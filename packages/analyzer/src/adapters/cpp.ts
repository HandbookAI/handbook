/**
 * C-family adapter — C++ AND C (tree-sitter grammars `cpp` and `c`).
 *
 * ONE adapter, not two. Measured, not assumed: the `cpp` grammar parses a pure
 * C header with `hasError=false` and yields the same node types the `c` grammar
 * does, while the `c` grammar FAILS on a C++ header (`hasError=true`, losing
 * `class` / `namespace` / `template` entirely). So `.c` takes the `c` grammar
 * and everything else — `.h` included, because a `.h` is as likely to be C++ as
 * C — takes `cpp`. That mirrors the TypeScript adapter's `.tsx → tsx, else
 * typescript` split exactly.
 *
 * ## The header/implementation rule
 *
 * This is the whole reason the adapter is hard. `int spin();` is declared in
 * `engine.h`, defined in `engine.cpp`, and called from `main.cpp`; a call must
 * land on the DEFINITION and one function must never become two nodes.
 *
 *   1. **The definition owns the node.** A declaration with no body — a header
 *      prototype, an in-class method declaration, `= default`, a pure virtual —
 *      registers the symbol (its name joins the type's member set, its
 *      parameter types are learned) but yields no {@link FunctionNode} as long
 *      as some scanned file defines it.
 *   2. **A never-defined declaration keeps its node**, at the declaration. It is
 *      the only evidence of that function in the tree and it is a genuine call
 *      target; dropping it would leave edges pointing at ids that do not exist.
 *   3. Symbols are keyed by their C++ name (`demo::App::run`, `spin_once`), not
 *      by file, so a declaration and its definition collapse onto one key
 *      whatever files they live in. Because nodes can only be assigned once the
 *      whole scan set is known, they are materialised in `buildIndexes` rather
 *      than in `scan` — see {@link materialize}.
 *   4. **`#include` supplies visibility.** Quoted includes are resolved (against
 *      the includer's directory, then the source root, then a unique
 *      path-suffix match) into the modules they name, transitively. When two
 *      scanned modules define the same symbol — two `static` helpers of the same
 *      name in different translation units — the one the caller can actually see
 *      wins. A `<system>` include, or a quoted one naming no scanned file, marks
 *      the module as seeing declarations we did not read; that is what makes a
 *      bare `printf(...)` a `boundary` rather than a shrug (C and C++ require a
 *      declaration before use, so a name declared nowhere in the scan set must
 *      come from a header we did not scan).
 *
 * Header and implementation usually share a basename, so `src/engine.h` and
 * `src/engine.cpp` collapse to one moduleId and one scan (`mergeByModule`).
 * When a project splits `include/` from `src/` they stay two modules and the
 * include edge plus the symbol key link them.
 *
 * ## Ids
 *
 * `id = <path-derived moduleId>.<qualname>` as everywhere else in this repo,
 * with `qualname = <namespace>.<Type>.<member>` — `audio::Engine::spin` defined
 * in `impl.cpp` is `impl.audio.Engine.spin`. The namespace is part of the
 * qualname, not of the module: two out-of-line definitions of `audio::Engine::
 * spin` and `video::Engine::spin` routinely share one .cpp, and without the
 * namespace both ids collapse to `impl.Engine.spin`, silently deleting one
 * function and conflating two unrelated types. `::` is flattened to `.` so the
 * id decomposes the way `graph.ts` expects (last two segments are
 * `<Type>.<member>`).
 *
 * ## Scopes
 *
 * C++ namespaces are the third language (after Java packages and C#
 * namespaces) where the spine's BARE-name `typeToModule` silently mis-picks:
 * `alpha::Config` and `beta::Config` are different types. This adapter is the
 * first consumer of the spine's scope-aware index —
 * {@link StandardIndexes.scopedTypeToModule} read through `lookupScoped` with
 * C++'s own visibility order (innermost namespace outward, then the global
 * scope, then every `using namespace`). The same helper drives this adapter's
 * private symbol table, which is keyed the same way.
 *
 * ## Known gaps, stated rather than hidden
 *
 *   - **Macros are not expanded.** `#define`d call sites read as whatever they
 *     look like textually — `FOO(x)` becomes a call to `FOO` — and a macro that
 *     hides a call is invisible. A macro invoked in a class body parses as a
 *     member declaration, so it gets a node named after the macro.
 *   - **A broken parse is recovered from, not skipped.** The C-linkage guard
 *     (`#ifdef __cplusplus` / `extern "C" {` / `#endif`) opens a brace the
 *     grammar cannot pair and buries the rest of the file in one `ERROR` node;
 *     since nearly every portable C header has it, `ERROR` is walked as an
 *     ordinary container. Dispatch is by node type, so this only recovers
 *     subtrees the parser did in fact recognise. A file it recognised nothing
 *     in still contributes nothing, and never affects its neighbours.
 *   - **Every `#ifdef` branch is scanned**, so a function defined once per
 *     branch contributes one node (the first) and both branches' calls are
 *     attributed. No preprocessor state is simulated.
 *   - **Overloads collapse.** An id carries no arity, so `f(int)` and
 *     `f(double)` share `<module>.f` and the last definition wins — the same
 *     trade Java, C# and TypeScript overloads already make here.
 *   - **Templates are not instantiated.** `twice<int>(2)` resolves to the
 *     template's own node; per-instantiation targets do not exist in this IR.
 *   - **Operator overloads and conversion operators are skipped** — their name
 *     is punctuation, not an identifier, and ids travel through DOT and
 *     Markdown. Calls inside their bodies are therefore not recorded.
 *   - **Function pointers and functors are not followed**: `cb(1)` where `cb` is
 *     a variable, and `(*fp)()`, stay unresolved rather than guessing.
 *   - Only one level of member chain is typed: `this->a_->m()` resolves,
 *     `this->a_->b_->m()` does not.
 *   - A type alias is followed one hop (`using Alias = demo::Engine;`), not
 *     through a chain of aliases; `auto` is inferred only from `new T()` and
 *     `T(...)` initialisers, never from a return type.
 *   - Nested types are keyed by their bare name inside the enclosing namespace,
 *     so `Outer1::Inner` and `Outer2::Inner` in one namespace would collide (the
 *     limit Java and C# already document).
 *   - C++ has no `async`/`await`, so `isAsync`/`isAwait` are always false, and
 *     `[[attributes]]` are not collected — `decorators` is always empty.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, FunctionNode } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  dirOf,
  lookupScoped,
  scopedKey,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

const EXTENSIONS = ['.c', '.h', '.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx'] as const;

const EXTENSION_RE = /\.(c\+\+|cpp|cxx|cc|hpp|hxx|hh|c|h)$/;

/**
 * CMake and autotools scratch. `build`, `out` and `dist` are already common
 * skips; `CMakeFiles` and `.deps` hold generated compilation units, and
 * `cmake-build-*` (the CLion convention) is matched by name prefix in
 * {@link discoverFilter} because skip lists match whole directory names.
 */
const EXTRA_SKIP_DIRS = ['build', 'CMakeFiles', '.deps', '_build', 'cmake-build'];

