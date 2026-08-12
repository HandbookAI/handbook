/**
 * Solidity adapter (tree-sitter grammar `solidity`).
 *
 * Two passes, like every adapter:
 *   1. scan each file: `import` directives, every declared contract / interface
 *      / library with its bases, state variables, functions, modifiers,
 *      constructors, fallback/receive, and file-level free functions;
 *   2. resolve call sites (`f()`, `this.f()`, `super.f()`, `Lib.f()`,
 *      `state.f()`, `param.f()`, `IERC20(a).transfer()`, `new C()`, and modifier
 *      invocations) against the cross-module indexes into typed {@link CallEdge}s.
 *
 * Three Solidity facts shape this adapter:
 *
 * - **State variables are the state register.** A contract's storage IS the
 *   cross-stage shared state the handbook wants to describe, and Solidity reads
 *   and writes it through BARE identifiers (`rpm = rpm + 1`), not through a
 *   `self`/`this` prefix — `this.rpm` is an external call to the generated
 *   getter, which real code avoids. So `selfAttrsRead`/`selfAttrsWritten` are
 *   computed by resolving bare identifiers against the contract's storage set
 *   (its own plus every scanned ancestor's), minus anything a parameter, named
 *   return or local variable shadows. This is the highest-value signal here and
 *   is treated as such.
 * - **A qualified call to a scanned type is an internal call.** `MathLib.add()`
 *   resolves to `internal_func` at `<module>.MathLib.add`, following the SP2
 *   decision not to add a `static_method` kind. The same applies to the
 *   interface-wrapping idiom `IERC20(token).transfer(...)`: the wrap is a cast,
 *   the call lands on the scanned interface's declaration.
 * - **A modifier is a real dependency, so it gets an edge.** `onlyOwner` is not
 *   an annotation: the compiler inlines its body around the function, so the
 *   `require`s and storage reads inside it execute on every call. Omitting it
 *   would hide the single most consequential fact about most external
 *   functions. It resolves as `self_method`, since a modifier is reachable only
 *   through the contract that declares it or inherits it. Modifier invocations
 *   are also mirrored into `decorators`, matching Python's and Java's shape.
 *
 * Which members become function nodes, and why:
 *   - `function` (including a body-less one in an interface or `abstract`
 *     contract — it is the declaration an external call resolves to);
 *   - `constructor`, recorded under the CONTRACT's name (`<module>.Engine.Engine`),
 *     so `new Engine()` has a stable target and `graph.ts:synthesizeConstructor`
 *     can still decompose `<module>.<Type>.<member>` for the very common contract
 *     that declares no constructor at all;
 *   - `modifier`, `fallback`, `receive` — all three have bodies that run;
 *   - file-level free functions (Solidity ≥0.7), as `<module>.<name>`.
 *   - `event` and `error` do NOT: they are data declarations with no body, so a
 *     node for one would be a permanent zero-callee leaf. `emit` therefore
 *     produces no edge (see gaps).
 *
 * Known limits, stated rather than hidden:
 *   - **`emit E(...)` produces no edge and events get no node.** An event has no
 *     body to call into; a boundary edge would falsely claim the target is
 *     outside the scanned set.
 *   - **`assembly { … }` blocks are skipped entirely.** Yul cannot call Solidity
 *     functions, and its builtins (`sstore`, `mload`) are EVM opcodes rather
 *     than functions — so storage touched only via `sstore`/`.slot` is invisible
 *     to `selfAttrs`.
 *   - **Inheritance uses reversed-declaration-order BFS, not full C3
 *     linearization.** Solidity resolves `is A, B` right-to-left, which this
 *     reproduces; the two differ only for a diamond in which two unrelated
 *     ancestors declare the same member.
 *   - **Imports are matched by path, not by a remapping table.** A relative
 *     `./x.sol` resolves against the importing file's directory and then against
 *     the source root; a remapped or package path (`@openzeppelin/…`) names no
 *     scanned file and correctly becomes a boundary.
 *   - **A plain `import "x.sol";` is followed one level**, not transitively
 *     through what `x.sol` itself imported plainly.
 *   - **Local variables are typed only from their declaration.** Solidity has no
 *     `var`, so no inference is needed — but a receiver reached through an
 *     expression (`f().g()`, a nested mapping) stays unresolved.
 *   - **Overloads share one id**, so the spine dedupe keeps the last definition,
 *     the same trade Java and TypeScript already make.
 *   - **`using L for T` is honoured only when exactly one attached library
 *     declares the member name**; an ambiguous attachment stays unresolved
 *     rather than guessing. The newer `using {f} for T` form is a parse ERROR in
 *     the pinned grammar (see below) and is ignored.
 *   - A call in a state-variable initializer produces no edge: there is no
 *     enclosing function node to hang it on (as in Java and TypeScript).
 *
 * Grammar notes, measured against the pinned `tree-sitter-wasms@0.1.13`:
 * NatSpec (`///` and block), `assembly` with Yul functions/switch/for,
 * `pragma abicoder`/`experimental`, `try`/`catch`, `unchecked`, arrays and
 * mappings of user types all parse with `hasError = false`. The one construct
 * that does not is `using {f} for T;` (Solidity ≥0.8.13), which yields two
 * ERROR nodes — but they stay local to that directive and the rest of the file
 * is unaffected. A file the grammar cannot parse at all collapses into a single
 * ERROR root with no declaration children, so it contributes nothing and is
 * effectively skipped.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, CallType, TypeKind } from '@handbook/core';
import { truncate } from '@handbook/core';
import { dedupeFunctionsById } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import {
  boundaryOf,
  declaredTypeKinds,
  dirOf,
  recordType,
  resolveOwnMethod,
  resolveSameFileFree,
  unresolvedOf,
  SpineAdapter,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from '../spine.js';

/** Hardhat / Foundry build output and vendored dependency trees. */
const EXTRA_SKIP_DIRS = ['artifacts', 'cache', 'broadcast', 'typechain', 'typechain-types', 'forge-cache'];

/** Contract-like declarations: the things that own members. */
const TYPE_DECLARATIONS = new Set(['contract_declaration', 'interface_declaration', 'library_declaration']);

/** Declarations that name a type but own no callable member. */
const DATA_DECLARATIONS = new Set([
  'struct_declaration',
  'enum_declaration',
  'user_defined_type_definition',
  'event_definition',
  'error_declaration',
]);

