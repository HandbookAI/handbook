/**
 * Swift adapter (tree-sitter grammar `swift`).
 *
 * ⚠ GRAMMAR HAZARD — READ BEFORE REGISTERING THIS ADAPTER ⚠
 *
 * `tree-sitter-wasms@0.1.13`'s `tree-sitter-swift.wasm` **fatally aborts the
 * process** on Node ≥ 22 (verified on 24.14.0 and 24.18.0, V8 13.6): the first
 * `parse()` makes a wasm function hot, V8 tiers it up, and turboshaft asks its
 * compiler zone for a single allocation over `INT_MAX`, which is an immediate
 * `Fatal process out of memory: Zone` — not memory pressure (peak RSS 73 MB,
 * 0.17 s of user time before the abort). It is 100% reproducible from a bare
 * `parse('class A {}')` and it takes the whole process down, so it cannot be
 * caught. Node 21.7.3 (V8 11.8) and older are unaffected. All 18 other grammars
 * in the same package were tested the same way and every one of them is fine —
 * this is Swift's grammar alone.
 *
 * No in-process fix exists: `v8.setFlagsFromString` cannot durably change wasm
 * tiering (`--liftoff-only`, `--no-wasm-tier-up`, `--wasm-tier-up-filter` all
 * still abort when set at runtime), and NODE_OPTIONS rejects V8 flags. Only
 * launching node with `--liftoff-only` (or a large `--wasm-tiering-budget`)
 * avoids it, which is a process-launch decision this package cannot make.
 *
 * The adapter below is complete and verified against a V8 without the bug; its
 * tests self-guard and skip where the grammar would abort the runner.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Two passes, like every adapter:
 *   1. scan each file: imports, every type declaration (class / struct / enum /
 *      actor / protocol, nested ones included), every `extension` block, stored
 *      and computed property types, members, and per-member parameter/local
 *      types plus `self.x` usage;
 *   2. resolve every call site against the cross-module indexes into typed
 *      {@link CallEdge}s.
 *
 * Three things make Swift different from the other typed adapters:
 *
 * - **`extension` blocks attach members to a type declared elsewhere**, usually
 *   in another file. This is Swift's defining structural feature and the same
 *   problem C# `partial` types pose: knowing a type's home module is not enough
 *   to name the id of one of its methods. So a scan-set-wide `Type.member → the
 *   module that declares it` index does the work, and members of an extension
 *   land on the extended type (`className`, `qualname`, `ownerMethods`) rather
 *   than becoming free functions. The grammar spells an extension
 *   `class_declaration` with `declaration_kind` = `extension`, exactly like a
 *   class — the declaration kind is the only thing that distinguishes them.
 * - **Nested types are scope-qualified.** `enum Outer { struct Inner {} }`
 *   declares `Outer.Inner`, and inside `Outer` it is reachable as plain `Inner`.
 *   The scope here is the enclosing TYPE (Swift has no namespaces), so the
 *   spine's shared scoped index is keyed by enclosing-type path and read
 *   through {@link lookupScoped} with the chain "innermost type outward →
 *   file scope".
 * - **There is no `new`.** `Engine()` is a constructor call, and the same
 *   syntax with a lowercase name is an ordinary function call, so the two are
 *   told apart by what the scanned set knows, falling back to Swift's
 *   universally observed capitalization convention for types.
 *
 * Module ids stay path-derived (`Sources/App/Engine.swift` →
 * `Sources.App.Engine`) like every other adapter. That is not a compromise
 * here: Swift's unit of namespacing IS the module/target, files inside it have
 * no scope of their own, and ids must be unique per definition.
 *
 * Ids follow the repo-wide convention `id = <moduleId>.<qualname>` with
 * `qualname = <Type>.<member>`, enclosing types included for nested ones
 * (`Outer.Inner.deep`), so `graph.ts:synthesizeConstructor` can still decompose
 * `<module>.<Type>.<member>`.
 *
 * ── Known gaps, stated rather than hidden ───────────────────────────────────
 *
 * - **Argument labels are not in ids.** `move(to:)` and `move(from:)` are
 *   different functions in Swift but this IR has no arity or labels in an id,
 *   so overloads — label overloads, type overloads, and `subscript` overloads
 *   alike — collapse onto one node and the last declaration wins.
 * - **Generic specialization is not modelled.** `Box<Engine>` peels to `Box`;
 *   a call on a value of generic parameter type `T` is unresolved.
 * - **Protocol-witness dispatch is not resolved to the implementation.**
 *   `drawable.draw()` where `drawable: Drawable` lands on the protocol's own
 *   requirement (or its protocol-extension default), never on the concrete
 *   conforming type — there is no way to pick one at a call site statically.
 * - `@dynamicMemberLookup`, `@dynamicCallable`, key paths (`\.foo`),
 *   `#selector`/`#keyPath`, and operator declarations (`static func ==`) are
 *   not recorded: the grammar gives an operator declaration an ANONYMOUS name
 *   node, and a key path names no call.
 * - **Conditional compilation is not evaluated.** `#if os(iOS)` parses cleanly
 *   (the `directive` nodes are flat siblings and every branch's declarations
 *   stay in the tree), so all branches are scanned. That over-counts rather
 *   than under-counts: a symbol defined in two branches collapses to one node.
 * - **Collection types peel to the container, not the element**: `[Engine]` →
 *   `Array`, `[String: Engine]` → `Dictionary`. That is what the value's type
 *   actually is, so `items.map { … }` becomes `boundary:Array.map`. Peeling to
 *   `Engine` instead would manufacture a `Engine.map` edge into the scanned set
 *   that does not exist. `Engine?` (and `Engine!`) DO peel to `Engine`, because
 *   an optional's members are the wrapped type's.
 * - **Top-level code has no enclosing member** (`main.swift`, global `let`
 *   initializers), so its calls are attributed to nothing, as in C#.
 * - Property observers become `willSet_x` / `didSet_x` nodes and accessors
 *   `get_x` / `set_x`, mirroring the C# adapter's CLR-style accessor names.
 *   Protocol property requirements (`var size: Int { get }`) contribute their
 *   type but no node — they have no body anywhere to describe.
 * - Local variables are typed from an explicit annotation or from a direct
 *   `T()` / `T.static()` initializer only; no dataflow.
 * - A bare capitalized call the scanned set does not know (`NSLog("x")`) is
 *   reported as a boundary CONSTRUCTOR, following Swift's near-universal
 *   "types are capitalized, functions are not" convention. Swift's implicitly
 *   imported standard-library globals (`print`, `min`, `abs`) are lowercase and
 *   named by no import, so they come out `unresolved` — nothing distinguishes
 *   them from a typo.
 *
 * ── Grammar defects measured in the pinned wasm ─────────────────────────────
 *
 * Three constructs the grammar cannot parse. All three degrade LOCALLY —
 * verified by test, and unlike the C++ adapter's `extern "C"` (which swallowed
 * whole translation units) the surrounding declarations and their calls are
 * still recovered:
 *   - raw string literals, `#"…"#`;
 *   - Swift 5.9 macro expansions, `#m(1)` (a `macro` DECLARATION parses fine);
 *   - Swift 6 typed throws, `throws(MyError)` — the function is still found,
 *     but its signature text carries the error node.
 * Everything else thrown at it parses clean: SwiftUI result builders and
 * trailing closures, `@propertyWrapper` with `$projectedValue`, `guard let` /
 * `if case let` / `switch` bindings, multi-line strings with interpolation,
 * `async let` and task groups, actors, `some`/`any`, conditional conformance,
 * capture lists, multiple trailing closures, indirect enums, and `#if` /
 * `#elseif` / `#else` nesting at file, type-body and expression level.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, Logger, TypeKind } from '@handbooks/core';
import { truncate } from '@handbooks/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  declaredTypeKinds,
  lookupScoped,
  recordType,
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

/**
 * `class`, `struct`, `enum`, `actor` and `extension` are all `class_declaration`
 * in this grammar, told apart only by the `declaration_kind` field. `protocol`
 * is its own node type.
 */
