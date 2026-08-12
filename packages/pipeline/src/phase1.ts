/**
 * Phase 1 — static call-graph extraction. Pure and deterministic: no LLM.
 */
import {
  buildGraph,
  discoverAll,
  getAdapter,
  registerBuiltinAdapters,
  writeGraphArtifacts,
} from '@handbook/analyzer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterCapabilities, ModuleAnalysis, UnparsedFile } from '@handbook/core';
import {
  adapterCapabilitiesSchema,
  ensureDir,
  sha256Hex,
  silentLogger,
  withDirLock,
  type Logger,
} from '@handbook/core';
import { WorkDir } from './workdir.js';

export interface Phase1Options {
  sourceRoot: string;
  workDir: string;
  /** `auto` (default) detects and merges every registered language. */
  lang?: string;
  /** Explicit file list (relative POSIX paths); empty = adapter discovery. */
  files?: readonly string[];
  logger?: Logger;
}

export interface Phase1Stats {
  language: string;
  /** Files that reached the graph — discovered minus unreadable/unparsable. */
  files: number;
  functions: number;
  edgesKept: number;
  edgesDropped: number;
  /** Files recorded in `scan-coverage.json` (unreadable, unparsable, partial). */
  filesUnparsed: number;
}

/**
 * Read an adapter's fidelity declaration without requiring one.
 *
 * A declaration is a promise about what the analysis contains, so it is taken
 * only when it is actually there and actually well-formed: adapters can be
 * registered by anyone (`registerAdapter`), and a hand-rolled or half-migrated
 * one may declare nothing, or declare junk. Both must leave the language out of
 * the graph rather than invent a fidelity claim, or write a `graph.json` that
 * fails its own schema on the next read.
 */
function declaredCapabilities(adapter: unknown): AdapterCapabilities | undefined {
  if (typeof adapter !== 'object' || adapter === null || !('capabilities' in adapter)) return undefined;
  const parsed = adapterCapabilitiesSchema.safeParse(adapter.capabilities);
  return parsed.success ? parsed.data : undefined;
}

export async function runPhase1(options: Phase1Options): Promise<Phase1Stats> {
  // Re-entrant: generateHandbook already holds this lock when it calls us.
  return withDirLock(options.workDir, 'handbook', options.logger ?? silentLogger, () =>
    runPhase1Locked(options),
  );
}

