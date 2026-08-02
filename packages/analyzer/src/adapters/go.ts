/**
 * Go adapter (tree-sitter grammar `go`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: imports, type declarations (+ struct field types),
 *      free functions, methods with their receiver variable;
 *   2. resolve call sites (`f()`, `r.M()`, `r.field.M()`, `pkg.F()`) against
 *      the cross-module indexes into typed {@link CallEdge}s.
 *
 * Go has no async/await, so `isAsync`/`isAwait` are always false.
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
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'byte', 'rune', 'string', 'bool', 'error', 'any',
]);

/** Nested function scopes are skipped while walking a body. */
const NESTED_SCOPES = new Set(['func_literal', 'function_declaration', 'method_declaration']);

interface ModuleScan {
  moduleId: string;
  file: string;
  /** local package name → full import path. */
  imports: Map<string, string>;
  /** declared type names. */
  types: Set<string>;
  /** type name → set of method names. */
  methods: Map<string, Set<string>>;
  /** `Type.field` → core type name. */
  fieldTypes: Map<string, string>;
  topLevelFunctions: Set<string>;
  functions: FunctionNode[];
  fnContext: Map<string, { body: Node; receiver: { varName: string; typeName: string } | null; params: Map<string, string> }>;
}

export class GoAdapter implements LanguageAdapter {
  readonly name = 'go';
  readonly extensions = ['.go'];

  discover(sourceRoot: string): string[] {
    return discoverByExtension(sourceRoot, this.extensions, ['vendor'], (rel) => !rel.endsWith('_test.go'));
  }

  async analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis> {
    const parser = await createParser('go');
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
    const typeToModule = new Map<string, string>();
    const typeMethods = new Map<string, Set<string>>();
    for (const scan of scans) {
      for (const type of scan.types) {
        if (!typeToModule.has(type)) typeToModule.set(type, scan.moduleId);
      }
      for (const [type, methods] of scan.methods) {
        typeMethods.set(`${scan.moduleId}.${type}`, methods);
      }
    }
    const indexes: CrossModuleIndexes = { typeToModule, typeMethods };

    const functions = scans.flatMap((s) => s.functions);
    const edges = scans.flatMap((s) => extractCalls(s, indexes));
    return { functions, edges };
  }
}

interface CrossModuleIndexes {
  typeToModule: Map<string, string>;
  /** `<moduleId>.<Type>` → method names. */
  typeMethods: Map<string, Set<string>>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(/\.go$/, '').split('/').join('.');
}

/** Peel `*T`, `[]T`, `pkg.T` down to the core named type; '' for builtins. */
function coreTypeName(typeNode: Node | null): string {
  if (!typeNode) return '';
  let bare = '';
  if (typeNode.type === 'type_identifier') {
    bare = typeNode.text;
  } else if (typeNode.type === 'pointer_type') {
    return coreTypeName(typeNode.namedChildren.find((c) => c !== null) ?? null);
  } else if (typeNode.type === 'slice_type' || typeNode.type === 'array_type') {
    return coreTypeName(typeNode.childForFieldName('element'));
  } else if (typeNode.type === 'qualified_type') {
    bare = fieldText(typeNode, 'name');
  }
  if (!bare || GENERIC_TYPES.has(bare)) return '';
  return bare;
}

function scanModule(root: Node, file: string): ModuleScan {
  const scan: ModuleScan = {
    moduleId: moduleIdForFile(file),
    file,
    imports: new Map(),
    types: new Set(),
    methods: new Map(),
    fieldTypes: new Map(),
    topLevelFunctions: new Set(),
    functions: [],
    fnContext: new Map(),
  };

  for (const childOrNull of root.namedChildren) {
    const child = childOrNull;
    if (!child) continue;
    if (child.type === 'import_declaration') {
      collectImports(child, scan.imports);
    } else if (child.type === 'type_declaration') {
      for (const spec of child.namedChildren) {
        if (!spec || spec.type !== 'type_spec') continue;
        scanTypeSpec(scan, spec);
      }
    } else if (child.type === 'function_declaration') {
      recordFunction(scan, child, null);
    } else if (child.type === 'method_declaration') {
      const receiver = receiverOf(child);
      if (receiver) recordFunction(scan, child, receiver);
    }
  }
  return scan;
}

function collectImports(node: Node, imports: Map<string, string>): void {
  walk(node, (n) => {
    if (n.type !== 'import_spec') return undefined;
    const path = n.childForFieldName('path')?.text.replace(/^"|"$/g, '') ?? '';
    if (!path) return false;
    const alias = fieldText(n, 'name');
    const local = alias || (path.split('/').pop() ?? path);
    if (local !== '_' && local !== '.') imports.set(local, path);
    return false;
  });
}

function scanTypeSpec(scan: ModuleScan, spec: Node): void {
  const name = fieldText(spec, 'name');
  if (!name) return;
  scan.types.add(name);
  const type = spec.childForFieldName('type');
  if (type?.type !== 'struct_type') return;
  walk(type, (n) => {
    if (n.type !== 'field_declaration') return undefined;
    const fieldType = coreTypeName(n.childForFieldName('type'));
    if (fieldType) {
      for (const c of n.namedChildren) {
        if (c?.type === 'field_identifier') scan.fieldTypes.set(`${name}.${c.text}`, fieldType);
      }
    }
    return false;
  });
}

function receiverOf(method: Node): { varName: string; typeName: string } | null {
  const receiver = method.childForFieldName('receiver');
  const decl = receiver?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  if (!decl) return null;
  const typeName = coreTypeName(decl.childForFieldName('type')) || decl.childForFieldName('type')?.text || '';
  const varName = fieldText(decl, 'name');
  if (!typeName) return null;
  return { varName, typeName };
}

