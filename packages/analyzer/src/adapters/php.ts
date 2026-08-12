/**
 * PHP adapter (tree-sitter grammar `php`).
 *
 * Two passes, like every full-tier adapter:
 *   1. scan each file: `namespace` blocks, `use` imports, every class / interface
 *      / trait / enum declaration (parents, trait uses, typed properties,
 *      members), every free function, and per-function parameter/local types
 *      plus `$this->` usage;
 *   2. resolve every call / `new` against the cross-module indexes into typed
 *      {@link CallEdge}s.
 *
 * ## Namespaces
 *
 * PHP is the fourth language (after Java packages, C# namespaces and C++
 * namespaces) where the spine's BARE-name `typeToModule` silently mis-picks:
 * `App\Billing\Config` and `App\Report\Config` are different types, and both
 * routinely live in ONE file (`namespace A { … } namespace B { … }`). So the
 * scope-aware index does the work here — {@link StandardIndexes.scopedTypeToModule}
 * read through `lookupScoped` with PHP's own name-resolution order — and this
 * adapter builds no private type→module table of its own.
 *
 * Name resolution follows the language: a leading `\` is absolute; `namespace\X`
 * is explicitly relative; an unqualified or relative name has its FIRST segment
 * matched against the `use` imports (aliases included) before falling back to
 * the current namespace. Unqualified FUNCTION names fall back to the global
 * namespace, which is PHP's rule; unqualified CLASS names get the same fallback
 * as a deliberate lenience — strict PHP would raise "class not found" there, so
 * the fallback can only add resolution where the program would not have run.
 *
 * ## Types are real information, where they exist
 *
 * Typed properties (`private Engine $engine;`), promoted constructor properties,
 * parameter types, `catch (IOException $e)` and `$x = new Engine()` are the four
 * places a type is stated. Nullable (`?Engine`) and union/intersection types are
 * peeled to the first named member (`Engine|null` → `Engine`); `int`, `string`,
 * `mixed`, `void` and friends are `primitive_type` in the grammar and yield no
 * type at all, so no hand-maintained builtin list is needed. Where nothing
 * declares a type the call is `unresolved` — never guessed from the name.
 *
 * ## Ids
 *
 * `id = <path-derived moduleId>.<qualname>` as everywhere else in this repo,
 * with `qualname = <Namespace>.<Class>.<member>` and `\` flattened to `.`:
 * `App\Billing\Ledger::post` declared in `src/Ledger.php` is
 * `src.Ledger.App.Billing.Ledger.post`. The namespace has to be in the qualname
 * — two same-named classes in different namespaces in one file would otherwise
 * collapse onto one id and silently delete a function — and `.` rather than `\`
 * or `::` because `graph.ts:synthesizeConstructor` decomposes an id by taking
 * its last two segments as `<Type>.<member>`, which still holds with a namespace
 * in front. The constructor's member name is `__construct`, as in source.
 *
 * Module ids stay path-derived: a namespace is neither unique per file nor even
 * one-per-file, and ids must be unique.
 *
 * ## Mixed HTML, measured rather than assumed
 *
 * The `php` grammar is the HTML-aware one, and it holds up: a template that
 * opens and closes `<?php … ?>` around markup seven times, alternative syntax
 * (`if: … endif;`), heredoc/nowdoc, `#[Attributes]`, backticks, `goto`, a
 * shebang line, a UTF-8 BOM and short `<?` tags all parse with `hasError=false`
 * and lose no declaration. A file with no PHP at all parses to a single `text`
 * node and therefore contributes nothing, which is the wanted behaviour.
 *
 * ## Known gaps, stated rather than hidden
 *
 *   - **Dynamic dispatch is not guessed.** `$obj->$name()`, `$fn()`,
 *     `new $cls()`, `$$var`, variable static calls and first-class callable
 *     syntax (`$this->m(...)` resolves as a call to `m`, not as a closure) stay
 *     `unresolved`. So do `call_user_func` / `call_user_func_array` /
 *     `array_map('f', …)` targets — the callee is a string or an array, not a
 *     call site — and `__call` / `__callStatic` / `__invoke` magic: a call
 *     routed through `__call` resolves to the name written, which has no
 *     declaration, so it lands on `unresolved` or `boundary`.
 *   - **Trait conflict resolution is not modelled.** `use A, B;` makes both
 *     traits' methods resolvable on the class, but `insteadof` and `as`
 *     (renaming / re-scoping) inside the `use { … }` block are ignored, so an
 *     aliased trait method resolves under its ORIGINAL name only.
 *   - **Overloads do not exist in PHP, but redeclarations do**: an id carries no
 *     arity and conditional redefinitions collapse to the last one seen.
 *   - **Anonymous classes get no nodes.** `new class { … }` emits no
 *     constructor edge and its method bodies are not walked — `$this` inside one
 *     is a different object, so attributing those calls to the enclosing method
 *     would be wrong. Closures and arrow functions are the opposite case: they
 *     share the enclosing `$this`, so their calls belong to the member that
 *     contains them, exactly as C# treats lambdas.
 *   - **Functions declared inside a function body are not recorded** (PHP hoists
 *     them to the global namespace when the outer one runs); their calls are
 *     attributed to the enclosing function.
 *   - **Top-level statements have no enclosing function**, so calls written at
 *     file scope — the bulk of a procedural script or a template — are not
 *     attributed to anything. Same limit C# top-level statements already carry.
 *   - **`include`/`require` are not followed.** PHP's visibility comes from an
 *     autoloader at runtime, so the whole scan set is treated as visible; a name
 *     it does not contain is a `boundary`.
 *   - **Return types are not propagated into locals.** `$order =
 *     Order::findOrFail($id); $order->save();` leaves the second call
 *     unresolved: a variable's type comes from a parameter, a `catch`, or a
 *     `new`, never from what a callee declares it returns. Same trade the C#
 *     and C++ adapters make; following it is a type checker's job.
 *   - **A method inherited from an UNSCANNED ancestor stays unresolved.**
 *     `$this->save()` on a class extending a framework base could come from the
 *     base, an interface, a trait or `__call`, and naming one would be a guess.
 *     `parent::m()` is the exception — it denotes exactly one class, so an
 *     unresolved `extends` makes it a truthful `boundary`.
 *   - Only one level of property chain is typed: `$this->a->m()` resolves,
 *     `$this->a->b->m()` does not. Docblock `@var` / `@param` hints are not read.
 *   - `@method`, `__get`-backed virtual properties, and properties assigned
 *     without a declaration (`$this->x = 1` on a class with no `$x`) are tracked
 *     as state but have no type.
 *   - PHP has no `async`/`await`, so `isAsync` and `isAwait` are always false.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, TypeKind } from '@handbooks/core';
import { truncate } from '@handbooks/core';
import { dedupeFunctionsById } from '../adapter.js';
import { lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  declaredTypeKinds,
  lookupScoped,
  recordType,
  scopedKey,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

const EXTENSIONS = ['.php', '.phtml'] as const;

const EXTENSION_RE = /\.(php|phtml)$/;

/**
 * Laravel Blade templates. They are `.php` by extension but Blade syntax
 * (`@section`, `{{ … }}`) is not PHP, so the grammar reads a whole one as inline
 * HTML and it contributes nothing — reading thousands of them costs time and
 * yields no facts.
 */