/**
 * Generated protobuf units. They are machine-written, enormous, and describe
 * nothing a reader wrote — the same reasoning that excludes C#'s `.Designer.cs`.
 * Nothing else is excluded by name: `moc_*.cpp` and friends are too
 * project-specific to guess at, and a wrong exclusion loses real code silently.
 */
const GENERATED_RE = /\.pb\.(h|cc|cpp)$/;

/** Declarator shells wrapped around the thing actually being declared. */
const DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'reference_declarator',
  'parenthesized_declarator',
  'array_declarator',
  'init_declarator',
]);

/** Children of a declaration that can carry a declarator. */
const DECLARATOR_LIKE = new Set([
  ...DECLARATOR_WRAPPERS,
  'function_declarator',
  'identifier',
  'field_identifier',
  'operator_name',
  'destructor_name',
  'qualified_identifier',
]);

/** Type declarations that own a member list. */
const TYPE_SPECIFIERS = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);

/**
 * Preprocessor conditionals whose branches are scanned as ordinary containers.
 * Both arms of an `#ifdef` contribute — no preprocessor state is simulated, and
 * dropping one arm would lose real code in half of all builds.
 */
const PREPROC_BRANCHES = new Set([
  'preproc_if',
  'preproc_ifdef',
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
  'preproc_elifndef',
]);

/** A function/member name we are willing to put in an id (`~Dtor` included). */
const NAME_RE = /^~?[A-Za-z_]\w*$/;

/** One type, located: the namespace that declares it and the module it lives in. */
interface TypeRef {
  /** Namespace path, `::`-joined; '' is the global scope. */
  scope: string;
  name: string;
  module: string;
}

/** What a scan learned about one declared type. */
interface TypeInfo {
  scope: string;
  name: string;
  /** Written base spellings, resolved to {@link TypeRef}s in `buildIndexes`. */
  baseSpellings: string[];
  /** field name → written type spelling ('' when the type names no class). */
  fields: Map<string, string>;
  /** Every callable member name, declared or defined. */
  members: Set<string>;
  /** Members carrying `static` at their DECLARATION (an out-of-line definition may not repeat it). */
  staticMembers: Set<string>;
}

/** {@link TypeInfo} merged across scans, with bases resolved. */
interface MergedType extends TypeInfo {
  module: string;
  bases: TypeRef[];
  /** The scan that first declared it — its imports resolve the base names. */
  home: ModuleScan;
}

/**
 * One callable seen while scanning. Deliberately not a node yet: whether
 * `demo::helpers::shout` is a method of class `helpers` or a free function of
 * namespace `demo::helpers` cannot be answered from one file.
 */
interface FnRecord {
  /** Enclosing namespace path. */
  scope: string;
  /** Owning type, when the declaration sat inside a class body; '' otherwise. */
  className: string;
  /** Qualifiers written before the name (`demo::App::run` → `['demo','App']`). */
  quals: string[];
  name: string;
  file: string;
  /** Node spanning the declaration; drives lines and signature. */
  node: Node;
  /** null = a declaration with no body. */
  body: Node | null;
  /** Member-initialiser list of a constructor, which also holds calls. */
  initList: Node | null;
  isStatic: boolean;
  /** parameter name → written type spelling ('' when unlearnable). */
  params: Map<string, string>;
}

interface FnContext {
  /** Everything to walk for calls: the body, plus a constructor's init list. */
  bodies: Node[];
  owner: TypeRef | undefined;
  scope: string;
  /** parameters and locals whose type we learned → written type spelling. */
  scopeTypes: Map<string, string>;
  /** every name bound in this scope — it shadows a member of the same name. */
  declaredNames: Set<string>;
}

/** One `#include`, with the directory it was written in. */
interface IncludeRef {
  dir: string;
  path: string;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: local name → the qualified spelling it aliases (`using
   * demo::Engine;`, `using A = demo::Engine;`, `typedef`). `ownerMethods` and
   * `fieldTypes` carry the BARE-name view for spine compatibility; resolution
   * uses the scope-aware tables instead. `freeFunctions` holds the free
   * functions that were unambiguous at scan time.
   */
  fnContext: Map<string, FnContext>;
  /** Every callable seen; nodes are materialised in `buildIndexes`. */
  records: FnRecord[];
  /** scopedKey(scope, Type) → what this scan learned about it. */
  types: Map<string, TypeInfo>;
  /** `using namespace X;` targets, in file order. */
  usingNamespaces: string[];
  includes: IncludeRef[];
  /** This module plus everything it includes, transitively. */
  visible: Set<string>;
  /** Some include names a header outside the scan set (transitively). */
  seesUnscannedHeaders: boolean;
}

/** Where a symbol's node lives. */
interface SymbolDef {
  id: string;
  module: string;
}

interface CppIndexes {
  /** scopedKey(scope, `Type::member` | freeName) → every node owning that name. */
  symbols: Map<string, SymbolDef[]>;
  /** scopedKey(scope, Type) → the merged type. */
  types: Map<string, MergedType>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(EXTENSION_RE, '').split('/').join('.');
}

/* ------------------------------------------------------------------ names */

/** `a::b::c` from an identifier / qualified-identifier tree; '' if unnameable. */
function nameSpelling(node: Node | null): string {
  if (!node) return '';
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'namespace_identifier':
    case 'field_identifier':
    case 'destructor_name':
    case 'operator_name':
      return node.text;
    case 'qualified_identifier': {
      const name = node.childForFieldName('name');
      const first = node.namedChildren[0] ?? null;
      // `::global` has no left-hand scope: its only child IS the name.
      const left = first && name && first.startIndex !== name.startIndex ? nameSpelling(first) : '';
      const right = nameSpelling(name);
      return left ? `${left}::${right}` : right;
    }
    case 'template_type':
    case 'template_function':
      return nameSpelling(node.childForFieldName('name'));
    case 'nested_namespace_specifier':
      return node.namedChildren
        .filter((c): c is Node => c !== null)
        .map((c) => c.text)
        .join('::');
    default:
      return '';
  }
}

/**
 * The written spelling of a type, template arguments and cv/ref/pointer noise
 * peeled off: `std::shared_ptr<Engine>` → `std::shared_ptr`, `struct Engine*` →
 * `Engine`, `Holder<int>` → `Holder`. Primitives and `auto` yield '' — the
 * grammar tags them, so no hand-maintained builtin list is needed.
 */
function typeSpelling(node: Node | null): string {
  if (!node) return '';
  switch (node.type) {
    case 'type_identifier':
      return node.text;
    case 'qualified_identifier':
    case 'template_type':
      return nameSpelling(node);
    case 'class_specifier':
    case 'struct_specifier':
    case 'union_specifier':
    case 'enum_specifier':
      // `struct Engine* e` — a type reference spelled with its tag keyword.
      return fieldText(node, 'name');
    case 'type_descriptor':
      return typeSpelling(node.childForFieldName('type'));
    default:
      return '';
  }
}

function tailOf(spelling: string): string {
  const at = spelling.lastIndexOf('::');
  return at >= 0 ? spelling.slice(at + 2) : spelling;
}

