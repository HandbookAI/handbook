Run this repo's verification gate and interpret whatever it reports.

```bash
pnpm check
```

It runs, in this order — **stop at the first failure and fix that one**:

1. `typecheck` — `tsc -b`, then the tests against `tsconfig.tests.json`
2. `check:workspace` — the monorepo's structural invariants
3. `lint` — eslint, zero warnings tolerated
4. `format:check` — prettier
5. `test:coverage` — vitest with per-package coverage floors

Reading the failures:

- **`.env.example is stale — run: pnpm run config:docs`** — never hand-edit the generated
  file. Change `packages/core/src/config/registry.ts` and regenerate.
- **`README.md does not mention: <lang>`** — a registered language is missing from the
  docs. Update both READMEs, both analyzer READMEs,
  `docs/content/docs/reference/languages.mdx`, and `DISPLAY` in
  `packages/cli/src/docs-drift.test.ts`.
- **`links path(s) not tracked in git`** — the link target exists but is not committed.
  `git add` it. The test uses `git ls-files` on purpose.
- **`references missing script(s)`** — something in a README reads as `pnpm <word>` but
  no such script exists. Often an innocent sentence. Rephrase.
- **`pins "<range>" directly`** — use `"catalog:"` and put the version in
  `pnpm-workspace.yaml`.
- **A coverage floor** — floors are per package and ratchet. Add tests. Do **not** lower
  a floor to make the run green.

When it passes, say so with the actual output, not a summary of it.
