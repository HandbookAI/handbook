# Round 1 review — core / llm / analyzer / renderer / cli

Adversarial correctness review. Every finding below was verified either by executing the built
`dist/` against a constructed failure case (repro noted) or by exact code-path trace. No source
files were modified. Repro scripts: `scratchpad/review1b/v1-core.mjs` … `v7-sid.mjs`.

---

1. **HIGH · CONFIRMED (repro)** — `packages/analyzer/src/adapters/go.ts:322-327`
   **Defect**: Bare calls to free functions defined in a *sibling file of the same Go package* are
   unresolved. `resolveCall` case A checks only the per-file `scan.topLevelFunctions`; no
   cross-file index of free functions exists (methods DO get one — `typeMethods` at go.ts:341-344 —
   so this is an oversight, not a design choice).
   **Failure**: `app/a.go: func Caller() { Helper() }`, `app/b.go: func Helper() {}` →
   `app.a.Caller -> unresolved:Helper`. Same-package cross-file calls are the dominant call form in
   Go, so most of a real Go repo's call graph is silently diverted to dropped-calls.json.
   **Fix**: build a package-level (directory-level) free-function index in `analyze()` and consult
   it in case A, mirroring the `typeMethods` fallback.

2. **HIGH · CONFIRMED (repro)** — `packages/core/src/util/json-extract.ts:10-23`
   **Defect**: `FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)```/g` cannot match a fence with any other
   language tag (```` ```python ````), so the regex instead matches from that block's *closing*
   ``` and consumes the following ```` ```json ```` *opener* as its terminator. The real JSON fence
   is never tried, and the balanced-scan fallback returns the first parseable JSON-ish span from
   the earlier code block.
   **Failure** (repro v1): input "```` ```python\nx = [1, 2]\n``` ````… ```` ```json\n{"decision":"APPROVE"}\n``` ````"
   → `extractJsonBlock` returns `[1,2]`, not the verdict object. Every `ChatClient.complete()`
   result flows through this (client.ts:131); in `actorCriticLoop` a critic that shows a code
   snippet before its verdict gets `parseVerdict(undefined-shape)` → counted as REJECT → a good
   proposal is silently discarded.
   **Fix**: make the fence opener anchored to line start with an optional language word, e.g.
   `/^[ \t]*```(\w*)[ \t]*\n([\s\S]*?)^[ \t]*```/gm`, and only attempt blocks whose tag is `json`
   or empty; skip (but correctly *consume*) other-language fences.

3. **HIGH · CONFIRMED (repro)** — `packages/core/src/model.ts:261-269` (`StageTree.subtree`)
   **Defect**: `subtree()` recursion has no visited-set, unlike `depth()` (which guards with
   `seen`, model.ts:251). A parent cycle (A.parent=B, B.parent=A) makes `walk` recurse forever.
   **Failure** (repro v1, v6): schema-valid skeleton with a 2-cycle → `RangeError: Maximum call
   stack size exceeded`. Reachable end-to-end: `renderMarkdownHandbook` → `stagePageMd`/`indexMd`
   → `HandbookView.subtreeFileCount` → `tree.subtree`. The pipeline's skeleton normalizer
   (pipeline/src/skeleton.ts:123) nulls only self-parents and dangling parents, not multi-node
   cycles, and user-authored skeleton.yaml (member strategy) is unchecked, so LLM/user input
   crashes all three renderers.
   **Fix**: add `if (keep.has(sid)) return;` at the top of `walk` in `subtree` (and ideally break
   cycles in the `StageTree` constructor).

