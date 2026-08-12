# @handbooks/resync

**English** · [中文](README.zh-CN.md)

> The code moved on. Roll the handbook forward — diff the graph, regenerate only what
> actually changed, and leave everything else alone. No full rebuild.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fresync-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/resync)

---

## What it is

Documentation rots because keeping it current costs as much as writing it. `resync` makes
the update **proportional to the change**: touch three files, pay for three files.

```
   old graph ──┐
               ├──▶ diff ──▶ changed / added / deleted files
   new graph ──┘                    │
                                    ▼
              ┌─────────────────────────────────────────────┐
              │ 1. regenerate cards for changed + added      │
              │ 2. assign added, drop deleted, fix buckets   │
              │ 3. rebuild organization for affected stages  │
              │ 4. re-narrate affected stages + the overview │
              │ 5. refresh registers                         │
              └─────────────────────────────────────────────┘
```

Content-hash caching does the rest: a stage whose inputs did not change is not re-narrated
at all.

---

## Install

```bash
pnpm add @handbooks/resync
```

---

## The case contract

A **case** is a directory you assemble. It answers two questions: _what does the code look
like now_, and _what was the change supposed to be_.

```
<case>/
  edited/        the changed source tree            REQUIRED
  plan.md        what the change was                optional — SHARPENS the scope
  change.diff    unified diff vs the previous tree  optional — WIDENS the scope
```

```bash
mkdir -p cases/upload-retry
cp -R /path/to/repo cases/upload-retry/edited
cp plan.md cases/upload-retry/
handbook resync --case cases/upload-retry --work work/myrepo
```

**Declarations and the diff can only ever _widen_ the refresh set, never narrow it.** The
graph diff is the floor: if a file's bytes changed, it gets refreshed whether or not the
plan mentioned it. A plan that under-declares its own blast radius cannot cause a stale
page.

An **empty** `change.diff` means "nothing to do" and the run is skipped cleanly rather
than treated as "everything changed".

---

## Quick start

```ts
import { resyncHandbook } from '@handbooks/resync';
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const report = await resyncHandbook({
  caseDir: 'cases/upload-retry',
  workDir: 'work/myrepo',
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  correctionsPath: 'skills/myrepo/corrections.jsonl', // optional
});

report.changedFiles; // string[]
report.addedFiles;
report.deletedFiles;
report.affectedStages;
report.cardsRegenerated; // number
report.narrated; // boolean
report.corrections; // { applied, files, problems, archivedTo }
```

---

## How the diff works

`diffGraphs(before, after)` compares two phase-1 graphs and classifies every file:

| Signal                         | Detects                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Content hash**               | An in-place body edit that leaves line numbers and signatures untouched — the case a structural diff misses entirely |
| **Function set**               | Added, removed or renamed functions                                                                                  |
| **Signatures and line ranges** | Reshaped functions                                                                                                   |
| **Call edges**                 | New or removed relationships, including into and out of untouched files                                              |
| **File set**                   | Added and deleted files                                                                                              |

The per-file hashes were stamped by phase 1 for exactly this purpose. If a graph predates
them, the diff falls back to structure — degraded, but never wrong.

---

## Corrections: the feedback loop

Agents consuming a handbook SKILL are instructed to append contradictions to
`corrections.jsonl`:

```json
{
  "file": "src/engine.py",
  "page": "references/stages/stage-2.md",
  "claim": "spin() is defined in src/main.py",
  "actual": "spin() is defined in src/engine.py"
}
```

`--corrections <file>` folds those in: **the named files join the refresh set even when
their bytes never changed**, because a claim contradicted by the source is a reason to
re-describe that file regardless. The consumed file is then archived with a timestamp, so
the same correction cannot be applied twice and the record is not lost.

Malformed lines are reported in `report.corrections.problems`, never fatal — one bad line
written by one agent must not block the refresh.

---

## Working without an LLM

```bash
handbook resync --case cases/x --work work/myrepo --no-llm
```

Structural facts are refreshed — call graph, function inventory, assignment, ordering —
and every affected card's purpose gets ` (stale: code changed since narration)` appended.

**That is the honest degradation.** The alternative — leaving the prose untouched and
unmarked — is a handbook that lies quietly.

---

## Both strategies are supported

For a `member`-strategy work dir, resync reclassifies members for the affected files and
re-derives the file artifacts deterministically, exactly as phase 2b would have. It reads
`phase2/strategy.json` and does the right thing without being told.

---

## Safety and lifecycle

- **The same directory lock as `generateHandbook`**, so a resync can never interleave with
  a concurrent generate on the same artifacts.
- **The phase-1 staging area is always cleaned up** — `<case>/.resync-phase1` never
  outlives the call, on success or failure.
- **Cooperative cancellation.** Pass an `AbortSignal`; it is checked between steps and
  threaded into every LLM pass.
- **Cards for deleted files are removed**, so a deleted file cannot linger in the handbook.
- **`editedRoot`** lets a caller point at a live tree instead of `<case>/edited` — that is
  how Studio runs resync in place, without copying the repo.

---

## API

```ts
resyncHandbook(options: ResyncOptions): Promise<ResyncReport>

loadCase(caseDir): ResyncCase | undefined
diffGraphs(before, after): GraphDelta
filesFromDiff(diffText): string[]
parsePlanDeclarations(planText): { willModify; willAdd; willRemove } | undefined
detectCardDetail(cards): 'brief' | 'deep'      // match the existing handbook's depth

loadCorrections(path): LoadCorrectionsResult
correctionFiles(corrections): string[]
archiveCorrections(path, stamp): string | undefined
```

`detectCardDetail` is why `--detail` is optional: an unset value means _"match what this
handbook already is"_, so a resync never silently downgrades a deep handbook to brief.
The same applies to `--narrate-lang`.

---

## Testing

```bash
pnpm --filter @handbooks/resync test
```

Covered end to end against `MockChatClient`: in-place body edits, renames, added and
deleted files, empty diffs, the `--no-llm` path, corrections widening the set, malformed
correction lines, member-strategy work dirs, and abort mid-run.

---

Part of [Handbook](../../README.md) · MIT