/**
 * Node type → the {@link TypeKind} it declares, for THIS grammar. Three of the
 * five mappings are judgement calls, so each is argued rather than asserted.
 *
 * **`contract` is `class`.** Read the vocabulary's definition of `class` clause by
 * clause — nominal, instantiable, owns methods and state — and a Solidity contract
 * satisfies every one of them literally: `new Engine()` deploys one, it holds
 * storage, it has a constructor, it inherits with `is`, it can be `abstract`, and
 * `Engine(addr)` uses it as a variable's type. The reasons to hesitate (it is
 * deployed at an address; state is persistent storage) are facts about the runtime,
 * not about the shape of the declaration a reader is looking up. Filing the single
 * most common declaration in the language under `other` would leave the escape
 * hatch carrying most of the index, which tells a reader nothing at all.
 *
 * **`library` is NOT `class`, and is `other`.** A library is the one contract-like
 * form that fails the definition: it cannot be instantiated, cannot declare state
 * variables, and cannot inherit or be inherited from. It is not an `interface`
 * either — it carries implementations — and not a `trait`: nothing "is a" library,
 * and `using MathLib for uint256` attaches functions to a type rather than making
 * the type a subtype of anything. A stateless, non-instantiable named collection of
 * functions is exactly the case `other` exists for, with `library MathLib` verbatim
 * in the signature.
 *
 * **`type Price is uint128` is `other`, not `alias`.** Solidity has no type aliases.
 * A user-defined value type is a DISTINCT type with no implicit conversion to its
 * representation — `Price.wrap`/`unwrap` are required — so `alias` would state the
 * opposite of the language's rule. Same reasoning, and the same bucket, as a Go
 * defined type.
 *
 * Deliberately absent: `event_definition` and `error_declaration`. Both are named,
 * both are in {@link DATA_DECLARATIONS} because their names must not be mistaken for
 * contracts at a call site, and neither is a TYPE — an event is a log signature and
 * an error is a revert signature; neither can annotate a variable or be inherited.
 * A `constructor` and a `modifier` are members, and are already functions.
 */
const SOLIDITY_TYPE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ['contract_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['library_declaration', 'other'],
  ['struct_declaration', 'struct'],
  ['enum_declaration', 'enum'],
  ['user_defined_type_definition', 'other'],
]);

/**
 * Emit the {@link TypeNode} for one declaration, if it declares a type at all.
 *
 * `container` is the enclosing contract for a nested `struct` or `enum` — Solidity
 * refers to those as `Engine.Reading` from outside, so the qualname matches the
 * source. A top-level one has no container: a Solidity file is not a namespace.
 */
function recordTypeDeclaration(scan: ModuleScan, node: Node, file: string, container: string | null): void {
  const kind = SOLIDITY_TYPE_KINDS.get(node.type);
  if (!kind) return;
  recordType(scan, {
    name: fieldText(node, 'name'),
    kind,
    node,
    // A contract/interface/library has a `body` field. A struct's and an enum's
    // members are DIRECT children with no wrapper to stop at, so the brace is the
    // stop — otherwise a 40-field struct's signature would be 40 fields long.
    body: node.childForFieldName('body') ?? openingBrace(node),
    file,
    container,
  });
}

/** The `{` that opens a member list, for a declaration with no body node. */
function openingBrace(node: Node): Node | null {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text === '{') return child;
  }
  return null;
}

/**
 * Compiler intrinsics reachable as a bare call. They are genuinely external to
 * the scanned source — `require` is not a function anyone wrote — so a boundary
 * edge is the truthful record, and "this function uses `revert`" is worth
 * keeping.
 */
const BUILTIN_FUNCTIONS = new Set([
  'require',
  'assert',
  'revert',
  'keccak256',
  'sha256',
  'sha3',
  'ripemd160',
  'ecrecover',
  'addmod',
  'mulmod',
  'selfdestruct',
  'suicide',
  'blockhash',
  'blobhash',
  'gasleft',
  'type',
]);

/** Magic globals; a call through one of them leaves the scanned set. */
const GLOBAL_OBJECTS = new Set(['msg', 'block', 'tx', 'abi']);

/** Members every `address` has. Reaching one means value/low-level movement. */
const ADDRESS_MEMBERS = new Set([
  'transfer',
  'send',
  'call',
  'delegatecall',
  'staticcall',
  'balance',
  'code',
]);

/** Receiver expressions that are an address cast, not a contract reference. */
const CAST_EXPRESSIONS = new Set(['type_cast_expression', 'payable_conversion_expression']);

interface FnContext {
  body: Node;
  /** Owning contract / interface / library; '' for a file-level free function. */
  ownerName: string;
  /** Parameter and local-variable name → bare user-defined type name. */
  types: Map<string, string>;
  /** Modifier invocations written on the declaration (base constructors too). */
  modifiers: Node[];
  /** Parameters, named returns and locals — they shadow same-named storage. */
  shadowed: Set<string>;
}

interface ModuleScan extends BaseScan {
  /**
   * `imports`: local name → the raw import path it came from.
   * `ownerMethods`: contract → its callable member names (functions, modifiers,
   * `fallback`/`receive`, and the constructor under the contract's own name).
   * `fieldTypes`: `Contract.stateVar` → bare user-defined type name.
   * `freeFunctions`: file-level functions.
   */
  fnContext: Map<string, FnContext>;
  /** contract → ancestor names in `is` order. */
  supertypeNames: Map<string, string[]>;
  /** contract → the modifier names it declares (a subset of `ownerMethods`). */
  ownModifiers: Map<string, Set<string>>;
  /** contract → its state-variable names. */
  stateVars: Map<string, Set<string>>;
  /** `Contract.stateVar` → array element / mapping value bare type name. */
  elementTypes: Map<string, string>;
  /** contract → libraries attached with `using L for T`. */
  usingLibraries: Map<string, string[]>;
  /** A locally aliased import name → the name actually exported by the source. */
  importOriginal: Map<string, string>;
  /** `import * as U from "x"` / `import "x" as U` — alias → raw path. */
  fileAliases: Map<string, string>;
  /** `import "x";` — raw paths whose whole scope becomes visible here. */
  plainImports: string[];
  /** Struct / enum / user-defined value types declared here. */
  dataTypes: Set<string>;
}

/** One type, located: the module that declares it and its name there. */
interface TypeRef {
  module: string;
  type: string;
}

