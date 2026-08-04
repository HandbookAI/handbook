/**
 * Python adapter (tree-sitter grammar `python`).
 *
 * Two passes, like every adapter:
 *   1. scan each module: imports, classes, functions (incl. nested defs),
 *      self-attribute usage, parameter types, learned `self.x` types;
 *   2. resolve every call site against the cross-module indexes into typed
 *      {@link CallEdge}s (`self_method`, `internal_func`, `boundary`, …).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { CallEdge, CallType, FunctionNode, ModuleAnalysis } from '@handbook/core';
import { truncate } from '@handbook/core';
import { createParser } from '../languages.js';
import { dedupeFunctionsById, discoverByExtension, type LanguageAdapter } from '../adapter.js';
import { collectLineSpans, fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';

const GENERIC_TYPES = new Set([
  'str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'object', 'None',
  'Any', 'Optional', 'Union', 'Callable', 'Iterable', 'Iterator', 'Sequence', 'Mapping', 'Path',
]);

interface ModuleScan {
  moduleId: string;
  file: string;
  /** local name → full dotted import path. */
  imports: Map<string, string>;
  /** class name → set of method names. */
  classes: Map<string, Set<string>>;
  /** top-level function names. */
  topLevelFunctions: Set<string>;
  functions: FunctionNode[];
  /** function id → its AST context for pass 2. */
  fnContext: Map<string, { body: Node; className: string | null; params: Map<string, string> }>;
  /** `Class.attr` → resolved type name (bare class name). */
  selfAttrTypes: Map<string, string>;
  /** `Class.method` → return annotation text. */
  methodReturns: Map<string, string>;
}

export class PythonAdapter implements LanguageAdapter {
  readonly name = 'python';
  readonly extensions = ['.py'];

  discover(sourceRoot: string): string[] {
    return discoverByExtension(sourceRoot, this.extensions);
  }

  async analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis> {
    const parser = await createParser('python');
    const scans: ModuleScan[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(join(sourceRoot, file), 'utf8');
      } catch {
        continue;
      }
      const tree = parser.parse(source);
      if (!tree) continue;
      scans.push(scanModule(tree.rootNode, file));
    }

    // Cross-module indexes (first definition wins on collisions).
    const classToModule = new Map<string, string>();
    const moduleIds = new Set<string>();
    const moduleFunctions = new Map<string, Set<string>>();
    const classMethods = new Map<string, Set<string>>();
    for (const scan of scans) {
      moduleIds.add(scan.moduleId);
      moduleFunctions.set(scan.moduleId, scan.topLevelFunctions);
      for (const [cls, methods] of scan.classes) {
        if (!classToModule.has(cls)) classToModule.set(cls, scan.moduleId);
        const key = `${scan.moduleId}.${cls}`;
        classMethods.set(key, methods);
      }
    }
    const indexes: CrossModuleIndexes = { classToModule, moduleIds, moduleFunctions, classMethods };

    const functions = scans.flatMap((s) => s.functions);
    const edges = scans.flatMap((s) => extractCalls(s, indexes));
    return { functions, edges };
  }

  async statementSpans(filePath: string, qualname: string): Promise<Array<[number, number]> | undefined> {
    const parser = await createParser('python');
    let tree;
    try {
      tree = parser.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return undefined;
    }
    if (!tree) return undefined;
    const leaf = qualname.split('.').pop() ?? qualname;
    let found: Node | undefined;
    walk(tree.rootNode, (node) => {
      if (found) return false;
      if (node.type === 'function_definition' && fieldText(node, 'name') === leaf) {
        found = node.childForFieldName('body') ?? undefined;
        return false;
      }
      return undefined;
    });
    return found ? collectLineSpans(found) : undefined;
  }
}

interface CrossModuleIndexes {
  classToModule: Map<string, string>;
  moduleIds: Set<string>;
  moduleFunctions: Map<string, Set<string>>;
  classMethods: Map<string, Set<string>>;
}

