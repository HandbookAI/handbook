# Handbook — working notes for coding agents

Turn any codebase into a navigable handbook, and use that handbook to plan precise code
changes. A pnpm monorepo of eleven TypeScript packages plus a standalone docs site.

Read this before touching anything. Everything below is a fact about _this_ repo that a
generic instinct gets wrong.

---

## The one command that matters

```bash
pnpm check
```

Type-check → workspace invariants → eslint (zero warnings) → prettier → tests with
**per-package** coverage floors. **Nothing is "done" until this passes.** A green
`tsc -b` implies none of the other four.

`pnpm check:all` adds the publish gates (`publint`, `are-the-types-wrong`, and a real
`npm install` of eleven packed tarballs). Slow; CI and pre-release only.

---

## Files you must never hand-edit

Three files are rendered from `packages/core/src/config/registry.ts` and compared **byte
for byte** by `packages/cli/src/docs-drift.test.ts`:

- `.env.example`
- `handbook.config.example.yaml`
- `docs/content/docs/reference/configuration.md`

Change the registry, then `pnpm run config:docs`. Also generated: `packages/*/dist/**`
(edit `src/`), `docs/public/diagrams/**` (edit `assets/`), `pnpm-lock.yaml`,
`packages/*/CHANGELOG.md`.

---

## Architecture, in four lines

```
cli · studio                                      ← entry points
pipeline · renderer · skill · planner · patcher · resync   ← capabilities
analyzer · llm                                    ← engines
core                                              ← foundation
```

**Dependencies only ever point down.** A cycle or an upward import fails
`pnpm check:workspace`.

**LLM isolation is a package boundary, not a convention.** Only `llm`, `pipeline`,
`planner` and `resync` may reach a model, and only through the `ChatClient` interface.
`analyzer`, `renderer`, `skill` and `patcher` do not depend on `@handbooks/llm` at all —
which is what makes `render`, `skill`, `validate`, `apply` and `rollback` free to run in
CI, and what makes the whole test suite runnable offline.

**`HandbookModel` (in `core`) is the renderer's only input.** It never reads pipeline
internals. Anything that can fill one gets rendering, packaging and planning for free.

---

## The invariants this project is actually about

This codebase's value is in what it **refuses** to do. When changing any of these, the
burden of proof is high.

1. **Facts come from the parser; prose comes from the model; the two are never mixed.**
   A file whose card generation failed still appears, with an **empty** description, and
   is listed in `_coverage.json`. Never invent, never drop.
2. **A call the analyzer cannot resolve goes to `dropped-calls.json`.** Never guessed.
   A guessed edge is indistinguishable from a real one to everything downstream.
3. **Analysis fidelity is declared per adapter and disclosed in the output.** Both tiers
   produce identical-looking IR; the declaration is the only thing preventing a reader
   from trusting a generic-tier edge like a Python one.
4. **A patch anchor must match byte-exactly and uniquely.** Zero matches or two matches
   both refuse. Never "take the first one".
5. **A run that gave up exits non-zero.** Returning an apology as a result reports an
   abandoned run as a success, and something downstream acts on it.
6. **Degrade, never block.** Organization falls back to call-graph order; narration to
   the stage description; register extraction to an empty list.
7. **Secrets are never a flag and are rejected in a config file.** Config files get
   committed.

---

## Conventions the tooling enforces

- **Versions live only in `pnpm-workspace.yaml`'s catalog.** Packages depend on
  `"catalog:"`. A literal range in a manifest fails `check:workspace`; so does an unused
  catalog entry.
- **TypeScript project references must mirror `package.json` dependencies exactly.**
- **Build projects exclude `*.test.ts`; `dist/` must contain no test artifact.**
- **Coverage floors are per package** and sit just under measured. They **ratchet** —
  raise one when your change raises coverage; never lower one to go green.
- **Tests resolve `@handbooks/*` to `src`, not `dist`** (see `vitest.config.ts`), so
  cross-package coverage is attributed. The real `dist` is verified by `tsc -b` and by
  `pnpm check:install`.
- **The npm scope is `@handbooks/` — plural — and is defined once**, in
  `scripts/scope.mjs`. `check-workspace.mjs`, `vitest.config.ts`, `check-packaging.mjs`
  and `smoke-install.mjs` import it; only the package manifests spell it out, and
  `check:workspace` proves they agree. Never restate the literal: a stale copy in the
  vitest alias does not fail, it quietly resolves through `dist` and collapses
  cross-package coverage.
- **Conventional Commits**, enforced by `commitlint`. A change to a published package
  needs `pnpm changeset`.

---

## Testing

**Everything runs offline. No test ever needs an API key.**

- LLM flows → `MockChatClient` (rules; first match wins). The real client → a local HTTP
  server.
- Analyzer tests build **real** mini-repos in temp dirs. A mocked parse tree proves
  nothing about a grammar.
- Cover the failure paths: unparseable replies, partial batches, each degradation tier,
  aborts, resume, sandbox escapes, ambiguous anchors, every parser rejection.

```bash
pnpm test                                  # everything
pnpm exec vitest run packages/analyzer     # one package
pnpm exec vitest run -t "dropped calls"    # one test
pnpm demo                                  # the whole toolchain, offline, ~30s
```

---

## Layout

```
packages/<name>/src/       source; tests colocated as *.test.ts
scripts/                   workspace checks, doc generation, smoke tests
examples/                  the offline demo, the mock LLM server, the fixture project
assets/                    diagrams referenced by BOTH READMEs — the single source
docs/                      the documentation site: a SEPARATE Next.js app
docs/internal/             the engineering journal — LOCAL ONLY, gitignored
.claude/                   shared agent config: hooks, subagents, skills, rules
```

**`docs/` is not a workspace member.** It has its own `pnpm-workspace.yaml`, so a root
`pnpm install` ignores it, and the root eslint config ignores it too. Work on it from
inside `docs/`.

---

## Things that will surprise you

- **Swift's grammar aborts the process on V8 ≥ 13.** The adapter refuses at discovery and
  names `node --liftoff-only`. `vitest.config.ts` passes that flag for the same reason.
- **Shell scripts containing `case` are skipped** — that grammar throws. Reported in the
  scan log, never silently dropped.
- **Never set a commander default.** It is evaluated at module load, before the preAction
  hook applies `--env-file`, which silently ignores the file. Defaults come from the
  registry at action time.
- **A lone `--no-x` flag needs a hidden positive counterpart**, or commander gives it an
  implicit `true` that permanently masks the env var and the config file.
- **The `.env` cascade is cwd-only**, unlike `handbook.config.yaml`, which is discovered
  by walking up to the git root.
- **`handbook config` deliberately does not abort on invalid configuration** — showing
  broken configuration is its entire job.
- **Exit code `2` means "the tool worked and the answer is no"** (`validate` failed,
  `apply` did not fully land, `config --check` found a problem). `1` means an error.

---

## Reference

- [README.md](README.md) · [中文](README.zh-CN.md)
- [docs/](docs/) — the full documentation site
- [.claude/README.md](.claude/README.md) — the hooks, subagents and skills in this repo
- [CONTRIBUTING.md](CONTRIBUTING.md)
