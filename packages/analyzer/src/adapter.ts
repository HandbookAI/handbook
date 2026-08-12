/**
 * The language-adapter contract and registry.
 *
 * An adapter turns a set of source files into the language-agnostic IR
 * ({@link ModuleAnalysis}); the graph builder does everything downstream.
 * Adding a language = implementing this interface and registering it.
 */
import type { AdapterCapabilities, FunctionNode, ModuleAnalysis } from '@handbooks/core';
import { listFilesRecursive, type Logger } from '@handbooks/core';

/** Directory names skipped by every adapter's discovery. */
export const COMMON_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'out',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
  'venv',
  '.venv',
  'env',
  '.env',
  'site-packages',
  '.idea',
  '.vscode',
  '.handbook-patches',
]);

export interface LanguageAdapter {
  /** Registry key, e.g. `python`. */
  readonly name: string;
  /** File extensions (with dot) this adapter owns. */
  readonly extensions: readonly string[];
  /**
   * What this adapter can actually deliver. Required, not optional: two
   * fidelity tiers coexist in the graph, and a reader cannot tell them apart
   * from nodes and edges alone — so every adapter must say so out loud.
   */
  readonly capabilities: AdapterCapabilities;
  /**
   * Find analyzable files under `sourceRoot` (relative POSIX paths, sorted).
   *
   * The optional logger reports directories discovery could not enter. Without
   * it every path beneath an unreadable directory simply disappears, and
   * nothing downstream can tell that apart from "there was nothing there" —
   * the same silent-erasure defect the unparsed-file record exists to prevent.
   */
  discover(sourceRoot: string, options?: { logger?: Logger }): string[];
  /** Parse `files` (relative POSIX paths) into the IR. */
  /**
   * Parse `files` into the IR. The optional logger lets a driver report files
   * it had to skip — a grammar can fail, and a silently shorter handbook is
   * worse than one that says what it could not read.
   */
  analyze(
    files: readonly string[],
    sourceRoot: string,
    options?: { logger?: Logger },
  ): Promise<ModuleAnalysis>;
  /**
   * 1-based inclusive statement spans inside the named function — legal snap
   * boundaries for resync. Undefined = unsupported for this language.
   */
  statementSpans?(filePath: string, qualname: string): Promise<Array<[number, number]> | undefined>;
}

/** Default discovery: by extension, skipping {@link COMMON_SKIP_DIRS}. */
export function discoverByExtension(
  sourceRoot: string,
  extensions: readonly string[],
  extraSkipDirs: readonly string[] = [],
  filter?: (relPath: string) => boolean,
  logger?: Logger,
): string[] {
  const skipDirs = new Set([...COMMON_SKIP_DIRS, ...extraSkipDirs]);
  return listFilesRecursive(sourceRoot, {
    skipDirs,
    extensions,
    filter,
    onSkip: (path, reason) => logger?.warn(`[scan] ${path}/: not searched (${reason})`),
  });
}

/**
 * Collapse functions that share an id — redefinitions (`def f` twice) and
 * typing `@overload` stubs — to a single node, keeping the LAST definition (the
 * one live at runtime, e.g. the real `@overload` implementation). Node ids are
 * required to be globally unique; without this a single logical function emits
 * duplicate nodes AND its call edges are multiplied, since a pass-2 walk looks
 * up the shared body by id once per duplicate.
 */
export function dedupeFunctionsById(functions: readonly FunctionNode[]): FunctionNode[] {
  const lastIndex = new Map<string, number>();
  functions.forEach((fn, i) => lastIndex.set(fn.id, i));
  return functions.filter((fn, i) => lastIndex.get(fn.id) === i);
}

const registry = new Map<string, () => LanguageAdapter>();
const instances = new Map<string, LanguageAdapter>();

export function registerAdapter(name: string, factory: () => LanguageAdapter): void {
  registry.set(name, factory);
}

export function getAdapter(name: string): LanguageAdapter {
  let instance = instances.get(name);
  if (!instance) {
    const factory = registry.get(name);
    if (!factory) {
      throw new Error(`unknown language "${name}" — registered: ${availableLanguages().join(', ')}`);
    }
    instance = factory();
    instances.set(name, instance);
  }
  return instance;
}

export function availableLanguages(): string[] {
  return [...registry.keys()].sort();
}

/** The adapter owning a file, by extension (longest-extension match wins). */
export function adapterForFile(relPath: string): LanguageAdapter | undefined {
  let best: LanguageAdapter | undefined;
  let bestLen = 0;
  for (const name of registry.keys()) {
    const adapter = getAdapter(name);
    for (const ext of adapter.extensions) {
      if (relPath.endsWith(ext) && ext.length > bestLen) {
        best = adapter;
        bestLen = ext.length;
      }
    }
  }
  return best;
}

/** Discover files for every registered language (only languages with ≥1 file). */
export function discoverAll(
  sourceRoot: string,
  logger?: { warn(message: string): void },
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const claimed = new Set<string>();
  for (const name of availableLanguages()) {
    try {
      const files = getAdapter(name)
        .discover(sourceRoot, { logger: logger as Logger | undefined })
        .filter((f) => !claimed.has(f));
      if (files.length > 0) {
        result[name] = files;
        for (const f of files) claimed.add(f);
      }
    } catch (err) {
      // a broken adapter must not break multi-language discovery — but say so
      logger?.warn(
        `[scan] ${name} adapter failed during discovery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}
