#!/usr/bin/env bash
# PostToolUse(Edit|Write) — format and auto-fix just the file that changed.
#
# `pnpm check` runs prettier and eslint over the whole repo and fails on the
# first offence. Formatting one file the moment it is written keeps that gate
# about real problems instead of about whitespace, and it is fast because it
# never touches anything else.
#
# Deliberately silent on success and never blocking: a formatter that fails
# should not abort the work, only report.
set -uo pipefail

INPUT="$(cat)"
ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

FILE="$(printf '%s' "$INPUT" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    try {
      const path = JSON.parse(raw)?.tool_input?.file_path;
      if (typeof path === "string") process.stdout.write(path);
    } catch {
      /* ignore */
    }
  });
')"

[ -n "$FILE" ] && [ -f "$FILE" ] || exit 0

REL="${FILE#"$ROOT"/}"

# The docs site has its own toolchain; the root eslint config ignores it, and
# the generated config reference must stay byte-identical to its generator.
case "$REL" in
  .env.example | handbook.config.example.yaml | docs/content/docs/reference/configuration.md) exit 0 ;;
  assets/* | docs/public/*) exit 0 ;;
esac

case "$FILE" in
  *.ts | *.tsx | *.mjs | *.cjs | *.js | *.json | *.md | *.mdx | *.yml | *.yaml)
    (cd "$ROOT" && pnpm exec prettier --write --log-level warn "$FILE") >/dev/null 2>&1
    ;;
esac

# eslint only for repo sources — docs/ is a separate app with its own linting.
case "$REL" in
  docs/*) ;;
  *.ts | *.mjs | *.cjs | *.js)
    (cd "$ROOT" && pnpm exec eslint --fix --no-warn-ignored "$FILE") >/dev/null 2>&1
    ;;
esac

exit 0
