/**
 * Rust adapter (tree-sitter grammar `rust`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: `use` imports, type items (struct/enum/trait/union +
 *      struct field types), impl-block methods, inline `mod {}` recursion,
 *      attributes-as-decorators, free functions;
 *   2. resolve call sites (bare names, `A::b` paths, `self.m()`, field and
 *      param method calls, macros) into typed {@link CallEdge}s.
 *
 * Ids are `::`-separated: `<moduleId>::<Owner>::<name>`. Sibling files that
 * collapse to the same moduleId (lib.rs/main.rs/mod.rs) are merged, first
 * definition wins.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { CallEdge, CallType, FunctionNode, ModuleAnalysis } from '@handbook/core';
import { truncate } from '@handbook/core';
import { createParser } from '../languages.js';
import { discoverByExtension, type LanguageAdapter } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';

const GENERIC_TYPES = new Set([
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'f32', 'f64', 'bool', 'char', 'str', 'String',
  'Vec', 'Box', 'Option', 'Result', 'HashMap', 'HashSet', 'BTreeMap',
  'Rc', 'Arc', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'Cow',
]);

/** Method names treated as constructors in `A::b()` resolution. */
const CTOR_NAMES = new Set(['new', 'default', 'from']);

/** Nested function scopes are skipped while walking a body. */
const NESTED_SCOPES = new Set(['closure_expression', 'function_item']);

interface ModuleScan {
  moduleId: string;
  files: string[];
  /** local name → full `::`-separated path. */
  imports: Map<string, string>;
  /** bare type name → effective module id (moduleId + inline-mod prefix). */
  typeModules: Map<string, string>;
  /** bare owner type name → set of method names. */
  methods: Map<string, Set<string>>;
  /** `Owner.field` → core type name. */
  fieldTypes: Map<string, string>;
  /** free-fn leaf name → node id (first wins). */
  freeFns: Map<string, string>;
  /** free-fn entries for the cross-module unique index. */
  freeFnEntries: Array<{ name: string; id: string; effModule: string }>;
  functions: FunctionNode[];
  fnContext: Map<string, { body: Node; owner: string | null; selfIdBase: string | null; params: Map<string, string> }>;
}

export class RustAdapter implements LanguageAdapter {
  readonly name = 'rust';
  readonly extensions = ['.rs'];

  discover(sourceRoot: string): string[] {
    return discoverByExtension(sourceRoot, this.extensions, ['target']);
  }

  async analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis> {
    const parser = await createParser('rust');
    // Sibling files collapsing to one moduleId are merged (first wins).
    const byModule = new Map<string, ModuleScan>();
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(join(sourceRoot, file), 'utf8');
      } catch {
        continue;
      }
      const tree = parser.parse(source);
      if (!tree) continue;
      const moduleId = moduleIdForFile(file);
      let scan = byModule.get(moduleId);
      if (!scan) {
        scan = emptyScan(moduleId);
        byModule.set(moduleId, scan);
      }
      scan.files.push(file);
      scanInto(scan, tree.rootNode, file, '');
    }
    const scans = [...byModule.values()];

    // Cross-module indexes (first definition wins on collisions).
    const typeToModule = new Map<string, string>();
    const freeFnsByTailName = new Map<string, Set<string>>();
    for (const scan of scans) {
      for (const [type, effModule] of scan.typeModules) {
        if (!typeToModule.has(type)) typeToModule.set(type, effModule);
      }
      for (const { name, id, effModule } of scan.freeFnEntries) {
        const tail = effModule.split('::').pop() ?? effModule;
        const key = `${tail}::${name}`;
        if (!freeFnsByTailName.has(key)) freeFnsByTailName.set(key, new Set());
        freeFnsByTailName.get(key)?.add(id);
      }
    }
    const indexes: CrossModuleIndexes = { typeToModule, freeFnsByTailName };

    const functions = scans.flatMap((s) => s.functions);
    const edges = scans.flatMap((s) => extractCalls(s, indexes));
    return { functions, edges };
  }
}

