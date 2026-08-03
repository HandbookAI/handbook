/**
 * Apply parsed EDIT blocks to a source tree.
 *
 * Safety rules, in priority order:
 * 1. **Nothing is written until every edit verifies.** The whole plan is
 *    resolved against the current file contents first; one failure aborts the
 *    entire application (all-or-nothing).
 * 2. **`old` must match byte-exactly and uniquely.** Zero matches means the
 *    code moved on; two or more means the anchor is ambiguous. Both refuse.
 * 3. **Every touched file is backed up first**, so a rollback restores the
 *    exact prior bytes even if the process dies mid-write.
 * 4. **No path escapes the source root**, and no symlink is followed out of it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { sha256Hex, silentLogger, toPosix, writeFileAtomic, writeJsonFile, type Logger } from '@handbook/core';
import { parsePlan, type EditBlock } from './parse.js';

export type EditStatus = 'applied' | 'created' | 'no-match' | 'ambiguous' | 'file-missing' | 'unsafe-path' | 'skipped';

export interface EditOutcome {
  index: number;
  file: string;
  where: string;
  status: EditStatus;
  /** Populated for failures. */
  detail?: string;
  /** 1-based line where `old` was found (applied edits only). */
  line?: number;
}

export interface ApplyResult {
  /** True only when every edit landed (or would land, in dry-run). */
  ok: boolean;
  dryRun: boolean;
  outcomes: EditOutcome[];
  /** Files written (empty in dry-run). */
  changedFiles: string[];
  /** Backup directory that `rollback` consumes (undefined in dry-run). */
  backupDir?: string;
  problems: string[];
}

export interface ApplyOptions {
  /** Root of the tree being edited. */
  sourceRoot: string;
  /** The plan text (as produced by the planner). */
  plan: string;
  /** Verify only — never write. Default false. */
  dryRun?: boolean;
  /** Where backups + manifest go. Default `<sourceRoot>/../.handbook-patches`. */
  backupRoot?: string;
  logger?: Logger;
}

interface ResolvedEdit {
  edit: EditBlock;
  absolutePath: string;
  /** Full new content of the file after this edit. */
  nextContent: string;
  line: number;
  creates: boolean;
}

/** Resolve a repo-relative path inside `root`, refusing escapes and out-of-root symlinks. */
function safeResolve(root: string, relPath: string): string | undefined {
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, normalize(relPath));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return undefined;
  // A symlinked target must not lead out of the root either. Both sides go
  // through realpath — on macOS the root itself often sits behind a symlink
  // (/var → /private/var), and comparing a resolved path against an
  // unresolved root would reject every legitimate file.
  try {
    const realRoot = realpathSync(rootAbs);
    const real = realpathSync(full);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  } catch {
    // the file does not exist yet (creation) — the prefix check above suffices
  }
  return full;
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * Verify a plan against the tree and (unless `dryRun`) apply it atomically.
 * Edits to the same file are applied in plan order against the accumulating
 * content, so a plan may touch one file several times — as long as each `old`
 * is still unique at the moment it is applied.
 */
