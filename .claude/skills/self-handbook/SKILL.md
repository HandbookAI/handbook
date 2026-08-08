---
name: self-handbook
description: Generate this repository's own handbook end to end, offline, against the bundled mock LLM — the fastest way to see the whole toolchain work, or to check a change did not break the pipeline. Costs nothing.
argument-hint: '[demo|self]'
allowed-tools: Bash Read
---

# Run the toolchain on itself, offline

Two variants. Both use the bundled mock LLM server, so they need **no API key and
spend no tokens**. The prose will be placeholder text; **the structure is entirely
real**.

```bash
pnpm demo        # the bundled sample project — fastest, ~30s
pnpm demo:self   # this monorepo's own TypeScript — a real map of a real codebase
```

`$ARGUMENTS` picks one; default to `demo` if nothing was given.

## What each step proves

| Step                   | Proves                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `analyze`              | The analyzer parses, the graph builds, artifacts validate                                            |
| `generate --phase 2,3` | Cards, skeleton, assignment, organization, narration, registers all run and their artifacts validate |
| `render`               | Markdown, the HTML site, the single page, the agent index and llms.txt all render                    |
| `skill`                | Packaging works, and `coverage.json` gets hashes                                                     |
| `validate`             | The package satisfies its own contract                                                               |

A failure in any of them is a real regression — this path exercises every package
except `planner`, `patcher` and `studio`.

## Afterwards, look at the output

```bash
open examples/work/demo/handbook/overview.md
open examples/work/demo/handbook/html/overview.html
open examples/work/demo/handbook/handbook.html
cat  examples/work/demo/skill/SKILL.md
```

And at the artifacts, which is where regressions actually show:

```bash
jq '.metadata | {files: (.scannedFiles|length), nInternalFunctions, nEdges}' \
   examples/work/demo/phase1/graph.json
jq '{nFiles, nDescribed}' examples/work/demo/phase2/cards/_coverage.json
cat examples/work/demo/phase2/skeleton.yaml
jq '.coverage' examples/work/demo/phase2/assignment.json
```

## Against a real endpoint

```bash
pnpm demo:self:real   # uses ./.env or shell OPENAI_*
```

**This spends tokens.** Only do it when you are specifically checking prose quality,
and say so before running it.

## If it fails

The demo scripts print each step. The failing step names the command; re-run just that
command with `-v` to see the phase logs. `examples/work/<name>/phase2/cards/_rejected/`
holds any reply that produced no usable card.
