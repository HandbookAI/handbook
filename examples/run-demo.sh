#!/usr/bin/env bash
# End-to-end offline demo: analyze → generate → render → skill → validate,
# entirely against the bundled mock LLM server (no API key needed).
#
# Usage: bash examples/run-demo.sh [work-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="$ROOT/examples/demo-project"
WORK="${1:-$ROOT/examples/work/demo}"
PORT=8090

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

echo "== 1. analyze (no LLM) =="
$CLI analyze --source "$DEMO" --work "$WORK"

echo "== 2. generate (phases 2+3 against the mock) =="
$CLI generate --source "$DEMO" --work "$WORK" --phase 2,3 --detail deep --narrate-lang en

echo "== 3. render markdown + HTML site + agent index =="
$CLI render --work "$WORK" --title "Demo Task Runner Handbook" --html --html-single --agent-site

echo "== 4. package as an agent SKILL =="
$CLI skill --handbook "$WORK/handbook" --out "$WORK/skill" --name demo-task-runner \
  --project "Demo Task Runner" --work "$WORK" --source "$DEMO"

echo "== 5. validate the SKILL =="
$CLI validate --skill "$WORK/skill" --source "$DEMO"

echo
echo "Done. Open these:"
echo "  $WORK/handbook/overview.md"
echo "  $WORK/handbook/html/overview.html"
echo "  $WORK/handbook/handbook.html"
echo "  $WORK/skill/SKILL.md"