const EXTENSION_KIND = 'extension';

/**
 * Discriminator → the {@link TypeKind} it declares, for THIS grammar.
 *
 * Keyed by `declaration_kind` for a `class_declaration` and by NODE TYPE for the
 * two declarations that have their own — which is what makes the capability
 * derivable from the mapping instead of hand-listed. The two key spaces cannot
 * collide: a `declaration_kind` is a bare keyword, a node type ends in
 * `_declaration`.
 *
 * `actor` is `class`. It is nominal, instantiable, and owns methods and state —
 * every clause of the definition — and its one distinguishing property (actor
 * isolation) is a rule about how its members may be CALLED, not about the shape of
 * the declaration. Same call the vocabulary already makes for a Kotlin `object`.
 *
 * `protocol` is `interface`, which the vocabulary states outright.
 *
 * `extension` is deliberately absent, and this is the one omission that matters:
 * `extension Engine { … }` declares NO type. Its `name` field is the extended
 * type, declared somewhere else entirely — usually in another file, often in
 * another module — so a row for it would report `Engine` as being declared at a
 * line where it is not, and an agent that opened that span would read an
 * extension block believing it was the definition. That is a wrong pointer, which
 * is worse than a missing one. Extension MEMBERS are still recorded, attached to
 * the type they extend; it is only the type row that would be a lie.
 *
 * Also absent: `associatedtype` (a placeholder inside a protocol, not a
 * declaration of a concrete type) and `enum case` / a `case`'s payload.
 */
const SWIFT_TYPE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ['class', 'class'],
  ['actor', 'class'],
  ['struct', 'struct'],
  ['enum', 'enum'],
  ['protocol_declaration', 'interface'],
  ['typealias_declaration', 'alias'],
]);

/** The kind a declaration node declares, or undefined for an `extension`. */
function swiftTypeKind(node: Node): TypeKind | undefined {
  const key =
    node.type === 'class_declaration' ? (node.childForFieldName('declaration_kind')?.text ?? '') : node.type;
  return SWIFT_TYPE_KINDS.get(key);
}

/** Bodies whose children are a type's members. */
const TYPE_BODIES = new Set(['class_body', 'enum_class_body', 'protocol_body']);

/** Expression wrappers that are transparent for receiver analysis. */
const TRANSPARENT = new Set(['await_expression', 'try_expression', 'prefix_expression']);

/** Nested scopes that own their own node and must not be walked twice. */
const NESTED_FN = 'function_declaration';

interface FnContext {
  body: Node;
  /** Fully-qualified enclosing type path (`Outer.Inner`), or null for a free fn. */
  owner: string | null;
  /** Type-name lookup order: innermost enclosing type outward, then file scope. */
  scopes: string[];
  /** parameters + locals whose type we learned → peeled type name as written. */
  scopeTypes: Map<string, string>;
  /** every name bound in this scope, typed or not — shadows properties. */
  declaredNames: Set<string>;
  /** nested function name → its node id. */
  localFns: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: module or imported-symbol name → dotted path. `ownerMethods`:
   * fully-qualified type path → the member names THIS scan declares for it
   * (an extension contributes here without declaring the type). `fieldTypes`:
   * `Type.property` → peeled type name. `freeFunctions`: top-level `func`s.
   */
  fnContext: Map<string, FnContext>;
  /** Only types this scan DECLARES; an extension must not claim the type. */
  typeModules: Map<string, string>;
  /** Enclosing-type scope ('' = file scope) → simple names declared in it. */
  scopedTypes: Map<string, Set<string>>;
  /** type path → superclass and protocol names, as written (extensions add). */
  bases: Map<string, string[]>;
  /** type path → its property names, typed or not. */
  ownerFields: Map<string, Set<string>>;
}

/**
 * Scan-set-wide tables. Extensions split a type's members across files exactly
 * as C# `partial` does, so the spine's per-module tables cannot say which file
 * declares a given member, and a Swift module is the whole target rather than
 * one directory.
 */
interface SwiftIndexes {
  /** type path → direct bases (superclass + conformances, from all files). */
  bases: Map<string, string[]>;
  /** `Type.member` → the module that DECLARES it (first declaration wins). */
  memberModules: Map<string, string>;
  /** `Type.property` → peeled type name, across the whole scan set. */
  fieldTypes: Map<string, string>;
  /** free function name → owning module; a Swift module spans every file. */
  freeFunctions: Map<string, string>;
}

export function moduleIdForFile(file: string): string {
  return file
    .replace(/\.swift$/, '')
    .split('/')
    .join('.');
}

/** `<scope>.<name>`, or just `<name>` at file scope. */
function qualify(scope: string, name: string): string {
  return scope ? `${scope}.${name}` : name;
}

/** Lookup order for a type name used inside `scope`: innermost outward. */
function scopeChain(scope: string): string[] {
  const chain: string[] = [];
  let current = scope;
  while (current) {
    chain.push(current);
    const at = current.lastIndexOf('.');
    current = at < 0 ? '' : current.slice(0, at);
  }
  chain.push('');
  return chain;
}

