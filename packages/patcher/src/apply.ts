/**
 * Apply parsed EDIT blocks to a source tree.
 *
 * Safety rules, in priority order:
 * 1. **Verify everything, then write in two phases.** The plan is first
 *    resolved against current file contents (one failure aborts the whole
 *    application); the write then stages every file as a temp file and only
 *    renames once all staging succeeded — and if a rename fails midway, the
 *    already-renamed files are restored from the backup taken moments before.
 * 2. **`old` must match byte-exactly and uniquely.** Zero matches means the
 *    code moved on; two or more means the anchor is ambiguous. Both refuse.
 * 3. **Every touched file is backed up with its pre-patch hash**, so rollback
 *    can prove it is restoring the bytes this patch replaced — and refuse when
 *    someone has edited the file since.
 * 4. **No path escapes the source root**, including through symlinked parent
 *    directories on creation, and symlinked targets are never replaced.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { sha256Hex, silentLogger, toPosix, writeJsonFile, type Logger } from '@handbook/core';
import { parsePlan, type EditBlock } from './parse.js';

export type EditStatus =
  | 'applied'
  | 'created'
  | 'no-match'
  | 'ambiguous'
  | 'file-missing'
  | 'not-a-file'
  | 'unsafe-path'
  | 'undecodable'
  | 'skipped';

export interface EditOutcome {
  index: number;
  file: string;
  where: string;
  status: EditStatus;
  /** Populated for failures, and for notable successes (e.g. file emptied). */
  detail?: string;
  /** 1-based line where `old` was found (applied edits only). */
  line?: number;
}

export interface ApplyResult {
  /** True only when every edit landed (or would land, in dry-run). */
  ok: boolean;
  dryRun: boolean;
  outcomes: EditOutcome[];
  /** Files whose bytes actually changed (empty in dry-run). */
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
  /** Where backups + manifests go. Default `<sourceRoot>/.handbook-patches`. */
  backupRoot?: string;
  logger?: Logger;
}

interface ResolvedEdit {
  absolutePath: string;
  /** Full new content of the file after this edit. */
  nextContent: string;
}

/**
 * Resolve a repo-relative path inside `root`, refusing escapes — including via
 * a symlinked parent directory when the file itself does not exist yet.
 */
function safeResolve(root: string, relPath: string): string | undefined {
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, normalize(relPath));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return undefined;
  let realRoot: string;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    return undefined;
  }
  // Realpath the deepest EXISTING ancestor: a missing leaf must not skip the
  // check, or a symlinked directory would let a create escape the root.
  let probe = full;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const suffix = full.slice(probe.length); // '' when probe === full
      const realFull = real + suffix;
      if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) return undefined;
      return full;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

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

/** Read a text file, refusing content that is not valid UTF-8 (lossless round-trip). */
function readTextExact(path: string): { text: string; mode: number } | undefined {
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return undefined;
  return { text, mode: statSync(path).mode };
}

const CRLF = '\r\n';

/** Dominant line ending of a text (CRLF only when it clearly dominates). */
function dominantEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? CRLF : '\n';
}

function toEol(text: string, eol: '\n' | '\r\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === CRLF ? lf.replace(/\n/g, CRLF) : lf;
}

/**
 * Verify a plan against the tree and (unless `dryRun`) apply it atomically.
 * Edits to the same file compose in plan order against the accumulating
 * content, so a plan may touch one file several times — as long as each `old`
 * is still unique at the moment it is applied.
 */
