# @handbook/resync

Rolls a handbook's derived layer forward after a real code change, without re-running the full pipeline. Given a "case" directory (`edited/` source tree, optional `plan.md` with declarations, optional `change.diff`), it re-analyzes the edited tree, diffs the old and new call graphs into changed/added/deleted file sets, and updates only what those sets touch: cards, assignment, organization, narration, and registers — writing a `resync-report.json` alongside the case. It closes the loop that `@handbook/planner` opens: plan → apply → resync.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Load and validate the case contract (`loadCase`): `edited/` required, `plan.md` and `change.diff` optional, empty diff short-circuits to a skip.
- Compute the structural delta between the stored graph and a fresh phase-1 graph over the edited tree (`diffGraphs`).
- Regenerate cards for changed/added files, re-assign added files, drop deleted ones, and reconcile buckets.
- Rebuild organization entries for affected stages deterministically and re-narrate through the content-hash cache.
- Parse plan declarations and unified-diff file lists as scope-widening inputs (`parsePlanDeclarations`, `filesFromDiff`).
- Does NOT re-run skeleton synthesis or the doctor — the stage structure is kept; only the derived layer rolls forward.
- Does NOT render — re-rendering the updated work directory is the caller's (CLI's) job.

## Public API

All in `resync.ts`:
- `resyncHandbook(options: ResyncOptions): Promise<ResyncReport>` — the whole flow; updates the work directory in place and writes `<case>/resync-report.json`.
  - `ResyncOptions` — `{ caseDir, workDir, client?, noLlm?, lang?, detail? ('brief' | 'deep'), logger? }`; `client` is required unless `noLlm` is true.
  - `ResyncReport` — `{ skipped, changedFiles, addedFiles, deletedFiles, affectedStages, cardsRegenerated, narrated }`.
- `loadCase(caseDir): ResyncCase | undefined` — read the case directory; `undefined` means an empty diff (nothing to resync).
  - `ResyncCase` — `{ editedRoot, planText?, declarations?, diffText? }`.
- `parsePlanDeclarations(planText)` — last parseable ` ```json ` block with `will_modify`/`will_add`/`will_remove` → `{ willModify, willAdd, willRemove }`.
- `filesFromDiff(diffText): string[]` — file paths from unified-diff `+++/---` headers (`/dev/null` skipped).
- `diffGraphs(before, after): GraphDelta` — per-file structural fingerprints → `{ changed, added, deleted }`.

## Usage

```ts
import { resyncHandbook } from '@handbook/resync';
import { OpenAiChatClient } from '@handbook/llm';

// case dir layout: <case>/edited/ (changed tree), plan.md?, change.diff?
const report = await resyncHandbook({
  caseDir: '/path/to/case',
  workDir: '/path/to/work',   // holds the handbook artifacts to roll forward
  client: new OpenAiChatClient(),
  detail: 'deep',
  lang: 'en',
});

console.log(report.changedFiles, report.addedFiles, report.deletedFiles);
console.log(report.affectedStages, report.cardsRegenerated, report.narrated);
```

For a structural-only refresh with no LLM: pass `noLlm: true` and omit `client` — facts are refreshed, old prose is kept and marked stale.

## Design notes

- Graph-fingerprint delta: each file is fingerprinted as its sorted set of `qualname@lines:signature` strings from the fresh phase-1 graph, so the changed/added/deleted sets come from real structure, not from timestamps or text diffs.
- Widen-only scoping: the plan declarations and the unified diff can only ADD files to the refresh set (e.g. a file whose functions kept identical fingerprints but whose body text changed), never remove any — the structural delta is the floor, not the ceiling.
- `noLlm` mode keeps old card prose but appends a "(stale: code changed since narration)" marker to the purpose while refreshing the structural function inventory, so consumers can see exactly which prose lags the code.
- Organization entries for affected stages are rebuilt deterministically in call-graph order (labelled "(resynced)") rather than via a new LLM grouping pass; narration then reuses the phase-3 content-hash cache, so untouched stages cost nothing.
- Assignment is reconciled mechanically (deleted files dropped, added files defaulted to `unassigned` then LLM re-assigned), which keeps `buckets` and `coverage` consistent without touching stable files.

## Dependencies

Internal:
- `@handbook/core` — artifact types, file helpers, `isInternalNode`, errors.
- `@handbook/analyzer` — indirectly via phase 1 (fresh graph over the edited tree).
- `@handbook/pipeline` — `WorkDir`, `runPhase1`, `generateCards`, `rebuildAssignment`/`reassignSubset`, `suggestOrder`/`fileCallAdjacency`, `narrate`, `extractRegisters`, `buildInventory`.
- `@handbook/llm` — the `ChatClient` type for the optional LLM passes.

External: none.
