# `.codex/` — Codex configuration for this repo

Project-scoped configuration for the [Codex CLI](https://developers.openai.com/codex),
committed so every contributor gets the same guard rails.

Codex loads `.codex/config.toml` **only when the project is trusted**, and a
project-scoped config can never override machine-local provider, auth or telemetry
settings — so nothing here can change where your requests go.

## What is configured, and why

| Setting                                  | Value                          | Why                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_mode`                           | `workspace-write`              | Everything this repo asks of an agent is editing files and running `pnpm check`. Nothing needs more.                                                                                            |
| `approval_policy`                        | `on-request`                   | The destructive commands here are `git push` and `pnpm publish`, both rare and both worth a prompt.                                                                                             |
| `sandbox_workspace_write.network_access` | `false`                        | Every test runs offline against `MockChatClient`; `pnpm demo` uses a mock LLM on `127.0.0.1`. The only thing that genuinely needs the network is `pnpm install`, which you should run yourself. |
| `model_reasoning_effort`                 | `high`                         | The load-bearing work here is invariants and refusals, not boilerplate.                                                                                                                         |
| `project_doc_max_bytes`                  | `65536`                        | `AGENTS.md` is long because this repo has a lot of load-bearing invariants; the default cap truncates it partway through the ones that matter.                                                  |
| `project_doc_fallback_filenames`         | `CLAUDE.md`, `CONTRIBUTING.md` | So the instructions are found even if `AGENTS.md` moves.                                                                                                                                        |

`model` is deliberately **not** pinned: the work ranges from a one-line registry edit to
writing a tree-sitter adapter. Pick per session with `codex --model`.

## Hooks

| Event         | Script                       | What it does                                                                                                                                                    |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUse`  | `hooks/protect-generated.sh` | **Blocks** writes to the three generated config surfaces, to `dist/`, to `docs/public/diagrams/` and to the lockfile — naming the right thing to change instead |
| `PostToolUse` | `hooks/format-touched.sh`    | Runs prettier and `eslint --fix` on the files that just changed                                                                                                 |

Both are plain shell scripts, and both are written to survive a payload-shape change:
the guard extracts the **target path** from the payload rather than grepping the whole
thing, so editing a README that merely _mentions_ `.env.example` is not blocked.

Run them by hand:

```bash
echo '{"tool_input":{"file_path":".env.example"}}' | .codex/hooks/protect-generated.sh; echo $?   # → 2
echo '{"tool_input":{"file_path":"README.md","content":"see .env.example"}}' | .codex/hooks/protect-generated.sh; echo $?   # → 0
```

## Prompts

`prompts/` holds three reusable prompts. Codex reads custom prompts from
`$CODEX_HOME/prompts/`, so link or copy them in:

```bash
mkdir -p ~/.codex/prompts
ln -sf "$PWD"/.codex/prompts/*.md ~/.codex/prompts/
```

| Prompt            | What it does                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `gate.md`         | Runs `pnpm check` and interprets each class of failure               |
| `offline-demo.md` | Runs the whole toolchain offline, for free, and says what to inspect |
| `diagnose-run.md` | Reads a work directory and reports what a run actually did           |

## The instructions themselves

Codex reads [`AGENTS.md`](../AGENTS.md) at the repo root. That file is the tool-agnostic
version of the same guidance in [`CLAUDE.md`](../CLAUDE.md) and
[`.cursor/rules/`](../.cursor/README.md).
