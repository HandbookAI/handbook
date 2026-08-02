# Round 2 — adversarial review of the round-1 fixes (commit 63d1511) + fresh scan

Method: read every fixed site in current source; runtime-verified the concurrency, JSON-extraction
and skeleton-normalization edges against the built `dist/`; full suite run twice independently
(18 files, **156/156 pass**, matching the commit's "156 total"). Doc claims cross-checked against
code by a dedicated sub-audit and spot-checked. No source files modified.

---

## Fix verification

### round1-pipeline.md (10 findings)

1. **skill flat-layout filter — OK.** `build.ts:46-54,115-133`: pattern filter replaced by
   copy-everything-except-`NON_STAGE_PAGES` (case-insensitive, includes `readme.md`), non-recursive
   so `agent/`/`html/` copies are not double-collected; `handbook.html` is not `.md` and is ignored.
   `validate.ts:87-93` now errors on index links whose stage page is missing, closing the silent
   half. SKILL.md is written before the reference copies (`build.ts:90`) but its body is static
   (never enumerates pages), so ordering is immaterial. Residual: the `known` set in the validator
   masks the reserved-id collision — see New finding 1.
2. **resync baseline destroyed before completion — OK.** `resync.ts:193-207`: fresh phase-1 goes to
   `<case>/.resync-phase1`; the delta is computed staging-vs-stored; promotion (`cpSync` staging →
   `work.phase1Dir`) happens LAST (`:367-370`). A crash anywhere in steps 3-6 leaves the old
   baseline in place, so a re-run recomputes the same delta and the already-written cards/assignment
   make the retry idempotent. If `cpSync` itself fails, steps 3-6 are committed but the baseline
   isn't — the next run just redoes them (idempotent). `writeGraphArtifacts` (analyzer
   `graph.ts:236-241`) always writes all four phase-1 files, so the recursive overwrite-copy leaves
   no stale artifact behind.
3. **noLlm resync wipes function prose — OK.** `resync.ts:239-243` now calls
   `mergeFunctionNotes(inventory[file] ?? [], old?.functions ?? [])`. Verified the call shape:
   `mergeFunctionNotes` (`cards.ts:173-197`) treats `llmFns` as `unknown`, keys by
   qualname (leaf-name fallback), reads `purpose` (`|| note`), `relations`, and `dataFlow` via the
   `hit?.data_flow ?? hit?.dataFlow` fallback (`cards.ts:193`) — so passing old camelCase
   `FunctionNote[]` preserves all three prose fields onto the fresh structural inventory.
   Brief cards (`old.functions` undefined) are left brief (`:241` guard).
4. **onlyFiles coverage lies — OK.** `cards.ts:383-407`: the backfill loop now treats an existing
   card with empty `purpose` as `missing` without rewriting it (first `continue` branch keeps
   described cards; second branch counts-but-preserves empty ones). Preloaded out-of-scope cards
   with prose are never rewritten (no clobber); previously-backfilled empty cards stay in
   `missing`, so the drift signal survives resync subset passes.
5. **deleted files' former stages missing from report — OK.** `resync.ts:267-270` captures
   `deletedStages` from the pre-deletion assignment (excluding `unassigned`) and seeds
   `affectedStages` with them (`:285`).
6. **fallback narration cached — OK.** `narrate.ts:88-104`: `succeeded` is set only when
   `produce()` returns non-empty text; the cache write is gated on it, so fallback (and empty-LLM)
   prose is retried next run. Legacy poisoned cache files from before the fix are still honored,
   but that is data, not code.
7. **zero-register handbook can't validate — OK.** `build.ts:105-113` synthesizes a stub
   `references/registers.md` when neither `registers.md` nor `register.md` exists;
   `validate.ts:67-69`'s unconditional requirement is now always satisfiable.
8. **resume breaks onlyFiles — OK.** `cards.ts:261-263`: `todo = todo.filter(...)` filters the
   already-restricted list.
9. **stale-marker accumulation — OK.** `resync.ts:235-236` guards with
   `!old.purpose.endsWith(STALE_SUFFIX)`.
