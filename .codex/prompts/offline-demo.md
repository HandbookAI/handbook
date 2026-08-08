Run the whole toolchain offline, against the bundled mock LLM. No API key, no network,
zero tokens.

```bash
pnpm demo        # the bundled sample project — fastest, ~30s
pnpm demo:self   # this monorepo's own TypeScript — a real map of a real codebase
```

The prose will be placeholder text; **the structure is entirely real** — stages, file
assignment, call facts, line ranges, the register table, every link.

This path exercises every package except `planner`, `patcher` and `studio`, so a failure
in it is a real regression.

Afterwards, check the artifacts — that is where regressions actually show:

```bash
jq '.metadata | {files: (.scannedFiles|length), nInternalFunctions, nEdges}' \
   examples/work/demo/phase1/graph.json
jq '{nFiles, nDescribed}' examples/work/demo/phase2/cards/_coverage.json
cat examples/work/demo/phase2/skeleton.yaml
ls  examples/work/demo/phase2/cards/_rejected/ 2>/dev/null   # replies that produced no card
```

Do **not** run `pnpm demo:self:real` without saying so first — that one spends tokens
against a real endpoint.
