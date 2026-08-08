#!/usr/bin/env bash
# PreToolUse(Edit|Write|NotebookEdit) — refuse to hand-edit a generated file.
#
# Three files in this repo are rendered from the settings registry and compared
# BYTE FOR BYTE by packages/cli/src/docs-drift.test.ts. Editing one by hand
# produces a change that looks right, passes review, and then fails the build
# with a message about drift that does not say "you edited the output".
#
# Blocking here turns "mysterious CI failure" into one sentence, at the moment
# the mistake is made, naming the file to change instead.
#
# Exit 2 = block, with stderr fed back to Claude as the reason.
set -euo pipefail

INPUT="$(cat)"

FILE="$(printf '%s' "$INPUT" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    try {
      const path = JSON.parse(raw)?.tool_input?.file_path;
      if (typeof path === "string") process.stdout.write(path);
    } catch {
      /* malformed input is not for this hook to report */
    }
  });
')"

[ -n "$FILE" ] || exit 0

# Compare repo-relative, so an absolute path and a relative one behave alike.
REL="${FILE#"${CLAUDE_PROJECT_DIR:-$PWD}"/}"

case "$REL" in
  .env.example | handbook.config.example.yaml | docs/content/docs/reference/configuration.md)
    cat >&2 <<MSG
$REL is GENERATED from the settings registry — do not edit it by hand.

Change packages/core/src/config/registry.ts (or render-docs.ts, if the wording
around the tables is what is wrong), then regenerate all three surfaces:

    pnpm run config:docs

A drift test compares these files byte for byte against the generator, so a hand
edit fails the build rather than shipping.
MSG
    exit 2
    ;;

  */dist/* | dist/*)
    echo "$REL is build output. Edit the TypeScript source under src/ and run \`pnpm build\`." >&2
    exit 2
    ;;

  docs/public/diagrams/*)
    cat >&2 <<MSG
$REL is a build-time copy. The diagrams live in assets/ at the repo root,
because both READMEs reference them from there.

Edit assets/<name>.svg; docs/scripts/sync-generated.mjs copies it on the next
\`pnpm dev\` or \`pnpm build\` in docs/.
MSG
    exit 2
    ;;

  pnpm-lock.yaml | docs/pnpm-lock.yaml)
    echo "$REL is managed by pnpm. Change the manifest (or the catalog in pnpm-workspace.yaml) and run \`pnpm install\`." >&2
    exit 2
    ;;
esac

exit 0
