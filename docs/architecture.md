# Architecture

This document explains how the toolchain is layered, how data flows through it, and why
the boundaries sit where they do. Artifact schemas live in [formats.md](formats.md);
prompts in [prompts.md](prompts.md).

## 1. The problem shape

A codebase handbook has two consumers with different needs:

1. **Humans** need a narrative: what the system is, in what order things happen, how the
   parts cooperate.
2. **Code agents** need an index: given a change request, which files / functions /
   pieces of state are in scope — including the scattered, non-obvious sites a text
   search misses.

Both views must stay anchored to facts. The architecture therefore separates three
concerns end to end:

- **Facts** come from static analysis (the call graph). They are deterministic and
  never invented by a model.
- **Structure** (stages, assignment, ordering) is proposed by an LLM but _validated
  mechanically_ and repaired in an actor–critic loop.
- **Prose** (cards, overviews) is written by an LLM around the facts, cached by content
  hash, and always degradable to deterministic fallbacks.

## 2. Package layering

```
                 ┌─────────────────────────── cli ────────────────────────────┐
                 │  analyze · generate · render · skill · validate · plan · resync
                 └──────┬──────────┬──────────┬─────────┬──────────┬──────────┘
                        │          │          │         │          │
                  pipeline    renderer     skill     planner    resync
                        │        (no LLM)  (no LLM)     │          │
              ┌─────────┼──────────────────────────────┐│          │
              │         │                              ││          │
          analyzer     llm ◀───────────────────────────┘└──▶ pipeline (reuse)
          (no LLM)      │
              └────┬────┘
                  core          ← types, schemas, utilities; no internal deps
```

Rules that keep this healthy:

- **One-way dependencies.** `core` imports nothing internal. Nothing imports `cli`.
- **LLM isolation.** Only `llm`, `pipeline`, `planner`, `resync` may talk to a model —
  and only through the `ChatClient` interface. `analyzer`, `renderer`, `skill` are
  fully deterministic and reusable without any LLM.
- **The renderer boundary is a type.** `HandbookModel` (in `core`) is the only thing
  the renderer knows about; it never reads pipeline internals. Any producer that can
  fill a `HandbookModel` gets rendering, skill packaging and planning for free.

## 3. Data flow and artifacts

```
source tree
   │  analyzer (tree-sitter WASM, per-language adapters)
   ▼
phase1/graph.json ─ functions.csv ─ graph.dot ─ dropped-calls.json
   │  pipeline 2a: cards (batched LLM, 3-tier degradation, resumable)
   ▼
phase2/cards/<rel>.json + _coverage.json
   │  pipeline 2b: skeleton synthesis (+ doctor loop) + file assignment
   ▼
phase2/skeleton.yaml + assignment.json
   │  pipeline 2c: call-graph topo order + LLM grouping (flat fallback)
   ▼
phase2/organization.yaml
   │  pipeline 3: bottom-up narration + register extraction (cached)
   ▼
phase3/narration.json + registers.json (+ phase3/cache/**)
   │  loadHandbookModel()
   ▼
HandbookModel ──▶ renderer ──▶ handbook/ (md, html/, handbook.html, agent/)
                     │
                     └──▶ skill ──▶ SKILL.md + references/ (+ coverage.json)
```

Work-dir contract: every phase reads only upstream artifacts and writes its own, all
schema-validated on read (zod, with `version` fields). Any phase can be re-run alone;
crashes resume (cards are written per batch; narration is content-hash cached).

## 4. The analyzer

Each language implements one `LanguageAdapter` (discover + analyze, optionally
`statementSpans`). All grammars are WebAssembly (`web-tree-sitter` + `tree-sitter-wasms`),
so installation never compiles native code.

Adapters run two passes per module:

1. **Scan** — declarations, imports, classes/methods, per-function facts (signature,
   lines, async, decorators, `self`/`this` attribute reads/writes, typed parameters,
   learned attribute types from constructor assignments and typed parameters).
2. **Resolve** — every call site becomes a typed edge: `self_method`,
   `self_attr_method`, `param_method`, `internal_func`, `internal_constructor`,
   `boundary`, `boundary_constructor` — or `unresolved`, which the graph builder
   quarantines into `dropped-calls.json` with a category (builtin, local-var method,
   bare name, …). The kept graph only ever contains resolved, named callees.

The **nav-pack** is a deterministic orientation summary derived from the graph
(directory rollup, entry-point candidates by root/name heuristics, fan-out, external
subsystems). It is the only "view" of the codebase the skeleton synthesizer sees, which
keeps that prompt small and grounded.

## 5. The pipeline's quality machinery

- **Three-tier card degradation** (2a): whole batch → single file → per-function chunks
  for oversized files. Files that still fail get an honest empty card and are listed in
  `_coverage.json` — coverage is complete _by construction_, and misses are visible
  rather than silent.