function qualifierOf(spelling: string): string {
  const at = spelling.lastIndexOf('::');
  return at >= 0 ? spelling.slice(0, at) : '';
}

function joinScope(...parts: string[]): string {
  return parts.filter(Boolean).join('::');
}

/** `outer::inner` → `['outer::inner', 'outer', '']` — enclosing scopes, nearest first. */
function scopeChain(scope: string): string[] {
  const parts = scope ? scope.split('::') : [];
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i -= 1) chain.push(parts.slice(0, i).join('::'));
  chain.push('');
  return chain;
}

/**
 * C++'s own lookup order for a name written with `qualifier`: every enclosing
 * namespace from the innermost out, then the global scope, then each `using
 * namespace`. A generator so later candidates are only built if needed.
 */
function* candidateScopes(scope: string, qualifier: string, usings: readonly string[]): Generator<string> {
  for (const prefix of scopeChain(scope)) yield joinScope(prefix, qualifier);
  for (const using of usings) yield joinScope(using, qualifier);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The qualname of a member or free function: `<namespace>.<Type>.<member>`,
 * with `::` flattened to `.`.
 *
 * The namespace MUST be in here. Two out-of-line definitions of
 * `audio::Engine::spin` and `video::Engine::spin` can sit in one .cpp, which
 * gives them one moduleId; without the namespace their ids both collapse to
 * `impl.Engine.spin` and one of the two functions silently disappears (the
 * spine's id dedupe keeps the last). Same-named `Engine` / `Config` / `Buffer`
 * across namespaces is the norm in real C++, not a corner case.
 *
 * `.` rather than `::` because every other adapter uses `.` and
 * `graph.ts` decomposes an id by taking the last two segments as
 * `<Type>.<member>` — which still holds with a namespace in front. Empty
 * segments are dropped, so the global scope and an anonymous namespace both
 * yield a qualname with no leading dot.
 */
function dottedQualname(scope: string, className: string | undefined, name: string): string {
  return [...(scope ? scope.split('::') : []), className, name].filter(Boolean).join('.');
}

/* ------------------------------------------------------------ declarators */

/** Peel `*`, `&`, `[]`, `(…)` and `= init` off a declarator. */
function coreDeclarator(node: Node | null): Node | null {
  let current = node;
  let guard = 0;
  while (current && DECLARATOR_WRAPPERS.has(current.type) && guard < 64) {
    guard += 1;
    current =
      current.childForFieldName('declarator') ?? current.namedChildren.find((c) => c !== null) ?? null;
  }
  return current;
}

/** The `function_declarator` a declaration is built around, if it is one. */
function functionDeclaratorOf(node: Node | null): Node | undefined {
  const core = coreDeclarator(node);
  return core?.type === 'function_declarator' ? core : undefined;
}

/** The `= …` initialiser of a declarator chain. */
function initializerValue(node: Node | null): Node | null {
  let current = node;
  let guard = 0;
  while (current && DECLARATOR_WRAPPERS.has(current.type) && guard < 64) {
    guard += 1;
    if (current.type === 'init_declarator') return current.childForFieldName('value');
    current =
      current.childForFieldName('declarator') ?? current.namedChildren.find((c) => c !== null) ?? null;
  }
  return null;
}

interface DeclaredName {
  quals: string[];
  leaf: string;
}

/** The name a `function_declarator` declares, split into qualifiers and leaf. */
function declaredNameOf(fnDeclarator: Node): DeclaredName | undefined {
  const spelling = nameSpelling(fnDeclarator.childForFieldName('declarator'));
  if (!spelling) return undefined;
  const parts = spelling.split('::').filter(Boolean);
  const leaf = parts.pop() ?? '';
  // Operator overloads (`operator+`, `operator[]`) and function-pointer
  // declarators land here with punctuation in the name; they get no node.
  return NAME_RE.test(leaf) ? { quals: parts, leaf } : undefined;
}

function hasSpecifier(node: Node, keyword: string): boolean {
  return node.namedChildren.some((c) => c?.type === 'storage_class_specifier' && c.text === keyword);
}

function paramTypesOf(fnDeclarator: Node): Map<string, string> {
  const params = new Map<string, string>();
  const list = fnDeclarator.childForFieldName('parameters');
  for (const param of list?.namedChildren ?? []) {
    if (param?.type !== 'parameter_declaration' && param?.type !== 'optional_parameter_declaration') {
      continue;
    }
    const core = coreDeclarator(param.childForFieldName('declarator'));
    if (!core || (core.type !== 'identifier' && core.type !== 'field_identifier')) continue;
    params.set(core.text, typeSpelling(param.childForFieldName('type')));
  }
  return params;
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

function collectInclude(scan: ModuleScan, node: Node, file: string): void {
  const path = node.childForFieldName('path');
  if (!path) return;
  if (path.type === 'string_literal') {
    scan.includes.push({ dir: dirOf(file), path: path.text.slice(1, -1) });
    return;
  }
  // `<system>` — never in the scan set, but real evidence that this unit sees
  // declarations we did not read.
  scan.seesUnscannedHeaders = true;
}

function collectUsing(scan: ModuleScan, node: Node): void {
  const isNamespace = node.children.some((c) => c !== null && !c.isNamed && c.text === 'namespace');
  const target = node.namedChildren.find((c) => c !== null) ?? null;
  const spelling = nameSpelling(target);
  if (!spelling) return;
  if (isNamespace) {
    if (!scan.usingNamespaces.includes(spelling)) scan.usingNamespaces.push(spelling);
    return;
  }
  scan.imports.set(tailOf(spelling), spelling);
}

function collectAlias(scan: ModuleScan, node: Node): void {
  // `using Alias = demo::Engine;`
  const alias = fieldText(node, 'name');
  const target = typeSpelling(node.childForFieldName('type'));
  if (alias && target && alias !== target) scan.imports.set(alias, target);
}

function collectTypedef(scan: ModuleScan, node: Node): void {
  // `typedef struct Point Point;` / `typedef demo::Engine E;`
  const target = typeSpelling(node.childForFieldName('type'));
  const core = coreDeclarator(node.childForFieldName('declarator'));
  const alias = core?.type === 'type_identifier' ? core.text : '';
  if (alias && target && alias !== target) scan.imports.set(alias, target);
}

function recordFromDeclarator(
  scan: ModuleScan,
  opts: {
    declarator: Node | null;
    node: Node;
    body: Node | null;
    initList: Node | null;
    scope: string;
    className: string;
    file: string;
    isStatic: boolean;
  },
): DeclaredName | undefined {
  const fnDeclarator = functionDeclaratorOf(opts.declarator);
  if (!fnDeclarator) return undefined;
  const named = declaredNameOf(fnDeclarator);
  if (!named) return undefined;
  scan.records.push({
    scope: opts.scope,
    className: opts.className,
    quals: named.quals,
    name: named.leaf,
    file: opts.file,
    node: opts.node,
    body: opts.body,
    initList: opts.initList,
    isStatic: opts.isStatic,
    params: paramTypesOf(fnDeclarator),
  });
  return named;
}

/** A `function_definition` at namespace or global scope. */
function scanFunctionDefinition(scan: ModuleScan, node: Node, scope: string, file: string): void {
  const named = recordFromDeclarator(scan, {
    declarator: node.childForFieldName('declarator'),
    node,
    // `= default` / `= delete` parse as a definition with no body.
    body: node.childForFieldName('body'),
    initList: node.namedChildren.find((c) => c?.type === 'field_initializer_list') ?? null,
    scope,
    className: '',
    file,
    isStatic: hasSpecifier(node, 'static'),
  });
  if (named && named.quals.length === 0) scan.freeFunctions.add(named.leaf);
}

/** A `declaration` at namespace or global scope — a prototype, or data. */
function scanDeclaration(scan: ModuleScan, node: Node, scope: string, file: string): void {
  for (const child of node.namedChildren) {
    if (!child || !DECLARATOR_LIKE.has(child.type)) continue;
    const named = recordFromDeclarator(scan, {
      declarator: child,
      node,
      body: null,
      initList: null,
      scope,
      className: '',
      file,
      isStatic: hasSpecifier(node, 'static'),
    });
    if (named && named.quals.length === 0) scan.freeFunctions.add(named.leaf);
  }
}

/** Members of a type body, with member templates unwrapped. */
function membersOf(body: Node): Node[] {
  const members: Node[] = [];
  const pending: Node[] = body.namedChildren.filter((c): c is Node => c !== null);
  while (pending.length > 0) {
    const member = pending.shift();
    if (!member) continue;
    // A member template wraps the real member; an ERROR is a member the parser
    // stumbled over (a macro in the class body) with its neighbours intact.
    if (member.type === 'template_declaration' || member.type === 'ERROR') {
      pending.unshift(
        ...member.namedChildren.filter((c): c is Node => c !== null && c.type !== 'template_parameter_list'),
      );
      continue;
    }
    members.push(member);
  }
  return members;
}

function scanTypeDeclaration(scan: ModuleScan, node: Node, scope: string, file: string): void {
  const name = fieldText(node, 'name');
  const body = node.childForFieldName('body');
  // No body = a reference to the type (`struct Engine* e`), not a declaration.
  if (!name || !body) return;

  const key = scopedKey(scope, name);
  let info = scan.types.get(key);
  if (!info) {
    info = {
      scope,
      name,
      baseSpellings: [],
      fields: new Map(),
      members: new Set(),
      staticMembers: new Set(),
    };
    scan.types.set(key, info);
  }
  addScopedType(scan, scope, name);
  if (!scan.ownerMethods.has(name)) scan.ownerMethods.set(name, new Set());

  const baseClause = node.namedChildren.find((c) => c?.type === 'base_class_clause');
  for (const base of baseClause?.namedChildren ?? []) {
    const spelling = base ? typeSpelling(base) : '';
    if (spelling && !info.baseSpellings.includes(spelling)) info.baseSpellings.push(spelling);
  }

  const noteMember = (member: string, isStatic: boolean): void => {
    info.members.add(member);
    scan.ownerMethods.get(name)?.add(member);
    if (isStatic) info.staticMembers.add(member);
  };

  for (const member of membersOf(body)) {
    if (TYPE_SPECIFIERS.has(member.type)) {
      // A nested type keeps the enclosing NAMESPACE as its scope; see the header
      // note on bare-name keying of nested types.
      scanTypeDeclaration(scan, member, scope, file);
      continue;
    }
    if (member.type === 'function_definition') {
      const named = recordFromDeclarator(scan, {
        declarator: member.childForFieldName('declarator'),
        node: member,
        body: member.childForFieldName('body'),
        initList: member.namedChildren.find((c) => c?.type === 'field_initializer_list') ?? null,
        scope,
        className: name,
        file,
        isStatic: hasSpecifier(member, 'static'),
      });
      if (named) noteMember(named.leaf, hasSpecifier(member, 'static'));
      continue;
    }
    if (member.type !== 'field_declaration' && member.type !== 'declaration') continue;

    const declaredType = typeSpelling(member.childForFieldName('type'));
    const isStatic = hasSpecifier(member, 'static');
    for (const child of member.namedChildren) {
      if (!child || !DECLARATOR_LIKE.has(child.type)) continue;
      const core = coreDeclarator(child);
      if (!core) continue;
      if (core.type === 'function_declarator') {
        const named = recordFromDeclarator(scan, {
          declarator: child,
          node: member,
          body: null,
          initList: null,
          scope,
          className: name,
          file,
          isStatic,
        });
        if (named) noteMember(named.leaf, isStatic);
      } else if (core.type === 'field_identifier' || core.type === 'identifier') {
        info.fields.set(core.text, declaredType);
        if (declaredType) scan.fieldTypes.set(`${name}.${core.text}`, tailOf(declaredType));
      }
    }
  }
}

/**
 * Walk a translation unit's containers iteratively: namespaces, `extern "C"`
 * blocks, templates and preprocessor branches all nest, and an explicit
 * worklist cannot overflow on pathological input.
 */
function scanRoot(scan: ModuleScan, root: Node, file: string): void {
  const queue: Array<{ node: Node; scope: string }> = [{ node: root, scope: '' }];
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item) continue;
    const { scope } = item;
    for (const child of item.node.namedChildren) {
      if (!child) continue;
      switch (child.type) {
        case 'preproc_include':
          collectInclude(scan, child, file);
          break;
        case 'using_declaration':
          collectUsing(scan, child);
          break;
        case 'alias_declaration':
          collectAlias(scan, child);
          break;
        case 'type_definition':
          collectTypedef(scan, child);
          break;
        case 'namespace_definition': {
          const named = child.childForFieldName('name');
          // An anonymous namespace binds internal linkage, not a new name: its
          // members are visible unqualified, so it keeps the enclosing scope.
          const inner = named ? joinScope(scope, nameSpelling(named)) : scope;
          const body = child.childForFieldName('body');
          if (body) queue.push({ node: body, scope: inner });
          break;
        }
        case 'linkage_specification':
        case 'declaration_list':
        case 'template_declaration':
        // Recovering inside ERROR is not optional here. The C-linkage guard
        // every portable C header carries —
        //   #ifdef __cplusplus
        //   extern "C" {
        //   #endif
        // — opens a brace the preprocessor closes in a different branch, which
        // the grammar cannot pair, so it swallows THE WHOLE REST OF THE FILE
        // into one ERROR node (measured). The well-formed declarations are
        // still in there, correctly typed; dispatch is by node type, so
        // descending recovers them and cannot invent anything the parser did
        // not already recognise.
        case 'ERROR':
          queue.push({ node: child, scope });
          break;
        case 'class_specifier':
        case 'struct_specifier':
        case 'union_specifier':
          scanTypeDeclaration(scan, child, scope, file);
          break;
        case 'function_definition':
          scanFunctionDefinition(scan, child, scope, file);
          break;
        case 'declaration':
          scanDeclaration(scan, child, scope, file);
          break;
        default:
          if (PREPROC_BRANCHES.has(child.type)) queue.push({ node: child, scope });
      }
    }
  }
}

/* ----------------------------------------------------------------- scopes */

/**
 * Was this spelling refused because the scan set declares the name MORE than
 * once, rather than not at all?
 *
 * The difference decides `boundary` vs `unresolved`, and those are opposite
 * claims. C++ requires a declaration before use, so a type no scanned file
 * declares provably came from a header we did not read — `boundary` is a fact.
 * A type two scanned files declare is the opposite situation: it is right here,
 * twice, and the analyzer cannot say which. Calling that a boundary tells the
 * reader it is third-party code.
 */
function typeSpellingIsAmbiguous(
  spelling: string,
  scan: ModuleScan,
  scope: string,
  std: StandardIndexes,
): boolean {
  if (!spelling) return false;
  let name = tailOf(spelling);
  let qualifier = qualifierOf(spelling);
  if (!qualifier) {
    const aliased = scan.imports.get(name);
    if (aliased && aliased !== spelling) {
      name = tailOf(aliased);
      qualifier = qualifierOf(aliased);
    }
  }
  for (const candidate of candidateScopes(scope, qualifier, scan.usingNamespaces)) {
    const key = scopedKey(candidate, name);
    if (std.ambiguousScopedTypes.has(key)) return true;
    // The walk stops at the first scope that HAS the name, ambiguous or not —
    // mirroring `lookupScoped`, or this would report an ambiguity in an outer
    // scope that the real lookup never reached.
    if (std.scopedTypeToModule.has(key)) return false;
  }
  return false;
}

/**
 * The type a written spelling names, or undefined when it is outside the scan
 * set — or, per {@link typeSpellingIsAmbiguous}, declared in it more than once.
 * This is the call the bare-name `typeToModule` cannot make: `Config` from
 * inside `namespace alpha` is `alpha::Config`, never `beta::Config`.
 */
function resolveTypeSpelling(
  spelling: string,
  scan: ModuleScan,
  scope: string,
  std: StandardIndexes,
): TypeRef | undefined {
  if (!spelling) return undefined;
  let name = tailOf(spelling);
  let qualifier = qualifierOf(spelling);
  if (!qualifier) {
    // `using demo::Engine;` / `using A = demo::Engine;` / `typedef`. One hop.
    const aliased = scan.imports.get(name);
    if (aliased && aliased !== spelling) {
      name = tailOf(aliased);
      qualifier = qualifierOf(aliased);
    }
  }
  const hit = lookupScoped(
    std.scopedTypeToModule,
    candidateScopes(scope, qualifier, scan.usingNamespaces),
    name,
    std.ambiguousScopedTypes,
  );
  return hit ? { scope: hit.scope, name, module: hit.value } : undefined;
}

/** Base classes of `ref`, breadth-first and cycle-safe (multiple inheritance is real). */
function ancestorsOf(ref: TypeRef, own: CppIndexes): TypeRef[] {
  const start = scopedKey(ref.scope, ref.name);
  const seen = new Set([start]);
  const order: TypeRef[] = [];
  const queue: TypeRef[] = [ref];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const info = own.types.get(scopedKey(current.scope, current.name));
    for (const base of info?.bases ?? []) {
      const key = scopedKey(base.scope, base.name);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(base);
      queue.push(base);
    }
  }
  return order;
}

