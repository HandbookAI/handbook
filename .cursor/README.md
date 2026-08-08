# `.cursor/` — Cursor configuration for this repo

Project rules for [Cursor](https://cursor.com/docs/context/rules), committed so every
contributor's agent starts with the same facts.

## The rules

| File                      | Applies                                     | Covers                                                                      |
| ------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| `rules/00-project.mdc`    | **always**                                  | The gate, the generated files, the architecture, the seven invariants       |
| `rules/10-typescript.mdc` | `packages/**/*.ts`                          | ESM conventions, zod artifacts, atomic writes, error codes, comment style   |
| `rules/20-analyzer.mdc`   | `packages/analyzer/**`                      | Never guess a call edge; two passes; honest capabilities; real-source tests |
| `rules/30-llm.mdc`        | `packages/{llm,pipeline,planner,resync}/**` | The one `ChatClient` seam; degrade-never-block; non-zero on giving up       |
| `rules/40-tests.mdc`      | `packages/**/*.test.ts`                     | Offline always; failure paths first; ratcheting coverage floors             |
| `rules/50-docs-site.mdc`  | `docs/**`                                   | It is a separate app; the two generated inputs; MDX traps                   |

Only `00-project.mdc` is `alwaysApply: true`. The rest auto-attach when a matching file
is in context, so a session about the analyzer does not carry the docs-site rules and
vice versa.

Rules must use the `.mdc` extension — Cursor ignores plain `.md` files in this directory.

## `AGENTS.md`

Cursor also reads [`AGENTS.md`](../AGENTS.md) at the repo root — the tool-agnostic version
of the same guidance, shared with Codex. The rules here are its path-scoped slices.

## Before your first edit

```bash
pnpm install && pnpm build
pnpm demo        # the whole toolchain, offline, ~30s, zero tokens
pnpm check       # the gate — nothing is done until this passes
```

**Three files are generated** and compared byte for byte by a drift test:
`.env.example`, `handbook.config.example.yaml` and
`docs/content/docs/reference/configuration.md`. Change
`packages/core/src/config/registry.ts` and run `pnpm run config:docs`.

## Other agents

Equivalent configurations live at [`.claude/`](../.claude/README.md) and
[`.codex/`](../.codex/README.md). All three describe the same repository.
