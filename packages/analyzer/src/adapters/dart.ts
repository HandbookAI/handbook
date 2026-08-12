/**
 * Dart adapter (tree-sitter grammar `dart`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: directives (`import` / `export` / `part` / `part of`),
 *      every class / mixin / extension / enum, its ancestry, its field and
 *      parameter types, its members, and `this.x` usage;
 *   2. resolve every invocation and `new` against the cross-module indexes into
 *      typed {@link CallEdge}s.
 *
 * Four things make Dart different from the other typed adapters here, and all
 * four are grammar-shaped rather than language-shaped:
 *
 * - **There is no call node.** `tree-sitter-dart` models a postfix expression as
 *   a FLAT run of siblings: the head, then a sequence of `selector` nodes
 *   (`.name`, `?.name`, `[i]`, `!`, `(args)`) and `cascade_section`s. So
 *   `a.b.c()` is four siblings, not a nested tree, and there is nothing to match
 *   on called "call_expression". Call sites are therefore found by enumerating
 *   `argument_part` nodes and walking BACKWARDS through `previousSibling` to
 *   rebuild the receiver — see {@link chainBefore}. `super.m()` is the one
 *   irregular case: its first selector is unwrapped, so the walker accepts both
 *   the wrapped and the bare form.
 * - **A signature and its body are SIBLINGS**, not parent and child:
 *   `method_signature` is followed by `function_body`. A member with no body
 *   (abstract, `external`, a redirecting constructor) is wrapped in
 *   `declaration` instead. Members are therefore paired positionally.
 * - **`new` is optional and almost never written**, so a constructor call looks
 *   exactly like a function call. `Engine()` is disambiguated by asking whether
 *   `Engine` names a scanned type, and a capitalized name that does not is
 *   reported as `boundary_constructor` — which is what `Text(...)` in a Flutter
 *   widget tree actually is.
 * - **The grammar SILENTLY MISPARSES `Foo<T>(…)`** — one type argument, outside
 *   statement position — as the comparison `Foo < T > (record)`, with
 *   `hasError` still false. That is where a Flutter widget tree lives, so the
 *   shape is detected and recovered; see {@link misparsedGenericCall}. The
 *   grammar is otherwise sound: it is order-INDEPENDENT (unlike the `lua` one
 *   this repo dropped), and a file it cannot parse collapses into a single
 *   ERROR node that yields no functions rather than corrupting its neighbours.
 *
 * **Mixins** are Dart's defining structural feature and are fully resolved:
 * `extends`, `with`, `implements` and a mixin's own `on` constraint all feed one
 * ancestor list, so a method a class only gets by mixing in `Loggable` resolves
 * to `Loggable.log` at its real declaration site. **Extension methods** are
 * resolved too: `extension EngineX on Engine` registers `boost` under the key
 * `Engine.boost` pointing at `<module>.EngineX.boost`, so `engine.boost()` lands
 * on the extension — with the caveat below.
 *
 * Ids are path-derived (`lib/src/engine.dart` → `lib.src.engine`), matching every
 * other adapter: `id = <moduleId>.<qualname>`, `qualname = <Type>.<member>`. Dart
 * has no namespaces, so nothing is lost. **Named constructors keep their source
 * name**: `Engine.named(...)` → `<module>.Engine.named`, and the unnamed
 * constructor is `<module>.Engine.Engine` (the Java/C# convention, and what
 * `graph.ts:synthesizeConstructor` needs to decompose an implicit one).
 * **Setters are named `x=`** — the real Dart member name — so a `get x` / `set x`
 * pair does not collapse onto one id.
 *
 * Module visibility is followed rather than assumed: a relative
 * `import 'engine.dart'` resolves against the importing file's directory, a
 * `package:<pkg>/<path>` URI is tried as `lib/<path>` and `<path>`, `part` /
 * `part of` join files into one library whose top-level names are mutually
 * visible, and `export` is followed transitively so barrel files work. A bare
 * name is looked up in that visible set first and only then in the scan-wide
 * `typeToModule` — the fallback keeps edges when a `package:` URI cannot be
 * mapped (no pubspec is read), at the cost of occasionally crossing an import
 * boundary that Dart itself would not.
 *
 * Known blind spots, stated rather than hidden:
 * - `noSuchMethod` and any other dynamic dispatch: a call on a `dynamic`
 *   receiver is `unresolved`, never guessed.
 * - Extension methods resolve only when the RECEIVER's type is known and the
 *   extension is anywhere in the scan set; Dart's actual rule (the extension
 *   must be imported and unambiguous) is not modelled, so an extension can be
 *   applied here that Dart would not have in scope.
 * - Generic type arguments are peeled to the core named type, so
 *   `List<Engine> l; l.first.spin()` stops at `List` — element types are not
 *   propagated, and neither are index (`l[0].m()`) or call results (`f().m()`).
 * - Local variable types are inferred ONLY from an unnamed constructor call
 *   (`var e = Engine()`); `var e = Engine.named()` and `var t = Theme.of(c)` are
 *   deliberately not inferred, because a capitalized head followed by `.name()`
 *   is as often a static factory returning some other type.
 * - `operator +` and friends are recorded as members named `operator+`, but
 *   operator APPLICATION (`a + b`) produces no edge.
 * - Top-level variable initializers (`final e = Engine();` outside any function)
 *   have no enclosing callable, so their calls are attributed to nothing.
 * - `show` / `hide` combinators are recorded for boundary naming but do not
 *   narrow internal visibility (they can only ever remove edges, never add
 *   wrong ones).
 * - Overloads do not exist in Dart, but a member and a same-named local
 *   function still share one id space; the last declaration wins.
 * - A call through a TYPED LOCAL (`var e = Engine(); e.spin()`) is reported as
 *   `param_method`, the same choice C# makes: the IR has no separate callType
 *   for it, and the alternative — dropping the edge — loses more than it saves.
 * - The spine's `directoryFunctions` is deliberately unused: Dart's visibility
 *   unit is the library, not the directory, so a same-directory sibling is NOT
 *   visible without an import. `moduleFunctions` does the cross-file work.
 *
 * Generated sources are excluded at discovery: `*.g.dart`, `*.freezed.dart`,
 * `*.gr.dart`, `*.mocks.dart` and the protobuf `*.pb*.dart` family. Every one of
 * them is machine-written, is a `part of` a hand-written library that IS scanned,
 * and would otherwise bury the real code under thousands of generated members —
 * the same call this repo already makes for C#'s `.Designer.cs` / `.g.cs`.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, TypeKind } from '@handbooks/core';
import { truncate } from '@handbooks/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  declaredTypeKinds,
  recordType,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

/** Build-tool output and the pub cache; never hand-written Dart. */
const EXTRA_SKIP_DIRS = ['.dart_tool', '.pub', '.pub-cache'];

/** Conventional `build_runner` output suffixes. See the header for why. */
const GENERATED_SUFFIXES = [
  '.g.dart',
  '.freezed.dart',
  '.gr.dart',
  '.mocks.dart',
  '.pb.dart',
  '.pbenum.dart',
  '.pbjson.dart',
  '.pbserver.dart',
];

/**
 * Types that can never be a scanned declaration. Dart's grammar tags `int` and
 * `String` as plain `type_identifier`s (unlike C#'s `predefined_type`), so
 * without this list every `int` field would produce a `boundary:int.…` edge.
 * Deliberately short: `List` / `Future` / `Map` resolving to a boundary is TRUE
 * information about a call leaving the scanned set, not noise to suppress.
 */
const PRIMITIVE_TYPES = new Set([
  'int',
  'double',
  'num',
  'bool',
  'String',
  'dynamic',
  'void',
  'Object',
  'Never',
  'Null',
  'Symbol',
  'Type',
  'Function',
]);

/** Type declarations whose members become functions. */
const TYPE_DECLS = new Set([
  'class_definition',
  'mixin_declaration',
  'extension_declaration',
  'enum_declaration',
]);

