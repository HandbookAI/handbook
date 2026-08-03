# @handbook/cli

The `handbook` command-line interface — the single entry point that wires every other package into one toolchain: analyze a codebase into a call graph, generate the handbook, render it for humans and agents, package it as a skill, validate that skill, plan changes with it, and resync it after the code moves. It contains no domain logic of its own; each subcommand is a thin adapter from flags to one package's API, printing JSON results to stdout and logs to stderr.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Define the ten subcommands (`analyze`, `generate`, `render`, `skill`, `validate`, `plan`, `apply`, `rollback`, `resync`, `studio`) and map their flags onto the underlying package APIs.
- Construct shared infrastructure per invocation: the leveled logger (`-v`/`-q`) and the `OpenAiChatClient` from environment variables for LLM-needing commands.
- Load `./.env` (or `--env-file`) before every subcommand action; shell environment variables always win.
- Resolve all path flags to absolute paths and print machine-readable JSON results.
- Set exit codes (`validate` exits 2 on failure; any error exits 1 with a one-line message).
- Does NOT implement any pipeline, rendering, planning, or resync logic — that all lives in the other `@handbook/*` packages.
- Does NOT export a programmatic API — `src/index.ts` is intentionally empty; consume the underlying packages directly instead.

## Public API

None. The package's product is the `handbook` binary (`bin: { "handbook": "./dist/main.js" }`); `src/index.ts` exports nothing. Global flags: `-v, --verbose` (debug logging), `-q, --quiet` (errors only), `--env-file <path>`. LLM-backed commands (`generate` beyond phase 1, `plan`, `resync` without `--no-llm`) read `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_MAX_TOKENS`, `OPENAI_TIMEOUT` (seconds, default 300) and `OPENAI_EXTRA_BODY` (JSON, vendor fields) — all with `HANDBOOK_LLM_*` fallbacks.

## Usage

```sh
# 1. analyze — static call graph only, no LLM
handbook analyze --source ./project --work ./work --lang auto

# 2. generate — the full pipeline (phases 1/2a/2b/2c/3)
export OPENAI_API_KEY=... OPENAI_MODEL=gpt-4o-mini
handbook generate --source ./project --work ./work \
  --phase all --strategy file --detail deep --synth-mode doctor \
  --narrate-lang en --resume --refresh
# member strategy with an authored skeleton:
handbook generate --source ./project --work ./work --strategy member --skeleton ./skeleton.yaml

# 3. render — work dir to markdown (+ optional HTML / agent site), no LLM
handbook render --work ./work --out ./out --title "My Project Handbook" \
  --html --html-single --agent-site

# 4. skill — package the rendered handbook as an agent SKILL, no LLM
handbook skill --handbook ./out --out ./skills/myproject --name myproject \
  --project MyProject --work ./work --source ./project

# 5. validate — check a SKILL package structure + coverage freshness, no LLM
handbook validate --skill ./skills/myproject --source ./project

# 6. plan — handbook-guided change localization (read-only agent)
handbook plan --source ./project --handbook ./skills/myproject/references \
  --request "Add a --json flag to the export command" --max-turns 30 --out plan.md

# 7. apply — write a plan's EDIT blocks into the tree (verify first)
handbook apply --source ./project --plan plan.md --dry-run
handbook apply --source ./project --plan plan.md

# 8. rollback — restore the exact pre-patch bytes
handbook rollback --backup ./project/.handbook-patches/2026-08-03T…
handbook rollback --backup … --force   # override the post-patch-edit guard

# 9. resync — roll the handbook forward after a code change
handbook resync --case ./case --work ./work --detail deep
handbook resync --case ./case --work ./work --no-llm   # structural refresh only

# 10. studio — the local web UI (127.0.0.1 only)
handbook studio --port 4860 --state-dir ~/.handbook-studio
```

Key flags per command:
- `analyze`: `--source`, `--work` (required); `--lang auto|python|typescript|go|rust|shell`.
- `generate`: `--source`, `--work` (required); `--phase all|1|2|2a|2b|2c|3|<comma list>`, `--strategy file|member`, `--skeleton <path>`, `--detail brief|deep`, `--synth-mode oneshot|doctor`, `--max-doctor-rounds <n>`, `--narrate-lang en|zh`, `--read-workers <n>`, `--resume`, `--refresh`.
- `render`: `--work` (required); `--out`, `--title`, `--html`, `--html-single`, `--agent-site`.
- `skill`: `--handbook`, `--out`, `--name` (required); `--project`, `--work` (adds coverage.json), `--source` (adds content hashes).
- `validate`: `--skill` (required); `--source` (enables hash freshness checks).
- `plan`: `--source`, `--request` (required); `--handbook`, `--out`, `--max-turns <n>`.
- `apply`: `--source`, `--plan` (required); `--dry-run`, `--backup-root <dir>`.
- `rollback`: `--backup` (required); `--source`, `--force`.
- `resync`: `--case`, `--work` (required); `--no-llm`, `--detail brief|deep`, `--narrate-lang en|zh`.
- `studio`: `--port <n>`, `--state-dir <dir>`.

## Design notes

- Strict stdout/stderr split: results are JSON on stdout, logs go to stderr via the core logger, so every command is pipeline-friendly (`handbook analyze ... | jq .functions`).
- The LLM client is built lazily and only for commands that need it — `analyze`, `render`, `skill`, and `validate` run with no API key at all, and `generate --phase 1` skips client construction entirely.
- `--no-llm` on `resync` maps through commander's negated-flag convention (`opts.llm === false`), selecting the structural-only refresh path with stale-marked prose.
- Errors are funneled through one `parseAsync().catch` handler that prints a single `handbook: error: …` line and exits 1 — no stack traces in normal operation.

## Dependencies

Internal:
- `@handbook/core` — logger creation, log-level types, `.env` parsing.
- `@handbook/llm` — `OpenAiChatClient` for LLM-backed commands.
- `@handbook/pipeline` — `runPhase1`, `generateHandbook`, `loadHandbookModel`, `WorkDir`.
- `@handbook/renderer` — the four render functions behind `render`.
- `@handbook/skill` — `buildSkill` / `validateSkill`.
- `@handbook/planner` — `runPlanner` behind `plan`.
- `@handbook/patcher` — `applyPlan` / `rollback` / `listBackups` behind `apply` and `rollback`.
- `@handbook/resync` — `resyncHandbook` behind `resync`.
- `@handbook/studio` — `startStudio` behind `studio`.
- `@handbook/analyzer` — pulled in for the analysis stack (used via the pipeline).

External:
- `commander` — declarative subcommand/flag parsing and help text.
