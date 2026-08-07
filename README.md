# Handbook

**English** | [中文](README.zh-CN.md)

Turn any codebase into a navigable **handbook** — then use that handbook to help a code
agent find _every_ place a change needs to touch, and keep the handbook current as the
code evolves.

```
source code ──▶ analyze ──▶ generate ──▶ render ──▶ skill ──▶ plan
   (any repo)   call graph   LLM pipeline  md + HTML   agent      change
                (no LLM)     cards/stages  + locator   package    localization
                             /narration    index                     │
                                  ▲                                  │
                                  └────────────── resync ◀───────────┘
                                             (after code changes)
```

## What you get

- **A handbook**: a stage-by-stage map of the codebase — system overview, ordered stage
  pages with plain-language walkthroughs of every file and function, a cross-stage
  **state-register** table, and a self-contained HTML site (multi-page or single-file).
- **An agent locator index**: a deterministic, fact-gated routing layer (duty, entry
  concepts, state, exemplars, co-change hints, core files) built for code agents.
- **A SKILL package**: the handbook repackaged as an agent skill (`SKILL.md` +
  `references/`), with content-hash coverage for drift detection.
- **A planner**: a read-only agent that routes with the handbook, reads the real source,
  and emits a byte-exact edit plan plus machine-readable change declarations.
- **Resync**: after a real code change, the handbook's derived layer rolls forward
  incrementally — no full regeneration.

## Requirements

- Node.js ≥ 20.11, pnpm ≥ 9
- For LLM phases: any **OpenAI-compatible** endpoint

```bash
export OPENAI_API_KEY=sk-...                        # required for phases 2/3
export OPENAI_MODEL=gpt-4o-mini                     # default: gpt-4o-mini
export OPENAI_BASE_URL=https://api.openai.com/v1    # or vLLM / a proxy / any compatible endpoint
```

Use `OPENAI_API_KEY=EMPTY` for keyless local endpoints. Phase 1 (static analysis) never
needs a key. `--lang auto` detects and merges every language in one pass.

**Full fidelity** (hand-written adapters: type-driven call resolution, inherited members,
per-attribute state tracking): Python, TypeScript — which also covers JavaScript
(`.js`/`.jsx`/`.mjs`/`.cjs`) — Go, Rust, Java, C#, C/C++, Ruby, PHP, Swift, Dart, Solidity,
and Shell.
**Generic tier** (config-driven: exact file and function inventory, best-effort call
relations): Kotlin, Scala, Zig, Objective-C, OCaml. A handbook whose analysis mixes tiers says
so in its overview — see [docs/architecture.md](docs/architecture.md).

Two caveats worth stating up front: Swift's grammar aborts the process on V8 ≥ 13, so the
adapter refuses at discovery there and names the remedy (`node --liftoff-only`) instead of
crashing; and a shell script containing a `case` statement is skipped, because that grammar
throws — both are reported in the scan log rather than silently dropped.

Prefer a file over shell exports? The CLI auto-loads `./.env` from the directory you run
it in (shell variables win; see [.env.example](.env.example)), or pass an explicit
`--env-file <path>`.

## Quick start

```bash
pnpm install
pnpm build

# Try the full offline demo first (bundled mock LLM, no key needed):
bash examples/run-demo.sh

# On your own repo:
alias handbook="node $(pwd)/packages/cli/dist/main.js"

# 1. Static call graph only — a good smoke test, no LLM:
handbook analyze --source /path/to/repo --work work/myrepo

# 2. Full generation (cards → skeleton → assignment → organization → narration):
handbook generate --source /path/to/repo --work work/myrepo \
    --detail deep --synth-mode doctor --narrate-lang en

# 3. Render markdown + HTML site + agent locator index:
handbook render --work work/myrepo --title "MyRepo Handbook" --html --html-single --agent-site

# 4. Package as an agent SKILL (+ coverage hashes for drift detection):
handbook skill --handbook work/myrepo/handbook --out skills/myrepo \
    --name myrepo --work work/myrepo --source /path/to/repo

# 5. Validate a skill (structure + freshness):
handbook validate --skill skills/myrepo --source /path/to/repo

# 6. Plan a change with the handbook:
handbook plan --source /path/to/repo --handbook skills/myrepo/references \
    --request "Retry failed uploads three times before giving up" --out plan.md

# 7. Apply the plan for real (verify first, then write with backups):
handbook apply --source /path/to/repo --plan plan.md --dry-run
handbook apply --source /path/to/repo --plan plan.md
#    …changed your mind? handbook rollback --backup <dir printed above>

# 8. After the change lands, roll the handbook forward. A resync case is a
#    directory you assemble — the tree as it stands now, plus what the plan said:
#      cases/upload-retry/
#        edited/       copy of the repo after the change   (required)
#        plan.md       the plan from step 6                (optional — sharpens scope)
#        change.diff   unified diff of the change          (optional — widens scope)
mkdir -p cases/upload-retry
cp -R /path/to/repo cases/upload-retry/edited
cp plan.md cases/upload-retry/
handbook resync --case cases/upload-retry --work work/myrepo
#    Already-rendered outputs under work/myrepo/handbook refresh automatically
#    (--no-render to skip); card depth follows the existing handbook.
```