10. **planner misparses prose plans — OK.** `planner.ts:115-127`: a reply containing `### EDIT`
    is taken as the plan unless the parsed action is an explicit `finish`. Traced the asked
    scenario: a `finish` action whose `plan` contains `### EDIT` → `looksLikePlan` is true but
    `action.tool === 'finish'` falsifies the override clause, so control reaches `:130-133` and it
    **finishes normally with `action.plan`**. Prose plans whose declarations `json` block parses
    (no `tool` key) also land in the plan branch. Interplay bonus: the new FENCE_RE skips the
    plan's ```old/```new fences as non-JSON candidates. Accepted trade-off: a non-finish tool
    action accompanied by `### EDIT` prose ends the loop early — consistent with the protocol's
    "output ONLY the action block" (`prompt.ts:89-102`).

### round1-analyzer.md (11 findings)

1. **Go sibling-file calls — OK.** `go.ts`: per-directory `packageFunctions` index built in
   `analyze()` (first definition wins — duplicate free functions in one package are illegal Go),
   consulted in `resolveCall` case A after the same-file check. Regression test present and green.
2. **FENCE_RE misalignment — OK for the stated failure; small residual gap remains.**
   `json-extract.ts:15-30`: line-anchored opener with captured tag; non-json/jsonc tags are
   consumed and skipped. Runtime-verified: ```python-before-```json returns the verdict object;
   fence at offset 0 works; `\r\n` works (JS multiline `$` matches before `\r`); trailing fence
   without final newline works. Residuals → New findings 3 and 4.
3. **StageTree.subtree infinite recursion — OK.** `model.ts:264-274`: `if (keep.has(sid)) return;`
   guard. `depth`/`ancestors` were already seen-guarded; renderers are now cycle-safe end-to-end.
4. **Python module-alias B3 — OK.** `python.ts:458-462`: after the `classToModule` miss, checks
   `moduleIds.has(imported) && moduleFunctions.get(imported)?.has(attr)` → `internal_func`,
   exactly the suggested fix. Regression test green.
5. **TS readonly parameter properties — OK.** `typescript.ts:214-217`: accepts
   `accessibility_modifier`, node type `readonly`, or text `readonly`.
6. **pLimit soft cap — OK, runtime-verified.** `concurrency.ts:19-36`: `release()` hands the slot
   to the next waiter WITHOUT decrementing `active`; the waiter does not re-increment. Verified at
   runtime: cap of 1 holds against a microtask-gap interloper (max concurrent = 1); rejecting and
   synchronously-throwing tasks release their slot via `finally`; `active` bookkeeping is exact
   after queue drain (burst of cap-many runs fully parallel afterwards); FIFO preserved; `mapLimit`
   rejects after all settle. No starvation: transfers are strictly FIFO and every completion either
   wakes exactly one waiter or decrements.
7. **register dead links — OK, all three renderers.** markdown `renderRegisterTable`
   (`markdown.ts:88-98`) links only `hasPage(sid)` = `view.hasContent(sid)` (false for ghost ids —
   `StageTree.children` of an unknown id is `[]`, bucket undefined); html `registerTableHtml`
   (`html.ts:293-304`) is shared by register.html (`:347`) and the single-page `#sid` anchors
   (`:410`) with the same guard; page-written ⇔ hasContent, so link ⇔ page exists. agent-site was
   already correct (`agent-site.ts:369-371` unchanged, `written` = contentStages).
8. **stage-id path escape — OK, two layers.** `stageSchema.id` regex
   `^[A-Za-z0-9][A-Za-z0-9._-]*$` (`model.ts:92-98`) rejects `/` and leading dots at every
   artifact load (all CLI render paths go through `loadSkeleton`/`parseSkeletonYaml`);
   `sanitizeStageId` (`skeleton.ts:99-105`) cleans LLM output at creation. Runtime-verified:
   `../escape` → `escape`, `..` → fallback id; sanitize collisions get `-N` suffixes and always
   terminate; sanitize is idempotent so doctor re-normalization never renames stable ids.
   Residuals → New findings 1 and 5.
