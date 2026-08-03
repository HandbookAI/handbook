# Patcher R1 — adversarial correctness + safety review of `@handbook/patcher`

Scope: `packages/patcher/src/{parse,apply,index,patcher.test}.ts`, `packages/patcher/README.md`,
the studio integration (`packages/studio/src/server.ts` — `patchBackupRoot`, `runApply`,
`runRollback`, `POST /apply`, `POST /rollback`, `GET /patches`; plus
`packages/studio/src/{jobs,state}.ts` and the `patchPanel`/`runPatch`/`outcomesFromLog` path in
`packages/studio/public/index.html`), the `apply`/`rollback` commands in
`packages/cli/src/main.ts`, and `writeFileAtomic` in `packages/core/src/util/fsx.ts`.

Method: full read of every file above, plus **8 runtime harnesses** (~60 scenarios) against the
built `dist/` in a scratch dir — data-loss inputs, ordering/composition, parse fuzzing, backup and
rollback integrity including crafted manifests, a live studio server on 127.0.0.1 exercising
`/apply` + `/rollback` + `/patches`, `JobRunner` mutex semantics, and the CLI end to end
(exit codes). **No repo file was modified**; every temp tree lived under `$TMPDIR`.

Verification gates (repo root, both green — see the end of this doc):
- `npx tsc -b` → exit 0, no output.
- `npx vitest run packages/patcher packages/studio` → 2 files, 27/27 passed.

**28 findings: 7 High, 13 Medium, 8 Low.** Everything below was reproduced unless explicitly
marked PLAUSIBLE. A final section lists what was attacked and came back **clean**.

---

## High

### 1. HIGH — The write phase is not atomic: one `fs` error mid-loop leaves a half-applied plan, and the `ApplyResult` is thrown away
`apply.ts:229-234` (write loop), `apply.ts:1-13` (the "all-or-nothing" contract),
`core/src/util/fsx.ts:21-26`.

**Defect.** The verify pass is all-or-nothing, but the *write* pass is a bare `for` loop with no
error handling and no undo. `writeFileAtomic` is atomic **per file**, not across the set. Any
failure on file *k* (EACCES, EROFS, ENOSPC, ENAMETOOLONG, a path whose parent is a regular file,
a concurrently-deleted directory) propagates out of `applyPlan` with files `1..k-1` already
replaced. Because the exception escapes, the caller never receives `ApplyResult` — so
`changedFiles` and `backupDir` are lost precisely when they matter most.

**Scenario (reproduced).** Plan touches `aaa/one.py` and `zzz/two.py`; `zzz/` is mode 555.
`applyPlan` threw `EACCES … open '…/zzz/two.py.tmp-368-…'`, and afterwards
`aaa/one.py === "ONE_PATCHED\n"` while `zzz/two.py` was untouched. The tree is now in a state no
plan describes — half of a refactor — and the studio surfaces only a raw `EACCES` string with
`job.result === undefined`. The backup dir does exist on disk (`listBackups` finds it), but
nothing in the result or the message points the user at it.

**Minimal fix.** Two-phase the writes: write every `<target>.tmp-*` first, then `renameSync` them
all; if the tmp phase throws, unlink the tmps and write nothing. If that is too invasive, wrap the
loop in `try/catch`, and on failure restore the already-written files from the backup just created
(the bytes are there) before rethrowing an error that names `backupDir`.

### 2. HIGH — A nested same-length fence silently truncates `old`/`new`; the truncated text is then written to the file
`parse.ts:46` (`FENCE_RE`), `parse.ts:73-78`.

**Defect.** `FENCE_RE`'s terminator is `^[ \t]*\1`*[ \t]*$` — the *first* line that is a backtick
run of at least the opener's length. Markdown nesting is not tracked, so a ```` ``` ````-fenced
`old`/`new` block whose body contains any ```` ``` ```` line ends there. The remainder is dropped
**with no problem reported**, so `ok:true` and the file is written from a truncated payload. The
README's design note — *"line-anchored openers with a backtick-run match, so an `old` block
containing fenced content survives intact"* — is false at equal fence length (it holds only for a
4-backtick outer fence, verified separately).

**Scenario A (reproduced, `new` truncated).** An edit rewriting `docs/guide.md` whose `new` block
contains a ` ```bash … ``` ` example parsed to
`newText === "# Guide\n\nRun this:\n```bash\nnpm test"`; `problems === []`, status `applied`, and
the file on disk ends mid-example — the trailing `` ``` `` and `"That is all."` are gone.