Prefer clicking over typing? `handbook studio` opens a local web UI at http://127.0.0.1:4860 — repository registry, generation with live logs, the handbook browser, an impact graph, a source viewer, and the full plan → dry-run → apply → rollback → resync loop.

Key `generate` flags: `--strategy file|member` (file = auto skeleton, file-as-leaf;
member = you author `skeleton.yaml`, functions are classified individually),
`--detail brief|deep`, `--synth-mode oneshot|doctor` (doctor = actor–critic repair loop),
`--narrate-lang en|zh`, `--phase all|1|2|2a|2b|2c|3|comma-list`, `--resume`.

## How generation works

| Phase | What happens                                                                                                                                                                                                                                                                                                                                            | LLM |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1     | Language adapters (tree-sitter, WASM) parse every file into a typed call graph: functions, methods, resolved call edges (`self`/attribute/parameter/import), boundary calls, unresolved calls quarantined into `dropped-calls.json`.                                                                                                                    | no  |
| 2a    | Every file gets a **card**: purpose, role, lifecycle — and in deep mode a 120–300-word walkthrough plus per-function purpose / data flow / relations merged onto graph facts. Batched, three-tier degradation, crash-safe, resumable.                                                                                                                   | yes |
| 2b    | A stage **skeleton** (the narrative spine, ordered by execution lifecycle) is synthesized from directory rollups + entry points, then every file is assigned to exactly one stage. `--synth-mode doctor` runs an actor–critic repair loop (engineer / architect / reader critics) until nothing is unassigned and no structural change survives review. | yes |
| 2c    | Each stage's files are ordered by call-graph topology and grouped into 2–8 titled sub-groups; every failure degrades to a deterministic flat order — files are never dropped.                                                                                                                                                                           | yes |
| 3     | Bottom-up narration: stage overviews (children before parents), a system overview, and cross-stage **state registers** extracted with a loop-until-dry gap pass. Everything is content-hash cached.                                                                                                                                                     | yes |

Every artifact is schema-validated JSON/YAML under the work dir; any phase can be re-run
independently and a crashed run resumes where it stopped.

## Monorepo layout

| Package                                             | Role                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@handbook/core`](packages/core/README.md)         | Data model (call-graph IR + handbook model), zod schemas, dependency-free utilities |
| [`@handbook/analyzer`](packages/analyzer/README.md) | Multi-language static call-graph extraction (tree-sitter WASM) — no LLM             |
| [`@handbook/llm`](packages/llm/README.md)           | OpenAI-compatible chat client + actor–critic orchestration + offline mock           |
| [`@handbook/pipeline`](packages/pipeline/README.md) | The generation pipeline (phases 1–3, file & member strategies)                      |
| [`@handbook/renderer`](packages/renderer/README.md) | Markdown pages, agent locator index, self-contained HTML site — no LLM              |
| [`@handbook/skill`](packages/skill/README.md)       | SKILL packaging + validation + coverage drift detection — no LLM                    |
| [`@handbook/planner`](packages/planner/README.md)   | Handbook-guided read-only planning agent                                            |
| [`@handbook/patcher`](packages/patcher/README.md)   | Apply a plan's EDIT blocks byte-exactly — all-or-nothing, backups, rollback         |
| [`@handbook/resync`](packages/resync/README.md)     | Incremental handbook roll-forward after code changes                                |
| [`@handbook/studio`](packages/studio/README.md)     | Local web UI: repos · generate · browse · evolve (127.0.0.1)                        |
| [`@handbook/cli`](packages/cli/README.md)           | The `handbook` command                                                              |

Dependency direction is strictly one-way (`cli → pipeline/renderer/skill/planner/resync →
analyzer/llm → core`); LLM-touching code and deterministic code are separated by package
boundary, so the analyzer, renderer and skill packages are reusable with no LLM at all.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layering, data flow, design decisions
- [docs/formats.md](docs/formats.md) — every artifact schema (graph, cards, skeleton, …)
- [docs/prompts.md](docs/prompts.md) — the complete prompt catalogue
- [examples/](examples/) — offline end-to-end demo (mock LLM server included)
- Per-package READMEs under [packages/](packages/)

## Command cheatsheet (no global CLI install needed)

Every script runs an incremental build first (`tsc -b`, ~0.4 s when up to date), so
you never run a stale `dist`. Flags are forwarded straight through — no `--` needed:

```bash
pnpm studio                          # local web UI → http://127.0.0.1:4860
pnpm studio --port 5000              # flags pass straight through