export function moduleIdForFile(file: string): string {
  let id = file.replace(/\.py$/, '').split('/').join('.');
  if (id.endsWith('.__init__')) id = id.slice(0, -'.__init__'.length);
  return id;
}

function unwrapDecorated(node: Node): { definition: Node; decorators: string[] } {
  if (node.type !== 'decorated_definition') return { definition: node, decorators: [] };
  const decorators = node.namedChildren
    .filter((c): c is Node => c !== null && c.type === 'decorator')
    .map((c) => c.text.replace(/^@/, '').trim());
  const definition = node.childForFieldName('definition') ?? node;
  return { definition, decorators };
}

function scanModule(root: Node, file: string): ModuleScan {
  const scan: ModuleScan = {
    moduleId: moduleIdForFile(file),
    file,
    imports: new Map(),
    classes: new Map(),
    topLevelFunctions: new Set(),
    functions: [],
    fnContext: new Map(),
    selfAttrTypes: new Map(),
    methodReturns: new Map(),
  };

  collectImports(root, scan.imports);

  // Iterative pre-order DFS (explicit stack) rather than recursion: the body
  // walk descends through arbitrary nested blocks AND expression trees, so a
  // pathologically nested module (thousands of nested `if`s or a giant nested
  // call) would otherwise blow the JS call stack. Children are pushed in
  // reverse so they pop left-to-right — byte-identical order to the recursion.
  interface Frame {
    node: Node;
    classStack: string[];
    fnStack: string[];
  }
  const stack: Frame[] = [];
  const pushChildren = (container: Node, classStack: string[], fnStack: string[]): void => {
    const children = container.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push({ node: child, classStack, fnStack });
    }
  };
  pushChildren(root, [], []);
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const { node: child, classStack, fnStack } = frame;
    const { definition, decorators } = unwrapDecorated(child);
    if (definition.type === 'class_definition') {
      const className = fieldText(definition, 'name');
      if (!scan.classes.has(className)) scan.classes.set(className, new Set());
      const classBody = definition.childForFieldName('body');
      if (classBody) pushChildren(classBody, [...classStack, className], fnStack);
    } else if (definition.type === 'function_definition') {
      recordFunction(scan, definition, decorators, classStack, fnStack);
      const fnBody = definition.childForFieldName('body');
      const name = fieldText(definition, 'name');
      // Nested defs are their own nodes; the class context does not apply inside.
      if (fnBody) pushChildren(fnBody, classStack, [...fnStack, name]);
    } else if (child.namedChildCount > 0 && child.type !== 'function_definition') {
      // Descend into plain blocks (if/try/with at module or class level).
      pushChildren(child, classStack, fnStack);
    }
  }
  // Redefinitions / `@overload` stubs share an id; keep the last (live) one.
  scan.functions = dedupeFunctionsById(scan.functions);
  return scan;
}

function collectImports(root: Node, imports: Map<string, string>): void {
  walk(root, (node) => {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (!child) continue;
        if (child.type === 'dotted_name') {
          const full = child.text;
          const head = full.split('.', 1)[0] ?? full;
          imports.set(head, head);
        } else if (child.type === 'aliased_import') {
          const full = child.childForFieldName('name')?.text ?? '';
          const alias = fieldText(child, 'alias');
          if (alias && full) imports.set(alias, full);
        }
      }
      return false;
    }
    if (node.type === 'import_from_statement') {
      const moduleName = node.childForFieldName('module_name')?.text ?? '';
      for (const child of node.namedChildren) {
        if (!child || child === node.childForFieldName('module_name')) continue;
        if (child.type === 'dotted_name') {
          imports.set(child.text, `${moduleName}.${child.text}`);
        } else if (child.type === 'aliased_import') {
          const original = child.childForFieldName('name')?.text ?? '';
          const alias = fieldText(child, 'alias');
          if (alias && original) imports.set(alias, `${moduleName}.${original}`);
        }
      }
      return false;
    }
    return undefined;
  });
}

