# @handbook/core

**English** · [中文](README.zh-CN.md)

> The shared vocabulary. Every other `@handbook/*` package speaks it, and none of them
> may define its own.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fcore-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbook/core)
[![no LLM](https://img.shields.io/badge/LLM-never-2dd4bf?style=flat-square)](#)

---

## What it is

`@handbook/core` is the foundation layer of the [Handbook](../../README.md) toolchain.
It contains four things and deliberately nothing else:

1. **The data model** — what a call graph _is_, and what a handbook _is_, as zod schemas.
2. **The configuration registry** — every setting in the whole toolchain, declared once.
3. **Errors and logging** — the shared failure vocabulary.
4. **Dependency-free utilities** — atomic file writes, concurrency limits, retries,
   hashing, `.env` parsing, directory locks, JSON extraction from LLM prose.

It has exactly two runtime dependencies: `zod` (validation) and `yaml` (parsing).
**It never talks to a network or an LLM.**

### Why it exists

Two packages that each define "what a file card looks like" will disagree within a month.
Making the model a package means the pipeline that _writes_ an artifact and the renderer
that _reads_ it are checked against the same schema by the compiler — and, on every read
from disk, by the validator.

---

## Install

```bash
pnpm add @handbook/core
```

---

## The data model

### Layer 1 — the call-graph IR (`ir.ts`)

Language-agnostic. Every analyzer produces this and nothing else, so nothing downstream
knows or cares which language a fact came from.

```ts
import { codeGraphSchema, type CodeGraph, type FunctionNode, isInternalNode } from '@handbook/core';

const graph: CodeGraph = codeGraphSchema.parse(JSON.parse(raw)); // throws with a path on mismatch

for (const node of Object.values(graph.nodes)) {
  if (isInternalNode(node)) {
    console.log(node.qualname, node.file, node.lineStart, node.lineEnd, node.nCallers);
  }
}
```

| Type           | What it holds                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FunctionNode` | One internal function or method: id, qualname, file, line range, signature, `isAsync`, `isMethod`, `className`, decorators, `selfAttrsRead` / `selfAttrsWritten`, `paramTypes` |
| `BoundaryNode` | One external symbol your code calls (`boundary:<qualname>`)                                                                                                                    |
| `CallEdge`     | `callerId` → `calleeId`, plus `isAwait`, `callType`, `line`, and the raw call text                                                                                             |
| `CodeGraph`    | The persisted graph: metadata (source root, scanned files, per-file hashes, per-language capabilities) + nodes + edges + a per-class self-attribute index                      |
| `DroppedCalls` | Unresolved calls, categorized — kept, never guessed at                                                                                                                         |

`CallType` is a closed vocabulary of eight values: `self_method`, `self_attr_method`,
`param_method`, `internal_func`, `internal_constructor`, `boundary`,
`boundary_constructor`, `unresolved`.

#### Fidelity is declared, not assumed

```ts
interface AdapterCapabilities {
  tier: 'full' | 'generic';
  callTypes: readonly CallType[];
  selfAttrs: boolean; // can it track self/this attribute reads and writes?
  statementSpans: boolean; // can it report statement spans (resync snap precision)?
}
```

Two analysis tiers coexist and produce the same IR — which is exactly the trap: a reader
(especially an agent) would assume a generic-tier language's call facts are as hard as
Python's. So every adapter must say what it can deliver, phase 1 records it _per
language_, and the renderers disclose it. Same honesty rule the handbook applies to
"assigned vs described" coverage.

### Layer 2 — the handbook model (`model.ts`)

What phases 2–3 produce and the renderer, skill packager, planner and resync consume.

| Type            | Persisted as               | What it is                                                                        |
| --------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `FileCard`      | `phase2/cards/<rel>.json`  | Purpose, `FileRole`, lifecycle; deep cards add a description and `FunctionNote[]` |
| `Skeleton`      | `phase2/skeleton.yaml`     | The stage spine — ordered `Stage`s with parent/children and a `crosscut` flag     |
| `Assignment`    | `phase2/assignment.json`   | File → primary stage (+ extras), plus disjoint buckets and coverage               |
| `Organization`  | `phase2/organization.yaml` | Per-stage titled groups and a flat reading order                                  |
| `Narration`     | `phase3/narration.json`    | System overview + one summary per stage, in `NarrateLang`                         |
| `Registers`     | `phase3/registers.json`    | Cross-stage state, each with semantics and the stages that touch it               |
| `HandbookModel` | —                          | The in-memory boundary type between generation and presentation                   |

`FileRole` is a constrained vocabulary — `entrypoint`, `orchestration`, `domain_logic`,
`io_transport`, `data_model`, `config`, `util`, `test`, `generated`, `other` — and
`coerceRole()` maps anything else to `other`, so a creative LLM answer can never widen it.

`StageTree` is the shared lookup helper: `title()`, `children()`, `depth()`, `subtree()`.
It re-derives children from `parent` rather than trusting a stale `children` list, and
its `subtree()` walk is iterative and cycle-safe — a corrupted skeleton must not overflow
the stack.

---

## The configuration registry

One table (`config/registry.ts`) describes every setting exactly once. **Four** consumers
read it and nothing else:

```
                       ┌─► CLI flags        (packages/cli/src/options.ts)
  SETTINGS ────────────┼─► value resolution (config/resolve.ts)
  (one table)          ├─► .env.example     (config/render-docs.ts)
                       └─► docs/configuration.md + handbook.config.example.yaml
```

Adding a setting is a one-line change that shows up on all four surfaces — or fails the
build, because a drift test compares the generated files byte for byte.

```ts
import { resolveConfig, settingsFor, envName, scopedEnvName } from '@handbook/core';

envName('readWorkers'); // 'HANDBOOK_READ_WORKERS'
scopedEnvName('generate', 'readWorkers'); // 'HANDBOOK_GENERATE_READ_WORKERS'

const { values, sources, errors } = resolveConfig({
  command: 'generate',
  flags: { readWorkers: 4 },
  env: process.env,
  file: loadConfigFile('/repo/handbook.config.yaml'),
});

values.readWorkers; // 4
sources.readWorkers; // { kind: 'flag', name: '--read-workers' }
errors; // every problem, not just the first
```

**Errors are collected, never thrown**, so `handbook config --check` reports everything in
one pass instead of one problem per run.

Three rules the resolver enforces:

- An **empty** value reads as unset. `HANDBOOK_TITLE=` does not produce a handbook titled
  with nothing.
- A **supplied-but-invalid** value never falls through to a default. A typo'd number is an
  error, not a silent 12.
- A `path`-typed value from the **config file** resolves against the file's own directory,
  while one from a flag or env resolves against the cwd — so a committed config file stays
  portable.

Secrets (`secret: true`) get no flag and are **rejected** if they appear in a config file,
with a message saying why: config files get committed.

---

## The `.env` cascade

```ts
import { applyEnvFiles, applyEnvFile, parseEnvFile } from '@handbook/core';

applyEnvFiles(process.cwd(), 'prod');
// tries, in order: .env.prod.local → .env.prod → .env.local → .env
// → returns the paths actually loaded, highest precedence first
```

The whole cascade is "call it in this order, first writer wins", because `applyEnvFile`
never overrides a key that is already set. That single rule is what keeps the shell
outranking every file with no extra logic anywhere.

The parser is deliberately small and deliberately careful: `export ` prefixes, `#`
comments, single/double quotes, inline ` #` comments on unquoted values, CRLF **and**
bare-CR line endings, and a literal `__proto__=` line preserved as data rather than
silently swallowed by `Object.prototype`.

---

## Utilities

| Module              | Exports                                                                                                                             | Note                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `util/fsx`          | `writeFileAtomic`, `writeJsonFile`, `readJsonFile`, `readValidatedJson`, `ensureDir`, `listFilesRecursive`, `fileExists`, `toPosix` | Atomic = write temp, then rename. A crash never leaves a half-written artifact. |
| `util/concurrency`  | `pLimit`, `mapLimit`                                                                                                                | Bounded parallelism for every batched phase                                     |
| `util/retry`        | `withRetry`                                                                                                                         | Exponential backoff with jitter                                                 |
| `util/hash`         | `sha256Hex`                                                                                                                         | Content hashes for caches and drift detection                                   |
| `util/lock`         | `withDirLock`                                                                                                                       | Re-entrant directory lock — one pipeline run per work dir                       |
| `util/json-extract` | `extractJsonBlock`, `describeJsonShape`                                                                                             | Pull JSON out of an LLM reply that wrapped it in prose or a fence               |
| `util/reply-shape`  | `replyExcerpt`                                                                                                                      | Readable diagnostics for a reply that did not parse                             |
| `util/text`         | `truncate`, `firstSentence`                                                                                                         |                                                                                 |
| `util/progress`     | `progressLine`                                                                                                                      |                                                                                 |
| `logger`            | `createLogger`, `silentLogger`, `LOG_LEVELS`                                                                                        | `debug` / `info` / `warn` / `error` / `silent`                                  |
| `errors`            | `HandbookError`, `MissingArtifactError`, `ArtifactValidationError`, `PermanentError`                                                | Every error carries a stable code                                               |

---

## Guarantees

- **No network, no LLM, no child processes.** Ever.
- **Every persisted artifact carries a `version` field** and is schema-validated on read.
- **`MissingArtifactError` names the remedy**, not just the problem:
  `phase1/graph.json — run phase 1 first`.
- **`PermanentError` means "do not retry"** — the LLM client uses it to distinguish a bad
  request from a flaky one.

---

## Testing

```bash
pnpm --filter @handbook/core test
```

Fully offline, no fixtures beyond temp dirs. Coverage floor is enforced in
`vitest.config.ts` at the repo root.

---

Part of [Handbook](../../README.md) · [Architecture](../../docs/content/docs/concepts/architecture.mdx) ·
[Configuration reference](../../docs/content/docs/reference/configuration.md) · MIT
