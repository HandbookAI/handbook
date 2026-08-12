/**
 * Ruby adapter (tree-sitter grammar `ruby`).
 *
 * Ruby gives an analyzer almost nothing to stand on: no type annotations, no
 * declaration-before-use, and a method call that is spelled exactly like a local
 * variable read. So this adapter grounds itself on the three things Ruby *does*
 * state out loud — the lexical `module`/`class` nesting, the ancestor chain
 * (`<`, `include`, `extend`, `prepend`), and `X.new` — and refuses to guess
 * anywhere else. A receiver whose class nothing in the source names stays
 * `unresolved`; it is never promoted to a boundary just to look resolved.
 *
 * ## Scopes
 *
 * A Ruby type name is only unique inside its lexical scope: `Billing::Invoice`
 * and `Shipping::Invoice` are different classes and routinely share one file.
 * This is the fourth language to hit that (after Java packages, C# namespaces
 * and C++ namespaces), so it uses the spine's scope-aware index —
 * {@link StandardIndexes.scopedTypeToModule} read through `lookupScoped` with
 * Ruby's own constant lookup order (innermost lexical scope outward, then the
 * top level) — rather than building a fifth private one.
 *
 * The scope is a STACK of written spellings, not a `::`-split path, because
 * `class A::B` does not open `A` as a lookup scope: inside it, Ruby searches
 * `A::B` and then the top level, skipping `A`. Popping stack entries whole
 * reproduces that; splitting on `::` would not.
 *
 * ## Ids
 *
 * `id = <path-derived moduleId>.<qualname>` as everywhere else in this repo,
 * with `qualname = <Module::Nesting>.<Type>.<member>` and `::` flattened to `.`
 * — `Billing::Invoice#total` in `app/billing.rb` is
 * `app.billing.Billing.Invoice.total`. The nesting belongs in the qualname, not
 * in the module: same-named classes in two modules of ONE file would otherwise
 * collapse onto one id and silently delete a function. `.` rather than `::` so
 * that `graph.ts:synthesizeConstructor` can still read the last two segments as
 * `<Type>.<member>`.
 *
 * A class reopened in several files keeps one node per `def`, in the file that
 * wrote it; call sites are matched through a symbol table keyed by
 * scope + `Type#member`, so they land on the file that actually defines the
 * method rather than on the file that first named the class.
 *
 * ## Bare names
 *
 * `foo` with no receiver, no parentheses and no arguments parses as a plain
 * `identifier` — the grammar cannot tell a zero-arg method call from a local
 * variable read, and neither can Ruby without its binding table. This adapter
 * approximates that table (parameters, block parameters, assignment targets,
 * `rescue => e`, pattern bindings) and then emits an edge for a leftover bare
 * identifier ONLY when it resolves to a method or top-level function we scanned.
 * An unresolvable bare identifier is assumed to be a local we failed to track
 * and produces nothing — inventing an `unresolved` edge for every variable read
 * would drown the real ones. A call written with parentheses or arguments is
 * unambiguous and always produces an edge.
 *
 * ## `require` / `require_relative`
 *
 * Ruby constants are global once loaded, so a `require` is NOT what makes a
 * cross-file call resolvable — the scope-aware type index already is. What the
 * requires buy is DISAMBIGUATION: two files can define a top-level `def log`, or
 * reopen one class and define the same method twice, and the caller's own
 * module wins first, then anything it requires (transitively), then scan order.
 * `require_relative` is resolved against the requiring file; a plain `require`
 * against the source root and then by unique path suffix, which stands in for
 * the `$LOAD_PATH` this adapter cannot see. A require naming no scanned file is
 * a gem and is simply dropped — an unscanned CONSTANT is already evidence
 * enough to call something a boundary.
 *
 * ## What is NOT handled (stated, because a silent gap is a defect)
 *
 *   - **`define_method`, `class_eval`, `instance_eval`, `Struct.new do … end`,
 *     `Class.new do … end`**: methods created by running code are invisible.
 *     Nothing is recorded for them and calls to them stay `unresolved`.
 *   - **`method_missing` / `respond_to_missing?`**: a call dispatched through
 *     them cannot be attributed, so it stays `unresolved`. The `def
 *     method_missing` itself is an ordinary node.
 *   - **`send` / `public_send` / `__send__`**: deliberately NOT treated as
 *     calls to their symbol argument — the argument is frequently computed. They
 *     resolve as `unresolved`, which is what "we do not know" looks like here.
 *   - **Monkey-patching core classes**: reopening `class String` declares a
 *     scanned type named `String`, so `"x".upcase` still reports
 *     `boundary:String.upcase` (literal receivers are never matched against
 *     scanned types).
 *   - **Refinements** (`refine` / `using`): scope-limited method replacement is
 *     not modelled; calls resolve as if the refinement did not exist.
 *   - **`method_missing`-style DSLs, `def_delegators`, ActiveRecord attributes**
 *     and every other macro that mints methods at load time: not expanded.
 *   - **Return types**: a chained call (`a.b.c`) resolves only its first hop;
 *     there is no return-type inference, so `.c` is `unresolved`.
 *   - **Operator methods** (`def ==`, `def []`, `def <<`) get no node and their
 *     bodies contribute no edges: their names are punctuation, and ids travel
 *     through DOT and Markdown. Same trade the C++ adapter makes.
 *   - **`def obj.meth`** on a receiver other than `self` is skipped.
 *   - **A file the grammar cannot parse contributes nothing.** Unlike C++, real
 *     Ruby parses cleanly (measured on heredocs, `%w`/`%i`/`%r`, `=begin`
 *     blocks, `__END__`, refinements, RSpec DSL, multiline chains with
 *     interior comments, `rescue`/`ensure` inside blocks: zero ERROR nodes), and
 *     a genuinely broken file wraps its whole body in one ERROR. Mining that
 *     would only recover half-parsed junk, so ERROR subtrees are skipped —
 *     without affecting the file's neighbours.
 *   - Ruby has no `async`/`await`, so `isAsync`/`isAwait` are always false, and
 *     `decorators` is always empty.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart } from '../tsx-util.js';
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

const EXTENSIONS = ['.rb', '.rake', '.gemspec'] as const;

const EXTENSION_RE = /\.(rb|rake|gemspec)$/;

/** Bundler/Rails scratch. `vendor` and `coverage` are already common skips. */
const EXTRA_SKIP_DIRS = ['.bundle', 'tmp', 'log'];

/** A method name we are willing to put in an id — `save!`, `valid?`, `total=`. */
const METHOD_NAME_RE = /^[A-Za-z_]\w*[?!=]?$/;

