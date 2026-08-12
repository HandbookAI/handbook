// The npm scope every package in this workspace is published under.
//
// It is `handbooks`, plural, because `handbook` could not be created as an npm
// organization — and npm requires a package's scope to match an organization
// you own, so the scope follows the org rather than the repo.
//
// This lives in its own module, imported rather than restated, because four
// independent places need the same string and two of them fail *quietly* when
// it drifts:
//
//   - `check-workspace.mjs` anchors every structural invariant on it — the
//     dependency direction, the catalog rule, and the project-reference
//     mirroring all key off `startsWith(SCOPE)`. A stale value there makes the
//     checks pass by matching nothing at all.
//   - `vitest.config.ts` aliases it to each package's `src`, so cross-package
//     coverage is attributed. A stale value there resolves imports through
//     `dist` instead and collapses coverage for every cross-package call,
//     which reads as a coverage regression rather than as a broken alias.
//   - `check-packaging.mjs` labels its per-package report with it.
//   - `smoke-install.mjs` looks for the installed packages beneath it in
//     `node_modules`.
//
// Package manifests still spell their own names out in full; npm reads those
// directly and they cannot be computed. `check-workspace.mjs` is what proves
// they agree with this constant.

/** Scope prefix, trailing slash included: `@handbooks/`. */
export const SCOPE = '@handbooks/';

/** Directory npm installs this scope's packages into: `@handbooks`. */
export const SCOPE_DIR = SCOPE.slice(0, -1);

/** `@handbooks/core` for `core`. */
export const scoped = (name) => `${SCOPE}${name}`;
