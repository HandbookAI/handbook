# Patcher R3 (final) — verification of the 17 R2 fixes + adversarial sweep of the third fence rewrite

Scope: `packages/patcher/src/{parse,apply}.ts` at commit `9a1fc91`, plus the integration points it
touches (`packages/studio/src/{server,state,jobs}.ts`, `packages/studio/public/index.html`,
`packages/cli/src/main.ts`, `packages/analyzer/src/adapter.ts`) and — new this round — the contract
they are supposed to honour: `packages/planner/src/prompt.ts`, `packages/planner/src/planner.ts`,
`docs/formats.md`, `packages/patcher/README.md`.

Method: full read of the rewritten parser and applier, then **9 runtime harnesses** (`h1`–`h9` in the
scratch dir) against the built `dist/`: ~45 crafted plans through `parsePlan`, ~20 tree scenarios
through `applyPlan`/`rollback` (forced `EACCES` staging failure, corrupted backup entry, dangling
symlinks, 3 GB sparse file, read-only tree/file, in-root symlinks with longer/shorter realpaths),
**8 rounds of two OS processes applying to one tree**, a stale/live lock matrix, and a live
`node:http` server measured while an apply waited on the lock. **No repo file was modified**; every
temp tree lived under `$TMPDIR`. This document is the only file added.

Verdict: **13 of 17 R2 findings fully fixed, 3 incomplete, 1 not fixed, 0 regressions of the R2
defects themselves.** Both R2 HIGH defects (N1, N2) are genuinely closed — I could not find a single
silent-truncation or phantom-edit path in the new parser, which is a real achievement after three
attempts.

But the fix package that closed them **over-corrected**: the parser now refuses the exact plan shape
`packages/planner/src/prompt.ts` instructs the model to emit and `docs/formats.md` documents. The
parser and the planner prompt **DISAGREE**.

**14 new findings: 2 High, 5 Medium, 7 Low.** Everything below was reproduced at runtime.

---

## A. R2 fix verification

