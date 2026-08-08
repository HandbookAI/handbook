#!/usr/bin/env bash
# End-to-end smoke test of the whole CLI surface — every subcommand, every
# configuration layer, and the refusals — driven against the bundled mock LLM.
#
#   pnpm run check:cli
#
# Why this exists alongside the unit tests: those mock `generateHandbook` and
# friends, so they cannot catch a flag that resolves correctly and is then never
# passed on, a wrong exit code, or an artifact contract that broke at the seam.
# This runs the REAL binary, end to end, and asserts on exit codes and artifacts.
#
# Entirely offline: the mock LLM server listens on 127.0.0.1 and no test needs an
# API key. Safe to run in CI, and fast enough to run before a release.
#
# Exit 0 = everything passed. Otherwise it prints each failure with a log path.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
HB="node $ROOT/packages/cli/dist/main.js"
OUT="$(mktemp -d)"
SRC="$ROOT/examples/demo-project"
PASS=0; FAIL=0
declare -a FAILURES=()

if [ ! -f "$ROOT/packages/cli/dist/main.js" ]; then
  echo "dist is missing — run \`pnpm build\` first" >&2
  exit 1
fi
t() { # t <name> <expected-exit> <cmd...>
  local name="$1" want="$2"; shift 2
  local log="$OUT/$(echo "$name" | tr ' /' '__').log"
  "$@" > "$log" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok   %-52s exit=%s\n' "$name" "$got"; PASS=$((PASS+1))
  else
    printf '  FAIL %-52s exit=%s want=%s\n' "$name" "$got" "$want"; FAIL=$((FAIL+1))
    FAILURES+=("$name (exit=$got want=$want) → $log")
  fi
}

echo "== mock LLM =="
node "$ROOT/examples/mock-llm-server.mjs" "${SMOKE_PORT:-8123}" >/dev/null 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
sleep 1
export OPENAI_BASE_URL="http://127.0.0.1:${SMOKE_PORT:-8123}/v1"
export OPENAI_API_KEY=EMPTY

echo
echo "== 1. help surfaces =="
t "handbook --help" 0 $HB --help
t "handbook --version" 0 $HB --version
for c in analyze generate render skill validate plan apply rollback resync studio config; do
  t "handbook $c --help" 0 $HB "$c" --help
done
t "unknown subcommand rejected" 1 $HB definitely-not-a-command

echo
echo "== 2. config resolution =="
t "config (default command)" 0 $HB config
t "config --command generate" 0 $HB config --command generate
t "config --command render" 0 $HB config --command render
t "config --json" 0 $HB config --json
t "config --check --command render (work unset → 2)" 2 $HB config --check --command render
t "config --check --command config (nothing required → 0)" 0 $HB config --check --command config
t "config --env prod" 0 $HB --env prod config --command generate
t "HANDBOOK_ENV_FILE missing → our own error" 1 env HANDBOOK_ENV_FILE=/nope/none.env $HB config
t "--env-file missing → node eats it first (exit 9)" 9 $HB --env-file /nope/none.env config
t "config --config missing → error" 1 $HB --config /nope/none.yaml config

echo
echo "== 3. required-ness and validation =="
t "analyze with no --source → 1" 1 $HB analyze --work "$OUT/w1"
t "analyze with bad --lang → 1" 1 $HB analyze --source "$SRC" --work "$OUT/w1" --lang klingon
t "generate bad --detail → 1" 1 $HB generate --source "$SRC" --work "$OUT/w1" --detail verbose
t "generate bad --phase → 1" 1 $HB generate --source "$SRC" --work "$OUT/w1" --phase 9
t "generate non-integer worker count → 1" 1 env HANDBOOK_READ_WORKERS=twelve $HB generate --source "$SRC" --work "$OUT/w1" --phase 1
t "analyze on an empty dir → 1" 1 $HB analyze --source "$OUT/empty" --work "$OUT/w-empty"

echo
echo "== 4. the no-LLM half =="
W="$OUT/work"
t "analyze" 0 $HB analyze --source "$SRC" --work "$W"
t "analyze --lang python" 0 $HB analyze --source "$SRC" --work "$OUT/w-py" --lang python
t "generate --phase 1 (no key needed)" 0 env -u OPENAI_API_KEY $HB generate --source "$SRC" --work "$OUT/w-p1" --phase 1