pnpm analyze  --source ~/code/proj --work work/proj      # static call graph, free
pnpm generate --source ~/code/proj --work work/proj --narrate-lang en
pnpm render   --work work/proj --html --agent-site
pnpm skill    --handbook work/proj/handbook --out skills/proj --name proj
pnpm validate --skill skills/proj --source ~/code/proj

pnpm plan     --source ~/code/proj --request "Add a --json flag to export" --out plan.md
pnpm apply    --source ~/code/proj --plan plan.md --dry-run
pnpm apply    --source ~/code/proj --plan plan.md
pnpm rollback --backup ~/code/proj/.handbook-patches/<stamp>
pnpm resync   --case case1 --work work/proj

pnpm handbook <subcommand>           # generic entry point, same as the binary
pnpm handbook --help                 # list every subcommand
```

Offline demos and the mock endpoint:

```bash
pnpm demo             # examples/run-demo.sh — fully offline, zero tokens
pnpm demo:self        # this repo as its own input (mock)
pnpm demo:self:real   # same, against the real endpoint from .env
pnpm mock-llm         # the bundled mock LLM server alone (port 8099)
```

> LLM-backed commands (`generate` past phase 1, `plan`, `resync` without `--no-llm`,
> and Studio's jobs) auto-load `./.env` from the **current directory**, with shell
> variables winning — so run them from the repo root.

## Development

```bash
pnpm build            # tsc -b (composite project references)
pnpm test             # build + vitest (every test runs offline)
pnpm check            # the everyday gate — run before committing (see below)
pnpm check:all        # check + packaging + install smoke; what CI runs
pnpm typecheck        # tsc -b, then the tests against tsconfig.tests.json
pnpm lint             # eslint over the whole repo
pnpm format           # prettier over the whole repo
pnpm test:coverage    # vitest with per-package coverage floors
pnpm check:workspace  # the monorepo's structural invariants
pnpm check:packaging  # publint + are-the-types-wrong, per package
pnpm run check:install # pack, install with plain npm, drive the CLI
```

`pnpm check` runs, in order: type-check (sources, then tests) → workspace
invariants → eslint with zero warnings → prettier → tests with per-package
coverage floors. It is deliberately the fast one. `pnpm check:all` adds the two
publish-facing gates, which pack eleven tarballs and belong in CI and before a
release rather than in every local loop. A pre-commit hook runs the formatter and
linter over staged files only, and `commit-msg` enforces Conventional Commits.

Testing philosophy: everything runs offline. LLM-dependent flows are tested against
`MockChatClient` (scripted rules) and the bundled mock HTTP endpoint; deterministic
packages are tested directly. No test ever needs an API key.

Conventions the tooling enforces rather than documents:

- **Versions live in one place.** Every third-party version is declared in
  `pnpm-workspace.yaml`'s catalog; packages depend on `"catalog:"` and never
  restate a range. A literal range in a manifest fails `pnpm check:workspace`.
- **`dist/` is the published surface.** Build projects exclude `*.test.ts` and
  `*.test-helper.ts`; `tsconfig.tests.json` type-checks them with `noEmit`, and
  source maps are excluded from the tarball because they name sources that are
  never published. A test artifact under `dist/` fails the same check.
- **Coverage floors are per package.** A single repo-wide number hides what
  matters: at 86% overall, `@handbook/cli` sits at 23%. Each package has its own
  floor, set just under what it measures, so it ratchets.
- **Tests resolve `@handbook/*` to source, not `dist`.** Otherwise coverage of
  anything consumed across a package boundary is attributed nowhere —
  `core/src/util/hash.ts` read as 0% while the pipeline called it on every run.
  The real `dist` is verified by `tsc -b` and by `pnpm run check:install`, which
  installs the packed tarballs with plain npm and runs the CLI against them.

## Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset        # describe the change and pick the version bumps
```

Commit that file with the code. On merge to `main`, the Release workflow opens a
"Version Packages" PR that applies pending changesets, bumps versions and writes
each package's `CHANGELOG.md`. Merging that PR publishes to npm — which stays
inert until an `NPM_TOKEN` secret is configured, so versioning and changelogs are
correct whether or not the packages are being published yet.

## License

MIT — see [LICENSE](LICENSE).
