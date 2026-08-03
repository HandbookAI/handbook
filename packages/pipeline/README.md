# @handbook/pipeline

The handbook generation pipeline: from a static call graph to a fully narrated handbook model. It owns the work-directory layout and orchestrates the phases — 1 (graph extraction via `@handbook/analyzer`), 2a (per-file cards), 2b (stage skeleton + file assignment, optionally with the actor–critic "doctor"), 2c (intra-stage organization), and 3 (bottom-up narration + state registers). Its output is a work directory that `loadHandbookModel` turns into the `HandbookModel` consumed by `@handbook/renderer` and `@handbook/skill`.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Own the work-directory layout and typed, schema-validated artifact I/O (`WorkDir`).
- Run phase 1 (deterministic, no LLM) and phases 2a/2b/2c/3 (LLM-driven) with phase selection and prerequisite checks (`generateHandbook`, `expandPhases`).
- Generate per-file cards with complete coverage by construction, including graph-derived function inventories (`generateCards`, `buildInventory`).
- Synthesize, repair, and assign the stage skeleton (`synthesizeSkeleton`, `synthesizeWithDoctor`, `assignFiles`), and organize each stage's files into ordered groups (`organizeStages`).
- Produce narration and cross-stage state registers (`narrate`, `extractRegisters`), plus the member-granularity strategy for smaller codebases (`classifyMembers`, `deriveFileArtifacts`).
- Does NOT render anything — presentation is `@handbook/renderer`'s job; the boundary is `HandbookModel`.
- Does NOT talk to LLM endpoints directly — every call goes through the injected `ChatClient`.

## Public API

Orchestration (`generate.ts`):
- `generateHandbook(options: GenerateOptions): Promise<GenerateStats>` — run selected phases; `GenerateOptions` covers `sourceRoot`, `workDir`, `client?`, `phase?`, `strategy?` (`'file' | 'member'`), `skeletonPath?`, `lang?`, `narrateLang?`, `detail?`, `synthMode?` (`'oneshot' | 'doctor'`), worker/batch knobs, `resume?`, `refresh?`.
- `expandPhases(spec)` / `Phase` — parse `all | 1 | 2 | 2a | 2b | 2c | 3` or comma lists.
- `loadHandbookModel(workDir, title): HandbookModel` — load a completed work directory for the renderer.

Work directory (`workdir.ts`):
- `WorkDir` — path getters (`graphPath`, `cardsDir`, `skeletonPath`, `assignmentPath`, `organizationPath`, `narrationPath`, `registersPath`, `cacheDir`) plus validated `load*`/`save*` for every artifact and `parseSkeletonYaml`.

Phase 1 and facts:
- `runPhase1(options: Phase1Options): Promise<Phase1Stats>` — scan (`lang: 'auto'` merges all registered languages), build and persist the graph.
- `buildInventory(graph): Record<string, FunctionNote[]>` — deterministic per-file function facts (calls/calledBy/extCalls, capped).

Cards (`cards.ts`):
- `generateCards(options: CardsOptions): Promise<CardsResult>` — brief or deep cards; `CardDetail` (`'brief' | 'deep'`), options for batching, workers, truncation, chunking, `resume`, `onlyFiles`.
- `mergeFunctionNotes(graphFns, llmFns)` — LLM prose merged onto the complete structural inventory.
- `isCardDone(card, detail)` — resume filter.

Skeleton, assignment, doctor:
- `synthesizeSkeleton(client, nav, cards, lang?)`, `dirRollups(cards, examplesPerDir?)` / `DirRollup`, `buildSynthPrompt(nav, rollups, lang)`, `normalizeSkeleton(raw, draftedBy?)`, `stageShortDescriptions(skeleton)`.
- `assignFiles(client, graph, skeleton, options?)`, `reassignSubset(client, graph, skeleton, subset, previous, options?)`, `rebuildAssignment(fileStage, skeleton)` / `AssignOptions`.
- `synthesizeWithDoctor(client, graph, cards, options?)` / `SynthLoopOptions` — draft → assign → doctor rounds until convergence.
- `runDoctorRound(client, skeleton, assignment, cards, logger?)` / `DoctorRoundResult`, `computeStageStats` / `StageStats`, `renderStats`, `validateChange`, `applyChange`, `DoctorChange`.

Organization and narration:
- `organizeStages(client, graph, skeleton, assignment, cards, options?)` / `OrganizeOptions`; `fileCallAdjacency(graph)`, `suggestOrder(files, adjacency)` (Kahn's topological order, callers first).
- `narrate(client, inputs, options?)` / `NarrateOptions` — deepest-first stage summaries plus the system overview.
- `extractRegisters(client, skeleton, narration, cards, options?)` / `RegistersOptions` — loop-until-dry register extraction.

Member strategy (`member.ts`):
- `classifyMembers(client, graph, skeleton, options?)` / `ClassifyMembersOptions`, `memberAssignmentSchema` / `MemberAssignment`.
- `deriveFileArtifacts(graph, skeleton, memberAssignment, cards)` — file-level assignment + organization by member majority vote.
- `saveMemberAssignment(work, memberAssignment)`.

## Usage

```ts
import { generateHandbook, loadHandbookModel } from '@handbook/pipeline';
import { OpenAiChatClient } from '@handbook/llm';
import { createLogger } from '@handbook/core';

const stats = await generateHandbook({
  sourceRoot: '/path/to/project',
  workDir: '/path/to/work',
  client: new OpenAiChatClient(),
  phase: 'all',
  detail: 'deep',
  synthMode: 'doctor',
  narrateLang: 'en',
  logger: createLogger(),
});
console.log(stats); // { phasesRun, phase1, nCards, nStages, nUnassignedFiles, nRegisters }

const model = loadHandbookModel('/path/to/work', 'My Project Handbook');
```

## Design notes

- Work-dir idempotence: each phase reads only upstream artifacts and writes its own, all schema-validated on read — any phase can be re-run alone, a crashed run resumes (`resume` skips completed cards), and corruption fails loudly.
- Three-tier card degradation: whole batch → single-file retry → per-function chunks (deep mode); files that still fail get an honest empty card recorded in `_coverage.json`, so coverage is complete by construction.
- The doctor is an actor–critic loop: the actor proposes at most 3 structural changes, an engineer/architect/reader critic panel reviews them against ground-truth stats, validated changes are applied mechanically, affected files are re-assigned, and two consecutive no-progress rounds trip a stuck detector.
- Facts and prose are separated: call relations and line ranges always come from the graph (`buildInventory`); the LLM only adds prose, merged on via qualname, so structural data can never be hallucinated.
- Phase-3 narration is content-hash cached (prompt-derived keys under `phase3/cache/`) and degrades to deterministic fallback prose on failure, so re-narration only pays for stages whose inputs changed and the build never blocks.

## Dependencies

Internal:
- `@handbook/core` — model types/schemas, work-dir I/O primitives, concurrency, progress, hashing.
- `@handbook/analyzer` — phase 1 adapters/graph building and the `NavPack` orientation inputs.
- `@handbook/llm` — the `ChatClient` seam and the actor–critic loop used by the doctor.

External:
- `yaml` — human-editable `skeleton.yaml` / `organization.yaml` serialization.
- `zod` — the package-local `memberAssignmentSchema` (all other schemas come from core).
