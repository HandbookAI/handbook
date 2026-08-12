# @handbooks/patcher

**English** · [中文](README.zh-CN.md)

> Apply a plan's EDIT blocks to a real source tree, byte-exactly. All-or-nothing, with
> backups it can prove are the right ones. No LLM, no guessing, no partial writes.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fpatcher-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbooks/patcher)
[![no LLM](https://img.shields.io/badge/LLM-never-2dd4bf?style=flat-square)](#)

---

## What it is

A mechanical executor. It takes the markdown plan that `@handbooks/planner` produces and
substitutes each exact `old` text with the exact `new` text — no re-reading, no
interpretation, no model in the loop.

That is the point. **A plan is a proposal a human can review; applying it must be boring
and predictable.** Everything interesting in this package is about refusing to do the
wrong thing.

---

## Install

```bash
pnpm add @handbooks/patcher
```

---

## Quick start

```ts
import { applyPlan, rollback, listBackups, parsePlan } from '@handbooks/patcher';
import { readFileSync } from 'node:fs';

// 1. Verify without writing anything
const dry = applyPlan({
  sourceRoot: '/path/to/repo',
  plan: readFileSync('plan.md', 'utf8'),
  dryRun: true,
});

if (dry.ok) {
  // 2. Apply for real
  const result = applyPlan({ sourceRoot: '/path/to/repo', plan: readFileSync('plan.md', 'utf8') });
  console.log(result.changedFiles, result.backupDir);

  // 3. Changed your mind
  rollback(result.backupDir!, { expectedSourceRoot: '/path/to/repo' });
}
```

From the CLI:

```bash
handbook apply --source /path/to/repo --plan plan.md --dry-run
handbook apply --source /path/to/repo --plan plan.md
handbook rollback --backup /path/to/repo/.handbook-patches/<stamp>
```

Both commands exit non-zero on failure.

---

## The safety rules, in priority order

### 1. Verify everything, then write in two phases

The plan is first resolved against current file contents — **one failure aborts the whole
application**, before a single byte is written. The write then stages every file as a
temp file and only renames once _all_ staging succeeded. If a rename fails midway, the
already-renamed files are restored from the backup taken moments before.

There is no state in which half a plan has landed.

### 2. `old` must match byte-exactly and uniquely

| Matches found | Result                                                    |
| ------------- | --------------------------------------------------------- |
| 0             | `no-match` — the code moved on since the plan was written |
| 1             | applied                                                   |
| 2+            | `ambiguous` — the anchor does not identify a single site  |

Both failures refuse. **Neither picks one.** "The first occurrence" is how a patch lands
in the wrong function.

### 3. Every touched file is backed up with its pre-patch hash

```
<source>/.handbook-patches/
  .gitignore                 written automatically — backups never enter git
  2026-08-08T14-05-11-204Z/
    manifest.json            source root, timestamp, per-file pre/post hashes
    files/…                  the original bytes
```

The hash is what lets `rollback` **prove** it is restoring the bytes this patch replaced,
rather than trusting a filename.

### 4. No path escapes the source root

Resolution refuses `..`, absolute paths, drive-absolute Windows paths — and escapes
through a **symlinked parent directory** when the file itself does not exist yet. That
last one is the subtle case: realpath is taken on the deepest _existing_ ancestor, so a
missing leaf cannot skip the check. Symlinked targets are never replaced.

---

## What the parser refuses, and why

The plan format is simple; parsing it is deliberately hostile to ambiguity, because the
result is executed against real source.

**Fence tracking follows CommonMark** for both backtick and tilde fences: a block opened
with a run of N markers closes only on a line whose run is ≥ N _and_ carries no info
string. So `### EDIT n` inside a fenced region is **content, never a heading** — a plan
that quotes an example edit (say, one that edits documentation) cannot smuggle a phantom
edit into the run.

| Refused                                                                                   | Message tells you                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Content between an edit's fenced blocks                                                   | An inner fence probably closed `old`/`new` early — open them with a longer fence              |
| An untagged ``` block                                                                     | Same cause; refused wherever it sits, so a truncated anchor cannot slip through as "epilogue" |
| Not exactly one `old` and one `new`                                                       | How many of each it actually found                                                            |
| `new` before `old`                                                                        | Write the anchor first, then the replacement                                                  |
| `old` identical to `new`                                                                  | Nothing to do                                                                                 |
| Missing or duplicated `- file:` line                                                      | Exactly one is required                                                                       |
| Edit numbers out of order or duplicated                                                   | They must ascend, top to bottom                                                               |
| A path with whitespace, backticks, control characters, backslashes, `~`, or a leading `/` | Which rule it broke                                                                           |
| A near-miss heading (`## EDIT 1`, `#### edit 2`)                                          | It looks like a heading but is not `### EDIT <n>` — reported, not silently ignored            |

Trailing prose and the declarations JSON block **after** the last `old`/`new` pair are
expected output and are ignored, not refused.

---

## Outcomes

Every edit gets a status, so a partial refusal tells you exactly which one and why:

| Status         | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| `applied`      | Replaced, with the 1-based line where `old` was found |
| `created`      | `old` was empty; the file was created                 |
| `no-match`     | `old` is not in the file                              |
| `ambiguous`    | `old` appears more than once                          |
| `file-missing` | Non-empty `old`, but no such file                     |
| `not-a-file`   | The path is a directory or a symlink                  |
| `unsafe-path`  | The path escapes the source root                      |
| `undecodable`  | The file is not valid UTF-8                           |
| `skipped`      | An earlier failure aborted the run                    |

```ts
interface ApplyResult {
  ok: boolean; // true only when every edit landed (or would, in dry-run)
  dryRun: boolean;
  outcomes: EditOutcome[];
  changedFiles: string[]; // empty in dry-run
  backupDir?: string; // undefined in dry-run
  problems: string[];
}
```

---

## Rollback

```ts
rollback(backupDir, {
  force: false, // restore even files changed after the patch
  expectedSourceRoot: '/path/to/repo', // refuse a backup belonging to another tree
});

listBackups('/path/to/repo/.handbook-patches'); // newest first, valid manifests only
```

By default rollback **refuses any file whose current hash does not match the post-patch
hash** in the manifest — meaning someone has edited it since. Restoring it would silently
destroy that work. `--force` overrides, deliberately explicitly.

`expectedSourceRoot` guards the other direction: pointing rollback at a backup taken from
a different tree is a mistake, not a feature.

---

## Other details worth knowing

- **File modes are preserved.** An executable script stays executable.
- **Line endings and the final newline are preserved.** The patcher does not normalize
  anything it was not asked to change.
- **A directory lock** (`.handbook-patches/`) prevents two concurrent applies on the same
  tree.
- **Empty directories left behind by a rollback are cleaned up**, but only the ones the
  rollback itself emptied.

---

## API

```ts
applyPlan(options: ApplyOptions): ApplyResult
rollback(backupDir: string, options?: RollbackOptions): RollbackResult
listBackups(backupRoot: string): string[]
parsePlan(plan: string): ParsedPlan       // exported: lint a plan without applying it
```

---

## Testing

```bash
pnpm --filter @handbooks/patcher test
```

Over a thousand lines of tests, most of them about refusal: ambiguous anchors, symlink
escapes, nested fences, non-UTF-8 files, mid-rename failure and restore, rollback of a
file edited afterwards, and every parser rejection above.

---

Part of [Handbook](../../README.md) ·
plans come from [`@handbooks/planner`](../planner/README.md) · MIT