9. **retry `throw undefined` / NaN env — OK.** `retry.ts:22-27` clamps attempts to ≥1 (trunc,
   NaN→default) and floors backoff/jitter at 0; `client.ts:63-74` validates all numeric env with
   min bounds. Residual semantic quirk → New finding 8.
10. **entry-point dedup — OK.** `navpack.ts:81-95` keys by `node.id`; two `main`s in different
    files both survive.
11. **synthesized `.py` paths — OK.** `buildGraph` default ext is now `''`; `runPhase1`
    (`phase1.ts:74-80`) passes the analyzed language's first extension (`''` for `multi`); the
    synthesized signature comment is language-neutral (`graph.ts:158-161`).

**Verdict: 21/21 OK — no regression found in any fix.** Two fixes carry small residual gaps
(findings 1, 3, 4 below); none reopens the original failure.

---

## New findings

1. **MED — reserved stage ids silently destroy fixed pages / lose stage content.**
   `packages/pipeline/src/skeleton.ts:99-105` + `packages/renderer/src/markdown.ts:182-192` +
   `packages/skill/src/build.ts:46-54` + `packages/skill/src/validate.ts:88`.
   *Defect:* neither `stageSchema` nor `sanitizeStageId`/`normalizeSkeleton` reserves the fixed
   page names. Runtime-verified: `normalizeSkeleton` passes ids `overview` and `index` through
   unchanged. *Scenario:* an LLM- or user-authored stage id `overview` writes its stage page to
   `overview.md` (`markdown.ts:182`), which `write('overview.md', …)` then overwrites (`:184`) —
   stage content silently gone, and `index.md` links `[Title](overview.md)` to the wrong page. Id
   `index` is worse: the stage index overwrites the stage page (`:192`). In the skill,
   `NON_STAGE_PAGES` drops such pages, and the validator's `known` set (`validate.ts:88`) skips
   exactly these names in the link check, so the loss is invisible end-to-end. Same class applies
   to `register`, `registers`, and (agent site) `how_to_use`/`disambiguation`
   (`agent-site.ts:417-422`). *Minimal fix:* in `normalizeSkeleton`, treat
   `{overview,index,register,registers,how_to_use,disambiguation,readme}` (case-insensitive) as
   colliding and suffix them like duplicate ids; optionally add the same denylist to
   `stageSchema.id.refine`.

2. **MED — resync never deletes the cards of deleted files; stale cards leak into register
   extraction.** `packages/resync/src/resync.ts:271-273` (only `fileStage` is cleaned) +
   `packages/pipeline/src/narrate.ts:250-256`.
   *Defect:* `phase2/cards/<deleted>.json` stays on disk forever; `work.loadCards()` keeps
   returning it. *Scenario:* delete `models/schema.py` (role `data_model`), resync; step 6's
   `extractRegisters` builds its evidence from `Object.values(cards)` filtered by role — the
   deleted file is still listed as a live `data_model` file, so registers can be extracted from
   (and cite) code that no longer exists. Subsequent `generateCards` onlyFiles passes also preload
   the ghost card (harmless for coverage — only graph files are counted — but the rot compounds).
   *Minimal fix:* in step 4, `rmSync(work.cardPath(file), {force:true})` for each `delta.deleted`
   file (or filter `loadCards()` by `graph.metadata.scannedFiles` before narration/registers).

