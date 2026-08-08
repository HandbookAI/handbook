Diagnose a Handbook work directory: report what a generation run actually did, with
evidence. Do **not** re-run `generate` — everything needed is already on disk.

Ask for the work directory if it was not given.

```bash
WORK=<the work dir>

# 1. What did the last GOOD run do, with what model, at what cost?
cat "$WORK/run-manifest.json"

# 2. Was the scan right? Everything downstream is built on this.
jq '.metadata | {language, files: (.scannedFiles|length), nInternalFunctions, nEdges, languages}' \
   "$WORK/phase1/graph.json"
jq '.metadata' "$WORK/phase1/dropped-calls.json"

# 3. Did every file get prose, and why not?
jq '{nFiles, nDescribed, nMissing: (.missing|length)}' "$WORK/phase2/cards/_coverage.json"
head -60 "$WORK"/phase2/cards/_rejected/*.txt 2>/dev/null

# 4. Is the structure sane?
cat "$WORK/phase2/strategy.json" "$WORK/phase2/skeleton.yaml"
jq '.coverage' "$WORK/phase2/assignment.json"
jq '.buckets | map_values(length)' "$WORK/phase2/assignment.json"

# 5. Prose and state
jq '{lang, stages: (.stageSummaries|keys|length)}' "$WORK/phase3/narration.json"
jq '.registers | length' "$WORK/phase3/registers.json"
```

Do not call model-written prose a bug. A wrong **path** or **line range** would be a real
bug, because those come from the parser; a bland sentence is prose quality, and the fix
for that is a better `--model`.

A large `edgesDropped` is **normal** for dynamic and generic-tier languages — it is the
analyzer refusing to guess, not a failure.

Report: one paragraph per finding, each quoting the artifact it came from, then the
**narrowest** command that would fix it — a `--phase` subset with `--resume` wherever
possible, never a full regeneration when a partial one would do.