**Scenario B (reproduced, `old` truncated).** `oldText` truncated to `"intro\n```bash\nnpm test"`
still matched uniquely, so the splice landed **inside** the code block and left an orphan `` ``` ``:
`"REPLACED\n```\noutro\n"`. Reported as a clean `applied`.

**Minimal fix.** After extracting a block, reject rather than guess: if the captured content
contains a line matching `` /^[ \t]*`{3,}/ `` whose run length ≥ the opener's, push a problem
(`EDIT n (file): fenced content inside \`old\`/\`new\` — use a longer outer fence`). Also document
that plans editing fenced markdown must open with 4+ backticks.

### 3. HIGH — `### EDIT n` inside a fenced block splits the plan, so example edits quoted in documentation are applied to real files
`parse.ts:41` (`EDIT_HEAD_RE`), `parse.ts:52-62`.

**Defect.** Heads are located by a global regex over the raw plan with no awareness of fenced
regions, and each edit's body is `plan.slice(headEnd, nextHeadStart)`. Any `### EDIT n` line
*inside* an `old`/`new` block therefore terminates the enclosing edit and starts a new one whose
`- file:` and fences are read out of what was supposed to be file **content**.

**Scenario (reproduced, both files written).** A plan whose one edit rewrites
`docs/plan-format.md` to a body that documents the plan format (`### EDIT 1`, `- file:
\`src/real.py\``, an `old`/`new` pair) parsed to **two** edits, `problems === []`, `ok:true`:
`docs/plan-format.md` was written with truncated content *and* `src/real.py` was patched
`SECRET = 1` → `SECRET = 666` from the documentation example. The author never asked for the
second write. (The variant where the outer fence is 4 backticks also yields the phantom edit; there
it is saved only by finding 4 in the first body, so all-or-nothing refuses — a coincidence, not a
guard.)

**Minimal fix.** Mask fenced regions before locating heads: scan the plan line by line, track
open/close fences, and only accept `### EDIT n` at fence depth 0. Optionally also require the
edit's `- file:`/`- where:` lines to appear *before* the first fence in the body (see #22).

### 4. HIGH — Symlink escape on file creation: a plan can write new files outside `sourceRoot`
`apply.ts:66-82` (`safeResolve`, esp. the `catch` at 78-80), `apply.ts:129-155`, `apply.ts:231-232`.

**Defect.** `safeResolve` realpaths both sides — but only inside a `try`. When the target does not
exist yet (exactly the create case), `realpathSync(full)` throws ENOENT and the code falls into the
catch with the comment *"the file does not exist yet (creation) — the prefix check above
suffices"*. The prefix check ran on the **unresolved** path, so a symlinked *directory* inside the
repo is never resolved. Safety rule 4 in the file header (*"no symlink is followed out of it"*) and
the README row *"path escapes the source root (or symlinks out) → `unsafe-path`"* are both violated.

**Scenario (reproduced).** Repo contains `vendor -> /var/…/outside-6GDWD2` (a normal pattern:
vendored deps, shared caches, a sibling checkout). Plan: `- file: \`vendor/pwned.py\`` with empty
`old`. Result: `ok:true`, outcome `created`, `changedFiles === ["vendor/pwned.py"]` — and
`/var/…/outside-6GDWD2/pwned.py` now exists with the plan's content. Nested new directories under
the link work too (`vendor/deep/new/file.py`). Since a planner-authored path is attacker-influenced
whenever the planned repo contains untrusted text, this is a write-outside-the-tree primitive that
the report actively hides (the printed path looks in-root).

**Minimal fix.** In `safeResolve`, when `realpathSync(full)` fails, realpath the nearest **existing
ancestor** and containment-check that instead of silently accepting the lexical result.

### 5. HIGH — `rollback` trusts the manifest completely: `sourceRoot` + `entry.file` give arbitrary file write **and** delete
`apply.ts:250-274` (esp. `259`, `261`, `268`).

**Defect.** `rollback` `JSON.parse`s `manifest.json` with no schema validation and no containment
check, then computes `join(manifest.sourceRoot, entry.file)`. Both operands come from the file. For
`existed: true` it copies `<backupDir>/files/<entry.file>` over that path; for `existed: false` it
`rmSync(target, { force: true })`. Nothing constrains `entry.file` to a relative in-root path, and
nothing checks that `manifest.sourceRoot` is the repo being rolled back.