/** Where `member` is declared: on `ref` itself, or on its nearest scanned base. */
function declaringType(
  ref: TypeRef,
  member: string,
  own: CppIndexes,
  opts: { skipSelf?: boolean } = {},
): TypeRef | undefined {
  const declares = (candidate: TypeRef): boolean =>
    own.types.get(scopedKey(candidate.scope, candidate.name))?.members.has(member) ?? false;
  if (!opts.skipSelf && declares(ref)) return ref;
  return ancestorsOf(ref, own).find(declares);
}

/** A field's declared type spelling, inherited fields included. */
function fieldTypeOf(ref: TypeRef, field: string, own: CppIndexes): string {
  for (const candidate of [ref, ...ancestorsOf(ref, own)]) {
    const spelling = own.types.get(scopedKey(candidate.scope, candidate.name))?.fields.get(field);
    if (spelling) return spelling;
  }
  return '';
}

/** The id a member of `ref` gets when no node of its own was emitted for it. */
function fallbackMemberId(ref: TypeRef, member: string): string {
  return `${ref.module}.${dottedQualname(ref.scope, ref.name, member)}`;
}

/** Whether `name` is a data member at all — its type may not have been learnable. */
function isFieldOf(ref: TypeRef, name: string, own: CppIndexes): boolean {
  return [ref, ...ancestorsOf(ref, own)].some(
    (candidate) => own.types.get(scopedKey(candidate.scope, candidate.name))?.fields.has(name) ?? false,
  );
}

