# @handbook/patcher

Applies the EDIT blocks of a plan (as produced by `@handbook/planner`) to a source tree —
byte-exactly, all-or-nothing, with backups and an exact-bytes rollback. This is the step
that turns a handbook-guided plan into real code changes without ever guessing.

## Responsibilities

- Parse a plan's `### EDIT n` blocks into a typed edit list, reporting problems instead of
  improvising when the format does not hold (`parsePlan`).
- Verify every edit against current file contents *before writing anything*, and refuse
  the whole plan if any edit fails (`applyPlan`).
- Back up each touched file plus a manifest, so a change can be undone to the exact prior
  bytes (`rollback`, `listBackups`).
- Does NOT reformat, re-indent, or "fix up" an edit — the plan's `new` text lands verbatim.
- Does NOT search for a fuzzy match: an anchor that no longer exists, or exists twice, is
  a refusal, not a guess.

## Safety contract

| Situation | Outcome |
|---|---|
| `old` matches exactly once | applied at that offset (line reported) |
| `old` not found | `no-match` — the code changed since the plan was made |
| `old` found 2+ times | `ambiguous` — the anchor needs more context |
| `old` empty, file absent | `created` |
| `old` empty, file has content | `no-match` (never silently overwrites) |
| path escapes the source root (or symlinks out) | `unsafe-path` |
| any edit fails | **nothing is written**; the successful ones report `skipped` |

Multiple edits to one file compose in plan order against the accumulating content, so a
plan may touch the same file several times as long as each anchor is unique when reached.

## Public API

| Export | Purpose |
|---|---|
| `parsePlan(plan): ParsedPlan` | `{ edits: EditBlock[], problems: string[] }` |
| `applyPlan(options): ApplyResult` | verify + (unless `dryRun`) write; returns per-edit `outcomes`, `changedFiles`, `backupDir` |
| `rollback(backupDir, logger?)` | restore backed-up files, delete files the patch created |
| `listBackups(backupRoot)` | backup stamps, newest first |
| `writeApplyReport(backupDir, result)` | persist a result next to its backup |

`ApplyOptions`: `{ sourceRoot, plan, dryRun?, backupRoot?, logger? }` — backups default to
`<sourceRoot>/../.handbook-patches/<timestamp>/`.

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
if (testsFail()) rollback(applied.backupDir!);
```

From the CLI:

```bash
handbook apply --source /repo --plan plan.md --dry-run   # verify
handbook apply --source /repo --plan plan.md             # write + back up
handbook rollback --backup /repo/../.handbook-patches/2026-08-03T…
```

## Design notes

- **Verify-then-write, not write-then-check.** The resolve pass builds the complete next
  content of every file in memory; the write phase cannot half-apply a plan.
- **Backups are the undo layer**, not version control: they capture the pre-patch bytes
  and a `sha256Before` per file, so a rollback is provable rather than best-effort.
- **Uniqueness is the correctness anchor.** The planner is instructed to include ≥3 lines
  of context precisely so this check can be strict; a strict check here is what makes a
  blind executor safe.
- **Fenced-block parsing shares the repo's fence discipline**: line-anchored openers with
  a backtick-run match, so an `old` block containing fenced content survives intact.

## Dependencies

Internal: `@handbook/core` (atomic writes, hashing, logger). No external dependencies.
