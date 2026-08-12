#!/usr/bin/env bash
# Generate THIS monorepo's own handbook (analyzes packages/).
#
# Default: offline against the bundled mock LLM — structure is real (stages per
# package, call facts), prose is placeholder text.
# --real:  skip the mock and use YOUR endpoint — configured via ./.env at the
#          repo root (auto-loaded; see .env.example) or shell OPENAI_* vars.
#
# Usage: bash examples/run-self.sh [--real] [work-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/packages"

REAL=0
if [ "${1:-}" = "--real" ]; then REAL=1; shift; fi
WORK="${1:-$ROOT/examples/work/self}"
PORT=8091

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

echo "== 1. analyze this monorepo's TypeScript sources =="
hb analyze --source "$SOURCE" --work "$WORK" --lang typescript

echo "== 2. generate =="
hb generate --source "$SOURCE" --work "$WORK" --phase 2,3 --narrate-lang "${NARRATE_LANG:-en}"

echo "== 3. render =="
hb render --work "$WORK" --title "Handbooks Monorepo — Self Handbook" --html --html-single --agent-site

echo
echo "Done. Open these:"
echo "  $WORK/handbook/html/overview.html"
echo "  $WORK/handbook/handbook.html"