/**
 * Which of several same-named definitions the caller actually reaches. Two
 * `static` helpers of one name in different translation units are legal C, so
 * the caller's own module wins first, then anything it can see through its
 * includes, and only then scan order. (Internal linkage is not modelled beyond
 * that: a `static` definition in an unrelated, unincluded unit can still be
 * picked as the last resort.)
 */
function pickSymbol(defs: readonly SymbolDef[] | undefined, scan: ModuleScan): string | undefined {
  if (!defs || defs.length === 0) return undefined;
  return (
    defs.find((def) => def.module === scan.moduleId) ??
    defs.find((def) => scan.visible.has(def.module)) ??
    defs[0]
  )?.id;
}

/** The node id of `member` on `ref`, following the base chain. */
function memberIdOf(ref: TypeRef, member: string, scan: ModuleScan, own: CppIndexes): string | undefined {
  const declaring = declaringType(ref, member, own);
  if (!declaring) return undefined;
  return (
    pickSymbol(own.symbols.get(scopedKey(declaring.scope, `${declaring.name}::${member}`)), scan) ??
    // Declared but with no node of its own (an operator, or a member we skipped):
    // the target is still internal, and calling it a boundary would be a lie.
    fallbackMemberId(declaring, member)
  );
}

/* ---------------------------------------------------------------- pass 1b */

/** `this->x` — the member name, or '' if `node` is not that shape. */
function selfField(node: Node): string {
  return node.type === 'field_expression' && node.childForFieldName('argument')?.type === 'this'
    ? fieldText(node, 'field')
    : '';
}

/**
 * Member reads and writes: `this->x`, and bare `x` where `x` is a member of the
 * enclosing type and nothing in scope shadows it — omitting `this->` is the C++
 * norm, and register inference would miss most real state without it.
 *
 * Descent is explicit (and iterative) because the interesting distinctions are
 * positional: the field of a call's `field_expression` is a method name rather
 * than state, a declared name is not a read, and the left of `=` is a write
 * while the left of `+=` is both.
 */