4. **MEDIUM · CONFIRMED (repro)** — `packages/analyzer/src/adapters/python.ts:452-459`
   (`resolveCall` case B3)
   **Defect**: For `alias.attr()` where `alias` is an imported *module*, B3 only tries
   `indexes.classToModule` and then falls straight to `boundary:` — it never checks
   `indexes.moduleIds` / `moduleFunctions`, although `resolveBareName` (python.ts:486-489) does
   exactly that check for the same situation.
   **Failure** (repro v4): `from pkg import helpers` (or `import pkg.helpers as ph`) then
   `helpers.do()` → edge `boundary:pkg.helpers.do` [boundary], while the internal node
   `pkg.helpers.do` exists. The internal edge is lost AND the graph gains a duplicate boundary
   node shadowing an internal function; navpack then reports the project's own package as an
   "external subsystem".
   **Fix**: in B3, after the `classToModule` miss, resolve `imported` as a module id:
   `if (indexes.moduleIds.has(imported) && indexes.moduleFunctions.get(imported)?.has(attr))
   return { calleeId: `${imported}.${attr}`, callType: 'internal_func' }`.

5. **MEDIUM · CONFIRMED (repro)** — `packages/analyzer/src/adapters/typescript.ts:214`
   (`mineParameterProperties`)
   **Defect**: A constructor parameter is treated as a parameter property only when it has an
   `accessibility_modifier` (`public/private/protected`). `constructor(readonly rear: Wheel)` is
   a valid TS parameter property but has node type `readonly` → the field type is never learned.
   **Failure** (repro v4): `constructor(private front: Wheel, readonly rear: Wheel)` →
   `this.front.spin()` resolves to `wheel.Wheel.spin` [self_attr_method] but `this.rear.spin()`
   becomes `unresolved:this.rear.spin`. Silent edge loss for the very common `readonly` DI style.
   **Fix**: `const hasModifier = p.children.some((c) => c?.type === 'accessibility_modifier' ||
   c?.type === 'readonly' || c?.text === 'readonly');`

6. **MEDIUM · CONFIRMED (repro)** — `packages/core/src/util/concurrency.ts:16-31` (`pLimit`)
   **Defect**: `next()` decrements `active` and resolves the queued waiter, but the waiter only
   re-increments `active` when its continuation runs. Any `limit()` call whose microtask executes
   in that window sees the lowered count and enters immediately; the waiter then enters too.
   **Failure** (repro v3): `pLimit(1)` observed running **2** tasks concurrently (task A resolves
   instantly; an independent chain calls `limit()` in the gap between A's release and queued B's
   wake-up). Consequence: `OpenAiChatClient`'s concurrency cap (client.ts:112) is soft — bursts
   can exceed it and trip endpoint rate limits.
   **Fix**: transfer the slot without dropping it — e.g. in `next()`, if a waiter exists, resolve
   it *without* decrementing `active` (waiter must then not re-increment), or increment `active`
   inside `next()` before resolving.

7. **MEDIUM · CONFIRMED (repro)** — `packages/renderer/src/markdown.ts:89`, `html.ts:295`,
   `html.ts:405` (register stage links)
   **Defect**: The register tables link `reg.stages` entries as `[title](<sid>.md)` /
   `<a href="<sid>.html">` / `#<sid>` without checking that the stage got a page. Pages are
   written only for content-bearing stages (`view.contentStages()`), and `reg.stages` is
   LLM-produced (registersSchema does not verify ids). `agent-site.ts:369-371` guards exactly this
   with `written.has(sid)` — markdown/html do not.
   **Failure** (repro v5): register with `stages: ['stage-1','stage-2','stage-ghost']` where
   stage-2 has no files and stage-ghost doesn't exist → register.md contains
   `[Empty Stage](stage-2.md)` and `[stage-ghost](stage-ghost.md)`; register.html and the
   single-page `#stage-ghost` anchor are equally dead.
   **Fix**: filter/plain-text non-content stage ids (mirror the `written.has(sid)` pattern), and
   drop ids absent from `tree.byId`.

8. **MEDIUM · mechanism CONFIRMED (repro), trigger PLAUSIBLE** —
   `packages/renderer/src/markdown.ts:177,192`, `html.ts:354`, `agent-site.ts:418`
   **Defect**: Stage ids are used verbatim as file names (`join(outDir, `${sid}.md`)`).
   `stageSchema.id` is only `z.string().min(1)` and the pipeline normalizer never sanitizes ids,
   so an id containing `/` or `..` escapes the output directory (`writeFileAtomic` even
   `ensureDir`s the foreign path).
   **Failure** (repro v7): stage id `../escaped-stage` → `escaped-stage.md` written *outside*
   `outDir`. Ids come from LLM output or user skeleton.yaml.
   **Fix**: validate ids against `/^[a-z0-9.-]+$/i` (no `/`, no `..`) at load/normalize time, or
   sanitize in the renderers before `join`.

