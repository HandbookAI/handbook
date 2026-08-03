# Patcher R4 (final) — verification of the 14 R3 fixes + adversarial sweep of the fourth parser/lock rewrite

Scope: `packages/patcher/src/{parse,apply}.ts` at commit `cea10e7`, plus `packages/cli/src/main.ts`,
`packages/studio/src/{server,jobs}.ts`, `packages/planner/src/prompt.ts`, `packages/patcher/README.md`.

Method: full read of both files, then **7 runtime harnesses** (`h1`–`h7` + two worker scripts in the
scratch dir) against the built `dist/`: ~35 crafted plans through `parsePlan`, ~25 tree scenarios
through `applyPlan`/`rollback` (forced `EACCES` staging + create + read-only file, dangling symlinks
at ancestor and leaf, 9 MB file, custom/archived/read-only backup roots), a lock matrix (live pid,
dead pid, absent/garbage owner record, foreign-user pid, SIGKILLed holder), and **20 rounds of two OS
processes applying to one tree** in three layouts. No repo file was modified; every temp tree lived
under `$TMPDIR`. This document is the only file added.

Verdict: **9 of 14 R3 findings fixed, 4 incomplete, 1 incomplete-and-regressing.** The headline
(M1/M2 — the planner's own plan shape) is genuinely fixed. But the two mechanisms that fixed it and
M3–M5 each broke a guarantee R3 had verified as safe:

- **R2-N1 (no silent truncation) is broken again** — a plan whose `new` block contains a fenced code
  block parses with `problems: []` and writes *truncated or empty* content (F1).
- **R2-N10 (cross-process lock) is broken again** — two simultaneous applies both take the lock and
  one edit is lost, `ok:true` on both sides: 6/6 rounds, was 0/8 at `9a1fc91` (F2).
- **R2-N17 (read-only files patch cleanly, mode preserved) is broken** — now refused as
  `unsafe-path` (F6).

**12 new findings: 2 High, 4 Medium, 3 Low-Med, 3 Low.** Everything below was reproduced at runtime.

---

## A. R3 fix verification

| # | R3 title (sev) | Verdict | Trace against current code |
|---|---|---|---|
| M1 | declarations JSON block makes every planner plan unapplicable (H) | **OK** | `parse.ts:191-196,230-231,271-277`. A plan built exactly as `prompt.ts:75-83` instructs — prose summary, **two** EDIT blocks across **two** files, one ` ```json ` declarations block, then the three echoed bullets — parses `problems: []`, `edits: 2`, and applies: `ok:true`, `changedFiles:["app/engine.py","app/utils.py"]`, both files byte-correct (`h1`). |
| M2 | trailing prose refuses the plan (H) | **OK** (over-corrected → **F1**) | Trailing prose, a `## Declarations` heading and the echoed bullets all pass now. The **other direction still holds**: content *between* `old` and `new` is refused — `EDIT 1: content between the fenced blocks ("npm test"…)`, `edits: 0`, file byte-identical (`h1`, `h2`); R2 Scenario A verbatim is still refused. |
| M3 | lock wait busy-spins, freezes the studio (M) | **OK** | `apply.ts:157-183` no longer waits at all. Live-pid lock → throws in **0 ms** with `another patch run (pid N) is writing to this tree — retry when it finishes`; a `setTimeout(…,300)` scheduled before the call **fired** (`h3` L1). Dry-run still bypasses the lock (`apply.ts:264`) — correct. |
| M4 | lock staleness unsafe in three ways (M) | **INCOMPLETE** | Only part 4 landed (`owner.json` + `process.kill(pid,0)`, `apply.ts:147,167-176`): dead pid → reclaimed, apply proceeds (`h3` L2). Part 1 **inverted** — the mtime/age check was *deleted*, so staleness is now pid-only and unbounded (**F7**). Part 2 (atomic reclaim) not done — still `rmSync` + `mkdirSync` (`apply.ts:181-182`) → **F4**. Two new holes the R3 fix opened: a missing/garbage owner record counts as "owner gone" (**F2**, the serious one) and `EPERM` counts as dead (**F3**). |
| M5 | lock created inside `sourceRoot` despite `backupRoot`; raw errnos (M) | **INCOMPLETE** | Lock now lives in the effective backup root (`apply.ts:265-266`): with `backupRoot` set, `<source>/.handbook-patches` is **not** created (`h2` #8) ✓; acquire errors are wrapped — `cannot create the patch backup directory …: EACCES`, `cannot take the patch lock in …` (`h2` #8b) ✓. Not done: the `.gitignore` is still only written by `createStampDir` (`apply.ts:516-517`), so a killed run leaves `.handbook-patches/` holding **only** `apply.lock`, un-ignored (**F9**); callers still get a throw, not an `ApplyResult` (**F10**). Moving the lock also made its key the backup root instead of the tree (**F5**). |
| M6 | `closes()` ignores the closer's indentation (M) | **OK** | `parse.ts:81-83` (`indent.length <= Math.max(3, open.indent.length)`). `old` = `"- steps:\n\n    ```\n    npm test\n    ```\n"` with 3-tick fences → `problems: []`, content byte-exact (`h3`); a 3-space-indented opener+closer pair still parses (`h2` #9b). |
| M7 | `HEAD_LOOSE_RE` fires on prose headings (M) | **OK** | `parse.ts:52` now requires a digit. `## Editing guidelines`, `## EDIT BLOCK format (exact)`, `## EDIT blocks`, `## Edits`, `### EDITS 1` → `edits: 1, problems: []`. N14's coverage is retained: `### EDIT 1 — fix the engine` and `#### EDIT 2` still report (`h2` #10). |
| M8 | dangling symlink ancestor invisible (L-M) | **OK** | `blockingAncestor` uses `lstatSync` (`apply.ts:200`). `root/link -> root/nowhere`, create `link/child.py` → `not-a-file` in **both** dry-run and real apply, nothing thrown, `listBackups` empty (`h2` #4a). Nit: the detail says `"link" is a file` when it is a dangling symlink. |
| M9 | staging failure leaves an orphan stamp (L-M) | **OK** (named half) | `apply.ts:476` `rmSync(backupDir…)`, symmetric with the rename catch. Dir `chmod 500` → `EACCES` thrown, `listBackups` `[]`, lock released, the sibling target untouched (`h2` #5). Second half of R3's fix **not** done: `rollback` still never consults `sha256Before` (`apply.ts:620`), so a hand-reverted file is reported `changed after the patch — pass force to overwrite` (`h2` #6). |
| M10 | `readTextExact` has no size cap (L-M) | **OK** | `apply.ts:230,234`. A 9,000,006-byte file → `undecodable`, `file is not valid UTF-8, or is larger than 8 MiB — refusing to rewrite it`; no `RangeError` (`h2` #7). |
| M11 | `rollback` takes no lock (L) | **INCOMPLETE** | `apply.ts:595` locks `dirname(resolve(backupDir))`. Default layout: same lock as apply — a rollback under a live apply lock is refused ✓, trailing slash is harmless (`resolve` normalises) ✓ (`h3` R1/R2). But the key is the *backup* location, not the tree: a studio rollback proceeded and rewrote `a.py` while a CLI apply held `<source>/.handbook-patches/apply.lock` (`h3` R3), and a rollback of a moved/archived stamp locks the archive dir (`h7` #4) → **F5**; rollback now also *requires write access* to the backup root → **F8**. |
| M12 | dry-run honest about content, not permissions (L) | **INCOMPLETE + REGRESSION** | `apply.ts:392-397` checks the wrong inode and is unreachable for creates → **F6**: (a) file `444` in a writable dir is now **refused** (was applied with mode preserved — R2-N17); (b) writable file in a `chmod 500` dir still passes dry-run then throws raw `EACCES`; (c) create edits never reach the check. |
| M13 | create through a dangling symlink leaf destroys the link (L) | **OK** | `apply.ts:308` `lstatSync` in a try/catch. `leaf.py -> /tmp/<absent>` with empty `old` → `unsafe-path: target is a symlink — refusing to replace the link`; `lstat` confirms the link is intact and the outside path was not created (`h2` #4b, `h3`). |
| M14 | `(unclosed fenced block)` sentinel quoted back (L) | **OK** | `parse.ts:148,178,233-236`. Unclosed `new` → `EDIT 1: a fenced block is never closed — check the fence markers`; no invented content. One cause still yields two problems (with `splitSections`' own message) → **F12**. |

Totals: **OK 9 · INCOMPLETE 4 (M4, M5, M9-second-half, M11) · INCOMPLETE+REGRESSION 1 (M12) ·
regressions of *previously verified* R2 guarantees: 3 (N1 → F1, N10 → F2, N17 → F6).**

---

## B. New findings

### F1. HIGH — the epilogue tolerance reintroduces silent truncation: a `new` block containing a fenced code block writes truncated (or empty) content
`parse.ts:191-196` (epilogue split), `parse.ts:230-231` (`void epilogue`), `parse.ts:271-277`
(`unexpected` sliced to `[0, lastEditBlock)`).

**Defect.** Stray lines and fenced blocks that land *after* the last `old`/`new` block are tolerated
unconditionally. R3's minimal fix said the opposite for one case: "Keep refusing an **untagged**
trailing block — that one really is the signature of a truncated `new`." The implementation tolerates
it. So when an inner fence closes `new` early, the debris and the leftover fenced block are
classified as "the planner's prose + declarations block" and the truncated `new` is applied.

**Scenario (reproduced, `h6` S1 — a single realistic planner-shaped plan, declarations block and
all).** `new` is markdown that *starts* with a code fence:

```
### EDIT 1
- file: `README.md`
- where: `install section` — add the command
```old
Install:
```
```new
```
npm test
```
```

```json
{"will_modify": [], "will_add": [], "will_remove": []}
```
```

→ `parsePlan`: `problems: []`, `edits: [{old:"Install:", new:""}]`
→ `applyPlan`: `ok:true`, outcome `applied — removed the matched text`
→ `README.md` `"Install:\nrun it\n"` becomes `"\nrun it\n"`. **The anchor was deleted; the code block
the plan clearly shows was never written.** No problem, no warning, ok:true.

Second shape (`h1` E1 / `h2` #1): `new` = `"Run:\n```\nnpm test\n```\nDone"` → applied as `"Run:"`;
in a two-edit plan EDIT 1 is silently truncated while EDIT 2 applies normally
(`README.md` → `"Run:\n"`, `a.py` → `"x = 2\n"`, `ok:true`). Third shape (`h1` E5, `h6` S3): an
untagged trailing block can swallow one or more later `### EDIT n` headings — `edits: 1`,
`problems: []`, the remaining edits vanish silently.

**Minimal fix.** Implement R3's recommendation #2 as written: after computing `lastEditBlock`, refuse
the section when any block at index ≥ `lastEditBlock` has `kind === ''`, and count strays that
precede such a block as `strayInside`. That catches every scenario above (each has an untagged
trailing block) and keeps M1/M2 green (a `json`-tagged epilogue block has a non-empty info string).
Residual it cannot catch: a truncated block whose debris is *pure prose* with no trailing fence —
indistinguishable from a legitimate trailing note; shrink it with F11.

### F2. HIGH — the tree lock is stolen from a live holder, so two simultaneous applies both write and one edit is silently lost
`apply.ts:144-155` (claim = `mkdirSync` **then** `writeFileSync(owner.json)` — two syscalls),
`apply.ts:161-166` (`catch { owner = {} }`), `apply.ts:167-183`.

**Defect.** A waiter that finds the lock dir reads `owner.json` to decide liveness. Between the
holder's `mkdirSync(lockDir)` and its `writeFileSync(ownerPath)` — and while that file is open but
empty — the record is absent/unparseable, which the code maps to `owner = {}` → `ownerAlive = false`
→ `rmSync` the **live** lock and take it. Both processes then run the verify+write window
concurrently, and the second `finally` deletes a lock it does not own.

**Scenario (reproduced, `h4` case A / `h5`).** Two OS processes, launched together, applying
`A→A_ONE` and `B→B_TWO` to one file:

```
round 0  P1 ok:true  ev:[[2,"warn","[patch] reclaiming a stale patch lock (its owner is gone)"], …]
         P2 ok:true                                   ← P2 was alive the whole time
         final "A\nB_TWO\n"        ← A_ONE lost
CASE A: 6 rounds → 6 rounds lost an edit, 0 lock errors      (R3 measured 8 rounds → 0 lost)
```

3 of 4 instrumented rounds show the "reclaiming a stale patch lock" warning fired against a live
owner; the 4th round shows the intended fail-fast. This is exactly R2-N10 again, now with both runs
reporting `ok:true`.

**Minimal fix.** Make the claim a single atomic syscall carrying its own payload —
`writeFileSync(lockPath, JSON.stringify({pid,host,startedAt}), {flag:'wx'})` (a lock *file*, `O_EXCL`)
— and treat "no readable owner record" as **alive** unless the lock's `mtime` is older than a short
grace window (~10 s), which also restores the age bound M4 asked for.

### F3. MED — `EPERM` from the liveness probe counts as "dead": a lock held by another user's live run is stolen
`apply.ts:169-175`.

**Defect.** `process.kill(pid, 0)` throws `EPERM` when the process **exists** but belongs to another
user (`sudo handbook apply`, a shared build box, a container sharing a mount). The bare `catch`
returns `false` → "its owner is gone" → reclaim.

**Scenario (reproduced, `h7` #1).** `owner.json = {pid: 1, startedAt: "2020-01-01"}` → `applyPlan`
reclaims and applies (`node -e "process.kill(1,0)"` → `EPERM`).

**Minimal fix.** `catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }`.

### F4. MED — reclaim is still `rmSync` + `mkdirSync`, so two runners can both take one stale lock
`apply.ts:180-182`.

**Scenario (reproduced, `h4` case C).** A genuinely stale lock (dead pid), two processes launched
together: **4 of 6 rounds both reported `ok:true`**, 6 of 6 rounds lost an edit — A reclaims and
creates its lock, B's `rmSync(…, {force:true})` deletes **A's** lock and B creates its own.

**Minimal fix.** R3's M4.2 verbatim: `renameSync(lockDir, lockDir + '.stale-' + process.pid)` (the
loser gets `ENOENT`), then acquire; if the acquire fails, fail loudly instead of proceeding.

### F5. MED — the lock's key is the backup root, not the tree: a studio apply and a CLI apply on one tree do not exclude each other
`apply.ts:265-266` (`lockRoot = resolve(backupRoot ?? <source>/.handbook-patches)`), `apply.ts:595`
(`rollback` locks `dirname(resolve(backupDir))`), `server.ts:295` (studio uses `<workDir>/patches`).

**Defect.** Mutual exclusion is only as good as the lock path, and the lock path is derived from
where *backups* go. The studio's default layout puts it outside the tree; the CLI's default puts it
inside. Two writers on the same tree with different `--backup-root` values take **different** locks.
Before `cea10e7` the lock was always `<sourceRoot>/.handbook-patches/apply.lock`, i.e. per tree.

**Scenarios (both reproduced).**
- `h4` case B — studio layout (`backupRoot=<workDir>/patches`) vs CLI default, same tree, 8 rounds:
  **8 rounds lost an edit, 0 lock errors, 8 rounds where both claimed `ok:true`**.
- `h3` R3 — a studio-layout rollback proceeded (`{restored:["a.py"]}`) while a live CLI apply held
  `<source>/.handbook-patches/apply.lock`. `h7` #4 — a rollback of a stamp copied to an archive dir
  locks the archive dir; the tree is not locked at all.

**Minimal fix.** Derive the lock path from the *tree*: `realpathSync(sourceRoot)` for `applyPlan` and
`manifest.sourceRoot` for `rollback` — either always `<realpath(sourceRoot)>/.handbook-patches/apply.lock`,
or a shared lock dir keyed by hash (`<tmpdir>/handbook-locks/<sha256(realpath)>.lock`), which also
fixes F8 and F9.

### F6. MED — the new permission check inspects the file instead of the directory: it refuses read-only files that used to patch cleanly, and still lets an unwritable directory pass dry-run
`apply.ts:392-397` (`accessSync(existsSync(p) ? p : dirname(p), W_OK)`), `apply.ts:345-366` (the
`creates` branch `continue`s before it), `apply.ts:332-334` (the now-unreachable warning).

**Defect.** The write phase never writes *to the target file*: it writes a temp sibling and
`renameSync`s it (`apply.ts:468-471`). The permission that matters is therefore **the parent
directory's**, never the leaf's. The check has it exactly backwards, and skips creates entirely.

**Scenarios (all reproduced, `h2` #3).**
- `ro.py` mode `444` in a writable dir → `ok:false`, `unsafe-path: no write permission for this path`,
  file untouched. At `9a1fc91` this applied with the mode preserved (R2-N17, verified OK in R3), and
  `apply.ts:333`'s warning `ro.py is read-only (mode 444); its mode is preserved` is now dead code
  that contradicts the outcome. Same for any file owned by another user in a writable dir.
- `sub/` mode `500`, writable file inside → **dry-run `ok:true, ["applied"]`**, real apply throws
  `EACCES: permission denied, open …/a.py.handbook-tmp-…`. M12's original scenario, still open.
- create `sub/new.py` into a `500` dir → dry-run `ok:true, ["created"]`, real apply throws raw
  `EACCES` (the stamp *is* cleaned up — M9 holds).

**Minimal fix.** One line: `accessSync(dirname(absolutePath), constants.W_OK)` (walk to the nearest
existing ancestor for creates), applied to **every** edit including creates; drop the leaf check.

### F7. LOW-MED — the owner record has no host and the lock has no age ceiling, so a recycled pid wedges the tree permanently
`apply.ts:147` (`{pid, startedAt}` only — `startedAt` is never read), `apply.ts:167-179`.

**Defect.** R3's M4 fix specified `{pid, host, startedAt}` plus "age exceeds the window **and** the
pid is dead **on the same host**". The implementation records no host and consults no age, so
liveness is a bare pid comparison: (a) a pid recycled by any unrelated process of the same user makes
a dead lock look alive forever — `another patch run (pid N) is writing to this tree`, with no
self-healing and no documented remedy; (b) on an NFS/SMB-shared checkout, a pid from another host is
compared against the local process table — either a false "alive" (denial) or a false "dead" (lost
edit, F2's class).

**Scenario (reproduced).** `owner.json = {pid: <a live `sleep` we own>}` → every apply refuses
(`h3` L1 with our own pid); `startedAt: "2020-01-01"` changes nothing (`h7` #1). A SIGKILLed holder
leaves the lock behind (`h7` #2), which is only recoverable because the pid happens to stay dead.

**Minimal fix.** Record `host` (`os.hostname()`); treat a foreign host as unknown; reclaim when
`age > N minutes` **and** the pid is not provably alive; mention the manual remedy
(`rm -rf <backup-root>/apply.lock`) in the error message.

### F8. LOW-MED — `rollback` now needs write access to the backup root, so an archived/read-only backup cannot be restored at all
`apply.ts:595` → `apply.ts:139-142`.

**Scenario (reproduced, `h7` #3).** Backup root `chmod 500` (the natural way to archive backups):
`rollback(stamp, {expectedSourceRoot})` throws
`cannot take the patch lock in <backup root>: EACCES: permission denied, mkdir …/apply.lock` — and
the message blames "the patch lock" for what the user experiences as a rollback failure. Rollback
writes nothing into the backup root; only the lock does.

**Minimal fix.** F5's tree-keyed lock; failing that, catch the acquire error in `rollback` and either
proceed with a warning or report it as `rollback cannot lock <tree>: …`.

### F9. LOW — a killed run leaves `.handbook-patches/apply.lock` in the repo with no `.gitignore`
`apply.ts:139` (`mkdirSync(lockRoot)` writes no ignore file), `apply.ts:516-517` (only
`createStampDir` writes it).

**Scenario (reproduced).** `h7` #2 — after a SIGKILLed holder, `.handbook-patches` contains exactly
`["apply.lock"]`, no `.gitignore` → untracked, un-ignored noise in `git status`. `h3` L6 — even an
unparseable plan creates an empty `.handbook-patches/` in the user's repo (the lock is taken before
`parsePlan`). R3's M5 fix explicitly asked for the ignore file here.

**Minimal fix.** Write the `.gitignore` immediately after `mkdirSync(lockRoot)` (2 lines, reusing
`createStampDir`'s logic), and remove `lockRoot` if it was created empty and unused.

### F10. LOW — the lock and backup-dir paths throw where the contract promises an `ApplyResult`, and the README documents none of the new refusals
`apply.ts:141,151,178,182`; `README.md:20-33` (safety contract), `README.md:40-42` (API table).

**Defect.** `applyPlan(options): ApplyResult` now throws for a busy lock, an uncreatable backup root
and (via F6) an unwritable directory — while the *same* inputs return `{ok:false, problems:[…]}` in
dry-run (`h2` #8b: `dryRun` returns a result, the real call throws). The studio survives this
(`jobs.ts:81-85` turns it into `job.error`, and the message *is* actionable — `another patch run
(pid N) is writing to this tree — retry when it finishes`), and `main.ts:308-311` prints it, but
library callers get no typed signal. The safety-contract table still has no row for the 8 MiB cap,
the permission refusal, the two parser refusal classes, or the lock.

**Minimal fix.** Add the four rows plus a "throws when…" note to the README; optionally return a
`lock-busy` problem instead of throwing.

### F11. LOW — `parse` does not require `old` to precede `new`, which widens F1 to the `old` block
`parse.ts:267-268` (`filter` by kind, order never checked).

**Scenario (reproduced, `h2` #2/#2b).** A section with ` ```new ` before ` ```old ` is accepted. With
that ordering, a truncated `old` becomes the *last* `old`/`new` block, so its debris is epilogue and
tolerated: `old` truncated to `"KEEP"`, `a.py` `"KEEP\nME\n"` → `"NEW\nME\n"`, `ok:true`.

**Minimal fix.** Refuse when the `new` block's index is lower than the `old` block's.

### F12. LOW — one unclosed fence still produces two problems
`parse.ts:122` and `parse.ts:233-236`.

**Scenario (reproduced, `h6` S6).** `["plan ends inside an unclosed fenced block", "EDIT 1: a fenced
block is never closed — check the fence markers"]`. M14's invented-content sentinel is gone (the real
defect); the duplication is cosmetic. Suppress the section-level message when `splitSections` already
reported EOF inside a fence.

---

## C. Attacked and clean (this round)

- **The M1/M2 reconciliation holds in both directions.** The planner-exact plan (prose → 2 EDIT
  blocks over 2 files → one `json` block → 3 echoed bullets) applies; content *between* `old` and
  `new` is still refused with the file byte-identical; a `json` block *between* `old` and `new` is
  still refused (`unexpected fenced block(s) tagged "json"`); a `json` block *between two EDIT
  sections* does not disturb either (`h6` S4).
- **A duplicate `old`/`new` pair in the epilogue is still refused** — `filter` counts every block in
  the section: `needs exactly one ```old and one ```new block (found 2 old, 2 new)` (`h1` E4). An
  epilogue block tagged something old-ish (` ```oldish `) is correctly ignored (`h6` S5).
- **Two EDIT sections where the first's payload leaks into the second** fail *safe* in the realistic
  shape: the later section's blocks push `lastEditBlock` past the debris, so the stray is
  `strayInside` and the plan is refused with nothing written (`h1` E6, `h6` S2). Only an untagged
  trailing block can swallow a header silently — that is F1's third shape.
- **Fail-fast lock behaviour does not block the event loop** (0 ms, timers fire), **dry-run bypasses
  the lock** and creates no `.handbook-patches`, and **`work()` throwing still releases the lock**
  (`h3` L1/L5, `h7` #6).
- **M8/M13's symlink handling is airtight in the cases tested**: dangling ancestor and dangling leaf
  both refuse, the link survives, and the outside target was not created.
- **Rollback's manifest validation, `expectedSourceRoot`, per-entry isolation and stamp allow-listing
  hold**; the CLI now has `--source` (`main.ts:282,289`), closing R3's N5 residual. `rollback` with a
  trailing slash locks the right directory (`resolve` normalises).
- **`studio/src/server.ts` needs no change for the parser rewrite**: `runApply` throws on `!ok` after
  logging every problem and outcome (the UI recovers outcomes from the log), `runRollback`
  allow-lists stamps via `listBackups` and passes `expectedSourceRoot`, and `listBackups` filters
  `apply.lock`/`.gitignore` out of `GET /patches`. Its one real exposure is F5 (its backup root is
  `<workDir>/patches`, so its lock never coincides with a CLI apply's).
- **The cancelling-edits path is honest enough**: `ok:true, changedFiles:[], backupDir:undefined`,
  outcomes `applied` — the UI renders `Wrote 0 file(s). Backup: —` (`h7` #5).

## Verification gates

```
$ npx tsc -b                # exit 0, no output
$ npx vitest run
  Test Files  23 passed (23)
       Tests  227 passed (227)
```

The 6 new tests cover M1/M2, M6 and the lock's two happy paths — none covers a `new` block that
contains a fenced code block (F1), and no test runs two processes (F2, F4, F5). Suggested additions:
`parsePlan` on `h6` S1 must report a problem; a two-process race asserting the loser throws.

## Verdict

**Not yet safe to point at a real repository.** Two independent silent-corruption paths remain, both
reproduced with `ok:true` and no warning: a plan whose `new` block contains a fenced code block
writes truncated or empty content (F1), and the cross-process lock is stolen from live holders
(F2/F3/F4) or not shared at all between the studio and the CLI (F5), losing an edit in 6/6 and 8/8
rounds. Fixing F1, F2, F3, F5 and F6 — roughly 20 lines across the two files — would make it safe;
until then the only defensible mode is `--dry-run` plus manual review, on a tree with no concurrent
writer.