**Scenario (both reproduced).**
- Write: manifest `{ sourceRoot: "<victim>/sub/dir", files: [{ file: "../../evil-payload.txt",
  existed: true }] }` + a payload at `files/../../evil-payload.txt` → `restored:
  ["../../evil-payload.txt"]` and `<victim>/evil-payload.txt` created with attacker content.
- Delete: manifest with `existed: false` and a `../../…` traversal → the victim file is gone
  (`removed: […]`, exit 0).
- A manifest naming an absolute `sourceRoot` overwrote a file in a completely unrelated tree.

Combined with #6 this is also a *non-adversarial* bug: change a repo's `sourceRoot` in
`studio.json` (repo moved/renamed) and rollback happily restores into the **old** path recorded in
the manifest, with no mismatch error.

**Minimal fix.** Validate the manifest with a zod schema; reject any `entry.file` that is absolute
or that fails `relative(root, join(root, file))` containment (no `..`, no `sep` escape) on both the
target and the `files/` side; and have callers pass the expected `sourceRoot` so rollback can refuse
a manifest that does not match.

### 6. HIGH — `rollback` never verifies `sha256Before`, so it silently destroys work done after the patch
`apply.ts:217` (hash recorded), `apply.ts:252-255` (the type literally omits `sha256Before`),
`apply.ts:258-266`.

**Defect.** `applyPlan` stores a per-file `sha256Before`, and the README sells it: *"they capture
the pre-patch bytes and a `sha256Before` per file, so a rollback is provable rather than
best-effort."* `rollback` never reads it — the local manifest type doesn't even declare the field.
There is no pre-rollback backup either, so the clobbered bytes are unrecoverable.

**Scenario (reproduced).** Apply a patch, keep editing the same file for a day, then click
`rollback` (or roll back the newest stamp from `GET /patches`, or the button the studio shows right
after an apply). Result: `{"restored":["a.py"]}`, exit 0, and the file is back to the pre-patch
bytes — a day of unrelated work gone with no warning, no diff, no confirmation.

**Minimal fix.** Hash the current file before restoring; when it differs from `sha256Before` (i.e.
the file changed since the patch), skip it and report it as `stale` unless an explicit `force`
option is passed. Bonus: copy the current bytes into `<backupDir>/superseded/` first so the
rollback is itself undoable.

### 7. HIGH — Backup stamps collide within the same millisecond: the second apply overwrites the first's backup and manifest, making the original bytes unrecoverable
`apply.ts:203-205` (`stamp`/`backupDir`), `apply.ts:210-227` (`mkdirSync(..., {recursive:true})` +
`copyFileSync` + `writeJsonFile`).

**Defect.** The backup directory name is only `new Date().toISOString()` with `:.` replaced —
millisecond resolution, no pid, no counter, and `recursive: true` means an existing directory is
silently reused. Two applies in the same millisecond share one `backupDir`: the second
`copyFileSync` overwrites the first's saved bytes with the **already-patched** content, and
`manifest.json` is replaced wholesale so the first apply's other files vanish from the record. Both
calls return the *same* `backupDir`, so no caller can tell.

