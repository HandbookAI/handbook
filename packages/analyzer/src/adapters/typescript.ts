/**
 * TypeScript adapter (tree-sitter grammars `typescript` and `tsx`).
 *
 * Two passes, like every adapter:
 *   1. scan each module: imports, classes (methods + field types, including
 *      constructor parameter-properties and arrow-function class fields),
 *      free functions, `this.X` attribute usage, parameter types;
 *   2. resolve every call / new-expression against the cross-module indexes
 *      into typed {@link CallEdge}s.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { CallEdge, CallType, FunctionNode, ModuleAnalysis } from '@handbook/core';
import { truncate } from '@handbook/core';
import { createParser } from '../languages.js';
import { dedupeFunctionsById, discoverByExtension, type LanguageAdapter } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';

const GENERIC_TYPES = new Set([
  'number', 'string', 'boolean', 'any', 'unknown', 'void', 'never', 'object',
  'Array', 'Promise', 'Map', 'Set', 'Record', 'Date', 'Object',
]);

const EXTRA_SKIP_DIRS = ['dist', 'build', 'out', 'coverage'];

/** Node types that open a nested function scope (skipped while walking a body). */
const NESTED_SCOPES = new Set([
  'arrow_function', 'function_expression', 'function_declaration',
  'method_definition', 'class_declaration', 'abstract_class_declaration',
]);

interface ModuleScan {
  moduleId: string;
  file: string;
  /** local name → `source::exported` (named/default) or `source` (namespace). */
  imports: Map<string, string>;
  /** class name → set of method names (incl. arrow-function fields). */
  classes: Map<string, Set<string>>;
  /** `Class.field` → bare type name. */
  fieldTypes: Map<string, string>;
  /** top-level function names (declarations + const arrow/function bindings). */
  topLevelFunctions: Set<string>;
  functions: FunctionNode[];
  /** function id → its AST context for pass 2. */
  fnContext: Map<string, { body: Node; className: string | null; params: Map<string, string> }>;
}

export class TypeScriptAdapter implements LanguageAdapter {
  readonly name = 'typescript';
  readonly extensions = ['.ts', '.tsx'];

  discover(sourceRoot: string): string[] {
    return discoverByExtension(sourceRoot, this.extensions, EXTRA_SKIP_DIRS, (rel) => !rel.endsWith('.d.ts'));
  }

  async analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis> {
    const tsParser = await createParser('typescript');
    const tsxParser = await createParser('tsx');
    const scans: ModuleScan[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(join(sourceRoot, file), 'utf8');
      } catch {
        continue;
      }
      const parser = file.endsWith('.tsx') ? tsxParser : tsParser;
      const tree = parser.parse(source);
      if (!tree) continue;
      scans.push(scanModule(tree.rootNode, file));
    }

    // Cross-module indexes (first definition wins on collisions).
    const classToModule = new Map<string, string>();
    const moduleFunctions = new Map<string, Set<string>>();
    for (const scan of scans) {
      moduleFunctions.set(scan.moduleId, scan.topLevelFunctions);
      for (const cls of scan.classes.keys()) {
        if (!classToModule.has(cls)) classToModule.set(cls, scan.moduleId);
      }
    }
    const indexes: CrossModuleIndexes = { classToModule, moduleFunctions };

    const functions = scans.flatMap((s) => s.functions);
    const edges = scans.flatMap((s) => extractCalls(s, indexes));
    return { functions, edges };
  }
}

interface CrossModuleIndexes {
  classToModule: Map<string, string>;
  /** moduleId → top-level function names (resolves imports of scanned free functions). */
  moduleFunctions: Map<string, Set<string>>;
}

/**
 * `./helpers.js` imported from `src/app.ts` → `src.helpers`.
 * Undefined for non-relative specifiers and paths escaping the source root.
 */
