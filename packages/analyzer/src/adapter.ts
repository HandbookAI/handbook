/**
 * The language-adapter contract and registry.
 *
 * An adapter turns a set of source files into the language-agnostic IR
 * ({@link ModuleAnalysis}); the graph builder does everything downstream.
 * Adding a language = implementing this interface and registering it.
 */
import type { FunctionNode, ModuleAnalysis } from '@handbook/core';
import { listFilesRecursive } from '@handbook/core';

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
  /** Find analyzable files under `sourceRoot` (relative POSIX paths, sorted). */
  discover(sourceRoot: string): string[];
  /** Parse `files` (relative POSIX paths) into the IR. */
  analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis>;
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
): string[] {
  const skipDirs = new Set([...COMMON_SKIP_DIRS, ...extraSkipDirs]);
  return listFilesRecursive(sourceRoot, { skipDirs, extensions, filter });
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
        .discover(sourceRoot)
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
