#!/usr/bin/env bash
# Refuse a write to a generated file, and name the right thing to change instead.
#
# Three files here are compared BYTE FOR BYTE against their generator by a drift
# test. Hand-editing one produces a change that looks right, passes review, and
# then fails the build with a message about drift that does not say "you edited
# the output". This turns that into one sentence at the moment of the mistake.
#
# Exit 2 blocks; stderr is fed back as the reason.
set -uo pipefail

PAYLOAD="$(cat)"

# Pull the TARGET PATH out of the payload rather than grepping the whole thing:
# a payload that merely MENTIONS .env.example — editing a README, say — must not
# be blocked. Several key names are tried because the field name is the hook
# contract's, not ours, and a guard that silently stops working after a rename is
# worse than no guard.
FILE="$(printf '%s' "$PAYLOAD" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const KEYS = ["file_path", "filePath", "path", "target", "file"];
    const seen = new Set();
    const find = (node) => {
      if (!node || typeof node !== "object" || seen.has(node)) return undefined;
      seen.add(node);
      for (const key of KEYS) {
        if (typeof node[key] === "string") return node[key];
      }
      for (const value of Object.values(node)) {
        const hit = find(value);
        if (hit) return hit;
      }
      return undefined;
    };
    const hit = find(data);
    if (hit) process.stdout.write(hit);
  });
' 2>/dev/null)"

[ -n "$FILE" ] || exit 0

REL="${FILE#"$PWD"/}"
REL="${REL#./}"

case "$REL" in
  .env.example | handbook.config.example.yaml | docs/content/docs/reference/configuration.md)
    cat >&2 <<MSG
$REL is GENERATED from the settings registry — do not edit it by hand.

Change packages/core/src/config/registry.ts, then regenerate all three surfaces:

    pnpm run config:docs

packages/cli/src/docs-drift.test.ts compares these files byte for byte against
the generator, so a hand edit fails the build rather than shipping.
MSG
    exit 2
    ;;
  */dist/* | dist/*)
    echo "$REL is build output. Edit the TypeScript source under src/ and run \`pnpm build\`." >&2
    exit 2
    ;;
  docs/public/diagrams/*)
    echo "$REL is a build-time copy. Edit assets/<name>.svg — both READMEs reference that path directly." >&2
    exit 2
    ;;
  pnpm-lock.yaml | docs/pnpm-lock.yaml)
    echo "$REL is managed by pnpm. Change the manifest (or the catalog in pnpm-workspace.yaml) and run \`pnpm install\`." >&2
    exit 2
    ;;
esac

exit 0