3. **LOW — FENCE_RE still misaligns on fences with info strings.**
   `packages/core/src/util/json-extract.ts:15`.
   *Defect:* an opener like ```` ```python title=x ```` (or ```` ```c++ ````) fails the opener
   pattern, so that block's *closing* fence is consumed as an untagged opener — the round-1
   failure mode reappears for info-stringed fences. Runtime-confirmed:
   `'```python title=x\n[9, 9]\n``` … ```json\n{"want":true}\n```'` → `extractJsonBlock` returns
   `[9,9]`, not `{"want":true}`. *Minimal fix:* let the opener consume a full info string —
   `^[ \t]*```([^\n`]*)\r?\n…` — and parse only when the first word of the tag is
   empty/`json`/`jsonc`.

4. **LOW — four-backtick meta-fences leak their example blocks.**
   `packages/core/src/util/json-extract.ts:15-28`.
   *Defect/scenario (runtime-confirmed):* in
   ` ````md … ```json {"inner":true} ``` … ```` ` followed by a real ```` ```json ```` block,
   the inner *example* is returned (`{"inner":true}`) because the regex sees only 3-backtick
   fences; CommonMark says the inner fence is literal content of the 4-backtick block. Rare (model
   quoting a fenced example before answering). *Minimal fix:* match the opener's backtick run
   (`(`{3,})`) and require the same-or-longer run to close, skipping shorter runs inside.

5. **LOW — cycle-breaking detaches innocent descendants, order-dependently.**
   `packages/pipeline/src/skeleton.ts:141-152`.
   *Defect:* the upward walk nulls the parent of the stage being *processed*, not a member of the
   cycle. Runtime-confirmed: stages `[D(parent A), A(parent B), B(parent A)]` → `D.parent = null`
   (legitimate D→A edge severed because D precedes the cycle in array order); with D listed after
   A the same input keeps `D→A`. Only reachable on already-broken input; result is valid, just
   flatter than necessary. *Minimal fix:* when a repeat is found, null the parent of the first
   node of the walk that is itself inside the cycle (the node where `cursor` repeats), not
   `stage`.

6. **LOW — pipeline strategy is not persisted; cross-strategy phase re-runs corrupt or no-op.**
   `packages/pipeline/src/generate.ts:141-142,186,91-93` + `packages/cli/src/main.ts:88`.
   *Scenario A:* after a member-strategy run (2b wrote the deterministic member organization),
   `handbook generate --phase 2c` *without* `--strategy member` (the default is `file`) runs
   `organizeStages` and silently overwrites the member-derived organization with LLM grouping.
   *Scenario B:* `--phase 2c --strategy member` demands an API key (`needsLlm` is phase-based),
   loads the graph, then does nothing — a silent no-op. *Minimal fix:* record `strategy` in a
   work-dir marker at 2b and warn/refuse on mismatch; short-circuit `needsLlm` when the selected
   phases have no LLM work for the strategy.

7. **LOW — CLI numeric options are unvalidated; NaN silently disables the doctor.**
   `packages/cli/src/main.ts:94,95,188`.
   *Scenario:* `--max-doctor-rounds six` → `Number('six') = NaN` → `synthesizeWithDoctor`'s loop
   condition `round < NaN` is false (`doctor.ts:342`) — zero doctor rounds, no warning, output
   looks normal. `plan --max-turns x` → NaN → immediately returns "(planner reached the turn
   limit…)" (`planner.ts:109`). `--read-workers x` at least fails loudly (`pLimit` RangeError,
   `concurrency.ts:10-12`). *Minimal fix:* a `toInt(flag, default, min)` helper in main.ts that
   rejects/falls back on NaN (mirror `resolveLlmEnv.num`).

8. **LOW — `HANDBOOK_LLM_MAX_RETRIES=0` now yields MORE attempts than any positive value.**
   `packages/llm/src/client.ts:63-66,72`.
   *Defect:* `num(raw, 6, 1)` treats `0` as invalid and falls back to the default **6**, so a user
   explicitly disabling retries gets six attempts; `retry()` itself would have handled
   `attempts:0` sanely as 1. *Minimal fix:* `maxRetries: Math.max(1, num(..., 6, 0))` — clamp,
   don't default.

9. **INFO — doctor round count off by one at the cap.** `packages/pipeline/src/doctor.ts:342,369`:
   when the loop exhausts `maxRounds`, `round === maxRounds` and the function reports
   `rounds: maxRounds + 1`. Cosmetic (stats/log only).

### Verified clean (Half B areas with no defect found)

