/**
 * Go adapter (tree-sitter grammar `go`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: imports, type declarations (+ struct field types),
 *      free functions, methods with their receiver variable;
 *   2. resolve call sites (`f()`, `r.M()`, `r.field.M()`, `pkg.F()`) against
 *      the cross-module indexes into typed {@link CallEdge}s.
 *
 * Go has no async/await, so `isAsync`/`isAwait` are always false. Visibility is
 * PACKAGE-scoped (one directory = one package), which is why both the sibling
 * free-function lookup and the cross-file method lookup are switched on here and
 * nowhere else.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, TypeKind } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, firstOfType, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  recordType,
  boundaryOf,
  resolveFieldType,
  resolveOwnMethod,
  resolveSameFileFree,
  resolveSiblingPackage,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

const GENERIC_TYPES = new Set([
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'float32',
  'float64',
  'complex64',
  'complex128',
  'byte',
  'rune',
  'string',
  'bool',
  'error',
  'any',
]);

/** Nested function scopes are skipped while walking a body. */
const NESTED_SCOPES = new Set(['func_literal', 'function_declaration', 'method_declaration']);

interface Receiver {
  varName: string;
  typeName: string;
}

interface FnContext {
  body: Node;
  receiver: Receiver | null;
  params: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: local package name → full import path. `ownerMethods`: declared
   * type names (empty set) plus receiver methods. `typeModules`: the types this
   * file DECLARES — a method whose receiver type lives in a sibling file must
   * not make this file the type's home. `fieldTypes`: `Type.field` → core type.
   */
  fnContext: Map<string, FnContext>;
  typeModules: Map<string, string>;
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

/**
 * The {@link TypeKind} a `type_spec`'s right-hand side declares.
 *
 * Go's `type` keyword covers four different things and the grammar tells them
 * apart only by what follows the name, so this reads the child rather than the
 * node type:
 *
 * - `struct_type`    → `struct`
 * - `interface_type` → `interface`
 * - a `type_alias` node (`type A = B`) → `alias`, handled by the caller since
 *   the grammar gives it its OWN node type, not a `type_spec`
 * - anything else (`type Celsius float64`, `type Handler func(int) error`) →
 *   `other`, because a Go DEFINED type is neither an alias nor an aggregate: it
 *   is a brand-new type with its own method set that happens to share a
 *   representation. Filing it as `alias` would state the opposite of the
 *   language's rule, so the honest answer is the escape hatch plus a signature
 *   that shows exactly what was written.
 */
function typeSpecKind(spec: Node): TypeKind {
  const type = spec.childForFieldName('type')?.type;
  if (type === 'struct_type') return 'struct';
  if (type === 'interface_type') return 'interface';
  return 'other';
}

/**
 * Every kind {@link typeSpecKind} and its caller can emit, sorted.
 *
 * Written out rather than derived from a node-type map, because Go's kind is
 * decided by a declaration's right-hand SIDE, not by its node type — a map keyed
 * by node type would have to invent keys to look derived. `register.test.ts`
 * checks the claim against a real fixture in both directions instead, which is
 * the guard that actually matters.
 */
const GO_TYPE_KINDS: readonly TypeKind[] = ['alias', 'interface', 'other', 'struct'];

function scanTypeSpec(scan: ModuleScan, spec: Node, file: string, declaration: Node): void {
  const name = fieldText(spec, 'name');
  if (!name) return;
  scan.typeModules.set(name, scan.moduleId);
  if (!scan.ownerMethods.has(name)) scan.ownerMethods.set(name, new Set());
  recordType(scan, {
    name,
    kind: spec.type === 'type_alias' ? 'alias' : typeSpecKind(spec),
    // `declaration` is the whole `type …` statement when it holds ONE spec, so the
    // signature keeps the `type` keyword and the span starts where a reader would
    // look. Inside a grouped `type ( A …; B … )` the caller passes the spec
    // itself, because one span covering the whole group would point every member
    // at the same lines.
    node: declaration,
    // A struct's field list, so the signature keeps the `struct` keyword and stops
    // before the fields — `type Engine struct`, not 200 characters of members.
    // Everything else has no wrapper node to stop at and shows whole (truncated),
    // which is what makes `type Celsius float64` readable at all.
    body: firstOfType(spec.childForFieldName('type') ?? spec, 'field_declaration_list') ?? null,
    file,
    container: null,
  });
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

function receiverOf(method: Node): Receiver | null {
  const receiver = method.childForFieldName('receiver');
  const decl = receiver?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  if (!decl) return null;
  const typeName = coreTypeName(decl.childForFieldName('type')) || decl.childForFieldName('type')?.text || '';
  const varName = fieldText(decl, 'name');
  if (!typeName) return null;
  return { varName, typeName };
}

function recordFunction(scan: ModuleScan, node: Node, receiver: Receiver | null, file: string): void {
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
    if (!scan.ownerMethods.has(className)) scan.ownerMethods.set(className, new Set());
    scan.ownerMethods.get(className)?.add(name);
  } else {
    scan.freeFunctions.add(name);
  }

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  const { reads, writes } =
    body && receiver?.varName ? trackReceiverAttrs(body, receiver.varName) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file,
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

function resolveCall(callee: Node, scan: ModuleScan, context: FnContext, std: StandardIndexes): Resolved {
  // A. bare `f(...)` — same file first, then any sibling file of the package.
  if (callee.type === 'identifier') {
    return (
      resolveSameFileFree(callee.text, scan) ??
      resolveSiblingPackage(callee.text, scan, std) ??
      unresolvedOf(callee.text)
    );
  }

  if (callee.type === 'selector_expression') {
    const operand = callee.childForFieldName('operand');
    const method = fieldText(callee, 'field');
    if (!operand || !method) return unresolvedOf(callee.text);
    const recv = context.receiver;

    // B1. `r.M(...)` on the receiver variable — the type's methods may live in
    // any file of the package, so cross-module lookup is allowed.
    if (operand.type === 'identifier' && recv && operand.text === recv.varName) {
      const own = resolveOwnMethod(recv.typeName, method, scan, std, { crossModule: true });
      return own ?? unresolvedOf(`${recv.varName}.${method}`);
    }

    // B2. `r.field.M(...)` through a struct field's learned type
    if (
      operand.type === 'selector_expression' &&
      recv &&
      operand.childForFieldName('operand')?.text === recv.varName
    ) {
      const field = fieldText(operand, 'field');
      const viaField = resolveFieldType(recv.typeName, field, method, scan, std);
      return viaField ?? unresolvedOf(`${recv.varName}.${field}.${method}`);
    }

    if (operand.type === 'identifier') {
      // B3. `param.M(...)` via a typed parameter
      const paramType = context.params.get(operand.text);
      if (paramType) {
        const typeModule = std.typeToModule.get(paramType);
        if (typeModule) {
          return { calleeId: `${typeModule}.${paramType}.${method}`, callType: 'param_method' };
        }
        return boundaryOf(paramType, method);
      }
      // B4. `pkg.F(...)` through an import — a scanned package whose directory
      // suffix-matches the import path is internal; everything else is boundary.
      const imported = scan.imports.get(operand.text);
      if (imported) {
        const owner = scannedPackageFunction(imported, method, std);
        if (owner) {
          return { calleeId: `${owner}.${method}`, callType: 'internal_func' };
        }
        return boundaryOf(imported, method);
      }
      return unresolvedOf(`${operand.text}.${method}`);
    }
  }

  return unresolvedOf(callee.text);
}

/**
 * Owning moduleId when `importPath` ends with a scanned package directory that
 * defines `fn`. Longest directory match wins (`internal/util` over `util`).
 */
function scannedPackageFunction(importPath: string, fn: string, std: StandardIndexes): string | undefined {
  let bestDir = '';
  let owner: string | undefined;
  for (const [dir, fns] of std.directoryFunctions) {
    if (dir === '.' || dir.length <= bestDir.length) continue;
    if (importPath !== dir && !importPath.endsWith(`/${dir}`)) continue;
    const moduleId = fns.get(fn);
    if (moduleId) {
      bestDir = dir;
      owner = moduleId;
    }
  }
  return owner;
}

const CAPABILITIES: AdapterCapabilities = {
  tier: 'full',
  // Go constructors are ordinary functions (`NewX`), so nothing here can be
  // typed as a constructor call.
  callTypes: ['self_method', 'self_attr_method', 'param_method', 'internal_func', 'boundary', 'unresolved'],
  selfAttrs: true,
  statementSpans: false,
  typeKinds: GO_TYPE_KINDS,
};

const GO_SPEC: LanguageSpec<ModuleScan> = {
  name: 'go',
  extensions: ['.go'],
  grammarFor: () => 'go',
  extraSkipDirs: ['vendor'],
  discoverFilter: (rel) => !rel.endsWith('_test.go'),
  moduleIdForFile,
  capabilities: CAPABILITIES,

  emptyScan(moduleId) {
    return {
      moduleId,
      files: [],
      functions: [],
      fnContext: new Map(),
      imports: new Map(),
      ownerMethods: new Map(),
      typeModules: new Map(),
      fieldTypes: new Map(),
      freeFunctions: new Set(),
    };
  },

  scan(scan, root, file) {
    for (const childOrNull of root.namedChildren) {
      const child = childOrNull;
      if (!child) continue;
      if (child.type === 'import_declaration') {
        collectImports(child, scan.imports);
      } else if (child.type === 'type_declaration') {
        const specs = child.namedChildren.filter(
          (n): n is Node => n !== null && (n.type === 'type_spec' || n.type === 'type_alias'),
        );
        for (const spec of specs) {
          scanTypeSpec(scan, spec, file, specs.length === 1 ? child : spec);
        }
      } else if (child.type === 'function_declaration') {
        recordFunction(scan, child, null, file);
      } else if (child.type === 'method_declaration') {
        const receiver = receiverOf(child);
        if (receiver) recordFunction(scan, child, receiver, file);
      }
    }
    // Ids must be unique; on (invalid) duplicate defs keep the last, matching the
    // shared-body pass-2 lookup so edges are not multiplied.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  extractCalls(scan, std) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      walk(context.body, (node) => {
        if (NESTED_SCOPES.has(node.type)) return false;
        if (node.type !== 'call_expression') return undefined;
        const callee = node.childForFieldName('function');
        if (!callee) return undefined;
        const resolved = resolveCall(callee, scan, context, std);
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
  },
};

export class GoAdapter extends SpineAdapter<ModuleScan> {
  constructor() {
    super(GO_SPEC);
  }
}
