# Round 3 — final adversarial review of the round-2 fixes (commit 9325007) + dryness sweep

Method: read every fixed site in current source; runtime-verified FENCE_RE, skeleton
normalization (reserved ids + cycles), the strategy-marker flow, CLI toInt, and the env clamps
against the built `dist/` (scratch harnesses, 40+ assertions, all green); full offline gauntlet
run. No source files modified.

---

## Fix verification (9 round-2 findings + 3 doc drifts)

| # | Round-2 finding | Verdict | Trace |
|---|---|---|---|
| 1 | Reserved stage ids destroy fixed pages | **OK** | `skeleton.ts:112-121` `RESERVED_STAGE_IDS` (the 7 suggested names **plus `handbook`** — covers the `--html-single` output too); `seen` pre-seeded (`:127`), case-insensitive while-suffix (`:135`). Runtime: all 8 reserved ids (mixed case) suffixed and unique; pathological collisions (`overview`, `overview-1`, `overview-1-2`, `overview`) terminate uniquely; fallback ids (`stage-N`/`crosscut-N`) intact and collision-suffixed. |
| 2 | Resync never deletes cards of deleted files | **OK** | `resync.ts:272-277` — `rmSync(work.cardPath(file), {force:true})` per `delta.deleted`, same `cardPath` used by `saveCard` (`workdir.ts:100-105`). Step-5/6 `work.loadCards()` (`:299`) runs after deletion, so organization, narration, and `extractRegisters` (`:363`) no longer see ghost cards. |
| 3 | FENCE_RE info-string misalignment | **OK** | `json-extract.ts:18` opener consumes the full info string (`([^\n`]*)`); tag = first word, only ``/`json`/`jsonc` parsed (`:22-23`). Runtime: ```` ```python title=x ```` and ```` ```c++ example ```` blocks skipped cleanly, the following ```` ```json ```` returned. |
| 4 | Four-backtick meta-fences leak examples | **OK** | Backtick run captured (`` (`{3,}) ``), closer requires same-or-longer run (`` \1`* ``). Runtime: 4-tick `md` block keeps its inner ```` ```json ```` example literal, real block wins; longer closing run accepted; unclosed 4-tick opener cannot backtrack into a 3-tick misparse (info string may not contain backticks) — falls to balanced scan, matching CommonMark. Offset-0, CRLF, indented, bare, and broken-then-valid fences all still correct. |
| 5 | Cycle-breaking detaches innocent descendants | **OK** | `skeleton.ts:158-171` detaches the node where the upward walk repeats (provably inside the cycle). Runtime: `[D→A, A→B, B→A]` keeps `D→A` in **both** array orders (round-2's order-dependence gone); 3-cycle with two innocent descendants keeps both legitimate edges, result acyclic; self-loops still nulled at `:153`. |
| 6 | Strategy not persisted; cross-strategy re-runs corrupt/no-op | **OK** (library) — residual at the CLI layer, see new finding 1 | `generate.ts:93-100`: marker read from `phase2/strategy.json`, `strategy = flag ?? stored ?? 'file'`, explicit-mismatch-without-2b **refused**; `:106` `needsLlm` short-circuits 2c+member; `:198` marker saved after 2b; `:202-204` member 2c logs "nothing to do". Runtime (7 cases): no-marker 2c throws needs-LLM; member-marker 2c with no client is a logged no-op; `--strategy file` vs member marker refused; switch allowed when 2b selected; phase 3 always needs LLM; garbage marker ignored. Demo work dir contains `{"strategy":"file"}` after a real 2b. |
| 7 | `HANDBOOK_LLM_MAX_RETRIES=0` → 6 attempts | **OK** | `client.ts:74` `Math.max(1, num(..., 6, 0))`. Runtime: `0`→1 attempt (clamped, not defaulted), `4`→4, unset/garbage/`-3`→6; `OPENAI_MAX_TOKENS=0`→16000; backoff `0`→0ms kept, NaN→3000ms. |
| 8 | CLI numeric flags NaN silently | **OK** | `main.ts:49-55` `toInt(value, flag, min)`; wired at `:103` (`--max-doctor-rounds`), `:104` (`--read-workers`), `:197` (`--max-turns`). Runtime: `--max-doctor-rounds six` and `--max-turns bogus` → loud `must be a number >= 1` error, exit 1, before any work runs. |
| 9 | Doctor round count off by one at the cap | **OK** | `doctor.ts:341-343` `roundsRun = round + 1` inside the loop, returned directly (`:370`); at cap exhaustion `rounds === maxRounds`, on break `rounds` = rounds actually run. |
| D1 | skill README "matched by pattern" | **OK** | `packages/skill/README.md` design notes now say "every root-level `.md` that is not a known top-level page (`overview.md`, `index.md`, `register(s).md`, …)"; no-recursion sentence retained. |
| D2 | formats.md presents `stage-N` as the format | **OK** | `docs/formats.md` skeleton block documents `^[A-Za-z0-9][A-Za-z0-9._-]*$`, demotes `stage-N` to "conventionally", and notes reserved-name auto-suffixing. |
| D3 | formats.md lists `register.md` unconditionally | **OK** | layout entry now reads `register.md … (only when registers exist)`. |

**Verdict: 12/12 OK — no regression found in any round-2 fix.** One fix (6) leaves a residual at
the CLI layer, recorded below; it does not reopen the corruption half of the original finding.

### Sweep answers (the specific knock-on questions)

- **generate.ts, no `--strategy` and no marker mid-2b:** resolves to `'file'` — identical to
  pre-fix default; 2b then writes the marker, so the window closes after the first post-fix run.
  The mismatch guard fires only when flag AND marker exist, differ, and 2b is not selected — correct.
- **skeleton.ts pre-seeded seen-set:** the suffix loop strictly lengthens the id each iteration
  (`id = id + '-' + (index+1)`), so it always terminates; fallback ids are unaffected (not in the
  reserved set) and collision-suffix correctly (runtime-verified).
- **resync deletion + staging:** staged phase-1 promotion (`resync.ts:374`) is **unconditional** —
  a pure-deletion delta (empty `refreshTargets`) still deletes cards, rebuilds assignment/
  organization, re-narrates (LLM mode), and promotes the baseline. In `noLlm` mode a pure deletion
  leaves registers stale until the next LLM pass — inherent to `noLlm`'s contract, not a defect.
- **FENCE_RE backtracking:** no exponential blowup. Worst case is quadratic (each failing opener
  scans to end-of-text); measured 0.59s on a 48KB adversarial near-miss-closer input, ≤0.21s on
  5k unclosed openers — negligible at LLM-reply sizes.

---

## New findings

1. **LOW — CLI still demands an API key for the no-LLM `--phase 2c` member no-op.**
   `packages/cli/src/main.ts:91,95`.
   *Defect:* `needsLlm = phase !== '1'` is still phase-based, and `llmClient()` (whose
   `OpenAiChatClient` constructor throws without a key, `client.ts:114-118`) is constructed
   eagerly before `generateHandbook` can consult the strategy marker. Runtime-confirmed: `handbook
   generate … --phase 2c` with no key dies with "no API key" before the work dir is even read —
   including on a member-strategy work dir where the library correctly needs no client (round-2
   finding 6, scenario B, survives at the CLI layer only; the corruption half is fully fixed).
   *Minimal fix:* pass a lazy client factory to `generateHandbook` (construct on first use), or
   have main.ts read `phase2/strategy.json` the same way `loadStrategyMarker` does before deciding
   `needsLlm`.

2. **LOW — renaming a reserved (or duplicate) stage id orphans its children.**
   `packages/pipeline/src/skeleton.ts:135,149-154`.
   *Defect/scenario (runtime-confirmed):* `normalizeSkeleton` renames stage `overview` →
   `overview-1`, but a stage declaring `parent: overview` is then dangling (the `ids` set holds
   only the new name) and is silently flattened to top level. Pre-existing for duplicate-id
   suffixing, but the round-2 fix widens exposure: reserved words like `overview` are plausible
   LLM choices for a *parent* stage. *Minimal fix:* record a rename map (raw id → final id) during
   the forEach and remap `stage.parent` through it before the dangling-parent pass.

3. **LOW — resync ignores the new strategy marker; member-strategy work dirs degrade silently.**
   `packages/resync/src/resync.ts` (no reference to members/strategy) +
   `packages/pipeline/src/member.ts:261-263`.
   *Scenario:* resync on a work dir generated with `--strategy member` rebuilds affected stages'
   organization as file-ordered "(resynced)" groups (`resync.ts:300-353`), discarding the
   member-derived grouping, and leaves `phase2/members.json` stale (deleted files' members still
   classified). Same silent-cross-strategy class the marker was introduced to prevent, via the
   other entry point. *Minimal fix:* read `phase2/strategy.json` in `resyncHandbook`; on `member`
   at minimum warn, ideally prune `members.json` of deleted files and re-derive affected stages
   via `deriveFileArtifacts`.

No HIGH or MED findings. Areas swept dry: FENCE_RE adversarial inputs (12 correctness + 5 timing
cases), normalizeSkeleton suffix/cycle edges (11 cases), strategy marker flow (7 cases),
doctor re-normalization idempotence over suffixed ids (suffixed ids are stable under sanitize and
not reserved, so re-normalization never renames them), resync deletion/staging/organization-dirty
interplay, env clamps.

---

## Gauntlet (all run this round, from repo root)

| Check | Result |
|---|---|
| `npx tsc -b` | exit 0, clean |
| `npx vitest run` | 18 files, **160/160 pass** (matches expected 160) |
| `npx eslint packages/*/src` | exit 0, no diagnostics |
| `bash examples/run-demo.sh` | full pipeline + render + skill + **`validate: OK`**, exit 0 |
