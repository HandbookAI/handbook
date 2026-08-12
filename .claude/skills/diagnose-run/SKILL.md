---
name: diagnose-run
description: Inspect a Handbooks work directory and report what a generation run actually did — file counts, dropped calls, card coverage, stage shape, unassigned files, registers, token cost. Use when a handbook looks wrong and you need evidence rather than a guess.
argument-hint: '<work-dir>'
allowed-tools: Bash Read Grep Glob
---

# Diagnose a work directory

Work dir: `$1` (ask if it was not given; do not guess).

Read the evidence **in this order** — each answer narrows the next question. Do not
re-run `generate`; everything needed is already on disk.

```bash
WORK="$1"
```

## 1. What did the last good run do?

```bash
cat "$WORK/run-manifest.json"
```

Model, phases, timings, token usage. It describes the **last successful** run — a
failed run leaves the previous manifest untouched, and an aborted one writes none.

## 2. Was the scan right?

```bash
jq '.metadata | {language, files: (.scannedFiles|length), nInternalFunctions, nBoundaryNodes, nEdges, languages}' \
   "$WORK/phase1/graph.json"
```

Everything downstream is built on this. A wrong file count here makes every later
question moot.

```bash
jq '.metadata' "$WORK/phase1/dropped-calls.json"
```

Unresolved calls, by category. A large number is **normal** for dynamic languages and
for generic-tier ones — it is not a bug, it is the analyzer refusing to guess.

## 3. Did every file get prose?

```bash
jq '{nFiles, nDescribed, nMissing: (.missing|length)}' "$WORK/phase2/cards/_coverage.json"
jq -r '.missing[]' "$WORK/phase2/cards/_coverage.json" | head -20
ls "$WORK/phase2/cards/_rejected/" 2>/dev/null
head -60 "$WORK"/phase2/cards/_rejected/*.txt 2>/dev/null
```

`_rejected/` is the answer to "why". Those are the replies that produced no usable
card, kept verbatim.

## 4. Is the structure sane?

```bash
cat "$WORK/phase2/strategy.json"
cat "$WORK/phase2/skeleton.yaml"
jq '.coverage' "$WORK/phase2/assignment.json"
jq '.buckets | map_values(length)' "$WORK/phase2/assignment.json"
```

Look for: one stage holding most of the repo, stages with one or two files, titles that
say nothing, a long `coverage.unassigned`.

## 5. Prose and state

```bash
jq '{lang, stages: (.stageSummaries|keys|length), overviewWords: (.systemOverview|split(" ")|length)}' \
   "$WORK/phase3/narration.json"
jq '.registers | map({id, stages: (.stages|length)})' "$WORK/phase3/registers.json"
```

## 6. The busiest code — where a change is most likely to fan out

```bash
jq -r '.nodes | to_entries | map(select(.value.kind=="internal"))
       | sort_by(-.value.nCallers) | .[:15]
       | .[] | "\(.value.nCallers)\t\(.value.qualname)\t\(.value.file)"' \
   "$WORK/phase1/graph.json"
```

## Report

One paragraph per finding, each quoting the artifact it came from, then **the narrowest
command that would fix it** — a `--phase` subset with `--resume` wherever possible.
Never propose a full regeneration when a partial one would do.

Do not call model-written prose a bug. A wrong **path** or **line range** would be a
real bug; a bland sentence is prose quality, and the fix for that is a better `--model`.