/**
 * Node type → the {@link TypeKind} it declares, for THIS grammar. Not the same
 * set as {@link TYPE_DECLS}, and the two differences are the interesting part.
 *
 * `mixin_declaration` is `trait`, not `other`. A Dart `mixin` is a named bundle of
 * method BODIES that a class composes in with `with`, and cannot be instantiated
 * — which is this vocabulary's definition of `trait`, word for word, and exactly
 * what a Scala or PHP trait is. Dart split `mixin` out of `class` in 2.19 for
 * precisely this reason, so the keyword has ONE job and can be mapped without
 * ambiguity. (Contrast Ruby's `module`, whose two jobs are why it is `other`.)
 *
 * `extension_type_declaration` (`extension type Meters(int value)`) is `other`,
 * on the same reasoning as a Go defined type: it is a distinct static type with
 * its own interface over a representation, NOT a second name for one — `Meters`
 * and `int` are not interchangeable — so `alias` would state the opposite of the
 * language's rule.
 *
 * `extension_declaration` (`extension StringX on String`) is deliberately ABSENT,
 * even though it is in {@link TYPE_DECLS} because its members are real functions.
 * An extension declares no type: `StringX` cannot annotate a variable, and the
 * type in the declaration (`String`) is one that was declared somewhere else
 * entirely. A row for it would put a non-type in the type index AND point at
 * `String`'s members as though this were where `String` came from — the wrong
 * pointer the agent artifact exists to prevent. Same rule as a Swift `extension`.
 *
 * A `class` modified by `interface`, `sealed`, `abstract`, `base` or `mixin`
 * (`abstract interface class Contract`) stays `class`: Dart's class modifiers
 * restrict who may extend or implement the type, they do not make it a different
 * kind of declaration, and the modifier survives verbatim in the signature.
 */
const DART_TYPE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ['class_definition', 'class'],
  ['enum_declaration', 'enum'],
  ['mixin_declaration', 'trait'],
  ['type_alias', 'alias'],
  ['extension_type_declaration', 'other'],
]);

/** Signature nodes that name a constructor; all share the `Type[.name]` shape. */
const CTOR_SIGNATURES = new Set([
  'constructor_signature',
  'factory_constructor_signature',
  'constant_constructor_signature',
]);

/** Signature nodes that name any callable member. */
const SIGNATURES = new Set([
  'function_signature',
  'getter_signature',
  'setter_signature',
  'operator_signature',
  ...CTOR_SIGNATURES,
]);

/** One `import` directive, before its URI has been mapped to a module. */
interface LibImport {
  /** URI text without quotes: `engine.dart`, `package:flutter/material.dart`. */
  uri: string;
  /** `as p` prefix, or '' when unprefixed. */
  prefix: string;
  /** The file that wrote the directive — relative URIs resolve against it. */
  file: string;
}

/** An {@link LibImport} whose URI has been looked up in the scanned module set. */
interface ResolvedImport {
  uri: string;
  prefix: string;
  /** moduleId inside the scan set, or undefined for a true boundary. */
  module: string | undefined;
}

