---
description: Files in this repo that are generated and must never be hand-edited.
---

# Never hand-edit these

Three files are rendered from `packages/core/src/config/registry.ts` and compared
**byte for byte** by `packages/cli/src/docs-drift.test.ts`:

- `.env.example`
- `handbook.config.example.yaml`
- `docs/content/docs/reference/configuration.md`

To change any of them, change the registry (or `config/render-docs.ts` for the prose
around the tables) and run:

```bash
pnpm run config:docs
```

Also generated:

- `packages/*/dist/**` — build output. Edit `src/` and run `pnpm build`.
- `docs/public/diagrams/**` — copied from `assets/` by `docs/scripts/sync-generated.mjs`.
  Edit `assets/<name>.svg`; both READMEs reference that path directly.
- `pnpm-lock.yaml` — change the manifest, or the catalog in `pnpm-workspace.yaml`,
  then `pnpm install`.
- `packages/*/CHANGELOG.md` — written by changesets. Add a changeset instead.

A `PreToolUse` hook blocks writes to all of these and explains the alternative.
