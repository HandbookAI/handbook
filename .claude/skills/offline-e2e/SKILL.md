---
name: offline-e2e
description: Exercise every CLI command end to end offline — analyze, generate, render, skill, validate, plan, apply, rollback, resync, config — using the bundled mock LLM. Use to verify a change did not break the command surface, or before a release.
allowed-tools: Bash Read
---

# Full offline command sweep

Every command in this toolchain can be driven with **no API key and no network**, by
pointing it at the bundled mock LLM. This is the check that catches a broken flag, a
broken exit code or a broken artifact contract — things unit tests do not see because
they never go through `main.ts`.

## Setup

```bash
pnpm build
node examples/mock-llm-server.mjs 8099 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
export OPENAI_BASE_URL=http://127.0.0.1:8099/v1
export OPENAI_API_KEY=EMPTY

HB="node packages/cli/dist/main.js"
SRC=examples/demo-project
W=$(mktemp -d)/work
```

## The sweep

```bash
# help surfaces — every command must have one
$HB --help
for c in analyze generate render skill validate plan apply rollback resync studio config; do
  $HB "$c" --help > /dev/null || echo "FAIL: $c --help"
done

# config, including the deliberately-broken case
$HB config --command generate
$HB config --json | jq -e '.settings | length > 0'
$HB config --check --command render     # exits 2 when --work is unset — that is correct

# the no-LLM half
$HB analyze --source "$SRC" --work "$W"
$HB generate --source "$SRC" --work "$W" --phase 2,3 --detail deep
$HB render --work "$W" --title "Sweep" --html --html-single --agent-site --llms-txt
$HB skill --handbook "$W/handbook" --out "$W/skill" --name sweep \
          --work "$W" --source "$SRC" --agent-dir "$W/handbook/agent"
$HB validate --skill "$W/skill" --source "$SRC"

# plan → dry-run → apply → rollback, on a COPY
cp -R "$SRC" "$W/edit-me"
$HB plan --source "$W/edit-me" --handbook "$W/skill/references" \
         --request "Add a docstring to the queue module" --out "$W/plan.md" || echo "(planner declined — that is a legal outcome)"
if [ -s "$W/plan.md" ]; then
  $HB apply --source "$W/edit-me" --plan "$W/plan.md" --dry-run
fi

# resync
mkdir -p "$W/case" && cp -R "$SRC" "$W/case/edited"
$HB resync --case "$W/case" --work "$W" --no-llm
```

## What to check, beyond "it did not crash"

| Check                                                        | Why                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `analyze` file count matches the fixture                     | A silent scan regression is invisible otherwise                 |
| `_coverage.json` `nDescribed == nFiles`                      | The mock always answers, so any miss is a real parsing bug      |
| `validate` exits `0`                                         | The SKILL contract holds                                        |
| `config --check` on an incomplete command exits `2`, not `1` | `2` means "the answer is no"; scripts depend on the distinction |
| `apply --dry-run` writes **nothing**                         | `git status` in the copy must be clean                          |
| `resync --no-llm` marks prose stale                          | Cards should carry the stale suffix                             |

## Report

A table of command → exit code → one-line result, and the full output of anything that
failed. Do not summarize a failure — paste it.