interface FnContext {
  body: Node | null;
  /**
   * A constructor's `: …` initializer list or `: this.other(…)` redirection.
   * Walked alongside the body because it holds real calls — `super(key: key)`,
   * a redirect, and any expression initialising a field.
   */
  initializer: Node | null;
  className: string | null;
  /** parameters + locals whose type we learned → bare type name. */
  scopeTypes: Map<string, string>;
  /** every name bound in this scope, typed or not — shadows fields of the type. */
  declaredNames: Set<string>;
  /** local function name → its node id. */
  localFns: Map<string, string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: prefix or `show`n name → URI, for boundary naming only.
   * `ownerMethods`: class / mixin / extension / enum name → member names.
   * `fieldTypes`: `Owner.field` → bare type name. `freeFunctions`: top-level
   * functions, getters and setters (Dart has them, unlike Java and C#).
   */
  fnContext: Map<string, FnContext>;
  /** declared type → everything above it: `extends`, `with`, `implements`, `on`. */
  bases: Map<string, string[]>;
  /** declared type → its field names, typed or not. */
  ownerFields: Map<string, Set<string>>;
  /** `Type.name` for every declared constructor, named or unnamed. */
  constructors: Set<string>;
  /** `extension X on T` → `X` → `T`, so `X`'s members can be found from `T`. */
  extensionTargets: Map<string, string>;
  imports2: LibImport[];
  /** URIs of `export` directives. */
  exportUris: string[];
  /** URIs naming the other halves of this library (`part` and `part of`). */
  libraryLinks: string[];
}

/**
 * Scan-set-wide tables keyed by BARE type name, plus the resolved module graph.
 * The spine's tables are per-module and cannot express an ancestor chain, an
 * extension's target type, or which module a `package:` URI meant.
 */
interface DartIndexes {
  /** type → direct ancestors (superclass, mixins, interfaces, `on` constraints). */
  bases: Map<string, string[]>;
  /**
   * `Type.member` → `<declaring module>.<declaring owner>`. Owner differs from
   * type for extension methods, which is exactly why this maps to an id BASE
   * rather than to a module.
   */
  memberBases: Map<string, string>;
  /** `Type.name` for every declared constructor — the internal_func/ctor split. */
  constructors: Set<string>;
  /** `Type.field` → bare type name, across the whole set (inherited fields). */
  fieldTypes: Map<string, string>;
  /** moduleId → its resolved `import` directives. */
  importsOf: Map<string, ResolvedImport[]>;
  /** moduleId → the scanned modules it re-exports (barrel files). */
  exportsOf: Map<string, string[]>;
  /** moduleId → every module of its library: itself plus its `part` files. */
  libraryOf: Map<string, string[]>;
  /**
   * moduleId → every module whose top-level names it can see, own library first:
   * itself, its `part` peers, then unprefixed internal imports and what those
   * re-export.
   */
  visible: Map<string, string[]>;
}

export function moduleIdForFile(file: string): string {
  return file
    .replace(/\.dart$/, '')
    .split('/')
    .join('.');
}

/** First named child, or null. */
function firstNamed(node: Node): Node | null {
  return node.namedChildren.find((c) => c !== null) ?? null;
}

/** Named children of `node` with the given type. */
function namedOfType(node: Node, type: string): Node[] {
  return node.namedChildren.filter((c): c is Node => c?.type === type);
}

/** `'engine.dart'` → `engine.dart`; the grammar keeps the quotes in the text. */
function uriText(node: Node | null | undefined): string {
  if (!node) return '';
  const literal = node.type === 'uri' || node.type === 'configurable_uri' ? firstNamed(node) : node;
  return (literal?.text ?? '').replace(/^['"]|['"]$/g, '');
}

/**
 * The core named type of a declaration's leading type annotation.
 *
 * Dart's grammar keeps a type and its arguments as FLAT siblings, so
 * `late List<Engine> children` is `late`, `type_identifier List`,
 * `type_arguments`, then the name — and `eng.Engine a` is two `type_identifier`s
 * with a `.` between them. This reads the leading run of type identifiers and
 * takes the last, which peels `List<Engine>` → `List`, `Engine?` → `Engine` and
 * `eng.Engine` → `Engine` without any special cases.
 */
function leadingTypeName(node: Node): string {
  let last = '';
  let started = false;
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'type_identifier') {
      last = child.text;
      started = true;
      continue;
    }
    // A dot continues a qualified type; anything else after one ends the run.
    if (started && !(child.text === '.' && !child.isNamed)) break;
  }
  return PRIMITIVE_TYPES.has(last) ? '' : last;
}

/**
 * `Engine` from a value chain that is exactly `Engine()` — an UNNAMED
 * constructor call. `Engine.named()` and `Theme.of(c)` are declined on purpose:
 * a capitalized head followed by `.name()` is as often a static factory
 * returning something else entirely.
 */
function inferredCtorType(chain: readonly (Node | null)[]): string {
  const head = chain[0];
  if (!head) return '';
  if (CONSTRUCTION_NODES.has(head.type)) {
    const { type, ctor } = newExpressionType(head);
    // Same rule as below: only an UNNAMED constructor names the value's type.
    return ctor ? '' : type;
  }
  // `var x = Foo<int>(1)` lands in the misparse described above.
  const generic = misparsedGenericCall(head);
  if (generic) return generic;
  if (head.type !== 'identifier' || !/^[A-Z_$]/.test(head.text)) return '';
  const next = chain[1];
  return next && stepOf(next)?.kind === 'args' ? head.text : '';
}

/**
 * `Engine.named(…)` written with explicit type arguments collapses into a single
 * `constructor_invocation` node instead of a selector chain — but ONLY in value
 * position. `Stream<int>.empty();` as a bare statement is still a chain. Both
 * spellings occur in real code, so both are handled.
 */
const CONSTRUCTION_NODES = new Set(['new_expression', 'constructor_invocation']);

/** `new Engine.named(1)` → its type and (optional) constructor name. */
function newExpressionType(node: Node): { type: string; ctor: string } {
  const type = namedOfType(node, 'type_identifier')[0]?.text ?? '';
  const ctor = namedOfType(node, 'identifier')[0]?.text ?? '';
  return { type, ctor };
}

/**
 * Recover a generic construction the grammar gets WRONG.
 *
 * `Consumer<Model>(…)` — a construction with exactly ONE type argument — is
 * misparsed as the comparison chain `Consumer < Model > (record)` everywhere
 * except a bare expression statement: in an argument, in `var x = …`, and after
 * `return`. It is a silent misparse (`hasError` stays false), and those three
 * positions are where a Flutter widget tree actually lives, so ignoring it would
 * drop most of the constructor edges in real code. Two type arguments
 * (`Foo<int, String>(…)`) parse correctly — the comma disambiguates.
 *
 * The shape is safe to claim because it requires a CHAINED comparison — a
 * `relational_expression` nested directly inside another one, which is not legal
 * Dart in any other reading (`a < b` is a bool, and `bool > (c)` does not
 * type-check). A plain `count > (limit)` has an identifier on the left, not a
 * relational expression, so it can never match. The argument group arrives as a
 * `record_literal` when it holds named or multiple arguments and as a
 * `parenthesized_expression` when it holds exactly one positional argument; an
 * EMPTY one, `Foo<T>()`, parses correctly and never reaches here.
 */
function misparsedGenericCall(node: Node): string | undefined {
  if (node.type !== 'relational_expression') return undefined;
  const parts = node.namedChildren.filter((c): c is Node => c !== null);
  const tail = parts.at(-1)?.type;
  if (tail !== 'record_literal' && tail !== 'parenthesized_expression') return undefined;
  if (parts[0]?.type !== 'relational_expression') return undefined;
  let cursor: Node | undefined = parts[0];
  while (cursor?.type === 'relational_expression') {
    cursor = cursor.namedChildren.filter((c): c is Node => c !== null)[0];
  }
  return cursor?.type === 'identifier' && /^[A-Z_$]/.test(cursor.text) ? cursor.text : undefined;
}

/* ------------------------------------------------------------------ *
 * Postfix chains
 * ------------------------------------------------------------------ */

/** `noop` covers `!` and a bare `<T>` — neither changes what is being called. */
type StepKind = 'name' | 'args' | 'cascade' | 'noop' | 'index';

/** One link of a postfix chain, normalised across the grammar's two spellings. */
interface Step {
  node: Node;
  kind: StepKind;
  /** the member name, for `name` and `cascade` steps. */
  name: string;
}

/**
 * Classify one sibling of a postfix chain, or undefined when it is not part of
 * one (which makes it the chain's HEAD).
 *
 * Two spellings must both be accepted: `this.m()` wraps its `.m` in a `selector`
 * while `super.m()` leaves it bare, and the final `.x` of an
 * `assignable_expression` is bare too.
 */
function stepOf(child: Node): Step | undefined {
  const inner = child.type === 'selector' ? firstNamed(child) : child;
  // `selector` with no named child is the null-assertion `!`.
  if (!inner) return child.type === 'selector' ? { node: child, kind: 'noop', name: '' } : undefined;
  switch (inner.type) {
    case 'argument_part':
      return { node: inner, kind: 'args', name: '' };
    // `Box<int>.of(…)`: the explicit type arguments are their own selector.
    case 'type_arguments':
      return { node: inner, kind: 'noop', name: '' };
    case 'cascade_section': {
      const selector = inner.namedChildren.find((c) => c?.type === 'cascade_selector');
      return { node: inner, kind: 'cascade', name: selector ? (firstNamed(selector)?.text ?? '') : '' };
    }
    case 'unconditional_assignable_selector':
    case 'conditional_assignable_selector': {
      const id = inner.namedChildren.find((c) => c?.type === 'identifier');
      return id ? { node: inner, kind: 'name', name: id.text } : { node: inner, kind: 'index', name: '' };
    }
    default:
      return undefined;
  }
}

/** A chain's head expression plus every step between it and `stop`. */
interface Chain {
  head: Node | null;
  steps: Step[];
}

/**
 * Rebuild the postfix chain that ends just before `stop`, walking backwards
 * through siblings. Stops at the first sibling that is not a step — that node is
 * the head (or, if it is an operator token, the chain simply has no usable one).
 */
function chainBefore(stop: Node): Chain {
  const steps: Step[] = [];
  let cursor: Node | null = stop.previousSibling;
  let head: Node | null = null;
  while (cursor) {
    const step = stepOf(cursor);
    if (!step) {
      head = cursor.isNamed ? cursor : null;
      break;
    }
    steps.unshift(step);
    cursor = cursor.previousSibling;
  }
  return { head, steps };
}

/** What a call is being made ON. */
type Receiver =
  | { kind: 'none' }
  | { kind: 'this' }
  | { kind: 'super' }
  /** `this.field.m()` or bare `field.m()`. */
  | { kind: 'field'; field: string }
  /** a bare identifier: a local, a field, a type, or an import prefix. */
  | { kind: 'name'; name: string }
  /** `a.b.m()` — two names before the method. */
  | { kind: 'dotted'; base: string; member: string }
  /** a type we know outright: `(x as Engine).m()`, `Engine()..m()`. */
  | { kind: 'type'; type: string }
  | { kind: 'opaque' };

/** `(x as Engine)` → `Engine`. */
function castType(node: Node): string {
  if (node.type !== 'parenthesized_expression') return '';
  const cast = node.namedChildren.find((c) => c?.type === 'type_cast_expression');
  const clause = cast?.namedChildren.find((c) => c?.type === 'type_cast');
  return clause ? leadingTypeName(clause) : '';
}

function receiverOf(head: Node | null, steps: readonly Step[]): Receiver {
  const real = steps.filter((s) => s.kind !== 'noop');
  if (!head) return real.length === 0 ? { kind: 'none' } : { kind: 'opaque' };
  const first = real[0];

  if (head.type === 'this') {
    if (real.length === 0) return { kind: 'this' };
    if (real.length === 1 && first?.kind === 'name') return { kind: 'field', field: first.name };
    return { kind: 'opaque' };
  }
  if (head.type === 'super') return real.length === 0 ? { kind: 'super' } : { kind: 'opaque' };
  if (CONSTRUCTION_NODES.has(head.type) && real.length === 0) {
    return { kind: 'type', type: newExpressionType(head).type };
  }
  if (head.type === 'identifier') {
    if (real.length === 0) return { kind: 'name', name: head.text };
    if (real.length === 1 && first?.kind === 'name') {
      return { kind: 'dotted', base: head.text, member: first.name };
    }
    // `Engine()..spin()` / `Engine().spin()`: the receiver is the new instance.
    if (real.length === 1 && first?.kind === 'args' && /^[A-Z_$]/.test(head.text)) {
      return { kind: 'type', type: head.text };
    }
    return { kind: 'opaque' };
  }
  const cast = castType(head);
  if (cast && real.length === 0) return { kind: 'type', type: cast };
  return { kind: 'opaque' };
}

/* ------------------------------------------------------------------ *
 * Pass 1 — scanning
 * ------------------------------------------------------------------ */

function collectDirective(node: Node, scan: ModuleScan, file: string): void {
  if (node.type === 'part_directive' || node.type === 'part_of_directive') {
    // `part of my.lib;` (the dotted form) names no path and cannot be mapped.
    const uri = uriText(node.namedChildren.find((c) => c?.type === 'uri'));
    if (uri) scan.libraryLinks.push(uri);
    return;
  }
  if (node.type !== 'import_or_export') return;
  const inner = firstNamed(node);
  if (!inner) return;

  if (inner.type === 'library_export') {
    const uri = uriText(inner.namedChildren.find((c) => c?.type === 'configurable_uri'));
    if (uri) scan.exportUris.push(uri);
    return;
  }
  const spec = inner.type === 'library_import' ? firstNamed(inner) : inner;
  if (!spec) return;
  const uri = uriText(spec.namedChildren.find((c) => c?.type === 'configurable_uri'));
  if (!uri) return;

  const prefix = spec.namedChildren.find((c) => c?.type === 'identifier')?.text ?? '';
  scan.imports2.push({ uri, prefix, file });
  if (prefix) scan.imports.set(prefix, uri);
  // `show Engine` binds a name we can attribute a boundary call to; `hide` binds
  // nothing. Recorded here only so boundary ids can name the real library.
  for (const combinator of namedOfType(spec, 'combinator')) {
    if (combinator.children[0]?.text !== 'show') continue;
    for (const name of namedOfType(combinator, 'identifier')) {
      if (!scan.imports.has(name.text)) scan.imports.set(name.text, uri);
    }
  }
}

/** Annotation names on a declaration — Dart's decorators. */
function annotationName(node: Node): string {
  return fieldText(node, 'name');
}

/** Declaration text up to `stop`, collapsed to one line. */
function headerOf(node: Node, stop: Node | null): string {
  const to = stop ? stop.startIndex : node.endIndex;
  const text = node.text.slice(0, Math.max(0, to - node.startIndex));
  return truncate(text.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim(), 200);
}

/** Every `formal_parameter` under a parameter list, optional groups included. */
function formalParameters(list: Node | null): Node[] {
  if (!list) return [];
  const found: Node[] = [];
  walk(list, (node) => {
    if (node.type !== 'formal_parameter') return undefined;
    found.push(node);
    // A parameter's own default value cannot contain another parameter.
    return false;
  });
  return found;
}

/** Name and declared type of one `formal_parameter`. */
function parameterOf(param: Node): { name: string; type: string; fieldInit: string } {
  const ctorParam = param.namedChildren.find((c) => c?.type === 'constructor_param');
  if (ctorParam) {
    // `this.power` — a field-initialising formal: the type IS the field's.
    const name = ctorParam.namedChildren.find((c) => c?.type === 'identifier')?.text ?? '';
    return { name, type: '', fieldInit: name };
  }
  const superParam = param.namedChildren.find((c) => c?.type === 'super_formal_parameter');
  if (superParam) {
    return {
      name: superParam.namedChildren.find((c) => c?.type === 'identifier')?.text ?? '',
      type: '',
      fieldInit: '',
    };
  }
  return { name: fieldText(param, 'name'), type: leadingTypeName(param), fieldInit: '' };
}

/**
 * Types and names of everything declared inside a body. Closures are descended
 * into (their calls belong to the enclosing member, so their bindings must
 * shadow fields there too); a local function declaration is skipped because it
 * becomes a node of its own.
 */
function collectLocals(body: Node, types: Map<string, string>, names: Set<string>): void {
  walk(body, (node) => {
    if (node.type === 'local_function_declaration') return false;
    if (node.type === 'initialized_variable_definition') {
      const name = fieldText(node, 'name');
      if (!name) return undefined;
      names.add(name);
      const type = leadingTypeName(node) || inferredCtorType(node.childrenForFieldName('value'));
      if (type) types.set(name, type);
      return undefined;
    }
    if (node.type === 'for_loop_parts') {
      const name = fieldText(node, 'name');
      if (name) {
        names.add(name);
        const type = leadingTypeName(node);
        if (type) types.set(name, type);
      }
      return undefined;
    }
    if (node.type === 'catch_parameters') {
      for (const id of namedOfType(node, 'identifier')) names.add(id.text);
      return false;
    }
    if (node.type === 'formal_parameter') {
      const { name, type } = parameterOf(node);
      if (name) names.add(name);
      if (name && type) types.set(name, type);
      return false;
    }
    return undefined;
  });
}

/** `this.<name>` when `node` heads that shape, else ''. */
function selfFieldAfter(node: Node): string {
  if (node.type !== 'this') return '';
  const next = node.nextSibling;
  const step = next ? stepOf(next) : undefined;
  return step?.kind === 'name' ? step.name : '';
}

/** True when the step chain immediately after `node` starts with `(args)`. */
function isCallHead(node: Node): boolean {
  const next = node.nextSibling;
  return next ? stepOf(next)?.kind === 'args' : false;
}

/**
 * The single self-attribute an assignment writes, or '' when the target is
 * something deeper (`this.engine.label = x` writes Engine's state, not ours).
 */
function assignmentTarget(left: Node, fields: ReadonlySet<string>, shadowed: ReadonlySet<string>): string {
  if (left.type !== 'assignable_expression') return '';
  const parts = left.namedChildren.filter((c): c is Node => c !== null);
  const head = parts[0];
  if (!head) return '';
  if (head.type === 'this' && parts.length === 2) {
    const step = parts[1] ? stepOf(parts[1]) : undefined;
    return step?.kind === 'name' ? step.name : '';
  }
  if (head.type === 'identifier' && parts.length === 1) {
    return fields.has(head.text) && !shadowed.has(head.text) ? head.text : '';
  }
  return '';
}

/**
 * `this.x` reads and writes, plus bare `x` where `x` is a field of the enclosing
 * type and nothing in scope shadows it — omitting `this.` is idiomatic Dart, and
 * register inference would miss most real state without it.
 *
 * Descent is explicit (and iterative, so tree depth cannot overflow the stack)
 * because the interesting distinctions are positional: the `.name` of a selector
 * is a member of something else rather than our own state, `x()` is a call while
 * `x.m()` still reads `x`, and the left of `=` is a write while the left of `+=`
 * is both.
 */
function trackSelfAttrs(
  body: Node,
  fields: ReadonlySet<string>,
  shadowed: ReadonlySet<string>,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const stack: Node[] = [body];
  const push = (node: Node | null | undefined): void => {
    if (node) stack.push(node);
  };

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      // A selector's name belongs to whatever precedes it, not to us; only its
      // arguments and index expressions are ordinary sub-expressions.
      case 'selector':
      case 'unconditional_assignable_selector':
      case 'conditional_assignable_selector':
      case 'cascade_section': {
        for (const child of node.namedChildren) {
          if (child && (child.type === 'argument_part' || child.type === 'index_selector')) push(child);
        }
        break;
      }
      case 'local_function_declaration':
      case 'annotation':
      case 'label':
        break;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const operator = node.childForFieldName('operator')?.text ?? '=';
        const target = left ? assignmentTarget(left, fields, shadowed) : '';
        if (target) {
          writes.add(target);
          if (operator !== '=') reads.add(target);
        } else {
          push(left);
        }
        for (const right of node.childrenForFieldName('right')) push(right);
        break;
      }
      case 'this': {
        const field = selfFieldAfter(node);
        // `this.m()` is a call, not a state read.
        const next = node.nextSibling;
        if (field && !(next && isCallHead(next))) reads.add(field);
        break;
      }
      // `Engine.idle() : rpm = 0` / `: this.engine = e` — an initializer-list
      // entry writes the named field; only its right-hand side is a read.
      case 'field_initializer': {
        const parts = node.namedChildren.filter((c): c is Node => c !== null);
        const offset = parts[0]?.type === 'this' ? 1 : 0;
        const target = parts[offset];
        if (target?.type === 'identifier' && fields.has(target.text)) writes.add(target.text);
        for (const part of parts.slice(offset + 1)) push(part);
        break;
      }
      case 'initialized_variable_definition':
      case 'initialized_identifier':
      case 'static_final_declaration': {
        // The declared name is not a read; its initializer is.
        const parts = node.namedChildren.filter((c): c is Node => c !== null);
        for (const part of parts.slice(1)) push(part);
        break;
      }
      case 'formal_parameter':
        break;
      case 'identifier': {
        if (fields.has(node.text) && !shadowed.has(node.text) && !isCallHead(node)) reads.add(node.text);
        break;
      }
      default: {
        for (const child of node.namedChildren) push(child);
      }
    }
  }
  // A `++`/`--` on a self attribute is both, and the walk above only saw a read.
  walk(body, (node) => {
    if (node.type !== 'postfix_expression' && node.type !== 'unary_expression') return undefined;
    const target = namedOfType(node, 'assignable_expression')[0];
    const name = target ? assignmentTarget(target, fields, shadowed) : '';
    if (name) {
      reads.add(name);
      writes.add(name);
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface RecordOptions {
  name: string;
  qualname: string;
  className: string | null;
  isMethod: boolean;
  /** Node spanning the declaration — drives line numbers and the signature. */
  defNode: Node;
  /** Node owning `formal_parameter_list`; differs from `defNode` for accessors. */
  sigNode: Node;
  body: Node | null;
  /** A constructor's `initializers` / `redirection` node, if any. */
  initializer?: Node | null;
  signature: string;
  decorators: string[];
  file: string;
  /** Enclosing scope for a local function — Dart closures capture it. */
  inherited?: FnContext;
}

/**
 * Record one callable. Bodiless declarations (abstract members, `external`,
 * redirecting constructors) still become nodes: they are legitimate call targets
 * and omitting them would leave edges pointing at ids that do not exist.
 */
function recordFunction(scan: ModuleScan, opts: RecordOptions): FnContext | undefined {
  const { name, qualname, className, defNode, sigNode, body, file } = opts;
  const initializer = opts.initializer ?? null;
  const id = `${scan.moduleId}.${qualname}`;
  const paramList =
    sigNode.childForFieldName('parameters') ?? namedOfType(sigNode, 'formal_parameter_list')[0];
  const params = new Map<string, string>();
  const declaredNames = new Set(opts.inherited?.declaredNames ?? []);
  const scopeTypes = new Map(opts.inherited?.scopeTypes ?? []);
  const fieldInits: string[] = [];

  for (const param of formalParameters(paramList ?? null)) {
    const { name: pname, type, fieldInit } = parameterOf(param);
    if (!pname) continue;
    declaredNames.add(pname);
    if (fieldInit) fieldInits.push(fieldInit);
    const known = type || (className ? (scan.fieldTypes.get(`${className}.${pname}`) ?? '') : '');
    if (known) {
      params.set(pname, known);
      scopeTypes.set(pname, known);
    }
  }
  if (body) collectLocals(body, scopeTypes, declaredNames);

  const fields = className ? (scan.ownerFields.get(className) ?? new Set<string>()) : new Set<string>();
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const region of [body, initializer]) {
    if (!region) continue;
    const tracked = trackSelfAttrs(region, fields, declaredNames);
    for (const attr of tracked.reads) reads.add(attr);
    for (const attr of tracked.writes) writes.add(attr);
  }
  // `Engine(this.power)` writes `power` without any statement doing so.
  for (const field of fieldInits) if (fields.has(field)) writes.add(field);

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(defNode),
    lineEnd: lineEnd(body ?? defNode),
    signature: opts.signature,
    isAsync: body ? body.children.some((c) => c?.text === 'async' || c?.text === 'async*') : false,
    isMethod: opts.isMethod,
    className,
    decorators: opts.decorators,
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: [...reads].sort(),
    selfAttrsWritten: [...writes].sort(),
    paramTypes: Object.fromEntries(params),
  });
  if (!body && !initializer) return undefined;
  const context: FnContext = {
    body,
    initializer,
    className,
    scopeTypes,
    declaredNames,
    localFns: new Map(),
  };
  scan.fnContext.set(id, context);
  return context;
}