interface SolidityIndexes {
  /** Normalized source-root-relative path → moduleId. */
  moduleOfPath: Map<string, string>;
  /** `<module>.<Type>` → its declared ancestors that are inside the scan set. */
  supertypes: Map<string, TypeRef[]>;
  /** `<module>.<Type>.<stateVar>` → bare type name, so heirs can read it. */
  fieldTypes: Map<string, string>;
  /** `<module>.<Type>.<stateVar>` → array element / mapping value type. */
  elementTypes: Map<string, string>;
  /** `<module>.<Type>` → state-variable names, so heirs can see the storage. */
  stateVars: Map<string, Set<string>>;
  /** moduleId → modules made wholly visible by a plain `import "x";`. */
  plainImportModules: Map<string, string[]>;
  /** `<module>.<Type>` → the modifier names it declares. */
  typeModifiers: Map<string, Set<string>>;
  /** moduleId → its free function names (a plain-import lookup needs this). */
  moduleFreeFunctions: Map<string, Set<string>>;
}

export function moduleIdForFile(file: string): string {
  return file
    .replace(/\.sol$/, '')
    .split('/')
    .join('.');
}

/** Collapse `a/./b` and `a/b/../c`; a leading `../` that escapes the root stays. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** `"./Base.sol"` → `./Base.sol`. */
function unquote(text: string): string {
  return text.replace(/^["']/, '').replace(/["']$/, '');
}

function isMapping(node: Node): boolean {
  return node.childForFieldName('value_type') !== null;
}

function isArrayType(node: Node): boolean {
  return node.children.some((c) => c?.type === '[');
}

/**
 * The contract-like name a declaration site refers to DIRECTLY:
 * `Engine` → `Engine`, `demo.Engine` → `Engine`, `uint256` → '',
 * `Engine[]` → '' (an array is not a contract reference; see
 * {@link elementTypeName}).
 */
function directTypeName(node: Node | null): string {
  if (!node) return '';
  if (node.type === 'user_defined_type') {
    const ids = node.namedChildren.filter((c): c is Node => c?.type === 'identifier');
    return ids.at(-1)?.text ?? '';
  }
  if (node.type !== 'type_name') return '';
  if (isMapping(node) || isArrayType(node)) return '';
  const inner = node.namedChildren.find((c) => c !== null);
  return inner ? directTypeName(inner) : '';
}

/** Element type of `T[]` and value type of `mapping(K => V)`; '' otherwise. */
function elementTypeName(node: Node | null): string {
  if (!node || node.type !== 'type_name') return '';
  if (isMapping(node)) return directTypeName(node.childForFieldName('value_type'));
  if (isArrayType(node)) {
    const inner = node.namedChildren.find((c) => c !== null);
    return inner ? directTypeName(inner) : '';
  }
  return '';
}

/** `contract C is A, B` → `['A', 'B']`, in written order. */
function ancestorNamesOf(decl: Node): string[] {
  const names: string[] = [];
  for (const child of decl.namedChildren) {
    if (child?.type !== 'inheritance_specifier') continue;
    const name = directTypeName(child.childForFieldName('ancestor'));
    if (name) names.push(name);
  }
  return names;
}

/** The modifier invocations written on a function / constructor declaration. */
function modifierNodesOf(decl: Node): Node[] {
  return decl.namedChildren.filter((c): c is Node => c?.type === 'modifier_invocation');
}

/** `onlyOwner` from a `modifier_invocation`, arguments dropped. */
function modifierNameOf(node: Node): string {
  const id = node.namedChildren.find((c): c is Node => c?.type === 'identifier');
  return id?.text ?? '';
}

/**
 * All three import forms. Children are walked IN ORDER, reading each one's
 * FIELD name, because `{A as B, C}` repeats the `import_name` and `alias`
 * fields — `childForFieldName` returns only the first of each and so cannot
 * pair a name with its alias. (Both fields hold plain `identifier` nodes, so
 * matching on node type would match nothing at all.)
 */
function collectImport(node: Node, scan: ModuleScan): void {
  const source = node.childForFieldName('source');
  if (!source) return;
  const path = unquote(source.text);
  let pending = '';
  let named = 0;
  let aliases = 0;
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child) continue;
    const field = node.fieldNameForChild(i);
    if (field === 'import_name') {
      if (pending) scan.imports.set(pending, path);
      pending = child.text;
      named += 1;
    } else if (field === 'alias') {
      aliases += 1;
      if (pending) {
        // `{A as B}` — B is the local name for the source's A.
        scan.imports.set(child.text, path);
        scan.importOriginal.set(child.text, pending);
        pending = '';
      } else {
        // `import * as U from "x"` / `import "x" as U` — a whole-file alias.
        scan.fileAliases.set(child.text, path);
      }
    }
  }
  if (pending) scan.imports.set(pending, path);
  // `import "x";` alone puts every symbol of x into this file's scope.
  if (named === 0 && aliases === 0) scan.plainImports.push(path);
}

/**
 * Names bound inside a function that SHADOW storage: parameters, named return
 * values and local declarations. Solidity forbids nothing here, and a shadowed
 * name must not be reported as a state access.
 */
function shadowedNames(decl: Node, body: Node | null): Set<string> {
  const names = new Set<string>();
  for (const child of decl.namedChildren) {
    if (child?.type === 'parameter') {
      const name = fieldText(child, 'name');
      if (name) names.add(name);
    } else if (child?.type === 'return_type_definition') {
      for (const param of child.namedChildren) {
        if (param?.type !== 'parameter') continue;
        const name = fieldText(param, 'name');
        if (name) names.add(name);
      }
    }
  }
  if (body) {
    walk(body, (node) => {
      if (node.type === 'assembly_statement') return false;
      if (node.type === 'variable_declaration') {
        const name = fieldText(node, 'name');
        if (name) names.add(name);
      }
      return undefined;
    });
  }
  return names;
}

/** The identifier a write lands on: `x`, `x[i]`, `x.f`, `x[i].f` → `x`. */
function writeBase(node: Node | null): Node | null {
  let current = node;
  while (current) {
    if (current.type === 'array_access') current = current.childForFieldName('base');
    else if (current.type === 'member_expression') current = current.childForFieldName('object');
    else break;
  }
  return current?.type === 'identifier' ? current : null;
}

/** Every write target of an assignment LHS, unwrapping `(a, b) = …`. */
function writeTargets(left: Node | null): Node[] {
  if (!left) return [];
  if (left.type === 'tuple_expression') {
    return left.namedChildren.flatMap((c) => (c ? writeTargets(c) : []));
  }
  const base = writeBase(left);
  return base ? [base] : [];
}