/** Definition forms that open a new `self`; both passes stop at them. */
const DEFINITION_NODES: ReadonlySet<string> = new Set([
  'method',
  'singleton_method',
  'class',
  'module',
  'singleton_class',
]);

const ATTR_MACROS: ReadonlySet<string> = new Set(['attr_accessor', 'attr_reader', 'attr_writer']);

/** `include`/`prepend` extend the instance chain; `extend` the singleton chain. */
const MIXIN_MACROS: ReadonlySet<string> = new Set(['include', 'prepend', 'extend']);

/**
 * Visibility markers that can WRAP a definition (`private def x`). Their
 * argument list is descended into so the wrapped `def` is still recorded.
 */
const VISIBILITY_MACROS: ReadonlySet<string> = new Set([
  'private',
  'public',
  'protected',
  'module_function',
  'private_class_method',
  'public_class_method',
]);

/**
 * Kernel/Object methods a bare call can only mean if nothing scanned defines
 * that name. Hard-coded rather than inferred, because Ruby has no import that
 * would reveal them: every object gets them for free. Deliberately EXCLUDES the
 * metaprogramming entry points (`send`, `define_method`, `instance_eval`, …) —
 * those must surface as `unresolved`, since that is exactly the fact a reader
 * needs. Scanned methods are matched first, so a user-defined `puts` wins.
 */
const KERNEL_METHODS: ReadonlySet<string> = new Set([
  'abort',
  'at_exit',
  'binding',
  'block_given?',
  'caller',
  'catch',
  'clone',
  'dup',
  'exit',
  'exit!',
  'fail',
  'format',
  'freeze',
  'frozen?',
  'gets',
  'instance_variable_get',
  'instance_variable_set',
  'instance_variables',
  'lambda',
  'load',
  'loop',
  'p',
  'pp',
  'print',
  'printf',
  'proc',
  'puts',
  'raise',
  'rand',
  'require',
  'require_relative',
  'sleep',
  'sprintf',
  'srand',
  'throw',
  'warn',
]);

/** Literal receivers whose class is certain and always outside the scan set. */
const LITERAL_RECEIVERS: Readonly<Record<string, string>> = {
  array: 'Array',
  string: 'String',
  bare_string: 'String',
  string_array: 'Array',
  symbol_array: 'Array',
  heredoc_beginning: 'String',
  character: 'String',
  hash: 'Hash',
  integer: 'Integer',
  float: 'Float',
  rational: 'Rational',
  complex: 'Complex',
  simple_symbol: 'Symbol',
  delimited_symbol: 'Symbol',
  regex: 'Regexp',
  range: 'Range',
  true: 'TrueClass',
  false: 'FalseClass',
  nil: 'NilClass',
  lambda: 'Proc',
};

/** One type, located: the lexical scope declaring it and the module it lives in. */
interface TypeRef {
  /** Lexical scope path, `::`-joined; '' is the top level. */
  scope: string;
  name: string;
  module: string;
}

/** What one scan learned about one declared class or module. */
interface TypeInfo {
  scope: string;
  name: string;
  isModule: boolean;
  /**
   * The enclosing lexical scope chain (innermost first, '' last) as written at
   * the declaration — superclass and mixin names resolve in it, not inside the
   * body.
   */
  outerScopes: string[];
  superSpelling: string;
  includeSpellings: string[];
  prependSpellings: string[];
  extendSpellings: string[];
  instanceMethods: Set<string>;
  singletonMethods: Set<string>;
  /** alias name → the instance method it stands for. */
  aliases: Map<string, string>;
  /** instance variable name (no `@`) → written constant spelling. */
  ivarTypes: Map<string, string>;
}

/** {@link TypeInfo} merged across the files that reopen the same type. */
interface MergedType extends TypeInfo {
  module: string;
  superRef: TypeRef | undefined;
  includes: TypeRef[];
  prepends: TypeRef[];
  extended: TypeRef[];
  /** The scan that first declared it — its constant aliases resolve the names. */
  home: ModuleScan;
}

/** Where a member's node lives. */
interface SymbolDef {
  id: string;
  module: string;
}

/** A member found on an ancestor chain, with the name it is really stored under. */
interface MemberSite {
  ref: TypeRef;
  singleton: boolean;
  member: string;
}

/** One member this scan emitted a node for. */
interface DeclaredMember {
  scope: string;
  owner: string;
  member: string;
  singleton: boolean;
  id: string;
}

interface FnContext {
  body: Node;
  /** {@link scopedKey} of the owning type; '' for a top-level `def`. */
  ownerKey: string;
  singleton: boolean;
  /** Lexical constant-lookup order inside the body, innermost first, '' last. */
  scopes: string[];
  /** Every name bound as a local here — it is a variable read, not a call. */
  locals: Set<string>;
  /** local name → written constant spelling, learned from `x = Foo.new`. */
  localTypes: Map<string, string>;
}

/** One `require` / `require_relative`, with the directory it was written in. */
interface RequireRef {
  dir: string;
  path: string;
  relative: boolean;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: constant alias → the spelling it stands for (`Engine =
   * Motor::Engine`). `ownerMethods` and `fieldTypes` carry the BARE-name view
   * for spine compatibility; resolution uses the scope-aware tables instead.
   */
  fnContext: Map<string, FnContext>;
  /** {@link scopedKey}(scope, Name) → what this file declared about it. */
  types: Map<string, TypeInfo>;
  declared: DeclaredMember[];
  requires: RequireRef[];
  /** This module plus everything it requires, transitively. */
  visible: Set<string>;
}

interface RubyIndexes {
  /** {@link scopedKey}(scope, Name) → the type, merged across files. */
  types: Map<string, MergedType>;
  /** {@link scopedKey}(scope, `Type#m` | `Type.m`) → every node owning it. */
  members: Map<string, SymbolDef[]>;
  /** top-level `def` name → every node owning it. */
  free: Map<string, SymbolDef[]>;
}

export function moduleIdForFile(file: string): string {
  return file.replace(EXTENSION_RE, '').split('/').join('.');
}