| # | R2 title (sev) | Verdict | Trace against current code |
|---|---|---|---|
| N1 | inner bare fence truncates `old`/`new` (H) | **OK** | Structural-integrity rule (`parse.ts:217-224`). `docs/g.md` scenario (R2 Scenario A verbatim): `ok:false`, `problems:["EDIT 1: content outside the fenced blocks (\"npm test\"…)"]`, file byte-identical afterwards (`h4`). The 4-tick form the message recommends applies cleanly. I then enumerated every arrangement in which an early close could leave a *clean* `[old,new]` pair (bare fence as last content line, bare fence in `new`, two bare fences, bare fence + blank tail): each ends as `found 1 old, 0 new`, `unexpected fenced block(s) tagged ""`, or stray → **no silent-truncation path found**. |
| N2 | `~~~` region hides an EDIT (H) | **OK** | `FENCE_RE`/`closes` track marker char + run (`parse.ts:54,78-81`). R2's exact plan: 0 edits, `ok:false`, `src/real.py` still `""`, `a.py` still `"A\n"` (`h4`). The related LOW is also gone: `~~~old`/`~~~new` blocks now parse as `old`/`new` (`h1` B6). |
| N3 | analyzer ingests backup copies (M) | **OK** | `.handbook-patches` in `COMMON_SKIP_DIRS` (`adapter.ts:34`) + `.gitignore` containing `*` written on first use (`apply.ts:461-462`). After an apply, `discoverByExtension(root,['.py'])` → `["app/engine.py"]` only (`h6b`). Residual → **M5**. |
| N4 | duplicate/overlapping `sourceRoot` (M) | **OK** | `state.ts:75-79` compares `realpathSync` and rejects containment both ways. Trailing slash, nested child and the `/var`↔`/private/var` alias are all rejected now. Residual (note only): `jobs.ts:34` still keys the mutex on the repo *name* and a pre-existing `studio.json` is not re-validated on load — but the new cross-process lock covers apply-vs-apply, so the R2 hazard is contained. |
| N5 | rollback trusts the manifest's own `sourceRoot` (M) | **INCOMPLETE** | `expectedSourceRoot` exists (`apply.ts:493,540-546`) and the studio passes it (`server.ts:329`) — a mismatched manifest throws, a matching one restores (`h2`). But R2's fix explicitly named the CLI, and `main.ts:279-286` still has no `--source` and passes nothing: `rollback(<foreign backup>, {})` restored into the foreign tree, verified (`h2`). The non-adversarial half (repo moved, old stamp rolled back from the CLI) is still open. |
| N6 | duplicate create in one plan (M) | **OK** | `apply.ts:301-304`. Two creates of `new.py` → `no-match: another edit in this plan already writes this file — merge them`, `ok:false`, `new.py` not created (`h2`). |
| N7 | rollback loses its report mid-loop (M) | **OK** | Per-entry `try/catch` (`apply.ts:553,579-582`). Backup copy replaced by a directory: `{restored:["a.py","c.py"], skipped:[{b.py, "restore failed: ENOTSUP …"}]}`, and zero stray `*.handbook-rollback-*` files (`h2`). `statSync(...).isFile()` was not added, but the catch subsumes it. |
| N8 | false positive on legitimate inline backticks (M) | **OK** | The `suspicious` heuristic is gone. `const FENCE = "```";` edited with 3-tick fences → applies, file becomes `const FENCE = "````";` (`h4`). A **lone** bare-fence content line is now refused instead — the defensible split (it is the genuinely ambiguous case, refusal not corruption, and the recommended longer fence works). One indentation flaw remains → **M6**. |
| N9 | create under a non-directory ancestor (M) | **INCOMPLETE** | `blockingAncestor` (`apply.ts:168-177`) closes the regular-file case: `a.py/child.py` → `not-a-file: "a.py" is a file, so it cannot contain this path` in **both** dry-run and real apply (`h2`). It uses `existsSync`, which follows symlinks, so a **dangling** symlink ancestor is still invisible: dry-run `ok:true, ["created"]`, real apply throws raw `ENOENT … mkdir` and leaves an orphan stamp (`h5`) → **M8**. |
| N10 | no cross-process lock; concurrent applies lose an edit (M) | **OK** | `withTreeLock` (`apply.ts:133-165`). Two `node` processes applying `A→A_ONE` and `B→B_TWO` to one file, launched without waiting, **8 rounds: 0 edits lost** (every round ended `"A_ONE\nB_TWO\n"`, two stamps, both `ok:true`) — was 8/8 lost in R2 (`h3`). New findings about the lock itself → **M3, M4, M5, M11**. |
| N11 | a plan can edit its own backup tree (M/L) | **OK** | `apply.ts:255-258`. `.handbook-patches/<stamp>/files/a.py` → `unsafe-path: target is inside the patch backup tree` (`h2`). |
| N12 | orphan stamp after a failed write / false "changed after the patch" (L) | **INCOMPLETE** | The *rename* path now deletes the stamp (`apply.ts:445`). The *staging* path does not (`apply.ts:420-423`): a read-only target dir → `EACCES`, stamp survives, and rolling it back says `changed after the patch — pass force to overwrite` although the file is untouched (`h2`). R2's second half was not implemented either — `apply.ts:556` never compares `sha256Before`, so a hand-reverted file gets the same wrong reason (`h5`) → **M9**. |
| N13 | asymmetric indent handling (L) | **OK** | `parse.ts:171-177` strips `min(opener indent, actual leading ws)`; 2-space opener with a 1-space content line → `"x = 1\ny = 2"` (CommonMark-correct). `FILE_RE`/`WHERE_RE` allow 0-3 spaces (`parse.ts:55-56`); the nested-bullet plan parses (`h1`, `h5`). |
| N14 | decorated/mis-levelled heading vanishes (L) | **OK** | `HEAD_LOOSE_RE` (`parse.ts:52,114-116`). `### EDIT 1 — fix the engine` and `#### EDIT 2` both report `line looks like an edit heading but is not "### EDIT <n>": …`. New false positive → **M7**. |
| N15 | studio UI cannot pass `force`, `skipped` never rendered (L) | **NOT FIXED** | `index.html:1799` still posts `{ backup }` only; `1804-1807` discards `result`; `grep -n "force" index.html` → no match. The commit's `index.html` diff is unrelated CSS/responsive work (`git show 9a1fc91 -- packages/studio/public/index.html`). A guarded rollback is still a dead end in the UI. |
| N16 | CLI `--backup-root` help stale (L) | **OK** | `main.ts:264` now reads `default <source>/.handbook-patches`. |
| N17 | read-only files silently patched (L) | **OK** (as designed) | `apply.ts:287-289` warns `ro.py is read-only (mode 444); its mode is preserved`; content replaced, mode still `444` (`h5`). |

