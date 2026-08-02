#!/usr/bin/env bash
# Generate THIS monorepo's own handbook, offline, against the bundled mock LLM.
#
# The structure you get (stages per package, file assignment, per-function call
# facts, HTML site) is real and derived from the actual source; the PROSE is
# placeholder text from the mock. Point OPENAI_* at a real endpoint and re-run
# `generate` for genuine narration.
#
# Usage: bash examples/run-self.sh [work-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/packages"
WORK="${1:-$ROOT/examples/work/self}"
PORT=8091

CLI="node $ROOT/packages/cli/dist/main.js"

echo "== build =="
(cd "$ROOT" && npx tsc -b)

echo "== start mock LLM =="
node "$ROOT/examples/mock-llm-server.mjs" "$PORT" &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 0.5

export OPENAI_BASE_URL="http://127.0.0.1:$PORT/v1"
export OPENAI_API_KEY=EMPTY

echo "== 1. analyze this monorepo's TypeScript sources =="
$CLI analyze --source "$SOURCE" --work "$WORK" --lang typescript

echo "== 2. generate (structure real, prose mocked) =="
$CLI generate --source "$SOURCE" --work "$WORK" --phase 2,3

echo "== 3. render =="
$CLI render --work "$WORK" --title "Handbook Monorepo — Self Handbook" --html --html-single --agent-site

echo
echo "Done. Open these:"
echo "  $WORK/handbook/html/overview.html"
echo "  $WORK/handbook/handbook.html"