/** Every child carrying `field`, in order. Swift reuses `name` for return types. */
function fieldNodes(node: Node, field: string): Node[] {
  return node.childrenForFieldName(field).filter((c): c is Node => c !== null);
}

/**
 * Peel a type node down to the named type a member lookup would run against:
 * `Engine?` / `Engine!` → `Engine`, `Box<Engine>` → `Box`, `A.B.Engine` →
 * `A.B.Engine` (kept whole so the scoped index can place it), `[Engine]` →
 * `Array`, `[String: Engine]` → `Dictionary`. Tuples, closures and anything
 * exotic come back as '' — no type learned is better than a wrong one.
 */
function coreTypeName(typeNode: Node | null | undefined): string {
  if (!typeNode) return '';
  switch (typeNode.type) {
    case 'type_identifier':
    case 'simple_identifier':
      return typeNode.text;
    case 'user_type': {
      // `Box<Engine>` and `A.B.Engine` are both user_type; the type_arguments
      // child is the generic list, and dots are anonymous separators.
      const parts = typeNode.children
        .filter((c): c is Node => c !== null && c.type === 'type_identifier')
        .map((c) => c.text);
      return parts.join('.');
    }
    case 'optional_type':
      return coreTypeName(typeNode.childForFieldName('wrapped') ?? typeNode.namedChildren[0]);
    case 'array_type':
      return 'Array';
    case 'dictionary_type':
      return 'Dictionary';
    case 'metatype':
      return coreTypeName(typeNode.namedChildren[0]);
    default:
      return '';
  }
}

/** The type annotation attached to a declaration, peeled. */
function annotatedType(node: Node): string {
  const annotation = node.namedChildren.find((c) => c?.type === 'type_annotation');
  return annotation ? coreTypeName(annotation.childForFieldName('name')) : '';
}

/** `let e = Engine()` / `let e = Engine.make()` — the type the initializer names. */
function typeFromInitializer(value: Node | null): string {
  if (value?.type !== 'call_expression') return '';
  const callee = value.namedChildren[0];
  if (!callee) return '';
  if (callee.type === 'simple_identifier') {
    return /^[A-Z]/.test(callee.text) ? callee.text : '';
  }
  if (callee.type === 'navigation_expression') {
    // `Engine.make()` names Engine, but only when the receiver is a type name.
    const target = callee.childForFieldName('target');
    const head = target && target.type === 'simple_identifier' ? target.text : '';
    return /^[A-Z]/.test(head) ? head : '';
  }
  return '';
}

/** The bound name of a `name: pattern` child (`let engine: Engine` → `engine`). */
function boundName(node: Node): string {
  const pattern = node.childForFieldName('name');
  if (!pattern) return '';
  const bound = pattern.childForFieldName('bound_identifier');
  return bound?.text ?? (pattern.type === 'simple_identifier' ? pattern.text : '');
}

/** Attribute names on a declaration — Swift's decorators (`@objc`, `@MainActor`). */
function attributesOf(node: Node): string[] {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  if (!modifiers) return [];
  const names: string[] = [];
  for (const attr of modifiers.namedChildren) {
    if (attr?.type !== 'attribute') continue;
    const name = attr.namedChildren.find((c) => c?.type === 'user_type');
    if (name) names.push(coreTypeName(name));
  }
  return names.filter(Boolean);
}

function hasKeyword(node: Node, keyword: string): boolean {
  return node.children.some((c) => c !== null && !c.isNamed && c.text === keyword);
}

/** Does a `modifiers` block carry `static` or `class` (a type-level member)? */
function isStaticMember(node: Node): boolean {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  return modifiers ? /\b(static|class)\b/.test(modifiers.text) : false;
}

/**
 * Declaration text up to `stop` (its body), with leading attributes cut off so
 * the result reads as a signature. Unlike C#, Swift keeps attributes inside the
 * same `modifiers` node as `public` and `static`, so only the attribute
 * children are skipped, never the whole block.
 */
function headerOf(node: Node, stop: Node | null): string {
  const modifiers = node.namedChildren.find((c) => c?.type === 'modifiers');
  const attrs = modifiers?.namedChildren.filter((c) => c?.type === 'attribute') ?? [];
  const from = attrs.length > 0 ? (attrs.at(-1)?.endIndex ?? node.startIndex) : node.startIndex;
  const to = stop ? stop.startIndex : node.endIndex;
  const text = node.text.slice(Math.max(0, from - node.startIndex), Math.max(0, to - node.startIndex));
  return truncate(text.replace(/\s+/g, ' ').trim(), 200);
}

/** Parameter internal name → peeled type. The external label is not in the id. */
function paramTypesOf(node: Node): Map<string, string> {
  const types = new Map<string, string>();
  for (const p of node.namedChildren) {
    if (p?.type !== 'parameter') continue;
    const parts = fieldNodes(p, 'name');
    // `label internal: Type` → [external?, internal, type]; the internal name is
    // the last simple_identifier, the type is whatever follows it.
    const nameNode = [...parts].reverse().find((c) => c.type === 'simple_identifier');
    const typeNode = parts.find((c) => c.type !== 'simple_identifier');
    const name = nameNode?.text ?? '';
    const type = coreTypeName(typeNode);
    if (name && name !== '_' && type) types.set(name, type);
  }
  return types;
}

function paramNamesOf(node: Node): string[] {
  const names: string[] = [];
  for (const p of node.namedChildren) {
    if (p?.type !== 'parameter') continue;
    const nameNode = [...fieldNodes(p, 'name')].reverse().find((c) => c.type === 'simple_identifier');
    if (nameNode && nameNode.text !== '_') names.push(nameNode.text);
  }
  return names;
}

/**
 * Names and types bound inside a body: `let e = Engine()`, `var f: Engine = …`,
 * `for item in …`, `if let x = …`, `guard let y = …`, closure parameters.
 * Nested functions are skipped — they get their own scope.
 */