const BLADE_RE = /\.blade\.php$/;

/**
 * Node type → the {@link TypeKind} it declares, for THIS grammar.
 *
 * PHP is the one language whose four declaration keywords land on four distinct
 * vocabulary members with nothing forced: a `trait` is the word the vocabulary
 * borrowed (a contract that carries implementation), and PHP's is the canonical
 * one — `use Loggable;` composes its bodies into a class exactly as Rust's and
 * Scala's do.
 *
 * Deliberately absent, so each omission is a decision rather than an oversight:
 * - an anonymous class (`new class extends Base {}`) has no `name` field and no
 *   name a reader could search for. `recordType` refuses it either way.
 * - a `const` or `define()` — a value, not a type.
 * - PHP has no type aliases at all, so `alias` is not claimed. `class_alias()` is
 *   a runtime function call, and reading one as a declaration would state a fact
 *   the parser cannot see (its arguments may be variables).
 */
const PHP_TYPE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['trait_declaration', 'trait'],
  ['enum_declaration', 'enum'],
]);

/**
 * Declarations that introduce a named type with members. Derived from
 * {@link PHP_TYPE_KINDS} so the call-resolution walk and the declared capability
 * cannot drift apart — in PHP they are exactly the same four nodes.
 */
const TYPE_DECLS = new Set(PHP_TYPE_KINDS.keys());

/**
 * Statement nodes walked as containers when hunting for declarations. Real code
 * guards declarations behind `if (!class_exists(…))` and `try`, and every node
 * type here was read off a syntax tree rather than guessed. Function bodies are
 * deliberately NOT reachable from this set: a `compound_statement` only enters
 * it via a namespace body or a block statement, never via a callable.
 */
const CONTAINERS = new Set([
  'compound_statement',
  'colon_block',
  'if_statement',
  'else_if_clause',
  'else_clause',
  'switch_statement',
  'switch_block',
  'case_statement',
  'default_statement',
  'try_statement',
  'catch_clause',
  'finally_clause',
  'while_statement',
  'do_statement',
  'for_statement',
  'foreach_statement',
  'declare_statement',
  // A file the parser stumbled over keeps its well-formed declarations inside
  // one ERROR node; dispatch is by node type, so descending can only recover
  // subtrees the parser did in fact recognise.
  'ERROR',
]);

/** Parameter forms that bind a name, all three of which may carry a type. */
const PARAM_KINDS = new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter']);

/** Nodes that can spell a type or a callable name. */
const NAME_NODES = new Set(['name', 'qualified_name', 'namespace_name']);

/** One type, located: the namespace that declares it and the module it lives in. */
interface TypeRef {
  /** Namespace path, `\`-joined; '' is the global namespace. */
  scope: string;
  name: string;
  module: string;
}

/** How a type names another: `extends`, `implements`, or a trait `use`. */
type ParentKind = 'extends' | 'implements' | 'trait';

/** A written parent spelling, kept with the scan whose imports resolve it. */
interface ParentRef {
  spelling: string;
  /** A trait's members merge into the user; `parent::` must skip them. */
  kind: ParentKind;
  home: ModuleScan;
  scope: string;
}

/** What one scan learned about one declared type. */
interface TypeInfo {
  scope: string;
  name: string;
  parents: ParentRef[];
  /** property name → written type spelling ('' when untyped). */
  fields: Map<string, string>;
  members: Set<string>;
}

/** {@link TypeInfo} merged across scans, with parents resolved. */
interface MergedType extends TypeInfo {
  module: string;
  /** `extends` and `implements` targets that are in the scan set. */
  bases: TypeRef[];
  traits: TypeRef[];
  /**
   * Fully-qualified `extends` spellings that name nothing we scanned. A class
   * has at most one, and it is what makes `parent::m()` on a framework base
   * class a truthful `boundary` instead of a shrug.
   */
  unresolvedBases: string[];
}