- **Actor–critic skeleton doctor** (2b): the actor proposes ≤3 structural changes
  (add/remove/merge/split) against ground-truth stats; three role-played critics
  (engineer, architect, reader) review in parallel; every change is then re-validated
  mechanically before being applied; affected files are re-assigned; the loop stops on
  convergence or two no-progress rounds. A broken critic counts as REJECT — a failing
  reviewer must never wave changes through.
- **Deterministic fallbacks everywhere** (2c/3): organization falls back to call-graph
  order; narration falls back to the stage description; register extraction failure
  yields an empty list. A generation run degrades — it does not block.
- **Content-hash caches** (3): stage/system prose is cached under
  `phase3/cache/` keyed by prompt version + language + full prompt hash, so re-runs and
  resyncs only pay for what actually changed.

## 6. Strategies: file vs member

The pipeline has one orchestrator and two granularities:

- **file** (default; scales to large repos): the file is the handbook's leaf. The
  skeleton is synthesized automatically; assignment is per file.
- **member** (small repos, tight prose): you author `skeleton.yaml`; individual
  functions/methods are classified into your stages; file-level artifacts (assignment,
  organization) are then _derived_ from the member map (majority vote per file,
  call-order within stages), so rendering, skill packaging and resync work identically
  for both strategies.

## 7. The helper side

- **patcher** turns a plan into real edits: it parses the `### EDIT n` blocks, verifies
  every `old` anchor against current file contents (unique match required), and only then
  writes — all-or-nothing, backing up each touched file so a rollback restores exact prior
  bytes. A stale or ambiguous anchor is a refusal, never a guess; this strictness is what
  makes a blind executor safe.
- **studio** is a localhost web shell over everything above (registry, jobs with SSE logs,
  handbook browsing, impact graph, source viewer, plan → apply → rollback → resync).
- **skill** packages a rendered handbook into `SKILL.md + references/` and can embed
  `coverage.json` (file → stage + source content hashes). The validator re-checks
  structure, the index↔stage-page contract, and hash freshness — a stale hash is a
  drift signal, not a hard failure of the code itself.
- **planner** is a single read-only agent: `list_dir` / `read_file` / `grep` / `finish`.
  It speaks a single-turn transcript protocol (the whole conversation is one prompt per
  step), which works against any OpenAI-compatible endpoint — no function-calling API
  needed — and makes the loop fully scriptable in tests. The handbook mounts read-only
  under `__handbook__/`; the source root is never writable; path escapes are rejected.
  The plan ends with EDIT blocks (byte-exact old→new) plus a declarations JSON
  (`will_modify` / `will_add` / `will_remove`) that resync consumes.
- **resync** rolls the derived layer forward from a case directory (`edited/` tree +
  optional `plan.md` declarations + optional diff): re-analyze, content-hash-diff the two
  graphs (structural fingerprints as the fallback; declarations/diff can only _widen_ the
  changed set, never narrow it), regenerate cards at the handbook's own depth, reconcile
  assignment, mechanically prune/append affected stages' organization, re-narrate through
  the cache. `--no-llm` refreshes the structural facts and marks prose stale instead of
  rewriting it.

## 8. Testing strategy

- Everything runs offline. `ChatClient` is the single LLM seam; tests script it with
  `MockChatClient` rules, and the examples ship a mock HTTP endpoint so even the CLI
  runs end-to-end without a key.
- Deterministic packages (core, analyzer, renderer, skill) are tested directly —
  analyzer tests build real mini-repos in temp dirs and assert nodes/edges per language.
- Pipeline/planner/resync tests run the real orchestration against scripted mocks,
  including cache-hit assertions and failure-degradation paths.

## 9. Decisions worth knowing (ADR digest)

| #   | Decision                               | Why                                                                                                                                                               |
| --- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | WASM-only tree-sitter                  | zero native builds; one loading path for every language; version-locked grammars                                                                                  |
| 2   | Hand-rolled fetch LLM client           | OpenAI-compatible endpoints vary; a thin client with explicit retry/fail-fast beats an SDK dependency; the interface seam matters more than the transport         |
| 3   | One pipeline, two strategies           | the previous-generation approach of separate large/small pipelines duplicates adapters, critics, clients and renderers; a strategy flag removes ~40% surface area |
| 4   | zod-validated artifacts with `version` | corrupted or hand-edited artifacts fail loudly at the boundary instead of poisoning later phases                                                                  |
| 5   | Facts/prose separation in cards        | the model annotates a complete graph-derived inventory; prose can be empty, facts cannot be wrong                                                                 |
| 6   | Single-turn planner protocol           | works on any endpoint, trivially mockable, transcript is inspectable; the cost (token re-send) is acceptable at planner scale                                     |
| 7   | ESM + `tsc -b`, no bundler             | libraries ship type-checked `dist/` + `.d.ts`; composite references give incremental builds with zero extra tooling                                               |