function collectLocals(body: Node, types: Map<string, string>, names: Set<string>): void {
  walk(body, (node) => {
    if (node.type === NESTED_FN) return false;
    switch (node.type) {
      case 'property_declaration': {
        const name = boundName(node);
        if (!name) return undefined;
        names.add(name);
        const type = annotatedType(node) || typeFromInitializer(node.childForFieldName('value'));
        if (type) types.set(name, type);
        return undefined;
      }
      case 'for_statement': {
        const item = node.childForFieldName('item');
        const bound = item?.childForFieldName('bound_identifier') ?? item;
        if (bound?.type === 'simple_identifier') names.add(bound.text);
        return undefined;
      }
      case 'lambda_parameter': {
        const name = fieldText(node, 'name');
        if (name) names.add(name);
        return undefined;
      }
      case 'if_statement':
      case 'guard_statement':
      case 'while_statement': {
        // `if let x = expr`: the binding is a sibling `bound_identifier` field.
        for (const bound of fieldNodes(node, 'bound_identifier')) {
          if (bound.type === 'simple_identifier') names.add(bound.text);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  });
}

/** `self.<prop>` — the property name, or '' if `node` is not that shape. */
function selfProp(node: Node): string {
  if (node.type !== 'navigation_expression') return '';
  if (node.childForFieldName('target')?.type !== 'self_expression') return '';
  return navigationName(node);
}

/** The member name of a `navigation_expression` (`a.b` → `b`). */
function navigationName(node: Node): string {
  const suffix = node.childForFieldName('suffix');
  return suffix ? fieldText(suffix, 'suffix') : '';
}

/**
 * `self.x` reads and writes, plus bare `x` where `x` is a property of the
 * enclosing type and nothing in scope shadows it — omitting `self.` is not just
 * idiomatic Swift, it is required outside closures, so register inference would
 * miss nearly all state without it.
 *
 * Descent is explicit (and iterative, so tree depth cannot overflow the stack)
 * because the interesting distinctions are positional: the member of a call is
 * a method name rather than state, a declared name is not a read, and the left
 * of `=` is a write while the left of `+=` is both.
 */
function trackSelfAttrs(
  body: Node,
  fields: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const bareField = (node: Node): string =>
    node.type === 'simple_identifier' && fields.has(node.text) && !shadowed.has(node.text) ? node.text : '';
  const attrTarget = (node: Node): string => {
    const inner = node.type === 'directly_assignable_expression' ? node.namedChildren[0] : node;
    return inner ? selfProp(inner) || bareField(inner) : '';
  };

  const stack: Node[] = [body];
  const push = (node: Node | null | undefined): void => {
    if (node) stack.push(node);
  };
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      case NESTED_FN:
      case 'modifiers':
      case 'parameter':
      case 'type_annotation':
        break;
      case 'assignment': {
        const left = node.childForFieldName('target');
        const operator = node.childForFieldName('operator')?.text ?? '=';
        const target = left ? attrTarget(left) : '';
        if (target) {
          writes.add(target);
          if (operator !== '=') reads.add(target);
        } else {
          push(left);
        }
        push(node.childForFieldName('result'));
        break;
      }
      case 'call_expression': {
        // The callee's trailing member is a method name, not state; its
        // receiver still is. `self.engine.spin()` reads `engine`.
        const callee = node.namedChildren[0];
        if (callee?.type === 'navigation_expression') push(callee.childForFieldName('target'));
        else if (callee && callee.type !== 'simple_identifier') push(callee);
        for (const child of node.namedChildren.slice(1)) push(child);
        break;
      }
      case 'navigation_expression': {
        const prop = selfProp(node);
        if (prop) reads.add(prop);
        else push(node.childForFieldName('target'));
        break;
      }
      case 'property_declaration': {
        // The bound name and its annotation are not state reads.
        push(node.childForFieldName('value'));
        push(node.namedChildren.find((c) => c?.type === 'computed_property'));
        push(node.namedChildren.find((c) => c?.type === 'willset_didset_block'));
        break;
      }
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
  /** Fully-qualified enclosing type path, or null. */
  owner: string | null;
  isMethod: boolean;
  /** Node spanning the declaration — drives line numbers and the signature. */
  defNode: Node;
  /** Node owning `parameter` children; equals `defNode` except for accessors. */
  fnNode: Node;
  body: Node | null;
  signature: string;
  decorators: string[];
  isAsync: boolean;
  file: string;
  scopes: string[];
  /** Enclosing scope for a nested function; Swift nested functions capture it. */
  inherited?: FnContext;
}

/**
 * Record one callable. Bodiless declarations (protocol requirements) still
 * become nodes — they are legitimate call targets, and omitting them would
 * leave edges pointing at ids that do not exist.
 */
function recordFunction(scan: ModuleScan, opts: RecordOptions): FnContext | undefined {
  const { name, qualname, owner, defNode, fnNode, body, file } = opts;
  const id = `${scan.moduleId}.${qualname}`;
  const params = paramTypesOf(fnNode);

  const scopeTypes = new Map(opts.inherited?.scopeTypes ?? []);
  const declaredNames = new Set(opts.inherited?.declaredNames ?? []);
  for (const [param, type] of params) scopeTypes.set(param, type);
  for (const param of paramNamesOf(fnNode)) declaredNames.add(param);
  if (body) collectLocals(body, scopeTypes, declaredNames);

  const fields = owner ? (scan.ownerFields.get(owner) ?? new Set<string>()) : new Set<string>();
  const { reads, writes } = body ? trackSelfAttrs(body, fields, declaredNames) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(defNode),
    lineEnd: lineEnd(defNode),
    signature: opts.signature,
    isAsync: opts.isAsync,
    isMethod: opts.isMethod,
    className: owner,
    decorators: opts.decorators,
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(params),
  });
  if (!body) return undefined;
  const context: FnContext = {
    body,
    owner,
    scopes: opts.scopes,
    scopeTypes,
    declaredNames,
    localFns: new Map(),
  };
  scan.fnContext.set(id, context);
  return context;
}

/**
 * Record a callable and, transitively, the functions nested inside it. A nested
 * function becomes its own node (`Type.method.inner`) so calls to it resolve to
 * something real instead of collapsing into the enclosing member.
 */
function recordCallableTree(scan: ModuleScan, root: RecordOptions): void {
  const queue: RecordOptions[] = [root];
  while (queue.length > 0) {
    const opts = queue.pop();
    if (!opts) continue;
    const context = recordFunction(scan, opts);
    if (!context) continue;
    walk(context.body, (node) => {
      if (node.type !== NESTED_FN) return undefined;
      const nameNode = node.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'simple_identifier') return false;
      const name = nameNode.text;
      const qualname = `${opts.qualname}.${name}`;
      context.localFns.set(name, `${scan.moduleId}.${qualname}`);
      const body = node.childForFieldName('body');
      queue.push({
        name,
        qualname,
        owner: opts.owner,
        isMethod: false,
        defNode: node,
        fnNode: node,
        body,
        signature: headerOf(node, body),
        decorators: attributesOf(node),
        isAsync: hasKeyword(node, 'async'),
        file: opts.file,
        scopes: opts.scopes,
        inherited: context,
      });
      return false;
    });
  }
}

