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
 *    directories on creation, and symlinked targets are never replaced. The
 *    check is made on the RESOLVED real path on both sides: apply and rollback.
 * 5. **Nothing on the write path follows a symlink.** Staging names are
 *    unguessable and created exclusively, so a pre-planted link cannot redirect
 *    the bytes, and the final `rename` replaces a link rather than writing
 *    through it.
 */
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  isAbsoluteAnyPlatform,
  sha256Hex,
  silentLogger,
  toPosix,
  writeJsonFile,
  type Logger,
} from '@handbook/core';
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

/** realpath when possible, else the input (missing paths compare literally). */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Is `path` `root` itself, or inside it? Compared case-INSENSITIVELY as well as
 * exactly, because macOS and Windows ship case-folding filesystems by default:
 * there `.HANDBOOK-PATCHES/x` and `.handbook-patches/x` are one file, and a
 * case-sensitive `startsWith` waved the first spelling past a guard written for
 * the second. Over-refusing a genuinely distinct casing on a case-sensitive
 * volume costs a rename; letting a patch into the backup tree costs the ability
 * to roll back at all.
 */
function isInside(root: string, path: string): boolean {
  const under = (a: string, b: string): boolean => b === a || b.startsWith(a + sep);
  return under(root, path) || under(root.toLowerCase(), path.toLowerCase());
}

/**
 * A staging name nobody outside this process can predict.
 *
 * `<target>.handbook-tmp-<pid>-<n>` was guessable, and `writeFileSync` follows a
 * symlink at the path it is given — so anyone able to create a file next to the
 * target could point the patch's bytes at any file the user can write, and the
 * rename that followed then moved the LINK over the source file. The token
 * removes the guess; the `wx` flag below (`O_CREAT|O_EXCL`) removes the follow
 * even if the name leaks, because `O_EXCL` refuses an existing path outright,
 * dangling symlink included.
 */
function stagingSuffix(): string {
  return randomBytes(9).toString('hex');
}

/**
 * Move `tmp` over `target`, even when `target` itself is read-only.
 *
 * A rename needs a writable PARENT directory — on POSIX, where the replaced
 * file's own mode is irrelevant. Windows also consults the destination's
 * read-only attribute and refuses with EPERM, so a single `mode 444` file in the
 * tree failed the entire apply there while the same plan applied cleanly
 * everywhere else, and the caller was handed a raw errno rather than an outcome.
 *
 * The write bit is added only after the OS has actually refused, so no platform
 * pays for it on the path where the rename works, and the mode is put back
 * either way: the caller re-applies the mode the verify phase recorded for every
 * target it found on disk, and a second refusal restores it before rethrowing.
 */
function replaceFile(tmp: string, target: string): void {
  try {
    renameSync(tmp, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== 'EPERM' && code !== 'EACCES') || !existsSync(target)) throw error;
  }
  const mode = statSync(target).mode;
  chmodSync(target, mode | 0o200);
  try {
    renameSync(tmp, target);
  } catch (error) {
    chmodSync(target, mode & 0o7777);
    throw error;
  }
}

/**
 * Cross-process exclusive lock for the verify+write window: two `handbook apply`
 * runs on one tree would otherwise interleave and silently lose an edit.
 */