function recordFunction(
  scan: ModuleScan,
  node: Node,
  decorators: string[],
  classStack: string[],
  fnStack: string[],
): void {
  const name = fieldText(node, 'name');
  if (!name) return;
  const className = classStack.at(-1) ?? null;
  const qualname = [...classStack, ...fnStack, name].join('.');
  const id = `${scan.moduleId}.${qualname}`;
  const isNested = fnStack.length > 0;
  const isAsync = node.children.some((c) => c?.type === 'async');
  const params = node.childForFieldName('parameters');
  const returnType = node.childForFieldName('return_type')?.text ?? '';
  const body = node.childForFieldName('body');

  const paramTypes = new Map<string, string>();
  if (params) {
    for (const p of params.namedChildren) {
      if (!p) continue;
      if (p.type === 'typed_parameter' || p.type === 'typed_default_parameter') {
        const pname = p.namedChildren[0]?.type === 'identifier' ? (p.namedChildren[0]?.text ?? '') : fieldText(p, 'name');
        const type = cleanTypeName(p.childForFieldName('type')?.text ?? '', scan.imports);
        if (pname && type) paramTypes.set(pname, type);
      }
    }
  }

  const isMethod = className !== null && !isNested && !decorators.includes('staticmethod');
  const { reads, writes } = body ? trackSelfAttrs(body) : { reads: [], writes: [] };

  if (className && isMethod && returnType) {
    scan.methodReturns.set(`${className}.${name}`, returnType);
  }
  if (className && body) learnSelfAttrTypes(scan, body, className, paramTypes);
  if (!className && !isNested) scan.topLevelFunctions.add(name);
  if (className && !isNested) scan.classes.get(className)?.add(name);

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = stripTrailingColonsAndWs(node.text.slice(0, Math.max(0, headerEnd - node.startIndex)));
  scan.functions.push({
    id,
    name,
    qualname,
    file: scan.file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(header.replace(/\s+/g, ' '), 200),
    isAsync,
    isMethod,
    className: isMethod ? className : null,
    decorators,
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(paramTypes),
  });
  if (body) {
    scan.fnContext.set(id, { body, className: isMethod ? className : null, params: paramTypes });
  }
}

/**
 * Strip a trailing run of `:` and whitespace from a def header — the linear
 * equivalent of `/[:\s]+$/`. The regex form is catastrophically quadratic in
 * V8 (a `$`-anchored quantifier is retried at every interior whitespace
 * position), so a header with a long interior whitespace run — `def f(<100k
 * spaces>x):` — hung for seconds. Walking back from the end touches only the
 * genuine trailing run, so it is O(trailing) and cannot be gamed.
 */
function stripTrailingColonsAndWs(header: string): string {
  let end = header.length;
  while (end > 0) {
    const c = header[end - 1] ?? '';
    if (c === ':' || /\s/.test(c)) end -= 1;
    else break;
  }
  return end === header.length ? header : header.slice(0, end);
}

/** Unwrap Optional[T] / T | None, drop generic builtins, resolve through imports. */
function cleanTypeName(raw: string, imports: Map<string, string>): string {
  let type = raw.trim();
  const optional = type.match(/^Optional\[(.+)\]$/);
  if (optional?.[1]) type = optional[1].trim();
  type = type
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t !== 'None')
    .join('|');
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(type)) return '';
  if (GENERIC_TYPES.has(type)) return '';
  return imports.get(type) ?? type;
}

