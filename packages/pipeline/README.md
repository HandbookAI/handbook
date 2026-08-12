# @handbooks/pipeline

**English** · [中文](README.zh-CN.md)

> Five phases turn a directory of source code into a structured handbook. Every phase
> reads only its upstream artifacts and writes its own — so any of them can be re-run
> alone, and a crashed run resumes where it stopped.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fpipeline-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/pipeline)

---

## What it is

`@handbooks/pipeline` is the generation engine of the [Handbooks](../../README.md)
toolchain. It orchestrates:

```
  phase 1   static call graph                     ← @handbooks/analyzer, no LLM
  phase 2a  one card per source file              ← LLM
  phase 2b  stage skeleton + file assignment      ← LLM
  phase 2c  intra-stage grouping and ordering     ← LLM
  phase 3   narration + cross-stage state registers ← LLM
```

and the artifact I/O that makes all of that restartable.

---

## Install

```bash
pnpm add @handbooks/pipeline
```

---

## Quick start

```ts
import { generateHandbook, loadHandbookModel } from '@handbooks/pipeline';
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const stats = await generateHandbook({
  sourceRoot: '/path/to/repo',
  workDir: 'work/myrepo',
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  phase: 'all', // or '1' | '2' | '2a' | '2b' | '2c' | '3' | '2c,3'
  detail: 'deep',
  synthMode: 'doctor',
  narrateLang: 'en',
  resume: true,
});

// later, for the renderer:
const model = loadHandbookModel('work/myrepo', 'MyRepo Handbook');
```

From the command line, the same thing:

```bash
handbook generate --source /path/to/repo --work work/myrepo --detail deep --synth-mode doctor
```

---

## The five phases, in detail

### Phase 1 — the call graph _(no LLM)_

Delegates to `@handbooks/analyzer`, merges every language into one graph, and stamps a
**content hash per scanned file** (resync uses those to detect in-place body edits that
leave line numbers and signatures untouched). Records each language's declared fidelity
so downstream renderers can disclose it.

```ts
const stats = await runPhase1({ sourceRoot, workDir, lang: 'auto', logger });
// { language: 'multi', files, functions, edgesKept, edgesDropped }
```

### Phase 2a — file cards _(LLM)_

One card per source file: **purpose**, **role** (a closed vocabulary), **lifecycle**; and
in `--detail deep` a 120–300-word walkthrough plus per-function purpose / data flow /
relations merged onto the graph facts.

- **Batched**, with `--read-batch-size` files per request and `--read-workers` batches in
  flight. Deep mode defaults to one file per batch.
- **Three-tier degradation.** If the batch reply does not parse, it retries smaller; if
  that fails, it falls back to structure-only cards. **A file never disappears from the
  handbook because its prose failed.**
- **Crash-safe and resumable.** Cards are written as they complete; `--resume` skips files
  that already have a complete one.
- **Diagnosable.** Replies that produced no usable card are kept (capped, hash-named)
  under `phase2/cards/_rejected/`, so a shape mismatch or a refusal can be _read_ after
  the run instead of guessed at.

### Phase 2b — skeleton and assignment _(LLM)_

Builds the narrative spine, then puts every file on exactly one stage.

**`--synth-mode oneshot`** (default): synthesize a skeleton from directory rollups and
entry points, then assign files in batches.

**`--synth-mode doctor`**: an actor–critic repair loop. Each round proposes structural
changes (split / merge / move / retitle / reparent), three critics review them
(engineer / architect / reader), surviving changes are validated against the real graph
and applied, and files are re-assigned. It stops when nothing is unassigned and no change
survives review — or at `--max-doctor-rounds`.

`validateChange` is the guard rail: a change referencing a stage id that does not exist,
or one that would orphan files, is rejected before it can touch the skeleton.

### Phase 2c — intra-stage organization _(LLM)_

Orders each stage's files by call-graph topology and groups them into 2–8 titled
sub-groups with a one-line summary each.

**Every failure degrades to a deterministic flat order — files are never dropped.** That
is the invariant this phase is written around.

### Phase 3 — narration and registers _(LLM)_

Bottom-up: leaf stages first, then parents (which get their children's summaries as
context), then the system overview. After that, **state registers** — pieces of state that
flow across stages — are extracted with a loop-until-dry gap pass that keeps asking until
a round finds nothing new.

Everything here is **content-hash cached** under `phase3/cache/`, so re-running phase 3
after touching one stage re-narrates one stage.

---

## Two strategies

