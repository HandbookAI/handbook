/**
 * C# adapter (tree-sitter grammar `c_sharp`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: `using` directives, every type declaration (bases, field
 *      and property types, members), and per-member parameter/local types plus
 *      `this.x` usage;
 *   2. resolve every invocation / object-creation against the cross-module
 *      indexes into typed {@link CallEdge}s.
 *
 * Three things make C# different from the other typed adapters:
 *
 * - **There are no free functions.** Every callable lives inside a type, so
 *   `freeFunctions` (and therefore the spine's `moduleFunctions` /
 *   `directoryFunctions`) stays empty and `typeToModule` does all the work.
 *   That single table is also what makes same-namespace resolution work without
 *   a `using`: C# sees sibling types in its own namespace for free, and a
 *   scan-set-wide type table reproduces that without modelling namespaces.
 * - **`using` imports a NAMESPACE, not a symbol**, so it binds no local name and
 *   cannot ground a call on its own; only `using X = A.B.C;` (alias) and
 *   `using static A.B.C;` introduce names, and those two are what `imports` and
 *   `staticUsings` hold.
 * - **Inheritance and `partial` are load-bearing.** A call may target a method
 *   declared several types up the chain, or in the other half of a `partial`
 *   type — either way in another file. So base lists, the module that declares
 *   each member, and field types all need to be keyed by BARE type name across
 *   the whole scan set: a language-private index, since the spine's tables are
 *   per-module and cannot say which file declared a given member.
 *
 * Module ids stay path-derived (`src/App.cs` → `src.App`) like every other
 * adapter: the namespace is the semantic module, but namespaces are neither
 * unique per file nor even one-per-file, and ids must be unique.
 *
 * Known blind spots, stated rather than hidden: top-level statements (C# 9
 * `Program.cs`) have no enclosing member, so their calls are not attributed to
 * anything; overloads share one id (an id carries no arity, here as everywhere
 * else in this IR) and collapse to the last declaration; `operator` and
 * conversion-operator declarations are not recorded because their name is a
 * token, not an identifier; nested types are keyed by their bare name, so
 * `Outer1.Inner` and `Outer2.Inner` in one module would collide; and `new()`
 * (target-typed) yields no constructor edge because the type is not at the call.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, TypeKind } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  declaredTypeKinds,
  recordType,
  boundaryOf,
  resolveFieldType,
  resolveOwnMethod,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

/** Declarations that introduce a named type with members. */
const TYPE_DECLS = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'record_declaration',
  'record_struct_declaration',
]);

/**
 * Node type → {@link TypeKind}, for this grammar.
 *
 * A superset of {@link TYPE_DECLS}: `enum_declaration` is here and not there
 * because an enum declares no members this adapter can call, so call resolution
 * has never needed it — while a reader looks enums up constantly.
 *
 * `record_struct_declaration` is `record`, not `struct`: `record` is what the
 * declaration says and what a reader searches for, and the value/reference
 * distinction survives in the signature (`record struct Point` vs `record Point`).
 *
 * `delegate_declaration` is `other`, and the alternative was measured before
 * choosing: 21 delegates in Newtonsoft.Json, none of them findable any other way.
 * A delegate IS a first-class named type — it annotates fields and parameters and
 * is inherited from — so leaving it out made an agent read a miss as absence,
 * which is the failure this declaration exists to prevent. It is not an aggregate
 * (no fields), not a contract (nothing implements it), and NOT an `alias`: two
 * delegates with identical signatures are distinct, non-interconvertible types,
 * so `alias` would state the opposite of the language's rule. That is exactly
 * what `other` is for, and no new vocabulary member is warranted: `TYPE_KINDS` is
 * closed on purpose, and {@link TypeNode.signature} already carries
 * `delegate void Handler(int)` verbatim — the same treatment a C++ `union` and a
 * Go defined type get.
 */
const CSHARP_TYPE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['struct_declaration', 'struct'],
  ['record_declaration', 'record'],
  ['record_struct_declaration', 'record'],
  ['enum_declaration', 'enum'],
  ['delegate_declaration', 'other'],
]);

/** Declarations whose children are more declarations. */
const NAMESPACE_DECLS = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);

/** Members carrying a `variable_declaration` list of fields. */
const FIELD_MEMBERS = new Set(['field_declaration', 'event_field_declaration']);

/** Members carrying an `accessor_list` we can turn into functions. */
const ACCESSOR_MEMBERS = new Set(['property_declaration', 'event_declaration', 'indexer_declaration']);

/** Accessor keywords, used both to detect and to name the accessor function. */
const ACCESSOR_KINDS = new Set(['get', 'set', 'init', 'add', 'remove']);