/** Collect `self.x` reads/writes inside a function body (nested defs/lambdas skipped). */
function trackSelfAttrs(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  walk(body, (node) => {
    if (node.type === 'function_definition' || node.type === 'lambda') return false;
    if (node.type === 'assignment' || node.type === 'augmented_assignment') {
      const left = node.childForFieldName('left');
      if (left) {
        for (const attr of selfAttrsIn(left)) writes.add(attr);
        if (node.type === 'augmented_assignment') for (const attr of selfAttrsIn(left)) reads.add(attr);
      }
      const right = node.childForFieldName('right');
      if (right) for (const attr of selfAttrsIn(right)) reads.add(attr);
      return false;
    }
    if (node.type === 'attribute') {
      for (const attr of selfAttrsIn(node)) reads.add(attr);
      return false;
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

/** All direct `self.<attr>` accesses inside `node`. */
function selfAttrsIn(node: Node): string[] {
  const hits: string[] = [];
  walk(node, (n) => {
    if (n.type === 'attribute' && n.childForFieldName('object')?.text === 'self') {
      const attr = fieldText(n, 'attribute');
      if (attr) hits.push(attr);
    }
  });
  return hits;
}

/**
 * Learn instance-attribute types from `self.x = SomeClass(...)`,
 * `self.x = self.make_y()` (via return annotation), and `self.x = param`
 * where the parameter carries a type annotation.
 */
function learnSelfAttrTypes(
  scan: ModuleScan,
  body: Node,
  className: string,
  paramTypes: Map<string, string>,
): void {
  walk(body, (node) => {
    if (node.type === 'function_definition' || node.type === 'lambda') return false;
    if (node.type !== 'assignment') return undefined;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right || left.type !== 'attribute') return undefined;
    if (left.childForFieldName('object')?.text !== 'self') return undefined;
    const attr = fieldText(left, 'attribute');
    if (!attr) return undefined;
    if (right.type === 'identifier') {
      const paramType = paramTypes.get(right.text);
      if (paramType) {
        const bare = paramType.split('.').pop() ?? paramType;
        scan.selfAttrTypes.set(`${className}.${attr}`, bare);
      }
      return undefined;
    }
    if (right.type !== 'call') return undefined;
    const callee = right.childForFieldName('function');
    if (!callee) return undefined;
    if (callee.type === 'identifier' && /^[A-Z]/.test(callee.text)) {
      scan.selfAttrTypes.set(`${className}.${attr}`, callee.text);
    } else if (
      callee.type === 'attribute' &&
      callee.childForFieldName('object')?.text === 'self'
    ) {
      const method = fieldText(callee, 'attribute');
      const ret = scan.methodReturns.get(`${className}.${method}`);
      if (ret && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ret) && !GENERIC_TYPES.has(ret)) {
        scan.selfAttrTypes.set(`${className}.${attr}`, ret);
      }
    }
    return undefined;
  });
}

function extractCalls(scan: ModuleScan, indexes: CrossModuleIndexes): CallEdge[] {
  const edges: CallEdge[] = [];
  for (const fn of scan.functions) {
    const context = scan.fnContext.get(fn.id);
    if (!context) continue;
    walk(context.body, (node) => {
      if (node.type === 'function_definition' || node.type === 'lambda') return false;
      if (node.type !== 'call') return undefined;
      const callee = node.childForFieldName('function');
      if (!callee) return undefined;
      const isAwait = node.parent?.type === 'await';
      const resolved = resolveCall(callee, scan, context, indexes);
      edges.push({
        callerId: fn.id,
        calleeId: resolved.calleeId,
        isAwait,
        callType: resolved.callType,
        line: lineStart(node),
        raw: truncate(callee.text, 80),
      });
      return undefined;
    });
  }
  return edges;
}

interface Resolved {
  calleeId: string;
  callType: CallType;
}

function resolveCall(
  callee: Node,
  scan: ModuleScan,
  context: { className: string | null; params: Map<string, string> },
  indexes: CrossModuleIndexes,
): Resolved {
  // A. bare `name(...)`
  if (callee.type === 'identifier') {
    return resolveBareName(callee.text, scan, indexes);
  }

  if (callee.type === 'attribute') {
    const object = callee.childForFieldName('object');
    const attr = fieldText(callee, 'attribute');
    if (!object || !attr) return unresolved(callee.text);

    // B1. `self.foo(...)`
    if (object.type === 'identifier' && object.text === 'self') {
      if (context.className && scan.classes.get(context.className)?.has(attr)) {
        return { calleeId: `${scan.moduleId}.${context.className}.${attr}`, callType: 'self_method' };
      }
      return unresolved(`self.${attr}`);
    }

    // B2. `self.attr.foo(...)`
    if (object.type === 'attribute' && object.childForFieldName('object')?.text === 'self') {
      const field = fieldText(object, 'attribute');
      const type = context.className ? scan.selfAttrTypes.get(`${context.className}.${field}`) : undefined;
      if (type) {
        const typeModule = indexes.classToModule.get(type);
        if (typeModule) {
          return { calleeId: `${typeModule}.${type}.${attr}`, callType: 'self_attr_method' };
        }
        return { calleeId: `boundary:${type}.${attr}`, callType: 'boundary' };
      }
      return unresolved(`self.${field}.${attr}`);
    }

    // B3. `Base.foo(...)` where Base is a bare name
    if (object.type === 'identifier') {
      const base = object.text;
      const paramType = context.params.get(base);
      if (paramType) {
        const bare = paramType.split('.').pop() ?? paramType;
        const typeModule = indexes.classToModule.get(bare);
        if (typeModule) return { calleeId: `${typeModule}.${bare}.${attr}`, callType: 'param_method' };
        return { calleeId: `boundary:${paramType}.${attr}`, callType: 'boundary' };
      }
      if (scan.classes.has(base)) {
        return { calleeId: `${scan.moduleId}.${base}.${attr}`, callType: 'internal_func' };
      }
      const imported = scan.imports.get(base);
      if (imported) {
        const bare = imported.split('.').pop() ?? imported;
        const typeModule = indexes.classToModule.get(bare);
        if (typeModule) return { calleeId: `${typeModule}.${bare}.${attr}`, callType: 'internal_func' };
        // `alias.attr()` where the alias is one of OUR modules (e.g.
        // `from pkg import helpers; helpers.do()`) is an internal call.
        if (indexes.moduleIds.has(imported) && indexes.moduleFunctions.get(imported)?.has(attr)) {
          return { calleeId: `${imported}.${attr}`, callType: 'internal_func' };
        }
        return { calleeId: `boundary:${imported}.${attr}`, callType: 'boundary' };
      }
      return unresolved(`${base}.${attr}`);
    }
  }

  // C. anything else
  return unresolved(callee.text);
}

function resolveBareName(name: string, scan: ModuleScan, indexes: CrossModuleIndexes): Resolved {
  if (scan.classes.has(name)) {
    return { calleeId: `${scan.moduleId}.${name}.__init__`, callType: 'internal_constructor' };
  }
  if (scan.topLevelFunctions.has(name)) {
    return { calleeId: `${scan.moduleId}.${name}`, callType: 'internal_func' };
  }
  const imported = scan.imports.get(name);
  if (imported) {
    const segments = imported.split('.');
    const leaf = segments.at(-1) ?? imported;
    if (/^[A-Z]/.test(leaf)) {
      const typeModule = indexes.classToModule.get(leaf);
      if (typeModule) {
        return { calleeId: `${typeModule}.${leaf}.__init__`, callType: 'internal_constructor' };
      }
      return { calleeId: `boundary:${imported}`, callType: 'boundary_constructor' };
    }
    const sourceModule = segments.slice(0, -1).join('.');
    if (indexes.moduleIds.has(sourceModule) && indexes.moduleFunctions.get(sourceModule)?.has(leaf)) {
      return { calleeId: imported, callType: 'internal_func' };
    }
    return { calleeId: `boundary:${imported}`, callType: 'boundary' };
  }
  return unresolved(name);
}

function unresolved(hint: string): Resolved {
  return { calleeId: `unresolved:${truncate(hint, 80)}`, callType: 'unresolved' };
}