**Scenario (reproduced, clock pinned).** `a.py` = `"A\nB\n"`; apply 1 (`A`→`A1`) and apply 2
(`B`→`B1`) in the same millisecond. `backupDir1 === backupDir2`; `files/a.py` in the shared backup
holds `"A1\nB\n"`; rolling back the *first* stamp produced `"A1\nB\n"` — the original `"A\nB\n"` is
gone from disk entirely, and `listBackups` shows a single stamp. The default backup root is the
**parent of `sourceRoot`** (`apply.ts:203`), so sibling repos share one root (verified, #26) and can
collide with each other as well.

**Minimal fix.** Create the stamp dir with a non-recursive `mkdirSync(backupDir)` and, on `EEXIST`,
retry with `-2`, `-3`, … (or append `process.pid` + a short random suffix). Never reuse an existing
stamp dir.

---

## Medium

### 8. MED — A non-UTF-8 byte anywhere in the file is silently rewritten as U+FFFD across the whole file
`apply.ts:132` (`readFileSync(absolutePath, 'utf8')`), `apply.ts:232` →
`core/src/util/fsx.ts:24` (`writeFileSync(tmp, content, 'utf8')`).

**Defect.** The file is decoded as UTF-8, spliced, and re-encoded in full. Any byte that is not
valid UTF-8 becomes the replacement character, so bytes the plan never mentions change.

**Scenario (reproduced).** `# caf\xe9\nx = 1\n`, edit `x = 1` → `x = 2`. Before:
`2320636166 e9 0a…`; after: `2320636166 efbfbd 0a…`. `ok:true`, status `applied`, no warning. Same
mechanism silently normalizes any lone-surrogate/invalid sequence. Rollback does restore the exact
bytes (verified byte-equal), so it is recoverable — if the user notices.

**Minimal fix.** Read a `Buffer`, decode, and verify `Buffer.from(text, 'utf8').equals(buf)`; when
it fails, refuse the edit with a new status (`not-utf8`) instead of rewriting the file.

### 9. MED — The "never silently overwrites" guard is disabled for any file the plan already touched, so a plan can replace a whole file wholesale
`apply.ts:141-155` (guard condition `current !== '' && !working.has(absolutePath)`).

**Defect.** The create guard is skipped whenever the file is already in the `working` map. Two
consequences, both reproduced:
- Edit 1 replaces the file's entire content with an empty `new` (allowed, see #16); edit 2 has an
  empty `old` and is treated as a **create** — final content is edit 2's text, `ok:true`, both
  outcomes green. The README's *"`old` empty, file has content → `no-match` (never silently
  overwrites)"* holds only for the first edit to a file.
- Two create edits for the same path: the second overwrites the first with status `created` for
  both, so the first edit's content is silently discarded and nothing reports it.

**Minimal fix.** Evaluate the guard against the file's *on-disk* state, not the working copy
(`existsSync(absolutePath) && originalContent !== ''`), and reject a second create for a path
already resolved in this plan as a problem.

### 10. MED — Silently dropped edits: a malformed head or a second `old`/`new` pair vanishes, and `ok:true` claims full success
`parse.ts:41` (head regex), `parse.ts:71-78` (`if (kind === 'old' && oldText === undefined)`).

**Defect.** Nothing validates that every plausible edit was consumed. Text between a valid head and
the next valid head is silently absorbed, and only the *first* `old` and *first* `new` fence in a
body are used — extras are dropped with no problem.

**Scenario (both reproduced).** A plan with `### EDIT 1` followed by `#### EDIT 2` (one extra `#`,
a very common LLM slip): `edits.length === 1`, `problems === []`, `ok:true`,
`changedFiles === ["a.py"]` — `b.py` was never touched and the user is told the plan applied. A
plan with two `- file:`/`old`/`new` triplets under a single `### EDIT 1` head behaves identically.

**Minimal fix.** Count `old`/`new` fences and `- file:` lines per body and report a problem when a
body holds more than one of each; separately, scan for `/^#{1,6}\s*EDIT\s+\d+/im` lines that
`EDIT_HEAD_RE` did *not* match and report them as malformed heads.

### 11. MED — CRLF: an LF plan against a CRLF file fails with the wrong explanation; a CRLF plan against an LF file injects mixed line endings
`parse.ts:46`/`parse.ts:94-96` (fence content keeps whatever EOL the plan uses), `apply.ts:157-166`.

**Defect.** Matching is byte-exact with no EOL normalization, and the failure message asserts a
cause it did not check.

**Scenario (both reproduced).**
- CRLF file + LF plan → `no-match` with detail *"the `old` text is not present — the code changed
  since the plan was made"*. The code did **not** change; on a CRLF checkout every plan fails this
  way and the message sends the user chasing a phantom edit.
- CRLF plan + LF file: a single-line `old` still matches, and the multi-line `new` is inserted
  verbatim → `"def f():\n    log()\r\n    return 2\n"`. Mixed EOLs introduced silently, `ok:true`.

**Minimal fix.** On `no-match`, retry with the file's dominant EOL applied to `old`/`new`; if that
matches, either apply it normalized or fail with detail *"line-ending mismatch (file is CRLF, plan
is LF)"* — never the "code changed" text.

### 12. MED — Every applied edit drops the file's mode: `755` → `644`
`apply.ts:232` → `core/src/util/fsx.ts:21-26` (write-tmp + `renameSync`).