function resolveRelativeModule(importerFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const stack = importerFile.split('/').slice(0, -1);
  const stripped = specifier.replace(/\.(jsx|js|mjs|cjs|tsx|ts)$/, '');
  for (const part of stripped.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length > 0 ? stack.join('.') : undefined;
}

export function moduleIdForFile(file: string): string {
  return file.replace(/\.(tsx|ts)$/, '').split('/').join('.');
}

/** `'./x.js::Engine'` → `Engine`; plain names pass through. */
function leafName(imported: string): string {
  return imported.split('::').pop() ?? imported;
}

function unwrapExport(node: Node): Node {
  if (node.type !== 'export_statement') return node;
  return node.childForFieldName('declaration') ?? node;
}

function scanModule(root: Node, file: string): ModuleScan {
  const scan: ModuleScan = {
    moduleId: moduleIdForFile(file),
    file,
    imports: new Map(),
    classes: new Map(),
    fieldTypes: new Map(),
    topLevelFunctions: new Set(),
    functions: [],
    fnContext: new Map(),
  };

  for (const childOrNull of root.namedChildren) {
    const child = childOrNull;
    if (!child) continue;
    if (child.type === 'import_statement') {
      collectImport(child, scan.imports);
      continue;
    }
    const decl = unwrapExport(child);
    if (decl.type === 'class_declaration' || decl.type === 'abstract_class_declaration') {
      scanClass(scan, decl);
    } else if (decl.type === 'function_declaration') {
      const name = fieldText(decl, 'name');
      if (name) {
        scan.topLevelFunctions.add(name);
        recordFunction(scan, { name, className: null, defNode: decl, fnNode: decl });
      }
    } else if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (const declarator of decl.namedChildren) {
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const value = declarator.childForFieldName('value');
        const nameNode = declarator.childForFieldName('name');
        if (!value || !nameNode || nameNode.type !== 'identifier') continue;
        if (value.type === 'arrow_function' || value.type === 'function_expression') {
          scan.topLevelFunctions.add(nameNode.text);
          recordFunction(scan, { name: nameNode.text, className: null, defNode: declarator, fnNode: value });
        }
      }
    }
  }
  // A `get x()`/`set x()` pair (or any same-name member) shares an id; keep the
  // last so ids stay unique and pass-2 edges are not multiplied.
  scan.functions = dedupeFunctionsById(scan.functions);
  return scan;
}

function collectImport(node: Node, imports: Map<string, string>): void {
  const sourceNode = node.childForFieldName('source');
  if (!sourceNode) return;
  const source = sourceNode.text.replace(/^['"]|['"]$/g, '');
  for (const clause of node.namedChildren) {
    if (!clause || clause.type !== 'import_clause') continue;
    for (const item of clause.namedChildren) {
      if (!item) continue;
      if (item.type === 'identifier') {
        // default import
        imports.set(item.text, `${source}::${item.text}`);
      } else if (item.type === 'namespace_import') {
        const ns = item.namedChildren.find((c) => c?.type === 'identifier');
        if (ns) imports.set(ns.text, source);
      } else if (item.type === 'named_imports') {
        for (const spec of item.namedChildren) {
          if (!spec || spec.type !== 'import_specifier') continue;
          const original = fieldText(spec, 'name');
          const alias = fieldText(spec, 'alias') || original;
          if (original) imports.set(alias, `${source}::${original}`);
        }
      }
    }
  }
}

function scanClass(scan: ModuleScan, classNode: Node): void {
  const className = fieldText(classNode, 'name');
  if (!className) return;
  if (!scan.classes.has(className)) scan.classes.set(className, new Set());
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const member of body.namedChildren) {
    if (!member) continue;
    if (member.type === 'method_definition') {
      const name = fieldText(member, 'name');
      if (!name) continue;
      scan.classes.get(className)?.add(name);
      recordFunction(scan, { name, className, defNode: member, fnNode: member });
      if (name === 'constructor') mineParameterProperties(scan, member, className);
    } else if (member.type === 'public_field_definition') {
      const name = fieldText(member, 'name');
      if (!name) continue;
      const value = member.childForFieldName('value');
      if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        // Function-valued fields ARE methods for our purposes.
        scan.classes.get(className)?.add(name);
        recordFunction(scan, { name, className, defNode: member, fnNode: value });
      } else {
        const type = typeFromAnnotation(member.childForFieldName('type'), scan.imports);
        if (type) scan.fieldTypes.set(`${className}.${name}`, leafName(type));
      }
    }
  }
}

/** `constructor(private wheel: Wheel)` → field type `Class.wheel = Wheel`. */
function mineParameterProperties(scan: ModuleScan, ctor: Node, className: string): void {
  const params = ctor.childForFieldName('parameters');
  if (!params) return;
  for (const p of params.namedChildren) {
    if (!p || (p.type !== 'required_parameter' && p.type !== 'optional_parameter')) continue;
    // `readonly rear: Wheel` is a parameter property too — not only
    // public/private/protected.
    const hasModifier = p.children.some(
      (c) => c?.type === 'accessibility_modifier' || c?.type === 'readonly' || c?.text === 'readonly',
    );
    if (!hasModifier) continue;
    const pattern = p.childForFieldName('pattern');
    const type = typeFromAnnotation(p.childForFieldName('type'), scan.imports);
    if (pattern?.type === 'identifier' && type) {
      scan.fieldTypes.set(`${className}.${pattern.text}`, leafName(type));
    }
  }
}