/**
 * Record a callable and, transitively, the local functions declared inside it.
 * A local function becomes its own node (`Class.method.local`) so that calls to
 * it resolve to something real instead of collapsing into the enclosing member.
 */
function recordCallableTree(scan: ModuleScan, root: RecordOptions): void {
  const queue: RecordOptions[] = [root];
  while (queue.length > 0) {
    const opts = queue.pop();
    if (!opts) continue;
    const context = recordFunction(scan, opts);
    if (!context?.body) continue;
    const enclosing = context.body;
    walk(enclosing, (node) => {
      if (node.type !== 'local_function_declaration') return undefined;
      const lambda = firstNamed(node);
      const sig = lambda?.childForFieldName('parameters');
      const name = sig ? fieldText(sig, 'name') : '';
      if (!lambda || !sig || !name) return false;
      const qualname = `${opts.qualname}.${name}`;
      context.localFns.set(name, `${scan.moduleId}.${qualname}`);
      const body = lambda.childForFieldName('body');
      queue.push({
        name,
        qualname,
        className: opts.className,
        isMethod: false,
        defNode: node,
        sigNode: sig,
        body,
        signature: headerOf(node, body),
        decorators: [],
        file: opts.file,
        inherited: context,
      });
      return false;
    });
  }
}

/** The member name a signature declares, plus whether it is a constructor. */
function memberNameOf(sig: Node): { name: string; isCtor: boolean } | undefined {
  if (CTOR_SIGNATURES.has(sig.type)) {
    // `Engine(…)` → [Engine]; `Engine.named(…)` → [Engine, named].
    const names = namedOfType(sig, 'identifier').map((n) => n.text);
    const owner = names[0];
    if (!owner) return undefined;
    return { name: names[1] ?? owner, isCtor: true };
  }
  if (sig.type === 'operator_signature') {
    const token = sig.namedChildren.find((c) => c?.type === 'binary_operator');
    const bracket = sig.children.find((c) => c !== null && !c.isNamed && c.text.startsWith('['));
    const symbol = token?.text ?? bracket?.text ?? '';
    return symbol ? { name: `operator${symbol}`, isCtor: false } : undefined;
  }
  const name = fieldText(sig, 'name');
  if (!name) return undefined;
  // A setter's real Dart name is `x=`, which keeps it off the getter's id.
  return { name: sig.type === 'setter_signature' ? `${name}=` : name, isCtor: false };
}