/** Position key, so a write target can be excluded from the read scan. */
function nodeKey(node: Node): string {
  return `${node.startIndex}:${node.endIndex}`;
}

/**
 * Bare identifiers read inside `node`, skipping the positions where an
 * identifier names something other than a value read: a member's `property`, a
 * struct field's `name`, the callee of a plain `f()`, and any node in `skip`
 * (the write targets of an enclosing assignment).
 */
function collectReads(
  node: Node,
  isState: (name: string) => boolean,
  out: Set<string>,
  skip: ReadonlySet<string> = new Set(),
): void {
  walk(node, (n) => {
    if (n.type === 'assembly_statement') return false;
    if (n.type === 'identifier' && skip.has(nodeKey(n))) return false;
    if (n.type === 'member_expression') {
      const object = n.childForFieldName('object');
      if (object) collectReads(object, isState, out, skip);
      return false;
    }
    if (n.type === 'struct_field_assignment') {
      const value = n.childForFieldName('value');
      if (value) collectReads(value, isState, out, skip);
      return false;
    }
    if (n.type === 'call_expression') {
      const callee = n.childForFieldName('function');
      // `spin()` — the callee identifier is a function name, not a storage read.
      // `delegate.start()` — the receiver IS one, so member callees recurse.
      if (callee && callee.type !== 'identifier') collectReads(callee, isState, out, skip);
      for (const arg of n.namedChildren) {
        if (arg?.type === 'call_argument') collectReads(arg, isState, out, skip);
      }
      return false;
    }
    if (n.type === 'identifier' && isState(n.text)) out.add(n.text);
    return undefined;
  });
}

/**
 * State-variable reads and writes inside one function body — the "state
 * register" signal. Bare identifiers, because that is how Solidity touches
 * storage: `this.rpm` would be an external call to the generated getter.
 */
function trackStateAttrs(
  body: Node,
  isState: (name: string) => boolean,
): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  /** Write targets, plus the read scan of what surrounds them (`m[k] = v`). */
  const assign = (side: Node | null, alsoRead: boolean): void => {
    if (!side) return;
    const targets = writeTargets(side);
    for (const target of targets) {
      if (!isState(target.text)) continue;
      writes.add(target.text);
      if (alsoRead) reads.add(target.text);
    }
    collectReads(side, isState, reads, new Set(targets.map(nodeKey)));
  };

  /** `a = b = 1` chains, so the RHS re-enters the same handling. */
  const assignment = (node: Node): void => {
    assign(node.childForFieldName('left'), node.type === 'augmented_assignment_expression');
    const right = node.childForFieldName('right');
    if (!right) return;
    if (right.type === 'assignment_expression' || right.type === 'augmented_assignment_expression') {
      assignment(right);
      return;
    }
    collectReads(right, isState, reads);
  };

  walk(body, (node) => {
    if (node.type === 'assembly_statement') return false;
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      assignment(node);
      return false;
    }
    if (node.type === 'update_expression') {
      assign(node.childForFieldName('argument'), true);
      return false;
    }
    if (node.type === 'unary_expression' && fieldText(node, 'operator') === 'delete') {
      assign(node.childForFieldName('argument'), false);
      return false;
    }
    if (
      node.type === 'member_expression' ||
      node.type === 'struct_field_assignment' ||
      node.type === 'call_expression' ||
      node.type === 'identifier'
    ) {
      collectReads(node, isState, reads);
      return false;
    }
    return undefined;
  });
  return { reads: [...reads].sort(), writes: [...writes].sort() };
}

interface RecordOptions {
  /** The declaration; the signature is sliced from its head. */
  node: Node;
  body: Node | null;
  name: string;
  /** Owning contract, or '' for a file-level free function. */
  ownerName: string;
  file: string;
}

function recordFunction(scan: ModuleScan, opts: RecordOptions): void {
  const { node, body, name, ownerName, file } = opts;
  if (!name) return;
  const qualname = ownerName ? `${ownerName}.${name}` : name;
  const id = `${scan.moduleId}.${qualname}`;

  const paramTypes: Record<string, string> = {};
  const types = new Map<string, string>();
  for (const child of node.namedChildren) {
    if (child?.type !== 'parameter') continue;
    const paramName = fieldText(child, 'name');
    if (!paramName) continue;
    const typeNode = child.childForFieldName('type');
    paramTypes[paramName] = typeNode ? typeNode.text.replace(/\s+/g, ' ') : '';
    const bare = directTypeName(typeNode);
    if (bare) types.set(paramName, bare);
  }
  if (body) {
    walk(body, (n) => {
      if (n.type === 'assembly_statement') return false;
      if (n.type !== 'variable_declaration') return undefined;
      const local = fieldText(n, 'name');
      const bare = directTypeName(n.childForFieldName('type'));
      if (local && bare && !types.has(local)) types.set(local, bare);
      return undefined;
    });
  }

  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  const modifiers = modifierNodesOf(node);

  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(header.replace(/\s+/g, ' ').trim(), 200),
    // Solidity has no async/await; the fields are not invented into something.
    isAsync: false,
    isMethod: ownerName !== '',
    className: ownerName || null,
    decorators: modifiers.map((m) => m.text.replace(/\s+/g, ' ').trim()),
    kind: 'internal',
    synthetic: false,
    // Filled by `annotateStateAttrs` once the inheritance index exists — a
    // contract's storage includes every scanned ancestor's, which cannot be
    // known while a single file is still being scanned.
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes,
  });
  if (body) {
    scan.fnContext.set(id, { body, ownerName, types, modifiers, shadowed: shadowedNames(node, body) });
  }
}

/** Declare `owner` in every per-contract table, once. */
function declareOwner(scan: ModuleScan, owner: string): void {
  if (!scan.ownerMethods.has(owner)) scan.ownerMethods.set(owner, new Set());
  if (!scan.ownModifiers.has(owner)) scan.ownModifiers.set(owner, new Set());
  if (!scan.stateVars.has(owner)) scan.stateVars.set(owner, new Set());
}

/**
 * Pass 1a — every declaration's shape, before any body is read. Storage sets
 * must be complete before {@link recordFunction} can decide whether a bare
 * identifier is a state access.
 */