Totals: **OK 13 · INCOMPLETE 3 (N5, N9, N12) · NOT FIXED 1 (N15) · REGRESSION of an R2 defect 0.**

---

## B. Do the parser and the planner prompt agree?

**No. They disagree, and the disagreement is new in `9a1fc91`.**

`packages/planner/src/prompt.ts:76-80` (verbatim):

```
## Finishing
When your plan is complete, finish with: a short prose summary, then ALL EDIT blocks, then EXACTLY
one declarations JSON block at FUNCTION granularity using ${vars.qualnameNote}:
```json
${vars.declExample}
```
```

…followed by three explanatory bullets (`prompt.ts:81-83`) that the model routinely echoes.
`docs/formats.md:216` states the same contract — "A markdown plan: prose summary → EDIT blocks →
one declarations JSON block" — and shows it (`formats.md:219-233`). `planner.ts:124,133` returns that
text **verbatim** as `result.plan` (it must: `parseDeclarations` reads the json block *out of the
plan text*). The studio puts that text in the textarea (`index.html:1782`) and POSTs it unchanged
(`index.html:1831-1837`) to `runApply`, which passes it straight to `applyPlan` (`server.ts:302-308`).

Because the declarations block sits *after* the last `### EDIT`, it belongs to the last EDIT
section, and the rewritten parser refuses it. Verified end-to-end on a real tree (`h4`):

```
plan = "Add a retry …\n\n### EDIT 1\n- file: `app/engine.py`\n- where: …\n```old…```\n```new…```\n\n```json\n{...}\n```"
→ ok:false  problems:['EDIT 1 (app/engine.py): unexpected fenced block(s) tagged "json" — only `old` and `new` belong in an edit']
→ 0 outcomes, app/engine.py byte-identical
the same plan with the json block deleted → ok:true, changedFiles:["app/engine.py"]
```

So **the first thing a user does in the studio — "Plan the change" then "Apply patch" — cannot
succeed** unless they hand-edit the plan. Same for `handbook plan > plan.md && handbook apply --plan
plan.md`. This is **M1** below; the trailing-prose half is **M2**. It is a regression against
`e40e622`, whose `captureFences` simply ignored blocks it did not recognise and never inspected
content outside them.

Root cause of the miss: `patcher.test.ts`'s `plan()` helper (`patcher.test.ts:12-19`) ends every
fixture at the last `new` fence, so none of the 221 tests exercises the documented plan shape.

**Minimal reconciliation** (parser-side; keeps every N1/N2 guarantee):

1. In `captureFences`, split the stray bucket in two — `strayInside` (non-blank lines between the
   first fence and the **last** captured block) and `epilogue` (everything after the last block).
   Refuse only on `strayInside`. In the N1 scenario the leftover `npm test` / `outer` lines sit
   *between* blocks, so it still refuses; a trailing note is epilogue, so it passes.
2. In `parsePlan`, treat a fenced block that appears **after** both `old` and `new` were captured
   and that carries a non-empty info string other than `old`/`new` (i.e. the `json` block) as
   epilogue too. Keep refusing an **untagged** trailing block — that one really is the signature of a
   truncated `new`.
3. Add two regression tests: the `docs/formats.md` plan verbatim, and the same plan plus a trailing
   prose line.

Optional belt-and-braces (verified to parse today, `h8`): move the declarations block *before* the
EDIT blocks in `prompt.ts:76-80` and `docs/formats.md:216-233`. That alone does **not** fix M2 (a
trailing prose sentence is still refused), so it is a complement, not a substitute. Whichever way it
goes, `packages/patcher/README.md:19-33` needs a row for the two new refusal classes — the safety
contract table documents none of them.

---

## C. New findings

### M1. HIGH — the declarations JSON block that the prompt requires makes every unedited planner plan unapplicable
`parse.ts:246` (`unexpected` filter), `parse.ts:253-259` (the refusal); contract at
`prompt.ts:76-80`, `docs/formats.md:216`, wiring at `planner.ts:124,133` → `index.html:1782,1831` →
`server.ts:302`.