function noteField(scan: ModuleScan, owner: string, field: string, type: string): void {
  scan.ownerFields.get(owner)?.add(field);
  if (type && !scan.fieldTypes.has(`${owner}.${field}`)) scan.fieldTypes.set(`${owner}.${field}`, type);
}

/** Fields declared by one `declaration` node inside a class body. */
function scanFieldDeclaration(scan: ModuleScan, owner: string, decl: Node): void {
  const declared = leadingTypeName(decl);
  for (const list of decl.namedChildren) {
    if (list?.type !== 'initialized_identifier_list' && list?.type !== 'static_final_declaration_list') {
      continue;
    }
    for (const entry of list.namedChildren) {
      if (!entry) continue;
      const parts = entry.namedChildren.filter((c): c is Node => c !== null);
      const nameNode = parts[0];
      if (nameNode?.type !== 'identifier') continue;
      noteField(scan, owner, nameNode.text, declared || inferredCtorType(parts.slice(1)));
    }
  }
}

/** Ancestors named by `extends` / `with` / `implements` / a mixin's `on`. */
function collectBases(scan: ModuleScan, owner: string, node: Node): void {
  const names: string[] = [];
  const addFrom = (container: Node): void => {
    for (const type of namedOfType(container, 'type_identifier')) names.push(type.text);
  };
  for (const child of node.namedChildren) {
    if (!child) continue;
    // `superclass` holds BOTH `extends X` and the `with M1, M2` mixin list.
    if (child.type === 'superclass' || child.type === 'interfaces' || child.type === 'mixins') {
      addFrom(child);
      for (const nested of namedOfType(child, 'mixins')) addFrom(nested);
    } else if (child.type === 'mixin_application') {
      addFrom(child);
    } else if (
      child.type === 'type_identifier' &&
      (node.type === 'mixin_declaration' || node.type === 'extension_declaration')
    ) {
      // A mixin's `on Base` constraint and an extension's `on Engine` target both
      // put that type's members in scope for an unqualified call in the body.
      names.push(child.text);
    }
  }
  if (names.length === 0) return;
  let bases = scan.bases.get(owner);
  if (!bases) {
    bases = [];
    scan.bases.set(owner, bases);
  }
  for (const name of names) if (!bases.includes(name) && name !== owner) bases.push(name);
}

/**
 * Members of one container body. Dart makes a signature and its body SIBLINGS,
 * so members are paired positionally rather than by descending into a node.
 */
function scanMembers(scan: ModuleScan, body: Node, owner: string | null, file: string): void {
  const children = body.namedChildren;
  let decorators: string[] = [];

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child) continue;
    if (child.type === 'annotation') {
      const name = annotationName(child);
      if (name) decorators.push(name);
      continue;
    }
    // `declaration` wraps a bodiless member (abstract, external, redirecting)
    // AND every field declaration; `method_signature` precedes a real body.
    const sig =
      child.type === 'method_signature' || child.type === 'declaration'
        ? (child.namedChildren.find((c) => c && SIGNATURES.has(c.type)) ?? null)
        : SIGNATURES.has(child.type)
          ? child
          : null;

    if (!sig) {
      if (child.type === 'declaration' && owner) scanFieldDeclaration(scan, owner, child);
      decorators = [];
      continue;
    }
    const next = children[i + 1];
    const fnBody = next?.type === 'function_body' ? next : null;
    const initializer =
      child.namedChildren.find((c) => c?.type === 'initializers' || c?.type === 'redirection') ?? null;
    const member = memberNameOf(sig);
    if (!member) {
      decorators = [];
      continue;
    }
    const qualname = owner ? `${owner}.${member.name}` : member.name;
    if (owner) {
      scan.ownerMethods.get(owner)?.add(member.name);
      if (member.isCtor) scan.constructors.add(`${owner}.${member.name}`);
    } else {
      scan.freeFunctions.add(member.name);
    }
    recordCallableTree(scan, {
      name: member.name,
      qualname,
      className: owner,
      isMethod: owner !== null,
      defNode: child,
      sigNode: sig,
      body: fnBody,
      initializer,
      signature: headerOf(child, fnBody),
      decorators,
      file,
    });
    decorators = [];
  }
}

/** The declared name of a type node; `mixin_declaration` carries no `name` field. */
function typeNameOf(node: Node): string {
  const named = fieldText(node, 'name');
  if (named) return named;
  // A `typedef` names itself with a `type_identifier`, and in the old
  // `typedef void Cb(int x)` form the return type comes FIRST — so it is the first
  // `type_identifier` that is the name, never simply the first named child.
  if (node.type === 'type_alias') {
    return node.namedChildren.find((c) => c?.type === 'type_identifier')?.text ?? '';
  }
  const application = node.namedChildren.find((c) => c?.type === 'mixin_application_class');
  const source = application ?? node;
  return source.namedChildren.find((c) => c?.type === 'identifier')?.text ?? '';
}

