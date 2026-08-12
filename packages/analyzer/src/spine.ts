/**
 * The shared spine every language adapter is built on.
 *
 * The hand-written adapters all had the same `analyze()` skeleton and the same
 * cross-module index tables, copied once per language. That is how audit
 * finding A1 happened: the cross-module free-function index existed in two
 * adapters and was simply missing from two others. Mirrored implementations
 * make "forgot to install a part" invisible, and the cost multiplies with every
 * new language.
 *
 * So the skeleton ({@link createAdapter}) and the standard index tables
 * ({@link buildStandardIndexes}) live here exactly once — a new language cannot
 * omit them. Call resolution, by contrast, stays a TOOLBOX of stateless helpers
 * rather than a fixed pipeline: C has no methods, Ruby has no type annotations,
 * Solidity has modifiers. Forcing one resolution order on all of them would be
 * a straitjacket, so each language calls the helpers it needs, in its own order,
 * inside its own `extractCalls`.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import type {
  AdapterCapabilities,
  CallEdge,
  CallType,
  FunctionNode,
  ModuleAnalysis,
  TypeKind,
  TypeNode,
  UnparsedFile,
} from '@handbook/core';
import { truncate } from '@handbook/core';
import type { Logger } from '@handbook/core';
import { createParser, freeParsers } from './languages.js';
import { discoverByExtension, type LanguageAdapter } from './adapter.js';

/** Id segment separator used by every language except Rust (`::`). */
export const DEFAULT_SEPARATOR = '.';

/**
 * The part of a per-module scan the spine understands. Language-private fields
 * live on the concrete scan type (`S`), which the spec is generic over — the
 * spine never looks at them.
 */
export interface BaseScan {
  moduleId: string;
  /** Source files that fed this scan; length 1 for single-file languages. */
  files: string[];
  functions: FunctionNode[];
  /** function id → language-defined pass-2 context (body node, receiver, …). */
  fnContext: Map<string, unknown>;
  /** local name → path; the path's meaning is per-language. */
  imports: Map<string, string>;
  /** class/type name → its method names. An empty set means "declared, no methods". */
  ownerMethods: Map<string, Set<string>>;
  /** `Owner.field` → bare type name. The key always uses `.`, even in Rust. */
  fieldTypes: Map<string, string>;
  /** top-level / free function names. */
  freeFunctions: Set<string>;
  /**
   * Scope-qualified type declarations: scope (namespace / package, '' = the
   * global or default one) → the type names this scan declares in it.
   *
   * Optional, and empty for languages that have no scopes. Languages whose type
   * names are unique only WITHIN a scope fill it in addition to
   * `ownerMethods`, and get {@link StandardIndexes.scopedTypeToModule} in
   * return — the table `typeToModule` cannot be, since that one is keyed by
   * bare name and silently keeps the first `Config` it meets.
   */
  scopedTypes?: Map<string, Set<string>>;
  /**
   * Declared type → the module that owns it, for languages where that is not
   * simply `moduleId`: Rust's inline `mod` blocks nest a module inside a file.
   *
   * When present it is the ONLY source of {@link StandardIndexes.typeToModule}
   * for this scan. That matters for languages that can attach methods to a type
   * they do not declare (Go methods in a sibling file, Rust `impl Trait for
   * Foreign`): such an owner appears in `ownerMethods` but must not be able to
   * claim the type's home module.
   */
  typeModules?: Map<string, string>;
  /**
   * Named types this scan declared, as parsed {@link TypeNode}s — filled by
   * {@link recordType}.
   *
   * Optional, so an adapter that does not extract types needs no change at all
   * and its `emptyScan` stays as written. What makes the omission honest is not
   * this field but {@link LanguageSpec.capabilities}`.typeKinds`, which every
   * adapter must state either way; a `register.test.ts` case fails the build if
   * one declares kinds it never emits, or emits kinds it never declared.
   *
   * Named `typeNodes` rather than `types` because three adapters (C++, PHP,
   * Ruby) already carry a private `types` map of their own, and silently
   * shadowing a language's own field from the shared base is how a scan starts
   * meaning two things at once.
   */
  typeNodes?: TypeNode[];
}

/**
 * The cross-module tables every object-oriented language needs, built once for
 * all of them. `moduleFunctions` is the one whose absence was audit finding
 * A1 — it exists here whether a given language happens to consult it or not.
 *
 * `scopedTypeToModule` is the answer to the opposite failure: Java, C# and C++
 * each hit the point where a BARE type name is not a unique key, and the first
 * two each grew a private scope-aware index of their own before the shape was
 * clear. It lives here now so the fourth language does not write a third one.
 */