**Defect + scenario.** See section B. `ok:false`,
`unexpected fenced block(s) tagged "json" — only \`old\` and \`new\` belong in an edit`, nothing
written, on the exact plan shape the prompt prescribes. Reproduced against a real tree (`h4`) and
with 4-tick fences too (`h9`), so no fence-length workaround exists.

**Minimal fix.** B.2 above (tolerate a *tagged* fenced block that appears after both `old` and `new`
were captured). Two lines in `parsePlan`.

### M2. HIGH — any prose after the last `new` block refuses the plan, with a message that misdiagnoses the cause and gives advice that does not work
`parse.ts:147-149` (stray collection), `parse.ts:217-224` (the message).

**Defect.** The structural rule treats *all* non-blank content outside fences as evidence of an
early close. A trailing note, a `## Declarations` heading, or the prompt's own
`- "will_modify": every EXISTING function whose implementation changes.` bullet (echoed after the
json block) all trip it. The message says an inner fence "probably closed a block early" and tells
the author to *open `old`/`new` with a longer fence* — following that advice does **not** help:
verified with 4-tick fences, the same refusal (`h9`). The author has to guess that a note must be
deleted.

**Scenarios (all reproduced, `h1`/`h4`/`h8`).**
- `…```new\nA2\n```\n\nThis keeps the public API stable.` → refused, `a.py` untouched.
- `…```new…```\n\n## Declarations\n\n```json\n{}\n```` → refused on `"## Declarations"`.
- `…```json\n{}\n```\n- "will_modify": every function whose body changes.` → refused on the bullet.

**Minimal fix.** B.1 above (`strayInside` vs `epilogue`), and when `strayInside` *is* non-empty keep
today's message but quote the line and say *which* block ended early.

### M3. MED — the lock wait busy-spins on the event loop: a waiting apply freezes the whole studio server for up to 30 s
`apply.ts:153-158` (`while (Date.now() < until) {}`), `apply.ts:136,152` (30 s deadline).

**Defect.** `applyPlan` is synchronous by contract, so the wait is implemented as a CPU spin in
200 ms slices. Node is single-threaded: while an apply waits, **no** timer, HTTP request or SSE
write in that process runs. `jobs.ts` serialises jobs per repo, but the lock is per *tree*, so a CLI
apply (or a second repo pointing at an overlapping tree, or a stale-lock race) parks the studio.

**Scenario (reproduced, `h2`/`h7`).** In-process: a `setTimeout(…, 300)` scheduled before the wait
never fired during a 30.2 s spin. Live: with a `node:http` server on 127.0.0.1:47861 in the same
process, a `curl` issued 1 s into the wait was answered after **29.35 s** (`real 29.35`); two later
requests returned in 0.00 s. One core is pinned for the whole window.

**Minimal fix.** Sleep without burning the loop — `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)`
(≈2 lines, keeps the synchronous contract, no CPU burn) — and lower the ceiling / log progress. The
real fix, if the studio is to stay responsive, is an async `applyPlanAsync` for the server path.

### M4. MED — lock staleness is unsafe in three ways: stolen from slow-but-live runs, racy reclaim, and one unbounded path
`apply.ts:143-151`.

**Defects.**
1. The lock dir's `mtime` is stamped once at creation and never refreshed, and the staleness window
   is fixed at 5 minutes. A legitimate apply that takes longer (huge plan, cold network volume,
   `readTextExact` on very large files — see **M10**) has its lock removed by the next runner, which
   reinstates exactly the N10 lost-edit hazard the lock exists to prevent.
2. Reclaim is `rmSync` then `mkdirSync` — not atomic. Two waiters that both see the same stale lock
   can both proceed: A removes it and creates its own; B's `rmSync(…, {force:true})` then deletes
   **A's live lock** and B creates its own. Both believe they hold it.
3. The `catch { continue }` at `apply.ts:149-151` skips both the deadline check and the 200 ms
   sleep, so a lock dir that keeps appearing/vanishing (another runner cycling, or an FS that throws
   on `statSync`) spins hot **forever** — the 30 s deadline is never consulted on that path.
4. No owner is recorded, so "is the holder alive?" cannot be answered; only wall-clock age is.