function scanTypeShape(scan: ModuleScan, decl: Node): void {
  const owner = fieldText(decl, 'name');
  if (!owner) return;
  declareOwner(scan, owner);
  const ancestors = ancestorNamesOf(decl);
  if (ancestors.length > 0) scan.supertypeNames.set(owner, ancestors);

  const body = decl.childForFieldName('body');
  if (!body) return;
  for (const member of body.namedChildren) {
    if (!member) continue;
    switch (member.type) {
      case 'state_variable_declaration': {
        const name = fieldText(member, 'name');
        if (!name) break;
        scan.stateVars.get(owner)?.add(name);
        const typeNode = member.childForFieldName('type');
        const direct = directTypeName(typeNode);
        if (direct) scan.fieldTypes.set(`${owner}.${name}`, direct);
        const element = elementTypeName(typeNode);
        if (element) scan.elementTypes.set(`${owner}.${name}`, element);
        break;
      }
      case 'using_directive': {
        const alias = member.namedChildren.find((c): c is Node => c?.type === 'type_alias');
        if (!alias) break;
        const libs = scan.usingLibraries.get(owner) ?? [];
        libs.push(alias.text);
        scan.usingLibraries.set(owner, libs);
        break;
      }
      case 'function_definition':
      case 'modifier_definition': {
        const name = fieldText(member, 'name');
        if (!name) break;
        scan.ownerMethods.get(owner)?.add(name);
        if (member.type === 'modifier_definition') scan.ownModifiers.get(owner)?.add(name);
        break;
      }
      case 'constructor_definition':
        // A Solidity constructor has no source name; it is recorded under the
        // contract's, matching Java and C# and keeping `new C()` resolvable.
        scan.ownerMethods.get(owner)?.add(owner);
        break;
      case 'fallback_receive_definition': {
        const kind = member.children.find((c) => c?.type === 'receive' || c?.type === 'fallback');
        if (kind) scan.ownerMethods.get(owner)?.add(kind.type);
        break;
      }
      default:
        if (DATA_DECLARATIONS.has(member.type)) {
          const name = fieldText(member, 'name');
          if (name) scan.dataTypes.add(name);
        }
    }
  }
}

/** Pass 1b — the members themselves. */
function scanTypeMembers(scan: ModuleScan, decl: Node, file: string): void {
  const owner = fieldText(decl, 'name');
  const body = decl.childForFieldName('body');
  if (!owner || !body) return;
  for (const member of body.namedChildren) {
    if (!member) continue;
    if (member.type === 'function_definition' || member.type === 'modifier_definition') {
      recordFunction(scan, {
        node: member,
        body: member.childForFieldName('body'),
        name: fieldText(member, 'name'),
        ownerName: owner,
        file,
      });
    } else if (member.type === 'constructor_definition') {
      recordFunction(scan, {
        node: member,
        body: member.childForFieldName('body'),
        name: owner,
        ownerName: owner,
        file,
      });
    } else if (member.type === 'fallback_receive_definition') {
      const kind = member.children.find((c) => c?.type === 'receive' || c?.type === 'fallback');
      recordFunction(scan, {
        node: member,
        body: member.childForFieldName('body'),
        name: kind?.type ?? '',
        ownerName: owner,
        file,
      });
    } else if (DATA_DECLARATIONS.has(member.type)) {
      // A `struct` or `enum` declared INSIDE a contract. Referred to from outside
      // as `Engine.Reading`, so the container makes the qualname match the source.
      recordTypeDeclaration(scan, member, file, owner);
    }
  }
}

/** Candidate module ids an import path could name, best first. */
function importCandidates(path: string, importingFile: string): string[] {
  const stripped = path.replace(/\.sol$/, '');
  const candidates: string[] = [];
  if (path.startsWith('./') || path.startsWith('../')) {
    candidates.push(normalizePath(`${dirOf(importingFile)}/${stripped}`));
  }
  candidates.push(normalizePath(stripped));
  return candidates.filter(Boolean);
}

/** The scanned module an import path names, if any. */
function moduleOfImport(path: string, scan: ModuleScan, own: SolidityIndexes): string | undefined {
  const importingFile = scan.files[0] ?? '';
  for (const candidate of importCandidates(path, importingFile)) {
    const module = own.moduleOfPath.get(candidate);
    if (module) return module;
  }
  return undefined;
}

/** Does `module` declare a contract-like type called `type`? */
function declaresType(module: string, type: string, std: StandardIndexes): boolean {
  return std.typeMethods.has(`${module}.${type}`);
}

/**
 * The contract-like type visible as `name` from `scan`, in Solidity's own order:
 * this file (Solidity has no implicit cross-file visibility), then a named
 * import, then a plain `import "x";`. Undefined means "not in the scan set",
 * including the imported-but-unscanned case — the caller still holds the import
 * path and reports it as a boundary.
 */
function resolveTypeRef(
  name: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SolidityIndexes,
): TypeRef | undefined {
  if (scan.ownerMethods.has(name)) return { module: scan.moduleId, type: name };
  const imported = scan.imports.get(name);
  if (imported) {
    const module = moduleOfImport(imported, scan, own);
    const original = scan.importOriginal.get(name) ?? name;
    if (module && declaresType(module, original, std)) return { module, type: original };
    return undefined;
  }
  for (const module of own.plainImportModules.get(scan.moduleId) ?? []) {
    if (declaresType(module, name, std)) return { module, type: name };
  }
  return undefined;
}

/** The raw import path a local name came from, for boundary reporting. */
function importPathOf(name: string, scan: ModuleScan): string | undefined {
  return scan.imports.get(name) ?? scan.fileAliases.get(name);
}

