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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node, Parser, Tree } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, CallType, FunctionNode, ModuleAnalysis } from '@handbook/core';
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
  /** bare type name → owning moduleId (first declaration wins). */
  typeToModule: Map<string, string>;
  /**
   * {@link scopedKey}(scope, Type) → owning moduleId (first declaration wins
   * within a scope). Built from {@link BaseScan.scopedTypes}, so it is empty
   * for languages that declare no scopes — and non-empty ones should prefer it
   * to `typeToModule`, which cannot tell `alpha::Config` from `beta::Config`.
   * Read it with {@link lookupScoped}, passing the language's own visibility
   * order.
   */
  scopedTypeToModule: Map<string, string>;
  /** `<owning module><sep><Type>` → method names. */
  typeMethods: Map<string, Set<string>>;
  /** moduleId → free function names. */
  moduleFunctions: Map<string, Set<string>>;
  /** directory → free function name → owning moduleId (same-package siblings). */
  directoryFunctions: Map<string, Map<string, string>>;
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
export function lookupScoped<T>(
  table: ReadonlyMap<string, T>,
  scopes: Iterable<string>,
  name: string,
): ScopedHit<T> | undefined {
  for (const scope of scopes) {
    const value = table.get(scopedKey(scope, name));
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
  const scopedTypeToModule = new Map<string, string>();
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
        if (!scopedTypeToModule.has(key)) {
          scopedTypeToModule.set(key, scan.typeModules?.get(type) ?? scan.moduleId);
        }
      }
    }

    for (const [owner, methods] of scan.ownerMethods) {
      const ownerModule = scan.typeModules?.get(owner) ?? scan.moduleId;
      // A scan that declares its types explicitly (typeModules) only claims
      // those; owners it merely implements methods for are skipped here.
      const declared = scan.typeModules ? scan.typeModules.has(owner) : true;
      if (declared && !typeToModule.has(owner)) typeToModule.set(owner, ownerModule);
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
        if (!pkg.has(name)) pkg.set(name, scan.moduleId);
      }
    }
  }

  return {
    typeToModule,
    scopedTypeToModule,
    typeMethods,
    moduleFunctions,
    directoryFunctions,
    moduleIds,
  };
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
    const owner = std.directoryFunctions.get(dirOf(file))?.get(name);
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
 * The driver (design §1.1): build parsers, read each file (unreadable → skip),
 * parse it (null tree → skip), merge by moduleId on demand, then hand the scans
 * to the language's own `extractCalls` and flatten the result.
 *
 * A class rather than a plain object because adapters are constructed with
 * `new` by the registry and by tests.
 */
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

  discover(sourceRoot: string): string[] {
    return discoverByExtension(
      sourceRoot,
      this.spec.extensions,
      this.spec.extraSkipDirs ?? [],
      this.spec.discoverFilter,
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
          source = readFileSync(join(sourceRoot, file), 'utf8');
        } catch {
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
          logger?.debug(`[scan] ${file}: parser failed (${(error as Error).message})`);
          continue;
        }
        if (!tree) continue;
        trees.push(tree);

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

      // Pass 2 runs HERE, inside the try, so its results are computed while the
      // trees its body nodes point into are still alive.
      const std = buildStandardIndexes(scans, spec.idSeparator ?? DEFAULT_SEPARATOR);
      const own = spec.buildIndexes?.(scans, std) as I;
      return {
        functions: scans.flatMap((scan) => scan.functions),
        edges: scans.flatMap((scan) => spec.extractCalls(scan, std, own)),
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
