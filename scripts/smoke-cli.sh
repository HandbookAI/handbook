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
cd "$ROOT" || exit 1
# An array, not a string: every call site is a command position — including the
# four behind `env`, which execs a binary and so cannot call a shell function —
# and "${HB[@]}" passes the two words without relying on word splitting.
HB=(node "$ROOT/packages/cli/dist/main.js")
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
  local log
  log="$OUT/$(echo "$name" | tr ' /' '__').log"
  "$@" > "$log" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok   %-52s exit=%s\n' "$name" "$got"; PASS=$((PASS+1))
  else
    printf '  FAIL %-52s exit=%s want=%s\n' "$name" "$got" "$want"; FAIL=$((FAIL+1))
    FAILURES+=("$name (exit=$got want=$want) → $log")
  fi
}

# Inline assertions (for checks that grep a log rather than run a command).
# `if/else`, not `A && B || C`: in that idiom C also runs when A succeeds and B
# fails, which is a real trap even where it happens not to fire today.
pass_() { printf '  ok   %s\n' "$1"; PASS=$((PASS+1)); }
fail_() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL+1)); FAILURES+=("${2:-$1}"); }
# Assert a log does (or, with -v, does not) contain a pattern.
grep_ok() { # grep_ok [-v] <pattern> <file> <ok-message> <fail-detail>
  local want=0; if [ "$1" = "-v" ]; then want=1; shift; fi
  local pattern="$1" file="$2" message="$3" detail="$4"
  local hit=1
  grep -q "$pattern" "$file" && hit=0
  if [ "$hit" = "$want" ]; then pass_ "$message"; else fail_ "$message" "$detail"; fi
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
t "handbook --help" 0 "${HB[@]}" --help
t "handbook --version" 0 "${HB[@]}" --version
for c in analyze generate render skill validate plan apply rollback resync studio config; do
  t "handbook $c --help" 0 "${HB[@]}" "$c" --help
done
t "unknown subcommand rejected" 1 "${HB[@]}" definitely-not-a-command

echo
echo "== 2. config resolution =="
t "config (default command)" 0 "${HB[@]}" config
t "config --command generate" 0 "${HB[@]}" config --command generate
t "config --command render" 0 "${HB[@]}" config --command render
t "config --json" 0 "${HB[@]}" config --json
t "config --check --command render (work unset → 2)" 2 "${HB[@]}" config --check --command render
t "config --check --command config (nothing required → 0)" 0 "${HB[@]}" config --check --command config
t "config --env prod" 0 "${HB[@]}" --env prod config --command generate
t "HANDBOOK_ENV_FILE missing → our own error" 1 env HANDBOOK_ENV_FILE=/nope/none.env "${HB[@]}" config
t "--env-file missing → node eats it first (exit 9)" 9 "${HB[@]}" --env-file /nope/none.env config
# Showing broken configuration is `config`'s entire job, so a config file it
# could not read is DISPLAYED, not fatal — the person running this is running it
# because something is wrong. `--check` is the one that renders a verdict.
t "config --config missing → shown, not fatal" 0 "${HB[@]}" --config /nope/none.yaml config
"${HB[@]}" --config /nope/none.yaml config > "$OUT/cfgmissing.log" 2>&1 || true
grep_ok "NOT LOADED" "$OUT/cfgmissing.log" \
  "a config file that could not be read is marked NOT LOADED" "silently ignored → $OUT/cfgmissing.log"
grep_ok "ENOENT" "$OUT/cfgmissing.log" \
  "and the reason it could not be read is named" "no reason given → $OUT/cfgmissing.log"
t "config --check with an unreadable config file → 2" 2 "${HB[@]}" --config /nope/none.yaml config --check
# The safety-critical half: every OTHER command must still refuse to run on a
# config file it could not read, rather than quietly falling back to defaults.
t "analyze with an unreadable config file → 1" 1 "${HB[@]}" --config /nope/none.yaml analyze --source "$SRC" --work "$OUT/wcfg"

echo
echo "== 3. required-ness and validation =="
t "analyze with no --source → 1" 1 "${HB[@]}" analyze --work "$OUT/w1"
t "analyze with bad --lang → 1" 1 "${HB[@]}" analyze --source "$SRC" --work "$OUT/w1" --lang klingon
t "generate bad --detail → 1" 1 "${HB[@]}" generate --source "$SRC" --work "$OUT/w1" --detail verbose
t "generate bad --phase → 1" 1 "${HB[@]}" generate --source "$SRC" --work "$OUT/w1" --phase 9
t "generate non-integer worker count → 1" 1 env HANDBOOK_READ_WORKERS=twelve "${HB[@]}" generate --source "$SRC" --work "$OUT/w1" --phase 1
t "analyze on an empty dir → 1" 1 "${HB[@]}" analyze --source "$OUT/empty" --work "$OUT/w-empty"

echo
echo "== 4. the no-LLM half =="
W="$OUT/work"
t "analyze" 0 "${HB[@]}" analyze --source "$SRC" --work "$W"
t "analyze --lang python" 0 "${HB[@]}" analyze --source "$SRC" --work "$OUT/w-py" --lang python
t "generate --phase 1 (no key needed)" 0 env -u OPENAI_API_KEY "${HB[@]}" generate --source "$SRC" --work "$OUT/w-p1" --phase 1

echo
echo "== 5. generation =="
t "generate --phase 2,3 --detail deep" 0 "${HB[@]}" generate --source "$SRC" --work "$W" --phase 2,3 --detail deep
t "generate --phase 3 (cache hit)" 0 "${HB[@]}" generate --source "$SRC" --work "$W" --phase 3
t "generate --phase 2a --resume" 0 "${HB[@]}" generate --source "$SRC" --work "$W" --phase 2a --resume
t "generate --narrate-lang zh --phase 3 --refresh" 0 "${HB[@]}" generate --source "$SRC" --work "$OUT/w-zh" --phase 1,2,3 --narrate-lang zh
t "generate --synth-mode doctor" 0 "${HB[@]}" generate --source "$SRC" --work "$OUT/w-doc" --phase 1,2,3 --synth-mode doctor --max-doctor-rounds 2
t "generate --llm-cache" 0 "${HB[@]}" generate --source "$SRC" --work "$OUT/w-cache" --phase 1,2a --llm-cache

echo
echo "== 6. render, all formats =="
t "render (markdown only)" 0 "${HB[@]}" render --work "$W" --title "Sweep"
t "render --html --html-single --agent-site --llms-txt" 0 "${HB[@]}" render --work "$W" --title "Sweep" --html --html-single --agent-site --llms-txt
t "render --source-base-url" 0 "${HB[@]}" render --work "$W" --title "Sweep" --source-base-url https://example.invalid/blob/main
t "render --out elsewhere" 0 "${HB[@]}" render --work "$W" --out "$OUT/rendered" --title "Sweep"
t "render on an empty work dir → 1" 1 "${HB[@]}" render --work "$OUT/w-p1" --title "x"

echo
echo "== 7. skill + validate =="
t "skill (with coverage + agent pages)" 0 "${HB[@]}" skill --handbook "$W/handbook" --out "$OUT/skill" --name sweep --project "Sweep" --work "$W" --source "$SRC" --agent-dir "$W/handbook/agent"
t "skill --lang zh" 0 "${HB[@]}" skill --handbook "$W/handbook" --out "$OUT/skill-zh" --name sweep --lang zh
t "skill without --work (no coverage)" 0 "${HB[@]}" skill --handbook "$W/handbook" --out "$OUT/skill-min" --name sweep
t "skill outDir == handbook → refused" 1 "${HB[@]}" skill --handbook "$W/handbook" --out "$W/handbook" --name sweep
t "skill on a non-handbook dir → 1" 1 "${HB[@]}" skill --handbook "$OUT" --out "$OUT/skill-bad" --name sweep
t "validate" 0 "${HB[@]}" validate --skill "$OUT/skill" --source "$SRC"
t "validate --lang zh package" 0 "${HB[@]}" validate --skill "$OUT/skill-zh"
t "validate a non-skill dir → 2" 2 "${HB[@]}" validate --skill "$OUT"

echo
echo "== 8. plan → apply → rollback =="
cp -R "$SRC" "$OUT/tree"
t "plan --out" 0 "${HB[@]}" plan --source "$OUT/tree" --handbook "$OUT/skill/references" --request "Add a module docstring to queue.py" --out "$OUT/plan.md" --max-turns 6
# The mock finishes with prose and no EDIT blocks — a legal "no change needed" plan,
# which exits 0. `apply` must then refuse it with 2 rather than pretend it applied.
t "apply --dry-run on a zero-edit plan → 2" 2 "${HB[@]}" apply --source "$OUT/tree" --plan "$OUT/plan.md" --dry-run
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
t "apply (hand-written plan)" 0 "${HB[@]}" apply --source "$OUT/t2" --plan "$OUT/hand.md"
t "apply again → no-match → 2" 2 "${HB[@]}" apply --source "$OUT/t2" --plan "$OUT/hand.md"
# shellcheck disable=SC2012  # this tree is ours: mktemp -d plus a fixed
# layout, so there are no newlines or globs in the names for `find` to save us
# from, and `ls -t` is the shortest correct way to take the newest.
BACKUP="$(ls -1dt "$OUT/t2/.handbook-patches/"*/ 2>/dev/null | head -1)"
t "rollback" 0 "${HB[@]}" rollback --backup "$BACKUP" --source "$OUT/t2"
grep_ok '^TWO$' "$OUT/t2/f.txt" "rollback restored the original bytes" "rollback bytes"
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
t "apply ambiguous anchor → 2" 2 "${HB[@]}" apply --source "$OUT/t2" --plan "$OUT/amb.md"
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
t "apply path escape → 2" 2 "${HB[@]}" apply --source "$OUT/t2" --plan "$OUT/esc.md"

echo
echo "== 9. resync =="
mkdir -p "$OUT/case" && cp -R "$SRC" "$OUT/case/edited"
t "resync --no-llm" 0 "${HB[@]}" resync --case "$OUT/case" --work "$W" --no-llm
t "resync (with mock LLM)" 0 "${HB[@]}" resync --case "$OUT/case" --work "$W"
t "resync --no-render" 0 "${HB[@]}" resync --case "$OUT/case" --work "$W" --no-llm --no-render
mkdir -p "$OUT/case2/edited" && : > "$OUT/case2/change.diff"
t "resync with an empty diff → skipped, exit 0" 0 "${HB[@]}" resync --case "$OUT/case2" --work "$W" --no-llm
t "resync with no edited/ → 1" 1 "${HB[@]}" resync --case "$OUT/nope" --work "$W" --no-llm

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
( cd "$CFG" && "${HB[@]}" config --command render ) > "$OUT/cfgfile.log" 2>&1
grep_ok "From The Config File" "$OUT/cfgfile.log" "config file supplies render.title" "config file title → $OUT/cfgfile.log"
( cd "$CFG/sub" && "${HB[@]}" config --command render ) > "$OUT/cfgwalk.log" 2>&1
grep_ok "From The Config File" "$OUT/cfgwalk.log" "discovery walks up from a subdirectory" "walk-up → $OUT/cfgwalk.log"
( cd "$CFG" && "${HB[@]}" --env prod config --command render ) > "$OUT/cfgprod.log" 2>&1
grep_ok "From The Prod Env File" "$OUT/cfgprod.log" ".env.prod outranks handbook.config.prod.yaml" "env>file → $OUT/cfgprod.log"
( cd "$CFG" && HANDBOOK_RENDER_TITLE="From The Shell" "${HB[@]}" config --command render ) > "$OUT/cfgshell.log" 2>&1
grep_ok "From The Shell" "$OUT/cfgshell.log" "shell env outranks the config file" "shell>file → $OUT/cfgshell.log"
( cd "$CFG" && HANDBOOK_RENDER_TITLE="From The Shell" "${HB[@]}" config --command render --json ) > "$OUT/cfgflag.log" 2>&1
# secret masking
( cd "$CFG" && OPENAI_API_KEY=sk-supersecretvalue "${HB[@]}" config --command generate ) > "$OUT/cfgsecret.log" 2>&1
grep_ok -v "supersecretvalue" "$OUT/cfgsecret.log" "the api key is masked in config output" "secret leak → $OUT/cfgsecret.log"
# secret in a config file must be refused
cat > "$CFG/handbook.config.yaml.bad" <<'YAML'
llm:
  apiKey: sk-nope
YAML
t "secret in a config file → shown, not fatal, by config" 0 env -C "$CFG" "${HB[@]}" --config "$CFG/handbook.config.yaml.bad" config
env -C "$CFG" "${HB[@]}" --config "$CFG/handbook.config.yaml.bad" config > "$OUT/cfgbadsecret.log" 2>&1 || true
grep_ok "must not appear in a config file" "$OUT/cfgbadsecret.log" \
  "a secret in a config file is named and explained" "not reported → $OUT/cfgbadsecret.log"
# Invariant 7 is about REFUSING, and the refusal lives on the commands that
# would act on it. `config` only ever displays.
t "secret in a config file → refused by every other command" 1 \
  env -C "$CFG" "${HB[@]}" --config "$CFG/handbook.config.yaml.bad" analyze --source "$SRC" --work "$OUT/wsec"
t "secret in a config file → --check says no" 2 \
  env -C "$CFG" "${HB[@]}" --config "$CFG/handbook.config.yaml.bad" config --check

echo
echo "== 11. scoped env overrides =="
( cd "$CFG" && HANDBOOK_TITLE=Flat HANDBOOK_RENDER_TITLE=Scoped "${HB[@]}" config --command render ) > "$OUT/scoped.log" 2>&1
grep_ok "Scoped" "$OUT/scoped.log" "scoped env beats flat env" "scoped>flat → $OUT/scoped.log"
( cd "$CFG" && HANDBOOK_TITLE='' "${HB[@]}" config --command render ) > "$OUT/empty.log" 2>&1
grep_ok "From The Config File" "$OUT/empty.log" "an empty env value reads as unset" "empty-as-unset → $OUT/empty.log"

echo
echo "== 12. artifact sanity =="
# shellcheck disable=SC2016  # a literal JS program: single quotes are what
# keep $ and ` out of it.
if node -e '
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
                 "handbook/agent/index.md","handbook/agent/symbols.tsv",
                 "handbook/agent/files.tsv","handbook/agent/calls.tsv",
                 "handbook/llms.txt","handbook/llms-full.txt"]) {
  if (!existsSync(W + "/" + f)) fail.push("missing " + f);
}
// Existence is not enough for a fact table: an empty one answers "no such
// symbol" rather than "this file was never written", which is the failure the
// whole artifact exists to avoid. Check it actually carries rows, and that a
// location looks like a location.
const symbols = readFileSync(W + "/handbook/agent/symbols.tsv", "utf8")
  .split("\n").filter((l) => l && !l.startsWith("#"));