/* ------------------------------------------------------------------ names */

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `A::B::C` / `::Top` from a constant or scope_resolution; '' if unnameable. */
function nameSpelling(node: Node | null): string {
  if (!node) return '';
  switch (node.type) {
    case 'constant':
    case 'identifier':
      return node.text;
    case 'scope_resolution': {
      const right = nameSpelling(node.childForFieldName('name'));
      if (!right) return '';
      const scope = node.childForFieldName('scope');
      // `::Top` has no scope child at all — the leading `::` IS the information.
      if (!scope) return `::${right}`;
      const left = nameSpelling(scope);
      return left ? `${left}::${right}` : right;
    }
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

/**
 * Ruby's constant lookup order for a body nested in `stack`: the whole nesting,
 * then each enclosing entry, then the top level. Entries are popped WHOLE — a
 * `class A::B` body does not see `A`, which is why the stack holds written
 * spellings rather than a `::`-split path.
 */
function scopeChainOf(stack: readonly string[]): string[] {
  const chain: string[] = [];
  for (let i = stack.length; i > 0; i -= 1) chain.push(stack.slice(0, i).join('::'));
  chain.push('');
  return chain;
}

/** `<nesting>.<Type>.<member>`, `::` flattened to `.`, empty segments dropped. */
function dottedQualname(scope: string, owner: string, member: string): string {
  return [...(scope ? scope.split('::') : []), owner, member].filter(Boolean).join('.');
}

/** The id a member gets when no node of its own was emitted for it. */
function fallbackMemberId(ref: TypeRef, member: string): string {
  return `${ref.module}.${dottedQualname(ref.scope, ref.name, member)}`;
}

/** The literal text a symbol or string argument carries (`:total` → `total`). */
function literalName(node: Node): string {
  if (node.type === 'simple_symbol') return node.text.slice(1);
  if (node.type === 'hash_key_symbol') return node.text;
  if (node.type === 'string' || node.type === 'delimited_symbol') {
    const content = node.namedChildren.find((c) => c?.type === 'string_content');
    return content ? content.text : '';
  }
  return '';
}

/** The name a `def` declares: `identifier`, or a `setter` spelled `total=`. */
function methodNameOf(nameNode: Node | null): string {
  if (!nameNode) return '';
  // `operator` (def ==, def []) is intentionally unnamed here — see the header.
  if (nameNode.type === 'setter') return `${fieldText(nameNode, 'name')}=`;
  if (nameNode.type === 'identifier' || nameNode.type === 'constant') return nameNode.text;
  return '';
}

/* ------------------------------------------------------------ pass 1: scan */

/** One position in the walk: what encloses the nodes about to be visited. */
interface Frame {
  node: Node;
  /** Lexical nesting, as written (`['Billing', 'Invoice']`). */
  stack: string[];
  /** {@link scopedKey} of the enclosing type; '' at the top level. */
  ownerKey: string;
  /** Inside `class << self`, or a `def self.x`. */
  singleton: boolean;
}

function addScopedType(scan: ModuleScan, scope: string, name: string): void {
  let names = scan.scopedTypes?.get(scope);
  if (!names) {
    names = new Set<string>();
    scan.scopedTypes?.set(scope, names);
  }
  names.add(name);
}

/** Every parameter name a `def`/block binds, destructuring included. */
function parameterNames(list: Node | null): string[] {
  if (!list) return [];
  const names: string[] = [];
  const pending: Node[] = list.namedChildren.filter((c): c is Node => c !== null);
  while (pending.length > 0) {
    const param = pending.shift();
    if (!param) continue;
    if (param.type === 'identifier') {
      names.push(param.text);
      continue;
    }
    if (param.type === 'destructured_parameter') {
      pending.unshift(...param.namedChildren.filter((c): c is Node => c !== null));
      continue;
    }
    // optional / keyword / splat / hash_splat / block parameters all carry `name`.
    const named = param.childForFieldName('name');
    if (named && named.type === 'identifier') names.push(named.text);
  }
  return names;
}

/** The class `x = Foo.new` / `x = a || Foo.new` constructs; '' when unlearnable. */
function constructedType(node: Node | null): string {
  if (!node) return '';
  if (node.type === 'call') {
    const method = node.childForFieldName('method');
    if (method?.text !== 'new') return '';
    const receiver = node.childForFieldName('receiver');
    if (!receiver || (receiver.type !== 'constant' && receiver.type !== 'scope_resolution')) return '';
    return nameSpelling(receiver);
  }
  // `@logger = logger || NullLogger.new` — the fallback is the only stated type.
  if (node.type === 'binary' && fieldText(node, 'operator') === '||') {
    return constructedType(node.childForFieldName('right'));
  }
  return '';
}

/** Walk a subtree, stopping at anything that opens a new `self`. */
function walkBody(root: Node, visit: (node: Node) => boolean | void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current !== root && DEFINITION_NODES.has(current.type)) continue;
    if (visit(current) === false) continue;
    const children = current.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
}

/** Every `identifier` under `node` — used to harvest binding forms. */
function harvestIdentifiers(node: Node, into: Set<string>): void {
  walkBody(node, (n) => {
    if (n.type === 'identifier') into.add(n.text);
  });
}

/**
 * The names bound as locals inside a body, plus the classes a few of them were
 * assigned. Over-collecting is the safe direction: a name wrongly believed to be
 * a local suppresses one bare-name edge, while a missed binding would invent
 * one.
 */
function collectLocals(body: Node, locals: Set<string>, types: Map<string, string>): void {
  walkBody(body, (node) => {
    switch (node.type) {
      case 'assignment':
      case 'operator_assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        // `obj.attr = 1` / `h[k] = v` bind nothing; their parts are expressions.
        if (left && left.type !== 'call' && left.type !== 'element_reference') {
          harvestIdentifiers(left, locals);
        }
        if (left?.type === 'identifier' && !types.has(left.text)) {
          const spelling = constructedType(right);
          if (spelling) types.set(left.text, spelling);
        }
        return undefined;
      }
      case 'block_parameters':
      case 'lambda_parameters':
      case 'method_parameters':
      case 'exception_variable':
      case 'hash_pattern':
      case 'array_pattern':
      case 'find_pattern':
      case 'as_pattern':
        harvestIdentifiers(node, locals);
        return false;
      case 'for': {
        const pattern = node.childForFieldName('pattern');
        if (pattern) harvestIdentifiers(pattern, locals);
        return undefined;
      }
      default:
        return undefined;
    }
  });
}

/** The instance variables a plain assignment target writes. */
function assignedIvars(left: Node): string[] {
  if (left.type === 'instance_variable') return [left.text.slice(1)];
  if (left.type !== 'left_assignment_list') return [];
  const hits: string[] = [];
  for (const child of left.namedChildren) {
    if (!child) continue;
    if (child.type === 'instance_variable') hits.push(child.text.slice(1));
    else if (child.type === 'rest_assignment') {
      const inner = child.namedChildren.find((c) => c?.type === 'instance_variable');
      if (inner) hits.push(inner.text.slice(1));
    }
  }
  return hits;
}

/**
 * `@ivar` reads and writes, blocks included — a `do … end` shares the enclosing
 * `self`, so state touched inside one is state the method touches. This is what
 * drives the handbook's state-register inference, so a plain `=` counts only as
 * a write while `+=` / `||=` count as both.
 */