/**
 * Emit the {@link TypeNode} for one declaration. Separate from
 * `scanTypeDeclaration` because the two sets differ in both directions: a
 * `typedef` and an `extension type` declare a type but no member this adapter
 * scans, and an `extension` is the reverse — real members, no type of its own.
 */
function recordTypeDeclaration(scan: ModuleScan, node: Node, file: string): void {
  const kind = DART_TYPE_KINDS.get(node.type);
  if (!kind) return;
  recordType(scan, {
    name: typeNameOf(node),
    kind,
    // A `mixin` has no `body` FIELD, only a `class_body` child, so the signature
    // would otherwise swallow every member. A `typedef` has no body at all, which
    // is right: `typedef Compare<T> = int Function(T, T)` is all header.
    body: node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'class_body') ?? null,
    node,
    file,
    // Dart has no nested type declarations — a class body holds members only.
    container: null,
  });
}

function scanTypeDeclaration(scan: ModuleScan, node: Node, file: string): void {
  const owner = typeNameOf(node);
  if (!owner) return;
  recordTypeDeclaration(scan, node, file);
  if (!scan.ownerMethods.has(owner)) scan.ownerMethods.set(owner, new Set());
  if (!scan.ownerFields.has(owner)) scan.ownerFields.set(owner, new Set());
  collectBases(scan, owner, node);

  if (node.type === 'extension_declaration') {
    const target = leadingTypeName(node) || fieldText(node, 'class');
    if (target) scan.extensionTargets.set(owner, target);
  }
  const body =
    node.childForFieldName('body') ??
    node.namedChildren.find((c) => c?.type === 'class_body' || c?.type === 'extension_body') ??
    null;
  if (!body) return;
  // State first: a method body may read a field declared below it.
  for (const child of body.namedChildren) {
    if (child?.type === 'declaration') scanFieldDeclaration(scan, owner, child);
  }
  scanMembers(scan, body, owner, file);
}

/* ------------------------------------------------------------------ *
 * Cross-module indexes
 * ------------------------------------------------------------------ */

/**
 * A URI mapped onto a scanned module: relative against the importing file,
 * `package:<pkg>/<path>` tried as both `lib/<path>` and `<path>` (no pubspec is
 * read, so the package's own name is not known — but its layout is conventional).
 */
function resolveUriModule(importer: string, uri: string, moduleIds: ReadonlySet<string>): string | undefined {
  if (uri.startsWith('dart:')) return undefined;
  const candidates: string[] = [];
  if (uri.startsWith('package:')) {
    const slash = uri.indexOf('/');
    if (slash < 0) return undefined;
    const rest = uri.slice(slash + 1);
    candidates.push(`lib/${rest}`, rest);
  } else {
    const stack = importer.split('/').slice(0, -1);
    let escaped = false;
    for (const part of uri.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (stack.length === 0) escaped = true;
        else stack.pop();
      } else {
        stack.push(part);
      }
    }
    if (escaped) return undefined;
    candidates.push(stack.join('/'));
  }
  for (const candidate of candidates) {
    const id = moduleIdForFile(candidate);
    if (id && moduleIds.has(id)) return id;
  }
  return undefined;
}

/** Connected components of the undirected `part` / `part of` graph. */
function libraryComponents(links: Map<string, Set<string>>): Map<string, string[]> {
  const component = new Map<string, string[]>();
  for (const start of links.keys()) {
    if (component.has(start)) continue;
    const group: string[] = [];
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) continue;
      group.push(current);
      for (const next of links.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const member of group) component.set(member, group);
  }
  return component;
}