echo
echo "== 5. generation =="
t "generate --phase 2,3 --detail deep" 0 $HB generate --source "$SRC" --work "$W" --phase 2,3 --detail deep
t "generate --phase 3 (cache hit)" 0 $HB generate --source "$SRC" --work "$W" --phase 3
t "generate --phase 2a --resume" 0 $HB generate --source "$SRC" --work "$W" --phase 2a --resume
t "generate --narrate-lang zh --phase 3 --refresh" 0 $HB generate --source "$SRC" --work "$OUT/w-zh" --phase 1,2,3 --narrate-lang zh
t "generate --synth-mode doctor" 0 $HB generate --source "$SRC" --work "$OUT/w-doc" --phase 1,2,3 --synth-mode doctor --max-doctor-rounds 2
t "generate --llm-cache" 0 $HB generate --source "$SRC" --work "$OUT/w-cache" --phase 1,2a --llm-cache

echo
echo "== 6. render, all formats =="
t "render (markdown only)" 0 $HB render --work "$W" --title "Sweep"
t "render --html --html-single --agent-site --llms-txt" 0 $HB render --work "$W" --title "Sweep" --html --html-single --agent-site --llms-txt
t "render --source-base-url" 0 $HB render --work "$W" --title "Sweep" --source-base-url https://example.invalid/blob/main
t "render --out elsewhere" 0 $HB render --work "$W" --out "$OUT/rendered" --title "Sweep"
t "render on an empty work dir → 1" 1 $HB render --work "$OUT/w-p1" --title "x"

echo
echo "== 7. skill + validate =="
t "skill (with coverage + agent pages)" 0 $HB skill --handbook "$W/handbook" --out "$OUT/skill" --name sweep --project "Sweep" --work "$W" --source "$SRC" --agent-dir "$W/handbook/agent"
t "skill --lang zh" 0 $HB skill --handbook "$W/handbook" --out "$OUT/skill-zh" --name sweep --lang zh
t "skill without --work (no coverage)" 0 $HB skill --handbook "$W/handbook" --out "$OUT/skill-min" --name sweep
t "skill outDir == handbook → refused" 1 $HB skill --handbook "$W/handbook" --out "$W/handbook" --name sweep
t "skill on a non-handbook dir → 1" 1 $HB skill --handbook "$OUT" --out "$OUT/skill-bad" --name sweep
t "validate" 0 $HB validate --skill "$OUT/skill" --source "$SRC"
t "validate --lang zh package" 0 $HB validate --skill "$OUT/skill-zh"
t "validate a non-skill dir → 2" 2 $HB validate --skill "$OUT"

echo
echo "== 8. plan → apply → rollback =="
cp -R "$SRC" "$OUT/tree"
t "plan --out" 0 $HB plan --source "$OUT/tree" --handbook "$OUT/skill/references" --request "Add a module docstring to queue.py" --out "$OUT/plan.md" --max-turns 6
# The mock finishes with prose and no EDIT blocks — a legal "no change needed" plan,
# which exits 0. `apply` must then refuse it with 2 rather than pretend it applied.
t "apply --dry-run on a zero-edit plan → 2" 2 $HB apply --source "$OUT/tree" --plan "$OUT/plan.md" --dry-run
# A hand-written plan exercises apply/rollback deterministically, whatever the mock said.
mkdir -p "$OUT/t2" && printf 'ONE\nTWO\nTHREE\n' > "$OUT/t2/f.txt"
cat > "$OUT/hand.md" <<'PLAN'
### EDIT 1
- file: `f.txt`
- where: line 2

```old
TWO
```

```new
SECOND-LINE
```
PLAN
t "apply (hand-written plan)" 0 $HB apply --source "$OUT/t2" --plan "$OUT/hand.md"
t "apply again → no-match → 2" 2 $HB apply --source "$OUT/t2" --plan "$OUT/hand.md"
BACKUP="$(ls -1dt "$OUT/t2/.handbook-patches/"*/ 2>/dev/null | head -1)"
t "rollback" 0 $HB rollback --backup "$BACKUP" --source "$OUT/t2"
grep -q '^TWO$' "$OUT/t2/f.txt" && echo "  ok   rollback restored the original bytes" && PASS=$((PASS+1)) || { echo "  FAIL rollback did not restore"; FAIL=$((FAIL+1)); FAILURES+=("rollback bytes"); }
# ambiguous anchor must refuse
printf 'DUP\nDUP\n' > "$OUT/t2/d.txt"
cat > "$OUT/amb.md" <<'PLAN'
### EDIT 1
- file: `d.txt`
- where: ambiguous on purpose

