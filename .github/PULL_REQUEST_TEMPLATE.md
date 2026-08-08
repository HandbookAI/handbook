<!--
Keep the title in Conventional Commits form — it is what commitlint checks, and the
scope must come from the list in commitlint.config.js:
    fix(patcher): refuse a write whose realpath escapes the source root
Delete any section below that doesn't apply. An empty template is worse than a short PR.
-->

## What and why

<!-- What changed, and the reasoning someone will need in six months. The diff already
     says what; this is for why. Link the issue: Fixes #123 / Refs #123 -->

## How it was verified

<!-- `pnpm check` passing is the floor, not the answer. If the change touches generation,
     rendering or the planner, say which demo you ran and what you looked at. Paste the
     output that proves it. -->

- [ ] `pnpm check` passes locally
- [ ] `pnpm check:all` passes — required if this touches a manifest, `dist` contents, exports or packaging
- [ ] New behaviour has a test; a bug fix has the test that would have caught it

## Release impact

- [ ] Changeset added (`pnpm changeset`), **or** this ships nothing — tests, CI, `docs/internal/`, repo tooling
- [ ] Breaking change — the migration is described above and the changeset is a `major`

## Docs

- [ ] `README.md` **and** `README.zh-CN.md` updated together, if user-facing behaviour changed
- [ ] `docs/architecture.md` / `docs/formats.md` / `docs/prompts.md` updated, if a boundary, artifact schema or prompt changed
- [ ] Language lists in both READMEs updated, if an adapter or tier changed

---

<!-- One concern per PR. No drive-by reformatting: prettier already covers the repo, so a
     formatting diff here means something else moved. See CONTRIBUTING.md. -->