|           | `file` (default)           | `member`                                                |
| --------- | -------------------------- | ------------------------------------------------------- |
| Skeleton  | synthesized by the LLM     | **you author** `skeleton.yaml`                          |
| Leaf unit | one source file            | one function or method                                  |
| Phase 2b  | assign files to stages     | classify every member, then _derive_ file artifacts     |
| Phase 2c  | LLM grouping               | already done — deterministic, so 2c needs no LLM at all |
| Best for  | a repo you do not know yet | a repo whose shape you already know                     |

The chosen strategy is recorded in `phase2/strategy.json`. A partial re-run with a
different `--strategy` and no `--phase 2b` is **refused**, because the file-strategy
default silently overwriting a member-derived organization is exactly the kind of
corruption that is hard to notice.

---

## The work directory

```
<work>/
  phase1/graph.json           the call graph — everything downstream reads this
  phase1/functions.csv        every function, flat
  phase1/graph.dot            Graphviz
  phase1/dropped-calls.json   unresolved calls, categorized
  phase1/scan-coverage.json   files that could not be read or fully parsed
  phase2/cards/<rel>.json     one card per source file
  phase2/cards/_coverage.json how many files got prose, and which did not
  phase2/cards/_rejected/     replies that produced no usable card (capped)
  phase2/skeleton.yaml        the stage spine
  phase2/assignment.json      file → stage
  phase2/organization.yaml    intra-stage groups + reading order
  phase2/strategy.json        which strategy produced the above
  phase3/narration.json       stage + system prose
  phase3/registers.json       cross-stage state registers
  phase3/cache/               content-hash caches
  run-manifest.json           model, phases, timings and token usage of the last good run
```

`WorkDir` is the typed accessor for all of it. Every read is schema-validated and every
failure names the file:

```ts
import { WorkDir } from '@handbooks/pipeline';

const work = new WorkDir('work/myrepo');
work.loadGraph(); // MissingArtifactError('phase1/graph.json', 'run phase 1 first')
work.loadCards(); // unparseable files are skipped, not fatal
work.loadSkeleton();
work.loadAssignment();
work.loadOrganization();
work.loadNarration();
```

Writes are **atomic** (temp file, then rename), so a crash mid-write never leaves a
half-written artifact for the next run to choke on.

---

## Concurrency, cancellation and locking

- **One run per work directory.** `generateHandbook` takes a re-entrant directory lock; a
  concurrent CLI and Studio run on the same artifacts would otherwise interleave writes.
- **Cooperative cancellation.** Pass an `AbortSignal`: it is checked between phases and at
  every batch checkpoint, and threaded into every LLM call so in-flight requests abort. An
  aborted run leaves the partial artifacts it already saved and writes **no** run manifest.
- **Tunable parallelism** at every stage: `--read-workers`, `--assign-workers`,
  `--organize-workers`, `--narrate-workers`, all under one global `--llm-concurrency` cap.

---

## API

```ts
// orchestration
generateHandbook(options): Promise<GenerateStats>
loadHandbookModel(workDir, title): HandbookModel
expandPhases(spec): Set<Phase>              // 'all' | '2' | '2c,3' → a phase set
runManifestPath(workDir): string

// phases, individually
runPhase1(options): Promise<Phase1Stats>
generateCards(options): Promise<CardsResult>
synthesizeSkeleton(client, nav, cards, lang, onRejected?, signal?): Promise<Skeleton>
synthesizeWithDoctor(client, graph, cards, options): Promise<{ skeleton; assignment }>
assignFiles(client, graph, skeleton, options): Promise<Assignment>
reassignSubset(...) / rebuildAssignment(...)
organizeStages(client, graph, skeleton, assignment, cards, options): Promise<Organization>
narrate(client, artifacts, options): Promise<Narration>
extractRegisters(client, skeleton, narration, cards, options): Promise<RegisterEntry[]>

// member strategy
classifyMembers(client, graph, skeleton, options): Promise<MemberAssignment>
deriveFileArtifacts(graph, skeleton, members, cards)

// helpers
class WorkDir
buildInventory(graph): Record<string, FunctionNote[]>
computeStageStats(skeleton, assignment): StageStats
normalizeSkeleton(raw, draftedBy?): Skeleton
```

---

## Testing

```bash
pnpm --filter @handbooks/pipeline test
```

Every phase is tested end to end against `MockChatClient` with scripted replies —
including the failure paths: unparseable replies, partial batches, degradation tiers,
mid-run aborts and resume. **No test needs an API key.**

---

Part of [Handbooks](../../README.md) · [Artifact formats](../../docs/content/docs/reference/artifacts.mdx) ·
[Prompt catalogue](../../docs/content/docs/reference/prompts.mdx) · MIT