**Defect.** `writeFileAtomic` creates a fresh temp file (umask default) and renames it over the
target, so permissions, ownership and any extended attributes of the original are replaced, not
preserved.

**Scenario (reproduced).** `run.sh` at mode 755; a one-line edit; after apply the mode is 644 and
the script no longer executes. Nothing in the outcome mentions it. (Rollback happens to restore 755
because `copyFileSync` carried the mode into the backup — verified — so the damage is undoable but
invisible.)

**Minimal fix.** `statSync` the target before writing and `chmodSync(path, mode)` after the rename
(or add a `preserveMode` path in `writeFileAtomic` for source-tree writes).

### 13. MED — Editing through an in-root symlink replaces the link with a regular file and leaves the real target stale — reported as `applied`
`apply.ts:74-77` (in-root symlinks are deliberately allowed), `apply.ts:232` (`rename` does not
follow symlinks).

**Defect.** `readFileSync` follows the link (so `old` matches the target's bytes), but the atomic
write renames over the **link itself**. The edit lands in a new regular file; the file the developer
actually builds from keeps the old content.

**Scenario (reproduced).** `link/alias.py -> real/target.py`; edit `x = 1` → `x = 2` via
`link/alias.py`. Outcome `applied`, `ok:true`; afterwards `link/alias.py` is a regular file
containing `x = 2`, `real/target.py` still contains `x = 1`, and the symlink is gone from the tree.
The change is effectively lost while the report claims success.

**Minimal fix.** `lstatSync` the target; if it is a symlink, either resolve it and write the real
path, or refuse with an explicit status. Do not silently convert a link into a file.

### 14. MED — A directory (or any unreadable) target throws out of `applyPlan` instead of producing an `EditStatus`
`apply.ts:130-139` (`existsSync` + `readFileSync`).

**Defect.** `existsSync` is true for directories, FIFOs, and unreadable files; `readFileSync` then
throws and the exception escapes the whole verify pass. The design promises a status per edit
(`file-missing`, `unsafe-path`, …); instead the caller gets a raw errno.

**Scenario (reproduced).** `- file: \`somedir\`` where `somedir/` is a directory →
`EISDIR: illegal operation on a directory, read`. In the studio the job fails with that string and
no outcomes at all; in the CLI it is exit 1 with no JSON report. Note this happens during *verify*,
so nothing is written — the harm is diagnostics, not data.

**Minimal fix.** Use `statSync(absolutePath, { throwIfNoEntry: false })` and require `isFile()`;
otherwise emit `file-missing` with detail *"not a regular file"*. Wrap the read in `try/catch` and
map errors to a status.

### 15. MED — `problems` never reach the studio user: a plan that fails to *parse* produces a generic error, an empty outcomes table, and the log line "0 edit(s) failed"
`apply.ts:193` (warn count), `server.ts:309-313` (logs `outcomes` only, then throws a generic
message), `public/index.html:1497-1504` (`outcomesFromLog`), `public/index.html:1824-1830`
(`runPatch`). *(`index.html` was being edited by someone else while this review ran — it grew from
19 KB to 106 KB mid-session. Its line numbers here are as of md5 `08b1273…`; the functions named are
stable anchors.)*

**Defect.** `runApply` logs one line per **outcome** and then throws. `result.problems` is never
logged and — because the job failed — `job.result` is `undefined`, so `ApplyResult` (including
`problems`) is discarded entirely. The UI reconstructs outcomes by regexing `✓/✗ EDIT …` lines out
of the log, so anything not in that shape is unreachable. When the failure is purely a parse
problem there are **no** outcomes, and `applyPlan`'s own warning is arithmetically true but absurd.

**Scenario (reproduced end to end against a live studio).** `POST /apply` with a plan the planner
degenerated into prose. Job log: `["⚠ [patch] refusing to write: 0 edit(s) failed", "✖ plan did not
verify — nothing was written (see the per-edit results)"]` — there are no per-edit results to see.
The UI renders "Apply failed — nothing was written" over an empty table. Same shape for
`old`/`new` identical, missing `- file:`, and missing fences. (The CLI is fine: `printJson(result)`
includes `problems`, verified.)

**Minimal fix.** In `runApply`, log every `result.problems` entry before the outcome loop, and put
`problems.join('; ')` into the thrown message. Better: return the result instead of throwing (let
the UI render `ok:false`), or attach it to the job (`job.result = result` on failure).

### 16. MED — An empty `new` block truncates the file with no distinct status and no confirmation
`parse.ts:79-86` (only `old === new` is rejected), `apply.ts:177-182`.

**Defect.** `newText === ''` is a legitimate deletion, but it is indistinguishable from a plan whose
`new` payload was lost (truncated LLM output, a copy-paste slip, or #2 above), and it is reported as
a plain `applied`.

**Scenario (reproduced).** `old` = the whole file, `new` = empty → the file becomes 0 bytes,
`ok:true`, outcome `applied`, `changedFiles: ["a.py"]`. Nothing distinguishes "delete this block"
from "the plan lost its replacement text". (Rollback does restore it — verified.)

**Minimal fix.** Report a distinct status/detail when `newText === ''` (e.g. `applied` +
`detail: "deletes N lines"`), and treat "new is empty **and** old is the entire file" as a problem
unless an explicit `allowTruncate` option is set.

### 17. MED — `POST /rollback` joins an unvalidated `body.backup` into the backup root: path traversal to any directory on disk
`server.ts:317-322` (`body.backup` → `join(patchBackupRoot(repo), stamp)`), `server.ts:294-296`.

**Defect.** `stamp` is taken verbatim from the request body when it is a non-empty string. `join`
happily consumes `../..`. There is no allow-list against `listBackups(...)` and no check that the
result stays under `patchBackupRoot(repo)`. Chained with #5, this promotes "any `manifest.json`
anywhere on disk" into an arbitrary write/delete.

**Scenario (reproduced against a live studio).** A backup dir planted in `$TMPDIR` with a manifest
pointing at an unrelated victim tree, then `POST /api/repos/A/rollback` with
`{"backup":"../../../../../../../../../../var/folders/…/evilbk-LZ10Hz"}` → job **succeeded**,
`{"restored":["keep.txt"]}`, and the victim's `keep.txt` now contains `PWNED`. Reachability caveat:
the request must pass the loopback `Host`/`Origin` + `application/json` checks
(`server.ts:558-589`), so this is a local-process / local-tooling vector rather than one-click CSRF;
the studio UI itself only ever sends stamps from `GET /patches`.

**Minimal fix.** `if (!listBackups(patchBackupRoot(repo)).includes(stamp)) throw new Error('unknown
backup')` — an allow-list, plus a containment assert on the joined path.

### 18. MED — Rolling back twice deletes files a human legitimately re-created
`apply.ts:267-270` (`rmSync(target, { force: true })` for `existed: false`).

**Defect.** Rollback is stateless: the backup is never marked consumed, and `removed` entries are
deleted by path with no identity check (no hash of what the patch created).

**Scenario (reproduced).** Apply creates `app/made.py`; rollback removes it; the developer writes a
*new, unrelated* `app/made.py`; rollback the same stamp again → the new file is deleted and the
report cheerfully says `removed: ["app/made.py"]`. In the studio every stamp keeps a live
`rollback` button after being used (`public/index.html:1530-1533`, `patchPanel`), so a double click
is one mis-click away.

**Minimal fix.** Record `sha256After` for created files and skip deletion when the current bytes
differ; write a `rolledBackAt` marker into the manifest and refuse (or warn) on re-use.

### 19. MED — The studio job mutex is keyed on repo *name*, and two repos may share one `sourceRoot`
`jobs.ts:33-36` (`busyRepos` keyed by `repo` name), `state.ts:52-64` (`add` validates only
`workDir` overlap), `server.ts:432-458`.

**Defect.** `StateStore.add` rejects a `workDir` inside `sourceRoot` and `workDir` overlaps between
repos, but never rejects a **duplicate `sourceRoot`**. The mutex therefore does not protect the
thing being written.

**Scenario (reproduced).** `POST /api/repos {name:"A2", sourceRoot:<same tree as A>}` → 201.
`JobRunner` then allows `A`'s apply and `A2`'s resync to run concurrently (verified directly: a
second `start` for the *same* name throws `repo "A" already has a running job`, for a different name
it does not). Resync snapshots/analyses the tree while apply rewrites files under it → an evolution
record describing a tree that never existed. Same-name apply+resync **is** correctly serialized
(verified).

**Minimal fix.** Reject a duplicate/overlapping `sourceRoot` in `StateStore.add`, or key
`busyRepos` on `resolve(repo.sourceRoot)` in addition to the name.

### 20. MED — Edits are applied in document order while the plan numbers them, and duplicate/out-of-order indices are never validated
`parse.ts:52-62`, `parse.ts:87`, `apply.ts:121`.

**Defect.** `edits` preserves the order the heads appear in, and `index` is only carried into the
report. Nothing checks that indices are unique or ascending.

**Scenario (reproduced).** `### EDIT 2` written before `### EDIT 1` parses to `[{index:2}, {index:1}]`
and is applied 2-then-1 — wrong for order-dependent edits to one file, with no warning. Two edits
both numbered `### EDIT 1` both apply and both report `index: 1`, so the studio log shows two
identical `EDIT 1` lines and `outcomesFromLog` produces two indistinguishable rows.

**Minimal fix.** Report a problem when indices are not a unique ascending sequence (or sort by index
and say so). Cheap and it makes the report unambiguous.

### 21. MED — Indented fences are accepted but their indentation is baked into `old`/`new`
`parse.ts:46` (`^[ \t]*` on both opener and closer), `parse.ts:73-78`.

**Defect.** The opener may be indented, yet the captured content is not dedented, so every line
carries the fence's leading whitespace.

**Scenario (reproduced).** A plan whose fences sit indented under the `- file:` bullet (a natural
markdown reflow, and the plan format *is* a bullet list) parsed to `oldText === "  A"` /
`newText === "  B"` → guaranteed `no-match`, again explained as *"the code changed since the plan was
made"*.

**Minimal fix.** Capture the opener's indent and strip exactly that prefix from each content line
(as CommonMark does), or refuse an indented opener with a clear problem.

---

## Low

22. **LOW** — `parse.ts:42-43,64-65`: `FILE_RE`/`WHERE_RE` are matched against the whole body,
    fenced content included. An edit missing its own `- file:` line silently adopts a `- file:` line
    written *inside* the `old` block (reproduced: picked `victim.py` while the real line said
    `intended.py`); `where` is stolen the same way. Fix: only search the region before the first
    fence.
23. **LOW** — `apply.ts:141-153`: an empty `old` against an existing **0-byte** file bypasses the
    "already has content" guard (correctly — there is no content) but reports `created` for a file
    that existed. Content is backed up (`existed: true`, sha of the empty string) so rollback works;
    only the status lies. Fix: report `applied` when the file existed.
24. **LOW** — `apply.ts:289-291`: `writeApplyReport` is exported and documented
    (`README.md:42`) but called from **nowhere** in the repo (verified by grep). It also uses bare
    `writeFileSync` with no `ensureDir`, and `ApplyResult.backupDir` is `undefined` for dry-run and
    for `ok:false`, so the only plausible call sites would throw. Fix: delete it, or call it from
    `runApply`/the CLI and guard on `backupDir`.
25. **LOW** — `parse.ts:42`: `- file:` accepts almost anything: `src/a.py (line 12)`, `~/secrets.txt`
    (no `~` expansion — it would create a literal `~` directory on a create edit), and
    `src\win\app.py` (a single POSIX filename) all parse and then fail as `file-missing`, while
    ``- file: `` `src/a.py` `` `` (double backticks) reports *missing* `- file:`. Absolute paths are
    correctly refused as `unsafe-path` (verified with `/etc/passwd`). Fix: validate the captured path
    (reject `~`, absolute, backslashes, trailing junk) with an explicit problem.
26. **LOW** — `apply.ts:203`: the default `backupRoot` is `<parent of sourceRoot>/.handbook-patches`,
    i.e. **outside** the repo, so sibling checkouts under one parent share one backup root
    (reproduced: `repoA` and `repoB` stamps interleaved in the same directory) — which is what makes
    #7's collision cross-repo. The studio avoids this (`workDir/patches`). Fix: default to
    `<sourceRoot>/.handbook-patches` (gitignored) or namespace by a hash of `sourceRoot`.
27. **LOW** — `apply.ts:277-286` / `250-255`: `listBackups` accepts any directory containing a
    `manifest.json`, and `rollback` surfaces raw parse failures (`Unexpected token 'N', "NOT JSON" is
    not valid JSON`, reproduced). Fix: validate the manifest and skip/report malformed stamps.
28. **LOW** — `server.ts:439`: rollback jobs are recorded as `kind: 'apply'` (verified over HTTP), so
    the job list cannot distinguish "wrote a patch" from "undid one" — unfortunate for an audit
    trail. Also `apply.ts:229-235`: `changedFiles` includes files rewritten to byte-identical content
    (reproduced with two cancelling edits), and `parse.ts:46` accepts ```` ```oldish ````/
    ```` ```newer ```` as `old`/`new` openers.

Documentation drift worth fixing alongside the code: `README.md:85` (fence nesting "survives
intact" — false at equal fence length, #2), `README.md:28` ("or symlinks out → `unsafe-path`" —
false on create, #4), `README.md:79-80` ("`sha256Before` … provable rather than best-effort" — never
verified, #6), and `README.md:29` / `apply.ts:4-6` ("nothing is written until every edit verifies" —
true of verification, false of the write loop, #1).

---

## Attacked and clean

Each of these was probed with a runtime harness (positive control included where the check could
trivially pass for the wrong reason):

- **Verification is genuinely all-or-nothing.** First edit destroys the second's anchor → `skipped` +
  `no-match`, file byte-identical to before. First edit makes the second's anchor ambiguous (2 hits)
  → `ambiguous`, nothing written. A later `file-missing`/`no-match` reverts earlier `applied`
  outcomes to `skipped`.
- **Composition in plan order works.** Edit 2 anchoring text that edit 1 *created* applies cleanly;
  create-then-edit of a brand-new file in one plan works; the same file spelled `./a.py` and `a.py`
  resolves to one working copy and composes instead of clobbering.
- **Uniqueness and absence refusals** behave as documented, including the 2-hit `ambiguous` detail.
- **Dry-run writes nothing** — no source mutation, and no backup directory is created
  (`workDir/patches` absent after a dry-run, verified over HTTP).
- **Re-verification at apply time** closes the dry-run TOCTOU: a file changed between dry-run and
  apply yields `no-match`, not a stale write.
- **Backup failures precede source writes.** With an unwritable backup root, `mkdirSync` throws and
  the source tree is untouched (`"A\n"` intact) — the ordering in `apply.ts:210-227` is correct.
- **Rollback restores exact bytes**, including a non-UTF-8 file (byte-equal to the original,
  verified) and file mode (755 restored via `copyFileSync`).
- **Absolute paths and `..` escapes are refused** (`/etc/passwd`, `../evil.py`,
  `src/../../a.py` → `unsafe-path`); an **existing** symlink pointing out of the root is refused
  (`unsafe-path`); a *dangling* in-root symlink is replaced rather than followed.
- **UTF-8 multi-byte, emoji and BOM content** round-trip byte-exactly (`efbbbf` preserved; CJK/emoji
  anchors match and line numbers are right).
- **CRLF plan + CRLF file** works end to end (the mismatch cases are #11).
- **Missing trailing newline** at plan end, at file end, and `where:` lines containing ```` ```old ````
  all parse correctly; a 4-backtick outer fence correctly preserves nested 3-backtick content.
- **Module-level global regexes** (`EDIT_HEAD_RE`, `FENCE_RE`) do not leak `lastIndex` across calls —
  three consecutive `parsePlan` calls on the same input gave identical results.
- **Same-repo apply + resync are serialized** by `JobRunner` (`repo "A" already has a running job`);
  the hole is cross-name (#19).
- **CLI exit codes are correct**: `0` when `ok`, `2` when `!ok` (both `no-match` and parse-only
  failures), `1` on exceptions (missing plan file, missing backup dir). The CLI also prints
  `problems` in its JSON, unlike the studio (#15).
- **Cross-repo plan** (`POST /apply` on repo A with repo B's plan) fails cleanly as `file-missing`
  and leaves repo B untouched.
- **Rollback with no backups** → `no patch backups to roll back`; nonexistent stamp → clean ENOENT
  failure; `listBackups` ordering is newest-first (lexicographic == chronological for this stamp
  format, verified across year/month boundaries).
- **A 200k-char file** with a tail anchor resolves in ~0 ms; no pathological regex behaviour observed.

## Verification gates

```
$ npx tsc -b            # exit 0, no output
$ npx vitest run packages/patcher packages/studio
  Test Files  2 passed (2)
       Tests  27 passed (27)
```