/** `start` plus everything it re-exports, transitively; cycle-guarded. */
function exportClosure(start: string, exports: Map<string, string[]>): string[] {
  const seen = new Set<string>([start]);
  const queue = [start];
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    order.push(current);
    for (const next of exports.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * Pass 2 — resolution
 * ------------------------------------------------------------------ */

/** Ancestors of `type` in breadth-first order, each visited once. */
function ancestorsOf(type: string, own: DartIndexes): string[] {
  const seen = new Set<string>([type]);
  const queue = [...(own.bases.get(type) ?? [])];
  const order: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    order.push(next);
    queue.push(...(own.bases.get(next) ?? []));
  }
  return order;
}

/** `<declaring module>.<declaring owner>` for a member of `type` itself. */
function declaredBase(type: string, member: string, own: DartIndexes): string | undefined {
  return own.memberBases.get(`${type}.${member}`);
}

/** The nearest ancestor — superclass, mixin or interface — declaring `member`. */
function inheritedBase(type: string, member: string, own: DartIndexes): string | undefined {
  for (const ancestor of ancestorsOf(type, own)) {
    const base = declaredBase(ancestor, member, own);
    if (base) return base;
  }
  return undefined;
}

/** The module that declares `type`, own library first, then the whole scan set. */
function typeModule(
  type: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): string | undefined {
  for (const module of own.visible.get(scan.moduleId) ?? [scan.moduleId]) {
    if (std.typeMethods.has(`${module}.${type}`)) return module;
  }
  return std.typeToModule.get(type);
}

/** The module declaring free function `name`, searched in visibility order. */
function freeFunctionModule(
  name: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): string | undefined {
  for (const module of own.visible.get(scan.moduleId) ?? [scan.moduleId]) {
    if (std.moduleFunctions.get(module)?.has(name)) return module;
  }
  return undefined;
}

/**
 * A call qualified by a scanned type: `Engine.staticHelp()` or `Engine.named()`.
 * Per the SP2 IR decision a static call IS a call to an internal function, so no
 * `static_method` callType is invented; a constructor keeps `internal_constructor`.
 *
 * When the type is scanned but the member is not one we saw, the edge still
 * points into the type's home module — the target IS internal, and calling it a
 * boundary would be a lie.
 */
function resolveTypeMember(
  type: string,
  method: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved | undefined {
  const module = typeModule(type, scan, std, own);
  const base = declaredBase(type, method, own) ?? inheritedBase(type, method, own);
  if (!base && !module) return undefined;
  const target = base ?? `${module}.${type}`;
  return {
    calleeId: `${target}.${method}`,
    callType: own.constructors.has(`${type}.${method}`) ? 'internal_constructor' : 'internal_func',
  };
}

/** `Engine()` — the unnamed constructor of a scanned type. */
function resolveConstructor(
  type: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved | undefined {
  const module = typeModule(type, scan, std, own);
  if (!module) return undefined;
  return { calleeId: `${module}.${type}.${type}`, callType: 'internal_constructor' };
}

/** A method of the caller's own type, of a mixin it mixes in, or of an ancestor. */
function resolveSelfMethod(className: string, method: string, own: DartIndexes): Resolved | undefined {
  const base = declaredBase(className, method, own) ?? inheritedBase(className, method, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/** `super.m()` — skip the caller's own type and start at its ancestors. */
function resolveSuperMethod(className: string, method: string, own: DartIndexes): Resolved | undefined {
  const base = inheritedBase(className, method, own);
  return base ? { calleeId: `${base}.${method}`, callType: 'self_method' } : undefined;
}

/**
 * `: super(…)` in a constructor's initializer list. The nearest ancestor that
 * actually declares an unnamed constructor wins; failing that, the nearest
 * scanned ancestor, whose implicit default constructor the graph builder will
 * synthesize.
 */
function resolveSuperConstructor(
  className: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved | undefined {
  const ancestors = ancestorsOf(className, own);
  for (const ancestor of ancestors) {
    if (own.constructors.has(`${ancestor}.${ancestor}`)) {
      const base =
        declaredBase(ancestor, ancestor, own) ?? `${typeModule(ancestor, scan, std, own)}.${ancestor}`;
      return { calleeId: `${base}.${ancestor}`, callType: 'internal_constructor' };
    }
  }
  for (const ancestor of ancestors) {
    const hit = resolveConstructor(ancestor, scan, std, own);
    if (hit) return hit;
  }
  return undefined;
}

/** A call through a value whose type we learned; `undefined` = type unknown. */
function resolveThroughType(
  type: string,
  method: string,
  callType: 'self_attr_method' | 'param_method',
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved {
  const hit = resolveTypeMember(type, method, scan, std, own);
  if (!hit) return boundaryOf(type, method);
  // A constructor reached through an instance is still a constructor.
  return hit.callType === 'internal_constructor' ? hit : { calleeId: hit.calleeId, callType };
}

/** `this.field` / bare `field`, including a field inherited from an ancestor. */
function fieldTypeOf(className: string, field: string, own: DartIndexes): string | undefined {
  const direct = own.fieldTypes.get(`${className}.${field}`);
  if (direct) return direct;
  for (const ancestor of ancestorsOf(className, own)) {
    const inherited = own.fieldTypes.get(`${ancestor}.${field}`);
    if (inherited) return inherited;
  }
  return undefined;
}

/** The import whose prefix is `name`, if any. */
function prefixImport(name: string, scan: ModuleScan, own: DartIndexes): ResolvedImport | undefined {
  return (own.importsOf.get(scan.moduleId) ?? []).find((i) => i.prefix === name);
}

/** `p.thing()` where `p` is an import prefix. */
function resolveViaPrefix(
  imported: ResolvedImport,
  member: string,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved {
  if (imported.module) {
    for (const reachable of exportClosure(imported.module, own.exportsOf)) {
      for (const module of own.libraryOf.get(reachable) ?? [reachable]) {
        if (std.moduleFunctions.get(module)?.has(member)) {
          return { calleeId: `${module}.${member}`, callType: 'internal_func' };
        }
        // `p.Engine()` — the prefix qualifies a TYPE, so this is a construction.
        if (std.typeMethods.has(`${module}.${member}`)) {
          return { calleeId: `${module}.${member}.${member}`, callType: 'internal_constructor' };
        }
      }
    }
  }
  return boundaryOf(imported.uri, member, { isConstructor: /^[A-Z_$]/.test(member) });
}

/** A bare `name(...)`: a local function, an own method, a type, or a free function. */
function resolveBareCall(
  name: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved {
  const local = context.localFns.get(name);
  if (local) return { calleeId: local, callType: 'internal_func' };

  // A capitalized name that IS a scanned type is a construction, and it must be
  // tested before the self-method chain: `new` is optional in Dart, so inside
  // `Engine` (or anything extending it) the bare call `Engine()` would otherwise
  // match the constructor as if it were an inherited method.
  if (/^[A-Z_$]/.test(name)) {
    const ctor = resolveConstructor(name, scan, std, own);
    if (ctor) return ctor;
  }
  if (context.className && !context.declaredNames.has(name)) {
    const hit = resolveSelfMethod(context.className, name, own);
    if (hit) return hit;
  }
  const module = freeFunctionModule(name, scan, std, own);
  if (module) return { calleeId: `${module}.${name}`, callType: 'internal_func' };

  const uri = scan.imports.get(name);
  if (uri) return boundaryOf(uri, name, { isConstructor: /^[A-Z_$]/.test(name) });
  // A capitalized name that is nothing we scanned is a constructor from a
  // package we do not have — which is what a Flutter widget tree is made of.
  if (/^[A-Z_$]/.test(name)) return boundaryOf(name, undefined, { isConstructor: true });
  return unresolvedOf(`${name}()`);
}

/** `base.member.m()` — two names before the method. */
function resolveDotted(
  base: string,
  member: string,
  method: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved {
  // A. `prefix.Type.m()` — an aliased import.
  const imported = prefixImport(base, scan, own);
  if (imported) {
    if (imported.module) {
      const hit = resolveTypeMember(member, method, scan, std, own);
      if (hit) return hit;
    }
    return boundaryOf(imported.uri, `${member}.${method}`);
  }
  // B. `value.field.m()` — one hop through a learned type.
  const scoped = context.scopeTypes.get(base);
  const viaField =
    !scoped && context.className && !context.declaredNames.has(base)
      ? fieldTypeOf(context.className, base, own)
      : undefined;
  const rootType = scoped ?? viaField;
  if (rootType) {
    const memberType = own.fieldTypes.get(`${rootType}.${member}`);
    if (memberType) {
      return resolveThroughType(
        memberType,
        method,
        scoped ? 'param_method' : 'self_attr_method',
        scan,
        std,
        own,
      );
    }
    return boundaryOf(`${rootType}.${member}`, method);
  }
  // C. `Type.staticField.m()` and anything else two levels deep.
  if (/^[A-Z_$]/.test(base)) return boundaryOf(`${base}.${member}`, method);
  return unresolvedOf(`${base}.${member}.${method}`);
}

function resolveInvocation(
  receiver: Receiver,
  method: string,
  hint: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: DartIndexes,
): Resolved {
  const { className } = context;
  switch (receiver.kind) {
    case 'none':
      return resolveBareCall(method, scan, context, std, own);

    case 'this': {
      const hit = className ? resolveSelfMethod(className, method, own) : undefined;
      return hit ?? unresolvedOf(`this.${method}`);
    }

    case 'super': {
      const hit = className ? resolveSuperMethod(className, method, own) : undefined;
      return hit ?? unresolvedOf(`super.${method}`);
    }

    case 'field': {
      const type = className ? fieldTypeOf(className, receiver.field, own) : undefined;
      if (!type) return unresolvedOf(`this.${receiver.field}.${method}`);
      return resolveThroughType(type, method, 'self_attr_method', scan, std, own);
    }

    case 'type':
      return receiver.type
        ? resolveThroughType(receiver.type, method, 'param_method', scan, std, own)
        : unresolvedOf(hint);

    case 'dotted':
      return resolveDotted(receiver.base, receiver.member, method, scan, context, std, own);

    case 'name': {
      const name = receiver.name;
      // A. a parameter or local whose type we learned.
      const scoped = context.scopeTypes.get(name);
      if (scoped) return resolveThroughType(scoped, method, 'param_method', scan, std, own);
      // B. a field of the enclosing type, written without `this.`.
      if (className && !context.declaredNames.has(name)) {
        const type = fieldTypeOf(className, name, own);
        if (type) return resolveThroughType(type, method, 'self_attr_method', scan, std, own);
      }
      // C. a scanned type: `Engine.staticHelp()` / `Engine.named()`.
      const viaType = resolveTypeMember(name, method, scan, std, own);
      if (viaType) return viaType;
      // D. an import prefix.
      const imported = prefixImport(name, scan, own);
      if (imported) return resolveViaPrefix(imported, method, std, own);
      if (/^[A-Z_$]/.test(name)) return boundaryOf(name, method);
      return unresolvedOf(`${name}.${method}`);
    }

    default:
      // An opaque receiver — a call result, an index, a `dynamic`. The source
      // text is the only useful thing left to say about it.
      return unresolvedOf(hint);
  }
}

/**
 * `new Engine()`, `new Engine.named()`, or the `constructor_invocation` spelling
 * `Engine<T>.named()`. The latter is not necessarily a constructor — the same
 * node also covers a generic static call — so the member decides.
 */
function resolveNew(node: Node, scan: ModuleScan, std: StandardIndexes, own: DartIndexes): Resolved {
  const { type, ctor } = newExpressionType(node);
  if (!type) return unresolvedOf(truncate(node.text, 80));
  const hit = ctor ? resolveTypeMember(type, ctor, scan, std, own) : resolveConstructor(type, scan, std, own);
  if (hit) return hit;
  const uri = scan.imports.get(type);
  return boundaryOf(uri ?? type, ctor || undefined, { isConstructor: true });
}

/** The call at `argPart`: its receiver, its method name and its source text. */
interface CallSite {
  receiver: Receiver;
  method: string;
  raw: string;
  line: number;
  isAwait: boolean;
}

function callSiteOf(argPart: Node): CallSite | undefined {
  const holder = argPart.parent;
  if (!holder) return undefined;

  // `recv..m(args)` — the cascade carries its own method name.
  if (holder.type === 'cascade_section') {
    const step = stepOf(holder);
    if (!step || step.kind !== 'cascade' || !step.name) return undefined;
    const { head, steps } = chainBefore(holder);
    const receiver = receiverOf(
      head,
      steps.filter((s) => s.kind !== 'cascade'),
    );
    return {
      receiver,
      method: step.name,
      raw: truncate(`${head?.text ?? ''}..${step.name}`, 80),
      line: lineStart(holder),
      isAwait: false,
    };
  }
  if (holder.type !== 'selector') return undefined;

  const { head, steps } = chainBefore(holder);
  const last = steps.at(-1);
  const isAwait = holder.parent?.type === 'await_expression';
  const rawFrom = head ?? argPart;
  const raw = truncate(
    rawFrom.parent
      ? rawFrom.parent.text
          .slice(
            Math.max(0, rawFrom.startIndex - rawFrom.parent.startIndex),
            Math.max(0, argPart.startIndex - rawFrom.parent.startIndex),
          )
          .trim() || rawFrom.text
      : rawFrom.text,
    80,
  );
  const line = lineStart(rawFrom);

  if (last?.kind === 'name') {
    return {
      receiver: receiverOf(head, steps.slice(0, -1)),
      method: last.name,
      raw,
      line,
      isAwait,
    };
  }
  // No `.name` immediately before the arguments: either a bare `f(…)` (head is
  // the callee) or a call on a call, `f()()`, which has no nameable target.
  if (steps.filter((s) => s.kind !== 'noop').length === 0 && head?.type === 'identifier') {
    return { receiver: { kind: 'none' }, method: head.text, raw, line, isAwait };
  }
  return undefined;
}

/**
 * `: super(…)` / `: this.other(…)` in a constructor's initializer list. Both
 * spell their argument list as a bare `arguments` node rather than the
 * `argument_part` every other call site uses, so they need their own hook.
 */
function superOrRedirectTarget(
  node: Node,
  className: string | null,
  scan: ModuleScan,
  std: StandardIndexes,
  own: DartIndexes,
): { resolved: Resolved; raw: string } | undefined {
  if (!className) return undefined;
  const isSuperEntry = node.type === 'initializer_list_entry' && firstNamed(node)?.type === 'super';
  const isRedirect = node.type === 'redirection';
  if (!isSuperEntry && !isRedirect) return undefined;
  if (!node.namedChildren.some((c) => c?.type === 'arguments')) return undefined;

  if (isSuperEntry) {
    const resolved = resolveSuperConstructor(className, scan, std, own);
    return resolved ? { resolved, raw: 'super(...)' } : undefined;
  }
  // `: this(…)` redirects to the unnamed constructor, `: this.named(…)` to that one.
  const ctor = node.namedChildren.find((c) => c?.type === 'identifier')?.text ?? className;
  const resolved = resolveTypeMember(className, ctor, scan, std, own);
  return resolved ? { resolved, raw: `this.${ctor}(...)` } : undefined;
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
  typeKinds: declaredTypeKinds(DART_TYPE_KINDS),
};

const DART_SPEC: LanguageSpec<ModuleScan, DartIndexes> = {
  name: 'dart',
  extensions: ['.dart'],
  grammarFor: () => 'dart',
  extraSkipDirs: EXTRA_SKIP_DIRS,
  discoverFilter: (rel) => !GENERATED_SUFFIXES.some((suffix) => rel.endsWith(suffix)),
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
      constructors: new Set(),
      extensionTargets: new Map(),
      imports2: [],
      exportUris: [],
      libraryLinks: [],
    };
  },

  scan(scan, root, file) {
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (
        child.type === 'import_or_export' ||
        child.type === 'part_directive' ||
        child.type === 'part_of_directive'
      ) {
        collectDirective(child, scan, file);
      } else if (TYPE_DECLS.has(child.type)) {
        scanTypeDeclaration(scan, child, file);
      } else if (DART_TYPE_KINDS.has(child.type)) {
        // A `typedef` or an `extension type`: indexed as a type, but no member of
        // it is scanned, so it never enters call resolution.
        recordTypeDeclaration(scan, child, file);
      }
    }
    // Top-level functions, getters and setters are direct children of `program`,
    // paired with the `function_body` that follows them.
    scanMembers(scan, root, null, file);
    // Ids must be unique; on a duplicate keep the last, matching the pass-2
    // body lookup so its edges are not multiplied.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes(scans, std) {
    const bases = new Map<string, string[]>();
    const memberBases = new Map<string, string>();
    const constructors = new Set<string>();
    const fieldTypes = new Map<string, string>();
    const importsOf = new Map<string, ResolvedImport[]>();
    const exportsOf = new Map<string, string[]>();
    const links = new Map<string, Set<string>>();

    const link = (a: string, b: string): void => {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ]) {
        if (from === undefined || to === undefined) continue;
        let set = links.get(from);
        if (!set) {
          set = new Set<string>();
          links.set(from, set);
        }
        set.add(to);
      }
    };

    for (const scan of scans) {
      for (const [type, list] of scan.bases) {
        let all = bases.get(type);
        if (!all) {
          all = [];
          bases.set(type, all);
        }
        for (const base of list) if (!all.includes(base)) all.push(base);
      }
      for (const [owner, members] of scan.ownerMethods) {
        // An extension's members are keyed by the type it extends, so a call on
        // an instance of that type finds them — pointing at the extension.
        const target = scan.extensionTargets.get(owner) ?? owner;
        for (const member of members) {
          const key = `${target}.${member}`;
          if (!memberBases.has(key)) memberBases.set(key, `${scan.moduleId}.${owner}`);
        }
      }
      for (const ctor of scan.constructors) constructors.add(ctor);
      for (const [key, type] of scan.fieldTypes) if (!fieldTypes.has(key)) fieldTypes.set(key, type);

      const resolved = scan.imports2.map((imported) => ({
        uri: imported.uri,
        prefix: imported.prefix,
        module: resolveUriModule(imported.file, imported.uri, std.moduleIds),
      }));
      importsOf.set(scan.moduleId, [...(importsOf.get(scan.moduleId) ?? []), ...resolved]);

      const file = scan.files[0] ?? '';
      const exported = scan.exportUris
        .map((uri) => resolveUriModule(file, uri, std.moduleIds))
        .filter((m): m is string => m !== undefined);
      exportsOf.set(scan.moduleId, [...(exportsOf.get(scan.moduleId) ?? []), ...exported]);

      links.set(scan.moduleId, links.get(scan.moduleId) ?? new Set());
      for (const uri of scan.libraryLinks) {
        const other = resolveUriModule(file, uri, std.moduleIds);
        if (other) link(scan.moduleId, other);
      }
    }

    const libraryOf = libraryComponents(links);
    const visible = new Map<string, string[]>();
    for (const moduleId of std.moduleIds) {
      const seen = new Set<string>([moduleId]);
      const order = [moduleId];
      const add = (next: string): void => {
        if (seen.has(next)) return;
        seen.add(next);
        order.push(next);
      };
      const library = libraryOf.get(moduleId) ?? [moduleId];
      for (const peer of library) add(peer);
      // Own library first, then what it imports — a local name always wins.
      // Importing a library brings in its `part` files too: a part's top-level
      // names belong to the library's namespace, not to the part's own file.
      for (const peer of library) {
        for (const imported of importsOf.get(peer) ?? []) {
          if (imported.prefix || !imported.module) continue;
          for (const reachable of exportClosure(imported.module, exportsOf)) {
            for (const part of libraryOf.get(reachable) ?? [reachable]) add(part);
          }
        }
      }
      visible.set(moduleId, order);
    }

    return { bases, memberBases, constructors, fieldTypes, importsOf, exportsOf, libraryOf, visible };
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      const emit = (resolved: Resolved, line: number, raw: string, isAwait: boolean): void => {
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait,
          callType: resolved.callType,
          line,
          raw,
        });
      };

      for (const region of [context.body, context.initializer]) {
        if (!region) continue;
        walk(region, (node) => {
          // A local function is its own node with its own walk. Closures are NOT
          // skipped: they are pervasive in Dart, have no identity in this IR, and
          // their calls belong to the member that contains them.
          if (node.type === 'local_function_declaration') return false;
          if (CONSTRUCTION_NODES.has(node.type)) {
            const resolved = resolveNew(node, scan, std, own);
            emit(
              resolved,
              lineStart(node),
              truncate(node.text, 80),
              node.parent?.type === 'await_expression',
            );
            return undefined;
          }
          const generic = misparsedGenericCall(node);
          if (generic) {
            emit(
              resolveBareCall(generic, scan, context, std, own),
              lineStart(node),
              truncate(node.text, 80),
              node.parent?.type === 'await_expression',
            );
            return undefined;
          }
          // `: super(…)` and `: this.other(…)` use `arguments` directly rather
          // than the `argument_part` every other call site is built from.
          const redirect = superOrRedirectTarget(node, context.className, scan, std, own);
          if (redirect) {
            emit(redirect.resolved, lineStart(node), redirect.raw, false);
            return undefined;
          }
          if (node.type !== 'argument_part') return undefined;
          const site = callSiteOf(node);
          if (!site) return undefined;
          emit(
            resolveInvocation(site.receiver, site.method, site.raw, scan, context, std, own),
            site.line,
            site.raw,
            site.isAwait,
          );
          return undefined;
        });
      }
    }
    return edges;
  },
};

export class DartAdapter extends SpineAdapter<ModuleScan, DartIndexes> {
  constructor() {
    super(DART_SPEC);
  }
}