export interface StandardIndexes {
  /**
   * bare type name → owning moduleId, for names that are UNAMBIGUOUS.
   *
   * A name declared in two scanned modules is deliberately absent: read it with
   * {@link lookupBareType}, which returns `undefined` for both the missing and
   * the ambiguous case so a caller falls through to `unresolvedOf`.
   *
   * First-declaration-wins was the previous behaviour and it silently invented
   * edges: two modules declaring `Config` — routine above a few thousand lines —
   * meant `from beta.mod import Config; Config()` resolved to ALPHA's
   * constructor and shipped as a real edge, with `dropped-calls.json` empty. A
   * guessed edge is indistinguishable from a real one to everything downstream,
   * which is exactly what invariant 2 exists to prevent.
   */
  typeToModule: Map<string, string>;
  /**
   * Bare type names declared by more than one scanned module. Kept so the
   * ambiguity can be REPORTED rather than merely refused — a reader who sees a
   * missing edge deserves to know the analyzer could not choose, not to wonder
   * whether the call exists.
   */
  ambiguousTypes: Set<string>;
  /**
   * {@link scopedKey}(scope, Type) → owning moduleId (first declaration wins
   * within a scope). Built from {@link BaseScan.scopedTypes}, so it is empty
   * for languages that declare no scopes — and non-empty ones should prefer it
   * to `typeToModule`, which cannot tell `alpha::Config` from `beta::Config`.
   * Read it with {@link lookupScoped}, passing the language's own visibility
   * order.
   */
  scopedTypeToModule: Map<string, string>;
  /**
   * {@link scopedKey}s declared by more than one module. Withdrawn from
   * `scopedTypeToModule` for the same reason as {@link ambiguousTypes}: a scope
   * is NOT always unique across a repository. C++'s `namespace detail` is
   * idiomatically re-opened in every file that needs it, so `detail::Impl` in
   * two translation units is two unrelated types, and first-wins resolved every
   * reference to whichever file was scanned first.
   */
  ambiguousScopedTypes: Set<string>;
  /** `<owning module><sep><Type>` → method names. */
  typeMethods: Map<string, Set<string>>;
  /** moduleId → free function names. */
  moduleFunctions: Map<string, Set<string>>;
  /** directory → free function name → owning moduleId (same-package siblings). */
  directoryFunctions: Map<string, Map<string, string>>;
  /**
   * `<dir>\0<function name>` for names declared by more than one module in the
   * same directory, withdrawn from `directoryFunctions`.
   *
   * Go cannot produce these — one package, one name, or it does not compile —
   * but Swift shares this table and its `private func` is FILE-scoped, so two
   * files in a directory legitimately declare the same helper. Resolving one
   * file's call to the other file's function is an invented edge.
   */
  ambiguousDirectoryFunctions: Set<string>;
  moduleIds: Set<string>;
}

/** One resolved call site: the callee id plus how it was resolved. */
export interface Resolved {
  calleeId: string;
  callType: CallType;
}

/**
 * Everything that differs between languages. The driver owns the rest.
 *
 * `I` is the language's own extra index type (`buildIndexes` → `extractCalls`);
 * it defaults to `unknown` for languages that need no private indexes.
 */
export interface LanguageSpec<S extends BaseScan, I = unknown> {
  /** Registry key, e.g. `python`. */
  name: string;
  /** File extensions (with dot) this adapter owns. */
  extensions: readonly string[];
  /** Grammar per file: TypeScript's `.tsx` → `tsx`, everything else → `typescript`. */
  grammarFor(file: string): string;
  extraSkipDirs?: readonly string[];
  discoverFilter?: (rel: string) => boolean;
  moduleIdForFile(file: string): string;
  /** true = files sharing a moduleId merge into one scan (Rust's lib/mod/main). */
  mergeByModule?: boolean;
  /** Id segment separator; defaults to {@link DEFAULT_SEPARATOR}. */
  idSeparator?: string;
  emptyScan(moduleId: string): S;
  scan(scan: S, root: Node, file: string): void;
  /** Language-private indexes; the standard four come from the spine. */
  buildIndexes?(scans: readonly S[], std: StandardIndexes): I;
  extractCalls(scan: S, std: StandardIndexes, own: I): CallEdge[];
  capabilities: AdapterCapabilities;
  statementSpans?: LanguageAdapter['statementSpans'];
}

/** Parent directory of a relative POSIX path; `.` for files at the root. */
export function dirOf(file: string): string {
  return file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
}

/**
 * Key for a scope-qualified table: `<scope>\0<name>`, where '' is the global
 * scope. NUL is the separator because it is legal in no language's scope
 * syntax, so `a::b` + `C` can never collide with `a` + `b::C`.
 */
export function scopedKey(scope: string, name: string): string {
  return `${scope}\u0000${name}`;
}

/** What {@link lookupScoped} found, plus the scope that produced the hit. */
export interface ScopedHit<T> {
  scope: string;
  value: T;
}

/**
 * First hit for `name` among `scopes`, tried in order.
 *
 * `scopes` IS the language's resolution order, which the spine deliberately
 * does not model: Java's is "this file → declared package → single-type import
 * → on-demand import", C++'s is "innermost namespace outward → global →
 * using-directives". Pass a generator to compute that order lazily when later
 * candidates are expensive.
 *
 * The matched scope comes back with the value because a caller almost always
 * needs it next — to build the qualified id of what it just found. Generic over
 * the value type so a language can use it on its own scoped tables too, not
 * only on {@link StandardIndexes.scopedTypeToModule}.
 */