async function runPhase1Locked(options: Phase1Options): Promise<Phase1Stats> {
  registerBuiltinAdapters();
  const logger = options.logger ?? silentLogger;
  const lang = options.lang ?? 'auto';
  const work = new WorkDir(options.workDir);

  let language: string;
  let scannedFiles: string[];
  const analyses: ModuleAnalysis[] = [];
  // Fidelity is per language, not per graph: a multi-language run mixes
  // hand-written and generic-tier analyses, and only this loop knows which
  // adapter produced which language's facts.
  const languages: Record<string, AdapterCapabilities> = {};

  if (lang === 'auto') {
    const byLanguage = discoverAll(options.sourceRoot, logger);
    const discovered = Object.keys(byLanguage);
    if (discovered.length === 0) {
      throw new Error(`no analyzable files found under ${options.sourceRoot}`);
    }
    logger.info(`[scan] auto root=${options.sourceRoot}`);
    scannedFiles = [];
    for (const [name, files] of Object.entries(byLanguage)) {
      logger.info(`[scan] ${name}: ${files.length} files`);
      const adapter = getAdapter(name);
      analyses.push(await adapter.analyze(files, options.sourceRoot, { logger }));
      const capabilities = declaredCapabilities(adapter);
      if (capabilities) languages[name] = capabilities;
      scannedFiles.push(...files);
    }
    scannedFiles.sort();
    language = discovered.length === 1 ? (discovered[0] ?? 'multi') : 'multi';
  } else {
    const adapter = getAdapter(lang);
    scannedFiles = options.files?.length ? [...options.files] : adapter.discover(options.sourceRoot);
    if (scannedFiles.length === 0) {
      throw new Error(`no ${lang} files found under ${options.sourceRoot}`);
    }
    logger.info(`[scan] lang=${lang} root=${options.sourceRoot}`);
    logger.info(`[scan] ${scannedFiles.length} files`);
    analyses.push(await adapter.analyze(scannedFiles, options.sourceRoot, { logger }));
    const capabilities = declaredCapabilities(adapter);
    if (capabilities) languages[lang] = capabilities;
    language = lang;
  }

  // `types` is undefined unless at least ONE analysis produced an array. A
  // multi-language run where only the TypeScript adapter extracts types must
  // still record the TypeScript ones, while a run of nothing but Ruby must leave
  // the field off entirely rather than write `[]` — that empty array would read
  // as "looked, found none" for a language nobody looked at.
  const analysedTypes = analyses.filter((a) => a.types !== undefined);
  const merged: ModuleAnalysis = {
    functions: analyses.flatMap((a) => a.functions),
    edges: analyses.flatMap((a) => a.edges),
    unparsedFiles: analyses.flatMap((a) => a.unparsedFiles ?? []),
    types: analysedTypes.length > 0 ? analysedTypes.flatMap((a) => a.types ?? []) : undefined,
  };
  const unparsedFiles: UnparsedFile[] = merged.unparsedFiles ?? [];
  // A file that yielded NO facts must not be listed as scanned. `scannedFiles`
  // is what `allFileDescriptors` widens the card list with, so leaving an
  // unreadable path in it makes the cards pass write a card for it and
  // `_coverage.json` count it as described — the handbook then states, as a
  // parser fact, that a file it never opened has zero functions. Dropping it
  // here (rather than filtering the card list later) keeps one file list
  // meaning one thing: "the analyzer read this and these are its facts".
  // Partially parsed files stay: their facts are real, merely incomplete, and
  // `scan-coverage.json` is where that is disclosed.
  const noFacts = new Set(
    unparsedFiles.filter((entry) => entry.reason !== 'partial').map((entry) => entry.file),
  );
  if (noFacts.size > 0) scannedFiles = scannedFiles.filter((file) => !noFacts.has(file));
  const defaultExt = language === 'multi' ? '' : (getAdapter(language).extensions[0] ?? '');
  const fileHashes: Record<string, string> = {};
  for (const file of scannedFiles) {
    try {
      fileHashes[file] = sha256Hex(readFileSync(join(options.sourceRoot, file)));
    } catch {
      // unreadable files simply have no hash; resync falls back to structure
    }
  }
  const result = buildGraph(merged, {
    sourceRoot: options.sourceRoot,
    scannedFiles,
    language,
    defaultExt,
    fileHashes,
    unparsedFiles,
  });
  // Stamped here rather than inside buildGraph: the builder is handed ONE merged
  // analysis and is language-agnostic by design, so the per-language map is
  // knowledge only this function has. Left off entirely when nothing was
  // declared — an empty map would read as "asked, and there is no fidelity".
  if (Object.keys(languages).length > 0) result.graph.metadata.languages = languages;
  ensureDir(work.phase1Dir);
  writeGraphArtifacts(result, work.phase1Dir);
  logger.info(
    `[build] functions=${result.stats.functions} kept=${result.stats.edgesKept} dropped=${result.stats.edgesDropped}` +
      // Named only when some adapter looked, so a silent `types=0` never implies
      // "this codebase declares none".
      (result.stats.types === undefined ? '' : ` types=${result.stats.types}`),
  );
  // The closing line of phase 1 says what the phase could NOT do, in the same
  // breath as what it did. A silent scan and a scan that lost a tenth of the
  // repository used to end identically.
  const byReason = result.scanCoverage.metadata.byReason;
  logger.info(
    unparsedFiles.length === 0
      ? `[scan] coverage: ${scannedFiles.length}/${scannedFiles.length} files parsed cleanly`
      : `[scan] coverage: ${scannedFiles.length} files analyzed; ${unparsedFiles.length} recorded in ` +
          `scan-coverage.json (${Object.entries(byReason)
            .map(([reason, n]) => `${reason}=${n}`)
            .sort()
            .join(' ')})`,
  );
  return {
    language,
    files: scannedFiles.length,
    functions: result.stats.functions,
    edgesKept: result.stats.edgesKept,
    edgesDropped: result.stats.edgesDropped,
    filesUnparsed: result.stats.filesUnparsed,
  };
}
