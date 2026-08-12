---
'@handbooks/llm': minor
'@handbooks/core': minor
'@handbooks/cli': minor
'@handbooks/pipeline': minor
'@handbooks/studio': minor
'@handbooks/analyzer': patch
'@handbooks/patcher': patch
'@handbooks/planner': patch
'@handbooks/renderer': patch
'@handbooks/resync': patch
'@handbooks/skill': patch
---

Configuration is declared once and derived everywhere. A registry in
`@handbooks/core` is the single source for every setting, and the CLI options, the
environment variables, `handbook.config.yaml`, `.env.example` and
`docs/configuration.md` are all generated or resolved from it. Precedence is
flag > shell env > .env > config file > default, and every resolved value carries
its source.

Before this, exactly one of ~45 flags (`--title`) could also be set from the
environment. Now all of them can, and eight LLM endpoint flags exist that did not
(`--model`, `--base-url`, `--max-tokens`, `--timeout`, `--llm-retries`,
`--llm-retry-backoff`, `--llm-concurrency`, `--extra-body`), along with six
pipeline tuning knobs that were reachable from neither a flag nor an env var
(`--read-batch-size`, `--max-chars-per-file`, `--assign-batch-size`,
`--assign-workers`, `--organize-workers`, `--narrate-workers`).

`handbook config` prints every setting, its value and where that value came from,
with secrets masked. `--check` validates and exits non-zero.

Studio's bind address is configurable (`--host`, default `127.0.0.1`) and the
repo ships a container image. The Host-header CSRF guard is unchanged: binding
wide does not widen who may talk to it.

BREAKING: an invalid `OPENAI_*` / `HANDBOOK_*` value now fails loudly instead of
falling back to a default. `OPENAI_MAX_TOKENS=lots` used to run at 16000 in
silence; it now names the variable and exits non-zero.