/**
 * Key for {@link StandardIndexes.ambiguousDirectoryFunctions}. NUL, because it
 * cannot occur in a path or an identifier — `dir + name` would make
 * `a/b` + `c` collide with `a` + `/bc`.
 */
export function dirKey(dir: string, name: string): string {
  return `${dir}\0${name}`;
}

/**
 * Read {@link StandardIndexes.typeToModule}, returning `undefined` for both a
 * name nobody declares and a name more than one module declares.
 *
 * Callers want the same thing in both cases — fall through to `unresolvedOf` —
 * and asking them to remember the second case is how the ambiguity gets lost
 * one adapter at a time.
 */
export function lookupBareType(std: StandardIndexes, name: string): string | undefined {
  return std.ambiguousTypes.has(name) ? undefined : std.typeToModule.get(name);
}

export function lookupScoped<T>(
  table: ReadonlyMap<string, T>,
  scopes: Iterable<string>,
  name: string,
  ambiguous?: ReadonlySet<string>,
): ScopedHit<T> | undefined {
  for (const scope of scopes) {
    const key = scopedKey(scope, name);
    // An ambiguous scope ENDS the walk rather than skipping to the next one.
    // Falling outward would find some other `Impl` in an enclosing scope and
    // resolve to it — turning "we cannot tell which of these two" into a
    // confident edge pointing at a third thing entirely.
    if (ambiguous?.has(key)) return undefined;
    const value = table.get(key);
    if (value !== undefined) return { scope, value };
  }
  return undefined;
}

/**
 * Build the standard cross-module tables. First declaration wins for
 * type→module and directory→function; method and free-function SETS are unioned
 * so two scans that collapse to one moduleId cannot silently drop one another.
 */
export function buildStandardIndexes<S extends BaseScan>(
  scans: readonly S[],
  separator: string = DEFAULT_SEPARATOR,
): StandardIndexes {
  const typeToModule = new Map<string, string>();
  const ambiguousTypes = new Set<string>();
  const scopedTypeToModule = new Map<string, string>();
  const ambiguousScopedTypes = new Set<string>();
  const ambiguousDirectoryFunctions = new Set<string>();
  const typeMethods = new Map<string, Set<string>>();
  const moduleFunctions = new Map<string, Set<string>>();
  const directoryFunctions = new Map<string, Map<string, string>>();
  const moduleIds = new Set<string>();

  for (const scan of scans) {
    moduleIds.add(scan.moduleId);

    let free = moduleFunctions.get(scan.moduleId);
    if (!free) {
      free = new Set<string>();
      moduleFunctions.set(scan.moduleId, free);
    }
    for (const name of scan.freeFunctions) free.add(name);

    for (const [scope, types] of scan.scopedTypes ?? []) {
      for (const type of types) {
        const key = scopedKey(scope, type);
        const owner = scan.typeModules?.get(type) ?? scan.moduleId;
        const existing = scopedTypeToModule.get(key);
        if (existing === undefined) {
          if (!ambiguousScopedTypes.has(key)) scopedTypeToModule.set(key, owner);
        } else if (existing !== owner) {
          // Same rule as the bare-name table: neither module can be chosen, so
          // the key is withdrawn rather than awarded to whoever came first.
          ambiguousScopedTypes.add(key);
          scopedTypeToModule.delete(key);
        }
      }
    }

    for (const [owner, methods] of scan.ownerMethods) {
      const ownerModule = scan.typeModules?.get(owner) ?? scan.moduleId;
      // A scan that declares its types explicitly (typeModules) only claims
      // those; owners it merely implements methods for are skipped here.
      const declared = scan.typeModules ? scan.typeModules.has(owner) : true;
      if (declared) {
        const existing = typeToModule.get(owner);
        if (existing === undefined) {
          typeToModule.set(owner, ownerModule);
        } else if (existing !== ownerModule) {
          // Two modules, one bare name. Neither can be chosen, so the name is
          // withdrawn from the table entirely — leaving the first one there
          // would resolve every later reference to it.
          ambiguousTypes.add(owner);
          typeToModule.delete(owner);
        }
      }
      const key = `${ownerModule}${separator}${owner}`;
      let known = typeMethods.get(key);
      if (!known) {
        known = new Set<string>();
        typeMethods.set(key, known);
      }
      for (const method of methods) known.add(method);
    }

    for (const file of scan.files) {
      const dir = dirOf(file);
      let pkg = directoryFunctions.get(dir);
      if (!pkg) {
        pkg = new Map<string, string>();
        directoryFunctions.set(dir, pkg);
      }
      for (const name of scan.freeFunctions) {
        const existing = pkg.get(name);
        if (existing === undefined) {
          if (!ambiguousDirectoryFunctions.has(dirKey(dir, name))) pkg.set(name, scan.moduleId);
        } else if (existing !== scan.moduleId) {
          ambiguousDirectoryFunctions.add(dirKey(dir, name));
          pkg.delete(name);
        }
      }
    }
  }

  return {
    typeToModule,
    ambiguousTypes,
    scopedTypeToModule,
    ambiguousScopedTypes,
    ambiguousDirectoryFunctions,
    typeMethods,
    moduleFunctions,
    directoryFunctions,
    moduleIds,
  };
}