function recordFunction(
  scan: ModuleScan,
  node: Node,
  receiver: { varName: string; typeName: string } | null,
): void {
  const name = fieldText(node, 'name');
  if (!name) return;
  const className = receiver?.typeName ?? null;
  const qualname = className ? `${className}.${name}` : name;
  const id = `${scan.moduleId}.${qualname}`;
  const body = node.childForFieldName('body');

  const params = new Map<string, string>();
  const paramsNode = node.childForFieldName('parameters');
  if (paramsNode) {
    for (const p of paramsNode.namedChildren) {
      if (!p || p.type !== 'parameter_declaration') continue;
      const type = coreTypeName(p.childForFieldName('type'));
      if (!type) continue;
      for (const c of p.namedChildren) {
        if (c?.type === 'identifier') params.set(c.text, type);
      }
    }
  }

  if (className) {
    if (!scan.methods.has(className)) scan.methods.set(className, new Set());
    scan.methods.get(className)?.add(name);
  } else {
    scan.topLevelFunctions.add(name);
  }

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  const { reads, writes } = body && receiver?.varName
    ? trackReceiverAttrs(body, receiver.varName)
    : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file: scan.file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(header.replace(/\s+/g, ' ').trim(), 200),
    isAsync: false,
    isMethod: className !== null,
    className,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (body) scan.fnContext.set(id, { body, receiver, params });
}

/** All `<recv>.<field>` selector accesses directly inside `node`. */
function receiverAttrsIn(node: Node, recv: string): string[] {
  const hits: string[] = [];
  walk(node, (n) => {
    if (n.type === 'selector_expression' && n.childForFieldName('operand')?.text === recv) {
      const field = fieldText(n, 'field');
      if (field) hits.push(field);
    }
  });
  return hits;
}

function trackReceiverAttrs(body: Node, recv: string): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  walk(body, (node) => {
    if (NESTED_SCOPES.has(node.type)) return false;
    if (node.type === 'assignment_statement') {
      const isCompound = node.children.some((c) => c && !c.isNamed && c.text !== '=' && c.text.endsWith('='));
      const left = node.childForFieldName('left');
      if (left) {
        for (const attr of receiverAttrsIn(left, recv)) writes.add(attr);
        if (isCompound) for (const attr of receiverAttrsIn(left, recv)) reads.add(attr);
      }
      const right = node.childForFieldName('right');
      if (right) for (const attr of receiverAttrsIn(right, recv)) reads.add(attr);
      return false;
    }
    if (node.type === 'selector_expression') {
      for (const attr of receiverAttrsIn(node, recv)) reads.add(attr);
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
      if (node.type !== 'call_expression') return undefined;
      const callee = node.childForFieldName('function');
      if (!callee) return undefined;
      const resolved = resolveCall(callee, scan, context, indexes);
      edges.push({
        callerId: fn.id,
        calleeId: resolved.calleeId,
        isAwait: false,
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
  context: { receiver: { varName: string; typeName: string } | null; params: Map<string, string> },
  indexes: CrossModuleIndexes,
): Resolved {
  // A. bare `f(...)`
  if (callee.type === 'identifier') {
    if (scan.topLevelFunctions.has(callee.text)) {
      return { calleeId: `${scan.moduleId}.${callee.text}`, callType: 'internal_func' };
    }
    return unresolved(callee.text);
  }

  if (callee.type === 'selector_expression') {
    const operand = callee.childForFieldName('operand');
    const method = fieldText(callee, 'field');
    if (!operand || !method) return unresolved(callee.text);
    const recv = context.receiver;

    // B1. `r.M(...)` on the receiver variable
    if (operand.type === 'identifier' && recv && operand.text === recv.varName) {
      const owner = recv.typeName;
      if (scan.methods.get(owner)?.has(method)) {
        return { calleeId: `${scan.moduleId}.${owner}.${method}`, callType: 'self_method' };
      }
      const typeModule = indexes.typeToModule.get(owner);
      if (typeModule && indexes.typeMethods.get(`${typeModule}.${owner}`)?.has(method)) {
        return { calleeId: `${typeModule}.${owner}.${method}`, callType: 'self_method' };
      }
      return unresolved(`${recv.varName}.${method}`);
    }

    // B2. `r.field.M(...)` through a struct field's learned type
    if (
      operand.type === 'selector_expression' &&
      recv &&
      operand.childForFieldName('operand')?.text === recv.varName
    ) {
      const field = fieldText(operand, 'field');
      const type = scan.fieldTypes.get(`${recv.typeName}.${field}`);
      if (type) {
        const typeModule = indexes.typeToModule.get(type);
        if (typeModule) {
          return { calleeId: `${typeModule}.${type}.${method}`, callType: 'self_attr_method' };
        }
        return { calleeId: `boundary:${type}.${method}`, callType: 'boundary' };
      }
      return unresolved(`${recv.varName}.${field}.${method}`);
    }

    if (operand.type === 'identifier') {
      // B3. `param.M(...)` via a typed parameter
      const paramType = context.params.get(operand.text);
      if (paramType) {
        const typeModule = indexes.typeToModule.get(paramType);
        if (typeModule) {
          return { calleeId: `${typeModule}.${paramType}.${method}`, callType: 'param_method' };
        }
        return { calleeId: `boundary:${paramType}.${method}`, callType: 'boundary' };
      }
      // B4. `pkg.F(...)` through an import
      const imported = scan.imports.get(operand.text);
      if (imported) {
        return { calleeId: `boundary:${imported}.${method}`, callType: 'boundary' };
      }
      return unresolved(`${operand.text}.${method}`);
    }
  }

  return unresolved(callee.text);
}

function unresolved(hint: string): Resolved {
  return { calleeId: `unresolved:${truncate(hint, 80)}`, callType: 'unresolved' };
}
