# `.claude/` — the shared agent configuration

This directory is **committed on purpose**. It encodes the invariants of this repo —
which files are generated, what the gate is, why the analyzer never guesses — so that a
coding agent does not have to rediscover them, and does not have to be told twice.

Nothing here carries personal state. `settings.local.json` (your permission mode, your
model choice) stays gitignored.

## What is in here

```
settings.json     permissions, environment, and the four hooks below
hooks/            small POSIX shell scripts; each says in its header WHY it exists
agents/           subagents for the three jobs that need real specialism
skills/           slash commands: /gate /ship /self-handbook /diagnose-run /offline-e2e
rules/            path-scoped rules, loaded when you touch the matching files
```

## The hooks

| Event                      | Script                 | What it does                                                                                                                                                                |
| -------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`             | `session-brief.sh`     | Prints the branch, dirty-file count, which packages have a stale `dist` (asked of `tsc -b --dry`, not guessed from mtimes), and the five invariants worth not rediscovering |
| `PreToolUse` (Edit/Write)  | `protect-generated.sh` | **Blocks** writes to the three generated config surfaces, to `dist/`, to `docs/public/diagrams/` and to the lockfile — and names the right thing to change instead          |
| `PostToolUse` (Edit/Write) | `format-touched.sh`    | Runs prettier and `eslint --fix` on just the file that changed, so `pnpm check` stays about real problems                                                                   |
| `Stop`                     | `gate-reminder.sh`     | If source changed and `pnpm check` has not run since, says so once. Never blocks                                                                                            |

All four are ordinary shell scripts you can run by hand:

```bash
echo '{"tool_input":{"file_path":".env.example"}}' | .claude/hooks/protect-generated.sh; echo $?   # → 2
CLAUDE_PROJECT_DIR=$PWD .claude/hooks/session-brief.sh
```

## The subagents

| Agent               | Use it for                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `adapter-author`    | Adding or debugging a tree-sitter language adapter                             |
| `pipeline-debugger` | Working out which generation phase produced a bad handbook, from the artifacts |
| `config-surgeon`    | Adding or changing a setting so all four generated surfaces stay in step       |

## The skills

| Command                    | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `/gate`                    | Runs `pnpm check` and interprets each class of failure           |
| `/self-handbook`           | Runs the whole toolchain on this repo, offline, for free         |
| `/diagnose-run <work-dir>` | Reads a work directory and reports what the run actually did     |
| `/offline-e2e`             | Drives every CLI command end to end against the bundled mock LLM |

## Permissions

`settings.json` pre-allows the read-only and build commands you run constantly
(`pnpm check`, `pnpm test`, `git status`, `jq`, `rg`) so they stop prompting; **denies**
reading any `.env`, pushing, publishing and raw network fetches; and **asks** before
committing or touching Docker.

`defaultMode` is deliberately not set here — that is a personal choice and belongs in
`settings.local.json`.

## Other agents

Equivalent configurations for other tools live at
[`.codex/`](../.codex/README.md) and [`.cursor/`](../.cursor/README.md). All three
describe the same repository, so they say the same things; only the format differs.
