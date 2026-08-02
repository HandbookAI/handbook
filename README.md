# Handbook

**English** | [中文](README.zh-CN.md)

Turn any codebase into a navigable **handbook** — then use that handbook to help a code
agent find *every* place a change needs to touch, and keep the handbook current as the
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
needs a key. Supported languages: Python, TypeScript, Go, Rust, Shell — detected and
merged automatically with `--lang auto`.

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

# 7. After the change lands, roll the handbook forward:
handbook resync --case cases/upload-retry --work work/myrepo
```

Key `generate` flags: `--strategy file|member` (file = auto skeleton, file-as-leaf;
member = you author `skeleton.yaml`, functions are classified individually),
`--detail brief|deep`, `--synth-mode oneshot|doctor` (doctor = actor–critic repair loop),
`--narrate-lang en|zh`, `--phase all|1|2|2a|2b|2c|3|comma-list`, `--resume`.

## How generation works

| Phase | What happens | LLM |
|---|---|---|
| 1 | Language adapters (tree-sitter, WASM) parse every file into a typed call graph: functions, methods, resolved call edges (`self`/attribute/parameter/import), boundary calls, unresolved calls quarantined into `dropped-calls.json`. | no |
| 2a | Every file gets a **card**: purpose, role, lifecycle — and in deep mode a 120–300-word walkthrough plus per-function purpose / data flow / relations merged onto graph facts. Batched, three-tier degradation, crash-safe, resumable. | yes |
| 2b | A stage **skeleton** (the narrative spine, ordered by execution lifecycle) is synthesized from directory rollups + entry points, then every file is assigned to exactly one stage. `--synth-mode doctor` runs an actor–critic repair loop (engineer / architect / reader critics) until nothing is unassigned and no structural change survives review. | yes |
| 2c | Each stage's files are ordered by call-graph topology and grouped into 2–8 titled sub-groups; every failure degrades to a deterministic flat order — files are never dropped. | yes |
| 3 | Bottom-up narration: stage overviews (children before parents), a system overview, and cross-stage **state registers** extracted with a loop-until-dry gap pass. Everything is content-hash cached. | yes |

Every artifact is schema-validated JSON/YAML under the work dir; any phase can be re-run
independently and a crashed run resumes where it stopped.

## Monorepo layout

| Package | Role |
|---|---|
| [`@handbook/core`](packages/core/README.md) | Data model (call-graph IR + handbook model), zod schemas, dependency-free utilities |
| [`@handbook/analyzer`](packages/analyzer/README.md) | Multi-language static call-graph extraction (tree-sitter WASM) — no LLM |
| [`@handbook/llm`](packages/llm/README.md) | OpenAI-compatible chat client + actor–critic orchestration + offline mock |
| [`@handbook/pipeline`](packages/pipeline/README.md) | The generation pipeline (phases 1–3, file & member strategies) |
| [`@handbook/renderer`](packages/renderer/README.md) | Markdown pages, agent locator index, self-contained HTML site — no LLM |
| [`@handbook/skill`](packages/skill/README.md) | SKILL packaging + validation + coverage drift detection — no LLM |
| [`@handbook/planner`](packages/planner/README.md) | Handbook-guided read-only planning agent |
| [`@handbook/resync`](packages/resync/README.md) | Incremental handbook roll-forward after code changes |
| [`@handbook/cli`](packages/cli/README.md) | The `handbook` command |

Dependency direction is strictly one-way (`cli → pipeline/renderer/skill/planner/resync →
analyzer/llm → core`); LLM-touching code and deterministic code are separated by package
boundary, so the analyzer, renderer and skill packages are reusable with no LLM at all.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layering, data flow, design decisions
- [docs/formats.md](docs/formats.md) — every artifact schema (graph, cards, skeleton, …)
- [docs/prompts.md](docs/prompts.md) — the complete prompt catalogue
- [examples/](examples/) — offline end-to-end demo (mock LLM server included)
- Per-package READMEs under [packages/](packages/)

## Development

```bash
pnpm build          # tsc -b (composite project references)
pnpm test           # build + vitest (150+ tests, all offline)
pnpm lint           # eslint
pnpm format         # prettier
```

Testing philosophy: everything runs offline. LLM-dependent flows are tested against
`MockChatClient` (scripted rules) and the bundled mock HTTP endpoint; deterministic
packages are tested directly. No test ever needs an API key.

## License

MIT — see [LICENSE](LICENSE).