**Minimal fix.** Write `<lock>/owner.json` with `{pid, host, startedAt}` and refresh its `mtime`
every ~30 s of work (or on every file staged); treat a lock as stale only when the age exceeds the
window **and** `process.kill(pid, 0)` fails on the same host; reclaim with `renameSync(lockDir,
lockDir + '.stale-' + pid)` (atomic — the loser gets `ENOENT`) instead of `rmSync`; and move the
deadline check to the top of the loop so every path is bounded.

### M5. MED — the lock is created inside `sourceRoot` even when `backupRoot` points elsewhere, and lock errors surface as raw errnos
`apply.ts:134-135` (`join(resolve(sourceRoot), '.handbook-patches', 'apply.lock')`) vs
`apply.ts:235` (`effectiveBackupRoot`), `server.ts:293-295` (studio uses `<workDir>/patches`).

**Defects + scenarios (reproduced, `h2`/`h4`).**
- With a custom `backupRoot`, an apply still creates `<sourceRoot>/.handbook-patches/` in the user's
  repo — empty afterwards, and **without** the `.gitignore` that `createStampDir` writes into the
  *backup* root (`h2`: `.gitignore there? false`). If a run is killed mid-apply, the repo is left
  with an untracked, un-ignored `.handbook-patches/apply.lock` in `git status`. The studio is the
  default configuration here, and its whole premise is that generated artifacts live outside the
  source tree (`state.ts:64-68` enforces exactly that for `workDir`).
- `withTreeLock` runs **before** `parsePlan`, and its `mkdirSync` is unguarded: on a read-only tree,
  `applyPlan({plan:'this is not a plan at all'})` throws
  `EACCES: permission denied, mkdir …/.handbook-patches/apply.lock`, while the same call with
  `dryRun:true` politely returns `{ok:false, problems:['no "### EDIT <n>" blocks found in the plan']}`.
  Callers get a raw errno where the documented contract promises an `ApplyResult`.

**Minimal fix.** Put the lock in `effectiveBackupRoot` (compute it before locking — one hoisted
line), write the `.gitignore` when the lock dir's parent is created, and wrap the acquire in a
`try/catch` that rethrows as `new Error('cannot lock <root> for patching: …')`.

### M6. MED — `closes()` ignores the closer's indentation, so an ordinary 4-space-indented fence inside `old` refuses the plan
`parse.ts:78-81`.

**Defect.** CommonMark: a closing fence may be indented **at most 3 spaces**; a more-indented
backtick run inside a fenced block is content. `closes()` tests only marker char, run length and
empty info, so any indentation closes. Editing markdown whose content contains a fence nested in a
list item — the single most common markdown shape after a plain fence — therefore ends in M2's
misleading refusal.

**Scenario (reproduced, `h8`).** `old` = ``"- steps:\n\n    ```\n    npm test\n    ```\n"`` with
3-tick fences → `content outside the fenced blocks ("npm test"…)`. The same plan with 4-tick fences
parses, with the content byte-exact — proving the content was never ambiguous.

**Minimal fix.** In `closes`, add `&& fence.indent.length <= Math.max(3, open.indent.length)`
(the `max` keeps today's tolerance for deeply indented *openers*, which CommonMark would not accept
either but which existing plans rely on).

### M7. MED — `HEAD_LOOSE_RE` fires on ordinary prose headings, and that problem is fatal
`parse.ts:52,114-116`; fatality at `apply.ts:242` (`ok = problems.length === 0`).

**Defect.** `/^\s*#{1,6}\s*EDIT\b/i` matches any heading containing the word EDIT followed by a
non-word char. The plan's own summary section — the prompt's format section is literally titled
`## EDIT BLOCK format (exact)` (`prompt.ts:56`) — makes this a realistic echo. Because every problem
is fatal, a plan whose edits all parse correctly is refused.

**Scenario (reproduced, `h1`).** `## EDIT blocks\n\n### EDIT 1\n…` → `edits: 1` **and**
`problems: ['line looks like an edit heading but is not "### EDIT <n>": ## EDIT blocks']` → `applyPlan`
returns `ok:false`, nothing written.

**Minimal fix.** Require a number: `/^\s*#{1,6}\s*EDIT\s+\d/i`, and only report it when the line is
not a valid head (as now). That keeps N14's coverage (`#### EDIT 2`, `### EDIT 1 — fix the engine`)
and drops prose headings.

