#!/usr/bin/env bash
# SessionStart — hand Claude the three facts it would otherwise spend three tool
# calls discovering, and that it is most likely to get wrong by assuming.
#
# stdout on exit 0 becomes context Claude can see.
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$ROOT" 2>/dev/null || exit 0

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git repo)')"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
HEAD_LINE="$(git log --oneline -1 2>/dev/null || echo '(no commits)')"

# Ask tsc itself rather than comparing mtimes. `--dry` reports what a real build
# would do without doing it, and it distinguishes "would build" (source actually
# changed) from "would update timestamps" (a file was touched but its output is
# already correct) — a distinction an mtime comparison cannot make, and which is
# why the obvious version of this check cried wolf on every `touch`.
STALE="$(pnpm exec tsc -b --dry 2>/dev/null \
  | sed -n 's|.*would build project .*/packages/\([^/]*\)/tsconfig.json.*|\1|p' \
  | paste -sd ', ' -)"
if [ -z "$STALE" ]; then
  STALE='no'
else
  STALE="$STALE — run \`pnpm build\`"
fi

cat <<BRIEF
## Repo state

- branch: $BRANCH  ·  uncommitted files: $DIRTY
- HEAD: $HEAD_LINE
- dist stale: $STALE

## Invariants worth not rediscovering

- \`.env.example\`, \`handbook.config.example.yaml\` and
  \`docs/content/docs/reference/configuration.md\` are GENERATED from
  \`packages/core/src/config/registry.ts\`. Change the registry, then run
  \`pnpm run config:docs\`. A hook blocks hand-edits to all three.
- Third-party versions live only in \`pnpm-workspace.yaml\`'s catalog. A literal
  range in any manifest fails \`pnpm check:workspace\`.
- \`docs/\` is a separate Next.js app with its own \`pnpm-workspace.yaml\`. A root
  \`pnpm install\` ignores it, and the root eslint config ignores it too.
- Every test runs offline against \`MockChatClient\`. No test needs an API key.
- The gate is \`pnpm check\`. Run it before claiming anything is done.
BRIEF

exit 0
