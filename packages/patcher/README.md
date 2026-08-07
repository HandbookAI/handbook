# @handbook/patcher

Applies the EDIT blocks of a plan (as produced by `@handbook/planner`) to a source tree —
byte-exactly, all-or-nothing, with backups and an exact-bytes rollback. This is the step
that turns a handbook-guided plan into real code changes without ever guessing.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Parse a plan's `### EDIT n` blocks into a typed edit list, reporting problems instead of
  improvising when the format does not hold (`parsePlan`).
- Verify every edit against current file contents _before writing anything_, and refuse
  the whole plan if any edit fails (`applyPlan`).
- Back up each touched file plus a manifest, so a change can be undone to the exact prior
  bytes (`rollback`, `listBackups`).
- Does NOT reformat, re-indent, or "fix up" an edit — the plan's `new` text lands verbatim.
- Does NOT search for a fuzzy match: an anchor that no longer exists, or exists twice, is
  a refusal, not a guess.

## Safety contract

| Situation                                                                                                          | Outcome                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `old` matches exactly once                                                                                         | applied at that offset (line reported)                                                                                                                                                                                                                                                     |
| `old` not found                                                                                                    | `no-match` — the code changed since the plan was made                                                                                                                                                                                                                                      |
| `old` found 2+ times                                                                                               | `ambiguous` — the anchor needs more context                                                                                                                                                                                                                                                |
| `old` empty, file absent                                                                                           | `created`                                                                                                                                                                                                                                                                                  |
| `old` empty, file has content                                                                                      | `no-match` (never silently overwrites; judged against the file's on-disk state, so an earlier edit in the same plan cannot unlock it)                                                                                                                                                      |
| path escapes the source root — directly, or through a symlinked parent on creation                                 | `unsafe-path`                                                                                                                                                                                                                                                                              |
| target is a symlink, a directory, or not valid UTF-8                                                               | `unsafe-path` / `not-a-file` / `undecodable`                                                                                                                                                                                                                                               |
| any edit fails verification                                                                                        | **nothing is written**; the successful ones report `skipped`                                                                                                                                                                                                                               |
| an `fs` error during the write                                                                                     | already-renamed files are restored from the backup taken moments before, then the error is rethrown                                                                                                                                                                                        |
| target file exceeds 8 MiB, or its bytes do not round-trip UTF-8                                                    | `undecodable` — never patched                                                                                                                                                                                                                                                              |
| target's parent directory is not writable                                                                          | `permission` — caught in the verify pass, before anything lands                                                                                                                                                                                                                            |
| the plan's fencing is malformed (untagged block, unclosed fence, `new` before `old`, duplicate/descending numbers) | the parse is refused with a per-EDIT problem; no edit from that plan runs                                                                                                                                                                                                                  |
| another `apply` holds this tree's lock                                                                             | the run **throws** (`another patch run is writing to this tree (pid … on … , started …)`); a lock whose recorded owner is a dead local pid is reclaimed, a foreign-host or unreadable owner counts as alive — delete `.handbook-patches/apply.lock` manually if its owner is provably gone |

Multiple edits to one file compose in plan order against the accumulating content, so a
plan may touch the same file several times as long as each anchor is unique when reached.

**Throws vs returns:** `applyPlan` returns an `ApplyResult` for anything expressible as a
per-edit outcome. It **throws** for environment-level failures: the tree lock is held, the
lock/backup dir cannot be prepared, or an `fs` error interrupts the write phase after its
restore pass. Callers automating apply should catch and surface those, not parse them.

## Public API

| Export                            | Purpose                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `parsePlan(plan): ParsedPlan`     | `{ edits: EditBlock[], problems: string[] }`                                                                                             |
| `applyPlan(options): ApplyResult` | verify + (unless `dryRun`) write; returns per-edit `outcomes`, `changedFiles`, `backupDir`                                               |
| `rollback(backupDir, options?)`   | restore backed-up files, delete files the patch created; files changed _after_ the patch are reported in `skipped` unless `{force:true}` |
| `listBackups(backupRoot)`         | backup stamps, newest first                                                                                                              |

`ApplyOptions`: `{ sourceRoot, plan, dryRun?, backupRoot?, logger? }` — backups default to
`<sourceRoot>/.handbook-patches/<timestamp>/` (inside the repo, so sibling checkouts never
share a backup root; add it to .gitignore).

## Usage

```ts
import { applyPlan, rollback } from '@handbook/patcher';
import { readFileSync } from 'node:fs';

const plan = readFileSync('plan.md', 'utf8');

// 1. Verify first — this never touches the tree.
const check = applyPlan({ sourceRoot: '/repo', plan, dryRun: true });
if (!check.ok) {
  for (const o of check.outcomes) console.log(o.status, o.file, o.detail ?? '');
  process.exit(2);
}

// 2. Apply for real, then undo if the tests disagree.
const applied = applyPlan({ sourceRoot: '/repo', plan });
if (testsFail()) {
  const undone = rollback(applied.backupDir!);
  // `skipped` lists files someone edited after the patch — nothing was clobbered.
  console.log(undone.restored, undone.removed, undone.skipped);
}
```

From the CLI:

```bash
handbook apply --source /repo --plan plan.md --dry-run   # verify
handbook apply --source /repo --plan plan.md             # write + back up
handbook rollback --backup /repo/.handbook-patches/2026-08-03T…   # add --force to override post-patch edits
```

## Design notes

- **Verify-then-write, in two phases.** The resolve pass builds the complete next content
  of every file in memory; the write stages each file as a temp sibling and only renames
  once all staging succeeded — and a failure mid-rename restores what already landed.
- **Backups are the undo layer**, not version control: they capture the pre-patch bytes
  plus `sha256Before`/`sha256After`. Rollback verifies the current bytes still match what
  the patch wrote, so it refuses (rather than destroys) work done since — `force` overrides.
- **Line endings and file mode survive.** An LF plan applies to a CRLF file using the
  file's own dominant ending, and the executable bit is restored after each write.
- **Uniqueness is the correctness anchor.** The planner is instructed to include ≥3 lines
  of context precisely so this check can be strict; a strict check here is what makes a
  blind executor safe.
- **Fenced-block parsing is hostile to ambiguity.** `### EDIT n` counts only outside fenced
  regions, so a plan that quotes an example edit cannot spawn a phantom one; a block whose
  content holds a backtick run as long as its opener is **refused** (write it with a longer
  ```` opener instead of hoping); and `- file:`/`- where:` are only read before the first
  fence, so fenced content cannot hijack the target.

## Dependencies

Internal: `@handbook/core` (atomic writes, hashing, logger). No external dependencies.
