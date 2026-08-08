---
name: gate
description: Run this repo's verification gate and interpret whatever it reports. Use before claiming any change is done, before committing, and whenever `pnpm check` fails and the message is not self-explanatory.
argument-hint: '[all]'
allowed-tools: Bash Read Grep
---

# Run the gate

```bash
pnpm check
```

Pass `all` to add the two publish-facing gates (they pack eleven tarballs, so they are
slow and belong in CI and before a release):

```bash
pnpm check:all
```

`pnpm check` runs, in this order — **stop at the first failure and fix that one**:

1. `typecheck` — `tsc -b`, then the tests against `tsconfig.tests.json`
2. `check:workspace` — the monorepo's structural invariants
3. `lint` — eslint, zero warnings tolerated
4. `format:check` — prettier
5. `test:coverage` — vitest with per-package coverage floors

## Reading the failures

### `check:workspace` failed

Seven rules, each of which this repo violated at least once. The message names the file
and the rule:

| Message contains                        | Fix                                                           |
| --------------------------------------- | ------------------------------------------------------------- |
| `does not reference ../<pkg>`           | Add it to `references` in that package's `tsconfig.json`      |
| `pins "<range>" directly`               | Use `"catalog:"` and put the version in `pnpm-workspace.yaml` |
| `catalog entry "<x>" is unused`         | Remove it from the catalog                                    |
| `contains N test artifact(s)`           | `pnpm clean && pnpm build`                                    |
| `must exclude "!dist/**/*.map"`         | Add it to `files` in that manifest                            |
| `is publishable but depends on private` | One of them is wrong; usually the dependency                  |

### A drift test failed

```
.env.example is stale — run: pnpm run config:docs
```

Never hand-edit the generated file. Change
`packages/core/src/config/registry.ts` and regenerate. A hook blocks the hand-edit.

```
README.md does not mention: kotlin
```

A registered language is missing from the docs. Update both READMEs, the analyzer
READMEs, `docs/content/docs/reference/languages.mdx`, and `DISPLAY` in
`packages/cli/src/docs-drift.test.ts`.

```
README.md links path(s) not tracked in git: …
```

The link target exists on disk but is not committed. `git add` it. This test uses
`git ls-files` on purpose — a file that is only in your working tree would break for
everyone else.

```
README.md references missing script(s): …
```

Something in a README reads as `pnpm <word>` but no such script exists. Often an
innocent sentence: "no local Node or pnpm needed" parses as `pnpm needed`. Rephrase.

### A coverage floor failed

```
ERROR: Coverage for statements (81.2%) does not meet threshold (84%) for packages/analyzer/src/**
```

Floors are **per package** and sit just under what each measured, so they ratchet. Add
tests for what you changed. **Do not lower the floor to make the run green.** If your
change genuinely raises coverage, raise the floor with it.

### Format or lint failed

```bash
pnpm format      # rewrites
pnpm lint:fix    # auto-fixes what it can
```

If eslint reports a file under `docs/`, that is a bug in the config — `docs/` is a
separate app with its own toolchain and the root config ignores it.

## When it passes

Say so with the actual output, not a summary of it. `pnpm check` passing is the only
statement about this repo's health worth making.