/** Core class-ish type from a `type_annotation`, resolved through imports; '' if generic. */
function typeFromAnnotation(annotation: Node | null, imports: Map<string, string>): string {
  const typeNode = annotation?.namedChildren.find((c) => c !== null);
  if (!typeNode) return '';
  let bare = '';
  if (typeNode.type === 'type_identifier') bare = typeNode.text;
  else if (typeNode.type === 'generic_type') bare = fieldText(typeNode, 'name');
  if (!bare || GENERIC_TYPES.has(bare)) return '';
  return imports.get(bare) ?? bare;
}

function recordFunction(
  scan: ModuleScan,
  opts: { name: string; className: string | null; defNode: Node; fnNode: Node },
): void {
  const { name, className, defNode, fnNode } = opts;
  const qualname = className ? `${className}.${name}` : name;
  const id = `${scan.moduleId}.${qualname}`;
  const body = fnNode.childForFieldName('body');
  const isAsync = fnNode.children.some((c) => c?.type === 'async');

  const params = new Map<string, string>();
  const paramsNode = fnNode.childForFieldName('parameters');
  if (paramsNode) {
    for (const p of paramsNode.namedChildren) {
      if (!p || (p.type !== 'required_parameter' && p.type !== 'optional_parameter')) continue;
      const pattern = p.childForFieldName('pattern');
      const type = typeFromAnnotation(p.childForFieldName('type'), scan.imports);
      if (pattern?.type === 'identifier' && type) params.set(pattern.text, type);
    }
  }

  const headerEnd = body ? body.startIndex : defNode.endIndex;
  const header = defNode.text.slice(0, Math.max(0, headerEnd - defNode.startIndex));
  const { reads, writes } = body ? trackThisAttrs(body) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file: scan.file,
    lineStart: lineStart(defNode),
    lineEnd: lineEnd(defNode),
    signature: truncate(header.replace(/\s+/g, ' ').trim(), 200),
    isAsync,
    isMethod: className !== null,
    className,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (body) scan.fnContext.set(id, { body, className, params });
}

/** All `this.<prop>` properties directly inside `node`. */
function thisAttrsIn(node: Node): string[] {
  const hits: string[] = [];
  walk(node, (n) => {
    if (n.type === 'member_expression' && n.childForFieldName('object')?.type === 'this') {
      const prop = fieldText(n, 'property');
      if (prop) hits.push(prop);
    }
  });
  return hits;
}

