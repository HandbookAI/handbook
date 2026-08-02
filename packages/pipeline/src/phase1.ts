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
import type { ModuleAnalysis } from '@handbook/core';
import { ensureDir, silentLogger, type Logger } from '@handbook/core';
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
  files: number;
  functions: number;
  edgesKept: number;
  edgesDropped: number;
}

export async function runPhase1(options: Phase1Options): Promise<Phase1Stats> {
  registerBuiltinAdapters();
  const logger = options.logger ?? silentLogger;
  const lang = options.lang ?? 'auto';
  const work = new WorkDir(options.workDir);

  let language: string;
  let scannedFiles: string[];
  const analyses: ModuleAnalysis[] = [];

  if (lang === 'auto') {
    const byLanguage = discoverAll(options.sourceRoot);
    const languages = Object.keys(byLanguage);
    if (languages.length === 0) {
      throw new Error(`no analyzable files found under ${options.sourceRoot}`);
    }
    logger.info(`[scan] auto root=${options.sourceRoot}`);
    scannedFiles = [];
    for (const [name, files] of Object.entries(byLanguage)) {
      logger.info(`[scan] ${name}: ${files.length} files`);
      analyses.push(await getAdapter(name).analyze(files, options.sourceRoot));
      scannedFiles.push(...files);
    }
    scannedFiles.sort();
    language = languages.length === 1 ? (languages[0] ?? 'multi') : 'multi';
  } else {
    const adapter = getAdapter(lang);
    scannedFiles = options.files?.length ? [...options.files] : adapter.discover(options.sourceRoot);
    if (scannedFiles.length === 0) {
      throw new Error(`no ${lang} files found under ${options.sourceRoot}`);
    }
    logger.info(`[scan] lang=${lang} root=${options.sourceRoot}`);
    logger.info(`[scan] ${scannedFiles.length} files`);
    analyses.push(await adapter.analyze(scannedFiles, options.sourceRoot));
    language = lang;
  }

  const merged: ModuleAnalysis = {
    functions: analyses.flatMap((a) => a.functions),
    edges: analyses.flatMap((a) => a.edges),
  };
  const result = buildGraph(merged, {
    sourceRoot: options.sourceRoot,
    scannedFiles,
    language,
  });
  ensureDir(work.phase1Dir);
  writeGraphArtifacts(result, work.phase1Dir);
  logger.info(
    `[build] functions=${result.stats.functions} kept=${result.stats.edgesKept} dropped=${result.stats.edgesDropped}`,
  );
  return {
    language,
    files: scannedFiles.length,
    functions: result.stats.functions,
    edgesKept: result.stats.edgesKept,
    edgesDropped: result.stats.edgesDropped,
  };
}