/** Ancestors nearest-first. Reversed declaration order approximates Solidity's C3. */
function ancestorsOf(start: TypeRef, own: SolidityIndexes): TypeRef[] {
  const seen = new Set([`${start.module}.${start.type}`]);
  const order: TypeRef[] = [];
  const queue: TypeRef[] = [start];
  while (queue.length > 0) {
    const ref = queue.shift();
    if (!ref) continue;
    const parents = [...(own.supertypes.get(`${ref.module}.${ref.type}`) ?? [])].reverse();
    for (const parent of parents) {
      const key = `${parent.module}.${parent.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(parent);
      queue.push(parent);
    }
  }
  return order;
}

/** Where `member` is declared: the type itself, or its nearest scanned ancestor. */
function declaringType(
  ref: TypeRef,
  member: string,
  std: StandardIndexes,
  own: SolidityIndexes,
  opts: { skipSelf?: boolean } = {},
): TypeRef | undefined {
  const declares = (candidate: TypeRef): boolean =>
    std.typeMethods.get(`${candidate.module}.${candidate.type}`)?.has(member) ?? false;
  if (!opts.skipSelf && declares(ref)) return ref;
  return ancestorsOf(ref, own).find(declares);
}

/** A state variable's declared type, inherited storage included. */
function stateVarType(
  owner: string,
  field: string,
  scan: ModuleScan,
  own: SolidityIndexes,
  table: 'fieldTypes' | 'elementTypes',
): string {
  const direct = scan[table].get(`${owner}.${field}`);
  if (direct) return direct;
  for (const ancestor of ancestorsOf({ module: scan.moduleId, type: owner }, own)) {
    const inherited = own[table].get(`${ancestor.module}.${ancestor.type}.${field}`);
    if (inherited) return inherited;
  }
  return '';
}

/** Is `name` a state variable of `owner`, inherited storage included? */
function isStateVarOf(name: string, owner: string, scan: ModuleScan, own: SolidityIndexes): boolean {
  if (scan.stateVars.get(owner)?.has(name)) return true;
  for (const ancestor of ancestorsOf({ module: scan.moduleId, type: owner }, own)) {
    if (own.stateVars.get(`${ancestor.module}.${ancestor.type}`)?.has(name)) return true;
  }
  return false;
}

/**
 * `<receiver of type `type`>.<member>()`. A type outside the scan set is a
 * boundary (real information); inside it, the call lands on whichever type
 * actually declares the member.
 */
function resolveOnType(
  type: string,
  member: string,
  callType: CallType,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved {
  const ref = resolveTypeRef(type, scan, std, own);
  if (!ref) return boundaryOf(importPathOf(type, scan) ?? type, member);
  const declaring = declaringType(ref, member, std, own) ?? ref;
  return { calleeId: `${declaring.module}.${declaring.type}.${member}`, callType };
}

/** `using L for T;` — accept only an unambiguous single attached library. */
function resolveViaUsing(
  owner: string,
  member: string,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved | undefined {
  const hits: TypeRef[] = [];
  for (const lib of scan.usingLibraries.get(owner) ?? []) {
    const ref = resolveTypeRef(lib, scan, std, own);
    if (ref && (std.typeMethods.get(`${ref.module}.${ref.type}`)?.has(member) ?? false)) hits.push(ref);
  }
  const only = hits.length === 1 ? hits[0] : undefined;
  return only ? { calleeId: `${only.module}.${only.type}.${member}`, callType: 'internal_func' } : undefined;
}

/** A free function `name` reachable from `scan` through its imports. */
function resolveImportedFree(name: string, scan: ModuleScan, own: SolidityIndexes): Resolved | undefined {
  const imported = scan.imports.get(name);
  if (imported) {
    const module = moduleOfImport(imported, scan, own);
    const original = scan.importOriginal.get(name) ?? name;
    if (module && own.moduleFreeFunctions.get(module)?.has(original)) {
      return { calleeId: `${module}.${original}`, callType: 'internal_func' };
    }
    return undefined;
  }
  for (const module of own.plainImportModules.get(scan.moduleId) ?? []) {
    if (own.moduleFreeFunctions.get(module)?.has(name)) {
      return { calleeId: `${module}.${name}`, callType: 'internal_func' };
    }
  }
  return undefined;
}

/** `f(...)` with no receiver. */
function resolveBareCall(
  name: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved | undefined {
  // `Engine(addr)` is a cast that produces a contract reference, and
  // `Point(1, 2)` / `Price.wrap`'s `Price(x)` construct a value of a declared
  // data type. Neither is a call to anything with a body.
  if (resolveTypeRef(name, scan, std, own) || scan.dataTypes.has(name)) return undefined;
  if (context.ownerName) {
    const self: TypeRef = { module: scan.moduleId, type: context.ownerName };
    const own_ = resolveOwnMethod(context.ownerName, name, scan, std);
    if (own_) return own_;
    const ancestor = declaringType(self, name, std, own, { skipSelf: true });
    if (ancestor) {
      return { calleeId: `${ancestor.module}.${ancestor.type}.${name}`, callType: 'self_method' };
    }
  }
  const free = resolveSameFileFree(name, scan) ?? resolveImportedFree(name, scan, own);
  if (free) return free;
  if (BUILTIN_FUNCTIONS.has(name)) return boundaryOf(name);
  const path = importPathOf(name, scan);
  if (path) {
    // `Token(addr)` on an imported name the scan set does not contain is a cast
    // to that type, not a call. Solidity's naming convention is the only signal
    // available, and it is a strong one: types are capitalized, free functions
    // are not. Same rule the Java adapter uses for an unimported qualifier.
    if (/^[A-Z]/.test(name)) return undefined;
    return boundaryOf(path, name);
  }
  return unresolvedOf(name);
}

/** Could `name` be a type here — scanned, or imported and capitalized? */
function isTypeLike(name: string, scan: ModuleScan, std: StandardIndexes, own: SolidityIndexes): boolean {
  if (resolveTypeRef(name, scan, std, own)) return true;
  return scan.imports.has(name) && /^[A-Z]/.test(name);
}

/** `<object>.<property>(...)`. */
function resolveMemberCall(
  object: Node,
  property: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved {
  const owner = context.ownerName;
  const self: TypeRef = { module: scan.moduleId, type: owner };
  const inherited = (): Resolved | undefined => {
    if (!owner) return undefined;
    const ancestor = declaringType(self, property, std, own, { skipSelf: true });
    return ancestor
      ? { calleeId: `${ancestor.module}.${ancestor.type}.${property}`, callType: 'self_method' }
      : undefined;
  };

  // `IERC20(token).transfer(...)` — the wrap is a cast; the call lands on the
  // wrapped type, which the SP2 decision records as an internal call.
  if (object.type === 'call_expression') {
    const wrapped = object.childForFieldName('function');
    if (wrapped?.type === 'identifier') {
      if (resolveTypeRef(wrapped.text, scan, std, own)) {
        return resolveOnType(wrapped.text, property, 'internal_func', scan, std, own);
      }
      const path = importPathOf(wrapped.text, scan);
      if (path) return boundaryOf(path, property);
    }
    return unresolvedOf(`${object.text}.${property}`);
  }

  // `address(x).call(…)` / `payable(x).transfer(…)` — an EVM primitive.
  if (CAST_EXPRESSIONS.has(object.type)) {
    return boundaryOf('address', property);
  }

  // `tokens[0].transfer(…)` / `vaults[k].deposit(…)` through the element type.
  if (object.type === 'array_access') {
    const base = object.childForFieldName('base');
    if (base?.type === 'identifier' && owner) {
      const element = stateVarType(owner, base.text, scan, own, 'elementTypes');
      if (element) return resolveOnType(element, property, 'self_attr_method', scan, std, own);
    }
    return unresolvedOf(`${object.text}.${property}`);
  }

  if (object.type !== 'identifier') {
    return unresolvedOf(`${object.text}.${property}`);
  }

  const base = object.text;
  if (base === 'this') {
    if (owner) {
      const direct = resolveOwnMethod(owner, property, scan, std);
      if (direct) return direct;
    }
    return inherited() ?? unresolvedOf(`this.${property}`);
  }
  if (base === 'super') {
    return inherited() ?? unresolvedOf(`super.${property}`);
  }

  // A parameter or local whose declared type is a scanned contract.
  const localType = context.types.get(base);
  if (localType) return resolveOnType(localType, property, 'param_method', scan, std, own);

  if (owner) {
    const fieldType = stateVarType(owner, base, scan, own, 'fieldTypes');
    if (fieldType) return resolveOnType(fieldType, property, 'self_attr_method', scan, std, own);
  }

  // `MathLib.add(…)` / `Engine.staticThing(…)` — a qualified internal call.
  if (resolveTypeRef(base, scan, std, own)) {
    return resolveOnType(base, property, 'internal_func', scan, std, own);
  }

  // `Utils.log(…)` where `Utils` aliases a whole scanned file.
  const alias = scan.fileAliases.get(base);
  if (alias) {
    const module = moduleOfImport(alias, scan, own);
    if (module && own.moduleFreeFunctions.get(module)?.has(property)) {
      return { calleeId: `${module}.${property}`, callType: 'internal_func' };
    }
    if (module && declaresType(module, property, std)) {
      return { calleeId: `${module}.${property}`, callType: 'internal_func' };
    }
    return boundaryOf(alias, property);
  }

  if (GLOBAL_OBJECTS.has(base)) return boundaryOf(base, property);

  const path = importPathOf(base, scan);
  if (path) return boundaryOf(path, property);

  // A `using L for T` attachment, when exactly one library owns the name.
  if (owner) {
    const attached = resolveViaUsing(owner, property, scan, std, own);
    if (attached) return attached;
    // A state variable of a non-contract type reaching an address member is
    // value movement — worth recording as a boundary rather than dropping.
    if (isStateVarOf(base, owner, scan, own) && ADDRESS_MEMBERS.has(property)) {
      return boundaryOf('address', property);
    }
  }

  return unresolvedOf(`${base}.${property}`);
}

/** `new C(...)`. */
function resolveNew(
  node: Node,
  scan: ModuleScan,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved | undefined {
  const type = directTypeName(node.childForFieldName('name'));
  // `new bytes(n)` / `new uint256[](n)` allocate memory; nothing is deployed.
  if (!type) return undefined;
  const ref = resolveTypeRef(type, scan, std, own);
  if (ref) {
    return { calleeId: `${ref.module}.${ref.type}.${ref.type}`, callType: 'internal_constructor' };
  }
  return boundaryOf(importPathOf(type, scan) ?? type, undefined, { isConstructor: true });
}

/**
 * A modifier written on a declaration. In a constructor header the same node
 * shape also carries a base-constructor invocation (`constructor() Parent(v)`),
 * which is why an ancestor name is checked before giving up.
 */
function resolveModifier(
  name: string,
  scan: ModuleScan,
  context: FnContext,
  std: StandardIndexes,
  own: SolidityIndexes,
): Resolved {
  const owner = context.ownerName;
  if (owner) {
    if (scan.ownModifiers.get(owner)?.has(name)) {
      return { calleeId: `${scan.moduleId}.${owner}.${name}`, callType: 'self_method' };
    }
    for (const ancestor of ancestorsOf({ module: scan.moduleId, type: owner }, own)) {
      if (own.typeModifiers.get(`${ancestor.module}.${ancestor.type}`)?.has(name)) {
        return { calleeId: `${ancestor.module}.${ancestor.type}.${name}`, callType: 'self_method' };
      }
    }
    // `constructor(…) Parent(v)` — an explicit base constructor call.
    if ((scan.supertypeNames.get(owner) ?? []).includes(name)) {
      const ref = resolveTypeRef(name, scan, std, own);
      if (ref) {
        return { calleeId: `${ref.module}.${ref.type}.${ref.type}`, callType: 'internal_constructor' };
      }
      return boundaryOf(importPathOf(name, scan) ?? name, undefined, { isConstructor: true });
    }
  }
  const path = importPathOf(name, scan);
  if (path) return boundaryOf(path, name);
  return unresolvedOf(name);
}

function buildIndexes(scans: readonly ModuleScan[], std: StandardIndexes): SolidityIndexes {
  const moduleOfPath = new Map<string, string>();
  const fieldTypes = new Map<string, string>();
  const elementTypes = new Map<string, string>();
  const stateVars = new Map<string, Set<string>>();
  const typeModifiers = new Map<string, Set<string>>();
  const moduleFreeFunctions = new Map<string, Set<string>>();

  for (const scan of scans) {
    for (const file of scan.files) {
      moduleOfPath.set(normalizePath(file.replace(/\.sol$/, '')), scan.moduleId);
    }
    for (const [key, type] of scan.fieldTypes) fieldTypes.set(`${scan.moduleId}.${key}`, type);
    for (const [key, type] of scan.elementTypes) elementTypes.set(`${scan.moduleId}.${key}`, type);
    for (const [owner, names] of scan.stateVars) stateVars.set(`${scan.moduleId}.${owner}`, names);
    for (const [owner, names] of scan.ownModifiers) typeModifiers.set(`${scan.moduleId}.${owner}`, names);
    moduleFreeFunctions.set(scan.moduleId, scan.freeFunctions);
  }

  const indexes: SolidityIndexes = {
    moduleOfPath,
    supertypes: new Map(),
    fieldTypes,
    elementTypes,
    stateVars,
    plainImportModules: new Map(),
    typeModifiers,
    moduleFreeFunctions,
  };

  // Plain imports first: ancestor names are resolved through them.
  for (const scan of scans) {
    const modules: string[] = [];
    for (const path of scan.plainImports) {
      const module = moduleOfImport(path, scan, indexes);
      if (module && module !== scan.moduleId) modules.push(module);
    }
    indexes.plainImportModules.set(scan.moduleId, modules);
  }

  for (const scan of scans) {
    for (const [type, names] of scan.supertypeNames) {
      const refs: TypeRef[] = [];
      for (const name of names) {
        const ref = resolveTypeRef(name, scan, std, indexes);
        if (ref) refs.push(ref);
      }
      if (refs.length > 0) indexes.supertypes.set(`${scan.moduleId}.${type}`, refs);
    }
  }

  annotateStateAttrs(scans, indexes);
  return indexes;
}

/**
 * Fill in `selfAttrsRead` / `selfAttrsWritten` now that the inheritance index
 * exists. It has to happen here rather than during the scan: a contract's
 * storage is its own state variables PLUS every scanned ancestor's, and an
 * ancestor usually lives in another file that may not have been read yet.
 *
 * The spine reads `scan.functions` only after `buildIndexes` returns, so
 * refining the nodes in place is safe.
 */
function annotateStateAttrs(scans: readonly ModuleScan[], own: SolidityIndexes): void {
  for (const scan of scans) {
    const storage = new Map<string, Set<string>>();
    const storageOf = (owner: string): Set<string> => {
      let names = storage.get(owner);
      if (names) return names;
      names = new Set(scan.stateVars.get(owner) ?? []);
      for (const ancestor of ancestorsOf({ module: scan.moduleId, type: owner }, own)) {
        for (const name of own.stateVars.get(`${ancestor.module}.${ancestor.type}`) ?? []) names.add(name);
      }
      storage.set(owner, names);
      return names;
    };
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context?.ownerName) continue;
      const names = storageOf(context.ownerName);
      if (names.size === 0) continue;
      const isState = (name: string): boolean => names.has(name) && !context.shadowed.has(name);
      const { reads, writes } = trackStateAttrs(context.body, isState);
      fn.selfAttrsRead = reads;
      fn.selfAttrsWritten = writes;
    }
  }
}

/** Source text of a call site, collapsed to one line. */
function rawOf(text: string): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), 80);
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
  typeKinds: declaredTypeKinds(SOLIDITY_TYPE_KINDS),
};

const SOLIDITY_SPEC: LanguageSpec<ModuleScan, SolidityIndexes> = {
  name: 'solidity',
  extensions: ['.sol'],
  grammarFor: () => 'solidity',
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
      supertypeNames: new Map(),
      ownModifiers: new Map(),
      stateVars: new Map(),
      elementTypes: new Map(),
      usingLibraries: new Map(),
      importOriginal: new Map(),
      fileAliases: new Map(),
      plainImports: [],
      dataTypes: new Set(),
    };
  },

  scan(scan, root, file) {
    const declarations: Node[] = [];
    for (const child of root.namedChildren) {
      if (!child) continue;
      if (child.type === 'import_directive') {
        collectImport(child, scan);
      } else if (TYPE_DECLARATIONS.has(child.type)) {
        declarations.push(child);
        scanTypeShape(scan, child);
        recordTypeDeclaration(scan, child, file, null);
      } else if (child.type === 'function_definition') {
        // Solidity ≥0.7: a function outside any contract.
        const name = fieldText(child, 'name');
        if (name) scan.freeFunctions.add(name);
      } else if (DATA_DECLARATIONS.has(child.type)) {
        const name = fieldText(child, 'name');
        if (name) scan.dataTypes.add(name);
        recordTypeDeclaration(scan, child, file, null);
      }
    }

    for (const decl of declarations) scanTypeMembers(scan, decl, file);
    for (const child of root.namedChildren) {
      if (child?.type !== 'function_definition') continue;
      recordFunction(scan, {
        node: child,
        body: child.childForFieldName('body'),
        name: fieldText(child, 'name'),
        ownerName: '',
        file,
      });
    }
    // Solidity allows overloading; ids must stay unique, so keep the last.
    scan.functions = dedupeFunctionsById(scan.functions);
  },

  buildIndexes,

  extractCalls(scan, std, own) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const context = scan.fnContext.get(fn.id);
      if (!context) continue;
      /**
       * Inner nodes already accounted for by an enclosing call site: the
       * `IERC20(token)` of `IERC20(token).transfer(…)` is a cast, and emitting
       * an edge for it too would double-count one call.
       */
      const consumed = new Set<string>();
      const push = (resolved: Resolved | undefined, node: Node, raw: string): void => {
        if (!resolved) return;
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait: false,
          callType: resolved.callType,
          line: lineStart(node),
          raw: rawOf(raw),
        });
      };

      for (const modifier of context.modifiers) {
        const name = modifierNameOf(modifier);
        if (!name) continue;
        push(resolveModifier(name, scan, context, std, own), modifier, modifier.text);
      }

      walk(context.body, (node) => {
        // Yul cannot reach Solidity functions, and its builtins are opcodes.
        if (node.type === 'assembly_statement') return false;
        if (node.type !== 'call_expression') return undefined;
        // Still walk the children: a cast's arguments can hold real calls.
        if (consumed.has(nodeKey(node))) return undefined;
        let callee = node.childForFieldName('function');
        // `x.call{value: v}(…)` wraps the callee in the call-options struct.
        if (callee?.type === 'struct_expression') callee = callee.childForFieldName('type');
        if (!callee) return undefined;

        if (callee.type === 'new_expression') {
          push(resolveNew(callee, scan, std, own), node, node.text);
        } else if (callee.type === 'identifier') {
          push(resolveBareCall(callee.text, scan, context, std, own), node, `${callee.text}()`);
        } else if (callee.type === 'member_expression') {
          const object = callee.childForFieldName('object');
          const property = fieldText(callee, 'property');
          if (object?.type === 'call_expression') {
            const wrapped = object.childForFieldName('function');
            if (wrapped?.type === 'identifier' && isTypeLike(wrapped.text, scan, std, own)) {
              consumed.add(nodeKey(object));
            }
          }
          if (object && property) {
            push(resolveMemberCall(object, property, scan, context, std, own), node, callee.text);
          }
        }
        return undefined;
      });
    }
    return edges;
  },
};

export class SolidityAdapter extends SpineAdapter<ModuleScan, SolidityIndexes> {
  constructor() {
    super(SOLIDITY_SPEC);
  }
}