### M8. LOW-MED — a dangling symlink ancestor is invisible to `blockingAncestor`: green dry-run, then a raw `ENOENT`, plus an orphan stamp
`apply.ts:173` (`existsSync` follows symlinks), `apply.ts:415` (`mkdirSync` in the staging loop).

**Scenario (reproduced, `h5`).** `root/link -> root/nowhere` (dangling), plan creates
`link/child.py`: dry-run `{ok:true, outcomes:[["created",null]]}`; the real apply throws
`ENOENT: no such file or directory, mkdir …/link` out of `applyPlan`, and `listBackups` afterwards
shows a stamp for a patch that never happened. N9's class, one symlink away.

**Minimal fix.** Use `lstatSync` in `blockingAncestor` (catch `ENOENT`) and report `not-a-file`
("a parent path component is a symlink or not a directory").

### M9. LOW-MED — a staging failure still leaves an orphan stamp, and rollback still calls an untouched file "changed after the patch"
`apply.ts:420-423` (staging catch — no `rmSync(backupDir)`, unlike the rename catch at
`apply.ts:445`), `apply.ts:556` (`sha256Before` never consulted).

**Scenarios (both reproduced, `h2`/`h5`).**
- Target dir `chmod 500` → staging `writeFileSync` throws `EACCES`; afterwards
  `listBackups` → `["2026-…Z"]`, the file is untouched, and rolling that stamp back returns
  `skipped:[{file:"sub/a.py", reason:"changed after the patch — pass force to overwrite"}]`.
- Apply, then hand-revert the file to its pre-patch bytes → rollback reports the same wrong reason
  instead of "already at the pre-patch bytes".

**Minimal fix.** Add `rmSync(backupDir, {recursive:true, force:true})` to the staging catch (one
line, symmetric with `apply.ts:445`), and in `rollback` check
`currentHash === entry.sha256Before` first → `skipped: 'already at the pre-patch bytes'` (or simply
count it as restored).

### M10. LOW-MED — `readTextExact` has no size cap: a raw `RangeError` above 2 GiB, ~3× memory below it
`apply.ts:200-205`.

**Scenario (reproduced, `h2`).** A 3 GB sparse file named by a plan →
`RangeError [ERR_FS_FILE_TOO_LARGE]: File size (3221225472) is greater than 2 GiB` thrown out of
`applyPlan` (inside the lock; the `finally` does release it). Below the limit there is no throw but
the file is materialised three times — `readFileSync` buffer + `toString('utf8')` string +
`Buffer.from(text)` for the round-trip check — so a ~700 MB vendored asset costs ~2 GB RSS and can
OOM the studio server, which holds all other repos' state.

**Minimal fix.** `statSync(path).size > MAX_PATCH_FILE (e.g. 8 MiB)` → return `undefined` and report
a new `too-large` status (or reuse `not-a-file` with a detail); no plan legitimately anchors into a
multi-megabyte file.

### M11. LOW — `rollback` takes no lock, so it can interleave with a concurrent apply on the same tree
`apply.ts:537` (no `withTreeLock`), `main.ts:285`, `server.ts:327-331`.

**Scenario (reproduced, `h4`).** With `<root>/.handbook-patches/apply.lock` held (an apply in
flight), `rollback(backupDir, {expectedSourceRoot: root})` proceeded and rewrote `a.py`:
`{restored:["a.py"]}`. A studio rollback during a CLI apply (or two CLIs) can therefore restore
bytes the apply is about to overwrite, and the apply's own backup then describes a state that never
existed.

**Minimal fix.** Wrap `rollback`'s loop in `withTreeLock(manifest.sourceRoot, …)`.

### M12. LOW — dry-run is honest about content but not about permissions
`apply.ts:370-373` (dry-run return), write phase at `apply.ts:411-432`.

**Scenario (reproduced, `h2`).** Target directory `chmod 500`: dry-run `{ok:true}`; the real apply
throws `EACCES: permission denied, open …`. Nothing is corrupted (staging aborts before any rename),
but `ApplyResult`'s promise ("True only when every edit … would land, in dry-run") is broken.

**Minimal fix.** During verification, `accessSync(dirname(absolutePath), W_OK)` for each target (and
the leaf when it exists) → `unsafe-path`/`not-a-file` with detail `not writable`.