export function applyPlan(options: ApplyOptions): ApplyResult {
  const logger = options.logger ?? silentLogger;
  const dryRun = options.dryRun ?? false;
  const { edits, problems } = parsePlan(options.plan);
  const outcomes: EditOutcome[] = [];
  const resolved: ResolvedEdit[] = [];
  /** Working copy per file, so multiple edits to one file compose. */
  const working = new Map<string, string>();
  let ok = problems.length === 0;

  for (const edit of edits) {
    const absolutePath = safeResolve(options.sourceRoot, edit.file);
    if (!absolutePath) {
      outcomes.push({ ...pick(edit), status: 'unsafe-path', detail: 'path escapes the source root' });
      ok = false;
      continue;
    }

    const creates = edit.oldText === '';
    let current = working.get(absolutePath);
    if (current === undefined) {
      if (existsSync(absolutePath)) current = readFileSync(absolutePath, 'utf8');
      else if (creates) current = '';
      else {
        outcomes.push({ ...pick(edit), status: 'file-missing', detail: 'file does not exist' });
        ok = false;
        continue;
      }
    }

    if (creates) {
      if (current !== '' && !working.has(absolutePath)) {
        outcomes.push({
          ...pick(edit),
          status: 'no-match',
          detail: 'empty `old` means "create", but the file already has content',
        });
        ok = false;
        continue;
      }
      working.set(absolutePath, edit.newText);
      resolved.push({ edit, absolutePath, nextContent: edit.newText, line: 1, creates: true });
      outcomes.push({ ...pick(edit), status: 'created', line: 1 });
      continue;
    }

    const hits = countOccurrences(current, edit.oldText);
    if (hits === 0) {
      outcomes.push({
        ...pick(edit),
        status: 'no-match',
        detail: 'the `old` text is not present — the code changed since the plan was made',
      });
      ok = false;
      continue;
    }
    if (hits > 1) {
      outcomes.push({
        ...pick(edit),
        status: 'ambiguous',
        detail: `the \`old\` text appears ${hits} times — needs more context to be unique`,
      });
      ok = false;
      continue;
    }

    const at = current.indexOf(edit.oldText);
    const next = current.slice(0, at) + edit.newText + current.slice(at + edit.oldText.length);
    working.set(absolutePath, next);
    const line = lineOfOffset(current, at);
    resolved.push({ edit, absolutePath, nextContent: next, line, creates: false });
    outcomes.push({ ...pick(edit), status: 'applied', line });
  }

  if (!ok) {
    // Mark verified-but-unapplied edits honestly: nothing was written.
    for (const outcome of outcomes) {
      if (outcome.status === 'applied' || outcome.status === 'created') {
        outcome.status = 'skipped';
        outcome.detail = 'not applied — another edit in the plan failed verification';
      }
    }
    logger.warn(`[patch] refusing to write: ${outcomes.filter((o) => o.status !== 'skipped').length} edit(s) failed`);
    return { ok: false, dryRun, outcomes, changedFiles: [], problems };
  }

  if (dryRun) {
    logger.info(`[patch] dry-run: ${resolved.length} edit(s) would apply cleanly`);
    return { ok: true, dryRun: true, outcomes, changedFiles: [], problems };
  }

  // ---- write phase: back up every target, then write ----
  const backupRoot = options.backupRoot ?? join(dirname(resolve(options.sourceRoot)), '.handbook-patches');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(backupRoot, stamp);
  const finalContent = new Map<string, string>();
  for (const item of resolved) finalContent.set(item.absolutePath, item.nextContent);

  const manifest: Array<{ file: string; existed: boolean; sha256Before?: string }> = [];
  for (const absolutePath of finalContent.keys()) {
    const rel = toPosix(relative(resolve(options.sourceRoot), absolutePath));
    const existed = existsSync(absolutePath);
    if (existed) {
      const backupPath = join(backupDir, 'files', rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(absolutePath, backupPath);
      manifest.push({ file: rel, existed, sha256Before: sha256Hex(readFileSync(absolutePath)) });
    } else {
      manifest.push({ file: rel, existed: false });
    }
  }
  writeJsonFile(join(backupDir, 'manifest.json'), {
    version: 1,
    at: new Date().toISOString(),
    sourceRoot: resolve(options.sourceRoot),
    files: manifest,
  });

  const changedFiles: string[] = [];
  for (const [absolutePath, content] of finalContent) {
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileAtomic(absolutePath, content);
    changedFiles.push(toPosix(relative(resolve(options.sourceRoot), absolutePath)));
  }
  changedFiles.sort();
  logger.info(`[patch] applied ${resolved.length} edit(s) across ${changedFiles.length} file(s)`);
  return { ok: true, dryRun: false, outcomes, changedFiles, backupDir, problems };
}

function pick(edit: EditBlock): Pick<EditOutcome, 'index' | 'file' | 'where'> {
  return { index: edit.index, file: edit.file, where: edit.where };
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
}

/** Restore a source tree from a backup directory produced by {@link applyPlan}. */
export function rollback(backupDir: string, logger: Logger = silentLogger): RollbackResult {
  const manifestPath = join(backupDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sourceRoot: string;
    files: Array<{ file: string; existed: boolean }>;
  };
  const restored: string[] = [];
  const removed: string[] = [];
  for (const entry of manifest.files) {
    const target = join(manifest.sourceRoot, entry.file);
    if (entry.existed) {
      const backupPath = join(backupDir, 'files', entry.file);
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.rollback-${process.pid}`;
      copyFileSync(backupPath, tmp);
      renameSync(tmp, target);
      restored.push(entry.file);
    } else {
      rmSync(target, { force: true });
      removed.push(entry.file);
    }
  }
  logger.info(`[patch] rolled back ${restored.length} file(s), removed ${removed.length} created file(s)`);
  return { restored, removed };
}

/** Backup directories under `backupRoot`, newest first. */
export function listBackups(backupRoot: string): string[] {
  try {
    return readdirSync(backupRoot)
      .filter((d) => existsSync(join(backupRoot, d, 'manifest.json')))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Written for callers that want to persist a result next to the backup. */
export function writeApplyReport(backupDir: string, result: ApplyResult): void {
  writeFileSync(join(backupDir, 'apply-report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