interface FnContext {
  body: Node;
  className: string | null;
  /** parameters + locals whose type we learned → bare type name. */
  scopeTypes: Map<string, string>;
  /** every name bound in this scope, typed or not — shadows fields of the type. */
  declaredNames: Set<string>;
  /** local function name → its node id (populated after the node is recorded). */
  localFns: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: alias / namespace-tail → dotted path. `ownerMethods`: type name →
   * declared member names. `fieldTypes`: `Type.field` → bare type name.
   * `freeFunctions`: always empty (C# has no free functions).
   */
  fnContext: Map<string, FnContext>;
  /** declared type → its direct bases (base class and interfaces). */
  bases: Map<string, string[]>;
  /** declared type → its field and property names, typed or not. */
  ownerFields: Map<string, Set<string>>;
  /** dotted paths of `using static A.B.C;` — they make members bare-callable. */
  staticUsings: string[];
}

/**
 * Scan-set-wide tables keyed by BARE type name. Needed because inheritance and
 * `partial` both cross module boundaries, which the spine's per-module tables
 * cannot express.
 */
interface CSharpIndexes {
  /** type → direct bases. */
  bases: Map<string, string[]>;
  /**
   * `Type.member` → the module that DECLARES it. Keyed by member rather than by
   * type because a `partial` type's members are split across files: knowing the
   * type's home module is not enough to name the id of one of its methods.
   */
  memberModules: Map<string, string>;
  /** `Type.field` → bare type name. */
  fieldTypes: Map<string, string>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(/\.cs$/, '').split('/').join('.');
}

/** First named child, or null. */
function firstNamed(node: Node): Node | null {
  return node.namedChildren.find((c) => c !== null) ?? null;
}

/**
 * Peel a type node down to the bare named type: `Engine?` → `Engine`,
 * `Engine[]` → `Engine`, `List<Engine>` → `List`, `A.B.Engine` → `Engine`.
 * Keyword types (`int`, `string`, `void`) and `var` come back as '' because the
 * grammar tags them `predefined_type` / `implicit_type` — no hand-maintained
 * builtin list is needed, and no BCL denylist either: `List` resolving to a
 * boundary node is true information, not noise to suppress.
 */
function coreTypeName(typeNode: Node | null | undefined): string {
  if (!typeNode) return '';
  switch (typeNode.type) {
    case 'identifier':
      return typeNode.text;
    case 'qualified_name':
      return typeNode.namedChildren.at(-1)?.text ?? '';
    case 'generic_name':
      return firstNamed(typeNode)?.text ?? '';
    case 'nullable_type':
      return coreTypeName(firstNamed(typeNode));
    case 'array_type':
      return coreTypeName(typeNode.childForFieldName('type'));
    default:
      return '';
  }
}

/** `A.B.C` when every segment is a plain name; '' as soon as one is not. */
function dottedPath(node: Node): string {
  const parts: string[] = [];
  let current: Node | null = node;
  while (current && current.type === 'member_access_expression') {
    const name = fieldText(current, 'name');
    if (!name) return '';
    parts.unshift(name);
    current = current.childForFieldName('expression');
  }
  if (!current || current.type !== 'identifier') return '';
  parts.unshift(current.text);
  return parts.join('.');
}

/** Last dotted segment of a `using` path. */
function tailOf(path: string): string {
  return path.split('.').pop() ?? path;
}

function collectUsing(node: Node, scan: ModuleScan): void {
  const isStatic = node.children.some((c) => c !== null && !c.isNamed && c.text === 'static');
  const alias = node.namedChildren.find((c) => c?.type === 'name_equals');
  const target = [...node.namedChildren]
    .reverse()
    .find((c) => c?.type === 'identifier' || c?.type === 'qualified_name');
  if (!target) return;
  const path = target.text;
  if (alias) {
    const local = firstNamed(alias);
    if (local) scan.imports.set(local.text, path);
    return;
  }
  if (isStatic) {
    scan.staticUsings.push(path);
    return;
  }
  // A plain `using` binds no symbol; keying it by its own tail is the only handle
  // it gives us, for a receiver written as the namespace tail.
  const tail = tailOf(path);
  if (!scan.imports.has(tail)) scan.imports.set(tail, path);
}

/** Attribute names on a declaration — C#'s decorators. */
function attributesOf(node: Node): string[] {
  const names: string[] = [];
  for (const list of node.namedChildren) {
    if (list?.type !== 'attribute_list') continue;
    for (const attr of list.namedChildren) {
      if (attr?.type !== 'attribute') continue;
      const name = coreTypeName(attr.childForFieldName('name'));
      if (name) names.push(name);
    }
  }
  return names;
}

function hasModifier(node: Node, keyword: string): boolean {
  return node.namedChildren.some((c) => c?.type === 'modifier' && c.text === keyword);
}

/**
 * Declaration text up to `stop` (its body), with leading attribute lists cut off
 * so the result reads as a signature rather than as a decorated declaration.
 */
function headerOf(node: Node, stop: Node | null): string {
  const attrs = node.namedChildren.filter((c) => c?.type === 'attribute_list');
  const from = attrs.length > 0 ? (attrs.at(-1)?.endIndex ?? node.startIndex) : node.startIndex;
  const to = stop ? stop.startIndex : node.endIndex;
  const text = node.text.slice(Math.max(0, from - node.startIndex), Math.max(0, to - node.startIndex));
  // A bodiless declaration runs to its own `;`, which is not part of a signature.
  return truncate(text.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim(), 200);
}

function paramTypesOf(node: Node): Map<string, string> {
  const types = new Map<string, string>();
  const list = node.childForFieldName('parameters');
  if (!list) return types;
  for (const p of list.namedChildren) {
    if (p?.type !== 'parameter') continue;
    const name = fieldText(p, 'name');
    const type = coreTypeName(p.childForFieldName('type'));
    if (name && type) types.set(name, type);
  }
  return types;
}

function paramNamesOf(node: Node): string[] {
  const list = node.childForFieldName('parameters');
  if (!list) return [];
  return list.namedChildren
    .filter((p) => p?.type === 'parameter')
    .map((p) => (p ? fieldText(p, 'name') : ''))
    .filter(Boolean);
}

/** `var e = new Engine();` — the initializer names the type the `var` hides. */
function typeFromInitializer(declarator: Node): string {
  const clause = declarator.namedChildren.find((c) => c?.type === 'equals_value_clause');
  const value = clause ? firstNamed(clause) : null;
  if (!value) return '';
  if (value.type === 'object_creation_expression') {
    return coreTypeName(value.childForFieldName('type'));
  }
  if (value.type === 'array_creation_expression') {
    return coreTypeName(firstNamed(value));
  }
  return '';
}

/**
 * Types and names of everything declared inside a body: `Engine e = …`,
 * `var e = new Engine()`, `foreach (Engine e in …)`, `catch (IOException ex)`.
 * Nested local functions are skipped — they get their own scope.
 */
function collectLocals(body: Node, types: Map<string, string>, names: Set<string>): void {
  walk(body, (node) => {
    if (node.type === 'local_function_statement') return false;
    if (node.type === 'variable_declaration') {
      const declared = coreTypeName(node.childForFieldName('type'));
      for (const declarator of node.namedChildren) {
        if (declarator?.type !== 'variable_declarator') continue;
        const nameNode = firstNamed(declarator);
        if (nameNode?.type !== 'identifier') continue;
        names.add(nameNode.text);
        const type = declared || typeFromInitializer(declarator);
        if (type) types.set(nameNode.text, type);
      }
      return false;
    }
    if (node.type === 'for_each_statement') {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') {
        names.add(left.text);
        const type = coreTypeName(node.childForFieldName('type'));
        if (type) types.set(left.text, type);
      }
      return undefined;
    }
    if (node.type === 'catch_declaration') {
      const name = fieldText(node, 'name');
      if (name) {
        names.add(name);
        const type = coreTypeName(node.childForFieldName('type'));
        if (type) types.set(name, type);
      }
      return undefined;
    }
    return undefined;
  });
}

