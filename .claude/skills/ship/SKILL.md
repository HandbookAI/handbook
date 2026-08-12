---
name: ship
description: Land a change on main and, when it is a published package, get it released. Use whenever work is finished and needs to reach the remote — `main` is protected by rulesets, so a direct push is rejected and the route is a pull request whose one required check is `ci`.
argument-hint: '[branch-name]'
allowed-tools: Bash Read Grep
---

# Ship a change

**`git push origin main` is rejected.** Three rulesets guard the default branch, so the
route is a branch, a pull request, and a green `ci`. Check what is actually enforced
rather than trusting this file, which will age:

```bash
gh api repos/HandbookAI/handbooks/rules/branches/main --jq '.[].type'
```

## 1. Gate it locally first

```bash
pnpm check
```

Nothing is done until this passes — see `/gate`. Pushing a red branch spends ten minutes
of CI to learn what sixteen seconds would have told you.

## 2. Branch, push, open the PR

```bash
git switch -c "${1:-fix/describe-the-change}"
git push -u origin HEAD
gh pr create --fill
```

Conventional Commits are enforced by `commitlint`, and on a PR it lints **every commit in
the range** — not just the last one. The allowed scopes are fixed:

```
analyzer cli core llm patcher pipeline planner renderer resync skill studio
ci deps docs examples internal repo spec deck
```

A scope outside that list fails the `commits` job, which fails `ci`, which blocks the
merge. `readme` is not a scope; root documentation is `docs(repo)`. A comma-separated
scope is legal for a change that genuinely spans packages: `feat(core,pipeline): …`.

## 3. Wait for `ci` — the single required check

```bash
gh pr checks --watch
```

`ci` is one aggregate job (`ci-ok` in `ci.yml`, reported under the name `ci`) that
`needs` every other job and fails if any dependency failed, was skipped, or was
cancelled. It is required **because** it cannot drift: requiring the individual jobs
would silently stop covering a platform the day the matrix gains one.

If a PR sits at "waiting for status to be reported" and never moves, the required
context and the job's reported name have diverged. Compare them:

```bash
gh api repos/HandbookAI/handbooks/rulesets --jq '.[] | select(.target=="branch") | .rules[]
  | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
gh pr checks --json name --jq '.[].name'
```

## 4. Merge

```bash
gh pr merge --squash --delete-branch
```

Squash keeps `main` conventional: the merge commit takes the PR title, and a merge
commit's own `Merge pull request #N` subject is not a valid Conventional Commit. The
branch is deleted automatically as well (`delete_branch_on_merge`), so the flag is
belt-and-braces.

Zero approvals are required — GitHub forbids approving your own pull request, and with a
single maintainer a review requirement is a permanent deadlock, not a speed bump. Review
threads **do** have to be resolved.

## 5. If the change touches a published package, it needs a changeset

```bash
pnpm changeset
```

No changeset means no release: `changesets/action` has nothing to version. Per
`CONTRIBUTING.md`, none is needed for a change that ships nothing — tests, CI, the docs
site, repo tooling, or a doc outside a package's published `files`. When unsure, add one:
a redundant patch bump is cheaper than a silent behaviour change.

## 6. Releasing

Merging to `main` runs `release.yml`, which gates on `pnpm run check:all` and then:

- **changesets pending** → it opens or updates a `chore(repo): version packages` PR.
  Merging **that** PR is what publishes.
- **none pending** → it publishes nothing. This is the normal case; most merges release
  nothing at all.

The publish runs `changeset publish` with `NPM_CONFIG_PROVENANCE: true`, so every tarball
is signed against the commit and workflow run that built it. It also pushes one git tag
per package. **Tags are immutable** by ruleset: they are the human-readable link from an
npm version back to source, and npm versions cannot be reused, so a moved tag would leave
a provenance claim pointing at code that is no longer there.

All eleven packages move together on one version. That is deliberate — they are used as a
set, and a reader should not have to work out why `@handbooks/patcher` trails
`@handbooks/core` by two patches.

## 7. Verify the release actually happened

A green Release job is **not** proof of a publish. Ask the registry:

```bash
for p in analyzer cli core llm patcher pipeline planner renderer resync skill studio; do
  printf '  %-12s %s\n' "$p" "$(npm view "@handbooks/$p" version --registry=https://registry.npmjs.org 2>&1 | tail -1)"
done
```

A fresh version can 404 for a few minutes while the registry builds the package document
even though the tarball is already served — the version-specific URL answers first:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@handbooks/cli/1.2.0
```

If that is 200 and the bare package name still 404s, it is propagation, not a failure.
`npm install` reads the package document, so it stays broken until that appears.

## When a ruleset is genuinely in the way

Disable it, do the thing, re-enable it. Do **not** delete it — the configuration is
worth more than the minute it saves.

```bash
gh api repos/HandbookAI/handbooks/rulesets --jq '.[] | "\(.id) \(.name)"'
gh api -X PUT repos/HandbookAI/handbooks/rulesets/<id> -f enforcement=disabled
# ... then, without forgetting:
gh api -X PUT repos/HandbookAI/handbooks/rulesets/<id> -f enforcement=active
```

## The docs site deploys itself

`docs/` is connected to Vercel by git: a merge to `main` builds and aliases
`docshandbook.vercel.app`. No manual `vercel deploy`. A CLI deploy from the repo root
still works as a fallback — the project's Root Directory is `docs` but its build reads
`assets/` from the repository root, so it must be run from the root, never from inside
`docs/`.