interface CrossModuleIndexes {
  typeToModule: Map<string, string>;
  /** `<module tail>::<fn name>` → ids; resolvable only when exactly one. */
  freeFnsByTailName: Map<string, Set<string>>;
}

export function moduleIdForFile(file: string): string {
  const stem = file.replace(/\.rs$/, '');
  const segments = stem.split('/').filter((s) => s !== 'mod' && s !== 'lib' && s !== 'main');
  if (segments.length === 0) return stem.split('/').join('::');
  return segments.join('::');
}

function emptyScan(moduleId: string): ModuleScan {
  return {
    moduleId,
    files: [],
    imports: new Map(),
    typeModules: new Map(),
    methods: new Map(),
    fieldTypes: new Map(),
    freeFns: new Map(),
    freeFnEntries: [],
    functions: [],
    fnContext: new Map(),
  };
}

/** Peel refs/generics/scoped paths down to the core named type; '' for builtins. */
function coreTypeName(typeNode: Node | null): string {
  if (!typeNode) return '';
  let bare = '';
  if (typeNode.type === 'type_identifier') {
    bare = typeNode.text;
  } else if (typeNode.type === 'reference_type') {
    return coreTypeName(typeNode.childForFieldName('type'));
  } else if (typeNode.type === 'generic_type') {
    bare = typeNode.childForFieldName('type')?.text ?? '';
  } else if (typeNode.type === 'scoped_type_identifier') {
    bare = fieldText(typeNode, 'name');
  } else if (typeNode.type === 'primitive_type') {
    bare = typeNode.text;
  }
  if (!bare || GENERIC_TYPES.has(bare)) return '';
  return bare;
}

/** The module id that owns items declared under `prefix` (inline mods). */
function effectiveModule(moduleId: string, prefix: string): string {
  return prefix ? `${moduleId}::${prefix.replace(/::$/, '')}` : moduleId;
}

function scanInto(scan: ModuleScan, container: Node, file: string, prefix: string): void {
  // Iterative pre-order DFS (explicit stack) rather than recursion on `mod`:
  // inline modules can nest without bound, so a pathologically nested source
  // (`mod a { mod b { ... } }` thousands deep) would otherwise blow the JS call
  // stack. Each work item carries its already-resolved decorators, and a
  // container's children are pushed in reverse so a nested mod's body is fully
  // processed before the container's later siblings — byte-identical order and
  // first-definition-wins tie-breaks to the recursion.
  interface Frame {
    node: Node;
    prefix: string;
    decorators: string[];
  }
  const stack: Frame[] = [];
  const expand = (node: Node, framePrefix: string): void => {
    const items: Frame[] = [];
    let decorators: string[] = [];
    for (const childOrNull of node.namedChildren) {
      const child = childOrNull;
      if (!child) continue;
      if (child.type === 'attribute_item') {
        decorators.push(child.text.replace(/^#\[/, '').replace(/\]$/, '').trim());
        continue;
      }
      items.push({ node: child, prefix: framePrefix, decorators });
      decorators = [];
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item) stack.push(item);
    }
  };
  expand(container, prefix);
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const { node: child, prefix: childPrefix, decorators } = frame;
    switch (child.type) {
      case 'use_declaration': {
        const argument = child.childForFieldName('argument');
        if (argument) collectUse(argument, '', scan.imports);
        break;
      }
      case 'struct_item':
      case 'union_item': {
        const name = fieldText(child, 'name');
        if (name) {
          registerType(scan, name, childPrefix);
          const body = child.childForFieldName('body');
          if (body) collectFieldTypes(scan, body, name);
        }
        break;
      }
      case 'enum_item': {
        const name = fieldText(child, 'name');
        if (name) registerType(scan, name, childPrefix);
        break;
      }
      case 'trait_item': {
        const name = fieldText(child, 'name');
        if (name) {
          registerType(scan, name, childPrefix);
          const body = child.childForFieldName('body');
          // Default methods (function_items with a body); signatures skipped.
          if (body) scanImplBody(scan, body, name, file, childPrefix);
        }
        break;
      }
      case 'impl_item': {
        const owner = coreTypeName(child.childForFieldName('type')) || (child.childForFieldName('type')?.text ?? '');
        const body = child.childForFieldName('body');
        if (owner && body) scanImplBody(scan, body, owner, file, childPrefix);
        break;
      }
      case 'mod_item': {
        const name = fieldText(child, 'name');
        const body = child.childForFieldName('body');
        if (name && body) expand(body, `${childPrefix}${name}::`);
        break;
      }
      case 'function_item': {
        recordFunction(scan, child, null, file, childPrefix, decorators);
        break;
      }
      default:
        break;
    }
  }
}