/** `this.<prop>` — the property name, or '' if `node` is not that shape. */
function selfProp(node: Node): string {
  return node.type === 'member_access_expression' &&
    node.childForFieldName('expression')?.type === 'this_expression'
    ? fieldText(node, 'name')
    : '';
}

/**
 * `this.x` reads and writes, plus bare `x` where `x` is a field or property of
 * the enclosing type and nothing in scope shadows it — omitting `this.` is
 * idiomatic C#, and register inference would miss most real state without it.
 *
 * Descent is explicit (and iterative, so tree depth cannot overflow the stack)
 * because the interesting distinctions are positional: the member of an
 * invocation is a method name rather than state, a declared name is not a read,
 * and the left of `=` is a write while the left of `+=` is both.
 */
function trackSelfAttrs(
  body: Node,
  fields: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const bareField = (node: Node): string =>
    node.type === 'identifier' && fields.has(node.text) && !shadowed.has(node.text) ? node.text : '';
  const attrTarget = (node: Node): string => selfProp(node) || bareField(node);

  const stack: Node[] = [body];
  const push = (node: Node | null | undefined): void => {
    if (node) stack.push(node);
  };
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      case 'local_function_statement':
      case 'member_binding_expression':
      case 'attribute_list':
      case 'parameter':
        break;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const operator = node.namedChildren.find((c) => c?.type === 'assignment_operator')?.text ?? '=';
        const target = left ? attrTarget(left) : '';
        if (target) {
          writes.add(target);
          if (operator !== '=') reads.add(target);
        } else {
          push(left);
        }
        push(node.childForFieldName('right'));
        break;
      }
      case 'invocation_expression': {
        const callee = node.childForFieldName('function');
        if (callee?.type === 'member_access_expression') {
          push(callee.childForFieldName('expression'));
        } else if (callee?.type === 'conditional_access_expression') {
          push(callee.childForFieldName('condition'));
        } else if (callee && callee.type !== 'identifier' && callee.type !== 'generic_name') {
          push(callee);
        }
        push(node.childForFieldName('arguments'));
        break;
      }
      case 'member_access_expression': {
        const prop = selfProp(node);
        if (prop) reads.add(prop);
        else push(node.childForFieldName('expression'));
        break;
      }
      case 'variable_declaration': {
        // The declared names and the type annotation are not state reads.
        for (const declarator of node.namedChildren) {
          if (declarator?.type !== 'variable_declarator') continue;
          for (const part of declarator.namedChildren) {
            if (part?.type === 'equals_value_clause') push(part);
          }
        }
        break;
      }
      case 'object_creation_expression':
        push(node.childForFieldName('arguments'));
        break;
      default: {
        const bare = bareField(node);
        if (bare) {
          reads.add(bare);
          break;
        }
        for (const child of node.namedChildren) push(child);
      }
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface RecordOptions {
  name: string;
  qualname: string;
  className: string | null;
  isMethod: boolean;
  /** Node spanning the declaration — drives line numbers. */
  defNode: Node;
  /** Node owning `parameters` / modifiers; equals `defNode` except for accessors. */
  fnNode: Node;
  body: Node | null;
  signature: string;
  decorators: string[];
  file: string;
  /** Enclosing scope for a local function; C# local functions capture it. */
  inherited?: FnContext;
}