```old
DUP
```

```new
CHANGED
```
PLAN
t "apply ambiguous anchor → 2" 2 $HB apply --source "$OUT/t2" --plan "$OUT/amb.md"
# path escape must refuse
cat > "$OUT/esc.md" <<'PLAN'
### EDIT 1
- file: `../escaped.txt`
- where: escape attempt

```old
```

```new
nope
```
PLAN
t "apply path escape → 2" 2 $HB apply --source "$OUT/t2" --plan "$OUT/esc.md"

echo
echo "== 9. resync =="
mkdir -p "$OUT/case" && cp -R "$SRC" "$OUT/case/edited"
t "resync --no-llm" 0 $HB resync --case "$OUT/case" --work "$W" --no-llm
t "resync (with mock LLM)" 0 $HB resync --case "$OUT/case" --work "$W"
t "resync --no-render" 0 $HB resync --case "$OUT/case" --work "$W" --no-llm --no-render
mkdir -p "$OUT/case2/edited" && : > "$OUT/case2/change.diff"
t "resync with an empty diff → skipped, exit 0" 0 $HB resync --case "$OUT/case2" --work "$W" --no-llm
t "resync with no edited/ → 1" 1 $HB resync --case "$OUT/nope" --work "$W" --no-llm

echo
echo "== 10. env + config-file layers =="
CFG="$OUT/proj"; mkdir -p "$CFG/.git" "$CFG/sub"
cp -R "$SRC" "$CFG/src"
cat > "$CFG/handbook.config.yaml" <<'YAML'
source: ./src
work: ./.handbook
generate:
  detail: deep
  narrateLang: en
render:
  title: From The Config File
YAML
cat > "$CFG/handbook.config.prod.yaml" <<'YAML'
source: ./src
work: ./.handbook-prod
render:
  title: From The PROD Config File
YAML
printf 'HANDBOOK_LOG_LEVEL=debug\n' > "$CFG/.env"
printf 'HANDBOOK_RENDER_TITLE=From The Prod Env File\n' > "$CFG/.env.prod"
( cd "$CFG" && $HB config --command render ) > "$OUT/cfgfile.log" 2>&1
grep -q "From The Config File" "$OUT/cfgfile.log" && { echo "  ok   config file supplies render.title"; PASS=$((PASS+1)); } || { echo "  FAIL config file title"; FAIL=$((FAIL+1)); FAILURES+=("config file title → $OUT/cfgfile.log"); }
( cd "$CFG/sub" && $HB config --command render ) > "$OUT/cfgwalk.log" 2>&1
grep -q "From The Config File" "$OUT/cfgwalk.log" && { echo "  ok   discovery walks up from a subdirectory"; PASS=$((PASS+1)); } || { echo "  FAIL discovery walk-up"; FAIL=$((FAIL+1)); FAILURES+=("walk-up → $OUT/cfgwalk.log"); }
( cd "$CFG" && $HB --env prod config --command render ) > "$OUT/cfgprod.log" 2>&1
grep -q "From The Prod Env File" "$OUT/cfgprod.log" && { echo "  ok   .env.prod outranks handbook.config.prod.yaml"; PASS=$((PASS+1)); } || { echo "  FAIL env precedence over prod config"; FAIL=$((FAIL+1)); FAILURES+=("env>file → $OUT/cfgprod.log"); }
( cd "$CFG" && HANDBOOK_RENDER_TITLE="From The Shell" $HB config --command render ) > "$OUT/cfgshell.log" 2>&1
grep -q "From The Shell" "$OUT/cfgshell.log" && { echo "  ok   shell env outranks the config file"; PASS=$((PASS+1)); } || { echo "  FAIL shell>file"; FAIL=$((FAIL+1)); FAILURES+=("shell>file → $OUT/cfgshell.log"); }
( cd "$CFG" && HANDBOOK_RENDER_TITLE="From The Shell" $HB config --command render --json ) > "$OUT/cfgflag.log" 2>&1
# secret masking
( cd "$CFG" && OPENAI_API_KEY=sk-supersecretvalue $HB config --command generate ) > "$OUT/cfgsecret.log" 2>&1
grep -q "supersecretvalue" "$OUT/cfgsecret.log" && { echo "  FAIL the api key leaked into config output"; FAIL=$((FAIL+1)); FAILURES+=("secret leak → $OUT/cfgsecret.log"); } || { echo "  ok   the api key is masked in config output"; PASS=$((PASS+1)); }
# secret in a config file must be refused
cat > "$CFG/handbook.config.yaml.bad" <<'YAML'
llm:
  apiKey: sk-nope