### M13. LOW — a create through a dangling symlink leaf silently destroys the link
`apply.ts:270` (`existsSync(...) ? lstatSync(...) : undefined`).

**Scenario (reproduced, `h5`).** `root/link.py -> <outside>/victim.py` (target absent) with an empty
`old`: `ok:true, created`; `link.py` is now a regular file and the symlink is gone. Nothing is
written outside the root (`renameSync` replaces the link itself, verified: the outside path was not
created), so this is a data-loss-of-one-symlink issue, not an escape — but R1 #13's rule ("never
replace a symlink") is bypassed because `existsSync` is consulted before `lstatSync`.

**Minimal fix.** `lstatSync` in a `try/catch` instead of `existsSync ? lstatSync : undefined`, so
dangling links are seen and refused like any other symlink.

### M14. LOW — the "(unclosed fenced block)" sentinel is quoted back to the user as if it were their content, and one cause yields two problems
`parse.ts:169`, `parse.ts:119`, `parse.ts:217-224`.

**Scenario (reproduced, `h1` B10).** A plan whose `new` block is unclosed at EOF reports
`plan ends inside an unclosed fenced block` **and**
`EDIT 1: content outside the fenced blocks ("(unclosed fenced block)"…) — an inner fence probably
closed a block early; open old/new with a LONGER fence`. The second message invents content the
author never wrote and blames the wrong thing.

**Minimal fix.** Track `unclosed` as its own boolean on the capture result and emit
`EDIT n: the last fenced block is never closed — add the closing fence`; do not push a sentinel into
the stray list.

---

## D. Attacked and clean (this round)

- **No silent-truncation path in the new parser.** Six arrangements designed to leave a clean
  `[old,new]` pair after an early close all ended in a refusal (see N1 above). The parser now fails
  closed in every fence shape I could build.
- **`safeResolve`'s `real + suffix` concatenation is correct.** `suffix` is sliced from `full` at
  `probe.length`, and `probe` is always a string prefix of `full`, so the length of the ancestor's
  realpath is irrelevant. Verified three ways (`h5`): short link → long dir (`s/new.py` landed in
  `a_very_long_directory_name/`), long link → short dir, and an escaping link → `unsafe-path` with
  nothing written outside. The only path whose realpath ends in a separator is `/`, and that case is
  unreachable (the root always exists).
- **Symlink-aliased or differently-cased `sourceRoot` does not defeat the lock**: both spellings
  `mkdirSync` the same inode, so the second run gets `EEXIST` as intended (`h2`).
- **Stale locks are reclaimed instantly**: a lock backdated 10 minutes was stolen and the apply
  proceeded in 1 ms (`h2`).
- **The lock is released when `work()` throws** — after a staging `EACCES`, `apply.lock` was gone
  and only the stamp remained (`h4`). `createStampDir` is still bounded at 501 attempts.
- **Dry-run bypasses the lock** (`apply.ts:229`) — correct: it writes nothing, and it means a
  verification cannot be blocked by an in-flight apply. It also, correctly, creates no
  `.handbook-patches`.
- **CommonMark divergences all fail *safe*.** A backtick opener whose info string contains backticks
  (`` ```js `x` ``) is not a fence in CommonMark but is treated as one here → the region is masked,
  so a quoted `### EDIT n` inside it stays content (`h1` B3: refused, no phantom edit). Over-masking
  can only hide edits, never invent them. Closers with trailing spaces/tabs, `~~~old`/`~~~new`,
  4-tick openers with a 5-tick run inside, CRLF plans, `###  EDIT  1`, `### EDIT 1   `, a preamble
  containing a fence, and content before the first heading all behave sensibly (`h1`, `h8`).
- **Rollback manifest validation, `expectedSourceRoot`, per-entry isolation, mode preservation, the
  `pending` filter, the two-phase write, backup-tree refusal, duplicate creates, and the analyzer
  skip** all held under the scenarios listed in section A.

## Verification gates

```
$ npx tsc -b                # exit 0, no output
$ npx vitest run
  Test Files  23 passed (23)
       Tests  221 passed (221)
```

Note that these 221 tests pass *while* the pipeline's own documented plan format is unapplicable
(**M1**) — the gap is in `patcher.test.ts:12-19`, whose `plan()` helper never emits a declarations
block or a trailing line.