function noteField(scan: ModuleScan, owner: string, field: string, type: string): void {
  scan.ownerFields.get(owner)?.add(field);
  const key = `${owner}.${field}`;
  if (type && !scan.fieldTypes.has(key)) scan.fieldTypes.set(key, type);
}

/** `get_x` / `set_x` / `willSet_x` / `didSet_x` for a property's code blocks. */
function scanAccessors(
  scan: ModuleScan,
  owner: string,
  member: Node,
  property: string,
  file: string,
  scopes: string[],
): void {
  const record = (kind: string, defNode: Node, body: Node): void => {
    const name = `${kind}_${property}`;
    scan.ownerMethods.get(owner)?.add(name);
    recordCallableTree(scan, {
      name,
      qualname: `${owner}.${name}`,
      owner,
      isMethod: true,
      defNode,
      fnNode: defNode,
      body,
      signature: `${kind} ${property}`,
      decorators: attributesOf(member),
      isAsync: false,
      file,
      scopes,
    });
  };

  const computed = member.namedChildren.find((c) => c?.type === 'computed_property');
  if (computed) {
    const explicit = computed.namedChildren.filter(
      (c) => c?.type === 'computed_getter' || c?.type === 'computed_setter',
    );
    if (explicit.length > 0) {
      for (const accessor of explicit) {
        if (!accessor) continue;
        record(accessor.type === 'computed_getter' ? 'get' : 'set', accessor, accessor);
      }
    } else if (computed.namedChildren.some((c) => c?.type === 'statements')) {
      // `var computed: Int { return 1 }` — an implicit getter.
      record('get', computed, computed);
    }
    return;
  }
  const observers = member.namedChildren.find((c) => c?.type === 'willset_didset_block');
  for (const clause of observers?.namedChildren ?? []) {
    if (clause?.type === 'willset_clause') record('willSet', clause, clause);
    else if (clause?.type === 'didset_clause') record('didSet', clause, clause);
  }
}

/** One member of a type body. Returns a nested type declaration to recurse into. */
function scanMember(
  scan: ModuleScan,
  owner: string,
  member: Node,
  file: string,
  scopes: string[],
): Node | undefined {
  switch (member.type) {
    case 'property_declaration':
    case 'protocol_property_declaration': {
      const name = boundName(member);
      if (!name) return undefined;
      noteField(
        scan,
        owner,
        name,
        annotatedType(member) || typeFromInitializer(member.childForFieldName('value')),
      );
      if (member.type === 'property_declaration') scanAccessors(scan, owner, member, name, file, scopes);
      return undefined;
    }
    case 'function_declaration':
    case 'protocol_function_declaration': {
      const nameNode = member.childForFieldName('name');
      // An operator declaration's name is an anonymous token, not an identifier.
      if (!nameNode || nameNode.type !== 'simple_identifier') return undefined;
      recordMember(scan, owner, member, nameNode.text, file, scopes);
      return undefined;
    }
    case 'init_declaration':
      recordMember(scan, owner, member, 'init', file, scopes);
      return undefined;
    case 'deinit_declaration':
      recordMember(scan, owner, member, 'deinit', file, scopes);
      return undefined;
    case 'subscript_declaration':
      recordMember(scan, owner, member, 'subscript', file, scopes);
      return undefined;
    case 'class_declaration':
    case 'protocol_declaration':
    // A nested `typealias` declares no member, but the container walk is what
    // reaches it — without this the body is never re-visited and a type nested
    // inside one would be silently missing rather than reported.
    case 'typealias_declaration':
      return member;
    default:
      return undefined;
  }
}

function recordMember(
  scan: ModuleScan,
  owner: string,
  member: Node,
  name: string,
  file: string,
  scopes: string[],
): void {
  scan.ownerMethods.get(owner)?.add(name);
  // A subscript keeps its body in a bare `computed_property`, not a `body` field.
  const body =
    member.childForFieldName('body') ??
    member.namedChildren.find((c) => c?.type === 'computed_property') ??
    null;
  recordCallableTree(scan, {
    name,
    qualname: `${owner}.${name}`,
    owner,
    isMethod: !isStaticMember(member),
    defNode: member,
    fnNode: member,
    body,
    signature: headerOf(member, body),
    decorators: attributesOf(member),
    isAsync: hasKeyword(member, 'async'),
    file,
    scopes,
  });
}

function noteBases(scan: ModuleScan, owner: string, node: Node): void {
  let bases = scan.bases.get(owner);
  if (!bases) {
    bases = [];
    scan.bases.set(owner, bases);
  }
  for (const spec of node.namedChildren) {
    if (spec?.type !== 'inheritance_specifier') continue;
    const name = coreTypeName(spec.childForFieldName('inherits_from') ?? spec.namedChildren[0]);
    if (name && !bases.includes(name)) bases.push(name);
  }
}

function collectImport(node: Node, scan: ModuleScan): void {
  const path = node.namedChildren.find((c) => c?.type === 'identifier')?.text;
  if (!path) return;
  const segments = path.split('.');
  const head = segments[0] ?? path;
  if (!scan.imports.has(head)) scan.imports.set(head, head);
  // `import struct Foundation.Data` also binds the symbol name.
  const leaf = segments.at(-1) ?? path;
  if (segments.length > 1 && !scan.imports.has(leaf)) scan.imports.set(leaf, path);
}

/** One declaration container to walk, with the enclosing type scope it sits in. */
interface Frame {
  node: Node;
  scope: string;
}

/**
 * Emit the {@link TypeNode} for one declaration. Returns without recording for an
 * `extension`, whose name belongs to a type declared elsewhere.
 */
function recordTypeDeclaration(
  scan: ModuleScan,
  node: Node,
  name: string,
  scope: string,
  file: string,
): void {
  const kind = swiftTypeKind(node);
  if (!kind) return;
  recordType(scan, {
    name,
    kind,
    node,
    // `class_body`, `enum_class_body` or `protocol_body`; a typealias has none, so
    // its whole text is the signature — which for `typealias Rpm = Int` is the point.
    body: node.childForFieldName('body'),
    file,
    // The enclosing TYPE path. Swift has no namespaces, so a top-level declaration
    // has no container at all, and a nested one comes out as `Outer.Inner` — the
    // same path its members already use.
    container: scope || null,
  });
}

