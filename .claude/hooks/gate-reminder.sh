#!/usr/bin/env bash
# Stop — if source changed this session and the gate has not been run since,
# say so once, as a note rather than a block.
#
# Claiming "done" on an unverified change is the single most expensive mistake
# available here: `pnpm check` also runs the drift tests, the workspace
# invariants and the per-package coverage floors, none of which a passing
# `tsc -b` implies.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 0

CHANGED="$(git status --porcelain -- 'packages/*/src' 'scripts' 'package.json' 'pnpm-workspace.yaml' 2>/dev/null | wc -l | tr -d ' ')"
[ "$CHANGED" -gt 0 ] || exit 0

# A marker newer than every changed source file means the gate already ran.
STAMP=".claude/.last-gate"
if [ -f "$STAMP" ] && [ -z "$(find packages/*/src scripts -newer "$STAMP" -name '*.ts' -o -newer "$STAMP" -name '*.mjs' 2>/dev/null | head -1)" ]; then
  exit 0
fi

node -e '
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "Source changed and `pnpm check` has not run since. It is the gate that " +
        "catches drift tests, workspace invariants and coverage floors — none of " +
        "which a green `tsc -b` implies.",
    }),
  );
'
exit 0
