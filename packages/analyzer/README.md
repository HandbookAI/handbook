# @handbook/analyzer

**English** · [中文](README.zh-CN.md)

> Point it at a directory. Get back a typed call graph. No LLM, no network, no native
> compilation — the parsers are WebAssembly.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fanalyzer-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbook/analyzer)
[![no LLM](https://img.shields.io/badge/LLM-never-2dd4bf?style=flat-square)](#)
[![languages](https://img.shields.io/badge/languages-18-a78bfa?style=flat-square)](#supported-languages)

---

## What it is

`@handbook/analyzer` is the static-analysis engine of the [Handbook](../../README.md)
toolchain — and it is genuinely useful on its own. Give it a source root and it returns
the same language-agnostic IR no matter what the code is written in:

- every **function and method**, with its file, line range, signature, decorators,
  parameter types, and the instance attributes it reads and writes;
- every **call edge**, resolved through `self`/`this`, attribute types, parameter type
  annotations, imports, and inheritance;
- every **boundary call** — where your code leaves for a third-party library;
- every **unresolved call**, categorized and quarantined into its own artifact rather
  than guessed at.

Because it is deterministic, the same input always produces the same graph. You can diff
two graphs, commit one, or assert on one in a test.

---

## Install

```bash
pnpm add @handbook/analyzer
```

No post-install compilation step. Grammars ship as `.wasm` files.

---

## Quick start

```ts
import {
  registerBuiltinAdapters,
  discoverAll,
  getAdapter,
  buildGraph,
  writeGraphArtifacts,
} from '@handbook/analyzer';

registerBuiltinAdapters();

const root = '/path/to/repo';
const byLanguage = discoverAll(root); // { typescript: [...], python: [...] }

const analyses = [];
for (const [lang, files] of Object.entries(byLanguage)) {
  analyses.push(await getAdapter(lang).analyze(files, root));
}

const result = buildGraph(
  { functions: analyses.flatMap((a) => a.functions), edges: analyses.flatMap((a) => a.edges) },
  { sourceRoot: root, scannedFiles: Object.values(byLanguage).flat(), language: 'multi', defaultExt: '' },
);

console.log(result.stats); // { functions, edgesKept, edgesDropped }
writeGraphArtifacts(result, './out');
```

Or, from the command line — same thing, one line:

```bash
handbook analyze --source /path/to/repo --work work/myrepo
```

### What lands on disk

| File                 | Contents                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- |
| `graph.json`         | The graph: metadata, degree-annotated nodes, edges, per-class self-attribute index |
| `functions.csv`      | Every function, flat — for `grep`, a spreadsheet, or a quick sanity check          |
| `graph.dot`          | Graphviz. `dot -Tsvg graph.dot -o graph.svg`                                       |
| `dropped-calls.json` | Unresolved calls by category, with the raw call text and line                      |

---

## Supported languages

**Full tier** — hand-written adapters. Type-driven call resolution, inherited members,
per-attribute state tracking, statement spans:

| Language                      | Extensions                                               |
| ----------------------------- | -------------------------------------------------------- |
| Python                        | `.py`                                                    |
| TypeScript _(and JavaScript)_ | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`                  |
| Go                            | `.go`                                                    |
| Rust                          | `.rs`                                                    |
| Java                          | `.java`                                                  |
| C#                            | `.cs`                                                    |
| C/C++                         | `.c` `.h` `.cpp` `.cc` `.cxx` `.c++` `.hpp` `.hh` `.hxx` |
| Ruby                          | `.rb` `.rake` `.gemspec`                                 |
| PHP                           | `.php` `.phtml`                                          |
| Swift                         | `.swift`                                                 |
| Dart                          | `.dart`                                                  |
| Solidity                      | `.sol`                                                   |
| Shell                         | `.sh` `.bash`                                            |

**Generic tier** — one config-driven engine, one declarative spec per language. Exact
file and function inventory; call relations are best-effort:

Kotlin (`.kt` `.kts`) · Scala (`.scala` `.sc`) · Zig (`.zig`) · Objective-C (`.m`) ·
OCaml (`.ml`)

### Fidelity is declared, and disclosed downstream

Every adapter must publish what it can actually deliver:

```ts
readonly capabilities: AdapterCapabilities = {
  tier: 'full',
  callTypes: ['self_method', 'self_attr_method', 'param_method', 'internal_func', /* … */],
  selfAttrs: true,
  statementSpans: true,
};
```

Phase 1 records this **per language** in the graph metadata, and the renderers surface it
in the handbook overview. Both tiers produce identical-looking IR, so without this a
reader would take a generic-tier call edge for a Python-grade fact. Saying so out loud is
the whole point.

### Two honest caveats

- **Swift**: the bundled grammar aborts the process on V8 ≥ 13 (measured fatal 5/5 on
  Node 24, fine on Node 21, and unique to that one grammar). The adapter therefore
  **refuses at discovery** on such a runtime and names the remedy — `node --liftoff-only`
  — instead of taking your whole run down with it.
- **Shell**: a script containing a `case` statement is skipped, because that grammar
  throws — its external scanner imports `env.isalpha`, which the pinned
  `web-tree-sitter` dynamic linker does not provide. `case` is ubiquitous, so in practice
  this is most non-trivial scripts: measured on `nvm`, all 6 files and all 122 functions.
  The adapter is full tier; **shell coverage is not**, until that grammar is fixed
  upstream. The scan log names the cause rather than leaving you to infer it.

Both are reported through the logger during the scan. Nothing is ever silently dropped.

---

## API

### Adapters and the registry

```ts
registerBuiltinAdapters(): void            // idempotent; call once at startup
registerAdapter(name, factory): void       // register your own
getAdapter(name): LanguageAdapter          // throws, naming every registered language
availableLanguages(): string[]
adapterForFile(relPath): LanguageAdapter | undefined   // longest-extension match wins
discoverAll(root, logger?): Record<string, string[]>   // first adapter to claim a file keeps it
discoverByExtension(root, exts, extraSkipDirs?, filter?): string[]
```

`COMMON_SKIP_DIRS` is the shared skip list every adapter honours: `.git`, `node_modules`,
`vendor`, `target`, `build`, `dist`, `out`, `__pycache__`, `.venv`, `.idea`, `.vscode`,
`.handbook-patches`, and friends.

### The adapter contract

```ts
interface LanguageAdapter {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly capabilities: AdapterCapabilities; // required — see above
  discover(sourceRoot: string): string[];
  analyze(files, sourceRoot, options?): Promise<ModuleAnalysis>;
  statementSpans?(filePath, qualname): Promise<Array<[number, number]> | undefined>;
}
```

That is the entire surface. Implement it, `registerAdapter` it, and every downstream
phase works unchanged.

### Graph building

```ts
buildGraph(analysis, options): BuildGraphResult
  // partitions kept vs dropped edges, annotates in/out degree,
  // synthesizes nodes for referenced-but-undefined constructors
writeGraphArtifacts(result, outDir): void
functionsCsv(graph): string
graphDot(graph): string
categorizeDropped(calleeId): string
dedupeFunctionsById(functions): FunctionNode[]   // last definition wins
```

### Navigation pack

```ts
buildNavPack(graph, options?): NavPack
renderOrientation(nav, options?): string
allFileDescriptors(graph, nav): NavFileDescriptor[]
```

A compact, LLM-friendly summary of a graph — entry points, directory rollups, hub
functions — used by the pipeline to synthesize a skeleton without shipping the whole graph
into a prompt.

---

## Adding a language

**Generic tier** (usually enough): add one `GenericLanguageSpec` to `GENERIC_LANGUAGES` in
`src/generic.ts` — grammar name, extensions, the node types that mean "function",
"class", "call", and how a qualified name is built. No new dependency: the grammars for
the languages listed above already ship with `tree-sitter-wasms`.

**Full tier**: implement `LanguageAdapter` under `src/adapters/`, declare honest
`capabilities`, and register it in `src/register.ts`.

Either way, add the display name to the docs drift test — it fails the build if a
registered language is missing from the READMEs, which is exactly how the previous list
managed to drift six languages behind.

---

## Design notes

- **Two-pass analysis.** Pass 1 collects definitions and builds type indexes; pass 2 walks
  call sites with those indexes in hand. That is what makes `self.attr.method()` and
  `param.method()` resolvable at all.
- **Unresolved is a category, not a guess.** A call the analyzer cannot pin down goes to
  `dropped-calls.json` with its raw text and line. Guessing would poison every downstream
  consumer with edges that look exactly as trustworthy as the real ones.
- **A broken adapter must not break discovery.** `discoverAll` catches per-adapter
  failures, logs them, and carries on with the rest.
- **`web-tree-sitter` is pinned to `~0.25.10`.** 0.26 changed the WASM ABI and fails to
  load the bundled grammars. The pin is deliberate; do not loosen it.

---

## Testing

```bash
pnpm --filter @handbook/analyzer test
```

Every test parses real source fixtures — no mocked parse trees, because a mocked tree
proves nothing about a grammar.

---

Part of [Handbook](../../README.md) · [Architecture](../../docs/content/docs/concepts/architecture.mdx) ·
[Artifact formats](../../docs/content/docs/reference/artifacts.mdx) · MIT
