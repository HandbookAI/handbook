#!/usr/bin/env bash
# Format the files that just changed, so `pnpm check` fails on real problems
# rather than on whitespace. Never blocks: a formatter that cannot run should
# report, not abort the work.
set -uo pipefail

PAYLOAD="$(cat)"

# Pull every plausible repo path out of the payload, then keep the ones that
# exist and are ours to format.
FILES="$(printf '%s' "$PAYLOAD" \
  | grep -oE '[A-Za-z0-9_./-]+\.(ts|tsx|mjs|cjs|js|json|md|mdx|ya?ml)' \
  | sort -u)"

[ -n "$FILES" ] || exit 0

for f in $FILES; do
  [ -f "$f" ] || continue
  case "$f" in
    .env.example | handbook.config.example.yaml | docs/content/docs/reference/configuration.md) continue ;;
    assets/* | docs/public/* | */dist/* | pnpm-lock.yaml) continue ;;
  esac
  pnpm exec prettier --write --log-level warn "$f" >/dev/null 2>&1
  case "$f" in
    docs/*) ;;
    *.ts | *.mjs | *.cjs | *.js) pnpm exec eslint --fix --no-warn-ignored "$f" >/dev/null 2>&1 ;;
  esac
done

exit 0