/**
 * Record one callable. Bodiless declarations (interface members, `abstract`,
 * `extern`) still become nodes — they are legitimate call targets, and omitting
 * them would leave edges pointing at ids that do not exist.
 */
function recordFunction(scan: ModuleScan, opts: RecordOptions): FnContext | undefined {
  const { name, qualname, className, defNode, fnNode, body, file } = opts;
  const id = `${scan.moduleId}.${qualname}`;
  const params = paramTypesOf(fnNode);

  const scopeTypes = new Map(opts.inherited?.scopeTypes ?? []);
  const declaredNames = new Set(opts.inherited?.declaredNames ?? []);
  for (const [param, type] of params) scopeTypes.set(param, type);
  for (const param of paramNamesOf(fnNode)) declaredNames.add(param);
  if (body) collectLocals(body, scopeTypes, declaredNames);

  const fields = className ? (scan.ownerFields.get(className) ?? new Set<string>()) : new Set<string>();
  const { reads, writes } = body ? trackSelfAttrs(body, fields, declaredNames) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(defNode),
    lineEnd: lineEnd(defNode),
    signature: opts.signature,
    isAsync: hasModifier(fnNode, 'async'),
    isMethod: opts.isMethod,
    className,
    decorators: opts.decorators,
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (!body) return undefined;
  const context: FnContext = { body, className, scopeTypes, declaredNames, localFns: new Map() };
  scan.fnContext.set(id, context);
  return context;
}

/**
 * Record a member and, transitively, the local functions declared inside it. A
 * local function becomes its own node (`Class.Method.Local`) so that calls to it
 * resolve to something real instead of collapsing into the enclosing member.
 */
function recordCallableTree(scan: ModuleScan, root: RecordOptions): void {
  const queue: RecordOptions[] = [root];
  while (queue.length > 0) {
    const opts = queue.pop();
    if (!opts) continue;
    const context = recordFunction(scan, opts);
    if (!context) continue;
    walk(context.body, (node) => {
      if (node.type !== 'local_function_statement') return undefined;
      const name = fieldText(node, 'name');
      if (!name) return false;
      const qualname = `${opts.qualname}.${name}`;
      context.localFns.set(name, `${scan.moduleId}.${qualname}`);
      queue.push({
        name,
        qualname,
        className: opts.className,
        isMethod: false,
        defNode: node,
        fnNode: node,
        body: node.childForFieldName('body'),
        signature: headerOf(node, node.childForFieldName('body')),
        decorators: attributesOf(node),
        file: opts.file,
        inherited: context,
      });
      return false;
    });
  }
}

function noteField(scan: ModuleScan, owner: string, field: string, type: string): void {
  scan.ownerFields.get(owner)?.add(field);
  if (type) scan.fieldTypes.set(`${owner}.${field}`, type);
}

