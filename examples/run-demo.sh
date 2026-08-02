#!/usr/bin/env bash
# End-to-end demo on the bundled fixture repo (examples/demo-project):
# analyze → generate → render → skill → validate.
#
# Default: fully offline against the bundled mock LLM (no key needed).
# --real:  skip the mock and use YOUR endpoint — configured via ./.env at the
#          repo root (auto-loaded; see .env.example) or shell OPENAI_* vars.
#
# Usage: bash examples/run-demo.sh [--real] [work-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/examples/demo-project"

REAL=0
if [ "${1:-}" = "--real" ]; then REAL=1; shift; fi
WORK="${1:-$ROOT/examples/work/demo}"
PORT=8090

CLI="node $ROOT/packages/cli/dist/main.js"
ENV_FILE=""
hb() { $CLI ${ENV_FILE:+--env-file "$ENV_FILE"} "$@"; }

echo "== build =="
(cd "$ROOT" && npx tsc -b)

if [ "$REAL" -eq 1 ]; then
  echo "== using YOUR endpoint (from $ROOT/.env or shell OPENAI_*) =="
  if [ -f "$ROOT/.env" ]; then ENV_FILE="$ROOT/.env"; fi
else
  echo "== start mock LLM (offline; prose will be placeholder text) =="
  node "$ROOT/examples/mock-llm-server.mjs" "$PORT" &
  MOCK_PID=$!
  trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
  sleep 0.5
  export OPENAI_BASE_URL="http://127.0.0.1:$PORT/v1"
  export OPENAI_API_KEY=EMPTY
fi

echo "== 1. analyze (no LLM) =="
hb analyze --source "$DEMO" --work "$WORK"

echo "== 2. generate (phases 2+3) =="
hb generate --source "$DEMO" --work "$WORK" --phase 2,3 --detail deep --narrate-lang "${NARRATE_LANG:-en}"

echo "== 3. render markdown + HTML site + agent index =="
hb render --work "$WORK" --title "Demo Task Runner Handbook" --html --html-single --agent-site

echo "== 4. package as an agent SKILL =="
hb skill --handbook "$WORK/handbook" --out "$WORK/skill" --name demo-task-runner \
  --project "Demo Task Runner" --work "$WORK" --source "$DEMO"

echo "== 5. validate the SKILL =="
hb validate --skill "$WORK/skill" --source "$DEMO"

echo
echo "Done. Open these:"
echo "  $WORK/handbook/overview.md"
echo "  $WORK/handbook/html/overview.html"
echo "  $WORK/handbook/handbook.html"
echo "  $WORK/skill/SKILL.md"