function scanFile(scan: ModuleScan, root: Node, file: string): void {
  // Worklist rather than recursion: types nest without bound, and an explicit
  // stack cannot overflow on pathological input.
  const stack: Frame[] = [{ node: root, scope: '' }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    for (const child of frame.node.namedChildren) {
      if (!child) continue;
      if (child.type === 'import_declaration') {
        collectImport(child, scan);
        continue;
      }
      if (child.type === 'typealias_declaration') {
        // `typealias Rpm = Int` declares a type but no member, so it never enters
        // call resolution — it is indexed here and nowhere else. The FIRST `name`
        // field is the alias; the second is the type it aliases.
        recordTypeDeclaration(scan, child, coreTypeName(child.childForFieldName('name')), frame.scope, file);
        continue;
      }
      if (child.type !== 'class_declaration' && child.type !== 'protocol_declaration') continue;

      const kind = child.childForFieldName('declaration_kind')?.text ?? '';
      const nameNode = child.childForFieldName('name');
      const written = nameNode ? coreTypeName(nameNode) : '';
      if (!written) continue;
      // `extension Outer.Inner` names a type declared elsewhere and must not
      // claim it; every other kind declares one inside the current scope. Both
      // spell their owner the same way — `Outer.Inner` written inside scope `S`
      // is `S.Outer.Inner` — so only the bookkeeping below differs.
      const owner = qualify(frame.scope, written);

      if (!scan.ownerMethods.has(owner)) scan.ownerMethods.set(owner, new Set());
      if (!scan.ownerFields.has(owner)) scan.ownerFields.set(owner, new Set());
      recordTypeDeclaration(scan, child, written, frame.scope, file);
      if (kind !== EXTENSION_KIND) {
        if (!scan.typeModules.has(owner)) scan.typeModules.set(owner, scan.moduleId);
        let siblings = scan.scopedTypes.get(frame.scope);
        if (!siblings) {
          siblings = new Set();
          scan.scopedTypes.set(frame.scope, siblings);
        }
        siblings.add(written);
      }
      noteBases(scan, owner, child);

      const body = child.childForFieldName('body');
      if (!body || !TYPE_BODIES.has(body.type)) continue;
      const scopes = scopeChain(owner);
      let hasNested = false;
      for (const member of body.namedChildren) {
        if (!member) continue;
        if (scanMember(scan, owner, member, file, scopes)) hasNested = true;
      }
      // Re-visit the body only to pick up NESTED type declarations; its ordinary
      // members are not container children.
      if (hasNested) stack.push({ node: body, scope: owner });
    }
  }
}

/** Ancestors of `type` (superclass + protocols, transitively), each visited once. */
function ancestorsOf(type: string, std: StandardIndexes, own: SwiftIndexes): string[] {
  const seen = new Set<string>([type]);
  const order: string[] = [];
  const queue: string[] = [type];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const chain = scopeChain(current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '');
    for (const base of own.bases.get(current) ?? []) {
      const hit = resolveTypeRef(base, chain, std);
      const path = hit?.type ?? base;
      if (seen.has(path)) continue;
      seen.add(path);
      order.push(path);
      queue.push(path);
    }
  }
  return order;
}

/** A scanned type named by `ref` (possibly dotted) as seen from `scopes`. */
function resolveTypeRef(
  ref: string,
  scopes: readonly string[],
  std: StandardIndexes,
): { type: string; module: string } | undefined {
  const at = ref.lastIndexOf('.');
  if (at < 0) {
    const hit = lookupScoped(std.scopedTypeToModule, scopes, ref, std.ambiguousScopedTypes);
    return hit ? { type: qualify(hit.scope, ref), module: hit.value } : undefined;
  }
  // `Outer.Inner` seen from scope `S` may mean `S.Outer.Inner` or `Outer.Inner`.
  const prefix = ref.slice(0, at);
  const leaf = ref.slice(at + 1);
  const candidates = scopes.map((s) => qualify(s, prefix));
  const hit = lookupScoped(std.scopedTypeToModule, candidates, leaf, std.ambiguousScopedTypes);
  return hit ? { type: qualify(hit.scope, leaf), module: hit.value } : undefined;
}

/** `<declaring module>.<type>` when `type` itself declares `member`. */
function memberIdBase(type: string, member: string, own: SwiftIndexes): string | undefined {
  const module = own.memberModules.get(`${type}.${member}`);
  return module ? `${module}.${type}` : undefined;
}

/**
 * The nearest ancestor that declares `member` — a scanned superclass, or a
 * protocol whose extension supplies a default implementation. Cycle-guarded via
 * {@link ancestorsOf}.
 */
function inheritedIdBase(
  type: string,
  member: string,
  std: StandardIndexes,
  own: SwiftIndexes,
): string | undefined {
  for (const ancestor of ancestorsOf(type, std, own)) {
    const base = memberIdBase(ancestor, member, own);
    if (base) return base;
  }
  return undefined;
}