/** Fields, properties and primary-constructor parameters of one type. */
function scanTypeState(scan: ModuleScan, owner: string, node: Node, body: Node | null): void {
  for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
    // A record's (or C# 12 class's) positional parameters ARE its state.
    if (p?.type !== 'parameter') continue;
    const name = fieldText(p, 'name');
    if (name) noteField(scan, owner, name, coreTypeName(p.childForFieldName('type')));
  }
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (FIELD_MEMBERS.has(member.type)) {
      const declaration = member.namedChildren.find((c) => c?.type === 'variable_declaration');
      if (!declaration) continue;
      const type = coreTypeName(declaration.childForFieldName('type'));
      for (const declarator of declaration.namedChildren) {
        if (declarator?.type !== 'variable_declarator') continue;
        const nameNode = firstNamed(declarator);
        if (nameNode?.type === 'identifier') noteField(scan, owner, nameNode.text, type);
      }
    } else if (member.type === 'property_declaration' || member.type === 'event_declaration') {
      const name = fieldText(member, 'name');
      if (name) noteField(scan, owner, name, coreTypeName(member.childForFieldName('type')));
    }
  }
}

/** Accessors with a body become `get_X` / `set_X` — their CLR method names. */
function scanAccessors(scan: ModuleScan, owner: string, member: Node, file: string): void {
  const property = fieldText(member, 'name') || (member.type === 'indexer_declaration' ? 'Item' : '');
  if (!property) return;
  const accessors = member.childForFieldName('accessors');
  const value = member.childForFieldName('value');

  const record = (kind: string, defNode: Node, body: Node): void => {
    const name = `${kind}_${property}`;
    scan.ownerMethods.get(owner)?.add(name);
    recordCallableTree(scan, {
      name,
      qualname: `${owner}.${name}`,
      className: owner,
      isMethod: true,
      defNode,
      fnNode: defNode,
      body,
      signature: headerOf(member, accessors ?? value),
      decorators: attributesOf(member),
      file,
    });
  };

  if (accessors) {
    for (const accessor of accessors.namedChildren) {
      if (accessor?.type !== 'accessor_declaration') continue;
      const body = accessor.childForFieldName('body');
      // `get;` is auto-implemented: no code, so nothing to describe.
      if (!body) continue;
      const kind = accessor.children.find(
        (c) => c !== null && !c.isNamed && ACCESSOR_KINDS.has(c.text),
      )?.text;
      if (kind) record(kind, accessor, body);
    }
    return;
  }
  // `public string Name => expr;` is an expression-bodied getter.
  if (value?.type === 'arrow_expression_clause') record('get', member, value);
}

/**
 * Emit the {@link TypeNode} for one type declaration. Separate from
 * `scanTypeDeclaration` so an enum — which declares nothing callable and so never
 * enters the call-resolution path — can be indexed by the same rules.
 */
function recordTypeDeclaration(scan: ModuleScan, node: Node, file: string, container: string | null): void {
  const kind = CSHARP_TYPE_KINDS.get(node.type);
  if (!kind) return;
  recordType(scan, {
    name: fieldText(node, 'name'),
    kind,
    node,
    body: node.childForFieldName('body'),
    file,
    container,
  });
}

function scanTypeDeclaration(scan: ModuleScan, node: Node, file: string, container: string | null): void {
  const owner = fieldText(node, 'name');
  if (!owner) return;
  recordTypeDeclaration(scan, node, file, container);
  if (!scan.ownerMethods.has(owner)) scan.ownerMethods.set(owner, new Set());
  if (!scan.ownerFields.has(owner)) scan.ownerFields.set(owner, new Set());

  const baseList = node.childForFieldName('bases');
  if (baseList) {
    let bases = scan.bases.get(owner);
    if (!bases) {
      bases = [];
      scan.bases.set(owner, bases);
    }
    for (const b of baseList.namedChildren) {
      const name = b ? coreTypeName(b) : '';
      if (name && !bases.includes(name)) bases.push(name);
    }
  }

  const body = node.childForFieldName('body');
  // State first: a method body may read a field declared below it.
  scanTypeState(scan, owner, node, body);

  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (ACCESSOR_MEMBERS.has(member.type)) {
      scanAccessors(scan, owner, member, file);
      continue;
    }
    if (
      member.type !== 'method_declaration' &&
      member.type !== 'constructor_declaration' &&
      member.type !== 'destructor_declaration'
    ) {
      continue;
    }
    // A destructor's declared name is the class name, which the constructor
    // already owns; `Finalize` is what it actually compiles to.
    const name = member.type === 'destructor_declaration' ? 'Finalize' : fieldText(member, 'name');
    if (!name) continue;
    scan.ownerMethods.get(owner)?.add(name);
    const memberBody = member.childForFieldName('body');
    recordCallableTree(scan, {
      name,
      qualname: `${owner}.${name}`,
      className: owner,
      isMethod: true,
      defNode: member,
      fnNode: member,
      body: memberBody,
      signature: headerOf(member, memberBody),
      decorators: attributesOf(member),
      file,
    });
  }
}