function trackSelfAttrs(
  bodies: readonly Node[],
  fields: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const bareField = (node: Node): string =>
    node.type === 'identifier' && fields.has(node.text) && !shadowed.has(node.text) ? node.text : '';
  const target = (node: Node): string => selfField(node) || bareField(node);

  const stack: Node[] = [...bodies];
  const push = (node: Node | null | undefined): void => {
    if (node) stack.push(node);
  };
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      case 'field_initializer': {
        const name = node.namedChildren.find((c) => c?.type === 'field_identifier');
        if (name) writes.add(name.text);
        push(node.namedChildren.find((c) => c?.type === 'argument_list'));
        break;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const compound = fieldText(node, 'operator') !== '=';
        const hit = left ? target(left) : '';
        if (hit) {
          writes.add(hit);
          if (compound) reads.add(hit);
        } else {
          push(left);
        }
        push(node.childForFieldName('right'));
        break;
      }
      case 'update_expression': {
        // `count_++` reads and writes in one go.
        const argument = node.childForFieldName('argument');
        const hit = argument ? target(argument) : '';
        if (hit) {
          reads.add(hit);
          writes.add(hit);
        } else {
          push(argument);
        }
        break;
      }
      case 'call_expression': {
        const callee = node.childForFieldName('function');
        if (callee?.type === 'field_expression') push(callee.childForFieldName('argument'));
        else if (callee && callee.type !== 'identifier') push(callee);
        push(node.childForFieldName('arguments'));
        break;
      }
      case 'field_expression': {
        const hit = selfField(node);
        if (hit) reads.add(hit);
        else push(node.childForFieldName('argument'));
        break;
      }
      case 'declaration': {
        // The declared names and the type annotation are not state reads.
        for (const child of node.namedChildren) {
          if (child && DECLARATOR_WRAPPERS.has(child.type)) push(initializerValue(child));
        }
        break;
      }
      case 'new_expression':
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

/**
 * Types and names of everything declared inside a body: `Engine local;`,
 * `auto e = Engine();`, `Engine* p = new Engine();`, `for (Engine& e : xs)`.
 */
function collectLocals(body: Node, types: Map<string, string>, names: Set<string>): void {
  const learn = (declarator: Node | null, declared: string): void => {
    const core = coreDeclarator(declarator);
    if (!core || (core.type !== 'identifier' && core.type !== 'field_identifier')) return;
    names.add(core.text);
    // `auto` hides the type; the initialiser is the only place left to read it.
    const spelling = declared || inferredType(declarator);
    if (spelling && !types.has(core.text)) types.set(core.text, spelling);
  };
  walk(body, (node) => {
    if (node.type === 'declaration') {
      const declared = typeSpelling(node.childForFieldName('type'));
      for (const child of node.namedChildren) {
        if (child && DECLARATOR_LIKE.has(child.type)) learn(child, declared);
      }
    } else if (node.type === 'for_range_loop') {
      learn(node.childForFieldName('declarator'), typeSpelling(node.childForFieldName('type')));
    }
    return undefined;
  });
}

/**
 * The type an `auto` initialiser names: `auto e = Engine();` and `auto p = new
 * Engine();`. Nothing else is inferred — a return type would need the callee's
 * signature, which is a type checker's job, not this adapter's.
 */
function inferredType(declarator: Node | null): string {
  const value = initializerValue(declarator);
  if (!value) return '';
  if (value.type === 'new_expression') return typeSpelling(value.childForFieldName('type'));
  if (value.type === 'call_expression') {
    const callee = value.childForFieldName('function');
    return callee ? nameSpelling(callee) : '';
  }
  return '';
}

/* ----------------------------------------------------------------- pass 2 */

/** Turn one {@link FnRecord} into a node plus its pass-2 context. */
function materialize(scan: ModuleScan, record: FnRecord, std: StandardIndexes, own: CppIndexes): void {
  const owner = ownerOf(record, scan, std, own);
  const symbolScope = owner ? owner.scope : joinScope(record.scope, ...record.quals);
  const symbolName = owner ? `${owner.name}::${record.name}` : record.name;
  const key = scopedKey(symbolScope, symbolName);

  // Rule 2: a declaration is only worth a node when nothing defines the symbol.
  const known = own.symbols.get(key);
  if (record.body === null && known && known.length > 0) return;

  const qualname = dottedQualname(symbolScope, owner?.name, record.name);
  const id = `${scan.moduleId}.${qualname}`;
  const info = owner ? own.types.get(scopedKey(owner.scope, owner.name)) : undefined;
  const isStatic = record.isStatic || (info?.staticMembers.has(record.name) ?? false);

  const scopeTypes = new Map<string, string>();
  const declaredNames = new Set<string>();
  for (const [param, spelling] of record.params) {
    declaredNames.add(param);
    if (spelling) scopeTypes.set(param, spelling);
  }
  const bodies = [record.initList, record.body].filter((n): n is Node => n !== null);
  if (record.body) collectLocals(record.body, scopeTypes, declaredNames);

  const { reads, writes } =
    owner && bodies.length > 0
      ? trackSelfAttrs(bodies, new Set(info?.fields.keys() ?? []), declaredNames)
      : { reads: [], writes: [] };

  const headerEnd = record.body ? record.body.startIndex : record.node.endIndex;
  const header = record.node.text.slice(0, Math.max(0, headerEnd - record.node.startIndex));

  const node: FunctionNode = {
    id,
    name: record.name,
    qualname,
    file: record.file,
    lineStart: lineStart(record.node),
    lineEnd: lineEnd(record.node),
    signature: truncate(collapse(header).replace(/[;{]$/, '').trim(), 200),
    isAsync: false,
    isMethod: owner !== undefined && !isStatic,
    className: owner ? owner.name : null,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    paramTypes: Object.fromEntries([...record.params].filter(([, spelling]) => spelling !== '')),
  };
  scan.functions.push(node);
  if (record.body) {
    scan.fnContext.set(id, {
      bodies,
      owner,
      scope: record.scope,
      scopeTypes,
      declaredNames,
    });
  }

  const defs = known ?? [];
  defs.push({ id, module: scan.moduleId });
  own.symbols.set(key, defs);
}

/**
 * The type a record belongs to. An in-class declaration says so directly; an
 * out-of-line `A::B::c` is a method only if `A::B` names a scanned type —
 * otherwise it is a free function of namespace `A::B`, and only the whole scan
 * set can tell the two apart.
 */
function ownerOf(
  record: FnRecord,
  scan: ModuleScan,
  std: StandardIndexes,
  own: CppIndexes,
): TypeRef | undefined {
  if (record.className) {
    const hit = lookupScoped(
      std.scopedTypeToModule,
      candidateScopes(record.scope, '', scan.usingNamespaces),
      record.className,
      std.ambiguousScopedTypes,
    );
    return hit
      ? { scope: hit.scope, name: record.className, module: hit.value }
      : { scope: record.scope, name: record.className, module: scan.moduleId };
  }
  if (record.quals.length === 0) return undefined;
  const ref = resolveTypeSpelling(record.quals.join('::'), scan, record.scope, std);
  // A constructor written out of line is `App::App`; the type must exist.
  return ref && own.types.has(scopedKey(ref.scope, ref.name)) ? ref : undefined;
}

/* ------------------------------------------------------------- resolution */

function resolveOnType(
  ref: TypeRef | undefined,
  spelling: string,
  method: string,
  callType: Resolved['callType'],
  scan: ModuleScan,
  own: CppIndexes,
  ambiguous = false,
): Resolved {
  // Ambiguous is NOT a boundary. The type is in the scan set twice, so claiming
  // the call leaves the scan set is false; the honest answer is that we could
  // not resolve it, which is what `dropped-calls.json` is for.
  if (!ref) return ambiguous ? unresolvedOf(`${spelling}.${method}`) : boundaryOf(spelling, method);
  const id = memberIdOf(ref, method, scan, own);
  // Scanned type, member we never saw: still internal, so point into its module.
  return { calleeId: id ?? fallbackMemberId(ref, method), callType };
}

/** A method of the caller's own type, or of a scanned base. */
function resolveSelfMethod(
  method: string,
  context: FnContext,
  scan: ModuleScan,
  own: CppIndexes,
): Resolved | undefined {
  if (!context.owner) return undefined;
  const id = memberIdOf(context.owner, method, scan, own);
  return id ? { calleeId: id, callType: 'self_method' } : undefined;
}

/** A free function visible from the caller's scope. */
function resolveFree(
  name: string,
  qualifier: string,
  scan: ModuleScan,
  context: FnContext,
  own: CppIndexes,
): Resolved | undefined {
  const hit = lookupScoped(
    own.symbols,
    candidateScopes(context.scope, qualifier, scan.usingNamespaces),
    name,
  );
  const id = pickSymbol(hit?.value, scan);
  return id ? { calleeId: id, callType: 'internal_func' } : undefined;
}

/** `Engine()` / `new Engine()` on a scanned type. */
function resolveConstructor(
  spelling: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved | undefined {
  const ref = resolveTypeSpelling(spelling, scan, context.scope, std);
  if (!ref) return undefined;
  const id =
    pickSymbol(own.symbols.get(scopedKey(ref.scope, `${ref.name}::${ref.name}`)), scan) ??
    fallbackMemberId(ref, ref.name);
  return { calleeId: id, callType: 'internal_constructor' };
}

/**
 * A name we could not ground. C and C++ require a declaration before use, so a
 * name declared in NO scanned file provably comes from a header we did not
 * read — but only when this unit includes one. Without that evidence, claiming
 * the call leaves the scan set would be a guess.
 */
function resolveUnknownBare(name: string, scan: ModuleScan): Resolved {
  return scan.seesUnscannedHeaders ? boundaryOf(name) : unresolvedOf(name);
}

/** Bare `m()` / `m<T>()`: own type first, then a free function, then a constructor. */
function resolveBare(
  name: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved {
  const viaSelf = resolveSelfMethod(name, context, scan, own);
  if (viaSelf) return viaSelf;
  const viaFree = resolveFree(name, '', scan, context, own);
  if (viaFree) return viaFree;
  const viaType = resolveConstructor(name, scan, context, std, own);
  if (viaType) return viaType;
  // A value in scope, or a data member, called like a function is a function
  // pointer or a functor. This adapter follows neither, and calling it a
  // boundary would claim the target is outside the scan set when we simply do
  // not know where it is.
  if (context.declaredNames.has(name)) return unresolvedOf(name);
  if (context.owner && isFieldOf(context.owner, name, own)) return unresolvedOf(name);
  return resolveUnknownBare(name, scan);
}

/** `Type::staticM()`, `ns::func()`, `::global()`. */
function resolveQualified(
  spelling: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved {
  const name = tailOf(spelling);
  const qualifier = qualifierOf(spelling);
  if (!qualifier) return resolveBare(name, scan, context, std, own);

  // A qualifier naming a scanned type: per the SP2 IR decision a qualified call
  // into the scan set IS a call to an internal function, so no callType is
  // invented for it.
  const ref = resolveTypeSpelling(qualifier, scan, context.scope, std);
  if (ref && own.types.has(scopedKey(ref.scope, ref.name))) {
    return resolveOnType(ref, qualifier, name, 'internal_func', scan, own);
  }
  const viaFree = resolveFree(name, qualifier, scan, context, own);
  if (viaFree) return viaFree;
  const viaType = resolveConstructor(spelling, scan, context, std, own);
  if (viaType) return viaType;
  return boundaryOf(qualifier, name);
}

/** `a.m()`, `p->m()`, `this->m()`, `this->field->m()`. */
function resolveMember(
  receiver: Node,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved {
  // A. `this->m()`
  if (receiver.type === 'this') {
    return resolveSelfMethod(method, context, scan, own) ?? unresolvedOf(`this->${method}`);
  }

  // B. `this->field->m()`
  const field = selfField(receiver);
  if (field) {
    const spelling = context.owner ? fieldTypeOf(context.owner, field, own) : '';
    if (!spelling) return unresolvedOf(`this->${field}.${method}`);
    const ref = resolveTypeSpelling(spelling, scan, context.scope, std);
    return resolveOnType(
      ref,
      spelling,
      method,
      'self_attr_method',
      scan,
      own,
      typeSpellingIsAmbiguous(spelling, scan, context.scope, std),
    );
  }

  // C. one bare name: a typed value in scope, then own state, then a type.
  if (receiver.type === 'identifier') {
    const base = receiver.text;
    const scoped = context.scopeTypes.get(base);
    if (scoped) {
      const ref = resolveTypeSpelling(scoped, scan, context.scope, std);
      return resolveOnType(
        ref,
        scoped,
        method,
        'param_method',
        scan,
        own,
        typeSpellingIsAmbiguous(scoped, scan, context.scope, std),
      );
    }
    if (context.owner && !context.declaredNames.has(base)) {
      const spelling = fieldTypeOf(context.owner, base, own);
      if (spelling) {
        const ref = resolveTypeSpelling(spelling, scan, context.scope, std);
        return resolveOnType(
          ref,
          spelling,
          method,
          'self_attr_method',
          scan,
          own,
          typeSpellingIsAmbiguous(spelling, scan, context.scope, std),
        );
      }
    }
    // A capitalized receiver that names no value in scope is a type or a
    // namespace we do not have, which `boundary` states truthfully. A lowercase
    // one is a value whose type we simply failed to learn — claiming it leaves
    // the scan set would be a guess, so it stays unresolved.
    if (/^[A-Z]/.test(base)) return boundaryOf(base, method);
    return unresolvedOf(`${base}.${method}`);
  }

  return unresolvedOf(collapse(`${receiver.text}.${method}`));
}

function resolveCall(
  callee: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved {
  if (callee.type === 'identifier' || callee.type === 'template_function') {
    // `m<T>()` resolves to the template itself: this IR has no instantiations.
    const name = nameSpelling(callee);
    return name ? resolveBare(name, scan, context, std, own) : unresolvedOf(callee.text);
  }
  if (callee.type === 'qualified_identifier') {
    const spelling = nameSpelling(callee);
    return spelling ? resolveQualified(spelling, scan, context, std, own) : unresolvedOf(callee.text);
  }
  if (callee.type === 'field_expression') {
    const receiver = callee.childForFieldName('argument');
    const method = fieldText(callee, 'field');
    if (receiver && method) return resolveMember(receiver, method, scan, context, std, own);
  }
  // `(*fp)()`, `obj()`, a call on a temporary — nothing to ground.
  return unresolvedOf(collapse(callee.text));
}

function resolveNew(
  node: Node,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: CppIndexes,
): Resolved | undefined {
  const spelling = typeSpelling(node.childForFieldName('type'));
  // `new int(4)` names no constructor; an edge to a primitive would be noise.
  if (!spelling) return undefined;
  return (
    resolveConstructor(spelling, scan, context, std, own) ??
    boundaryOf(spelling, undefined, { isConstructor: true })
  );
}

/* --------------------------------------------------------------- includes */

/** `src/a` + `../b/c.h` → `b/c.h`. */
function normalizeInclude(dir: string, path: string): string {
  const parts = (dir === '.' ? [] : dir.split('/')).concat(path.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/**
 * The module a quoted `#include` names: relative to the includer, then to the
 * source root, then by unique path suffix (which is how `#include
 * "core/spinner.h"` finds `include/core/spinner.h` without knowing the
 * project's `-I` flags).
 */
function resolveInclude(
  include: IncludeRef,
  byPath: ReadonlyMap<string, string>,
  byBasename: ReadonlyMap<string, string[]>,
): string | undefined {
  const direct = byPath.get(normalizeInclude(include.dir, include.path));
  if (direct) return direct;
  const fromRoot = byPath.get(normalizeInclude('.', include.path));
  if (fromRoot) return fromRoot;
  const wanted = `/${include.path}`;
  const matches = (byBasename.get(include.path.split('/').pop() ?? '') ?? []).filter((file) =>
    file.endsWith(wanted),
  );
  return matches.length === 1 ? byPath.get(matches[0] ?? '') : undefined;
}

/** Fill in each scan's transitive include closure and unscanned-header flag. */
function computeVisibility(scans: readonly ModuleScan[]): void {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const scan of scans) {
    for (const file of scan.files) {
      byPath.set(file, scan.moduleId);
      const base = file.split('/').pop() ?? file;
      const list = byBasename.get(base);
      if (list) list.push(file);
      else byBasename.set(base, [file]);
    }
  }

  const direct = new Map<string, Set<string>>();
  const opaque = new Map<string, boolean>();
  for (const scan of scans) {
    let edges = direct.get(scan.moduleId);
    if (!edges) {
      edges = new Set<string>();
      direct.set(scan.moduleId, edges);
    }
    for (const include of scan.includes) {
      const target = resolveInclude(include, byPath, byBasename);
      if (target) edges.add(target);
      else scan.seesUnscannedHeaders = true;
    }
    opaque.set(scan.moduleId, (opaque.get(scan.moduleId) ?? false) || scan.seesUnscannedHeaders);
  }

  for (const scan of scans) {
    const seen = new Set([scan.moduleId]);
    const queue = [...(direct.get(scan.moduleId) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop();
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push(...(direct.get(next) ?? []));
    }
    scan.visible = seen;
    // A header we cannot read is just as opaque when reached transitively.
    scan.seesUnscannedHeaders = [...seen].some((module) => opaque.get(module) ?? false);
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
  // No type extraction yet — an EMPTY list is the positive declaration, not a
  // gap in this object. The agent artifact reads it and says so on the page, and
  // the `class-derived` fallback row (a span inferred from a class's methods,
  // labelled as inferred) is what covers `class`, `struct` and `union` here in the meantime.
  typeKinds: [],
};

const CPP_SPEC: LanguageSpec<ModuleScan, CppIndexes> = {
  name: 'cpp',
  extensions: EXTENSIONS,
  // Measured: `cpp` parses pure C cleanly, `c` does not parse C++ at all. A
  // `.h` is as likely to be C++ as C, so only `.c` is certain enough for `c`.
  grammarFor: (file) => (file.endsWith('.c') ? 'c' : 'cpp'),
  extraSkipDirs: EXTRA_SKIP_DIRS,
  discoverFilter: (rel) =>
    !GENERATED_RE.test(rel) && !rel.split('/').some((seg) => seg.startsWith('cmake-build')),
  moduleIdForFile,
  // `engine.h` and `engine.cpp` are one module: that is what makes the common
  // layout's declaration and definition meet without an include lookup at all.
  mergeByModule: true,
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
      records: [],
      types: new Map(),
      usingNamespaces: [],
      includes: [],
      visible: new Set([moduleId]),
      seesUnscannedHeaders: false,
    };
  },

  scan(scan, root, file) {
    scanRoot(scan, root, file);
  },

  /**
   * Everything that needs the whole scan set happens here, in order: include
   * visibility, the merged type table, then node materialisation — definitions
   * first, so a declaration can tell whether it is the only evidence of its
   * function. The driver reads `scan.functions` AFTER this hook, which is what
   * makes "the definition owns the node" expressible at all.
   */
  buildIndexes(scans, std) {
    computeVisibility(scans);

    const types = new Map<string, MergedType>();
    for (const scan of scans) {
      for (const [key, info] of scan.types) {
        let merged = types.get(key);
        if (!merged) {
          merged = {
            scope: info.scope,
            name: info.name,
            module: std.scopedTypeToModule.get(key) ?? scan.moduleId,
            baseSpellings: [],
            bases: [],
            fields: new Map(),
            members: new Set(),
            staticMembers: new Set(),
            home: scan,
          };
          types.set(key, merged);
        }
        for (const base of info.baseSpellings) {
          if (!merged.baseSpellings.includes(base)) merged.baseSpellings.push(base);
        }
        for (const [field, spelling] of info.fields) {
          if (!merged.fields.has(field)) merged.fields.set(field, spelling);
        }
        for (const member of info.members) merged.members.add(member);
        for (const member of info.staticMembers) merged.staticMembers.add(member);
      }
    }
    // Base names are resolved with the DECLARING file's usings, so this needs
    // the table above to be complete first.
    for (const merged of types.values()) {
      for (const spelling of merged.baseSpellings) {
        const ref = resolveTypeSpelling(spelling, merged.home, merged.scope, std);
        if (ref) merged.bases.push(ref);
      }
    }

    const own: CppIndexes = { symbols: new Map(), types };
    for (const wantBody of [true, false]) {
      for (const scan of scans) {
        for (const record of scan.records) {
          if ((record.body !== null) === wantBody) materialize(scan, record, std, own);
        }
      }
    }
    // Overloads share one id (an id carries no arity); keep the last so the
    // pass-2 lookup does not multiply its edges.
    for (const scan of scans) scan.functions = dedupeFunctionsById(scan.functions);
    return own;
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      for (const body of context.bodies) {
        walk(body, (node) => {
          let resolved: Resolved | undefined;
          let raw = '';
          if (node.type === 'call_expression') {
            const callee = node.childForFieldName('function');
            if (!callee) return undefined;
            resolved = resolveCall(callee, scan, context, std, own);
            raw = callee.text;
          } else if (node.type === 'new_expression') {
            resolved = resolveNew(node, scan, context, std, own);
            raw = node.text;
          }
          if (!resolved) return undefined;
          edges.push({
            callerId: fn.id,
            calleeId: resolved.calleeId,
            isAwait: false,
            callType: resolved.callType,
            line: lineStart(node),
            raw: truncate(collapse(raw), 80),
          });
          return undefined;
        });
      }
    }
    return edges;
  },
};

export class CppAdapter extends SpineAdapter<ModuleScan, CppIndexes> {
  constructor() {
    super(CPP_SPEC);
  }
}