/** Collect `this.x` reads/writes inside a body (nested function scopes skipped). */
function trackThisAttrs(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  walk(body, (node) => {
    if (NESTED_SCOPES.has(node.type)) return false;
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      const left = node.childForFieldName('left');
      if (left) {
        for (const attr of thisAttrsIn(left)) writes.add(attr);
        if (node.type === 'augmented_assignment_expression') for (const attr of thisAttrsIn(left)) reads.add(attr);
      }
      const right = node.childForFieldName('right');
      if (right) for (const attr of thisAttrsIn(right)) reads.add(attr);
      return false;
    }
    if (node.type === 'member_expression') {
      for (const attr of thisAttrsIn(node)) reads.add(attr);
      return false;
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

function extractCalls(scan: ModuleScan, indexes: CrossModuleIndexes): CallEdge[] {
  const edges: CallEdge[] = [];
  for (const fn of scan.functions) {
    const context = scan.fnContext.get(fn.id);
    if (!context) continue;
    walk(context.body, (node) => {
      if (NESTED_SCOPES.has(node.type)) return false;
      const isAwait = node.parent?.type === 'await_expression';
      if (node.type === 'call_expression') {
        const callee = node.childForFieldName('function');
        if (!callee) return undefined;
        const resolved = resolveCall(callee, scan, context, indexes);
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait,
          callType: resolved.callType,
          line: lineStart(node),
          raw: truncate(callee.text, 80),
        });
      } else if (node.type === 'new_expression') {
        const resolved = resolveNew(node, scan, indexes);
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait,
          callType: resolved.callType,
          line: lineStart(node),
          raw: truncate(node.text, 80),
        });
      }
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

  if (callee.type === 'member_expression') {
    const object = callee.childForFieldName('object');
    const prop = fieldText(callee, 'property');
    if (!object || !prop) return unresolved(callee.text);

    // B1. `this.m(...)`
    if (object.type === 'this') {
      if (context.className && scan.classes.get(context.className)?.has(prop)) {
        return { calleeId: `${scan.moduleId}.${context.className}.${prop}`, callType: 'self_method' };
      }
      return unresolved(`this.${prop}`);
    }

    // B2. `this.field.m(...)`
    if (object.type === 'member_expression' && object.childForFieldName('object')?.type === 'this') {
      const field = fieldText(object, 'property');
      const type = context.className ? scan.fieldTypes.get(`${context.className}.${field}`) : undefined;
      if (type) {
        const typeModule = indexes.classToModule.get(type);
        if (typeModule) {
          return { calleeId: `${typeModule}.${type}.${prop}`, callType: 'self_attr_method' };
        }
        return { calleeId: `boundary:${type}.${prop}`, callType: 'boundary' };
      }
      return unresolved(`this.${field}.${prop}`);
    }

    // B3. `base.m(...)` where base is a bare identifier
    if (object.type === 'identifier') {
      const base = object.text;
      const paramType = context.params.get(base);
      if (paramType) {
        const bare = leafName(paramType);
        const typeModule = indexes.classToModule.get(bare);
        if (typeModule) return { calleeId: `${typeModule}.${bare}.${prop}`, callType: 'param_method' };
        return { calleeId: `boundary:${paramType}.${prop}`, callType: 'boundary' };
      }
      if (scan.classes.has(base)) {
        return { calleeId: `${scan.moduleId}.${base}.${prop}`, callType: 'internal_func' };
      }
      const imported = scan.imports.get(base);
      if (imported) {
        const bare = leafName(imported);
        const typeModule = indexes.classToModule.get(bare);
        if (typeModule) return { calleeId: `${typeModule}.${bare}.${prop}`, callType: 'internal_func' };
        if (!imported.includes('::')) {
          // namespace import of a scanned sibling module
          const scannedModule = resolveRelativeModule(scan.file, imported);
          if (scannedModule && indexes.moduleFunctions.get(scannedModule)?.has(prop)) {
            return { calleeId: `${scannedModule}.${prop}`, callType: 'internal_func' };
          }
        }
        return { calleeId: `boundary:${imported}.${prop}`, callType: 'boundary' };
      }
      return unresolved(`${base}.${prop}`);
    }
  }

  // C. anything else
  return unresolved(callee.text);
}

function resolveBareName(name: string, scan: ModuleScan, indexes: CrossModuleIndexes): Resolved {
  if (scan.topLevelFunctions.has(name)) {
    return { calleeId: `${scan.moduleId}.${name}`, callType: 'internal_func' };
  }
  const imported = scan.imports.get(name);
  if (imported) {
    const sep = imported.indexOf('::');
    const source = sep >= 0 ? imported.slice(0, sep) : imported;
    const leaf = leafName(imported);
    const scannedModule = resolveRelativeModule(scan.file, source);
    if (scannedModule && indexes.moduleFunctions.get(scannedModule)?.has(leaf)) {
      return { calleeId: `${scannedModule}.${leaf}`, callType: 'internal_func' };
    }
    const typeModule = indexes.classToModule.get(leaf);
    if (typeModule) {
      return { calleeId: `${typeModule}.${leaf}.constructor`, callType: 'internal_constructor' };
    }
    if (/^[A-Z]/.test(leaf)) {
      return { calleeId: `boundary:${imported}`, callType: 'boundary_constructor' };
    }
    return { calleeId: `boundary:${imported}`, callType: 'boundary' };
  }
  return unresolved(name);
}

function resolveNew(node: Node, scan: ModuleScan, indexes: CrossModuleIndexes): Resolved {
  const ctor = node.childForFieldName('constructor');
  if (!ctor) return unresolved(node.text);

  if (ctor.type === 'identifier') {
    const name = ctor.text;
    if (scan.classes.has(name)) {
      return { calleeId: `${scan.moduleId}.${name}.constructor`, callType: 'internal_constructor' };
    }
    const imported = scan.imports.get(name);
    if (imported) {
      const leaf = leafName(imported);
      const typeModule = indexes.classToModule.get(leaf);
      if (typeModule) {
        return { calleeId: `${typeModule}.${leaf}.constructor`, callType: 'internal_constructor' };
      }
      return { calleeId: `boundary:${imported}`, callType: 'boundary_constructor' };
    }
    return { calleeId: `boundary:${name}`, callType: 'boundary_constructor' };
  }

  // `new ns.Thing(...)` — via a namespace import → boundary; else unresolved.
  if (ctor.type === 'member_expression') {
    const object = ctor.childForFieldName('object');
    const prop = fieldText(ctor, 'property');
    if (object?.type === 'identifier' && prop) {
      const imported = scan.imports.get(object.text);
      if (imported) {
        return { calleeId: `boundary:${imported}.${prop}`, callType: 'boundary_constructor' };
      }
    }
  }
  return unresolved(node.text);
}

function unresolved(hint: string): Resolved {
  return { calleeId: `unresolved:${truncate(hint, 80)}`, callType: 'unresolved' };
}