/** Longest declaration header kept in {@link TypeNode.signature}. */
const TYPE_SIGNATURE_CHARS = 200;

/** What {@link recordType} needs from a language to name one type declaration. */
export interface RecordTypeOptions {
  /** Leaf name as written, e.g. `HandbookModel`. */
  name: string;
  kind: TypeKind;
  /** The whole declaration node — the ONLY source of the line span. */
  node: Node;
  /**
   * The declaration's body, when it has one. The signature is then the text
   * before it (`export interface Foo` out of `export interface Foo { … }`);
   * without it the node's own text is used, which is right for a body-less
   * declaration like a type alias.
   */
  body?: Node | null;
  file: string;
  /**
   * The enclosing type's QUALNAME, for a nested declaration — not its leaf name.
   * `qualname` below is built from it, so passing the leaf would make `C` inside
   * `A.B` come out as `B.C` and collide with a different `B.C` elsewhere.
   */
  container?: string | null;
  /** Id separator; defaults to {@link DEFAULT_SEPARATOR} (Rust passes `::`). */
  separator?: string;
  /**
   * Override the module part of the id, for languages whose types are not simply
   * owned by `scan.moduleId` (Rust's inline `mod` blocks nest a module in a file).
   */
  moduleId?: string;
  /**
   * Prefix prepended to the qualname, already ending in the separator — for a
   * language whose in-FILE module nesting is part of a type's name (Rust's
   * `mod inner { struct S; }` is `inner::S`).
   *
   * Separate from `container` on purpose: `container` is an enclosing TYPE, and a
   * module is not one. Conflating them would make `container` unreadable for the
   * one thing it is for.
   */
  namePrefix?: string;
}

/**
 * Record one parsed type declaration on a scan. The single constructor of a
 * {@link TypeNode}, so the invariants live here instead of in thirteen adapters.
 *
 * Refuses — silently, returning without recording — when the name is empty or
 * the declaration node yields a non-positive line span. That is the "a guessed
 * fact is worse than a missing one" rule at its narrowest: the interim
 * `class-derived` row in the agent artifact still covers a type nobody could
 * locate, and it is LABELLED as derived, whereas a `TypeNode` with a fabricated
 * range is indistinguishable from a parsed one. A tree-sitter node always has a
 * position, so in practice this guard only fires on a caller passing something
 * that is not a declaration.
 */
export function recordType(scan: BaseScan, opts: RecordTypeOptions): void {
  const { name, kind, node, body, file } = opts;
  if (name === '') return;
  const lineStart = node.startPosition.row + 1;
  const lineEnd = node.endPosition.row + 1;
  if (lineStart <= 0 || lineEnd <= 0) return;
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  const container = opts.container ?? null;
  const qualname = `${opts.namePrefix ?? ''}${container ? `${container}${separator}` : ''}${name}`;
  const headerEnd = body ? body.startIndex : node.endIndex;
  const header = node.text.slice(0, Math.max(0, headerEnd - node.startIndex));
  (scan.typeNodes ??= []).push({
    // `type:` so a type and a same-named function can never collide. TypeScript
    // makes that reachable in one file (`interface Foo {}` beside
    // `function Foo() {}`), and a collision would silently drop one of them.
    id: `type:${opts.moduleId ?? scan.moduleId}${separator}${qualname}`,
    name,
    qualname,
    file,
    lineStart,
    lineEnd: Math.max(lineStart, lineEnd),
    kind,
    signature: truncate(header.replace(/\s+/g, ' ').trim(), TYPE_SIGNATURE_CHARS),
    container,
  });
}

/**
 * The distinct {@link TypeKind}s a node-type→kind map can produce, sorted.
 *
 * Derived rather than hand-listed so an adapter's declaration cannot drift from
 * its extraction: adding `record_declaration → struct` to the map widens the
 * declared capability in the same commit, and removing a row narrows it. A
 * hand-written list is exactly how a capability claim goes stale, which is the
 * failure `AdapterCapabilities` exists to prevent. Sorted, because the result is
 * persisted in `graph.json` and an unchanged analysis must re-serialize
 * identically.
 */
export function declaredTypeKinds(kinds: ReadonlyMap<string, TypeKind>): readonly TypeKind[] {
  return [...new Set(kinds.values())].sort();
}

/**
 * Collapse types sharing an id, keeping the FIRST.
 *
 * The sibling of {@link dedupeFunctionsById}, with the opposite tie-break and a
 * reason for it. For a function the last definition is the one live at runtime,
 * so last-wins is a semantic choice. For a type the reachable duplicate is
 * TypeScript declaration MERGING — `interface Foo` written twice, both halves
 * live — where no single declaration is "the" one; the earliest is where a reader
 * should start and is the only choice that keeps the emitted span the first thing
 * in the file rather than an arbitrary later fragment.
 */