function trackIvars(body: Node): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  /** Start offsets of ivar nodes already counted as a pure write. */
  const written = new Set<number>();
  walkBody(body, (node) => {
    if (node.type === 'assignment' || node.type === 'operator_assignment') {
      const compound = node.type === 'operator_assignment';
      const left = node.childForFieldName('left');
      if (left) {
        for (const name of assignedIvars(left)) {
          writes.add(name);
          if (compound) reads.add(name);
        }
        if (!compound) {
          if (left.type === 'instance_variable') written.add(left.startIndex);
          else if (left.type === 'left_assignment_list') {
            for (const child of left.namedChildren) {
              if (child?.type === 'instance_variable') written.add(child.startIndex);
            }
          }
        }
      }
      return undefined;
    }
    if (node.type === 'instance_variable') {
      if (!written.has(node.startIndex)) reads.add(node.text.slice(1));
      return false;
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

/** Learn `@x = Foo.new` — the one place Ruby states an attribute's class. */
function learnIvarTypes(body: Node, info: TypeInfo): void {
  walkBody(body, (node) => {
    if (node.type !== 'assignment' && node.type !== 'operator_assignment') return undefined;
    const left = node.childForFieldName('left');
    if (left?.type !== 'instance_variable') return undefined;
    const spelling = constructedType(node.childForFieldName('right'));
    const name = left.text.slice(1);
    if (spelling && !info.ivarTypes.has(name)) info.ivarTypes.set(name, spelling);
    return undefined;
  });
}

function emptyTypeInfo(scope: string, name: string, isModule: boolean, outerScopes: string[]): TypeInfo {
  return {
    scope,
    name,
    isModule,
    outerScopes,
    superSpelling: '',
    includeSpellings: [],
    prependSpellings: [],
    extendSpellings: [],
    instanceMethods: new Set(),
    singletonMethods: new Set(),
    aliases: new Map(),
    ivarTypes: new Map(),
  };
}

/** `class Foo` / `module Foo` / `class A::B` — declare it and return its body frame. */
function scanTypeDeclaration(scan: ModuleScan, node: Node, frame: Frame): Frame | undefined {
  const spelling = nameSpelling(node.childForFieldName('name'));
  if (!spelling) return undefined;
  const absolute = spelling.startsWith('::');
  const bare = absolute ? spelling.slice(2) : spelling;
  const name = tailOf(bare);
  if (!name) return undefined;
  const qualifier = qualifierOf(bare);
  const scope = absolute ? qualifier : joinScope(frame.stack.join('::'), qualifier);
  const key = scopedKey(scope, name);

  let info = scan.types.get(key);
  if (!info) {
    info = emptyTypeInfo(scope, name, node.type === 'module', absolute ? [''] : scopeChainOf(frame.stack));
    scan.types.set(key, info);
  }
  addScopedType(scan, scope, name);
  if (!scan.ownerMethods.has(name)) scan.ownerMethods.set(name, new Set());

  const superclass = node.childForFieldName('superclass');
  if (superclass && !info.superSpelling) {
    const written = nameSpelling(superclass.namedChildren.find((c) => c !== null) ?? null);
    if (written) info.superSpelling = written;
  }

  const body = node.childForFieldName('body');
  if (!body) return undefined;
  return {
    node: body,
    stack: absolute ? [bare] : [...frame.stack, bare],
    ownerKey: key,
    singleton: false,
  };
}

/** Emit one {@link FunctionNode} plus, when it has a body, its pass-2 context. */
function recordMethod(scan: ModuleScan, node: Node, frame: Frame, file: string, singleton: boolean): void {
  const name = methodNameOf(node.childForFieldName('name'));
  if (!name || !METHOD_NAME_RE.test(name)) return;
  const info = frame.ownerKey ? scan.types.get(frame.ownerKey) : undefined;
  const scope = info?.scope ?? '';
  const owner = info?.name ?? '';
  const qualname = dottedQualname(scope, owner, name);
  const id = `${scan.moduleId}.${qualname}`;

  if (info) {
    if (singleton) info.singletonMethods.add(name);
    else info.instanceMethods.add(name);
    scan.ownerMethods.get(info.name)?.add(name);
  } else if (!singleton) {
    scan.freeFunctions.add(name);
  }
  scan.declared.push({ scope, owner, member: name, singleton, id });

  const body = node.childForFieldName('body');
  const params = node.childForFieldName('parameters');
  const { reads, writes } = body ? trackIvars(body) : { reads: [], writes: [] };
  if (info && body) learnIvarTypes(body, info);

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(
      `def ${singleton && info ? 'self.' : ''}${name}${params ? collapse(params.text) : ''}`,
      200,
    ),
    isAsync: false,
    isMethod: info !== undefined && !singleton,
    className: info ? info.name : null,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: reads,
    selfAttrsWritten: writes,
    // Ruby has no parameter annotations; there is nothing honest to put here.
    paramTypes: {},
  });

  if (!body) return;
  const locals = new Set<string>(parameterNames(params));
  const localTypes = new Map<string, string>();
  collectLocals(body, locals, localTypes);
  scan.fnContext.set(id, {
    body,
    ownerKey: frame.ownerKey,
    singleton,
    scopes: scopeChainOf(frame.stack),
    locals,
    localTypes,
  });
}

/**
 * `attr_accessor :total` really does define methods, and a call to one is
 * indistinguishable from any other. They therefore get real nodes — sited on the
 * macro line, with the attribute they touch recorded as state, which is exactly
 * what register inference wants. Only ONE node per attribute name is emitted:
 * the writer `total=` is registered for resolution but shares the reader's node,
 * because two nodes per attribute would triple a Rails model's function count
 * for no reader benefit.
 *
 * Inside `class << self` the macro defines CLASS-level accessors, so the
 * enclosing frame decides which side of the type they land on.
 */
function recordAttrMacro(scan: ModuleScan, node: Node, frame: Frame, file: string, macro: string): void {
  const info = frame.ownerKey ? scan.types.get(frame.ownerKey) : undefined;
  if (!info) return;
  const reader = macro !== 'attr_writer';
  const writer = macro !== 'attr_reader';
  const target = frame.singleton ? info.singletonMethods : info.instanceMethods;
  const args = node.childForFieldName('arguments');
  for (const arg of args?.namedChildren ?? []) {
    if (!arg) continue;
    const attr = literalName(arg);
    if (!attr || !METHOD_NAME_RE.test(attr)) continue;
    if (reader) target.add(attr);
    if (writer) target.add(`${attr}=`);
    scan.ownerMethods.get(info.name)?.add(attr);

    const qualname = dottedQualname(info.scope, info.name, attr);
    const id = `${scan.moduleId}.${qualname}`;
    scan.declared.push({
      scope: info.scope,
      owner: info.name,
      member: attr,
      singleton: frame.singleton,
      id,
    });
    scan.functions.push({
      id,
      name: attr,
      qualname,
      file,
      lineStart: lineStart(node),
      lineEnd: lineEnd(node),
      signature: truncate(`${macro} :${attr}`, 200),
      isAsync: false,
      isMethod: !frame.singleton,
      className: info.name,
      decorators: [],
      kind: 'internal',
      synthetic: false,
      selfAttrsRead: reader ? [attr] : [],
      selfAttrsWritten: writer ? [attr] : [],
      paramTypes: {},
    });
  }
}

function recordMixin(scan: ModuleScan, node: Node, frame: Frame, macro: string): void {
  const info = frame.ownerKey ? scan.types.get(frame.ownerKey) : undefined;
  if (!info) return;
  // `class << self; include M; end` is `extend M` written the long way round.
  const singleton = macro === 'extend' || frame.singleton;
  const target = singleton
    ? info.extendSpellings
    : macro === 'prepend'
      ? info.prependSpellings
      : info.includeSpellings;
  for (const arg of node.childForFieldName('arguments')?.namedChildren ?? []) {
    const spelling = arg ? nameSpelling(arg) : '';
    if (spelling && !target.includes(spelling)) target.push(spelling);
  }
}

function recordRequire(scan: ModuleScan, node: Node, file: string, relative: boolean): void {
  const arg = node.childForFieldName('arguments')?.namedChildren.find((c) => c !== null);
  const path = arg ? literalName(arg) : '';
  if (path) scan.requires.push({ dir: dirOf(file), path, relative });
}

/** `alias new old` and `alias_method :new, :old` — one hop, no node of its own. */
function recordAlias(scan: ModuleScan, frame: Frame, aliasName: string, target: string): void {
  const info = frame.ownerKey ? scan.types.get(frame.ownerKey) : undefined;
  if (!info || !aliasName || !target) return;
  info.aliases.set(aliasName, target);
  info.instanceMethods.add(aliasName);
}

/** A constant assigned another constant is an alias: `Engine = Motor::Engine`. */
function recordConstantAssignment(scan: ModuleScan, node: Node): void {
  const left = node.childForFieldName('left');
  if (left?.type !== 'constant') return;
  const right = node.childForFieldName('right');
  if (!right || (right.type !== 'constant' && right.type !== 'scope_resolution')) return;
  const spelling = nameSpelling(right);
  if (spelling && spelling !== left.text) scan.imports.set(left.text, spelling);
}

/**
 * Dispatch a `call` seen at definition level. Ruby writes its declarations as
 * ordinary method calls, so `include`, `attr_reader`, `require` and `private def`
 * are all `call` nodes and there is no other place to catch them.
 */
function scanDefinitionCall(scan: ModuleScan, node: Node, frame: Frame, file: string, nested: Frame[]): void {
  const method = node.childForFieldName('method');
  if (method?.type !== 'identifier' || node.childForFieldName('receiver')) return;
  const name = method.text;

  if (name === 'require' || name === 'require_relative') {
    recordRequire(scan, node, file, name === 'require_relative');
    return;
  }
  if (ATTR_MACROS.has(name)) {
    recordAttrMacro(scan, node, frame, file, name);
    return;
  }
  if (MIXIN_MACROS.has(name)) {
    recordMixin(scan, node, frame, name);
    return;
  }
  if (name === 'alias_method') {
    const args = node.childForFieldName('arguments')?.namedChildren.filter((c): c is Node => c !== null);
    recordAlias(scan, frame, literalName(args?.[0] ?? node), literalName(args?.[1] ?? node));
    return;
  }
  if (VISIBILITY_MACROS.has(name)) {
    // `private def x` wraps the definition in the macro's argument list.
    const args = node.childForFieldName('arguments');
    if (args) nested.push({ ...frame, node: args });
  }
  // Every other call at definition level (`Struct.new do … end`, `class_eval`,
  // a DSL) is left alone: descending into its block would record methods that
  // only exist at runtime under whatever owner happened to enclose the macro.
}

function scanRoot(scan: ModuleScan, root: Node, file: string): void {
  const stack: Frame[] = [{ node: root, stack: [], ownerKey: '', singleton: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) continue;
    const nested: Frame[] = [];
    for (const child of frame.node.namedChildren) {
      if (!child) continue;
      switch (child.type) {
        case 'class':
        case 'module': {
          const inner = scanTypeDeclaration(scan, child, frame);
          if (inner) nested.push(inner);
          break;
        }
        case 'singleton_class': {
          // `class << self` — the same type, but its class-level side.
          const body = child.childForFieldName('body');
          if (body && child.childForFieldName('value')?.type === 'self') {
            nested.push({ ...frame, node: body, singleton: true });
          }
          break;
        }
        case 'method':
          recordMethod(scan, child, frame, file, frame.singleton);
          break;
        case 'singleton_method':
          // `def self.x`; `def obj.x` on anything else is out of scope.
          if (child.childForFieldName('object')?.type === 'self') {
            recordMethod(scan, child, frame, file, true);
          }
          break;
        case 'call':
          scanDefinitionCall(scan, child, frame, file, nested);
          break;
        case 'assignment':
          recordConstantAssignment(scan, child);
          break;
        case 'alias':
          recordAlias(scan, frame, fieldText(child, 'name'), fieldText(child, 'alias'));
          break;
        case 'comment':
        case 'string':
        case 'heredoc_body':
        case 'uninterpreted':
        // A file the grammar could not parse buries its body in one ERROR;
        // mining it would recover half-parsed junk, so it contributes nothing.
        case 'ERROR':
          break;
        default:
          if (child.namedChildCount > 0) nested.push({ ...frame, node: child });
      }
    }
    for (let i = nested.length - 1; i >= 0; i -= 1) {
      const inner = nested[i];
      if (inner) stack.push(inner);
    }
  }
}

/* ------------------------------------------------------- pass 1b: indexes */

/** `app/foo` + `../lib/bar.rb` → `lib/bar.rb`. */
function normalizePath(dir: string, path: string): string {
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
 * The module a `require` names. `require_relative` is resolved against the
 * requiring file; a plain `require` is resolved against the source root and then
 * by unique path suffix, which is how `require 'billing/invoice'` finds
 * `lib/billing/invoice.rb` without knowing the project's `$LOAD_PATH`. Anything
 * else is a gem.
 */
function resolveRequire(
  ref: RequireRef,
  byPath: ReadonlyMap<string, string>,
  byBasename: ReadonlyMap<string, string[]>,
): string | undefined {
  const path = ref.path.endsWith('.rb') ? ref.path : `${ref.path}.rb`;
  if (ref.relative) return byPath.get(normalizePath(ref.dir, path));
  const fromRoot = byPath.get(normalizePath('.', path));
  if (fromRoot) return fromRoot;
  const wanted = `/${path}`;
  const matches = (byBasename.get(path.split('/').pop() ?? '') ?? []).filter(
    (file) => file === path || file.endsWith(wanted),
  );
  return matches.length === 1 ? byPath.get(matches[0] ?? '') : undefined;
}

/** Fill in each scan's transitive require closure. */
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
  for (const scan of scans) {
    let edges = direct.get(scan.moduleId);
    if (!edges) {
      edges = new Set<string>();
      direct.set(scan.moduleId, edges);
    }
    for (const ref of scan.requires) {
      const target = resolveRequire(ref, byPath, byBasename);
      if (target) edges.add(target);
    }
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
  }
}

/**
 * The type a written constant names, or undefined when it is outside the scan
 * set. This is the lookup the spine's BARE-name `typeToModule` cannot make:
 * `Invoice` inside `module Billing` is `Billing::Invoice`, never
 * `Shipping::Invoice`.
 */
function resolveTypeSpelling(
  spelling: string,
  scopes: readonly string[],
  scan: ModuleScan,
  std: StandardIndexes,
): TypeRef | undefined {
  if (!spelling) return undefined;
  let candidates = scopes;
  let bare = spelling;
  if (bare.startsWith('::')) {
    bare = bare.slice(2);
    candidates = [''];
  }
  let name = tailOf(bare);
  let qualifier = qualifierOf(bare);
  if (!qualifier) {
    // `Engine = Motor::Engine`. One hop, deliberately: a chain of aliases is
    // rare enough that following it would cost more than it explains.
    const aliased = scan.imports.get(name);
    if (aliased && aliased !== spelling) {
      const target = aliased.startsWith('::') ? aliased.slice(2) : aliased;
      if (aliased.startsWith('::')) candidates = [''];
      name = tailOf(target);
      qualifier = qualifierOf(target);
    }
  }
  if (!name) return undefined;
  const scoped = (function* () {
    for (const scope of candidates) yield joinScope(scope, qualifier);
  })();
  const hit = lookupScoped(std.scopedTypeToModule, scoped, name, std.ambiguousScopedTypes);
  return hit ? { scope: hit.scope, name, module: hit.value } : undefined;
}

function buildTypes(scans: readonly ModuleScan[], std: StandardIndexes): Map<string, MergedType> {
  const types = new Map<string, MergedType>();
  for (const scan of scans) {
    for (const [key, info] of scan.types) {
      let merged = types.get(key);
      if (!merged) {
        merged = {
          ...emptyTypeInfo(info.scope, info.name, info.isModule, info.outerScopes),
          module: std.scopedTypeToModule.get(key) ?? scan.moduleId,
          superRef: undefined,
          includes: [],
          prepends: [],
          extended: [],
          home: scan,
        };
        types.set(key, merged);
      }
      // A reopened class states its ancestry once; whichever file says it wins.
      if (!merged.superSpelling) merged.superSpelling = info.superSpelling;
      for (const list of ['includeSpellings', 'prependSpellings', 'extendSpellings'] as const) {
        for (const spelling of info[list]) {
          if (!merged[list].includes(spelling)) merged[list].push(spelling);
        }
      }
      for (const m of info.instanceMethods) merged.instanceMethods.add(m);
      for (const m of info.singletonMethods) merged.singletonMethods.add(m);
      for (const [from, to] of info.aliases) if (!merged.aliases.has(from)) merged.aliases.set(from, to);
      for (const [ivar, spelling] of info.ivarTypes) {
        if (!merged.ivarTypes.has(ivar)) merged.ivarTypes.set(ivar, spelling);
      }
    }
  }
  // Ancestry is resolved only once every type is in the table above.
  for (const merged of types.values()) {
    merged.superRef = resolveTypeSpelling(merged.superSpelling, merged.outerScopes, merged.home, std);
    for (const [spellings, refs] of [
      [merged.includeSpellings, merged.includes],
      [merged.prependSpellings, merged.prepends],
      [merged.extendSpellings, merged.extended],
    ] as const) {
      for (const spelling of spellings) {
        const ref = resolveTypeSpelling(spelling, merged.outerScopes, merged.home, std);
        if (ref) refs.push(ref);
      }
    }
  }
  return types;
}

/* ----------------------------------------------------------- ancestry */

function typeKey(ref: TypeRef): string {
  return scopedKey(ref.scope, ref.name);
}

/**
 * Ruby's instance-method lookup order: prepended modules, the type itself,
 * included modules (last `include` first), then the superclass — recursively,
 * with a cycle guard. Iterative because the chain is data-driven.
 */
function instanceAncestors(ref: TypeRef, own: RubyIndexes): TypeRef[] {
  const out: TypeRef[] = [];
  const seen = new Set<string>();
  const stack: Array<{ ref: TypeRef; emit: boolean }> = [{ ref, emit: false }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;
    if (item.emit) {
      out.push(item.ref);
      continue;
    }
    const key = typeKey(item.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const info = own.types.get(key);
    if (info?.superRef) stack.push({ ref: info.superRef, emit: false });
    for (const inc of info?.includes ?? []) stack.push({ ref: inc, emit: false });
    stack.push({ ref: item.ref, emit: true });
    for (let i = (info?.prepends.length ?? 0) - 1; i >= 0; i -= 1) {
      const pre = info?.prepends[i];
      if (pre) stack.push({ ref: pre, emit: false });
    }
  }
  return out;
}

/** The type and its superclasses — class methods are inherited down this chain. */
function classChain(ref: TypeRef, own: RubyIndexes): TypeRef[] {
  const out: TypeRef[] = [];
  const seen = new Set<string>();
  let current: TypeRef | undefined = ref;
  while (current && !seen.has(typeKey(current))) {
    seen.add(typeKey(current));
    out.push(current);
    current = own.types.get(typeKey(current))?.superRef;
  }
  return out;
}

/** Where an instance method is really declared, following aliases one hop. */
function instanceSite(
  ref: TypeRef,
  member: string,
  own: RubyIndexes,
  opts: { skipSelf?: boolean } = {},
): MemberSite | undefined {
  const chain = instanceAncestors(ref, own);
  const start = opts.skipSelf ? chain.findIndex((t) => typeKey(t) === typeKey(ref)) + 1 : 0;
  for (let i = Math.max(0, start); i < chain.length; i += 1) {
    const candidate = chain[i];
    if (!candidate) continue;
    const info = own.types.get(typeKey(candidate));
    if (!info) continue;
    if (info.instanceMethods.has(member)) return { ref: candidate, singleton: false, member };
    const target = info.aliases.get(member);
    if (target && info.instanceMethods.has(target)) {
      return { ref: candidate, singleton: false, member: target };
    }
  }
  return undefined;
}

/**
 * Where a class-level method is declared: the singleton methods of the type or
 * a superclass, or the INSTANCE methods of a module it `extend`s.
 */
function singletonSite(
  ref: TypeRef,
  member: string,
  own: RubyIndexes,
  opts: { skipSelf?: boolean } = {},
): MemberSite | undefined {
  const chain = classChain(ref, own);
  for (let i = opts.skipSelf ? 1 : 0; i < chain.length; i += 1) {
    const candidate = chain[i];
    if (!candidate) continue;
    const info = own.types.get(typeKey(candidate));
    if (!info) continue;
    if (info.singletonMethods.has(member)) return { ref: candidate, singleton: true, member };
    for (let j = info.extended.length - 1; j >= 0; j -= 1) {
      const module = info.extended[j];
      const hit = module ? instanceSite(module, member, own) : undefined;
      if (hit) return hit;
    }
  }
  return undefined;
}

function memberSite(
  ref: TypeRef,
  member: string,
  singleton: boolean,
  own: RubyIndexes,
  opts: { skipSelf?: boolean } = {},
): MemberSite | undefined {
  return singleton ? singletonSite(ref, member, own, opts) : instanceSite(ref, member, own, opts);
}

/**
 * Which of several definitions the caller reaches. A class reopened in three
 * files can define the same method more than once; the caller's own file wins,
 * then anything it `require`s, then scan order.
 */
function pickSymbol(defs: readonly SymbolDef[] | undefined, scan: ModuleScan): string | undefined {
  if (!defs || defs.length === 0) return undefined;
  return (
    defs.find((def) => def.module === scan.moduleId) ??
    defs.find((def) => scan.visible.has(def.module)) ??
    defs[0]
  )?.id;
}

function memberKey(site: MemberSite): string {
  return scopedKey(site.ref.scope, `${site.ref.name}${site.singleton ? '.' : '#'}${site.member}`);
}

/** The node id of a located member; an `attr_writer` shares its reader's node. */
function siteId(site: MemberSite, scan: ModuleScan, own: RubyIndexes): string {
  const direct = pickSymbol(own.members.get(memberKey(site)), scan);
  if (direct) return direct;
  if (site.member.endsWith('=')) {
    const reader = { ...site, member: site.member.slice(0, -1) };
    const viaReader = pickSymbol(own.members.get(memberKey(reader)), scan);
    if (viaReader) return viaReader;
  }
  // Declared (an alias, or a name we registered without a node) but with no node
  // of its own: still internal, so point into the type that declares it.
  return fallbackMemberId(site.ref, site.member);
}

/* ------------------------------------------------------- pass 2: resolve */

function ownerOf(context: FnContext, own: RubyIndexes): MergedType | undefined {
  return context.ownerKey ? own.types.get(context.ownerKey) : undefined;
}

/** A method on a type we scanned. An unknown member is NOT claimed as internal. */
function resolveOnType(
  ref: TypeRef | undefined,
  spelling: string,
  member: string,
  callType: Resolved['callType'],
  singleton: boolean,
  scan: ModuleScan,
  own: RubyIndexes,
): Resolved {
  if (!ref) return boundaryOf(spelling, member);
  const site = memberSite(ref, member, singleton, own);
  // Ruby mints methods at runtime, so "declared nowhere we can see" is a real
  // possibility, not a scanning miss. Pointing at an invented id would create a
  // phantom node; claiming a boundary would deny the type is ours.
  if (!site) return unresolvedOf(`${spelling}.${member}`);
  return { calleeId: siteId(site, scan, own), callType };
}

/** `Foo.new` on a scanned class. */
function resolveConstructor(ref: TypeRef, scan: ModuleScan, own: RubyIndexes): Resolved {
  const site = instanceSite(ref, 'initialize', own);
  // No explicit `initialize` anywhere on the chain: the id is still the right
  // one, and `graph.ts:synthesizeConstructor` exists to give it a node.
  return {
    calleeId: site ? siteId(site, scan, own) : fallbackMemberId(ref, 'initialize'),
    callType: 'internal_constructor',
  };
}

/** A method of the caller's own object (or its class, in a singleton method). */
function resolveSelf(
  member: string,
  scan: ModuleScan,
  context: FnContext,
  own: RubyIndexes,
  opts: { skipSelf?: boolean } = {},
): Resolved | undefined {
  const owner = ownerOf(context, own);
  if (!owner) return undefined;
  const site = memberSite(owner, member, context.singleton, own, opts);
  return site ? { calleeId: siteId(site, scan, own), callType: 'self_method' } : undefined;
}

/** A top-level `def` — Ruby makes it a private method on every object. */
function resolveFree(member: string, scan: ModuleScan, own: RubyIndexes): Resolved | undefined {
  const id = pickSymbol(own.free.get(member), scan);
  return id ? { calleeId: id, callType: 'internal_func' } : undefined;
}

/** The class a `@ivar` holds, inherited attributes included. */
function ivarSpelling(owner: MergedType | undefined, ivar: string, own: RubyIndexes): string {
  if (!owner) return '';
  for (const candidate of instanceAncestors(owner, own)) {
    const spelling = own.types.get(typeKey(candidate))?.ivarTypes.get(ivar);
    if (spelling) return spelling;
  }
  return '';
}

/** `foo(...)` with no receiver. */
function resolveBare(
  member: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: RubyIndexes,
): Resolved {
  const viaSelf = resolveSelf(member, scan, context, own);
  if (viaSelf) return viaSelf;
  // `def self.build; new(engine); end` — `new` on the enclosing class.
  if (member === 'new' && context.singleton) {
    const owner = ownerOf(context, own);
    if (owner) return resolveConstructor(owner, scan, own);
  }
  const viaFree = resolveFree(member, scan, own);
  if (viaFree) return viaFree;
  // A bare Capitalized name is a constant, not a method — `Foo()` is rare enough
  // that treating a scanned constant as a constructor is the useful reading.
  if (/^[A-Z]/.test(member)) {
    const ref = resolveTypeSpelling(member, context.scopes, scan, std);
    if (ref) return resolveConstructor(ref, scan, own);
  }
  if (KERNEL_METHODS.has(member)) return boundaryOf('Kernel', member);
  return unresolvedOf(member);
}

/** `recv.m(...)`. */
function resolveWithReceiver(
  receiver: Node,
  member: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: RubyIndexes,
): Resolved {
  if (receiver.type === 'self') {
    return resolveSelf(member, scan, context, own) ?? unresolvedOf(`self.${member}`);
  }

  if (receiver.type === 'instance_variable') {
    const ivar = receiver.text.slice(1);
    const spelling = ivarSpelling(ownerOf(context, own), ivar, own);
    if (!spelling) return unresolvedOf(`@${ivar}.${member}`);
    const ref = resolveTypeSpelling(spelling, context.scopes, scan, std);
    return resolveOnType(ref, spelling, member, 'self_attr_method', false, scan, own);
  }

  if (receiver.type === 'constant' || receiver.type === 'scope_resolution') {
    const spelling = nameSpelling(receiver);
    const ref = resolveTypeSpelling(spelling, context.scopes, scan, std);
    if (!ref) {
      return member === 'new'
        ? boundaryOf(spelling, undefined, { isConstructor: true })
        : boundaryOf(spelling, member);
    }
    if (member === 'new') return resolveConstructor(ref, scan, own);
    // A qualified call into the scan set IS a call to an internal function —
    // the SP2 IR decision, so no new callType is invented for it.
    return resolveOnType(ref, spelling, member, 'internal_func', true, scan, own);
  }

  if (receiver.type === 'identifier') {
    const spelling = context.localTypes.get(receiver.text);
    if (spelling) {
      const ref = resolveTypeSpelling(spelling, context.scopes, scan, std);
      return resolveOnType(ref, spelling, member, 'param_method', false, scan, own);
    }
    // Ruby annotates neither parameters nor locals; without an `X.new` in sight
    // there is nothing to ground this on, and guessing by method name would be
    // exactly the invented fact this adapter refuses to produce.
    return unresolvedOf(`${receiver.text}.${member}`);
  }

  const literal = LITERAL_RECEIVERS[receiver.type];
  if (literal) return boundaryOf(literal, member);
  return unresolvedOf(collapse(`${receiver.text}.${member}`));
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
  // labelled as inferred) is what covers Ruby classes and modules in the meantime.
  typeKinds: [],
};

const RUBY_SPEC: LanguageSpec<ModuleScan, RubyIndexes> = {
  name: 'ruby',
  extensions: EXTENSIONS,
  grammarFor: () => 'ruby',
  extraSkipDirs: EXTRA_SKIP_DIRS,
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
      declared: [],
      requires: [],
      visible: new Set([moduleId]),
    };
  },

  scan(scan, root, file) {
    scanRoot(scan, root, file);
    // Bare-name view of learned attribute types, for spine compatibility.
    for (const info of scan.types.values()) {
      for (const [ivar, spelling] of info.ivarTypes) {
        scan.fieldTypes.set(`${info.name}.${ivar}`, tailOf(spelling));
      }
    }
    // A class reopened in one file, or `attr_reader :x` beside `def x`, can name
    // one member twice; keep the last, which is the one live at runtime.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes(scans, std) {
    computeVisibility(scans);
    const own: RubyIndexes = { types: buildTypes(scans, std), members: new Map(), free: new Map() };
    for (const scan of scans) {
      for (const declared of scan.declared) {
        const def: SymbolDef = { id: declared.id, module: scan.moduleId };
        const table = declared.owner ? own.members : own.free;
        const key = declared.owner
          ? scopedKey(declared.scope, `${declared.owner}${declared.singleton ? '.' : '#'}${declared.member}`)
          : declared.member;
        const defs = table.get(key);
        if (defs) defs.push(def);
        else table.set(key, [def]);
      }
    }
    return own;
  },

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      const emit = (node: Node, resolved: Resolved, raw: string): void => {
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait: false,
          callType: resolved.callType,
          line: lineStart(node),
          raw: truncate(collapse(raw), 80),
        });
      };

      const stack: Node[] = [context.body];
      const push = (node: Node | null | undefined): void => {
        if (node) stack.push(node);
      };
      const pushChildren = (node: Node): void => {
        const children = node.namedChildren;
        for (let i = children.length - 1; i >= 0; i -= 1) push(children[i]);
      };

      while (stack.length > 0) {
        const node = stack.pop();
        if (!node) continue;
        // A nested `def`/`class` is its own caller; a block is not — `do … end`
        // shares `self`, so its calls belong to the enclosing method.
        if (node !== context.body && DEFINITION_NODES.has(node.type)) continue;

        switch (node.type) {
          case 'call': {
            const receiver = node.childForFieldName('receiver');
            const method = node.childForFieldName('method');
            const operator = fieldText(node, 'operator') || '.';
            if (method?.type === 'super') {
              emit(
                node,
                resolveSelf(fn.name, scan, context, own, { skipSelf: true }) ?? unresolvedOf('super'),
                'super',
              );
            } else if (method && (method.type === 'identifier' || method.type === 'constant')) {
              const name = method.text;
              const resolved = receiver
                ? resolveWithReceiver(receiver, name, scan, context, std, own)
                : resolveBare(name, scan, context, std, own);
              emit(node, resolved, receiver ? `${receiver.text}${operator}${name}` : name);
            }
            push(node.childForFieldName('block'));
            push(node.childForFieldName('arguments'));
            push(receiver);
            break;
          }
          case 'assignment': {
            const left = node.childForFieldName('left');
            // `self.total = 5` calls `total=`; the AST spells the target as a
            // plain reader call, so the `=` has to be put back here.
            if (left?.type === 'call') {
              const receiver = left.childForFieldName('receiver');
              const method = left.childForFieldName('method');
              if (receiver && method?.type === 'identifier') {
                const setter = `${method.text}=`;
                emit(left, resolveWithReceiver(receiver, setter, scan, context, std, own), `${left.text}=`);
              }
              push(left.childForFieldName('arguments'));
              push(receiver);
            } else {
              push(left);
            }
            push(node.childForFieldName('right'));
            break;
          }
          case 'identifier': {
            // A bare name is a call only if it grounds; see the header note.
            if (context.locals.has(node.text)) break;
            const resolved = resolveSelf(node.text, scan, context, own) ?? resolveFree(node.text, scan, own);
            if (resolved) emit(node, resolved, node.text);
            break;
          }
          case 'super':
            emit(
              node,
              resolveSelf(fn.name, scan, context, own, { skipSelf: true }) ?? unresolvedOf('super'),
              'super',
            );
            break;
          case 'comment':
          case 'string_content':
          case 'heredoc_content':
          case 'ERROR':
            break;
          default:
            pushChildren(node);
        }
      }
    }
    return edges;
  },
};

export class RubyAdapter extends SpineAdapter<ModuleScan, RubyIndexes> {
  constructor() {
    super(RUBY_SPEC);
  }
}