if (!symbols.length) fail.push("symbols.tsv has no rows");
const badLoc = symbols.find((l) => !/^[^\t]+\t[^\t]+:\d+-\d+\t/.test(l));
if (badLoc) fail.push("symbols.tsv row has no path:start-end — " + badLoc.slice(0, 60));
// The index is the one file assumed always-loaded; its budget is a product
// decision, not an accident.
const idx = readFileSync(W + "/handbook/agent/index.md", "utf8");
if (Buffer.byteLength(idx) > 4096) fail.push("agent/index.md over its 4 KB cap: " + Buffer.byteLength(idx));
if (!/## lookup/.test(idx)) fail.push("agent/index.md has no lookup recipes");
const man = JSON.parse(readFileSync(W + "/run-manifest.json", "utf8"));
if (!man.usage) fail.push("no token usage in the run manifest");
if (fail.length) { console.log("  FAIL " + fail.join(" | ")); process.exit(1); }
console.log("  ok   every artifact present and internally consistent");
' "$W"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILURES+=("artifact sanity"); fi

# shellcheck disable=SC2016  # as above: a literal JS program.
if node -e '
const { readFileSync, existsSync } = require("node:fs");
const S = process.argv[1];
const fail = [];
const skill = readFileSync(S + "/SKILL.md", "utf8");
if (!/^---\nname: sweep-handbook\n/.test(skill)) fail.push("frontmatter name");
if (!/Use when/.test(skill) || !/Do not use/.test(skill)) fail.push("routing contract");
for (const f of ["references/overview.md","references/index.md","references/registers.md",
                 "references/coverage.json","references/agent/index.md",
                 "references/agent/symbols.tsv","references/agent/files.tsv",
                 "references/agent/calls.tsv"]) {
  if (!existsSync(S + "/" + f)) fail.push("missing " + f);
}
// The delivery channel this guards: `buildSkill` probed for a file the renderer
// had stopped writing, so every skill shipped without its agent index — with no
// error, because an absent artifact is a supported configuration.
if (!/references\/agent\/symbols\.tsv/.test(skill)) fail.push("SKILL.md does not route to the fact tables");
const cov = JSON.parse(readFileSync(S + "/references/coverage.json", "utf8"));
if (!cov.files.length || cov.files.some((f) => !f.sha256)) fail.push("coverage hashes");
if (fail.length) { console.log("  FAIL " + fail.join(" | ")); process.exit(1); }
console.log("  ok   the SKILL package satisfies its own contract");
' "$OUT/skill"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILURES+=("skill contract"); fi

echo
echo "== Ctrl-C =="
# A real SIGINT to a real run. Cancellation is only observable in a process that
# actually has signals: a unit test can assert an AbortSignal propagates, but it
# cannot prove the CLI installs a handler, that the run unwinds instead of
# hanging, or that the shell sees 130 rather than a stack trace and exit 1.
SIGINT_WORK="$OUT/sigint"
# A source big enough that the run cannot finish before the signal arrives. The
# demo project completes against the mock LLM in a couple of seconds, and a
# signal delivered to an already-finished run proves nothing — it just passes.
"${HB[@]}" generate --source "$ROOT/packages" --work "$SIGINT_WORK" > "$OUT/sigint.log" 2>&1 &
CANCELLED=$!
# Wait for evidence the run is genuinely under way rather than sleeping a fixed
# guess: a fixed sleep is either too short (signal lands during startup) or too
# long (the run finished) depending on the machine.
for _ in $(seq 1 60); do
  if grep -q "scan\|phase\|LLM" "$OUT/sigint.log" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! kill -0 "$CANCELLED" 2>/dev/null; then
  # Report it rather than signalling a corpse and calling that a pass.
  fail_ "SIGINT lands on a live run" "the run finished before it could be signalled → $OUT/sigint.log"
fi
kill -INT "$CANCELLED" 2>/dev/null
# Wait, but not forever: hanging IS the failure this guards against, and a smoke
# suite that hangs tells nobody anything.
SIGINT_EXIT=""
for _ in $(seq 1 40); do
  if ! kill -0 "$CANCELLED" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$CANCELLED" 2>/dev/null; then
  kill -9 "$CANCELLED" 2>/dev/null
  fail_ "SIGINT stops the run" "still running 20s after SIGINT — the handler did not unwind"
else
  wait "$CANCELLED"; SIGINT_EXIT=$?
  if [ "$SIGINT_EXIT" = "130" ]; then
    pass_ "SIGINT exits 130 (128+SIGINT), not 0 and not a crash"
  else
    fail_ "SIGINT exits 130" "got exit=$SIGINT_EXIT → $OUT/sigint.log"
  fi
fi
grep_ok "cancelling" "$OUT/sigint.log" \
  "the first Ctrl-C says it is cancelling, and how to force" "no cancelling notice → $OUT/sigint.log"
# A cancelled run is not a crash. A stack trace tells the user they hit a bug
# when they hit Ctrl-C.
grep_ok -v "handbook: error:" "$OUT/sigint.log" \
  "a cancelled run does not report itself as an error" "printed an error → $OUT/sigint.log"
# Invariant 5: a run that gave up must not leave an artifact claiming success.
if [ -f "$SIGINT_WORK/run-manifest.json" ]; then
  fail_ "a cancelled run writes no run manifest" "run-manifest.json exists in $SIGINT_WORK"
else
  pass_ "a cancelled run writes no run manifest"
fi

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
