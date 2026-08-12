---
'@handbooks/analyzer': minor
'@handbooks/cli': minor
'@handbooks/core': minor
'@handbooks/llm': minor
'@handbooks/patcher': minor
'@handbooks/pipeline': minor
'@handbooks/planner': minor
'@handbooks/renderer': minor
'@handbooks/resync': minor
'@handbooks/skill': minor
'@handbooks/studio': minor
---

First published release, with all eleven packages on one version.

They are used as a set — a `@handbooks/cli` run loads the pipeline, which loads
the analyzer, the renderer and the LLM seam — so a reader picking a version
should not have to work out why `@handbooks/patcher` is two patch releases
behind `@handbooks/core`. The changesets accumulated before this point would
have produced exactly that: seven packages at one minor and four at a patch.

Listing every package at `minor` is what holds them together: changesets takes
the highest bump per package, so the ones whose pending changes were patches
come along to the same version instead of lagging.