function withTreeLock<T>(sourceRoot: string, logger: Logger, work: () => T): T {
  // The lock identifies the TREE, never the backup location: the studio and the
  // CLI use different backup roots on the same repo and must still exclude each
  // other. `wx` creates the file and its owner record in ONE atomic step, so a
  // waiter can never observe a claimed-but-unlabelled lock.
  const lockDir = join(realpathOr(resolve(sourceRoot)), '.handbook-patches');
  const lockPath = join(lockDir, 'apply.lock');
  try {
    mkdirSync(lockDir, { recursive: true });
    // Keep the lock dir out of the repo's history and out of the analyzer's way.
    const ignore = join(lockDir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
  } catch (error) {
    throw new Error(`cannot prepare ${lockDir}: ${(error as Error).message}`);
  }

  const claim = (): boolean => {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() })}\n`,
        { flag: 'wx' }, // exclusive create: atomic claim + owner record
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`cannot take the patch lock at ${lockPath}: ${(error as Error).message}`);
      }
      return false;
    }
  };

  const readOwner = (): { pid?: number; host?: string; startedAt?: string } | undefined => {
    try {
      const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      return {
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        host: typeof raw.host === 'string' ? raw.host : undefined,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      };
    } catch {
      return undefined; // unreadable or half-written
    }
  };

  /** Is the recorded owner still running? Unknown counts as ALIVE (fail closed). */
  const ownerAlive = (owner: ReturnType<typeof readOwner>): boolean => {
    if (!owner || owner.pid === undefined) return true; // fail closed
    // A pid table is per-machine: a lock claimed on another host (NFS/SMB
    // checkout) can never be probed locally, so it always counts as alive.
    if (owner.host !== undefined && owner.host !== hostname()) return true;
    if (owner.pid === process.pid) return true;
    try {
      process.kill(owner.pid, 0); // signal 0 = liveness probe
      return true;
    } catch (error) {
      // EPERM means the process EXISTS but belongs to another user.
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  };

  if (!claim()) {
    const owner = readOwner();
    if (ownerAlive(owner)) {
      const who =
        owner?.pid !== undefined
          ? ` (pid ${owner.pid}${owner.host ? ` on ${owner.host}` : ''}${owner.startedAt ? `, started ${owner.startedAt}` : ''})`
          : '';
      throw new Error(
        `another patch run is writing to this tree${who} — retry when it finishes, or delete ${lockPath} if that process is gone`,
      );
    }
    // Reclaim a provably dead lock. The exclusive create below is the referee:
    // if a competitor reclaims first, we lose and fail fast rather than share.
    logger.warn('[patch] reclaiming a stale patch lock (its owner is gone)');
    rmSync(lockPath, { force: true });
    if (!claim()) throw new Error('another patch run took the lock while it was being reclaimed');
  }

  try {
    return work();
  } finally {
    rmSync(lockPath, { force: true });
    try {
      // Leave no empty litter behind: a dir holding only our .gitignore has no
      // backups in it. A concurrent claim re-creates (and keeps) the dir.
      const leftover = readdirSync(lockDir);
      if (leftover.length === 0 || (leftover.length === 1 && leftover[0] === '.gitignore')) {
        rmSync(join(lockDir, '.gitignore'), { force: true });
        rmdirSync(lockDir);
      }
    } catch {
      // best-effort tidy-up only
    }
  }
}

/** The first ancestor of `relPath` under `root` that exists but is not a directory. */
function blockingAncestor(root: string, relPath: string): string | undefined {
  // `normalize` hands back NATIVE separators, so on Windows `app/x.py` became
  // `app\x.py`: one segment, `slice(0, -1)` empty, and this guard silently
  // inspected nothing for every nested path. The refusal it owes the caller
  // then arrived as a raw EEXIST thrown out of the write phase instead of a
  // `not-a-file` outcome. Converting back is lossless — a plan path is POSIX by
  // rule (parse.ts rejects a backslash as "must use forward slashes"), and on
  // POSIX a backslash is a legal filename character that must NOT split.
  const parts = toPosix(normalize(relPath))
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  let probe = resolve(root);
  for (const part of parts.slice(0, -1)) {
    probe = join(probe, part);
    let stat;
    try {
      stat = lstatSync(probe);
    } catch {
      return undefined; // does not exist yet — the write phase creates it
    }
    if (!stat.isDirectory()) return toPosix(relative(resolve(root), probe));
  }
  return undefined;
}

function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Count how many distinct positions `needle` can match in `haystack`, counting
 * OVERLAPPING matches (advance by one, not by needle.length). A self-overlapping
 * anchor — `aaa` inside `aaaa`, or `aba` inside `ababa` — genuinely has two
 * candidate positions, so it must read as ambiguous (≥2) and be refused, never
 * silently applied at the first offset.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/** Files above this size are not patch targets (protects memory and sanity). */
const MAX_PATCH_FILE_BYTES = 8 * 1024 * 1024;

/** Read a text file, refusing content that is not valid UTF-8 (lossless round-trip). */
function readTextExact(path: string): { text: string; mode: number } | undefined {
  if (statSync(path).size > MAX_PATCH_FILE_BYTES) return undefined;
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) return undefined;
  return { text, mode: statSync(path).mode };
}

const CRLF = '\r\n';

/**
 * Dominant line ending of a text (CRLF only when it clearly dominates).
 *
 * Counted in a loop rather than with `text.match(/\r\n/g)`: that materialises
 * one string per line ending, so a multi-megabyte file spends hundreds of
 * megabytes of heap to produce two integers.
 */
function dominantEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
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
  // dry-run never writes, so it needs no lock.
  if (options.dryRun) return applyPlanInner(options, logger);
  return withTreeLock(options.sourceRoot, logger, () => applyPlanInner(options, logger));
}

function applyPlanInner(options: ApplyOptions, logger: Logger): ApplyResult {
  const dryRun = options.dryRun ?? false;
  const effectiveBackupRoot = resolve(
    options.backupRoot ?? join(resolve(options.sourceRoot), '.handbook-patches'),
  );
  // Two roots, not one: the tree lock always lives in `<sourceRoot>/.handbook-patches`
  // whatever `backupRoot` says, so pointing backups elsewhere used to leave the
  // lock directory — and any backups a previous default-rooted run left in it —
  // patchable by the plan itself.
  const offLimits = [effectiveBackupRoot, join(resolve(options.sourceRoot), '.handbook-patches')];
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

  /** A rename needs a writable PARENT; the file's own mode is irrelevant. */
  const parentWritable = (absolutePath: string): boolean => {
    let probe = dirname(absolutePath);
    for (;;) {
      if (existsSync(probe)) {
        try {
          accessSync(probe, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      }
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  };

  for (const edit of edits) {
    const absolutePath = safeResolve(options.sourceRoot, edit.file);
    if (!absolutePath) {
      fail(edit, 'unsafe-path', 'path escapes the source root (directly or through a symlink)');
      continue;
    }
    if (offLimits.some((guard) => isInside(guard, absolutePath))) {
      fail(edit, 'unsafe-path', 'target is inside the patch backup tree (or the lock directory beside it)');
      continue;
    }
    const blocked = blockingAncestor(options.sourceRoot, edit.file);
    if (blocked) {
      fail(edit, 'not-a-file', `"${blocked}" is a file, so it cannot contain this path`);
      continue;
    }
    // Checked for creates and edits alike, and in dry-run too.
    if (!parentWritable(absolutePath)) {
      fail(edit, 'unsafe-path', 'the containing directory is not writable');
      continue;
    }

    const creates = edit.oldText === '';
    const known = resolvedByPath.get(absolutePath);
    let current = known?.nextContent;

    if (current === undefined) {
      let stat;
      try {
        stat = lstatSync(absolutePath); // lstat: a DANGLING symlink is still a symlink
      } catch {
        stat = undefined;
      }
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
          fail(
            edit,
            'undecodable',
            `file is not valid UTF-8, or is larger than ${MAX_PATCH_FILE_BYTES / (1024 * 1024)} MiB — refusing to rewrite it`,
          );
          continue;
        }
        current = read.text;
        modeByPath.set(absolutePath, read.mode);
        if ((read.mode & 0o200) === 0) {
          logger.warn(
            `[patch] ${edit.file} is read-only (mode ${(read.mode & 0o777).toString(8)}); its mode is preserved`,
          );
        }
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
      if (known) {
        fail(edit, 'no-match', 'another edit in this plan already writes this file — merge them');
        continue;
      }
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

  // Verification and the write are two separate steps, and the tree lock only
  // excludes other handbook runs — an editor, a formatter or a build script can
  // still save over a target in the window between them. Re-read every file
  // immediately before staging: a byte that moved since verification means the
  // anchor was resolved against content that no longer exists, so writing would
  // destroy someone else's work AND record a `sha256Before` for bytes the
  // backup does not contain, which is how a later rollback restores the wrong
  // thing. Nothing has been written yet, so the honest move is to give up.
  for (const item of pending) {
    const rel = toPosix(relative(resolve(options.sourceRoot), item.absolutePath));
    if (safeResolve(options.sourceRoot, rel) !== item.absolutePath) {
      throw new Error(`${rel} no longer resolves inside the source root since it was verified`);
    }
    const expected = originalContent.get(item.absolutePath);
    let stat;
    try {
      stat = lstatSync(item.absolutePath);
    } catch {
      stat = undefined;
    }
    if (expected === undefined) {
      if (stat) throw new Error(`${rel} appeared on disk since it was verified — refusing to overwrite it`);
      continue;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${rel} changed on disk since it was verified (no longer a plain file)`);
    }
    const now = readTextExact(item.absolutePath);
    if (!now || now.text !== expected) {
      throw new Error(`${rel} changed on disk since it was verified — refusing to overwrite the newer bytes`);
    }
  }

  const backupDir = createStampDir(effectiveBackupRoot);
  const manifest: Array<{ file: string; existed: boolean; sha256Before?: string; sha256After?: string }> = [];
  for (const item of pending) {
    const rel = toPosix(relative(resolve(options.sourceRoot), item.absolutePath));
    const before = originalContent.get(item.absolutePath);
    if (before !== undefined) {
      const backupPath = join(backupDir, 'files', rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      // COPYFILE_EXCL: the stamp dir is brand new, so a destination that
      // already exists is not ours and must never be written through.
      copyFileSync(item.absolutePath, backupPath, constants.COPYFILE_EXCL);
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
      const tmp = `${item.absolutePath}.handbook-tmp-${stagingSuffix()}`;
      writeFileSync(tmp, item.nextContent, { encoding: 'utf8', flag: 'wx' });
      staged.push({ tmp, target: item.absolutePath });
    }
  } catch (error) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    // No patch happened — the backup would only invite a bogus "rollback".
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }

  const renamed: string[] = [];
  try {
    for (const { tmp, target } of staged) {
      replaceFile(tmp, target);
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
    // The backup describes a patch that no longer exists — drop it so no one
    // rolls "back" to it later.
    rmSync(backupDir, { recursive: true, force: true });
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
  // Keep backups out of the repo's history and out of the analyzer's way.
  const ignore = join(backupRoot, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', 'utf8');
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
  /**
   * Refuse a backup whose manifest belongs to a different tree. Callers that
   * know which repo they are rolling back should always pass this.
   */
  expectedSourceRoot?: string;
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
  // `isAbsolute`, not `startsWith('/')`: a Windows sourceRoot is `C:\...`, and
  // testing for a leading slash rejected every backup ever taken there, making
  // rollback impossible on that platform.
  if (typeof obj.sourceRoot !== 'string' || !isAbsolute(obj.sourceRoot)) {
    throw new Error('backup manifest has no absolute sourceRoot');
  }
  if (!Array.isArray(obj.files)) throw new Error('backup manifest has no files array');
  const rootAbs = resolve(obj.sourceRoot);
  const files: Manifest['files'] = [];
  for (const entry of obj.files) {
    if (typeof entry !== 'object' || entry === null) throw new Error('malformed manifest entry');
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === 'string' ? e.file : '';
    if (!file || isAbsoluteAnyPlatform(file) || file.includes('\\'))
      throw new Error(`unsafe manifest path: ${file}`);
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
  return withTreeLock(manifest.sourceRoot, logger, () => rollbackInner(backupDir, manifest, options, logger));
}

function rollbackInner(
  backupDir: string,
  manifest: Manifest,
  options: RollbackOptions,
  logger: Logger,
): RollbackResult {
  if (options.expectedSourceRoot) {
    const expected = realpathOr(resolve(options.expectedSourceRoot));
    const actual = realpathOr(manifest.sourceRoot);
    if (expected !== actual) {
      throw new Error(`backup belongs to ${manifest.sourceRoot}, not ${resolve(options.expectedSourceRoot)}`);
    }
  }
  const restored: string[] = [];
  const removed: string[] = [];
  const skipped: RollbackResult['skipped'] = [];

  for (const entry of manifest.files) {
    // readManifest only proves the path is lexically inside the root. A
    // symlinked directory inside the tree passes every string test and then
    // redirects the restore — or the delete — clean out of it, so the real
    // path is resolved here, where the filesystem can be asked.
    const target = safeResolve(manifest.sourceRoot, entry.file);
    if (!target) {
      skipped.push({
        file: entry.file,
        reason: 'path escapes the source root (directly or through a symlink) — refusing to restore',
      });
      continue;
    }
    let tmp: string | undefined;
    try {
      // A symlink is not what the patch replaced, so it is not what rollback
      // restores: `existsSync`/`readFileSync` below would follow it and hash
      // whatever it points at.
      let targetStat;
      try {
        targetStat = lstatSync(target);
      } catch {
        targetStat = undefined;
      }
      if (targetStat?.isSymbolicLink()) {
        skipped.push({ file: entry.file, reason: 'target is a symlink — refusing to restore through it' });
        continue;
      }
      const currentHash = targetStat ? sha256Hex(readFileSync(target)) : undefined;

      if (!options.force && entry.sha256After && currentHash && currentHash !== entry.sha256After) {
        const reason =
          entry.sha256Before && currentHash === entry.sha256Before
            ? 'already back at its pre-patch content — nothing to restore'
            : 'changed after the patch — pass force to overwrite';
        skipped.push({ file: entry.file, reason });
        continue;
      }
      if (entry.existed) {
        const backupPath = join(backupDir, 'files', entry.file);
        if (!existsSync(backupPath)) {
          skipped.push({ file: entry.file, reason: 'backup copy missing' });
          continue;
        }
        // Never trust the backup blindly: if its bytes no longer hash to the
        // pre-patch content the manifest recorded, the backup was corrupted or
        // tampered with, and restoring it would write WRONG bytes over the tree.
        if (entry.sha256Before && sha256Hex(readFileSync(backupPath)) !== entry.sha256Before) {
          skipped.push({
            file: entry.file,
            reason: 'backup copy is corrupt (content hash mismatch) — refusing to restore',
          });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        // Unguessable name + COPYFILE_EXCL, for the same reason `applyPlan`
        // stages exclusively: `copyFileSync` follows a symlink at the
        // destination, and the bytes it would push through one here are a
        // previous revision of the user's source.
        tmp = `${target}.handbook-rollback-${stagingSuffix()}`;
        copyFileSync(backupPath, tmp, constants.COPYFILE_EXCL);
        // `replaceFile`, not a bare rename: Windows consults the DESTINATION's
        // read-only attribute, so restoring a mode-444 file failed with `EPERM:
        // rename` and the file was reported skipped — a rollback that silently
        // did not roll one file back. POSIX allows the owner the rename and
        // never enters the retry, which is why this only showed up in CI.
        replaceFile(tmp, target);
        tmp = undefined;
        restored.push(entry.file);
      } else {
        if (currentHash === undefined) {
          skipped.push({ file: entry.file, reason: 'already absent' });
          continue;
        }
        rmSync(target, { force: true });
        removed.push(entry.file);
      }
    } catch (error) {
      // One unwritable file must not abandon the rest of the rollback.
      if (tmp) rmSync(tmp, { force: true });
      skipped.push({
        file: entry.file,
        reason: `restore failed: ${error instanceof Error ? error.message : String(error)}`,
      });
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