- **doctor.ts**: `applyChange` → `normalizeSkeleton` correctly rebuilds every `children` list from
  parents (stale lists after remove/merge are discarded); metadata/archetype preserved
  (`doctor.ts:294-302`); sanitize-idempotence means re-normalization never renames existing ids,
  and any doctor-added id that sanitize *does* change has all its files in `affectedFiles`, which
  `reassignSubset` re-homes against the post-normalize menu (same mutated `skeleton` object).
  When the doctor makes no change, `rebuildAssignment` still runs every round
  (`doctor.ts:350-353`), remapping entries whose stage id vanished to `unassigned`
  (`assign.ts:93-119`).
- **member.ts**: scanned files with zero members land in `unassigned` (honest, listed in
  coverage); `deriveFileArtifacts` organization coverage counts only bucketed files, so
  `nFiles === nOrganized` by construction — consistent with its "of assigned files" meaning;
  majority vote ties break by skeleton order as documented.
- **generate.ts**: `loadHandbookModel` tolerates a missing `phase3/registers.json`
  (`workdir.ts:205-208` returns an empty default) — render after a registers-less phase 3 works.
- **agent-site.ts** edge inputs: 1-file stages render (exemplar omitted when 0 fns — by design);
  card-less files get the defensive stub (role `other` ranks last in `coreFiles`);
  `disambiguation.md` can only reference written pages (collision index iterates
  `contentStages`); `isPureAncestorChain` keeps same-depth sibling collisions.
- **cli/main.ts plumbing**: `--narrate-lang`→`opts.narrateLang`, `--html-single`→`opts.htmlSingle`,
  `--agent-site`→`opts.agentSite`, `--max-doctor-rounds`→`opts.maxDoctorRounds`,
  `--no-llm`→`opts.llm === false` all correct; all async actions are awaited via
  `program.parseAsync` + async handlers; `resync --narrate-lang` unset correctly defers to the
  stored narration language.
- **examples/mock-llm-server.mjs ↔ current prompts**: all trigger substrings verified verbatim in
  current source ('Files to describe' cards.ts:279, 'dividing a large codebase into the STAGES'
  skeleton.ts:52, 'assigning whole SOURCE FILES' assign.ts:20, 'assigning individual FUNCTIONS'
  member.ts:46, 'SKELETON DOCTOR' doctor.ts:78, 'Proposal under review' critic.ts:83, 'organizing
  the files of ONE stage' organize.ts:82, 'STATE REGISTERS'/'COMPLETING a list of state registers'
  narrate.ts:196/209 — the gap-round prompt contains no uppercase 'STATE REGISTERS', so branch
  order is safe, and the dry-streak terminates); all extraction regexes match the current line
  formats (`### FILE:`, `  - qual  (lines a-b)`, `- file  (`, bare `- <member-id>` lines,
  organize's `- file  [` / `- file\n`). `run-demo.sh` flags all exist; the flat-skill scan picks
  exactly the 4 stage pages.

---

## Doc drift

(From the doc sub-audit; each spot-checked against source. Everything else — both root READMEs,
architecture.md, prompts.md (all 16 prompt-contract rows), the other 8 package READMEs,
examples/README.md — verified accurate against post-fix code, including the "fallback prose is
never cached" and noLlm-resync claims, env-var handling, and the "150+ tests" counts.)

1. `packages/skill/README.md:52` — "flat root-level `<sid>.md` files are **matched by pattern**
   without recursing" → stale: the pattern filter (`STAGE_PAGE_RE`) was deleted by 63d1511;
   current behavior is "every root-level `.md` not in the known non-stage set"
   (`build.ts:46-54,127-129`). The no-recursion half is still true.
2. `docs/formats.md:117` — `id: stage-1  # stage-N / stage-N.M / crosscut-N` presents the
   convention as the format → the schema now accepts any filename-safe id
   (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, `model.ts:98`) and *rejects* unsafe ones; the constraint (new
   in 63d1511) is documented nowhere in formats.md.
3. `docs/formats.md:186` — rendered-handbook layout lists `register.md` unconditionally → it is
   written only when registers exist (`markdown.ts:185-191`); other entries on the same list carry
   conditional qualifiers, this one should too (the skill layer papers over the absence with its
   stub `references/registers.md`, which formats.md's SKILL section correctly implies is always
   present).
