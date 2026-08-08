# @handbook/cli

**English** · [中文](README.zh-CN.md)

> The `handbook` command. Eleven subcommands, one configuration model, and a `config`
> command that tells you exactly where every value came from.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fcli-6366f1?style=flat-square)](https://www.npmjs.com/package/@handbook/cli)

---

## Install

```bash
npm i -g @handbook/cli
handbook --help
```

Or, from a clone of the monorepo:

```bash
pnpm install && pnpm build
alias handbook="node $(pwd)/packages/cli/dist/main.js"
```

Or use the pnpm shortcuts, which build first and forward flags straight through:

```bash
pnpm analyze --source ~/code/proj --work work/proj
pnpm handbook --help
```

---

## The eleven subcommands

| Command    | What it does                                             | LLM? |
| ---------- | -------------------------------------------------------- | :--: |
| `analyze`  | Phase 1 only — build the static call graph               |  ❌  |
| `generate` | The full pipeline (phases 1, 2a, 2b, 2c, 3)              |  ✅  |
| `render`   | Work dir → markdown / HTML site / agent index / llms.txt |  ❌  |
| `skill`    | Rendered handbook → agent SKILL package                  |  ❌  |
| `validate` | Check a SKILL package's structure and freshness          |  ❌  |
| `plan`     | Handbook-guided change localization → an edit plan       |  ✅  |
| `apply`    | Apply a plan's EDIT blocks byte-exactly, with backups    |  ❌  |
| `rollback` | Restore a source tree from a patch backup                |  ❌  |
| `resync`   | Roll a handbook forward after a code change              |  ✅  |
| `studio`   | Launch the local web UI                                  |  ✅  |
| `config`   | Print the resolved configuration and its provenance      |  ❌  |

Every subcommand supports `--help`, and that help is **generated from the config
registry** — so each flag is listed with its environment variable, its scoped
per-command variable, and its default:

```
--read-workers <n>   concurrent card batches
                     [env: HANDBOOK_READ_WORKERS, or scoped: HANDBOOK_GENERATE_READ_WORKERS]
                     (default: 12)
```

---

## Global flags

| Flag                | Effect                                                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v, --verbose`     | Debug logging (shorthand for `--log-level debug`)                                                                                                                                                                                                                                                                 |
| `-q, --quiet`       | Errors only (wins over `-v`)                                                                                                                                                                                                                                                                                      |
| `--env <name>`      | Select an environment — loads `.env.<name>.local` and `.env.<name>` ahead of `.env.local` and `.env`, and prefers `handbook.config.<name>.yaml`                                                                                                                                                                   |
| `--env-file <path>` | Load exactly this file, bypassing the `.env` cascade. A missing file is a loud error, not a fallback. **Prefer `HANDBOOK_ENV_FILE`**: Node >= 20.6 owns `--env-file` too and pre-scans for it, so a missing path dies as `node: <path>: not found` (exit 9) before this CLI runs. The flag wins when both are set |
| `--config <path>`   | Use this config file instead of discovering the nearest `handbook.config.yaml`                                                                                                                                                                                                                                    |

---

## Configuration, in one picture

```
CLI flag  >  shell env  >  .env cascade  >  handbook.config.yaml  >  registry default
```

Every setting is declared once in `@handbook/core`'s registry. The flags you see, the
environment variables that work, the YAML keys that are accepted, `.env.example`,
`handbook.config.example.yaml` and `docs/configuration.md` are **all generated from that
one table**. They cannot drift apart, because a drift test compares them byte for byte.

### Order of operations, and why it matters

```
1. read --env / HANDBOOK_ENV                    ← everything below depends on it
2. apply the .env cascade into process.env      ← so HANDBOOK_* is visible to step 3
3. discover and load the config file            ← AFTER env: it ranks below it
4. resolve THIS command's settings              ← flags > env > file > default
```

The config file is loaded _after_ the env files on purpose: it sits below the environment
in precedence, so `HANDBOOK_*` values from a `.env` must already be in `process.env`
before anything reads them — and loading the file later cannot, and must not, override
what the env supplied.

Two consequences worth knowing:

- **No commander defaults are ever set.** An eagerly-evaluated default captures the shell
  value at module load, _before_ the hook applies `--env-file` — which silently ignores
  the file. Defaults come from the registry, at action time.
- **Nothing is marked "mandatory" by commander.** `--source` and `--work` can come from
  env or the config file, so required-ness is enforced by the resolver _after_ every layer
  has been consulted. The error then names every way you could supply it:

  ```
  invalid configuration:
    - source is required: pass --source, set HANDBOOK_GENERATE_SOURCE,
      or add it to handbook.config.yaml
  ```

---

## `handbook config` — the debugging tool

```bash
handbook config                        # every setting, its value, and its source
handbook config --command generate     # scoped to one subcommand
handbook config --json                 # machine-readable
handbook config --check                # validate only; exit 2 if anything is wrong
```

It prints the active environment, every `.env` file the cascade actually loaded, the
config file it resolved, and then one row per setting with its provenance
(`flag` / `env` / `file` / `default`). Without that, a cascade of up to eight possible
sources is unauditable.

It deliberately uses the plain resolver rather than the throwing one: **this command's job
is to show configuration, including when it is broken.** A missing `--source` renders as a
visible `— unset (required)` row instead of taking down the one tool you would use to
debug that exact problem.

Secrets are masked. `--check` is the one to put in CI.

---

## Examples

```bash
# free smoke test
handbook analyze --source ~/code/api --work work/api

# cheap first pass, then deepen only the cards
handbook generate --source ~/code/api --work work/api
handbook generate --source ~/code/api --work work/api --phase 2a --detail deep --resume

# everything, in Chinese, with the actor-critic skeleton loop
handbook generate --source ~/code/api --work work/api \
  --detail deep --synth-mode doctor --narrate-lang zh --llm-cache

# render every format
handbook render --work work/api --title "API Handbook" \
  --html --html-single --agent-site --llms-txt \
  --source-base-url https://github.com/me/api/blob/main

# package + validate
handbook skill --handbook work/api/handbook --out skills/api --name api \
  --work work/api --source ~/code/api --agent-dir work/api/handbook/agent
handbook validate --skill skills/api --source ~/code/api

# plan → dry-run → apply → rollback
handbook plan --source ~/code/api --handbook skills/api/references \
  --request "Add a --json flag to the export command" --out plan.md
handbook apply --source ~/code/api --plan plan.md --dry-run
handbook apply --source ~/code/api --plan plan.md
handbook rollback --backup ~/code/api/.handbook-patches/<stamp>

# keep the handbook current
handbook resync --case cases/export-json --work work/api

# per-environment config
handbook generate --env prod --source ~/code/api --work work/api
handbook config --env prod --command generate
```

---

## Exit codes

| Code | Meaning                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success                                                                                                                          |
| `1`  | An error — invalid configuration, a missing artifact, a failed run (message on stderr, prefixed `handbook: error:`)              |
| `2`  | A **check** failed: `validate` found problems, `apply` did not fully land, or `config --check` found an invalid or missing value |

The distinction matters in scripts: `2` means "the tool worked and the answer is no".

---

## Output

Every command writes its result to **stdout as JSON**, and logs to **stderr**. So this
works exactly as you would hope:

```bash
handbook analyze --source ~/code/api --work work/api | jq .functions
handbook config --json | jq '.settings[] | select(.source.kind == "env")'
```

---

## Notes

- `handbook studio` runs until `Ctrl-C`.
- `handbook plan` writes to stdout when `--out` is omitted, so you can pipe it.
- `handbook apply` always prints the backup directory — copy it before you need it.
- `handbook skill --work <dir>` adds `coverage.json` only when a phase-2 assignment exists;
  a work dir without one simply contributes nothing, rather than failing the build.

---

Part of [Handbook](../../README.md) ·
[Configuration reference](../../docs/content/docs/reference/configuration.md) · MIT
