# Contributing to Handbook

**English** | [中文](CONTRIBUTING.zh-CN.md)

Thanks for being here. This document is the contributor-facing half of the
[README](README.md): the README tells you what the toolchain does and which commands exist,
this one tells you what a change is expected to look like before it can be merged.

Two things are worth knowing up front, because they shape everything else:

- **Every test runs offline.** No test may require an API key or reach the network. LLM
  behaviour is tested against `MockChatClient` (scripted rules) or the bundled mock HTTP
  endpoint. A PR that adds a test needing a live endpoint will be asked to change it.
- **The gate is a script, not a bot.** `pnpm check` is exactly what CI runs first. If it
  passes on your laptop, CI's `check` job passes too — and when CI is red you reproduce it
  locally instead of pushing commits at it.

## Ways to help

| You want to                   | Start with                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Report something broken       | [Bug report](../../issues/new?template=bug_report.yml) — include the reproduction, see the form    |
| Ask for a language            | [Language support](../../issues/new?template=language_support.yml)                                 |
| Propose a feature or a change | [Feature request](../../issues/new?template=feature_request.yml) — open this **before** a large PR |
| Ask how something works       | Discussions, or [docs/architecture.md](docs/architecture.md) — questions are not bugs              |
| Report a vulnerability        | **Not** an issue — see [SECURITY.md](SECURITY.md)                                                  |
| Fix a typo, tighten a doc     | Just send the PR                                                                                   |

Small, obviously-correct fixes need no preamble. For anything that changes an artifact
schema, a prompt, a CLI flag or a package boundary, open an issue first — those decisions
are documented in [docs/formats.md](docs/formats.md), [docs/prompts.md](docs/prompts.md) and
[docs/architecture.md](docs/architecture.md), and the discussion belongs where the reasoning
can be read later.

## Setting up

```bash
node -v                 # must be >= 20.11 (see .nvmrc)
corepack enable         # picks up the pnpm version pinned in package.json
pnpm install
pnpm build

bash examples/run-demo.sh   # fully offline, zero tokens — proves the setup works
```

If the demo produces `examples/work/demo/handbook/overview.md`, your environment is
correct. It uses the bundled mock LLM, so it needs no key and no network.

You only need a real endpoint to work on the LLM-facing packages by hand. Copy
[.env.example](.env.example) to `.env` (git-ignored) — never add a key to a tracked file,
and never paste one into an issue.

## The loop

```bash
pnpm check        # before every commit — typecheck, workspace invariants, lint, format, tests
pnpm check:all    # before a PR that touches packaging or a manifest — adds publint/attw + install smoke
```

`pnpm check` runs in a deliberate order so a failure names its own cause: type-check
(sources, then tests) → workspace invariants → eslint at zero warnings → prettier → tests
with per-package coverage floors. `pnpm check:all` adds the two publish-facing gates, which
pack eleven tarballs; they belong in CI and before a release, not in every local loop.

A `pre-commit` hook formats and lints staged files, and `commit-msg` runs commitlint, so a
commit cannot introduce a formatting failure that CI reports minutes later. Don't bypass
them with `--no-verify` — if a hook is wrong, that's a bug worth fixing.

The full command list is in the README's [Development](README.md#development) section, and
the conventions the tooling enforces rather than documents (versions live in the
`pnpm-workspace.yaml` catalog, `dist/` is the published surface, tests resolve `@handbook/*`
to source) are listed right below it. Read those once — each has a check that will fail on
you otherwise.

## Commits

Conventional Commits, enforced by the `commit-msg` hook locally and by the `commitlint` job
on every PR:

```
feat(analyzer): resolve inherited members through the type table
fix(patcher): refuse a write whose realpath escapes the source root
docs(repo): document the release flow
```