export function applyPlan(options: ApplyOptions): ApplyResult {
  const logger = options.logger ?? silentLogger;
  const dryRun = options.dryRun ?? false;
  const { edits, problems } = parsePlan(options.plan);
  const outcomes: EditOutcome[] = [];
  const resolvedByPath = new Map<string, ResolvedEdit>();
  /** Original on-disk content per file (undefined = did not exist). */
  const originalContent = new Map<string, string | undefined>();
  const modeByPath = new Map<string, number>();
  let ok = problems.length === 0;

  const fail = (edit: EditBlock, status: EditStatus, detail: string): void => {
    outcomes.push({ ...pick(edit), status, detail });
    ok = false;
  };

  for (const edit of edits) {
    const absolutePath = safeResolve(options.sourceRoot, edit.file);
    if (!absolutePath) {
      fail(edit, 'unsafe-path', 'path escapes the source root (directly or through a symlink)');
      continue;
    }

    const creates = edit.oldText === '';
    const known = resolvedByPath.get(absolutePath);
    let current = known?.nextContent;

    if (current === undefined) {
      const stat = existsSync(absolutePath) ? lstatSync(absolutePath) : undefined;
      if (stat?.isSymbolicLink()) {
        fail(edit, 'unsafe-path', 'target is a symlink — refusing to replace the link');
        continue;
      }
      if (stat && !stat.isFile()) {
        fail(edit, 'not-a-file', 'target exists but is not a regular file');
        continue;
      }
      if (stat) {
        const read = readTextExact(absolutePath);
        if (!read) {
          fail(edit, 'undecodable', 'file is not valid UTF-8 — refusing to rewrite it');
          continue;
        }
        current = read.text;
        modeByPath.set(absolutePath, read.mode);
        originalContent.set(absolutePath, read.text);
      } else if (creates) {
        current = '';
        originalContent.set(absolutePath, undefined);
      } else {
        fail(edit, 'file-missing', 'file does not exist');
        continue;
      }
    }

    if (creates) {
      // The "never silently overwrite" guard is judged against the file's
      // ON-DISK state, so an earlier edit in the same plan cannot unlock it.
      const onDisk = originalContent.get(absolutePath);
      if (onDisk !== undefined && onDisk !== '') {
        fail(edit, 'no-match', 'empty `old` means "create", but the file already has content');
        continue;
      }
      const existed = onDisk !== undefined;
      resolvedByPath.set(absolutePath, { absolutePath, nextContent: edit.newText });
      outcomes.push({
        ...pick(edit),
        status: existed ? 'applied' : 'created',
        line: 1,
        detail: existed ? 'filled a previously empty file' : undefined,
      });
      continue;
    }

    // Match byte-exactly; if that fails, retry once with the file's own line
    // endings so an LF plan still applies to a CRLF file (and vice versa).
    let oldText = edit.oldText;
    let newText = edit.newText;
    let hits = countOccurrences(current, oldText);
    if (hits === 0) {
      const eol = dominantEol(current);
      const oldEol = toEol(oldText, eol);
      if (oldEol !== oldText && countOccurrences(current, oldEol) > 0) {
        oldText = oldEol;
        newText = toEol(newText, eol);
        hits = countOccurrences(current, oldText);
      }
    }
    if (hits === 0) {
      fail(edit, 'no-match', 'the `old` text is not present — the code changed since the plan was made');
      continue;
    }
    if (hits > 1) {
      fail(edit, 'ambiguous', `the \`old\` text appears ${hits} times — needs more context to be unique`);
      continue;
    }

    const at = current.indexOf(oldText);
    const next = current.slice(0, at) + newText + current.slice(at + oldText.length);
    resolvedByPath.set(absolutePath, { absolutePath, nextContent: next });
    outcomes.push({
      ...pick(edit),
      status: 'applied',
      line: lineOfOffset(current, at),
      detail: newText === '' ? 'removed the matched text' : undefined,
    });
  }

  if (!ok) {
    for (const outcome of outcomes) {
      if (outcome.status === 'applied' || outcome.status === 'created') {
        outcome.status = 'skipped';
        outcome.detail = 'not applied — another edit in the plan failed verification';
      }
    }
    const failures = outcomes.filter((o) => o.status !== 'skipped').length;
    for (const problem of problems) logger.warn(`[patch] ${problem}`);
    logger.warn(`[patch] refusing to write: ${failures} edit(s) failed, ${problems.length} plan problem(s)`);
    return { ok: false, dryRun, outcomes, changedFiles: [], problems };
  }

  if (dryRun) {
    logger.info(`[patch] dry-run: ${resolvedByPath.size} file(s) would change cleanly`);
    return { ok: true, dryRun: true, outcomes, changedFiles: [], problems };
  }

  // ---- write phase ----
  // Files whose content is unchanged (e.g. two cancelling edits) are not written.
  const pending = [...resolvedByPath.values()].filter(
    (item) => originalContent.get(item.absolutePath) !== item.nextContent,
  );
  if (pending.length === 0) {
    logger.info('[patch] every edit cancels out — no file content changed');
    return { ok: true, dryRun: false, outcomes, changedFiles: [], problems };
  }

  const backupRoot = options.backupRoot ?? join(resolve(options.sourceRoot), '.handbook-patches');
  const backupDir = createStampDir(backupRoot);
  const manifest: Array<{ file: string; existed: boolean; sha256Before?: string; sha256After?: string }> = [];
  for (const item of pending) {
    const rel = toPosix(relative(resolve(options.sourceRoot), item.absolutePath));
    const before = originalContent.get(item.absolutePath);
    if (before !== undefined) {
      const backupPath = join(backupDir, 'files', rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      copyFileSync(item.absolutePath, backupPath);
      manifest.push({
        file: rel,
        existed: true,
        sha256Before: sha256Hex(before),
        sha256After: sha256Hex(item.nextContent),
      });
    } else {
      manifest.push({ file: rel, existed: false, sha256After: sha256Hex(item.nextContent) });
    }
  }
  writeJsonFile(join(backupDir, 'manifest.json'), {
    version: 1,
    at: new Date().toISOString(),
    sourceRoot: resolve(options.sourceRoot),
    files: manifest,
  });

  // Stage every file as a temp sibling first; only rename once all staged.
  const staged: Array<{ tmp: string; target: string }> = [];
  try {
    for (const item of pending) {
      mkdirSync(dirname(item.absolutePath), { recursive: true });
      const tmp = `${item.absolutePath}.handbook-tmp-${process.pid}-${staged.length}`;
      writeFileSync(tmp, item.nextContent, 'utf8');
      staged.push({ tmp, target: item.absolutePath });
    }
  } catch (error) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw error;
  }

  const renamed: string[] = [];
  try {
    for (const { tmp, target } of staged) {
      renameSync(tmp, target);
      renamed.push(target);
      const mode = modeByPath.get(target);
      if (mode !== undefined) chmodSync(target, mode & 0o7777); // preserve the executable bit
    }
  } catch (error) {
    // Restore what already landed, then clean the rest, so the tree is never
    // left half-patched.
    for (const target of renamed) {
      const rel = toPosix(relative(resolve(options.sourceRoot), target));
      const entry = manifest.find((m) => m.file === rel);
      if (entry?.existed) copyFileSync(join(backupDir, 'files', rel), target);
      else rmSync(target, { force: true });
    }
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    logger.error(`[patch] write failed and was rolled back: ${String(error)}`);
    throw error;
  }

  const changedFiles = pending
    .map((item) => toPosix(relative(resolve(options.sourceRoot), item.absolutePath)))
    .sort();
  logger.info(`[patch] applied ${edits.length} edit(s) across ${changedFiles.length} file(s)`);
  return { ok: true, dryRun: false, outcomes, changedFiles, backupDir, problems };
}

