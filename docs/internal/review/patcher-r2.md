# Patcher R2 — verification of the 28 R1 fixes + adversarial sweep of the rewritten code

Scope: the rewritten `packages/patcher/src/{parse,apply}.ts` (commit `e40e622`), the patched
integration points `packages/studio/src/{server,jobs,state}.ts`, `packages/cli/src/main.ts`, plus
`packages/studio/public/index.html` (rollback/apply contract) and
`packages/core/src/util/fsx.ts`.

Method: full read of every file above, then **10 runtime harnesses** against the built `dist/`
(`h1`–`h10` in the scratch dir) covering ~95 scenarios: a forced `EPERM` on the *second* rename via
the macOS user-immutable flag, a pinned clock for stamp collisions, symlinked-directory escapes,
seven crafted manifests, a live studio on 127.0.0.1 (`/apply`, `/rollback`, `/patches`, `/jobs`),
`StateStore.add` directly, and 8 rounds of two OS processes patching one tree in parallel.
**No repo file was modified**; every temp tree lived under `$TMPDIR`.

Verdict: **19 of 28 findings fully fixed, 7 incomplete, 2 partial, 0 regressions of the original
defect.** The rewrite is a large net improvement — but it re-opens the two worst R1 defects (#2, #3)
through new parser paths, and the #26 fix introduced a new problem of its own.

**17 new findings: 2 High, 8 Medium, 7 Low.** Everything below was reproduced at runtime unless
marked PLAUSIBLE.

---

## A. R1 fix verification

| # | R1 title (sev) | Verdict | Trace |
|---|---|---|---|
| 1 | write phase not atomic (H) | **OK** | Two-phase stage-then-rename (`apply.ts:332-365`). Forced `EPERM` on rename #2 (immutable target): threw `EPERM`, `aaa/one.py` restored to `ONE\n`, `zzz/two.py` untouched, zero stray `handbook-tmp` files, mode preserved. Staging-phase failure also cleans up (`h9`). Residual → **N12**. |
| 2 | nested equal-length fence truncates `old`/`new` (H) | **INCOMPLETE** | `suspicious` (`parse.ts:127-131`) catches inner fences *with* an info string and unclosed blocks (verified refusals), but the close test at `parse.ts:122` runs **first**, so an inner fence with an **empty** info string still closes the block early. Two of them restore parity → silent truncation, `problems: []`, bad bytes written → **N1**. |
| 3 | `### EDIT n` inside a fence splits the plan (H) | **INCOMPLETE** | Backtick fences are masked (`parse.ts:66-88`; a 4-tick-quoted `### EDIT 2` yields exactly 1 edit, verified). `~~~` fences are not tracked at all (`parse.ts:48` is backticks-only) → a quoted example inside `~~~` becomes a real edit that patched `src/real.py` with `SECRET = 666`, `ok:true`, `problems: []` → **N2**. |
| 4 | symlink escape on create (H) | **OK** | `safeResolve` realpaths the deepest existing ancestor (`apply.ts:102-117`). `vendor -> <outside>` + `- file: vendor/pwned.py` → `unsafe-path`, nothing created outside; nested `vendor/deep/new/f.py` likewise. |
| 5 | rollback trusts the manifest (H) | **INCOMPLETE** | `readManifest` (`apply.ts:412-439`) rejected all 7 crafted manifests (`../../` write, `../../` delete, absolute `entry.file`, backslashes, relative `sourceRoot`, no `files`, non-JSON) with the victim intact. But no caller passes an expected root, so a *valid* manifest naming an unrelated absolute `sourceRoot` still restored into that foreign tree (verified) → **N5**. |
| 6 | rollback ignores `sha256Before` (H) | **OK** | `sha256After` is recorded (`apply.ts:318,321`) and checked (`apply.ts:457`). Post-patch edit → `skipped: "changed after the patch — pass force to overwrite"`, file kept; `{force:true}` restored byte-exactly. |
| 7 | stamp collision in one millisecond (H) | **OK** | `createStampDir` non-recursive + `-1,-2,…` (`apply.ts:374-387`). Clock pinned to a fixed ISO string: two applies → `…000Z` and `…000Z-1`, both listed, the first backup still holds the original `A\nB\n`. Loop bounded at 501 attempts. |
| 8 | non-UTF-8 silently rewritten (H→M) | **OK** | `readTextExact` round-trip check (`apply.ts:141-146`). `# caf\xe9` file → `undecodable`, `ok:false`, `0xe9` still on disk. |
| 9 | create guard disabled for touched files (M) | **INCOMPLETE** | Guard now judged on-disk (`apply.ts:226-230`): empty-`new` then create → `no-match`, file intact. But R1's second clause is missing — two create edits for one path both report `created` and the second silently discards the first → **N6**. |
| 10 | silently dropped edits (M) | **PARTIAL** | Extra `old`/`new` pairs and bodies absorbed from a malformed head are now loud (`found 2 old, 2 new`, `parse.ts:196`). No malformed-head detection though: a plan of only `#### EDIT 2` reports `no "### EDIT <n>" blocks found` → **N14**. |
| 11 | CRLF mismatch (M) | **OK** | `dominantEol`/`toEol` retry (`apply.ts:247-255`). LF plan → CRLF file gave `"def a():\r\n    return 2\r\n"`; CRLF plan → LF file gave pure LF; a mixed-EOL file was spliced without EOL damage. |
| 12 | mode dropped 755→644 (M) | **OK** | `modeByPath` + `chmodSync` after rename (`apply.ts:350-351`). `run.sh` stayed `755`; mode also survives the rename-failure restore path. |
| 13 | editing through an in-root symlink (M) | **OK** | `lstatSync` check (`apply.ts:196-199`) → `unsafe-path: target is a symlink — refusing to replace the link`. |
| 14 | directory target throws instead of a status (M) | **PARTIAL** | A directory *leaf* now yields `not-a-file` (`apply.ts:201-203`). Ancestors are never checked: a create under a path whose parent is a regular file verifies as `created` (dry-run `ok:true`) and then throws raw `EEXIST` from the write phase → **N9**. |
| 15 | `problems` never reach the studio (M) | **OK** | `server.ts:309-317` logs every problem and puts `problems.join('; ')` in the thrown message. Verified over HTTP: parse-only failure → `error: "plan did not verify — nothing was written: no \"### EDIT <n>\" blocks found in the plan"`; per-edit failure logs `✗ EDIT 1 a.py — no-match: …`, which matches `outcomesFromLog`'s regex (`index.html:1511`). Residual: `job.result` is still `undefined` on failure. |
| 16 | empty `new` truncates silently (M) | **PARTIAL** | `detail: "removed the matched text"` is now emitted (`apply.ts:272`). The "`new` empty **and** `old` is the whole file" case is still a plain `applied` with a 0-byte result and no `allowTruncate` gate. Low residual risk — rollback recovers it. |
| 17 | `POST /rollback` path traversal (M) | **OK** | Allow-list at `server.ts:322-326`. Live studio: `../../etc`, `../..`, an absolute planted backup dir, a `../…×10` traversal to it, and `nope` all failed with `unknown backup "…"`; the planted victim file stayed `ORIGINAL`. |
| 18 | rolling back twice deletes re-created files (M) | **OK** | `sha256After` guard on the delete branch (`apply.ts:457`). Rollback → human re-creates `made.py` → second rollback `skipped: changed after the patch`, the human's file survived. (A *byte-identical* re-creation is still deleted — acceptable.) |
| 19 | mutex keyed on repo name / duplicate `sourceRoot` (M) | **INCOMPLETE** | `state.ts:66-68` rejects only exact string equality. Verified accepted: trailing slash, a **nested** child of a registered root, and the `/var` vs `/private/var` symlink alias. `jobs.ts:34` still keys on the name → **N4**. |
| 20 | edit order / duplicate indices unvalidated (M) | **OK** | `parse.ts:168-171`. `### EDIT 2` before `### EDIT 1` → `edit numbers must ascend`, `ok:false`, file untouched; duplicates → `duplicate edit number`. |
| 21 | indented fences bake in indentation (M) | **OK** | Opener indent stripped (`parse.ts:137`); the indented-fence plan that R1 reproduced now parses to clean `old`/`new`. Two rough edges → **N13**. |
| 22 | `- file:`/`- where:` read from inside fences (L) | **OK** | Header limited to `lines.slice(0, firstFenceAt)` (`parse.ts:173-177`). A `- where:` hidden in `old` no longer hijacks (`where === ''`). |
| 23 | 0-byte file reported as `created` (L) | **OK** | `applied` + `detail: "filled a previously empty file"` (`apply.ts:236-237`). |
| 24 | dead `writeApplyReport` export (L) | **OK** | Removed — `grep -rn writeApplyReport packages docs` (excluding `dist/`) hits only the R1 doc. |
| 25 | `- file:` accepts junk (L) | **OK** | `pathProblem` (`parse.ts:144-151`) rejects `~`, absolute, backslashes, whitespace, backticks; `` - file: ``a.py`` `` now parses correctly; `src/../../a.py` still stopped later as `unsafe-path`. |
| 26 | backup root outside the repo (L) | **OK, with regressions** | Default is now `<sourceRoot>/.handbook-patches` (`apply.ts:304`), so sibling checkouts no longer share a root. Three new problems follow from putting it in-tree → **N3, N11, N16**. |
| 27 | `listBackups` accepts any dir / raw parse errors (L) | **OK** | `listBackups` validates each manifest (`apply.ts:488-504`); a `NOT JSON` stamp and a stamp with no manifest are both filtered out. |
| 28 | rollback recorded as `kind:'apply'`, no-op files in `changedFiles`, `oldish` openers (L) | **OK** | HTTP job shows `kind:"rollback"`; the `pending` filter (`apply.ts:296-298`) drops byte-identical files (`changedFiles: []` for two cancelling edits); ` ```oldish `/` ```newer ` are no longer `old`/`new` blocks. |

Totals: **OK 19 · INCOMPLETE 7 (#2, #3, #5, #9, #14→partial, #19, plus #10/#16 partial) · REGRESSION 0.**
Counting strictly: 19 OK, 5 INCOMPLETE (#2, #3, #5, #9, #19), 3 PARTIAL (#10, #14, #16), 1 OK-with-regressions (#26).

---

## B. New findings in the rewritten code

### N1. HIGH — An inner fence with an **empty info string** closes the block early: `old`/`new` are silently truncated and the wrong fences become `old`/`new`
`parse.ts:122` (captureFences close test), `parse.ts:85` (the same test in `splitSections`),
`parse.ts:127-131` (`suspicious`, evaluated *after* the close).

**Defect.** The close test accepts any backtick run ≥ the opener whose info string is empty, and it
`break`s before the `suspicious` heuristic can run. So `suspicious` only fires for inner fences that
carry an info string (` ```bash `) or for a block that never closes. A bare ` ``` ` line inside the
content — indented or not — closes the block instead of being flagged. Because each early close
flips fence parity, an **even** number of them leaves the `old`/`new` counts at 1/1, so
`parsePlan` returns `problems: []` and the truncated text is written. The file header's promise
("a block whose content contains a backtick run at least as long as its opener is REFUSED rather
than truncated") is false for exactly the shape markdown produces most often.

**Scenario A (reproduced, `h8`).** Editing `docs/g.md` whose content is
`intro\n  ```\n  npm test\n  ```\noutro\n`, with `old` = that whole passage and `new` = `REPLACED`:
`oldText` parsed as just `"intro"`, one `applied` outcome, `problems: []`, and the file became
`"REPLACED\n  ```\n  npm test\n  ```\noutro\n"` — the splice landed at the top and orphaned the code
block. This is R1 #2 Scenario B verbatim.

**Scenario B (reproduced, `h8`).** With a quoted `### EDIT 2` example following the early close, the
block boundaries shift so that a *different* pair of fences becomes `old`/`new`:
`docs/fmt.md` was written as `"SECRET = 666\n  ```\n  code\n  ```\n"` — the replacement text came
from the quoted example's `new` block. `ok:true`, `problems: []`, one green `applied` row.

**Minimal fix.** Evaluate suspicion **before** closing: in `captureFences`, if a candidate closing
line's run length is `> runLength`, or if the block has already seen content and the closer is
indented differently from the opener, treat it as ambiguous and push the problem instead of closing.
Simplest robust form — reject the block whenever any *content* line matches
`` /^[ \t]*`{3,}[ \t]*$/ `` other than the final closer, i.e. do the parity check explicitly:
count candidate closers in the section and refuse when more than one exists at the opener's length.

### N2. HIGH — `~~~` fenced regions are invisible to `splitSections`, so a quoted example edit inside one is applied to real source
`parse.ts:48` (`FENCE_OPEN_RE` matches backticks only), `parse.ts:66-88`.

**Defect.** `splitSections` masks `### EDIT n` inside backtick fences but has no notion of the other
CommonMark fence character. A plan that quotes an example plan inside a `~~~` block — the natural
choice precisely *because* the quoted content is full of backticks — has its `### EDIT n` line read
as a real heading, and the quoted `- file:`/`old`/`new` become a real edit.

**Scenario (reproduced, `h2`/`h8`).** A one-edit plan for `a.py` followed by
`~~~\n### EDIT 2\n- file: \`src/real.py\`\n…\n~~~` parsed to **two** edits with `problems: []` and
applied both: `changedFiles: ["a.py","src/real.py"]`, and `src/real.py` now contains
`SECRET = 666` from text the author explicitly labelled "example only, do not apply". Same class as
R1 #3, and the parser's own doc comment (`parse.ts:18-20`) claims it cannot happen.

Related (LOW, same root): a plan that *uses* `~~~old`/`~~~new` fences fails with
`needs exactly one \`\`\`old and one \`\`\`new block (found 0 old, 0 new)`, which never mentions that
tilde fences are unsupported.

**Minimal fix.** Generalise the fence regex to `^([ \t]*)((?:`{3,}|~{3,}))([^\n]*)$` and track the
opening character alongside the run length (a `~~~` fence closes only on `~`, per CommonMark), or —
if tilde support is unwanted — mask `~{3,}` regions in `splitSections` and reject a plan that opens
an `old`/`new` block with tildes, with a message that says so.

### N3. MED — The new in-repo default `backupRoot` makes the analyzer ingest backup copies as source files
`apply.ts:304`, `packages/analyzer/src/adapter.ts:12-34` (`COMMON_SKIP_DIRS`).

**Defect.** Fixing R1 #26 moved the default backup root from the repo's parent to
`<sourceRoot>/.handbook-patches`. `.handbook-patches` is not in `COMMON_SKIP_DIRS`, so every
subsequent `analyze`/`generate`/`resync` on that tree discovers `<stamp>/files/**` as real source.

**Scenario (reproduced, `h7`).** Two CLI-default applies to `app/engine.py`, then
`listFilesRecursive(root, { skipDirs: COMMON_SKIP_DIRS, extensions: ['.py'] })` returned
`['.handbook-patches/<stamp1>/files/app/engine.py', '.handbook-patches/<stamp2>/files/app/engine.py',
'app/engine.py']` — one stale duplicate of every patched file per apply, which the graph, the
inventory and the assignment buckets will treat as three distinct modules. The studio is safe
(`server.ts:294-295` uses `workDir/patches`); the CLI default is not, and it also dirties
`git status` without adding a `.gitignore`.

**Minimal fix.** Add `.handbook-patches` to `COMMON_SKIP_DIRS`, and write a
`.handbook-patches/.gitignore` containing `*` on first use.

### N4. MED — The duplicate-`sourceRoot` guard only catches exact string equality, so two repos can still share one tree
`state.ts:66-68`, `jobs.ts:34` (mutex still keyed on the repo name), `server.ts:406`.

**Defect.** `parsed.sourceRoot === other.sourceRoot` is a string compare on a path that is
`resolve()`d but never `realpath`ed, and there is no containment test (the neighbouring `workDir`
check uses `inside()` — `sourceRoot` does not).

**Scenario (reproduced, `h5`, direct `StateStore.add`).** With repo `A` at `<src>`, all three of
these were **accepted**: `<src>/` (trailing slash), `<src>/sub` (a nested child), and
`/private/var/…` vs `/var/…` (the macOS `/var` symlink alias). `resolve()` in `server.ts:406`
normalises only the trailing slash, so the nested and aliased forms are reachable over HTTP — and
then `A`'s apply and `A4`'s resync run concurrently, which is exactly the R1 #19 hazard.

**Minimal fix.** Compare `realpathSync(sourceRoot)` and reject containment in either direction
(reuse `inside()`); additionally key `busyRepos` on the resolved `sourceRoot` as well as the name, so
a stale registry cannot defeat the mutex.

### N5. MED — `rollback` still never checks that the manifest's `sourceRoot` is the tree being rolled back
`apply.ts:416-420` (validates only "absolute"), `apply.ts:454`, `server.ts:327`, `main.ts:285`.

**Defect.** Traversal is now blocked, but containment is checked against the manifest's *own*
`sourceRoot`, which the manifest supplies. R1's prescribed fix ("have callers pass the expected
`sourceRoot` so rollback can refuse a manifest that does not match") was not implemented — neither
`runRollback` nor the CLI passes an expected root.

**Scenario (reproduced, `h4`).** A well-formed backup dir whose manifest names an unrelated absolute
`sourceRoot` → `rollback` returned `{restored:["keep.txt"]}` and overwrote that foreign tree's file.
The non-adversarial half is the likelier one: move or rename a repo, update `sourceRoot` in
`studio.json`, then roll back an older stamp — it restores into the **old** path with no mismatch
error, and the studio reports success.

**Minimal fix.** Add `expectedSourceRoot` to `RollbackOptions`; throw when
`realpathSync(manifest.sourceRoot) !== realpathSync(expected)`. Pass `repo.sourceRoot` from
`server.ts:327` and add `--source` to the CLI `rollback` command.

### N6. MED — Two create edits for one path: the second silently overwrites the first, both report `created`
`apply.ts:223-239` (no check against `resolvedByPath` for a repeated create).

**Defect.** The create branch consults `originalContent` (on-disk state) but never asks whether this
plan already resolved a create for the same path. R1 #9's minimal fix named this case explicitly.

**Scenario (reproduced, `h3`).** Plan: `EDIT 1` creates `new.py` with `FIRST`, `EDIT 2` creates
`new.py` with `SECOND`. Result: `ok:true`, outcomes `["created","created"]` with no `detail`,
`changedFiles: ["new.py"]`, and the file contains `SECOND`. `EDIT 1`'s payload is gone and the report
shows two green rows.

**Minimal fix.** In the create branch, `if (resolvedByPath.has(absolutePath))` push a problem
(`EDIT n (file): a second create for a path this plan already creates`).

### N7. MED — `rollback` is not atomic and loses its progress report when an entry fails mid-loop
`apply.ts:453-480` (the loop has no try/catch), `apply.ts:462-470`.

**Defect.** Each entry is restored in place; the first `copyFileSync`/`mkdirSync`/`renameSync` error
escapes `rollback`, so the caller learns neither which files were already restored nor which were
not, and the tree is left half-rolled-back. The `existsSync(backupPath)` guard at `apply.ts:463`
checks presence, not that the backup copy is a regular file.

**Scenario (both reproduced, `h4`).**
- Backup copy replaced by a *directory* (corrupt/tampered backup): `copyFileSync` threw
  `ENOTSUP … copyfile`, and afterwards `a.py` was restored while `b.py` and `c.py` were still
  patched (`B9`, `C9`) — a tree matching no state that ever existed, and `restored: ["a.py"]` was
  thrown away with the exception.
- A directory in the source tree replaced by a regular file since the patch: `mkdirSync` threw
  `EEXIST`, again after `a.py` had already been restored.

A failure between `copyFileSync` and `renameSync` also strands a
`<target>.handbook-rollback-<pid>` file in the source tree.

**Minimal fix.** Wrap the per-entry work in `try/catch`, push
`skipped.push({ file, reason: String(error) })` and continue, so `RollbackResult` always comes back
whole; and require `statSync(backupPath).isFile()` before copying.

### N8. MED — `suspicious` false positive: a legitimate plan editing code that *contains* ` ``` ` is refused
`parse.ts:128-131`.

**Defect.** The heuristic flags any content line whose longest backtick run is ≥ the opener's,
regardless of position. But the parser's own close rule requires a line that is *only* backticks
(plus indent) — so ` const FENCE = "```"; ` can never close a fence and is not ambiguous. Rating the
two directions: the false **negative** (N1) writes wrong bytes, so it is far worse; this false
**positive** is a hard refusal with a workaround, but it hits an entirely ordinary case (any file
that manipulates markdown fences, and every plan an LLM writes with 3-tick fences against such a
file), and the message blames the plan author for a non-problem.

**Scenario (reproduced, `h8`).** `md.js` = `const FENCE = "```";\nexport default FENCE;\n`, plan
edits that line with 3-tick fences → `ok:false`, zero outcomes,
`a fenced block contains a backtick run as long as its opener…`. The same plan with 4-tick openers
applies cleanly, so the content was never ambiguous.

**Minimal fix.** Only flag lines that could actually be a closer:
`/^[ \t]*`{3,}[ \t]*$/` with run ≥ opener (which, combined with N1's fix, is the parity check) —
drop the "longest run anywhere on the line" test.

### N9. MED — A create whose parent path is a regular file verifies as `created`, then throws a raw errno from the write phase
`apply.ts:196` (leaf-only `existsSync`/`lstatSync`), `apply.ts:335` (`mkdirSync` in the staging loop).

**Defect.** Verification stats only the leaf. `existsSync('<file>/child.py')` is `false`, so the edit
is accepted as a create; the write phase's `mkdirSync(dirname(...), {recursive:true})` then throws
`EEXIST` because a path component is a file. R1 #14 was fixed for the "target is a directory" leaf
case but not for non-directory ancestors.

**Scenario (reproduced, `h9`).** `a.py` is a regular file; `- file: \`a.py/child.py\`` →
**dry-run** returns `ok:true, outcomes:["created"]`; the real apply throws
`EEXIST: file already exists, mkdir '…/a.py'` out of `applyPlan`, so the caller gets no
`ApplyResult` at all (studio job fails with the raw errno, CLI exits 1 with no JSON). Nothing is
corrupted — the staging loop aborts before any rename — but a green dry-run followed by a raw crash
breaks the documented contract.

**Minimal fix.** In the verify loop, walk `relPath`'s ancestors under the root and emit
`not-a-file` ("a parent path component is not a directory") when any existing component fails
`isDirectory()`.

### N10. MED — No cross-process lock: two concurrent `applyPlan` runs on one tree silently lose an edit, and both report success
`apply.ts:168-372` (read-verify-write with no lock file), `jobs.ts:30-36` (the mutex is
studio-internal only), `main.ts:265-276` (CLI takes no lock).

**Defect.** `applyPlan` reads the file during verification and writes it later; there is no lock,
lease, or re-read at rename time. Two processes that both verify against the same original both
succeed, and the later rename wins wholesale.

**Scenario (reproduced, `h5`).** Two `node` processes, one applying `A→A_ONE` and one `B→B_TWO` to
`a.py` (`"A\nB\n"`), launched without waiting, over 8 rounds: **8/8 rounds lost an edit** (e.g. the
file ended as `"A_ONE\nB\n"`), while *both* processes printed `ok:true, changedFiles:["a.py"]`. Each
backup records `sha256Before` = the same original, so rolling back the loser's stamp is refused as
"changed after the patch" and the loser's work is simply gone. The studio serialises same-name jobs,
so this is a CLI / two-terminal / CI hazard (and, with **N4**, a studio one too).

**Minimal fix.** Take an exclusive lock for the whole verify+write window —
`mkdirSync(join(backupRoot,'.lock'))` (atomic, `EEXIST` = busy) or `writeFileSync(lock, …, {flag:'wx'})`
with a stale-lock timeout — and release it in a `finally`.

### N11. LOW — A plan can edit its own backup tree, corrupting the rollback record
`apply.ts:304` (backups inside `sourceRoot`), `apply.ts:185-189` (`safeResolve` treats
`.handbook-patches` as ordinary in-root content).

**Scenario (reproduced, `h9`).** After one CLI-default apply, a plan targeting
`.handbook-patches/<stamp>/files/a.py` applied cleanly (`ok:true`, `applied`), leaving the backup
copy as `TAMPERED`. A later rollback of that stamp restores the tampered bytes and reports success.
Chained with **N3** this is reachable non-adversarially: the analyzer indexes the backup copies as
source, so the planner can be asked to edit one.

**Minimal fix.** Refuse any edit whose resolved path is inside the effective `backupRoot`
(`unsafe-path`), and hash-check the backup copy against `sha256Before` before restoring.

### N12. LOW — A failed write leaves an orphan backup stamp whose rollback reports a false "changed after the patch"
`apply.ts:305` (stamp created before the write), `apply.ts:353-365` (restore path does not remove the
stamp), `apply.ts:457`.

**Scenario (reproduced, `h1`, `h9`).** After the `EPERM`-on-second-rename run, `listBackups` showed a
stamp for a patch that was fully rolled back. Rolling it back returned
`skipped: [{a: "changed after the patch — pass force to overwrite"}, {b: …}]` — nothing had changed;
the files are at `sha256Before`, and the guard only compares against `sha256After`. A user chasing a
failed apply is told their files were edited when they were not.

**Minimal fix.** On the restore path, `rmSync(backupDir, {recursive:true, force:true})` after
restoring (nothing in it is needed any more); and in `rollback`, treat
`currentHash === entry.sha256Before` as "already at the pre-patch bytes → nothing to do" rather than
"changed after the patch".

### N13. LOW — Indent handling is asymmetric: fences may be indented, metadata may not; partial indents are not stripped
`parse.ts:137` (`l.startsWith(indent)` all-or-nothing), `parse.ts:49-50` (`FILE_RE`/`WHERE_RE`
anchored at column 0).

**Scenarios (reproduced, `h2`).** With a 2-space-indented opener, a content line indented **1**
space is left as `" x = 2"` (CommonMark strips what is there); with a tab-indented opener and
space-indented content nothing is stripped. And a nested-bullet plan
(`  - file: \`a.py\``, the exact markdown reflow R1 #21 was about) fails with
`missing "- file: \`path\`" line` even though its indented fences now parse fine.

**Minimal fix.** Strip `min(indent.length, leading whitespace)` per line, and allow up to 3 leading
spaces in `FILE_RE`/`WHERE_RE`.

### N14. LOW — `HEAD_RE` is exact-match, so a decorated or mis-levelled heading reports "no EDIT blocks found"
`parse.ts:47`.

**Scenarios (reproduced, `h2`, `h10`).** `### EDIT 1 — fix the engine` and a lone `#### EDIT 2` both
produce `no "### EDIT <n>" blocks found in the plan`. When such a head follows a valid one its body
is absorbed into the previous section, which is at least loud (`found 2 old, 2 new`) but names the
wrong cause. R1 #10's "scan for `/^#{1,6}\s*EDIT\s+\d+/im` lines the head regex did not match" is
still unimplemented.

**Minimal fix.** After splitting, scan for lines matching `/^\s*#{1,6}\s*EDIT\b/i` that are not
section heads at fence depth 0 and report each as a malformed heading.

### N15. LOW — The studio UI cannot pass `force`, so a guarded rollback is a dead end
`server.ts:328` (accepts `body.force`), `public/index.html:1794` (`{ backup }` only — no `force`
anywhere in the handler), `index.html:1791-1803` (the result, including `skipped`, is never
rendered).

**Scenario (reproduced against a live studio, `h6`).** Edit a file after applying, click Rollback →
job **succeeded** with `{restored:[],removed:[],skipped:[{file:"a.py",reason:"changed after the
patch — pass force to overwrite"}]}`. The advice is unreachable from the UI, and the panel only shows
success; the reason survives solely as a `⚠` line in the job-log drawer. (The R1 #6 guard is right —
the affordance is missing.)

**Minimal fix.** Render `result.skipped` after a rollback job and offer a "roll back anyway" button
that re-posts `{ backup, force: true }`.

### N16. LOW — CLI `--backup-root` help still documents the pre-fix default
`main.ts:264`: `'where backups go (default <source>/../.handbook-patches)'` — the default is now
`<source>/.handbook-patches` (`apply.ts:304`; the README was corrected in `ee5e221`, the CLI string
was not). Fix: update the string.

### N17. LOW — Read-only (`0444`) files are silently patched
`apply.ts:337-351`: the content goes to a fresh tmp and `renameSync` needs write permission on the
*directory*, not the target, so a file the user marked read-only is replaced and then `chmod`ped back
to `444` — reproduced (`h3`: `ok:true`, `applied`, mode `444`, new content). Arguably intended
(git behaves this way), but worth a `detail` at least. Fix: note it, or refuse when
`!(mode & 0o200)` unless forced.

---

## Attacked and clean (this round)

- **Two-phase write really is all-or-nothing.** Forced `EPERM` on rename #2 and forced `EISDIR` on
  staging write #2: in both cases the tree came back byte-identical, with zero stray `handbook-tmp`
  files and modes preserved.
- **Dry-run is inert.** No backup root, no stamp, no temp files, source untouched.
- **All-cancel plans create nothing** — `createStampDir` is only reached after the `pending` filter,
  so `.bk/` does not even exist afterwards (`h9`).
- **`createStampDir` is bounded** (501 attempts, then rethrows `EEXIST`) — no unbounded loop.
- **Manifest validation held against 7 crafted manifests** (traversal write, traversal delete,
  absolute path, backslashes, relative `sourceRoot`, missing `files`, non-JSON) with the victim tree
  intact every time, and `listBackups` filtered the invalid stamps.
- **Rollback restores file mode** — a file `chmod`ped to `600` after the patch came back `755` via
  the backup copy's own mode.
- **`create`-then-`edit` of one new file in a single plan** books correctly: one manifest entry with
  `existed:false`, no `files/` copy, final content `A\nB2\n`.
- **Symlinks**: create through a symlinked directory, nested create through one, and editing an
  in-root symlink are all `unsafe-path`; a directory target is `not-a-file`.
- **CRLF** in both directions, plus a mixed-EOL file, splice without EOL damage.
- **`### EDIT n` quoted inside a 4-backtick fence** yields exactly one edit and no phantom write —
  the R1 #3 primary scenario is closed (only `~~~`, **N2**, and the parity trick, **N1**, get through).
- **Studio failure path**: a rejected plan logs problems *and* `✗ EDIT …` lines in the exact shape
  `outcomesFromLog` parses, and the thrown message carries `problems.join('; ')`.
- **Studio rollback allow-list** rejected five traversal/absolute payloads; `kind` is now `rollback`.
- **Metadata hijacking** via a `- file:`/`- where:` line inside `old` is closed.
- **Byte-identical rewrites** are excluded from `changedFiles`, and ` ```oldish ` is no longer an
  `old` block.

## Verification gates

```
$ npx tsc -b                # exit 0, no output
$ npx vitest run
  Test Files  23 passed (23)
       Tests  211 passed (211)
```