- **Type**: the [conventional-commits](https://www.conventionalcommits.org/) set —
  `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`, `revert`.
- **Scope** is required and comes from a fixed list — the eleven packages (`analyzer`,
  `cli`, `core`, `llm`, `patcher`, `pipeline`, `planner`, `renderer`, `resync`, `skill`,
  `studio`) plus the repo-level areas (`ci`, `deps`, `docs`, `examples`, `internal`, `repo`,
  `spec`, `deck`). A comma-separated list is legal for a change that genuinely spans
  packages: `feat(core,pipeline): …`. The list lives in
  [commitlint.config.js](commitlint.config.js); adding a scope is a deliberate change to
  that file, not something to work around.
- **Subject**: lower-case, imperative, no trailing period. Body lines wrap at 110.

Write the subject so it says what changed and, where it fits, why — the history is the
changelog's raw material and it is read far more often than it is written.

## Changesets

Releases are driven by [changesets](https://github.com/changesets/changesets). If your
change alters the behaviour, API or packaging of a **published package**, add one and commit
it with the code:

```bash
pnpm changeset     # pick the affected packages and the bump, then describe the change
```

Write the changeset for someone upgrading, not for the reviewer: what changed for them, and
what they have to do about it. A `major` bump needs the migration in the body.

No changeset is needed for changes that ship nothing — tests, CI, `docs/internal/`,
repo tooling, or a doc that isn't part of a package's published files. If you're unsure, add
one; a redundant patch bump is cheaper than a silent behaviour change.

## Tests

- Tests sit next to the code: `packages/<pkg>/src/**/*.test.ts`. Shared fixtures and
  scripted mock rules go in `*.test-helper.ts`, which is excluded from the build and from
  coverage.
- Write the failing test first, then make it pass. Every bug fix needs the test that would
  have caught it — if you can't write one, say so in the PR and explain why.
- Coverage floors are **per package** and set just under what each package measures, so
  they ratchet. A change that drops coverage fails the gate; a change that raises it is
  expected to raise the floor with it in [vitest.config.ts](vitest.config.ts). Do not widen
  the gap to make a red run pass.
- Two grammar quirks are load-bearing and documented where they bite: the Swift grammar
  aborts the process on V8 ≥ 13 (hence `execArgv: ['--liftoff-only']` in the vitest config,
  and a refusal at discovery in the adapter), and a shell script containing `case` is
  skipped. Both are reported in the scan log rather than silently dropped — keep it that
  way.

## Adding a language

Two tiers, and picking the right one is most of the work.

**Generic tier** — exact file and function inventory, best-effort call relations. Append a
spec to `GENERIC_LANGUAGES` in [packages/analyzer/src/generic.ts](packages/analyzer/src/generic.ts):
a registry name, the `tree-sitter-wasms` grammar name, the file extensions and the node
kinds. No new adapter file. This is the right first step for a language nobody has modelled
yet, and it is a small, reviewable PR.

**Full fidelity** — type-driven call resolution, inherited members, per-attribute state
tracking. That means:

1. `packages/analyzer/src/adapters/<lang>.ts` implementing the `LanguageAdapter` contract in
   [adapter.ts](packages/analyzer/src/adapter.ts).
2. Registration in [register.ts](packages/analyzer/src/register.ts) and, if it should be
   part of the public API, an export from `index.ts`.
3. `<lang>.test.ts` beside it, plus a small, idiomatic fixture under
   [examples/demo-project/](examples/demo-project/) — those files are deliberately written in
   the idiom of the language being parsed and are excluded from prettier for that reason.
4. The coverage floor for `analyzer` raised to match.
5. The language lists in [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md), and
   a changeset.

The grammar must exist in `tree-sitter-wasms` — no native compilation is ever required, and
a PR that adds a build step to get a grammar will be declined.

## Pull requests

The [PR template](.github/PULL_REQUEST_TEMPLATE.md) is the checklist; this is the reasoning
behind it.

- **One concern per PR.** A fix plus an unrelated rename is two PRs. Reviewers read diffs,
  and a diff that does two things gets half the attention on each.
- **No drive-by reformatting.** Prettier runs over the whole repo already, so a formatting
  diff in your PR means something else changed. Keep the deliberate exclusions in
  [.prettierignore](.prettierignore) excluded.
- **Say why, not just what.** The what is in the diff. The PR body should leave someone
  reading it in six months able to reconstruct the decision — that is the same standard the
  comments in this repo hold themselves to.
- **State how you verified it.** `pnpm check` passing is the floor. If the change affects
  generation, rendering or the planner, say which demo you ran and what you looked at.
- **CI must be green.** Six independent jobs: `check` (Linux on Node 20 and 24, plus macOS
  and Windows on 24), `packaging`, `smoke`, `demo`, `shellcheck`, `commitlint`. The Windows
  legs are not box-ticking — the patcher's symlink-escape guard, core's directory lock and
  every path the analyzer normalises behave differently there.
- **Expect review comments, including on prose.** Comments and docs are part of the
  product here.

Maintainers may push small fixups to your branch rather than round-trip a nit. If you'd
rather they didn't, say so in the PR.

## Licensing

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE), the same terms as the project. There is no CLA and no DCO
sign-off — the commit itself is the record.

Do not paste code you don't have the right to relicense, and do not paste proprietary source
into an issue while reproducing a bug. The analyzer runs entirely locally, so a minimal
synthetic fixture is almost always enough to demonstrate a parsing problem.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). It applies to
issues, pull requests, discussions and commit messages alike.