/** A method of the caller's own type, or of a scanned ancestor. */
function resolveSelfMethod(
  className: string,
  method: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved | undefined {
  const here = resolveOwnMethod(className, method, scan, std);
  if (here) return here;
  // Not in THIS scan: either the other half of a `partial` type, or inherited.
  const base = memberIdBase(className, method, own) ?? inheritedIdBase(className, method, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/** `base.M()` — start above the caller's own type. */
function resolveInherited(type: string, method: string, own: CSharpIndexes): Resolved | undefined {
  const base = inheritedIdBase(type, method, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/** `<declaring module>.<type>` when `type` itself declares `member`. */
function memberIdBase(type: string, member: string, own: CSharpIndexes): string | undefined {
  const module = own.memberModules.get(`${type}.${member}`);
  return module ? `${module}.${type}` : undefined;
}

/**
 * The nearest ancestor (base class or interface, transitively) that declares
 * `member`. Cycle-guarded via {@link ancestorsOf}, so a malformed
 * `class A : B` / `class B : A` pair cannot loop.
 */
function inheritedIdBase(type: string, member: string, own: CSharpIndexes): string | undefined {
  for (const ancestor of ancestorsOf(type, own)) {
    const base = memberIdBase(ancestor, member, own);
    if (base) return base;
  }
  return undefined;
}

/** Ancestors of `type` in breadth-first order, each visited once. */
function ancestorsOf(type: string, own: CSharpIndexes): string[] {
  const seen = new Set<string>([type]);
  const queue = [...(own.bases.get(type) ?? [])];
  const order: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    order.push(next);
    queue.push(...(own.bases.get(next) ?? []));
  }
  return order;
}

/** `this.field.M()` / bare `field.M()` through a learned field or property type. */
function resolveAttrMethod(
  className: string,
  field: string,
  method: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved | undefined {
  const direct = resolveFieldType(className, field, method, scan, std);
  if (direct) return direct;
  // An inherited field's type was learned in ANOTHER scan, which the spine
  // helper cannot reach — that is what the private field index is for.
  for (const ancestor of ancestorsOf(className, own)) {
    const type = own.fieldTypes.get(`${ancestor}.${field}`);
    if (!type) continue;
    const module = std.typeToModule.get(type);
    return module
      ? { calleeId: `${module}.${type}.${method}`, callType: 'self_attr_method' }
      : boundaryOf(type, method);
  }
  return undefined;
}

/** A bare call made visible by `using static A.B.Type;`. */
function resolveStaticUsing(method: string, scan: ModuleScan, own: CSharpIndexes): Resolved | undefined {
  for (const path of scan.staticUsings) {
    const base = memberIdBase(tailOf(path), method, own);
    if (base) return { calleeId: `${base}.${method}`, callType: 'internal_func' };
  }
  return undefined;
}

/**
 * A qualified call on a scanned type (`Other.Static()`, `A.B.Other.Static()`)
 * resolves to `internal_func` pointing at the real member: per the SP2 IR
 * decision a static call IS a call to an internal function, and inventing a
 * `static_method` callType nobody consumes would buy nothing.
 *
 * When the type is scanned but the member is not one we saw (a generated or
 * inherited-from-outside member), the edge still points into the type's home
 * module: the target IS internal, and calling it a boundary would be a lie.
 */
function resolveTypeMember(
  type: string,
  method: string,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved | undefined {
  const base =
    memberIdBase(type, method, own) ??
    inheritedIdBase(type, method, own) ??
    (std.typeToModule.has(type) ? `${std.typeToModule.get(type)}.${type}` : undefined);
  return base ? { calleeId: `${base}.${method}`, callType: 'internal_func' } : undefined;
}

function resolveAlias(
  base: string,
  method: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved | undefined {
  const path = scan.imports.get(base);
  if (!path) return undefined;
  return resolveTypeMember(tailOf(path), method, std, own) ?? boundaryOf(path, method);
}

function resolveMember(
  receiver: Node,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved {
  const { className } = context;

  // A. `this.M()`
  if (receiver.type === 'this_expression') {
    const hit = className ? resolveSelfMethod(className, method, scan, std, own) : undefined;
    return hit ?? unresolvedOf(`this.${method}`);
  }

  // B. `base.M()` — skip the caller's own type, start at its bases.
  if (receiver.type === 'base_expression') {
    const hit = className ? resolveInherited(className, method, own) : undefined;
    return hit ?? unresolvedOf(`base.${method}`);
  }

  // C. `this.field.M()`
  if (selfProp(receiver)) {
    const field = fieldText(receiver, 'name');
    const hit = className ? resolveAttrMethod(className, field, method, scan, std, own) : undefined;
    return hit ?? unresolvedOf(`this.${field}.${method}`);
  }

  // D. bare receiver: a value in scope, then own state, then a type name.
  if (receiver.type === 'identifier') {
    const base = receiver.text;
    const scoped = context.scopeTypes.get(base);
    if (scoped) {
      const module = std.typeToModule.get(scoped);
      if (module) return { calleeId: `${module}.${scoped}.${method}`, callType: 'param_method' };
      return boundaryOf(scoped, method);
    }
    if (className && !context.declaredNames.has(base)) {
      // `field.M()` written without `this.`
      const viaField = resolveAttrMethod(className, base, method, scan, std, own);
      if (viaField) return viaField;
    }
    const viaType = resolveTypeMember(base, method, std, own) ?? resolveAlias(base, method, scan, std, own);
    if (viaType) return viaType;
    // A PascalCase receiver that names no value in scope is a type we do not
    // have. Saying "boundary" is true (it is outside the scanned set) and more
    // informative than shrugging.
    if (/^[A-Z]/.test(base)) return boundaryOf(base, method);
    return unresolvedOf(`${base}.${method}`);
  }

  // E. `A.B.Type.M()` — fully qualified, as long as every segment is a name.
  const path = dottedPath(receiver);
  const head = path.split('.')[0] ?? '';
  if (path && !context.declaredNames.has(head)) {
    const type = tailOf(path);
    const viaType = resolveTypeMember(type, method, std, own);
    if (viaType) return viaType;
    if (/^[A-Z]/.test(type)) return boundaryOf(path, method);
  }
  return unresolvedOf(`${receiver.text}.${method}`);
}

function resolveCall(
  callee: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CSharpIndexes,
): Resolved {
  // Bare `M()` / `M<T>()`: a local function, then the type's own chain, then a
  // `using static` member. C# has no free functions, so there is nothing else.
  if (callee.type === 'identifier' || callee.type === 'generic_name') {
    const name = callee.type === 'generic_name' ? (firstNamed(callee)?.text ?? '') : callee.text;
    if (!name) return unresolvedOf(callee.text);
    const local = context.localFns.get(name);
    if (local) return { calleeId: local, callType: 'internal_func' };
    const hit = context.className ? resolveSelfMethod(context.className, name, scan, std, own) : undefined;
    return hit ?? resolveStaticUsing(name, scan, own) ?? unresolvedOf(name);
  }

  if (callee.type === 'member_access_expression') {
    const receiver = callee.childForFieldName('expression');
    const method = fieldText(callee, 'name');
    if (receiver && method) return resolveMember(receiver, method, scan, context, std, own);
  }

  // `x?.M()`
  if (callee.type === 'conditional_access_expression') {
    const receiver = callee.childForFieldName('condition');
    const binding = callee.namedChildren.find((c) => c?.type === 'member_binding_expression');
    const method = binding ? fieldText(binding, 'name') : '';
    if (receiver && method) return resolveMember(receiver, method, scan, context, std, own);
  }

  return unresolvedOf(callee.text);
}

/** `new Foo()`. The constructor's member name is the type name, as in source. */
function resolveNew(node: Node, scan: ModuleScan, std: StandardIndexes): Resolved {
  const type = coreTypeName(node.childForFieldName('type'));
  if (!type) return unresolvedOf(node.text);
  const module = scan.ownerMethods.has(type) ? scan.moduleId : std.typeToModule.get(type);
  if (module) {
    return { calleeId: `${module}.${type}.${type}`, callType: 'internal_constructor' };
  }
  const aliased = scan.imports.get(type);
  if (aliased) {
    const leaf = tailOf(aliased);
    const aliasModule = std.typeToModule.get(leaf);
    if (aliasModule) {
      return { calleeId: `${aliasModule}.${leaf}.${leaf}`, callType: 'internal_constructor' };
    }
    return boundaryOf(aliased, undefined, { isConstructor: true });
  }
  return boundaryOf(type, undefined, { isConstructor: true });
}

const CAPABILITIES: AdapterCapabilities = {
  tier: 'full',
  callTypes: [
    'self_method',
    'self_attr_method',
    'param_method',
    'internal_func',
    'internal_constructor',
    'boundary',
    'boundary_constructor',
    'unresolved',
  ],
  selfAttrs: true,
  statementSpans: false,
  typeKinds: declaredTypeKinds(CSHARP_TYPE_KINDS),
};

const CSHARP_SPEC: LanguageSpec<ModuleScan, CSharpIndexes> = {
  name: 'csharp',
  extensions: ['.cs'],
  grammarFor: () => 'c_sharp',
  // `bin` and `obj` hold compiler output, including generated sources.
  extraSkipDirs: ['bin', 'obj'],
  // Machine-written partials: designer files, XAML/WinForms codegen and the
  // conventional `.generated.cs` suffix. All are cheap to spot and describe
  // nothing a reader wrote.
  discoverFilter: (rel) =>
    !rel.endsWith('.Designer.cs') && !rel.endsWith('.g.cs') && !rel.endsWith('.generated.cs'),
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
      fieldTypes: new Map(),
      freeFunctions: new Set(),
      bases: new Map(),
      ownerFields: new Map(),
      staticUsings: [],
    };
  },

  scan(scan, root, file) {
    // Containers worklist rather than recursion: namespaces and nested types
    // both nest, and an explicit stack cannot overflow on pathological input.
    // Each frame carries the enclosing TYPE's qualname, which is null under a
    // namespace: a namespace is a scope, not a type, so `A.B.Outer.Inner` would
    // put a package path in a field that means "the type this one is declared
    // inside". Nested types therefore come out as `Outer.Inner`, which is both
    // unique within the module and how C# source refers to them.
    const containers: Array<{ node: Node; owner: string | null }> = [{ node: root, owner: null }];
    while (containers.length > 0) {
      const frame = containers.pop();
      if (!frame) continue;
      for (const child of frame.node.namedChildren) {
        if (!child) continue;
        if (child.type === 'using_directive') {
          collectUsing(child, scan);
        } else if (NAMESPACE_DECLS.has(child.type)) {
          // A file-scoped namespace has no body: its members are its children.
          containers.push({ node: child.childForFieldName('body') ?? child, owner: frame.owner });
        } else if (TYPE_DECLS.has(child.type)) {
          scanTypeDeclaration(scan, child, file, frame.owner);
          const name = fieldText(child, 'name');
          const body = child.childForFieldName('body');
          // Re-visiting the body only picks up NESTED type declarations; its
          // ordinary members are not container children.
          if (body) {
            containers.push({
              node: body,
              owner: name ? (frame.owner ? `${frame.owner}.${name}` : name) : frame.owner,
            });
          }
        } else if (child.type === 'enum_declaration' || child.type === 'delegate_declaration') {
          // Indexed but never scanned for members: an enum's members are not
          // callable, and a delegate declares none at all — its `Invoke` is
          // synthesised by the compiler, and inventing a node for it would put a
          // function nobody wrote into the call graph.
          recordTypeDeclaration(scan, child, file, frame.owner);
        }
      }
    }
    // Ids must be unique; on (invalid) duplicate members keep the last, matching
    // the shared-body pass-2 lookup so edges are not multiplied.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes(scans) {
    const bases = new Map<string, string[]>();
    const memberModules = new Map<string, string>();
    const fieldTypes = new Map<string, string>();
    for (const scan of scans) {
      for (const [type, list] of scan.bases) {
        let all = bases.get(type);
        if (!all) {
          all = [];
          bases.set(type, all);
        }
        for (const base of list) if (!all.includes(base)) all.push(base);
      }
      for (const [type, declared] of scan.ownerMethods) {
        // First declaration wins, matching the spine's typeToModule convention.
        for (const member of declared) {
          const key = `${type}.${member}`;
          if (!memberModules.has(key)) memberModules.set(key, scan.moduleId);
        }
      }
      for (const [key, type] of scan.fieldTypes) {
        if (!fieldTypes.has(key)) fieldTypes.set(key, type);
      }
    }
    return { bases, memberModules, fieldTypes };
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      walk(context.body, (node) => {
        // A local function is its own node with its own body walk. Lambdas are
        // NOT skipped: they are pervasive in C# and have no identity of their
        // own in the IR, so their calls belong to the member that contains them.
        if (node.type === 'local_function_statement') return false;
        const isAwait = node.parent?.type === 'await_expression';
        if (node.type === 'invocation_expression') {
          const callee = node.childForFieldName('function');
          if (!callee) return undefined;
          const resolved = resolveCall(callee, scan, context, std, own);
          edges.push({
            callerId: fn.id,
            calleeId: resolved.calleeId,
            isAwait,
            callType: resolved.callType,
            line: lineStart(node),
            raw: truncate(callee.text, 80),
          });
        } else if (node.type === 'object_creation_expression') {
          const resolved = resolveNew(node, scan, std);
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
  },
};

export class CSharpAdapter extends SpineAdapter<ModuleScan, CSharpIndexes> {
  constructor() {
    super(CSHARP_SPEC);
  }
}