export function dedupeTypesById(types: readonly TypeNode[]): TypeNode[] {
  const seen = new Set<string>();
  return types.filter((type) => {
    if (seen.has(type.id)) return false;
    seen.add(type.id);
    return true;
  });
}

/** `unresolved:<hint>` — the one shape the graph builder diverts to dropped calls. */
export function unresolvedOf(hint: string): Resolved {
  return { calleeId: `unresolved:${truncate(hint, 80)}`, callType: 'unresolved' };
}

/** `boundary:<path>[<sep><member>]` — a call leaving the scanned set. */
export function boundaryOf(
  path: string,
  member?: string,
  opts: { separator?: string; isConstructor?: boolean } = {},
): Resolved {
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  return {
    calleeId: `boundary:${member ? `${path}${separator}${member}` : path}`,
    callType: opts.isConstructor ? 'boundary_constructor' : 'boundary',
  };
}

/**
 * A free function declared in the calling scan itself.
 *
 * `idOf` overrides the default `<moduleId><sep><name>` id for languages whose
 * free-function ids carry more than the module (Rust's inline `mod` prefix); it
 * declining (undefined) is a miss, not a fallback.
 */
export function resolveSameFileFree(
  name: string,
  scan: BaseScan,
  opts: { separator?: string; idOf?: (name: string) => string | undefined } = {},
): Resolved | undefined {
  if (!scan.freeFunctions.has(name)) return undefined;
  const id = opts.idOf ? opts.idOf(name) : `${scan.moduleId}${opts.separator ?? DEFAULT_SEPARATOR}${name}`;
  return id ? { calleeId: id, callType: 'internal_func' } : undefined;
}

/**
 * A free function declared in a sibling file of the same directory — for
 * languages whose visibility unit is the directory (Go's package), where a bare
 * call can target any file of it.
 */
export function resolveSiblingPackage(
  name: string,
  scan: BaseScan,
  std: StandardIndexes,
  opts: { separator?: string } = {},
): Resolved | undefined {
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  for (const file of scan.files) {
    const dir = dirOf(file);
    // Two files in this directory declare it; neither can be chosen.
    if (std.ambiguousDirectoryFunctions.has(dirKey(dir, name))) return undefined;
    const owner = std.directoryFunctions.get(dir)?.get(name);
    if (owner) return { calleeId: `${owner}${separator}${name}`, callType: 'internal_func' };
  }
  return undefined;
}

/** How a language reads its own import table. See {@link resolveViaImport}. */
export interface ImportResolveOptions {
  /** Split an import value into the module it came from and the imported name. */
  parse?: (imported: string) => { source: string; leaf: string };
  separator?: string;
  /** Member appended to a scanned type's id: `__init__` / `constructor` / `new`. */
  constructorName?: string;
  /** Try the type/constructor branch before the free-function branch. */
  typeFirst?: boolean;
  /** Only a capitalized leaf may name a type (Python's convention-based gate). */
  capitalizedTypesOnly?: boolean;
  /** A capitalized leaf that is NOT a scanned type is a boundary CONSTRUCTOR. */
  capitalizedIsConstructor?: boolean;
  /** The moduleId `source` names inside the scanned set, if any. */
  moduleOf?: (source: string) => string | undefined;
  /**
   * Full node id of free function `leaf` exported by `source`. Overrides the
   * `moduleOf` + {@link StandardIndexes.moduleFunctions} lookup for languages
   * that match imports differently (Rust matches on the module tail and
   * declines when two candidates tie).
   */
  freeFunctionId?: (source: string, leaf: string) => string | undefined;
}

/** Default import-value split: dotted path, leaf = last segment. */
function splitDotted(imported: string): { source: string; leaf: string } {
  const at = imported.lastIndexOf('.');
  return at >= 0
    ? { source: imported.slice(0, at), leaf: imported.slice(at + 1) }
    : { source: '', leaf: imported };
}

/**
 * Resolve an imported local name. A symbol imported from a SCANNED module is
 * internal (a free function, or a type whose constructor we can name); anything
 * else is a boundary. Returns undefined only when `localName` was not imported
 * at all, so a caller can fall through to its other strategies.
 */
