# @handbook/core

Shared foundation for the whole toolchain: the language-agnostic call-graph IR, the handbook domain model (cards, skeleton, assignment, organization, narration, registers), a small error taxonomy, a leveled logger, and dependency-free utilities (concurrency, retry, hashing, atomic file I/O, text, JSON extraction, progress). Every other `@handbook/*` package depends on it; it depends on nothing but `zod`.

## Responsibilities

- Define the call-graph IR (`FunctionNode`, `BoundaryNode`, `CallEdge`, `CodeGraph`, `DroppedCalls`) that all language analyzers target.
- Define the handbook model (`FileCard`, `Skeleton`, `Assignment`, `Organization`, `Narration`, `RegisterEntry`, `HandbookModel`) that phases 2–3 produce and the renderer/skill/planner/resync consume.
- Provide zod schemas for every persisted artifact so reads fail loudly on corruption.
- Provide the shared error classes (`HandbookError`, `MissingArtifactError`, `ArtifactValidationError`, `PermanentError`) and `Logger`.
- Provide utilities used everywhere: `pLimit`/`mapLimit`, `retry`, hashing, atomic writes, recursive file discovery, `extractJsonBlock`, `Progress`.
- Does NOT parse source code, call any LLM, or touch the network — it is pure data model + local helpers.
- Does NOT know the work-directory layout; that lives in `@handbook/pipeline`.

## Public API

Call-graph IR (`ir.ts`):
- `CALL_TYPES` / `CallType` — how a call site was resolved (`self_method`, `internal_func`, `boundary`, `unresolved`, …).
- `functionNodeSchema` / `FunctionNode`, `boundaryNodeSchema` / `BoundaryNode`, `callEdgeSchema` / `CallEdge` — the three IR kinds.
- `ModuleAnalysis` — `{ functions, edges }`, what a language adapter returns.
- `graphNodeSchema` / `GraphNode`, `selfAttrsIndexSchema` / `SelfAttrsIndex`, `codeGraphSchema` / `CodeGraph`, `droppedCallsSchema` / `DroppedCalls` — persisted graph artifacts (`version: 1`).
- `isInternalNode(node)` — type guard for internal function nodes.

Handbook model (`model.ts`):
- `NARRATE_LANGS` / `NarrateLang` (`'en' | 'zh'`), `FILE_ROLES` / `FileRole`, `coerceRole(value)` — constrained vocabularies.
- `functionNoteSchema` / `FunctionNote`, `fileCardSchema` / `FileCard`, `cardCoverageSchema` / `CardCoverage` — per-file leaf content.
- `stageSchema` / `Stage`, `skeletonSchema` / `Skeleton`, `assignmentSchema` / `Assignment`, `organizedFileSchema` / `OrganizedFile`, `organizationSchema` / `Organization` — structure artifacts.
- `registerEntrySchema` / `RegisterEntry`, `registersSchema` / `Registers`, `narrationSchema` / `Narration` — phase-3 artifacts.
- `HandbookModel` — the generation/presentation boundary type.
- `StageTree` — stage lookups: `title/description/isCrosscut/children/depth/subtree`, plus `byId`, `order`, `topLevel`.

Errors and logging:
- `HandbookError(code, message)`, `MissingArtifactError(what, hint?)`, `ArtifactValidationError(path, detail)`, `PermanentError(message)`.
- `Logger`, `LogLevel`, `createLogger(prefix?, level?)` (stderr only), `silentLogger`.

Utilities:
- `pLimit(concurrency): LimitFn`, `mapLimit(items, concurrency, fn)` — bounded concurrency, order-preserving.
- `retry(fn, options?)` / `RetryOptions` — linear backoff + jitter; `PermanentError` aborts immediately.
- `sha1Hex(text)`, `sha256Hex(data)`, `shortHash(text)` — digests (12-char short hash for cache keys).
- `toPosix`, `ensureDir`, `writeFileAtomic(path, content)`, `writeJsonFile`, `readJsonFile`, `readValidatedJson(path, schema)`, `fileExists`, `listFilesRecursive(root, options?)` / `DiscoverOptions`.
- `truncate`, `firstSentence`, `slugify`, `capList`, `leafName` — text helpers.
- `extractJsonBlock(text)` — first parseable JSON value from LLM output (fenced blocks, then balanced-brace scan).
- `Progress` (`tick(weight?, note?)`, `finish(unit?)`), `fmtDuration(seconds)` — ETA logging for batched passes.

## Usage

```ts
import {
  codeGraphSchema,
  readValidatedJson,
  writeJsonFile,
  isInternalNode,
  mapLimit,
  retry,
  createLogger,
  type CodeGraph,
} from '@handbook/core';

const log = createLogger('[demo]', 'info');
const graph: CodeGraph = readValidatedJson('work/phase1/graph.json', codeGraphSchema);

const internal = Object.values(graph.nodes).filter(isInternalNode);
const summaries = await mapLimit(internal.slice(0, 20), 4, async (node) =>
  retry(async () => `${node.qualname} (${node.file}:${node.lineStart})`),
);
writeJsonFile('out/summary.json', summaries);
log.info(`summarized ${summaries.length} functions`);
```

## Design notes

- Every persisted artifact is a zod schema with a `version` literal field; `readValidatedJson` turns silent corruption into an `ArtifactValidationError` at the read site.
- `writeFileAtomic` writes to a sibling temp file and renames over the target, so a crashed writer never leaves a half-written artifact for the next phase to read.
- `retry` treats `PermanentError` as non-retryable by construction — the LLM client maps 4xx statuses onto it so hopeless calls fail fast.
- `StageTree` re-derives children from `parent` pointers instead of trusting persisted `children` lists, making it robust to stale hand-edited skeletons.
- The logger writes exclusively to stderr so stdout stays clean for machine-readable command output.

## Dependencies

Internal: none — this is the root of the dependency graph.

External:
- `zod` — runtime validation of every persisted artifact plus inferred TypeScript types from a single source of truth.
