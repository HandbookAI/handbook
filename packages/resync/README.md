# @handbook/resync

Rolls a handbook's derived layer forward after a real code change, without re-running the full pipeline. Given a "case" directory (`edited/` source tree, optional `plan.md` with declarations, optional `change.diff`), it re-analyzes the edited tree, diffs the old and new call graphs into changed/added/deleted file sets, and updates only what those sets touch: cards, assignment, organization, narration, and registers — writing a `resync-report.json` alongside the case. It closes the loop that `@handbook/planner` opens: plan → apply → resync.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Load and validate the case contract (`loadCase`): `edited/` required, `plan.md` and `change.diff` optional, empty diff short-circuits to a skip.
- Compute the delta between the stored graph and a fresh phase-1 graph over the edited tree (`diffGraphs`): per-file content hashes, with structural fingerprints as the fallback for hash-less graphs and for files unreadable during either analysis.
- Regenerate cards for changed/added files — at the depth the handbook was built with unless overridden (`detectCardDetail`) — re-assign added files, drop deleted ones, and reconcile buckets.
- Edit organization entries for affected stages mechanically (prune departures, refresh facts, append newcomers) and re-narrate through the content-hash cache.
- Parse plan declarations and unified-diff file lists as scope-widening inputs (`parsePlanDeclarations`, `filesFromDiff`).
- Does NOT re-run skeleton synthesis or the doctor — the stage structure is kept; only the derived layer rolls forward.
- Does NOT render — the CLI's `resync` command refreshes already-rendered outputs afterwards (`--no-render` to skip); other callers re-render themselves.

## Public API

All in `resync.ts`:

- `resyncHandbook(options: ResyncOptions): Promise<ResyncReport>` — the whole flow; updates the work directory in place and writes `<case>/resync-report.json`.
  - `ResyncOptions` — `{ caseDir, workDir, client?, noLlm?, lang?, detail?, editedRoot?, planText?, correctionsPath?, signal?, logger? }`; `client` is required unless `noLlm` is true; `detail` (`'brief' | 'deep'`) defaults to whatever the existing cards were built with; `editedRoot`/`planText` let a caller (e.g. studio's live-tree flow) supply the edited tree and plan directly instead of via case files.
  - `ResyncReport` — `{ skipped, changedFiles, addedFiles, deletedFiles, affectedStages, cardsRegenerated, narrated }`.
- `loadCase(caseDir): ResyncCase | undefined` — read the case directory; `undefined` means an empty diff (nothing to resync).
  - `ResyncCase` — `{ editedRoot, planText?, declarations?, diffText? }`.
- `parsePlanDeclarations(planText)` — last parseable ` ```json ` block with `will_modify`/`will_add`/`will_remove` → `{ willModify, willAdd, willRemove }`.
- `filesFromDiff(diffText): string[]` — file paths from unified-diff `+++/---` headers (`/dev/null` skipped).
- `diffGraphs(before, after): GraphDelta` — per-file content hashes (structural-fingerprint fallback) → `{ changed, added, deleted }`.
- `detectCardDetail(cards): 'brief' | 'deep'` — the depth a handbook was built with (deep cards carry function notes / descriptions).
- `loadCorrections(path)` / `correctionFiles(corrections)` / `archiveCorrections(path, stamp)` (`corrections.ts`) — the agent correction channel: tolerant JSONL load (bad lines land in `problems` with line numbers), the unique source files named, and archiving a consumed file as `corrections.<stamp>.applied.jsonl`.

### Cancellation and corrections

`signal` is cooperative: it is checked between the numbered steps and passed into every LLM
pass, so an aborted resync rejects with an `AbortError` at the next checkpoint rather than
mid-write. The work-dir lock is still released, and already-saved cards stay on disk.

`correctionsPath` points at a `corrections.jsonl` written by handbook-consuming agents (see
`@handbook/skill` for the protocol). Every named file that exists in the analyzed set WIDENS
the refresh set — a claim contradicted by the source is a reason to redescribe that file even
when its bytes never changed — and files outside the set are reported in
`report.corrections.problems` rather than silently dropped. The file is archived only after a
run completes, so an aborted or failed resync leaves the corrections pending for the next one.

## Usage

```ts
import { resyncHandbook } from '@handbook/resync';
import { OpenAiChatClient } from '@handbook/llm';

// case dir layout: <case>/edited/ (changed tree), plan.md?, change.diff?
const report = await resyncHandbook({
  caseDir: '/path/to/case',
  workDir: '/path/to/work', // holds the handbook artifacts to roll forward
  client: new OpenAiChatClient(),
  lang: 'en', // detail is detected from the existing cards unless you pass it
});

console.log(report.changedFiles, report.addedFiles, report.deletedFiles);
console.log(report.affectedStages, report.cardsRegenerated, report.narrated);
```

For a structural-only refresh with no LLM: pass `noLlm: true` and omit `client` — facts are refreshed, old prose is kept and marked stale.

## Design notes

- Content-hash delta: each scanned file's sha256 (stored in `graph.metadata.fileHashes`) drives the changed/added/deleted sets, so in-place body edits that keep line numbers and signatures identical are still caught. Structural fingerprints (`qualname@lines:signature`) remain the fallback — for whole graphs written before hashes existed, and per file for entries unreadable during either analysis.
- Widen-only scoping: the plan declarations and the unified diff can only ADD files to the refresh set, never remove any — the graph delta is the floor, not the ceiling.
- `noLlm` mode keeps old card prose but appends a "(stale: code changed since narration)" marker to the purpose while refreshing the structural function inventory, so consumers can see exactly which prose lags the code.
- Organization entries for affected stages are edited mechanically rather than rebuilt: departed files are pruned from their groups (empty groups drop out), surviving entries get their facts refreshed from the current cards, and newcomers land in one deterministic call-order group labelled "(resynced)" — the LLM's original grouping survives repeated resyncs. Narration then reuses the phase-3 content-hash cache, so untouched stages cost nothing.
- Assignment is reconciled mechanically (deleted files dropped, added files defaulted to `unassigned` then LLM re-assigned), which keeps `buckets` and `coverage` consistent without touching stable files.

## Dependencies

Internal:

- `@handbook/core` — artifact types, file helpers, `isInternalNode`, errors.
- `@handbook/analyzer` — indirectly via phase 1 (fresh graph over the edited tree).
- `@handbook/pipeline` — `WorkDir`, `runPhase1`, `generateCards`, `rebuildAssignment`/`reassignSubset`, `suggestOrder`/`fileCallAdjacency`, `narrate`, `extractRegisters`, `buildInventory`.
- `@handbook/llm` — the `ChatClient` type for the optional LLM passes.

External: none.