export function resolveViaImport(
  localName: string,
  scan: BaseScan,
  std: StandardIndexes,
  opts: ImportResolveOptions = {},
): Resolved | undefined {
  const imported = scan.imports.get(localName);
  if (imported === undefined) return undefined;
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  const { source, leaf } = (opts.parse ?? splitDotted)(imported);
  const capitalized = /^[A-Z]/.test(leaf);

  const typeBranch = (): Resolved | undefined => {
    if (opts.capitalizedTypesOnly && !capitalized) return undefined;
    // A name the scanned set declares TWICE is not a boundary — the callee is
    // in the codebase, we simply cannot say which one. Falling through would
    // let `capitalizedIsConstructor` below label it `boundary_constructor`,
    // which positively asserts the call leaves the codebase. Quarantine it
    // instead, so it lands in dropped-calls.json and nothing downstream can
    // mistake a refusal for a fact.
    if (std.ambiguousTypes.has(leaf)) {
      return unresolvedOf(`ambiguous type "${leaf}" declared in more than one module`);
    }
    const typeModule = std.typeToModule.get(leaf);
    if (typeModule) {
      const base = `${typeModule}${separator}${leaf}`;
      return {
        calleeId: opts.constructorName ? `${base}${separator}${opts.constructorName}` : base,
        callType: 'internal_constructor',
      };
    }
    if (opts.capitalizedIsConstructor && capitalized) {
      return boundaryOf(imported, undefined, { separator, isConstructor: true });
    }
    return undefined;
  };

  const freeBranch = (): Resolved | undefined => {
    if (opts.freeFunctionId) {
      const id = opts.freeFunctionId(source, leaf);
      return id ? { calleeId: id, callType: 'internal_func' } : undefined;
    }
    const module = opts.moduleOf?.(source);
    if (module && std.moduleFunctions.get(module)?.has(leaf)) {
      return { calleeId: `${module}${separator}${leaf}`, callType: 'internal_func' };
    }
    return undefined;
  };

  for (const branch of opts.typeFirst ? [typeBranch, freeBranch] : [freeBranch, typeBranch]) {
    const hit = branch();
    if (hit) return hit;
  }
  return boundaryOf(imported, undefined, { separator });
}

/**
 * `self.m()` / `recv.M()` — a method of the caller's own owner type.
 *
 * `idBase` overrides the default `<moduleId><sep><owner>` id base (Rust inline
 * mods). `crossModule` additionally accepts a method declared in another scan
 * of the same type, which languages whose type methods span files need (Go: one
 * directory is one package, and a type's methods may live in any file of it).
 */
export function resolveOwnMethod(
  owner: string,
  method: string,
  scan: BaseScan,
  std: StandardIndexes,
  opts: { separator?: string; idBase?: string; crossModule?: boolean } = {},
): Resolved | undefined {
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  if (scan.ownerMethods.get(owner)?.has(method)) {
    const base = opts.idBase ?? `${scan.moduleId}${separator}${owner}`;
    return { calleeId: `${base}${separator}${method}`, callType: 'self_method' };
  }
  if (!opts.crossModule) return undefined;
  if (std.ambiguousTypes.has(owner)) {
    return unresolvedOf(`ambiguous type "${owner}" declared in more than one module`);
  }
  const ownerModule = std.typeToModule.get(owner);
  if (ownerModule && std.typeMethods.get(`${ownerModule}${separator}${owner}`)?.has(method)) {
    return {
      calleeId: `${ownerModule}${separator}${owner}${separator}${method}`,
      callType: 'self_method',
    };
  }
  return undefined;
}

/**
 * `self.field.m()` through the field type the scan learned (declared, annotated
 * or inferred — that part is each language's own business). A learned type that
 * is not in the scanned set is a boundary, which is real information; only a
 * field whose type was never learned is a miss.
 */
export function resolveFieldType(
  owner: string,
  field: string,
  method: string,
  scan: BaseScan,
  std: StandardIndexes,
  opts: { separator?: string } = {},
): Resolved | undefined {
  const type = scan.fieldTypes.get(`${owner}.${field}`);
  if (!type) return undefined;
  const separator = opts.separator ?? DEFAULT_SEPARATOR;
  if (std.ambiguousTypes.has(type)) {
    return unresolvedOf(`ambiguous field type "${type}" declared in more than one module`);
  }
  const typeModule = std.typeToModule.get(type);
  if (typeModule) {
    return {
      calleeId: `${typeModule}${separator}${type}${separator}${method}`,
      callType: 'self_attr_method',
    };
  }
  return boundaryOf(type, method, { separator });
}

/**
 * The driver (design §1.1): build parsers, read each file, parse it, merge by
 * moduleId on demand, then hand the scans to the language's own `extractCalls`
 * and flatten the result.
 *
 * A file that cannot be read, cannot be parsed, or parses with syntax errors is
 * RECORDED in `unparsedFiles` rather than skipped in silence — see
 * {@link ModuleAnalysis}.
 *
 * A class rather than a plain object because adapters are constructed with
 * `new` by the registry and by tests.
 */