YAML
t "secret in a config file → refused" 1 env -C "$CFG" $HB --config "$CFG/handbook.config.yaml.bad" config

echo
echo "== 11. scoped env overrides =="
( cd "$CFG" && HANDBOOK_TITLE=Flat HANDBOOK_RENDER_TITLE=Scoped $HB config --command render ) > "$OUT/scoped.log" 2>&1
grep -q "Scoped" "$OUT/scoped.log" && { echo "  ok   scoped env beats flat env"; PASS=$((PASS+1)); } || { echo "  FAIL scoped>flat"; FAIL=$((FAIL+1)); FAILURES+=("scoped>flat → $OUT/scoped.log"); }
( cd "$CFG" && HANDBOOK_TITLE= $HB config --command render ) > "$OUT/empty.log" 2>&1
grep -q "From The Config File" "$OUT/empty.log" && { echo "  ok   an empty env value reads as unset"; PASS=$((PASS+1)); } || { echo "  FAIL empty-as-unset"; FAIL=$((FAIL+1)); FAILURES+=("empty-as-unset → $OUT/empty.log"); }

echo
echo "== 12. artifact sanity =="
node -e '
const { readFileSync, existsSync } = require("node:fs");
const W = process.argv[1];
const fail = [];
const g = JSON.parse(readFileSync(W + "/phase1/graph.json", "utf8"));
if (g.version !== 1) fail.push("graph version");
if (!g.metadata.scannedFiles.length) fail.push("no scanned files");
if (!g.metadata.fileHashes) fail.push("no per-file hashes");
if (!g.metadata.languages) fail.push("no per-language capabilities");
const cov = JSON.parse(readFileSync(W + "/phase2/cards/_coverage.json", "utf8"));
if (cov.nDescribed !== cov.nFiles) fail.push(`coverage ${cov.nDescribed}/${cov.nFiles}`);
const asg = JSON.parse(readFileSync(W + "/phase2/assignment.json", "utf8"));
if (asg.coverage.unassigned.length) fail.push("unassigned: " + asg.coverage.unassigned.join(","));
for (const f of ["phase2/skeleton.yaml","phase2/organization.yaml","phase2/strategy.json",
                 "phase3/narration.json","phase3/registers.json","run-manifest.json",
                 "handbook/overview.md","handbook/index.md",
                 "handbook/html/overview.html","handbook/handbook.html",
                 "handbook/agent/index.md","handbook/agent/how_to_use.md",
                 "handbook/agent/disambiguation.md","handbook/llms.txt","handbook/llms-full.txt"]) {
  if (!existsSync(W + "/" + f)) fail.push("missing " + f);
}
const man = JSON.parse(readFileSync(W + "/run-manifest.json", "utf8"));
if (!man.usage) fail.push("no token usage in the run manifest");
if (fail.length) { console.log("  FAIL " + fail.join(" | ")); process.exit(1); }
console.log("  ok   every artifact present and internally consistent");
' "$W" && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("artifact sanity"); }

node -e '
const { readFileSync, existsSync } = require("node:fs");
const S = process.argv[1];
const fail = [];
const skill = readFileSync(S + "/SKILL.md", "utf8");
if (!/^---\nname: sweep-handbook\n/.test(skill)) fail.push("frontmatter name");
if (!/Use when/.test(skill) || !/Do not use/.test(skill)) fail.push("routing contract");
for (const f of ["references/overview.md","references/index.md","references/registers.md",
                 "references/coverage.json","references/agent/how_to_use.md",
                 "references/agent/disambiguation.md"]) {
  if (!existsSync(S + "/" + f)) fail.push("missing " + f);
}
const cov = JSON.parse(readFileSync(S + "/references/coverage.json", "utf8"));
if (!cov.files.length || cov.files.some((f) => !f.sha256)) fail.push("coverage hashes");
if (fail.length) { console.log("  FAIL " + fail.join(" | ")); process.exit(1); }
console.log("  ok   the SKILL package satisfies its own contract");
' "$OUT/skill" && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("skill contract"); }

echo
echo "=============================================================="
echo "  passed: $PASS    failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "  failures:"
  for f in "${FAILURES[@]}"; do echo "   - $f"; done
fi
if [ "$FAIL" -eq 0 ]; then
  rm -rf "$OUT"
else
  echo "  logs kept at: $OUT"
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