interface FnContext {
  body: Node;
  owner: TypeRef | undefined;
  /** Enclosing namespace of the declaration. */
  scope: string;
  /** parameters and locals whose type we learned → written type spelling. */
  scopeTypes: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`, `ownerMethods` and `fieldTypes` carry the flat, bare-name view
   * the spine's own helpers expect; resolution uses the scope-aware tables
   * below instead. `freeFunctions` holds every free function's bare name,
   * `scopedFunctions` the namespace-aware view.
   */
  fnContext: Map<string, FnContext>;
  /** scopedKey(namespace, Type) → what this scan learned about it. */
  types: Map<string, TypeInfo>;
  /**
   * scopedKey(namespace, local name) → fully-qualified CLASS path.
   *
   * Keyed by namespace, not just by local name: a `use` binds inside ONE
   * namespace block, and one file may hold several. `namespace First; use
   * Shared\Tool; … namespace Second; use Other\Tool;` is legal, and a flat
   * per-file table silently answers `Shared\Tool` for both.
   */
  scopedImports: Map<string, string>;
  /** scopedKey(namespace, local name) → fully-qualified FUNCTION path. */
  scopedFunctionImports: Map<string, string>;
  /** namespace → free function names declared in it. */
  scopedFunctions: Map<string, Set<string>>;
}

interface PhpIndexes {
  /** scopedKey(namespace, Type) → the merged type. */
  types: Map<string, MergedType>;
  /** scopedKey(namespace, function) → owning moduleId (first declaration wins). */
  functions: Map<string, string>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(EXTENSION_RE, '').split('/').join('.');
}

/* ------------------------------------------------------------------ names */

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A leading `\` is syntax, not part of the path. */
function stripRoot(spelling: string): string {
  return spelling.startsWith('\\') ? spelling.slice(1) : spelling;
}

function joinNs(...parts: string[]): string {
  return parts.filter(Boolean).join('\\');
}

function tailOf(spelling: string): string {
  const at = spelling.lastIndexOf('\\');
  return at >= 0 ? spelling.slice(at + 1) : spelling;
}

function qualifierOf(spelling: string): string {
  const at = spelling.lastIndexOf('\\');
  return at >= 0 ? spelling.slice(0, at) : '';
}

/** `A\B\C` as written (leading `\` and `namespace\` prefix kept); '' if unnameable. */
function nameSpelling(node: Node | null | undefined): string {
  if (!node) return '';
  return NAME_NODES.has(node.type) ? node.text : '';
}

/** First named child of `node`, or null. */
function firstNamed(node: Node): Node | null {
  return node.namedChildren.find((c) => c !== null) ?? null;
}

/**
 * The written spelling of a declared type, with `?` and union/intersection noise
 * peeled off: `?Engine` → `Engine`, `Engine|null` → `Engine`, `A&B` → `A`.
 * Primitives (`int`, `string`, `mixed`, `void`, `never`) yield '' because the
 * grammar tags them `primitive_type` / `bottom_type` — no builtin list needed.
 */
function typeSpelling(node: Node | null | undefined): string {
  if (!node) return '';
  switch (node.type) {
    case 'named_type':
      return nameSpelling(firstNamed(node));
    case 'optional_type':
      return typeSpelling(firstNamed(node));
    case 'union_type':
    case 'intersection_type':
    case 'type_list':
      for (const child of node.namedChildren) {
        const spelling = typeSpelling(child);
        if (spelling) return spelling;
      }
      return '';
    default:
      return '';
  }
}

/** `$engine` → `engine`; '' for `$$dynamic` and anything else. */
function variableName(node: Node | null | undefined): string {
  if (!node || node.type !== 'variable_name') return '';
  const inner = firstNamed(node);
  return inner?.type === 'name' ? inner.text : '';
}

function isThis(node: Node | null | undefined): boolean {
  return !!node && variableName(node) === 'this';
}

/**
 * The qualname of a member or free function: `<Namespace>.<Class>.<member>`,
 * with `\` flattened to `.`. Empty segments drop out, so the global namespace
 * yields a qualname with no leading dot.
 */
function dottedQualname(scope: string, className: string | undefined, name: string): string {
  return [...(scope ? scope.split('\\') : []), className, name].filter(Boolean).join('.');
}

/** A `\`-path as a dotted one, for ids that leave the scanned set. */
function dotted(spelling: string): string {
  return stripRoot(spelling).split('\\').filter(Boolean).join('.');
}

/* -------------------------------------------------------- name resolution */

/** A spelling normalised into the one name to look up and the scopes to try. */
interface Candidate {
  name: string;
  scopes: string[];
}

/**
 * PHP's own name resolution, as a (name, candidate scopes) pair.
 *
 * `\A\B` is absolute. `namespace\A` is explicitly relative to the current one.
 * Otherwise the FIRST segment is matched against `aliases` (the `use` imports),
 * and only if that misses does the name fall back to the current namespace and
 * then the global one.
 */
function candidatesFor(spelling: string, scan: ModuleScan, scope: string): Candidate | undefined {
  if (!spelling) return undefined;
  if (spelling.startsWith('\\')) {
    const fq = stripRoot(spelling);
    return { name: tailOf(fq), scopes: [qualifierOf(fq)] };
  }
  if (spelling.startsWith('namespace\\')) {
    const rest = spelling.slice('namespace\\'.length);
    return { name: tailOf(rest), scopes: [joinNs(scope, qualifierOf(rest))] };
  }
  const head = spelling.includes('\\') ? spelling.slice(0, spelling.indexOf('\\')) : spelling;
  const imported = scan.scopedImports.get(scopedKey(scope, head));
  if (imported) {
    const fq = spelling.length > head.length ? `${imported}${spelling.slice(head.length)}` : imported;
    return { name: tailOf(fq), scopes: [qualifierOf(fq)] };
  }
  const qualifier = qualifierOf(spelling);
  return { name: tailOf(spelling), scopes: [joinNs(scope, qualifier), qualifier] };
}

/**
 * The type a written spelling names, or undefined when it is outside the scan
 * set. This is the call the bare-name `typeToModule` cannot make: `Config` from
 * inside `namespace Alpha` is `Alpha\Config`, never `Beta\Config`.
 */
function resolveTypeRef(
  spelling: string,
  scan: ModuleScan,
  scope: string,
  std: StandardIndexes,
): TypeRef | undefined {
  const candidate = candidatesFor(spelling, scan, scope);
  if (!candidate) return undefined;
  const hit = lookupScoped(
    std.scopedTypeToModule,
    candidate.scopes,
    candidate.name,
    std.ambiguousScopedTypes,
  );
  return hit ? { scope: hit.scope, name: candidate.name, module: hit.value } : undefined;
}

/**
 * The fully-qualified path a CLASS spelling denotes, for ids that leave the scan
 * set: `Widget` under `use Vendor\Widget;` is `Vendor\Widget`, and an
 * unqualified name with no import is what PHP says it is — a type of the
 * current namespace.
 */
function boundaryTypePath(spelling: string, scan: ModuleScan, scope: string): string {
  const candidate = candidatesFor(spelling, scan, scope);
  if (!candidate) return spelling;
  return joinNs(candidate.scopes[0] ?? '', candidate.name);
}

/** `self` / `static` / `parent` name the caller's own type, not a scanned one. */
function isRelativeTypeWord(spelling: string): boolean {
  return spelling === 'self' || spelling === 'static' || spelling === 'parent';
}

/* ----------------------------------------------------------------- pass 1 */

function addScopedType(scan: ModuleScan, scope: string, name: string): void {
  let names = scan.scopedTypes?.get(scope);
  if (!names) {
    names = new Set<string>();
    scan.scopedTypes?.set(scope, names);
  }
  names.add(name);
}

/** `function` / `const` / '' — which symbol table a `use` writes into. */
function useKind(node: Node): string {
  for (const child of node.children) {
    if (child && !child.isNamed && (child.text === 'function' || child.text === 'const')) return child.text;
  }
  return '';
}

function addUse(scan: ModuleScan, prefix: string, clause: Node, kind: string, scope: string): void {
  const target = clause.namedChildren.find((c) => c !== null && NAME_NODES.has(c.type));
  const path = joinNs(prefix, stripRoot(nameSpelling(target)));
  if (!path) return;
  const aliasing = clause.namedChildren.find((c) => c?.type === 'namespace_aliasing_clause');
  const alias = aliasing ? nameSpelling(aliasing.namedChildren.find((c) => c?.type === 'name')) : '';
  const local = alias || tailOf(path);
  // `use const` binds a constant, which is never a call target.
  if (kind === 'const') return;
  const table = kind === 'function' ? scan.scopedFunctionImports : scan.scopedImports;
  const key = scopedKey(scope, local);
  if (!table.has(key)) table.set(key, path);
  // The spine's flat view, kept in step for helpers that read `imports`.
  if (kind !== 'function' && !scan.imports.has(local)) scan.imports.set(local, path);
}

/**
 * `use A\B;`, `use A\B as C;`, `use function A\b;` and the group form
 * `use A\{B, function c, D as E};`.
 */
function collectUse(scan: ModuleScan, node: Node, scope: string): void {
  const kind = useKind(node);
  const group = node.namedChildren.find((c) => c?.type === 'namespace_use_group');
  if (group) {
    const prefix = stripRoot(nameSpelling(node.namedChildren.find((c) => c?.type === 'namespace_name')));
    for (const clause of group.namedChildren) {
      if (clause?.type !== 'namespace_use_group_clause') continue;
      addUse(scan, prefix, clause, kind || useKind(clause), scope);
    }
    return;
  }
  for (const clause of node.namedChildren) {
    if (clause?.type !== 'namespace_use_clause') continue;
    addUse(scan, '', clause, kind, scope);
  }
}

/** Attribute names on a declaration — PHP 8's decorators. */
function attributesOf(node: Node): string[] {
  const list = node.childForFieldName('attributes');
  if (!list) return [];
  const names: string[] = [];
  for (const group of list.namedChildren) {
    if (group?.type !== 'attribute_group') continue;
    for (const attr of group.namedChildren) {
      if (attr?.type !== 'attribute') continue;
      const spelling = nameSpelling(attr.namedChildren.find((c) => c !== null && NAME_NODES.has(c.type)));
      if (spelling) names.push(tailOf(stripRoot(spelling)));
    }
  }
  return names;
}

function hasModifier(node: Node, type: string): boolean {
  return node.namedChildren.some((c) => c?.type === type);
}

/**
 * Declaration text up to `stop` (its body), with the leading attribute list cut
 * off so the result reads as a signature rather than a decorated declaration.
 */
function headerOf(node: Node, stop: Node | null): string {
  const attrs = node.childForFieldName('attributes');
  const from = attrs ? attrs.endIndex : node.startIndex;
  const to = stop ? stop.startIndex : node.endIndex;
  const text = node.text.slice(Math.max(0, from - node.startIndex), Math.max(0, to - node.startIndex));
  // A bodiless declaration (interface member, `abstract`) runs to its own `;`.
  return truncate(collapse(text).replace(/;$/, '').trim(), 200);
}

/**
 * Parameter name → written type spelling. `self` and `static` are rewritten to
 * the enclosing type's own name, which is what they mean.
 */
function paramsOf(node: Node, owner: string | undefined): Map<string, string> {
  const params = new Map<string, string>();
  const list = node.childForFieldName('parameters');
  for (const param of list?.namedChildren ?? []) {
    if (!param || !PARAM_KINDS.has(param.type)) continue;
    const name = variableName(param.childForFieldName('name'));
    if (!name) continue;
    params.set(name, concreteType(typeSpelling(param.childForFieldName('type')), owner));
  }
  return params;
}

/** `self`/`static` in a type position mean the enclosing type. */
function concreteType(spelling: string, owner: string | undefined): string {
  if (!owner) return isRelativeTypeWord(spelling) ? '' : spelling;
  return spelling === 'self' || spelling === 'static' ? owner : spelling;
}

/** The type node of `new X(...)`; undefined for an anonymous class. */
function creationTypeNode(node: Node): Node | undefined {
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === 'declaration_list') return undefined;
    if (NAME_NODES.has(child.type) || child.type === 'variable_name') return child;
  }
  return undefined;
}

/**
 * Local variables whose type a body states: `$e = new Engine();` and
 * `catch (IOException $e)`. PHP has no local type declarations, so those two are
 * the whole list — nothing is inferred from a return type or a docblock.
 */
function collectLocals(body: Node, types: Map<string, string>, owner: string | undefined): void {
  walk(body, (node) => {
    // An anonymous class body has its own scope and its own `$this`.
    if (node.type === 'declaration_list') return false;
    if (node.type === 'assignment_expression') {
      const name = variableName(node.childForFieldName('left'));
      const value = node.childForFieldName('right');
      if (name && value?.type === 'object_creation_expression') {
        const created = creationTypeNode(value);
        const spelling = created ? concreteType(nameSpelling(created), owner) : '';
        if (spelling && !types.has(name)) types.set(name, spelling);
      }
      return undefined;
    }
    if (node.type === 'catch_clause') {
      const name = variableName(node.childForFieldName('name'));
      const spelling = typeSpelling(node.childForFieldName('type'));
      if (name && spelling && !types.has(name)) types.set(name, spelling);
    }
    return undefined;
  });
}

/** `$this->prop` — the property name, or '' if `node` is not that shape. */
function selfProp(node: Node): string {
  if (node.type !== 'member_access_expression') return '';
  if (!isThis(node.childForFieldName('object'))) return '';
  const name = node.childForFieldName('name');
  return name?.type === 'name' ? name.text : '';
}

/** `self::$prop` / `static::$prop` — the caller's own class's static state. */
function selfStaticProp(node: Node): string {
  if (node.type !== 'scoped_property_access_expression') return '';
  const scope = node.childForFieldName('scope');
  if (scope?.type !== 'relative_scope') return '';
  return variableName(node.childForFieldName('name'));
}

/** Peel `['k'][0]` off an assignment target so `$this->m['k'] = 1` is a write. */
function unwrapSubscript(node: Node): Node {
  let current = node;
  let guard = 0;
  while (current.type === 'subscript_expression' && guard < 32) {
    guard += 1;
    current = firstNamed(current) ?? current;
  }
  return current;
}

/**
 * `$this->x` reads and writes, plus `self::$x` static state.
 *
 * PHP has no implicit `$this`, so unlike C# and C++ there is no bare-identifier
 * case to disambiguate — every property access is written out. Descent is still
 * explicit (and iterative, so tree depth cannot overflow the stack) because the
 * remaining distinctions are positional: the `name` of a method call is a method
 * rather than state, and the left of `=` is a write while the left of `+=` is
 * both.
 */
function trackSelfAttrs(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const target = (node: Node): string => selfProp(node) || selfStaticProp(node);

  const stack: Node[] = [body];
  const push = (node: Node | null | undefined): void => {
    if (node) stack.push(node);
  };
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      // An anonymous class body rebinds `$this`; its state is not ours.
      case 'declaration_list':
        break;
      case 'assignment_expression':
      case 'augmented_assignment_expression': {
        const left = node.childForFieldName('left');
        const hit = left ? target(unwrapSubscript(left)) : '';
        if (hit) {
          writes.add(hit);
          if (node.type === 'augmented_assignment_expression') reads.add(hit);
        } else {
          push(left);
        }
        push(node.childForFieldName('right'));
        break;
      }
      case 'update_expression': {
        // `$this->n++` reads and writes in one go.
        const argument = node.childForFieldName('argument');
        const hit = argument ? target(unwrapSubscript(argument)) : '';
        if (hit) {
          reads.add(hit);
          writes.add(hit);
        } else {
          push(argument);
        }
        break;
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression':
        push(node.childForFieldName('object'));
        push(node.childForFieldName('arguments'));
        break;
      case 'member_access_expression': {
        const hit = selfProp(node);
        if (hit) reads.add(hit);
        else push(node.childForFieldName('object'));
        break;
      }
      case 'scoped_property_access_expression': {
        const hit = selfStaticProp(node);
        if (hit) reads.add(hit);
        break;
      }
      default:
        for (const child of node.namedChildren) push(child);
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface RecordOptions {
  name: string;
  qualname: string;
  owner: TypeRef | undefined;
  isStatic: boolean;
  node: Node;
  body: Node | null;
  scope: string;
  file: string;
}

/**
 * Record one callable. Bodiless declarations (interface members, `abstract`)
 * still become nodes — they are legitimate call targets, and omitting them would
 * leave edges pointing at ids that do not exist.
 */
function recordFunction(scan: ModuleScan, opts: RecordOptions): void {
  const { name, qualname, owner, node, body, file } = opts;
  const id = `${scan.moduleId}.${qualname}`;
  const params = paramsOf(node, owner?.name);

  const scopeTypes = new Map<string, string>();
  for (const [param, spelling] of params) {
    if (spelling) scopeTypes.set(param, spelling);
  }
  if (body) collectLocals(body, scopeTypes, owner?.name);
  const { reads, writes } = body && owner ? trackSelfAttrs(body) : { reads: [], writes: [] };

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: headerOf(node, body),
    isAsync: false,
    isMethod: owner !== undefined && !opts.isStatic,
    className: owner ? owner.name : null,
    decorators: attributesOf(node),
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries(
      [...params]
        .filter(([, spelling]) => spelling !== '')
        .map(([param, spelling]) => [param, tailOf(stripRoot(spelling))]),
    ),
  });
  if (body) scan.fnContext.set(id, { body, owner, scope: opts.scope, scopeTypes });
}

/** Parents written on a declaration: `extends`, `implements`, and trait `use`. */
function collectParents(scan: ModuleScan, node: Node, body: Node | null, scope: string): ParentRef[] {
  const parents: ParentRef[] = [];
  const add = (spelling: string, kind: ParentKind): void => {
    if (spelling && !parents.some((p) => p.spelling === spelling && p.kind === kind)) {
      parents.push({ spelling, kind, home: scan, scope });
    }
  };
  for (const clause of node.namedChildren) {
    if (clause?.type !== 'base_clause' && clause?.type !== 'class_interface_clause') continue;
    const kind = clause.type === 'base_clause' ? 'extends' : 'implements';
    for (const child of clause.namedChildren) {
      if (child && NAME_NODES.has(child.type)) add(child.text, kind);
    }
  }
  for (const member of body?.namedChildren ?? []) {
    if (member?.type !== 'use_declaration') continue;
    for (const child of member.namedChildren) {
      // `use_list` carries `insteadof` / `as` rules, which are not modelled.
      if (child && NAME_NODES.has(child.type)) add(child.text, 'trait');
    }
  }
  return parents;
}

/** Typed properties and promoted constructor properties of one type. */
function collectFields(info: TypeInfo, scan: ModuleScan, body: Node | null): void {
  const note = (field: string, spelling: string): void => {
    if (!field || info.fields.has(field)) return;
    const concrete = concreteType(spelling, info.name);
    info.fields.set(field, concrete);
    if (concrete) scan.fieldTypes.set(`${info.name}.${field}`, tailOf(stripRoot(concrete)));
  };
  for (const member of body?.namedChildren ?? []) {
    if (!member) continue;
    if (member.type === 'property_declaration') {
      const spelling = typeSpelling(member.childForFieldName('type'));
      for (const element of member.namedChildren) {
        if (element?.type !== 'property_element') continue;
        note(variableName(firstNamed(element)), spelling);
      }
      continue;
    }
    if (member.type !== 'method_declaration') continue;
    for (const param of member.childForFieldName('parameters')?.namedChildren ?? []) {
      if (param?.type !== 'property_promotion_parameter') continue;
      note(variableName(param.childForFieldName('name')), typeSpelling(param.childForFieldName('type')));
    }
  }
}

function scanTypeDeclaration(scan: ModuleScan, node: Node, scope: string, file: string): void {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return;
  const body = node.childForFieldName('body');

  const kind = PHP_TYPE_KINDS.get(node.type);
  if (kind) {
    recordType(scan, {
      name,
      kind,
      node,
      body,
      file,
      // The namespace, like every PHP id in this adapter — `App.Billing.App`, so a
      // type and its methods sort together. `container` stays null: PHP has no
      // nested type declarations, and a namespace is a scope, not a type.
      namePrefix: scope ? `${dotted(scope)}.` : '',
      container: null,
    });
  }

  const key = scopedKey(scope, name);
  let info = scan.types.get(key);
  if (!info) {
    info = { scope, name, parents: [], fields: new Map(), members: new Set() };
    scan.types.set(key, info);
  }
  addScopedType(scan, scope, name);
  if (!scan.ownerMethods.has(name)) scan.ownerMethods.set(name, new Set());
  for (const parent of collectParents(scan, node, body, scope)) info.parents.push(parent);
  // State first: a method body may read a property declared below it.
  collectFields(info, scan, body);

  const owner: TypeRef = { scope, name, module: scan.moduleId };
  for (const member of body?.namedChildren ?? []) {
    if (member?.type !== 'method_declaration') continue;
    const method = member.childForFieldName('name')?.text ?? '';
    if (!method) continue;
    info.members.add(method);
    scan.ownerMethods.get(name)?.add(method);
    recordFunction(scan, {
      name: method,
      qualname: dottedQualname(scope, name, method),
      owner,
      isStatic: hasModifier(member, 'static_modifier'),
      node: member,
      body: member.childForFieldName('body'),
      scope,
      file,
    });
  }
}

function scanFreeFunction(scan: ModuleScan, node: Node, scope: string, file: string): void {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return;
  scan.freeFunctions.add(name);
  let names = scan.scopedFunctions.get(scope);
  if (!names) {
    names = new Set<string>();
    scan.scopedFunctions.set(scope, names);
  }
  names.add(name);
  recordFunction(scan, {
    name,
    qualname: dottedQualname(scope, undefined, name),
    owner: undefined,
    isStatic: false,
    node,
    body: node.childForFieldName('body'),
    scope,
    file,
  });
}

/**
 * Walk one file's containers iteratively. The namespace is threaded through
 * rather than pushed, because `namespace X;` without a body applies to every
 * declaration that follows it in the file — so the scope of a container's
 * children changes as the loop advances through them.
 */
function scanRoot(scan: ModuleScan, root: Node, file: string): void {
  const queue: Array<{ node: Node; scope: string }> = [{ node: root, scope: '' }];
  // FIFO, so containers are visited in source order: two `namespace A { … }`
  // blocks in one file must contribute their imports in the order written.
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) continue;
    let scope = item.scope;
    for (const child of item.node.namedChildren) {
      if (!child) continue;
      if (child.type === 'namespace_definition') {
        const named = stripRoot(nameSpelling(child.childForFieldName('name')));
        const body = child.childForFieldName('body');
        // Braced form: the namespace applies to the block only. Unbraced form:
        // it applies to the rest of this container.
        if (body) queue.push({ node: body, scope: named });
        else scope = named;
        continue;
      }
      if (child.type === 'namespace_use_declaration') {
        collectUse(scan, child, scope);
      } else if (TYPE_DECLS.has(child.type)) {
        scanTypeDeclaration(scan, child, scope, file);
      } else if (child.type === 'function_definition') {
        scanFreeFunction(scan, child, scope, file);
      } else if (CONTAINERS.has(child.type)) {
        queue.push({ node: child, scope });
      }
    }
  }
}

/* --------------------------------------------------------- type hierarchy */

/** `seeds` and everything above them, breadth-first and cycle-safe. */
function chainOf(seeds: readonly TypeRef[], own: PhpIndexes): TypeRef[] {
  const seen = new Set<string>();
  const order: TypeRef[] = [];
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const key = scopedKey(current.scope, current.name);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(current);
    const info = own.types.get(key);
    if (info) queue.push(...info.bases, ...info.traits);
  }
  return order;
}

/** `parent::` starts at the base classes and interfaces, never at a trait. */
function basesOf(ref: TypeRef, own: PhpIndexes): TypeRef[] {
  return own.types.get(scopedKey(ref.scope, ref.name))?.bases ?? [];
}

/** Where `member` is declared: on `ref` itself, on a trait it uses, or above. */
function declaringType(seeds: readonly TypeRef[], member: string, own: PhpIndexes): TypeRef | undefined {
  return chainOf(seeds, own).find((candidate) =>
    own.types.get(scopedKey(candidate.scope, candidate.name))?.members.has(member),
  );
}

/** A property's declared type spelling, inherited and trait properties included. */
function fieldTypeOf(ref: TypeRef, field: string, own: PhpIndexes): string {
  for (const candidate of chainOf([ref], own)) {
    const spelling = own.types.get(scopedKey(candidate.scope, candidate.name))?.fields.get(field);
    if (spelling) return spelling;
  }
  return '';
}

function memberIdOf(ref: TypeRef, member: string): string {
  return `${ref.module}.${dottedQualname(ref.scope, ref.name, member)}`;
}

/* ------------------------------------------------------------- resolution */

/**
 * A call on a type we resolved. When the type is scanned but the member is not
 * one we saw (a magic `__call` target, or a member inherited from outside the
 * scan set) the edge still points into the type's own module: the target IS
 * internal, and calling it a boundary would be a lie.
 */
function resolveOnType(
  ref: TypeRef,
  method: string,
  callType: Resolved['callType'],
  own: PhpIndexes,
): Resolved {
  const declaring = declaringType([ref], method, own) ?? ref;
  return { calleeId: memberIdOf(declaring, method), callType };
}

/** A method of the caller's own type, of a trait it uses, or of an ancestor. */
function resolveSelfMethod(method: string, context: FnContext, own: PhpIndexes): Resolved | undefined {
  if (!context.owner) return undefined;
  const declaring = declaringType([context.owner], method, own);
  return declaring ? { calleeId: memberIdOf(declaring, method), callType: 'self_method' } : undefined;
}

/**
 * `parent::m()` — start above the caller's own type.
 *
 * When no scanned ancestor declares the method, `parent` still names exactly ONE
 * class, so an `extends` we could not resolve makes the target provably external
 * — which is `boundary`, not a shrug. (`$this->m()` gets no such fallback: with
 * a base class, interfaces and traits all in play, and `__call` on top, there is
 * no single class to name.) Real framework code makes this the difference
 * between grounding `parent::__construct()` and losing it.
 */
function resolveParentMethod(method: string, context: FnContext, own: PhpIndexes): Resolved | undefined {
  if (!context.owner) return undefined;
  const declaring = declaringType(basesOf(context.owner, own), method, own);
  if (declaring) return { calleeId: memberIdOf(declaring, method), callType: 'self_method' };
  const outside = own.types.get(scopedKey(context.owner.scope, context.owner.name))?.unresolvedBases[0];
  return outside ? boundaryOf(dotted(outside), method) : undefined;
}

/** A value whose written type we learned: `$param->m()`, `$local->m()`. */
function resolveTypedValue(
  spelling: string,
  method: string,
  callType: Resolved['callType'],
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: PhpIndexes,
): Resolved {
  if (isRelativeTypeWord(spelling) && context.owner) {
    return resolveOnType(context.owner, method, callType, own);
  }
  const ref = resolveTypeRef(spelling, scan, context.scope, std);
  return ref
    ? resolveOnType(ref, method, callType, own)
    : boundaryOf(dotted(boundaryTypePath(spelling, scan, context.scope)), method);
}

/** `$recv->m()` and `$recv?->m()`. */
function resolveMemberCall(
  object: Node,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: PhpIndexes,
): Resolved {
  // A. `$this->m()`
  if (isThis(object)) {
    return resolveSelfMethod(method, context, own) ?? unresolvedOf(`$this->${method}`);
  }

  // B. `$this->field->m()` through the property's declared type.
  const field = selfProp(object);
  if (field) {
    const spelling = context.owner ? fieldTypeOf(context.owner, field, own) : '';
    if (!spelling) return unresolvedOf(`$this->${field}->${method}`);
    return resolveTypedValue(spelling, method, 'self_attr_method', scan, context, std, own);
  }

  // C. `$param->m()` / `$local->m()` through a declared parameter or `new` type.
  const variable = variableName(object);
  if (variable) {
    const spelling = context.scopeTypes.get(variable);
    if (!spelling) return unresolvedOf(`$${variable}->${method}`);
    return resolveTypedValue(spelling, method, 'param_method', scan, context, std, own);
  }

  // Anything else — a chained call, a subscript, a closure result — has no
  // declared type anywhere, and guessing one would be inventing a fact.
  return unresolvedOf(collapse(`${object.text}->${method}`));
}

/**
 * `Type::m()`, `self::m()`, `static::m()`, `parent::m()`.
 *
 * A qualified call into the scan set resolves to `internal_func` per the SP2 IR
 * decision: a static method IS an internal function, and inventing a
 * `static_method` callType nobody consumes would buy nothing.
 */
function resolveScopedCall(
  scopeNode: Node,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: PhpIndexes,
): Resolved {
  if (scopeNode.type === 'relative_scope') {
    const word = scopeNode.text;
    const hit =
      word === 'parent' ? resolveParentMethod(method, context, own) : resolveSelfMethod(method, context, own);
    return hit ?? unresolvedOf(`${word}::${method}`);
  }
  const spelling = nameSpelling(scopeNode);
  // `$cls::m()` and other computed scopes name no type we can look up.
  if (!spelling) return unresolvedOf(collapse(`${scopeNode.text}::${method}`));
  if (isRelativeTypeWord(spelling)) {
    const hit =
      spelling === 'parent'
        ? resolveParentMethod(method, context, own)
        : resolveSelfMethod(method, context, own);
    return hit ?? unresolvedOf(`${spelling}::${method}`);
  }
  const ref = resolveTypeRef(spelling, scan, context.scope, std);
  // `::` always names a class, so a class we do not have is provably outside
  // the scan set — `boundary` states that truthfully.
  return ref
    ? resolveOnType(ref, method, 'internal_func', own)
    : boundaryOf(dotted(boundaryTypePath(spelling, scan, context.scope)), method);
}

/** A free function, resolved through `use function`, then the namespace, then global. */
function resolveFunctionCall(callee: Node, scan: ModuleScan, context: FnContext, own: PhpIndexes): Resolved {
  const spelling = nameSpelling(callee);
  // `$fn()`, `($this->factory)()`, `Closure::fromCallable(...)()` — the callee
  // is a value, and this adapter does not follow values.
  if (!spelling) return unresolvedOf(collapse(callee.text));

  const direct = spelling.includes('\\')
    ? undefined
    : scan.scopedFunctionImports.get(scopedKey(context.scope, spelling));
  const candidate = direct
    ? { name: tailOf(direct), scopes: [qualifierOf(direct)] }
    : candidatesFor(spelling, scan, context.scope);
  const hit = candidate ? lookupScoped(own.functions, candidate.scopes, candidate.name) : undefined;
  if (hit && candidate) {
    return {
      calleeId: `${hit.value}.${dottedQualname(hit.scope, undefined, candidate.name)}`,
      callType: 'internal_func',
    };
  }
  // PHP has one flat function namespace and no local function scope, so a name
  // no scanned file declares is a builtin or lives in a file we did not read.
  // An UNQUALIFIED miss really does fall back to the global namespace, so its
  // boundary id is the bare name — only a written qualifier gets kept.
  const qualified = spelling.includes('\\') ? joinNs(candidate?.scopes[0] ?? '', candidate?.name ?? '') : '';
  return boundaryOf(dotted(direct || qualified || spelling));
}

/** `new Foo()`. The constructor's member name is `__construct`, as in source. */
function resolveNew(
  node: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
): Resolved | undefined {
  const typeNode = creationTypeNode(node);
  // `new class { … }` names no type; an anonymous class gets no node either.
  if (!typeNode) return undefined;
  // `new $cls()` / `new ($factory->type())()` — ungroundable by construction.
  if (!NAME_NODES.has(typeNode.type)) return unresolvedOf(collapse(node.text));
  const spelling = typeNode.text;
  const ref =
    isRelativeTypeWord(spelling) && context.owner
      ? context.owner
      : resolveTypeRef(spelling, scan, context.scope, std);
  if (!ref) {
    const path = dotted(boundaryTypePath(spelling, scan, context.scope));
    return boundaryOf(path, undefined, { isConstructor: true });
  }
  return { calleeId: memberIdOf(ref, '__construct'), callType: 'internal_constructor' };
}

/** Call text without its argument list: `$this->engine->spin`. */
function calleeText(node: Node): string {
  const args = node.childForFieldName('arguments');
  const end = args ? args.startIndex : node.endIndex;
  return collapse(node.text.slice(0, Math.max(0, end - node.startIndex)));
}

/** The method name of a `->` call; '' when it is computed (`$obj->$name()`). */
function calledMemberName(node: Node): string {
  const name = node.childForFieldName('name');
  return name?.type === 'name' ? name.text : '';
}

function resolveCall(
  node: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: PhpIndexes,
): Resolved | undefined {
  switch (node.type) {
    case 'member_call_expression':
    case 'nullsafe_member_call_expression': {
      const object = node.childForFieldName('object');
      const method = calledMemberName(node);
      if (!object) return undefined;
      return method
        ? resolveMemberCall(object, method, scan, context, std, own)
        : unresolvedOf(calleeText(node));
    }
    case 'scoped_call_expression': {
      const scopeNode = node.childForFieldName('scope');
      const method = calledMemberName(node);
      if (!scopeNode) return undefined;
      return method
        ? resolveScopedCall(scopeNode, method, scan, context, std, own)
        : unresolvedOf(calleeText(node));
    }
    case 'function_call_expression': {
      const callee = node.childForFieldName('function');
      return callee ? resolveFunctionCall(callee, scan, context, own) : undefined;
    }
    case 'object_creation_expression':
      return resolveNew(node, scan, context, std);
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------- spec */

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
  typeKinds: declaredTypeKinds(PHP_TYPE_KINDS),
};

const PHP_SPEC: LanguageSpec<ModuleScan, PhpIndexes> = {
  name: 'php',
  extensions: EXTENSIONS,
  grammarFor: () => 'php',
  discoverFilter: (rel) => !BLADE_RE.test(rel),
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
      scopedTypes: new Map(),
      types: new Map(),
      scopedImports: new Map(),
      scopedFunctionImports: new Map(),
      scopedFunctions: new Map(),
    };
  },

  scan(scan, root, file) {
    scanRoot(scan, root, file);
    // Ids must be unique; on a (conditional) redeclaration keep the last, which
    // matches the pass-2 lookup so edges are not multiplied.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  /**
   * Merge the per-scan type tables into one scope-keyed table and resolve every
   * written parent spelling against the imports of the file that wrote it. Two
   * steps, because a base class may be declared in a file scanned later.
   */
  buildIndexes(scans, std) {
    const types = new Map<string, MergedType>();
    const functions = new Map<string, string>();
    for (const scan of scans) {
      for (const [key, info] of scan.types) {
        let merged = types.get(key);
        if (!merged) {
          merged = {
            scope: info.scope,
            name: info.name,
            module: std.scopedTypeToModule.get(key) ?? scan.moduleId,
            parents: [],
            fields: new Map(),
            members: new Set(),
            bases: [],
            traits: [],
            unresolvedBases: [],
          };
          types.set(key, merged);
        }
        merged.parents.push(...info.parents);
        for (const [field, spelling] of info.fields) {
          if (!merged.fields.has(field)) merged.fields.set(field, spelling);
        }
        for (const member of info.members) merged.members.add(member);
      }
      for (const [scope, names] of scan.scopedFunctions) {
        for (const name of names) {
          const key = scopedKey(scope, name);
          if (!functions.has(key)) functions.set(key, scan.moduleId);
        }
      }
    }

    for (const merged of types.values()) {
      for (const parent of merged.parents) {
        const ref = resolveTypeRef(parent.spelling, parent.home, parent.scope, std);
        if (!ref) {
          if (parent.kind !== 'extends') continue;
          const path = boundaryTypePath(parent.spelling, parent.home, parent.scope);
          if (path && !merged.unresolvedBases.includes(path)) merged.unresolvedBases.push(path);
          continue;
        }
        const list = parent.kind === 'trait' ? merged.traits : merged.bases;
        if (!list.some((r) => r.scope === ref.scope && r.name === ref.name)) list.push(ref);
      }
    }
    return { types, functions };
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      walk(context.body, (node) => {
        // An anonymous class body is its own object with its own `$this`.
        if (node.type === 'declaration_list') return false;
        const resolved = resolveCall(node, scan, context, std, own);
        if (!resolved) return undefined;
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait: false,
          callType: resolved.callType,
          line: lineStart(node),
          raw: truncate(
            node.type === 'object_creation_expression' ? collapse(node.text) : calleeText(node),
            80,
          ),
        });
        return undefined;
      });
    }
    return edges;
  },
};

export class PhpAdapter extends SpineAdapter<ModuleScan, PhpIndexes> {
  constructor() {
    super(PHP_SPEC);
  }
}