9. **MEDIUM · CONFIRMED (repro)** — `packages/core/src/util/retry.ts:26-38` +
   `packages/llm/src/client.ts:66-67,134`
   **Defect**: With `attempts <= 0` (or `NaN`) the retry loop never executes and the function ends
   with `throw lastError` where `lastError` is still `undefined` — the call rejects with the value
   `undefined` (no message, no stack). `resolveLlmEnv` feeds this directly:
   `HANDBOOK_LLM_MAX_RETRIES=0` → `maxRetries: 0`; any non-numeric value → `NaN`. Likewise
   `OPENAI_MAX_TOKENS=<garbage>` → `maxTokens: NaN` (serialized as `"max_tokens":null`), and
   `HANDBOOK_LLM_RETRY_BACKOFF=<garbage>` → `NaN` backoff.
   **Failure** (repro v1): `retry(fn, {attempts: 0})` → `throw undefined`; every
   `client.complete()` under that env rejects with `undefined`, which the CLI reports as
   `handbook: error: undefined`.
   **Fix**: clamp `attempts = Math.max(1, ...)` in `retry`, and validate numerics in
   `resolveLlmEnv` (fall back to defaults on NaN).

10. **LOW · CONFIRMED (repro)** — `packages/analyzer/src/navpack.ts:87-96`
    **Defect**: Entry-point candidates are deduped by `qualname`, not node id. Distinct functions
    with the same qualname in different files (canonical case: `main` in `cmd/a/main.go` and
    `cmd/b/main.go`) collapse to whichever is seen first.
    **Failure** (repro): two `main` roots → `entryPoints` lists only `main @ cmd/a/main.go`; the
    other binary's entry point silently vanishes from orientation/skeleton prompts.
    **Fix**: key the map by `node.id` and keep `qualname` for display.

11. **LOW · CONFIRMED (repro)** — `packages/analyzer/src/graph.ts:27,54,144-167` +
    `packages/pipeline/src/phase1.ts:74-78`
    **Defect**: `buildGraph`'s `defaultExt` defaults to `.py` and `runPhase1` never passes it, so
    synthesized nodes in TS/Go/Rust/multi graphs get fabricated Python paths and a Python-comment
    signature.
    **Failure** (repro): TS edge to implicit `wheel.Wheel.constructor` → node
    `file: "wheel.py"`; Rust `src::engine::Engine::new` → `file: "src/engine.py"`; both rows are
    persisted in graph.json and functions.csv (`…,wheel.py,0,0,…`). Downstream consumers skip
    `synthetic` nodes, so impact is corrupted persisted artifacts/CSV only.
    **Fix**: pass a per-language `defaultExt` from phase 1 (or derive from the caller's file
    extension), and drop the `# synthesized` Python-style comment for non-Python graphs.

---

### Notable non-findings (checked, behave as specified)

- `parseVerdict` rejecting string `suggested_revision` and TS imported-function calls resolving to
  `boundary:` are pinned by tests (`critic.test.ts:20`, `typescript.test.ts:140-144`) — intended.
- `from pkg import func` with `pkg/__init__.py` resolves correctly (`moduleIdForFile` collapse and
  `resolveBareName`'s `moduleFunctions` check line up) — repro v4.
- `StageTree.depth` is cycle-safe; `pLimit` FIFO order, `mapLimit` ordering/rejection,
  `writeFileAtomic` tmp naming, `discoverAll` claims (extensions are disjoint), self-loop degree
  counting, CSV escaping of `",\n`, HTML escaping of card prose (markdown-it `html:false` +
  `esc()`), `--no-llm` → `opts.llm === false` mapping, and `generate --phase 1` vs `1,3` LLM
  gating are all correct.
