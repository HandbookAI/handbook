<div align="center">

# Handbook

### One codebase in. **Two handbooks out.**

**📖 One your team actually reads. 🤖 One your AI agent actually routes with.**

[![License: MIT](https://img.shields.io/badge/License-MIT-14b8a6.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-6366f1.svg?style=flat-square)](.nvmrc)
[![Tests](https://img.shields.io/badge/tests-offline%2C%20no%20API%20key-2dd4bf.svg?style=flat-square)](#development)
[![Languages](https://img.shields.io/badge/languages-18-a78bfa.svg?style=flat-square)](#language-support)
[![Outputs](https://img.shields.io/badge/outputs-human%20%2B%20AI-f472b6.svg?style=flat-square)](#what-you-get)
[![LLM](https://img.shields.io/badge/LLM-any%20OpenAI--compatible-fbbf24.svg?style=flat-square)](#requirements)

**English** · [中文](README.zh-CN.md)

</div>

<p align="center">
  <img src="assets/pipeline.svg" alt="Handbook pipeline: analyze, generate, render, skill, plan, apply, resync" width="100%">
</p>

<table>
<tr>
<td width="50%" valign="top">

### 📖 The handbook for **humans**

A narrated, stage-by-stage walkthrough of your system — a real documentation site
with search, a theme toggle and deep links, generated from your code. Open it from
`file://`, host it anywhere, email it as a single page.

**You read this one.**

</td>
<td width="50%" valign="top">

### 🤖 The handbook for **AI**

A machine-shaped _location index_ — `symbol → path:line`, resolved call edges,
file→stage routing, `llms.txt`, and an installable SKILL package. Not a summary:
an address book. Facts only, prose clipped to one labelled column.

**Your coding agent reads this one.**

</td>
</tr>
</table>

---

## The 60-second version

You have a repository. It is too big to hold in your head, and too big to hold in a
context window. Your coding agent greps for a symbol, finds three of the seven places
that matter, edits those three, and ships a half-change. Meanwhile the humans on the
team have a wiki that was last true eight months ago.

**Handbook fixes both with one pass.** It reads your code with a real parser, builds a
map of it, then writes that map down twice: once as prose a person enjoys reading, once
as a location index an agent can route with. Then it keeps both current as the code
moves.

```bash
git clone <this repo> && cd handbook
pnpm install && pnpm build
pnpm demo            # ← full end-to-end run, offline, no API key, ~30 seconds
```

That last command runs the whole toolchain against a bundled sample project using a
bundled mock LLM. When it finishes you will have a rendered handbook, an HTML site, an
agent locator index and a validated SKILL package on disk. **Zero tokens spent.**

---

## Table of contents

- [What this actually is](#what-this-actually-is)
- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start — 8 steps](#quick-start--8-steps)
- [Studio: the same thing, but you click it](#studio-the-same-thing-but-you-click-it)
- [How generation works](#how-generation-works)
- [Configuration](#configuration)
- [Language support](#language-support)
- [Monorepo layout](#monorepo-layout)
- [Command cheatsheet](#command-cheatsheet)
- [Docker](#docker)
- [Development](#development)
- [Releasing](#releasing)
- [FAQ](#faq)

---

## What this actually is

### The problem, stated plainly

A code agent is good at _editing_ code and bad at _finding_ the code to edit. Ask it to
"retry failed uploads three times" and it will confidently patch the one upload function
it found — and miss the retry policy constant, the mirrored implementation in the batch
worker, the metric that counts attempts, and the test that asserts the old behaviour.

That is not a reasoning failure. It is a **routing** failure. The agent never saw a map.

### The answer, in three ideas

**1. Facts come from a parser, not from a model.**
Handbook parses every source file with tree-sitter and builds a typed call graph:
functions, methods, call edges resolved through `self`/attributes/parameters/imports,
calls that leave your code, and calls it could not resolve (quarantined, never guessed).
This layer never touches an LLM. It is the same every time you run it.

**2. Prose is layered _on top of_ facts, and labelled.**
An LLM writes the human-readable part — what a file is for, how a subsystem hangs
together, which state flows across which stages. It is always anchored to the graph, and
where it fails, the structure still ships with an empty description. **A missing sentence
is better than an invented one.**

**3. The map is built for routing, not for reading.**
The output is not a summary of your code. It is an index that answers _"which files,
functions and state does this change have to touch?"_ — including the scattered,
non-obvious ones. Then the planner uses that index, reads the real source at every
address it found, and emits an edit plan that is byte-exact enough to apply mechanically.

### Who this is for

| You are…                                           | You get…                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| An engineer who just inherited a 200k-line service | A stage-by-stage walkthrough you can actually read, plus an HTML site to share |
| Someone running a coding agent on a big repo       | A SKILL package that stops the agent guessing where things live                |
| A team lead onboarding people                      | Documentation that regenerates instead of rotting                              |
| Someone maintaining a polyglot monorepo            | One pass over 18 languages, with the analysis fidelity disclosed per language  |

---

## What you get

<p align="center">
  <img src="assets/outputs.svg" alt="Outputs: markdown handbook, HTML site, single page, agent locator index, llms.txt, SKILL package" width="100%">
</p>

One `generate` + `render` produces **two families of artifacts from the same map** —
know which one you are looking at, because they are shaped for different readers:

### 📖 For humans — documentation you'd choose to read

- **A multi-page HTML documentation site** — numbered stage tree, per-page table of
  contents with scroll-spy, **⌘K search across every stage, file, function and state
  register**, deep links, light/dark/auto theme, previous/next paging, a mobile drawer.
  All CSS and JS inlined, every link relative: it works straight off `file://`, no
  server, no CDN, no build step.
- **One self-contained HTML page** — the whole handbook in a single file you can email.
- **A markdown handbook** — `overview.md` (system prose + a mermaid stage map),
  `index.md` (every stage, nested), one page per stage with grouped file cards, and
  `register.md`: a table of cross-stage state with the stages that touch it. Reads
  perfectly in a git forge.

### 🤖 For AI — an address book, not an essay

- **An agent locator index** (`agent/`) — a deterministic, fact-gated routing layer:
  duty, entry concepts, state touched, exemplar files, core files, and co-change hints.
  A field is emitted _only_ if the structural signal for it exists, so an empty field
  means "no signal", never "unknown". (Co-change is the sparsest by design: it fires
  only where a test file sits _beside_ its source, which most projects do not do.)
- **`llms.txt` and `llms-full.txt`** — the [llms.txt](https://llmstxt.org/) convention,
  plus the whole handbook flattened into one document for a single-shot context load.
- **A SKILL package** — `SKILL.md` + `references/`, installable into a coding agent,
  with `coverage.json` carrying a content hash per file, so the agent can tell when a
  page has fallen behind the code — and say so instead of trusting it.

The split is the point: the human pages optimise for narrative and navigation; the
agent surfaces optimise for routing and staleness detection. Same facts underneath —
the parser's call graph — so the two never disagree about what the code does.

---

## Requirements

- **Node.js ≥ 20.11** and **pnpm ≥ 9** — that is the whole list. No native compilation,
  no Python, no `node-gyp`; the parsers are WebAssembly.
- **For the LLM phases:** any **OpenAI-compatible** chat endpoint. Hosted OpenAI, Azure,
  vLLM, Ollama, LiteLLM, an internal proxy — if it speaks `/v1/chat/completions`, it works.

```bash
export OPENAI_API_KEY=sk-...                        # required for phases 2 and 3
export OPENAI_MODEL=gpt-4o-mini                     # default: gpt-4o-mini
export OPENAI_BASE_URL=https://api.openai.com/v1    # or your own endpoint
```

Use `OPENAI_API_KEY=EMPTY` for keyless local endpoints. **Phase 1 — static analysis —
never needs a key at all**, so `handbook analyze` is always free.

Prefer a file over shell exports? The CLI auto-loads `./.env` from the directory you run
it in (shell variables always win — see [.env.example](.env.example)), or pass an
explicit `--env-file <path>`. See [Configuration](#configuration) for the full cascade.

---

## Quick start — 8 steps

```bash
pnpm install && pnpm build

# Make the CLI convenient to call:
alias handbook="node $(pwd)/packages/cli/dist/main.js"
```

> Every `pnpm <command>` shortcut below does an incremental `tsc -b` first (~0.4 s when
> up to date), so you can never run a stale `dist`.

### Step 1 — Look before you leap: build the call graph (free, no LLM)

```bash
handbook analyze --source /path/to/repo --work work/myrepo
```

```json
{ "language": "multi", "files": 412, "functions": 3187, "edgesKept": 9042, "edgesDropped": 611 }
```

This is your smoke test. It writes `work/myrepo/phase1/graph.json` plus a CSV of every
function and a Graphviz `.dot`. If the file count looks wrong, fix that before spending
tokens. `--lang auto` (the default) detects and merges every language in one pass.

### Step 2 — Generate the handbook (this is the part that costs tokens)

```bash
handbook generate --source /path/to/repo --work work/myrepo \
    --detail deep --synth-mode doctor --narrate-lang en
```

Runs phases 1 → 2a → 2b → 2c → 3. On a first run of a mid-size repo expect minutes, not
seconds. It is **resumable** (`--resume`), **cancellable**, and **content-hash cached**,
so a re-run after a crash picks up where it stopped.

Start cheap on a big repo and upgrade later:

```bash
handbook generate --source /path/to/repo --work work/myrepo          # brief cards, one-shot skeleton
handbook generate --source /path/to/repo --work work/myrepo \
    --phase 2a --detail deep --resume                                # deepen only the cards
```

### Step 3 — Render it into things people and agents can open

```bash
handbook render --work work/myrepo --title "MyRepo Handbook" \
    --html --html-single --agent-site --llms-txt
```

No LLM. Run it as often as you like — in CI, on every commit, for free.

### Step 4 — Package it as an agent SKILL

```bash
handbook skill --handbook work/myrepo/handbook --out skills/myrepo \
    --name myrepo --project "MyRepo" \
    --work work/myrepo --source /path/to/repo \
    --agent-dir work/myrepo/handbook/agent
```

`--work` + `--source` add `coverage.json` with a content hash per file — that is what
makes handbook drift _detectable_ rather than silently wrong.

### Step 5 — Validate it

```bash
handbook validate --skill skills/myrepo --source /path/to/repo
```

Checks structure, frontmatter contract, index ↔ stage-page consistency, and re-hashes
the source to report pages that have fallen behind. Exits non-zero when it fails, so you
can wire it into CI.

### Step 6 — Plan a real change with it

```bash
handbook plan --source /path/to/repo --handbook skills/myrepo/references \
    --request "Retry failed uploads three times before giving up" \
    --out plan.md
```

A **read-only** agent loop: it lists, reads and greps (it can never write), routes with
the handbook, verifies against the real source, and emits `plan.md`. The plan ends with a
machine-readable declarations block:

````markdown
### EDIT 1

- file: `src/upload.py`
- where: `Uploader.send (~88)` — add the retry wrapper

```old
    response = self._client.put(url, data)
```

```new
    response = self._retry(lambda: self._client.put(url, data), attempts=3)
```

```json
{ "will_modify": ["Uploader.send"], "will_add": ["Uploader._retry"], "will_remove": [] }
```
````

If the planner cannot produce a usable plan it **exits non-zero** instead of writing an
apology into `plan.md` that a script would then happily feed into `apply`.

### Step 7 — Apply it, byte-exactly, with a way back

```bash
handbook apply --source /path/to/repo --plan plan.md --dry-run   # verify only, never writes
handbook apply --source /path/to/repo --plan plan.md             # for real
```

The safety rules, in priority order:

1. **Verify everything first, then write in two phases.** One failure aborts the whole
   application. Writes are staged as temp files and only renamed once every stage
   succeeded — and if a rename fails midway, the already-renamed files are restored.
2. **`old` must match byte-exactly and uniquely.** Zero matches means the code moved on.
   Two or more means the anchor is ambiguous. Both refuse.
3. **Every touched file is backed up with its pre-patch hash**, so rollback can _prove_
   it is restoring the bytes this patch replaced.
4. **No path escapes the source root** — including through symlinked parent directories.

Changed your mind?

```bash
handbook rollback --backup /path/to/repo/.handbook-patches/<stamp>
```

Rollback refuses any file that changed _after_ the patch, unless you pass `--force`.

### Step 8 — Roll the handbook forward

A resync **case** is a directory you assemble: the tree as it stands now, plus what the
plan said.

```
cases/upload-retry/
  edited/       copy of the repo after the change   (required)
  plan.md       the plan from step 6                (optional — sharpens scope)
  change.diff   unified diff of the change          (optional — widens scope)
```

```bash
mkdir -p cases/upload-retry
cp -R /path/to/repo cases/upload-retry/edited
cp plan.md cases/upload-retry/
handbook resync --case cases/upload-retry --work work/myrepo
```

Resync re-analyzes the edited tree, diffs old graph against new, and regenerates **only
what changed** — cards for touched files, assignment for added ones, organization for
affected stages, narration for affected prose. Already-rendered outputs under
`work/myrepo/handbook` refresh automatically (`--no-render` to skip).

No endpoint handy? `--no-llm` does the structural refresh and marks the prose stale
rather than pretending it is current.

---

## Studio: the same thing, but you click it

```bash
pnpm studio                    # → http://127.0.0.1:4860
pnpm studio --port 5000        # flags pass straight through
```

A local web UI over the whole toolchain: a repository registry, generation with live
streaming logs, the handbook browser, an impact graph, a source viewer, and the full
**plan → dry-run → apply → rollback → resync** loop.

It binds to `127.0.0.1` by default and its CSRF defence checks the `Host` header, so it
stays a local tool unless you deliberately change that.

---

## How generation works

| Phase  | What happens                                                                                                                                                                                                                                                                                                                                                | LLM? |
| :----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--: |
| **1**  | Language adapters (tree-sitter, WASM) parse every file into a typed call graph: functions, methods, resolved call edges (`self` / attribute / parameter / import), boundary calls into third-party code, and unresolved calls quarantined into `dropped-calls.json` rather than guessed at.                                                                 |  ❌  |
| **2a** | Every file gets a **card**: purpose, role, lifecycle — and in `--detail deep` a 120–300-word walkthrough plus per-function purpose / data flow / relations merged onto the graph facts. Batched, three-tier degradation, crash-safe, resumable.                                                                                                             |  ✅  |
| **2b** | A stage **skeleton** — the narrative spine, ordered by execution lifecycle — is synthesized from directory rollups and entry points; then every file is assigned to exactly one stage. `--synth-mode doctor` runs an actor–critic repair loop (engineer / architect / reader critics) until nothing is unassigned and no structural change survives review. |  ✅  |
| **2c** | Each stage's files are ordered by call-graph topology and grouped into 2–8 titled sub-groups. Every failure degrades to a deterministic flat order — **files are never dropped.**                                                                                                                                                                           |  ✅  |
| **3**  | Bottom-up narration: stage overviews (children before parents), then the system overview, then cross-stage **state registers** extracted with a loop-until-dry gap pass. Content-hash cached throughout.                                                                                                                                                    |  ✅  |

`--phase` selects any subset: `all`, `1`, `2` (= 2a+2b+2c), `2a`, `2b`, `2c`, `3`, or a
comma list like `2c,3`.

### Two strategies

|           | `--strategy file` (default) | `--strategy member`                    |
| --------- | --------------------------- | -------------------------------------- |
| Skeleton  | synthesized by the LLM      | **you author** `skeleton.yaml`         |
| Leaf unit | one source file             | one function/method                    |
| Best for  | repos you do not know yet   | repos where you already know the shape |
| Cost      | lower                       | higher — every member is classified    |

The strategy is recorded in `<work>/phase2/strategy.json`, so a partial re-run
(`--phase 3`) can never silently cross strategies.

### The work directory

```
<work>/
  phase1/graph.json          the call graph — the one file everything downstream reads
  phase1/functions.csv       every function, flat, for grepping
  phase1/graph.dot           Graphviz, if you want to look at it
  phase1/dropped-calls.json  calls we could not resolve, categorized — not hidden
  phase2/cards/<rel>.json    one card per source file
  phase2/cards/_coverage.json
  phase2/skeleton.yaml       the stage spine
  phase2/assignment.json     file → stage
  phase2/organization.yaml   intra-stage groups + reading order
  phase3/narration.json      stage and system prose
  phase3/registers.json      cross-stage state registers
  phase3/cache/              content-hash caches
  run-manifest.json          model, phases, timings, token usage of the last good run
```

Every artifact is schema-validated on read. A corrupted one fails loudly and names
itself; it never propagates.

---

## Configuration

<p align="center">
  <img src="assets/config-cascade.svg" alt="Configuration cascade: flag, environment, .env files, handbook.config.yaml, default" width="100%">
</p>

Every setting is declared **once**, in one registry table. The CLI flags, the environment
variable names, the config-file keys, [.env.example](.env.example),
[handbook.config.example.yaml](handbook.config.example.yaml) and
[docs/configuration.md](docs/content/docs/reference/configuration.md) are all _generated_ from it — so they
cannot drift apart.

### Precedence, highest first

1. **CLI flag** — `--read-workers 4`
2. **Shell environment** — `HANDBOOK_GENERATE_READ_WORKERS`, then `HANDBOOK_READ_WORKERS`,
   then vendor aliases like `OPENAI_MODEL`
3. **`.env` cascade** — merged into the environment before anything reads it
4. **`handbook.config.yaml`** — discovered by walking up from the cwd, stopping at the git root
5. **Registry default**

### Multiple environments

```bash
handbook generate --env prod --source ~/code/proj --work work/proj
```

`--env prod` (or `HANDBOOK_ENV=prod`) loads `.env.prod.local` → `.env.prod` →
`.env.local` → `.env`, in that order, first writer wins — and prefers
`handbook.config.prod.yaml` over the plain file. `--env-file <path>` bypasses the
cascade entirely and loads exactly that file.

### Ask what is actually set

```bash
handbook config                              # a table: every setting, value, and where it came from
handbook config --command generate           # scoped to one subcommand
handbook config --json                       # machine-readable
handbook config --check                      # exit non-zero if anything is invalid or missing
```

`--check` is the one to put in CI. A typo'd environment variable used to mean "silently
ran at the default"; now it is a build failure with the variable named in the message.

Secrets (`llmApiKey` / `OPENAI_API_KEY`) are masked in that output, are never a flag, and
are **rejected** if they appear in a config file — because config files get committed.

Full reference: **[docs/configuration.md](docs/content/docs/reference/configuration.md)**.

---

## Language support

**Full fidelity** — hand-written adapters with type-driven call resolution, inherited
members and per-attribute state tracking:

| Language       | Extensions                              |     | Language     | Extensions               |
| -------------- | --------------------------------------- | --- | ------------ | ------------------------ |
| **Python**     | `.py`                                   |     | **Ruby**     | `.rb` `.rake` `.gemspec` |
| **TypeScript** | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` |     | **PHP**      | `.php` `.phtml`          |
| **Go**         | `.go`                                   |     | **Swift**    | `.swift`                 |
| **Rust**       | `.rs`                                   |     | **Dart**     | `.dart`                  |
| **Java**       | `.java`                                 |     | **Solidity** | `.sol`                   |
| **C#**         | `.cs`                                   |     | **Shell**    | `.sh` `.bash`            |
| **C/C++**      | `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` …  |     |              |                          |

> JavaScript is covered by the TypeScript adapter — there is no separate one to pick.

**Generic tier** — one config-driven engine, one declarative spec per language. Exact
file and function inventory; call relations are best-effort:

**Kotlin** (`.kt` `.kts`) · **Scala** (`.scala` `.sc`) · **Zig** (`.zig`) ·
**Objective-C** (`.m`) · **OCaml** (`.ml`)

A handbook whose analysis mixes tiers **says so** in its overview, so "best-effort call
relations" can never be read as "exact".

Two caveats stated up front rather than discovered later:

- **Swift**'s grammar aborts the process on V8 ≥ 13. The adapter refuses at discovery on
  such a runtime and names the remedy (`node --liftoff-only`) instead of crashing your run.
- A **shell** script containing a `case` statement is skipped, because that grammar throws
  (its external scanner imports a symbol the pinned WASM linker does not provide). `case`
  is ubiquitous, so in practice this is most non-trivial scripts — measured on `nvm`, all
  6 files and all 122 functions. Shell is listed as full-tier because the adapter is, but
  **treat shell coverage as partial** until that grammar is fixed upstream.

Both are reported in the scan log — never silently dropped.

---

## Monorepo layout

<p align="center">
  <img src="assets/architecture.svg" alt="Package layering: entry points, capabilities, engines, foundation" width="100%">
</p>

| Package                                              | Role                                                                                                     | LLM? |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | :--: |
| [`@handbooks/core`](packages/core/README.md)         | Data model (call-graph IR + handbook model), zod schemas, the config registry, dependency-free utilities |  ❌  |
| [`@handbooks/analyzer`](packages/analyzer/README.md) | Multi-language static call-graph extraction via tree-sitter WASM                                         |  ❌  |
| [`@handbooks/llm`](packages/llm/README.md)           | OpenAI-compatible chat client, disk cache, actor–critic orchestration, offline mock                      |  ✅  |
| [`@handbooks/pipeline`](packages/pipeline/README.md) | The generation pipeline — phases 1–3, file & member strategies                                           |  ✅  |
| [`@handbooks/renderer`](packages/renderer/README.md) | Markdown pages, agent locator index, HTML site, llms.txt                                                 |  ❌  |
| [`@handbooks/skill`](packages/skill/README.md)       | SKILL packaging, validation, coverage drift detection                                                    |  ❌  |
| [`@handbooks/planner`](packages/planner/README.md)   | Handbook-guided read-only planning agent                                                                 |  ✅  |
| [`@handbooks/patcher`](packages/patcher/README.md)   | Apply a plan's EDIT blocks byte-exactly — all-or-nothing, backups, rollback                              |  ❌  |
| [`@handbooks/resync`](packages/resync/README.md)     | Incremental handbook roll-forward after code changes                                                     |  ✅  |
| [`@handbooks/studio`](packages/studio/README.md)     | Local web UI: repos · generate · browse · evolve                                                         |  ✅  |
| [`@handbooks/cli`](packages/cli/README.md)           | The `handbook` command                                                                                   |  —   |

Dependency direction is strictly one-way:
`cli → pipeline/renderer/skill/planner/patcher/resync → analyzer/llm → core`.
LLM-touching code and deterministic code are separated by **package boundary**, so the
analyzer, renderer, patcher and skill packages are fully reusable with no LLM at all.
A cycle or an upward import fails `pnpm check:workspace` — it is enforced, not documented.

---

## Command cheatsheet

Every script below runs an incremental build first, and forwards flags straight through —
no `--` needed:

```bash
pnpm studio                                                 # local web UI → http://127.0.0.1:4860

pnpm analyze  --source ~/code/proj --work work/proj         # static call graph, free
pnpm generate --source ~/code/proj --work work/proj --narrate-lang en
pnpm render   --work work/proj --html --agent-site --llms-txt
pnpm skill    --handbook work/proj/handbook --out skills/proj --name proj
pnpm validate --skill skills/proj --source ~/code/proj

pnpm plan     --source ~/code/proj --request "Add a --json flag to export" --out plan.md
pnpm apply    --source ~/code/proj --plan plan.md --dry-run
pnpm apply    --source ~/code/proj --plan plan.md
pnpm rollback --backup ~/code/proj/.handbook-patches/<stamp>
pnpm resync   --case cases/mycase --work work/proj

pnpm config:show --command generate                         # what is set, and where it came from
pnpm handbook --help                                        # every subcommand
pnpm handbook <subcommand> --help                           # every flag, with its env var and default
```

Offline demos and the mock endpoint:

```bash
pnpm demo             # examples/run-demo.sh — full pipeline, fully offline, zero tokens
pnpm demo:self        # this repo as its own input (mock LLM)
pnpm demo:self:real   # same, against the real endpoint from .env
pnpm mock-llm         # the bundled mock LLM server alone, on port 8099
```

> LLM-backed commands (`generate` past phase 1, `plan`, `resync` without `--no-llm`, and
> Studio's jobs) auto-load `./.env` from the **current directory**, with shell variables
> winning — so run them from the repo root, or pass `--env-file`.

---

## Docker

No local Node/pnpm install needed. The image is Node 22 (deliberately not 24 — see the
Dockerfile) plus the built packages:

```bash
pnpm run docker:build     # docker build -t handbook:local .

# HANDBOOK_SOURCE=/src and HANDBOOK_WORK=/work are baked in, so you only mount volumes:
docker run --rm -v "$PWD:/src:ro" -v handbook-work:/work handbook:local analyze
docker run --rm -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate --narrate-lang en

# Docker's own --env-file layers on top of the toolchain's .env loading — both apply:
docker run --rm --env-file .env -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate

# One image serves every environment (.env* files are never baked in — see .dockerignore):
docker run --rm --env-file .env.prod -e HANDBOOK_ENV=prod \
  -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate
```

Studio via compose:

```bash
pnpm run docker:studio    # docker compose up --build studio
```

> **Only `http://localhost:4860` works — not a LAN IP, not the container name.**
> Studio's CSRF defence checks the `Host` header, not the socket. A container must bind
> `0.0.0.0` for the published port to be reachable at all, but that does not widen who
> may talk to it: browsing from the host still sends `Host: localhost:4860` and passes,
> while a request naming a LAN IP or the container hostname is refused with `403` by
> design. Remote access is a deliberately unimplemented, separate feature — an explicit
> allowlist — not a gap in this defence.

---

## Development

```bash
pnpm build             # tsc -b (composite project references)
pnpm test              # build + vitest — every test runs offline
pnpm check             # the everyday gate; run this before committing
pnpm check:all         # check + packaging + install smoke — what CI runs

pnpm typecheck         # sources, then the tests against tsconfig.tests.json
pnpm lint              # eslint over the whole repo, zero warnings tolerated
pnpm format            # prettier over the whole repo
pnpm test:coverage     # vitest with per-package coverage floors
pnpm check:workspace   # the monorepo's structural invariants
pnpm check:packaging   # publint + are-the-types-wrong, per package
pnpm check:install     # pack, install with plain npm, drive the CLI
pnpm check:cli         # every subcommand and config layer, end to end, offline
```

`pnpm check` runs, in order: type-check → workspace invariants → eslint → prettier →
tests with per-package coverage floors. It is deliberately the fast one. `pnpm check:all`
adds the two publish-facing gates, which pack eleven tarballs and belong in CI and before
a release rather than in every local loop. A pre-commit hook runs the formatter and linter
over staged files only; `commit-msg` enforces Conventional Commits.

**Testing philosophy: everything runs offline.** LLM-dependent flows are tested against
`MockChatClient` (scripted rules) and a bundled mock HTTP endpoint; deterministic packages
are tested directly. **No test ever needs an API key.**

Four conventions the tooling _enforces_ rather than documents:

- **Versions live in one place.** Every third-party version is declared in
  `pnpm-workspace.yaml`'s catalog; packages depend on `"catalog:"` and never restate a
  range. A literal range in a manifest fails `pnpm check:workspace`.
- **`dist/` is the published surface.** Build projects exclude `*.test.ts`;
  `tsconfig.tests.json` type-checks tests with `noEmit`, and source maps are excluded
  from the tarball because they name sources that are never published.
- **Coverage floors are per package.** A single repo-wide number hides what matters: at
  86% overall, `@handbooks/cli` sits at 23%. Each package has its own floor, set just
  under what it measures, so it ratchets.
- **Tests resolve `@handbooks/*` to source, not `dist`.** Otherwise coverage of anything
  consumed across a package boundary is attributed nowhere. The real `dist` is verified
  by `tsc -b` and by `pnpm check:install`, which installs the packed tarballs with plain
  npm and drives the CLI against them.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) ·
Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset        # describe the change and pick the version bumps
```

Commit that file with the code. On merge to `main`, the Release workflow opens a
"Version Packages" PR that applies pending changesets, bumps versions and writes each
package's `CHANGELOG.md`. Merging that PR publishes to npm — which stays inert until an
`NPM_TOKEN` secret is configured, so versioning and changelogs are correct whether or not
the packages are being published yet.

---

## FAQ

**Does my code get uploaded anywhere?**
Phase 1 is entirely local. Phases 2 and 3 send file contents to whatever endpoint you
configured — which can be a model running on your own machine. Nothing else leaves.
`--max-chars-per-file` caps how much of any single file is ever sent.

**How much does a run cost?**
It depends on repo size and `--detail`. Start with `handbook analyze` (free) to see the
file count, then run `--detail brief` before `--detail deep`. Every run writes token usage
into `run-manifest.json`, and `--llm-cache` makes re-runs nearly free.

**What if the LLM writes something wrong?**
Structural facts are not LLM-written, so paths, functions and line ranges are correct by
construction. For prose, agents consuming the SKILL are instructed to append contradictions
to `corrections.jsonl`; `handbook resync --corrections <file>` then refreshes exactly the
files named in it.

**Can I use it without an LLM at all?**
Yes, partially. `analyze`, `render`, `skill`, `validate`, `apply` and `rollback` never
touch one, and `resync --no-llm` does a structural refresh that marks prose stale instead
of pretending it is current.

**My language is not in the list.**
Adding a generic-tier language is a declarative spec, not a new parser — see
[packages/analyzer/README.md](packages/analyzer/README.md).

---

## Documentation

- **[docs/](docs/)** — the full documentation site (architecture, every command, every
  setting, formats, prompts, guides)
- [docs/configuration.md](docs/content/docs/reference/configuration.md) — every setting, generated from the registry
- [examples/](examples/) — the offline end-to-end demo, mock LLM server included
- Per-package READMEs under [packages/](packages/)

## License

MIT — see [LICENSE](LICENSE).