/**
 * The largest source file this analyzer will read, in bytes.
 *
 * Chosen against real repositories rather than in the abstract: the largest
 * hand-written source file across the seventeen projects this was tested on is
 * under 1 MiB, and everything past a few MiB was generated — a protobuf stub,
 * a bundled vendor script, a lookup table. 8 MiB leaves an order of magnitude
 * of headroom over anything a person wrote, and the files above it are
 * disclosed in `scan-coverage.json` rather than dropped, so a repository that
 * genuinely needs one analyzed can see exactly what was skipped and why.
 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export class SpineAdapter<S extends BaseScan, I = unknown> implements LanguageAdapter {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly capabilities: AdapterCapabilities;
  readonly statementSpans?: LanguageAdapter['statementSpans'];

  constructor(private readonly spec: LanguageSpec<S, I>) {
    this.name = spec.name;
    this.extensions = spec.extensions;
    this.capabilities = spec.capabilities;
    if (spec.statementSpans) this.statementSpans = spec.statementSpans;
  }

  discover(sourceRoot: string, options: { logger?: Logger } = {}): string[] {
    return discoverByExtension(
      sourceRoot,
      this.spec.extensions,
      this.spec.extraSkipDirs ?? [],
      this.spec.discoverFilter,
      options.logger,
    );
  }

  async analyze(
    files: readonly string[],
    sourceRoot: string,
    options: { logger?: Logger } = {},
  ): Promise<ModuleAnalysis> {
    const { spec } = this;
    const logger = options.logger;
    const parsers = new Map<string, Parser>();
    const trees: Tree[] = [];
    const unparsable: string[] = [];
    const partial: string[] = [];
    const unparsedFiles: UnparsedFile[] = [];
    const scans: S[] = [];
    const byModule = new Map<string, S>();

    // Trees and parsers both own memory inside ONE WASM instance shared by every
    // grammar, and the JavaScript garbage collector cannot reclaim it —
    // `delete()` is the only way back.
    //
    // THE TREES ARE THE ONES THAT MATTER. Measured on a 4,937-file polyglot
    // repository: holding every tree from C++ (566 files), Dart (3,351), Java
    // (510) and Kotlin (343) exhausted the shared resource, and the next
    // `new Parser()` — the first one Objective-C asked for — died with
    //
    //     RuntimeError: table index is out of bounds
    //         at tree-sitter.wasm.ts_parser_new_wasm
    //
    // taking the whole analyze down 90% of the way through. Freeing the parsers
    // and not the trees does NOT fix it (verified by running both in isolation);
    // freeing the trees does. Parsers are freed too because they are ours to
    // free, not because they were the cause.
    //
    // Trees are freed AFTER pass 2, never during pass 1. `spec.scan` stores live
    // body `Node`s in `scan.fnContext` for `extractCalls` to walk, and a Node is
    // a pointer into its tree's memory — freeing inside the loop would hand pass
    // 2 dangling pointers, which is worse than the leak: silently wrong call
    // facts instead of a crash.
    //
    // So the peak is one language's trees rather than the whole process's, which
    // is what makes a polyglot repository analyzable at all. A single language
    // large enough to exhaust the table on its own would still fail, and the
    // remedy is to analyze it alone with `--lang`.
    //
    // A `finally`, because a leak on the error path costs exactly as much as one
    // on the success path.
    try {
      for (const file of files) {
        let source: string;
        try {
          // Size first, so an implausible file costs a `stat` rather than a
          // read. A minified bundle, a vendored blob or a generated table can
          // be hundreds of megabytes; read as UTF-8 it becomes a JS string
          // roughly twice that in memory, and then tree-sitter is asked to
          // parse it. Neither the memory nor the minutes buy anything: nobody
          // reads a card about a 400 MB generated file.
          //
          // Recorded as `unreadable` — which is the truth, we did not read it —
          // with the size in `detail`, so `scan-coverage.json` names the real
          // reason rather than implying the parser choked.
          const bytes = statSync(join(sourceRoot, file)).size;
          if (bytes > MAX_SOURCE_BYTES) {
            const mib = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
            unparsedFiles.push({
              file,
              reason: 'unreadable',
              detail: `${mib(bytes)} is above the ${mib(MAX_SOURCE_BYTES)} scan limit — not read`,
            });
            logger?.warn(`[scan] ${file}: ${mib(bytes)}, above the ${mib(MAX_SOURCE_BYTES)} limit — skipped`);
            continue;
          }
          source = readFileSync(join(sourceRoot, file), 'utf8');
        } catch (error) {
          // Discovery listed this path, so something happened between listing
          // and reading: a mode that denies us, a dangling symlink, a file the
          // build deleted underneath us. Continuing silently was worse than the
          // failure — the path stayed in `scannedFiles`, so the cards pass
          // described it as "a file with 0 functions" and `_coverage.json`
          // counted it as fully covered. The handbook then asserted, as a
          // parser fact, that an unread file is empty.
          unparsedFiles.push({ file, reason: 'unreadable', detail: (error as Error).message });
          logger?.warn(`[scan] ${file}: unreadable (${(error as Error).message}) — no facts for this file`);
          continue;
        }
        const grammar = spec.grammarFor(file);
        let parser = parsers.get(grammar);
        if (!parser) {
          parser = await createParser(grammar);
          parsers.set(grammar, parser);
        }
        // A grammar can THROW, not merely fail: tree-sitter-bash's external
        // scanner imports a symbol web-tree-sitter does not resolve, so any
        // `case` statement throws — and the throw escapes the whole run, taking
        // every other file with it. Catching is not enough: the parser instance
        // stays poisoned and fails every subsequent parse, so it is discarded
        // and rebuilt for the files that follow.
        let tree;
        try {
          tree = parser.parse(source);
        } catch (error) {
          parsers.delete(grammar);
          // Free it as well as forget it. A discarded-but-live parser still
          // holds its slots in the shared WASM function table, so a language
          // with many unparsable files would exhaust the table on its own.
          try {
            parser.delete();
          } catch {
            // already gone, or the runtime is past saving — either way, moving on
          }
          unparsable.push(file);
          unparsedFiles.push({ file, reason: 'unparsable', detail: (error as Error).message });
          logger?.debug(`[scan] ${file}: parser failed (${(error as Error).message})`);
          continue;
        }
        if (!tree) {
          // Same standing as a throw: no tree means no facts. It used to be the
          // one branch with neither a log line nor a record, so the file simply
          // ceased to exist between discovery and the graph.
          unparsedFiles.push({ file, reason: 'unparsable', detail: 'the parser returned no tree' });
          logger?.warn(`[scan] ${file}: the parser returned no tree — no facts for this file`);
          continue;
        }
        trees.push(tree);
        if (tree.rootNode.hasError) {
          // Tree-sitter recovers from a syntax error by parking the text it
          // could not understand in an ERROR node and carrying on, so the pass
          // below still yields functions — just not the ones inside that node.
          // Nothing downstream can see the difference: a file with three
          // exported functions and one malformed class reaches the handbook as
          // a file with one function, stated as fact. Recorded (not skipped),
          // because the facts we DID get are real and worth keeping.
          partial.push(file);
          unparsedFiles.push({
            file,
            reason: 'partial',
            detail: 'the parse tree contains syntax errors; facts from this file are incomplete',
          });
          logger?.debug(`[scan] ${file}: parsed with syntax errors — partial facts`);
        }

        const moduleId = spec.moduleIdForFile(file);
        let scan = spec.mergeByModule ? byModule.get(moduleId) : undefined;
        if (!scan) {
          scan = spec.emptyScan(moduleId);
          if (spec.mergeByModule) byModule.set(moduleId, scan);
          scans.push(scan);
        }
        scan.files.push(file);
        spec.scan(scan, tree.rootNode, file);
      }

      // Skipped files are stated, not swallowed: a handbook that silently omits
      // part of a codebase is worse than one that admits the gap.
      if (unparsable.length > 0) {
        const shown = unparsable.slice(0, 5).join(', ');
        const more = unparsable.length > 5 ? ` (+${unparsable.length - 5} more)` : '';
        // For shell the cause is known and worth naming, because the raw
        // message ("resolved is not a function") tells a reader nothing and the
        // impact is large: `case` is ubiquitous, so this routinely accounts for
        // EVERY file in a shell codebase. Saying "5 files skipped" without the
        // reason invites the conclusion that the tool merely found little.
        const because =
          spec.name === 'shell'
            ? ' — the pinned bash grammar throws on `case`, which most real scripts use;' +
              ' their functions are absent from this graph, not merely unresolved'
            : '';
        logger?.warn(
          `[scan] ${spec.name}: ${unparsable.length} file(s) the grammar could not parse${because} — ${shown}${more}`,
        );
      }
      // Partial parses get ONE aggregate line rather than a warning each: a
      // grammar that trails the language by a release makes this the common
      // case, and a per-file flood is how the two lines above stop being read.
      // Every one of them is still named individually in scan-coverage.json.
      if (partial.length > 0) {
        const shown = partial.slice(0, 5).join(', ');
        const more = partial.length > 5 ? ` (+${partial.length - 5} more)` : '';
        logger?.warn(
          `[scan] ${spec.name}: ${partial.length} file(s) parsed with syntax errors — their function` +
            ` and call facts are incomplete, not absent — ${shown}${more}`,
        );
      }

      // Pass 2 runs HERE, inside the try, so its results are computed while the
      // trees its body nodes point into are still alive.
      const std = buildStandardIndexes(scans, spec.idSeparator ?? DEFAULT_SEPARATOR);
      const own = spec.buildIndexes?.(scans, std) as I;
      // `[]` when the adapter DECLARES type kinds and found none; `undefined`
      // when it declares none at all. That is the whole disambiguation: an empty
      // array says "looked, found nothing", an absent one says "did not look",
      // and collapsing them would make an unindexed language indistinguishable
      // from an empty one to everything downstream.
      const declaresTypes = (spec.capabilities.typeKinds ?? []).length > 0;
      const types = scans.flatMap((scan) => scan.typeNodes ?? []);
      return {
        functions: scans.flatMap((scan) => scan.functions),
        edges: scans.flatMap((scan) => spec.extractCalls(scan, std, own)),
        unparsedFiles,
        types: declaresTypes ? dedupeTypesById(types) : undefined,
      };
    } finally {
      freeParsers(parsers.values());
      for (const tree of trees) {
        try {
          tree.delete();
        } catch {
          // already freed, or the runtime is past saving
        }
      }
    }
  }
}

/** Object form of {@link SpineAdapter} — what the generic engine builds. */
export function createAdapter<S extends BaseScan, I = unknown>(spec: LanguageSpec<S, I>): LanguageAdapter {
  return new SpineAdapter(spec);
}