function scanImplBody(scan: ModuleScan, body: Node, owner: string, file: string, prefix: string): void {
  let decorators: string[] = [];
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (member.type === 'attribute_item') {
      decorators.push(member.text.replace(/^#\[/, '').replace(/\]$/, '').trim());
      continue;
    }
    if (member.type === 'function_item') {
      recordFunction(scan, member, owner, file, prefix, decorators);
    }
    decorators = [];
  }
}

/**
 * Flatten a `use` argument into `imports[local] = full::path` entries.
 *
 * Iterative (explicit stack) rather than recursive: use-trees nest without
 * bound (`use a::{b::{c::{ ... }}}`), so a pathological one would otherwise blow
 * the JS call stack. Items are pushed in reverse for byte-identical pre-order,
 * left-to-right first-definition-wins behaviour to the recursion.
 */
function collectUse(node: Node, base: string, imports: Map<string, string>): void {
  const stack: Array<{ node: Node; base: string }> = [{ node, base }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const { node: current, base: curBase } = frame;
    const prefixed = (path: string): string => (curBase ? `${curBase}::${path}` : path);
    switch (current.type) {
      case 'identifier':
      case 'scoped_identifier': {
        const full = prefixed(current.text);
        const leaf = full.split('::').pop() ?? full;
        if (!imports.has(leaf)) imports.set(leaf, full);
        break;
      }
      case 'self': {
        const leaf = curBase.split('::').pop() ?? curBase;
        if (leaf && !imports.has(leaf)) imports.set(leaf, curBase);
        break;
      }
      case 'use_as_clause': {
        const path = current.childForFieldName('path')?.text ?? '';
        const alias = fieldText(current, 'alias');
        if (path && alias && !imports.has(alias)) imports.set(alias, prefixed(path));
        break;
      }
      case 'scoped_use_list': {
        const path = current.childForFieldName('path')?.text ?? '';
        const list = current.childForFieldName('list');
        if (list) stack.push({ node: list, base: prefixed(path) });
        break;
      }
      case 'use_list': {
        const children = current.namedChildren;
        for (let i = children.length - 1; i >= 0; i -= 1) {
          const item = children[i];
          if (item) stack.push({ node: item, base: curBase });
        }
        break;
      }
      default:
        // use_wildcard and anything exotic: ignored.
        break;
    }
  }
}

function registerType(scan: ModuleScan, name: string, prefix: string): void {
  const effModule = effectiveModule(scan.moduleId, prefix);
  if (!scan.typeModules.has(name)) scan.typeModules.set(name, effModule);
  if (!scan.methods.has(name)) scan.methods.set(name, new Set());
}

function collectFieldTypes(scan: ModuleScan, body: Node, owner: string): void {
  for (const field of body.namedChildren) {
    if (!field || field.type !== 'field_declaration') continue;
    const name = fieldText(field, 'name');
    const type = coreTypeName(field.childForFieldName('type'));
    const key = `${owner}.${name}`;
    if (name && type && !scan.fieldTypes.has(key)) scan.fieldTypes.set(key, type);
  }
}

function recordFunction(
  scan: ModuleScan,
  node: Node,
  owner: string | null,
  file: string,
  prefix: string,
  decorators: string[],
): void {
  const name = fieldText(node, 'name');
  if (!name) return;
  const qualname = owner ? `${prefix}${owner}::${name}` : `${prefix}${name}`;
  const id = `${scan.moduleId}::${qualname}`;
  if (scan.fnContext.has(id) || scan.functions.some((f) => f.id === id)) return; // merged sibling: first wins
  const body = node.childForFieldName('body');
  const isAsync = node.children.some((c) => c?.type === 'function_modifiers' && c.text.includes('async'));

  const params = new Map<string, string>();
  const paramsNode = node.childForFieldName('parameters');
  if (paramsNode) {
    for (const p of paramsNode.namedChildren) {
      if (!p || p.type !== 'parameter') continue;
      const pattern = p.childForFieldName('pattern');
      const type = coreTypeName(p.childForFieldName('type'));
      if (pattern?.type === 'identifier' && type) params.set(pattern.text, type);
    }
  }

  if (owner) {
    if (!scan.methods.has(owner)) scan.methods.set(owner, new Set());
    scan.methods.get(owner)?.add(name);
  } else {
    if (!scan.freeFns.has(name)) scan.freeFns.set(name, id);
    scan.freeFnEntries.push({ name, id, effModule: effectiveModule(scan.moduleId, prefix) });
  }

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  const { reads, writes } = body ? trackSelfAttrs(body) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(header.replace(/\s+/g, ' ').trim(), 200),
    isAsync,
    isMethod: owner !== null,
    className: owner,
    decorators,
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (body) {
    scan.fnContext.set(id, {
      body,
      owner,
      selfIdBase: owner ? `${scan.moduleId}::${prefix}${owner}` : null,
      params,
    });
  }
}

/** All direct `self.<field>` accesses inside `node`. */
function selfAttrsIn(node: Node): string[] {
  const hits: string[] = [];
  walk(node, (n) => {
    if (n.type === 'field_expression' && n.childForFieldName('value')?.type === 'self') {
      const field = fieldText(n, 'field');
      if (field) hits.push(field);
    }
  });
  return hits;
}

function trackSelfAttrs(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  walk(body, (node) => {
    if (NESTED_SCOPES.has(node.type)) return false;
    if (node.type === 'assignment_expression' || node.type === 'compound_assignment_expr') {
      const left = node.childForFieldName('left');
      if (left) {
        for (const attr of selfAttrsIn(left)) writes.add(attr);
        if (node.type === 'compound_assignment_expr') for (const attr of selfAttrsIn(left)) reads.add(attr);
      }
      const right = node.childForFieldName('right');
      if (right) for (const attr of selfAttrsIn(right)) reads.add(attr);
      return false;
    }
    if (node.type === 'field_expression') {
      for (const attr of selfAttrsIn(node)) reads.add(attr);
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
      if (node.type === 'macro_invocation') {
        const macro = fieldText(node, 'macro').split('::').pop() ?? '';
        if (macro) {
          edges.push({
            callerId: fn.id,
            calleeId: `boundary:${macro}!`,
            isAwait: false,
            callType: 'boundary',
            line: lineStart(node),
            raw: truncate(`${macro}!`, 80),
          });
        }
        return false;
      }
      if (node.type !== 'call_expression') return undefined;
      const callee = node.childForFieldName('function');
      if (!callee) return undefined;
      const isAwait = node.parent?.type === 'await_expression';
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
  context: { owner: string | null; selfIdBase: string | null; params: Map<string, string> },
  indexes: CrossModuleIndexes,
): Resolved {
  // A. bare `name(...)`
  if (callee.type === 'identifier') {
    return resolveBareName(callee.text, scan, indexes);
  }

  // B. `A::b(...)` (possibly deep: `std::mem::swap`)
  if (callee.type === 'scoped_identifier') {
    return resolveScoped(callee, scan, indexes);
  }

  // C. `x.m(...)`
  if (callee.type === 'field_expression') {
    const value = callee.childForFieldName('value');
    const method = fieldText(callee, 'field');
    if (!value || !method) return unresolved(callee.text);

    // C1. `self.m(...)`
    if (value.type === 'self') {
      if (context.owner && context.selfIdBase && scan.methods.get(context.owner)?.has(method)) {
        return { calleeId: `${context.selfIdBase}::${method}`, callType: 'self_method' };
      }
      return unresolved(`self.${method}`);
    }

    // C2. `self.field.m(...)` through a learned field type
    if (value.type === 'field_expression' && value.childForFieldName('value')?.type === 'self') {
      const field = fieldText(value, 'field');
      const type = context.owner ? scan.fieldTypes.get(`${context.owner}.${field}`) : undefined;
      if (type) {
        const typeModule = indexes.typeToModule.get(type);
        if (typeModule) {
          return { calleeId: `${typeModule}::${type}::${method}`, callType: 'self_attr_method' };
        }
        return { calleeId: `boundary:${type}::${method}`, callType: 'boundary' };
      }
      return unresolved(`self.${field}.${method}`);
    }

    // C3. `param.m(...)` via a typed parameter
    if (value.type === 'identifier') {
      const paramType = context.params.get(value.text);
      if (paramType) {
        const typeModule = indexes.typeToModule.get(paramType);
        if (typeModule) {
          return { calleeId: `${typeModule}::${paramType}::${method}`, callType: 'param_method' };
        }
        return { calleeId: `boundary:${paramType}::${method}`, callType: 'boundary' };
      }
      return unresolved(`${value.text}.${method}`);
    }
  }

  return unresolved(callee.text);
}

function resolveBareName(name: string, scan: ModuleScan, indexes: CrossModuleIndexes): Resolved {
  const localFn = scan.freeFns.get(name);
  if (localFn) return { calleeId: localFn, callType: 'internal_func' };

  const imported = scan.imports.get(name);
  if (imported) {
    const leaf = imported.split('::').pop() ?? imported;
    const typeModule = indexes.typeToModule.get(leaf);
    if (typeModule) {
      return { calleeId: `${typeModule}::${leaf}::new`, callType: 'internal_constructor' };
    }
    const segments = imported.split('::');
    const tail = segments.at(-2);
    if (tail) {
      const ids = indexes.freeFnsByTailName.get(`${tail}::${leaf}`);
      if (ids && ids.size === 1) {
        return { calleeId: [...ids][0] ?? '', callType: 'internal_func' };
      }
    }
    return { calleeId: `boundary:${imported}`, callType: 'boundary' };
  }
  return unresolved(name);
}

function resolveScoped(callee: Node, scan: ModuleScan, indexes: CrossModuleIndexes): Resolved {
  const pathText = callee.childForFieldName('path')?.text ?? '';
  const leaf = fieldText(callee, 'name');
  if (!pathText || !leaf) return unresolved(callee.text);
  const ownerBare = pathText.split('::').pop() ?? pathText;

  // B1. owner is a scanned type
  const typeModule = indexes.typeToModule.get(ownerBare);
  if (typeModule) {
    return {
      calleeId: `${typeModule}::${ownerBare}::${leaf}`,
      callType: CTOR_NAMES.has(leaf) ? 'internal_constructor' : 'internal_func',
    };
  }

  // B2. unique free function in a module whose tail matches the path tail
  const ids = indexes.freeFnsByTailName.get(`${ownerBare}::${leaf}`);
  if (ids && ids.size === 1) {
    return { calleeId: [...ids][0] ?? '', callType: 'internal_func' };
  }

  // B3. boundary — qualify the head through imports when possible
  const segments = `${pathText}::${leaf}`.split('::');
  const head = segments[0] ?? '';
  const expanded = scan.imports.get(head);
  const qual = expanded ? [expanded, ...segments.slice(1)].join('::') : segments.join('::');
  const isCtor = /^[A-Z]/.test(ownerBare) && CTOR_NAMES.has(leaf);
  return { calleeId: `boundary:${qual}`, callType: isCtor ? 'boundary_constructor' : 'boundary' };
}

function unresolved(hint: string): Resolved {
  return { calleeId: `unresolved:${truncate(hint, 80)}`, callType: 'unresolved' };
}
