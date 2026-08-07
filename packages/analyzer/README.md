# @handbook/analyzer

Multi-language static call-graph extraction, entirely LLM-free. Language adapters parse source files with tree-sitter (WASM) into the shared IR from `@handbook/core`; the graph builder assembles that IR into the persisted `graph.json` (plus CSV/DOT/dropped-calls artifacts) that phase 1 of the pipeline writes and every later phase consumes. It also derives the "navigation pack" — a deterministic orientation summary that feeds skeleton synthesis and file assignment.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Define the `LanguageAdapter` contract and the adapter registry (`registerAdapter`, `getAdapter`, `adapterForFile`, `discoverAll`).
- Ship the built-in adapters. Hand-written, full fidelity: Python, TypeScript (`.ts`/`.tsx` plus
  JavaScript `.js`/`.jsx`/`.mjs`/`.cjs`), Go, Rust, Java, C#, C/C++ (`.c`/`.h`/`.cpp`/… — one
  adapter, since the C++ grammar parses C while the C grammar fails on C++). Config-driven,
  generic tier: Kotlin, Scala, Zig, Objective-C, OCaml, plus Shell. Each declares an
  `AdapterCapabilities` saying which call types it can actually produce.
- Build the degree-annotated `CodeGraph` from adapter output, synthesizing nodes referenced by edges but never defined (implicit constructors, boundary symbols).
- Partition unresolved edges out of the graph into a categorized `dropped-calls.json` instead of polluting it.
- Emit the four phase-1 artifacts (`graph.json`, `functions.csv`, `graph.dot`, `dropped-calls.json`) and the `NavPack` orientation summary.
- Does NOT call any LLM and does NOT know about handbook stages, cards, or the work-directory layout.
- Does NOT perform full type inference — resolution is index-based and best-effort; anything unresolvable becomes a categorized dropped edge, never a guessed edge.

## Public API

Adapter contract and registry (`adapter.ts`):
- `LanguageAdapter` — `{ name, extensions, discover(sourceRoot), analyze(files, sourceRoot), statementSpans?(filePath, qualname) }`.
- `COMMON_SKIP_DIRS` — directory names every adapter's discovery skips.
- `discoverByExtension(sourceRoot, extensions, extraSkipDirs?, filter?)` — default discovery helper.
- `registerAdapter(name, factory)` / `getAdapter(name)` / `availableLanguages()` — lazy-instantiating registry.
- `adapterForFile(relPath)` — owning adapter by longest-extension match.
- `discoverAll(sourceRoot)` — per-language file lists; each file claimed by at most one adapter.
- `registerBuiltinAdapters()` — register every built-in once at startup.

Adapters implement `LanguageAdapter`; the hand-written ones are built on `spine.ts` (shared
driver, standard cross-module indexes, stateless resolution helpers) and the generic-tier ones
come from `generic.ts` plus a declarative spec. Only `PythonAdapter` implements
`statementSpans` (legal snap boundaries for resync). Run `handbook analyze --help` for the
authoritative list — the CLI derives it from the registry.

Graph building (`graph.ts`):
- `buildGraph(analysis, options): BuildGraphResult` — with `BuildGraphOptions` (`sourceRoot`, `scannedFiles`, `language`, `defaultExt?`, `now?`) and `BuildGraphResult` (`graph`, `dropped`, `stats`).
- `writeGraphArtifacts(result, outDir)` — persist all four artifacts.
- `functionsCsv(graph)` / `graphDot(graph)` — CSV inventory and Graphviz rendering.
- `synthesizeBoundary(id)` — `boundary:<qualname>` id to a `BoundaryNode` with best-effort module/class split.
- `categorizeDropped(calleeId)` — bucket an unresolved callee (`builtin`, `self_attr_unknown`, `local_var_method`, …).

Navigation pack (`navpack.ts`):
- `buildNavPack(graph, options?): NavPack` — directory map, entry-point candidates, fan-out top-K, external subsystems; `NavPackOptions` (`fanOutTopK?`, `sampleFnsPerFile?`), `NavFileDescriptor`.
- `allFileDescriptors(graph, nav)` — nav files widened with function-less scanned files (the 1:1 file set for cards/assignment).
- `renderOrientation(nav, options?)` — bounded plain-text orientation block for prompts; `OrientationOptions`.

tree-sitter runtime (`languages.ts`):
- `loadLanguage(grammar)` / `createParser(grammar)` — lazy, cached WASM grammar loading by `tree-sitter-wasms` name.

## Usage

```ts
import { registerBuiltinAdapters, getAdapter, buildGraph, writeGraphArtifacts, buildNavPack, renderOrientation } from '@handbook/analyzer';

registerBuiltinAdapters();
const adapter = getAdapter('typescript');
const sourceRoot = '/path/to/project';
const files = adapter.discover(sourceRoot);
const analysis = await adapter.analyze(files, sourceRoot);

const result = buildGraph(analysis, { sourceRoot, scannedFiles: files, language: 'typescript' });
writeGraphArtifacts(result, '/path/to/work/phase1');

const nav = buildNavPack(result.graph);
console.log(renderOrientation(nav));
console.log(result.stats); // { functions, edgesKept, edgesDropped, internalNodes, boundaryNodes }
```

## Design notes

- WASM-only tree-sitter: grammars come from the `tree-sitter-wasms` package and load via `web-tree-sitter`, so no native compilation or node-gyp is ever required; the runtime and each grammar are initialized lazily and cached.
- Adding a language is just implementing `LanguageAdapter` and calling `registerAdapter` — the graph builder, dropped-call categorization, and nav pack are identical across languages.
- Adapters emit ALL edges including unresolved ones; `buildGraph` partitions `unresolved` edges into `dropped-calls.json` with per-category counts, keeping the graph honest without losing evidence.
- Edge endpoints that were never defined in source are synthesized (`synthetic: true`, line numbers 0) rather than dropped, so degree counts and traversals stay consistent.
- `discoverAll` claims each file for the first adapter that discovers it and swallows individual adapter failures, so one broken grammar cannot break multi-language scans.

## Dependencies

Internal:
- `@handbook/core` — the IR types/schemas, `listFilesRecursive`, `truncate`, atomic JSON writes.

External:
- `web-tree-sitter` — the tree-sitter runtime (parser + language loading) compiled to WASM.
- `tree-sitter-wasms` — prebuilt grammar `.wasm` binaries for python/typescript/tsx/go/rust/bash.