/** Create a fresh timestamped directory, never reusing an existing one. */
function createStampDir(backupRoot: string): string {
  mkdirSync(backupRoot, { recursive: true });
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; ; attempt += 1) {
    const candidate = join(backupRoot, attempt === 0 ? base : `${base}-${attempt}`);
    try {
      mkdirSync(candidate); // non-recursive: EEXIST means "pick another name"
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 500) throw error;
    }
  }
}

function pick(edit: EditBlock): Pick<EditOutcome, 'index' | 'file' | 'where'> {
  return { index: edit.index, file: edit.file, where: edit.where };
}

export interface RollbackResult {
  restored: string[];
  removed: string[];
  /** Files skipped because they changed after the patch (unless `force`). */
  skipped: Array<{ file: string; reason: string }>;
}

export interface RollbackOptions {
  /** Restore even when the file changed after the patch. Default false. */
  force?: boolean;
  logger?: Logger;
}

interface Manifest {
  sourceRoot: string;
  files: Array<{ file: string; existed: boolean; sha256Before?: string; sha256After?: string }>;
}

/** Read + validate a backup manifest, refusing anything that could write outside its root. */
function readManifest(backupDir: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('backup manifest is not an object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sourceRoot !== 'string' || !obj.sourceRoot.startsWith('/')) {
    throw new Error('backup manifest has no absolute sourceRoot');
  }
  if (!Array.isArray(obj.files)) throw new Error('backup manifest has no files array');
  const rootAbs = resolve(obj.sourceRoot);
  const files: Manifest['files'] = [];
  for (const entry of obj.files) {
    if (typeof entry !== 'object' || entry === null) throw new Error('malformed manifest entry');
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === 'string' ? e.file : '';
    if (!file || file.startsWith('/') || file.includes('\\')) throw new Error(`unsafe manifest path: ${file}`);
    const target = resolve(rootAbs, normalize(file));
    if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
      throw new Error(`manifest path escapes its source root: ${file}`);
    }
    files.push({
      file,
      existed: e.existed === true,
      sha256Before: typeof e.sha256Before === 'string' ? e.sha256Before : undefined,
      sha256After: typeof e.sha256After === 'string' ? e.sha256After : undefined,
    });
  }
  return { sourceRoot: rootAbs, files };
}