/** `self.m()` / bare `m()` — the caller's own type, an extension of it, or an ancestor. */
function resolveSelfMethod(
  owner: string,
  method: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved | undefined {
  const here = resolveOwnMethod(owner, method, scan, std);
  if (here) return here;
  // Not in THIS file: an extension of the same type elsewhere, or inherited.
  const base = memberIdBase(owner, method, own) ?? inheritedIdBase(owner, method, std, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/** `super.m()` — start above the caller's own type. */
function resolveSuperMethod(
  owner: string,
  method: string,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved | undefined {
  const base = inheritedIdBase(owner, method, std, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/** A member of a scanned type, addressed through the type itself. */
function typeMemberId(
  type: string,
  module: string,
  member: string,
  own: SwiftIndexes,
  std: StandardIndexes,
): string {
  return `${memberIdBase(type, member, own) ?? inheritedIdBase(type, member, std, own) ?? `${module}.${type}`}.${member}`;
}

/** A member of a type we have already placed in the scanned set. */
function resolvedMember(
  hit: { type: string; module: string },
  method: string,
  std: StandardIndexes,
  own: SwiftIndexes,
  callType: Resolved['callType'],
): Resolved {
  return { calleeId: typeMemberId(hit.type, hit.module, method, own, std), callType };
}

/** A call on a value whose type we learned: internal when scanned, else boundary. */
function resolveOnType(
  type: string,
  method: string,
  scopes: readonly string[],
  std: StandardIndexes,
  own: SwiftIndexes,
  callType: 'self_attr_method' | 'param_method',
): Resolved {
  const hit = resolveTypeRef(type, scopes, std);
  return hit ? resolvedMember(hit, method, std, own, callType) : boundaryOf(type, method);
}

/** `self.field.m()` / bare `field.m()` through a learned property type. */
function resolveAttrMethod(
  owner: string,
  field: string,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved | undefined {
  const local = scan.fieldTypes.get(`${owner}.${field}`);
  if (local) return resolveOnType(local, method, context.scopes, std, own, 'self_attr_method');
  // A property declared in another file's extension, or inherited: the scan's
  // own table cannot see it, which is what the scan-set-wide index is for.
  const direct = own.fieldTypes.get(`${owner}.${field}`);
  if (direct) return resolveOnType(direct, method, context.scopes, std, own, 'self_attr_method');
  for (const ancestor of ancestorsOf(owner, std, own)) {
    const type = own.fieldTypes.get(`${ancestor}.${field}`);
    if (type) return resolveOnType(type, method, context.scopes, std, own, 'self_attr_method');
  }
  return undefined;
}

/** Does the enclosing type (or an ancestor) have a property called `name`? */
function ownsField(owner: string, name: string, std: StandardIndexes, own: SwiftIndexes): boolean {
  if (own.fieldTypes.has(`${owner}.${name}`)) return true;
  return ancestorsOf(owner, std, own).some((a) => own.fieldTypes.has(`${a}.${name}`));
}

/** A free function anywhere in the scanned set — a Swift module spans every file. */
function resolveFreeFunction(
  name: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved | undefined {
  const near = resolveSameFileFree(name, scan) ?? resolveSiblingPackage(name, scan, std);
  if (near) return near;
  const module = own.freeFunctions.get(name);
  return module ? { calleeId: `${module}.${name}`, callType: 'internal_func' } : undefined;
}

/** `Engine()` — Swift has no `new`, so a scanned type name IS a constructor call. */
function resolveConstruction(
  ref: string,
  scopes: readonly string[],
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved | undefined {
  const hit = resolveTypeRef(ref, scopes, std);
  if (!hit) return undefined;
  return {
    calleeId: typeMemberId(hit.type, hit.module, 'init', own, std),
    callType: 'internal_constructor',
  };
}

/** `A.B.c()` where every segment is a plain name; '' as soon as one is not. */
function dottedPath(node: Node): string {
  const parts: string[] = [];
  let current: Node | null = node;
  while (current && current.type === 'navigation_expression') {
    const name = navigationName(current);
    if (!name) return '';
    parts.unshift(name);
    current = current.childForFieldName('target');
  }
  if (!current || current.type !== 'simple_identifier') return '';
  parts.unshift(current.text);
  return parts.join('.');
}

/**
 * The type name a call expression constructs, if its callee spells one:
 * `Engine()` → `Engine`, `Outer.Inner()` → `Outer.Inner`. Lowercase heads are
 * ordinary function calls and name no type.
 */
function constructedTypeRef(call: Node): string {
  if (call.type !== 'call_expression') return '';
  const callee = call.namedChildren[0];
  if (!callee) return '';
  const ref =
    callee.type === 'simple_identifier'
      ? callee.text
      : callee.type === 'navigation_expression'
        ? dottedPath(callee)
        : '';
  return /^[A-Z]/.test(ref.split('.')[0] ?? '') ? ref : '';
}

function resolveReceiver(
  receiver: Node,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved {
  const { owner } = context;

  // A. `self.m()` — and `self.field.m()`, whose receiver is itself a navigation.
  if (receiver.type === 'self_expression') {
    const hit = owner ? resolveSelfMethod(owner, method, scan, std, own) : undefined;
    return hit ?? unresolvedOf(`self.${method}`);
  }
  if (receiver.type === 'super_expression') {
    const hit = owner ? resolveSuperMethod(owner, method, std, own) : undefined;
    return hit ?? unresolvedOf(`super.${method}`);
  }
  const selfField = selfProp(receiver);
  if (selfField) {
    const hit = owner ? resolveAttrMethod(owner, selfField, method, scan, context, std, own) : undefined;
    return hit ?? unresolvedOf(`self.${selfField}.${method}`);
  }

  // B. bare receiver: a value in scope, then own state, then a type name.
  if (receiver.type === 'simple_identifier') {
    const base = receiver.text;
    const scoped = context.scopeTypes.get(base);
    if (scoped) return resolveOnType(scoped, method, context.scopes, std, own, 'param_method');
    if (owner && !context.declaredNames.has(base) && ownsField(owner, base, std, own)) {
      const viaField = resolveAttrMethod(owner, base, method, scan, context, std, own);
      if (viaField) return viaField;
    }
    return resolveQualified(base, method, scan, context, std, own);
  }

  // C. `Engine().m()` — the receiver is a value we just constructed.
  const constructed = constructedTypeRef(receiver);
  if (constructed) {
    return resolveOnType(constructed, method, context.scopes, std, own, 'param_method');
  }

  // D. `A.B.c()` — fully qualified, as long as every segment is a plain name.
  const path = dottedPath(receiver);
  const head = path.split('.')[0] ?? '';
  if (path && !context.declaredNames.has(head)) {
    return resolveQualified(path, method, scan, context, std, own);
  }
  return unresolvedOf(`${truncate(receiver.text, 60)}.${method}`);
}

/**
 * A receiver that names a type or a module rather than a value.
 *
 * A qualified call on a scanned type resolves to `internal_func` pointing at
 * the real member: per the SP2 IR decision a static call IS a call to an
 * internal function, and inventing a `static_method` callType nobody consumes
 * would buy nothing. `Engine.init()` and `Engine()` stay constructors.
 */
function resolveQualified(
  path: string,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved {
  const hit = resolveTypeRef(path, context.scopes, std);
  if (hit) {
    if (method === 'init') {
      return {
        calleeId: typeMemberId(hit.type, hit.module, 'init', own, std),
        callType: 'internal_constructor',
      };
    }
    return {
      calleeId: typeMemberId(hit.type, hit.module, method, own, std),
      callType: 'internal_func',
    };
  }
  const head = path.split('.')[0] ?? path;
  const imported = scan.imports.get(head);
  if (imported) {
    const rest = path.slice(head.length);
    return boundaryOf(`${imported}${rest}`, method);
  }
  // A capitalized receiver naming no value in scope is a type we do not have.
  // Saying "boundary" is true and more informative than shrugging.
  if (/^[A-Z]/.test(head)) return boundaryOf(path, method);
  return unresolvedOf(`${path}.${method}`);
}

function resolveCall(
  callee: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SwiftIndexes,
): Resolved {
  // A. bare `name(...)`. Swift has no `new`, so this is either a function call
  // or a constructor, decided by what the scanned set knows.
  if (callee.type === 'simple_identifier') {
    const name = callee.text;
    const local = context.localFns.get(name);
    if (local) return { calleeId: local, callType: 'internal_func' };
    if (!context.declaredNames.has(name)) {
      const viaSelf = context.owner ? resolveSelfMethod(context.owner, name, scan, std, own) : undefined;
      if (viaSelf) return viaSelf;
      const free = resolveFreeFunction(name, scan, std, own);
      if (free) return free;
      const ctor = resolveConstruction(name, context.scopes, std, own);
      if (ctor) return ctor;
      const imported = scan.imports.get(name);
      if (imported) return boundaryOf(imported, undefined, { isConstructor: /^[A-Z]/.test(name) });
      if (/^[A-Z]/.test(name)) return boundaryOf(name, undefined, { isConstructor: true });
    }
    return unresolvedOf(name);
  }

  // B. `Outer.Inner(...)` — a qualified name that IS a scanned type is a
  // constructor, not a member access, so it must be tried before the receiver
  // split turns `Inner` into a method of `Outer`.
  if (callee.type === 'navigation_expression') {
    const path = dottedPath(callee);
    const head = path.split('.')[0] ?? '';
    if (path && !context.declaredNames.has(head)) {
      const ctor = resolveConstruction(path, context.scopes, std, own);
      if (ctor) return ctor;
    }
    // C. `recv.m(...)`
    const receiver = callee.childForFieldName('target');
    const method = navigationName(callee);
    if (receiver && method) return resolveReceiver(receiver, method, scan, context, std, own);
  }

  return unresolvedOf(truncate(callee.text, 60));
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
  typeKinds: declaredTypeKinds(SWIFT_TYPE_KINDS),
};

const SWIFT_SPEC: LanguageSpec<ModuleScan, SwiftIndexes> = {
  name: 'swift',
  extensions: ['.swift'],
  grammarFor: () => 'swift',
  // SwiftPM, CocoaPods, Carthage and Xcode build output.
  extraSkipDirs: ['.build', 'Pods', 'Carthage', 'DerivedData'],
  // Sourcery / SwiftGen output: machine-written, describes nothing a reader wrote.
  discoverFilter: (rel) => !rel.endsWith('.generated.swift'),
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
      typeModules: new Map(),
      scopedTypes: new Map(),
      bases: new Map(),
      ownerFields: new Map(),
    };
  },

  scan(scan, root, file) {
    scanFile(scan, root, file);
    // Top-level functions, after types: a free function and a method can share a
    // name, and the type pass owns `ownerMethods`.
    for (const child of root.namedChildren) {
      if (child?.type !== NESTED_FN) continue;
      const nameNode = child.childForFieldName('name');
      if (!nameNode || nameNode.type !== 'simple_identifier') continue;
      const name = nameNode.text;
      scan.freeFunctions.add(name);
      const body = child.childForFieldName('body');
      recordCallableTree(scan, {
        name,
        qualname: name,
        owner: null,
        isMethod: false,
        defNode: child,
        fnNode: child,
        body,
        signature: headerOf(child, body),
        decorators: attributesOf(child),
        isAsync: hasKeyword(child, 'async'),
        file,
        scopes: [''],
      });
    }
    // Ids must be unique; on duplicates (two `#if` branches defining the same
    // symbol) keep the last, matching the pass-2 lookup so edges are not
    // multiplied.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes(scans) {
    const bases = new Map<string, string[]>();
    const memberModules = new Map<string, string>();
    const fieldTypes = new Map<string, string>();
    const freeFunctions = new Map<string, string>();
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
      for (const name of scan.freeFunctions) {
        if (!freeFunctions.has(name)) freeFunctions.set(name, scan.moduleId);
      }
    }
    return { bases, memberModules, fieldTypes, freeFunctions };
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      walk(context.body, (node) => {
        // A nested function is its own node with its own body walk. Closures are
        // NOT skipped: they are pervasive in Swift (trailing closures, result
        // builders) and have no identity of their own in the IR, so their calls
        // belong to the member that contains them.
        if (node.type === NESTED_FN) return false;
        if (node.type !== 'call_expression') return undefined;
        const callee = node.namedChildren[0];
        if (!callee) return undefined;
        const parent = node.parent;
        const isAwait =
          parent?.type === 'await_expression' ||
          (parent !== null && TRANSPARENT.has(parent.type) && parent.parent?.type === 'await_expression');
        const resolved = resolveCall(callee, scan, context, std, own);
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait,
          callType: resolved.callType,
          line: lineStart(node),
          raw: truncate(callee.text.replace(/\s+/g, ' '), 80),
        });
        return undefined;
      });
    }
    return edges;
  },
};

/**
 * Whether this runtime can parse Swift without dying.
 *
 * `tree-sitter-swift.wasm` does not throw on V8 >= 13 — it aborts the PROCESS
 * (`Fatal process out of memory: Zone`, exit 133) the moment V8 tiers the
 * module up, on a 36 GB machine at 73 MB RSS. Measured: fatal 5/5 on Node 24,
 * fine 5/5 on Node 21, and every other grammar in the package is unaffected.
 * `--liftoff-only` (or a large `--wasm-tiering-budget`) avoids the tier-up and
 * makes it work, but that is a process-launch flag a library cannot set for
 * its caller.
 *
 * So the adapter refuses up front rather than taking the run down with it: a
 * killed process tells a user nothing, while a named skip tells them exactly
 * what to do. `discoverAll` catches this and logs it, so every OTHER language
 * in a mixed repository is still analyzed.
 */
function swiftRuntimeIsSafe(): boolean {
  if (
    process.execArgv.some((flag) => flag.includes('liftoff-only') || flag.includes('wasm-tiering-budget'))
  ) {
    return true;
  }
  const major = Number.parseInt(process.versions.v8.split('.')[0] ?? '0', 10);
  return Number.isFinite(major) && major > 0 && major < 13;
}

export class SwiftAdapter extends SpineAdapter<ModuleScan, SwiftIndexes> {
  constructor() {
    super(SWIFT_SPEC);
  }

  override discover(sourceRoot: string, options: { logger?: Logger } = {}): string[] {
    if (!swiftRuntimeIsSafe()) {
      throw new Error(
        `Swift analysis is disabled on this runtime: tree-sitter-swift aborts the process on V8 ` +
          `${process.versions.v8} (node ${process.versions.node}). Re-run node with --liftoff-only, ` +
          `or use a runtime on V8 < 13, to analyze Swift.`,
      );
    }
    return super.discover(sourceRoot, options);
  }
}