/**
 * Restore a source tree from a backup directory produced by {@link applyPlan}.
 * A file whose current bytes differ from what the patch wrote is left alone
 * (someone edited it since) unless `force` is set.
 */
export function rollback(backupDir: string, options: RollbackOptions = {}): RollbackResult {
  const logger = options.logger ?? silentLogger;
  const manifest = readManifest(backupDir);
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: RollbackResult['skipped'] = [];

  for (const entry of manifest.files) {
    const target = join(manifest.sourceRoot, entry.file);
    const currentHash = existsSync(target) ? sha256Hex(readFileSync(target)) : undefined;

    if (!options.force && entry.sha256After && currentHash && currentHash !== entry.sha256After) {
      skipped.push({ file: entry.file, reason: 'changed after the patch — pass force to overwrite' });
      continue;
    }
    if (entry.existed) {
      const backupPath = join(backupDir, 'files', entry.file);
      if (!existsSync(backupPath)) {
        skipped.push({ file: entry.file, reason: 'backup copy missing' });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.handbook-rollback-${process.pid}`;
      copyFileSync(backupPath, tmp);
      renameSync(tmp, target);
      restored.push(entry.file);
    } else {
      if (currentHash === undefined) {
        skipped.push({ file: entry.file, reason: 'already absent' });
        continue;
      }
      rmSync(target, { force: true });
      removed.push(entry.file);
    }
  }
  logger.info(
    `[patch] rolled back ${restored.length} file(s), removed ${removed.length} created file(s), skipped ${skipped.length}`,
  );
  return { restored, removed, skipped };
}

/** Backup stamps under `backupRoot` with a readable, valid manifest, newest first. */
export function listBackups(backupRoot: string): string[] {
  try {
    return readdirSync(backupRoot)
      .filter((stamp) => {
        try {
          readManifest(join(backupRoot, stamp));
          return true;
        } catch {
          return false;
        }
      })
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
