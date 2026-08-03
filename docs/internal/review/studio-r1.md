# Studio R1 — adversarial correctness review of `@handbook/studio`

Scope: `packages/studio/src/{state,jobs,server,index,server.test}.ts`,
`packages/studio/public/index.html`, plus the diffs it leans on
(`packages/resync/src/resync.ts` `editedRoot`/`planText`, `packages/cli/src/main.ts` `studio`).

Method: full read of every file above, plus **7 runtime harnesses** against the built
`packages/studio/dist` (scratch dir, nothing in the repo touched) that verified: UTF-8 chunk
splitting in `readBody`, `res.write` after client abort, missing-`sourceRoot` registration,
`workDir` collision, `text/plain` + foreign `Host`/`Origin` acceptance, `phase:"1"` generate,
in-place-edit resync detection (with a positive control), and throw-inside-`.finally`
propagation. No source files modified.

Verification gates (repo root, both green):
- `npx tsc -b` → exit 0, no output.
- `npx vitest run packages/studio` → 1 file, **8/8 passed** (473 ms).

**15 findings: 2 High, 4 Medium, 3 Medium-Low, 6 Low.** A separate section records the
suspicions in the brief that turned out **not** to be defects, with the trace that clears them —
notably the SSE replay/subscribe race and the `serveStatic` traversal guard.

---

## High

### 1. HIGH — No `Origin`/`Host` validation and non-JSON bodies accepted: any web page can register a repo and start a job (source exfiltration)
`server.ts:236-262` (router entry, `POST /api/repos`), `server.ts:282-299` (job routes),
`server.ts:378-385` (`createServer`).

**Defect.** The API has no CSRF defence of any kind: no `Origin` check, no `Host` check, no
token, and no `content-type` requirement. `readBody` parses whatever arrives, so a POST with
`content-type: text/plain` — a CORS *simple* request, which the browser sends **without a
preflight** — is fully processed. Verified live: `POST /api/repos` with
`content-type: text/plain;charset=UTF-8` and `Origin: https://evil.example.com` → **201
Created**; `GET /api/repos` with `Host: evil.example.com` → **200** (no `Host` check, so DNS
rebinding also makes responses readable, not just writable).

**Scenario.** The user runs `handbook studio` (fixed default port 4860) and, in another tab,
visits any page that does:
```js
fetch('http://127.0.0.1:4860/api/repos', {method:'POST', mode:'no-cors',
  headers:{'content-type':'text/plain'}, body:'{"name":"x","sourceRoot":"/Users/victim"}'});
fetch('http://127.0.0.1:4860/api/repos/x/generate', {method:'POST', mode:'no-cors',
  headers:{'content-type':'text/plain'}, body:'{}'});
```
The response is opaque to the attacker, but the side effect lands: the pipeline walks
`/Users/victim` and ships file contents to the configured LLM endpoint. The module header's
promise ("source paths and prose never leave the machine except via the configured LLM
endpoint") is exactly what is subverted — an arbitrary tree gets uploaded on a drive-by.

**Minimal fix.** In the `createServer` callback, before `route()`:
```ts
const host = req.headers.host ?? '';
const okHost = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(host);
const origin = req.headers.origin;
const okOrigin = !origin || /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(origin);
const ct = (req.headers['content-type'] ?? '').split(';')[0]?.trim();
const okCt = req.method === 'GET' || req.method === 'DELETE' || ct === 'application/json';
if (!okHost || !okOrigin || !okCt) { json(res, 403, { error: 'forbidden' }); return; }
```
(`application/json` alone already forces a preflight, which then fails for lack of CORS headers;
the `Host` check closes DNS rebinding. A random token in the URL the CLI prints would be
stronger still.)

### 2. HIGH — Studio's resync silently misses every in-place code edit; the job still reports success and records a "re-narrated" evolution
`server.ts:199-214` (`runResync` passes `editedRoot`, never a diff), `resync.ts:190-196`
(inline case has no `diffText`), `resync.ts:232-240` (diff widening — dead in this flow),
`resync.ts:123-151` (`diffGraphs` fingerprint).

**Defect.** The delta is a structural fingerprint only:
`` `${node.qualname}@${node.lineStart}-${node.lineEnd}:${node.signature}` ``. An edit that
changes a function *body* without changing its line span or signature produces an identical
fingerprint, so the file is neither `changed` nor `added`. The CLI case flow can widen the set
with `change.diff` (`resync.ts:232-240`), but the Studio flow constructs `ResyncCase` inline
with **no `diffText`** and `ResyncOptions` has no way to supply one — so nothing can widen it.

**Verified** (harness, mock LLM, real pipeline): after a successful generate, changing
`self.rpm += 1` → `self.rpm += 7` (same line count, same signature) and calling
`POST /api/repos/demo/resync`:
```
resync status: succeeded
changedFiles: []  added: []  affectedStages: []  cardsRegenerated: 0
CONTROL changedFiles: ["app/engine.py"]   # adding a comment line shifts lineEnd → detected
```
`report.narrated` is set unconditionally at `resync.ts:435` whenever `!noLlm`, so the evolution
recorded in history claims "已重叙述" (`index.html:285`) with all-zero counts. The user is told
the handbook rolled forward; the cards and prose still describe the old body. Silent staleness
is precisely the failure resync exists to prevent, and the success report actively hides it.

**Minimal fix.** Add `diffText?: string` to `ResyncOptions`, thread it into the inline
`editedRoot` case, and have `runResync` supply a change set for the live tree — cheapest
reliable source is content hashing (store a `sha256` per scanned file in the work dir at
generate/resync time; widen `delta.changed` with files whose hash moved), with
`git -C <sourceRoot> diff --name-only HEAD` as an opportunistic fast path. Until then, at
minimum surface the risk: when `changedFiles`/`addedFiles`/`deletedFiles` are all empty, log a
warning and set `narrated: false` rather than reporting a clean re-narration.

---

## Medium

### 3. MEDIUM — `resyncCase.declarations` is parsed and then never used: `will_modify`/`will_add`/`will_remove` are silently ignored
`resync.ts:64` (field), `:82` and `:194` (populated), `:16-17` (doc claims it widens the delta).

**Defect.** `declarations` is written into the `ResyncCase` in both construction paths and read
**nowhere** in `resyncHandbook` (grep of the file: the identifier appears only at 64, 82, 162,
194 — all writes/docs, no reads). The header contract "declarations and the unified diff can
only WIDEN this set, never narrow it" is half false: only the diff widens.

**Scenario.** A caller (CLI case dir with `plan.md`, or Studio passing `description` with a
```` ```json ```` block) declares `{"will_modify":["app/engine.py"]}` for an in-place body edit.
Parsing succeeds, the declaration is dropped, the file is not refreshed — the same silent
staleness as finding 2, with the user having explicitly named the file.

**Minimal fix.** After the diff-widening block in `resyncHandbook`, widen with the declarations
too:
```ts
const declared = resyncCase.declarations;
if (declared) {
  const scanned = new Set(after.metadata.scannedFiles);
  for (const f of [...declared.willModify, ...declared.willAdd]) {
    if (scanned.has(f) && !delta.added.includes(f) && !delta.changed.includes(f)) delta.changed.push(f);
  }
  delta.changed.sort();
}
```
(`willRemove` should be intersected against files absent from `after` before being added to
`delta.deleted`, so a wrong declaration cannot delete a live card.)

### 4. MEDIUM — `readBody` corrupts multi-byte UTF-8 split across chunks
`server.ts:61-71` (`raw += chunk` at `:64`).

**Defect.** `raw += chunk` stringifies each `Buffer` independently, so a character whose bytes
straddle a chunk boundary decodes to U+FFFD. **Verified** with a hand-fragmented request
(`中文` split after 2 of the 3 bytes of `中`): the server saw `"��文"`, `intact: false`.
Depending on where the split lands, `JSON.parse` can also fail outright → a spurious 400.

**Scenario.** The UI is Chinese; `description` (resync) and `request` (planner) are free prose.
A body larger than one socket read (~64 KB — e.g. a pasted plan) or any TCP fragmentation
(proxy, slow client) mojibakes the text, which is then persisted verbatim into
`evolution.json` → `description` and rendered in the history tab forever.

**Minimal fix.**
```ts
const chunks: Buffer[] = []; let size = 0;
for await (const chunk of req) {
  chunks.push(chunk as Buffer); size += (chunk as Buffer).length;
  if (size > 1_000_000) throw new Error('request body too large');
}
const raw = Buffer.concat(chunks).toString('utf8');
```
(Also caps real bytes rather than UTF-16 code units, and halves peak memory.)

### 5. MEDIUM — Missing/empty `sourceRoot` silently registers the server's cwd as the repo
`server.ts:256` — `const sourceRoot = resolve(String(body.sourceRoot ?? ''));`

**Defect.** `resolve('')` is `process.cwd()`, which is a directory, so `StateStore.add`'s
`isDirectory()` check (`state.ts:50-52`) passes and the entry is created. **Verified**:
`POST /api/repos {"name":"noroot"}` → **201**, with `sourceRoot` set to the server's cwd.

**Scenario.** A UI/scripting slip (or finding 1's drive-by) that omits `sourceRoot` produces a
plausible-looking repo pointed at wherever `handbook studio` was launched — typically the
user's home or a work checkout. The next generate uploads that whole tree to the LLM endpoint.
`workDir` is equally unvalidated: `resolve(String(body.workDir))` accepts `/`, and no check
requires an absolute path.

**Minimal fix.** In the handler, before `store.add`:
```ts
if (typeof body.sourceRoot !== 'string' || !isAbsolute(body.sourceRoot.trim()))
  throw new Error('sourceRoot must be an absolute path');
if (body.workDir !== undefined && (typeof body.workDir !== 'string' || !isAbsolute(body.workDir.trim())))
  throw new Error('workDir must be an absolute path');
```
(Better: move both into `repoEntrySchema` as `z.string().refine(isAbsolute)` so the persisted
state is validated on load too.)

### 6. MEDIUM — Two repos may share one `workDir`; artifacts clobber each other
`state.ts:47-57` (`add` checks name and `sourceRoot` only), `server.ts:257-259`.

**Defect.** Nothing rejects a `workDir` already owned by another entry, nor a `workDir` equal to
or nested inside a `sourceRoot`. **Verified**: two repos (`left`, `right`) registered with the
same explicit `workDir` → both **201**.

**Scenario A (clobbering).** Generate `left`, then generate `right` into the same work dir:
`phase1/graph.json`, cards, skeleton, narration and `handbook/html/*` are all overwritten in
place (`renderHtmlSite` even deletes pre-existing `*.html` first — `renderer/html.ts:316-318`).
`left`'s status card then reports `right`'s chapter count and title, its browse tab serves
`right`'s handbook, and a resync of `left` rolls `right`'s artifacts forward against `left`'s
sources. Cross-repo data corruption with no error anywhere.

**Scenario B (self-nesting).** `workDir === sourceRoot` (or inside it): generated artifacts land
inside the analysed tree, so the next resync analyses its own output and reports the handbook's
own files as added.

**Minimal fix.** In `StateStore.add`, after the existing checks:
```ts
const clash = this.state.repos.find((r) => resolve(r.workDir) === resolve(parsed.workDir));
if (clash) throw new Error(`workDir already used by repo "${clash.name}"`);
const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
if (inside(resolve(parsed.workDir), resolve(parsed.sourceRoot)) ||
    inside(resolve(parsed.sourceRoot), resolve(parsed.workDir)))
  throw new Error('workDir and sourceRoot must not contain each other');
```

---

## Medium-Low

### 7. MEDIUM-LOW — `POST /generate` with any partial phase spec always ends as a FAILED job
`server.ts:158-178` (`loadHandbookModel` at `:173`), `pipeline/generate.ts:122` (early return),
`pipeline/workdir.ts:216-221` (`loadNarration` throws).

**Defect.** `runGenerate` renders unconditionally. With `phase:"1"` (or `"2"`, `"2a"`, `"2b"`,
`"2c"`), `generateHandbook` returns before phase 3, then `loadHandbookModel` →
`work.loadNarration()` → `MissingArtifactError`. **Verified**: `phase:"1"` job →
`status: failed`, `error: "phase3/narration.json not found — run phase 3 first"`, log tail
`['rendering handbook…', '✖ …', '— generate failed —']`, even though phase 1 completed and its
artifacts are on disk. (`busyRepos` is released correctly — the next job is accepted, 202.)

**Scenario.** Any API client that uses the documented `phase` knob (`--phase 1` is the free
static-analysis path the UI advertises at `index.html:157`) gets a red, failed job for work
that actually succeeded, and cannot distinguish it from a real failure.

**Minimal fix.** Guard the render block:
```ts
if (!fileExists(new WorkDir(repo.workDir).narrationPath)) {
  logger.info('narration not present — skipping render (partial phase run)');
  return { ...stats, render: null };
}
```

### 8. MEDIUM-LOW — A failed resync leaves a phantom history entry and leaks a full phase-1 copy
`server.ts:200-202` (`ensureDir(caseDir)` before the work), `:228` (`evolution.json` written
only on success), `:101-107`/`:109-124` (counting/listing), `resync.ts:218-219` and `:441`
(staging dir), `index.html:282-288`.

**Defect.** `runResync` creates `evolutions/<stamp>/` first and writes `evolution.json` last. If
`resyncHandbook` throws (LLM error, missing artifact, unreadable source), the directory
survives with no `evolution.json`, so `countEvolutions` counts it and `listEvolutions` yields
`{ id, error: 'unreadable' }`. The history tab renders that as a real evolution with a blank
description, the "结构更新" pill, and `变更 0 · 新增 0 · 删除 0 · 受影响章节 0`
(`index.html:284-287` — every field falls back). Separately, `.resync-phase1` (a complete copy
of the fresh phase-1 artifacts) is removed only on the success path (`resync.ts:441`) or by a
re-run **against the same case dir** (`:219`) — and every Studio resync gets a fresh timestamped
case dir, so each failure leaks a graph copy permanently.

**Scenario.** Three resyncs fail on a bad `OPENAI_API_KEY`: the sidebar reads "3 次演化", the
history tab shows three blank rows, and three `.resync-phase1` graph copies sit under
`evolutions/`.

**Minimal fix.** In `runResync`, wrap the call and clean up on failure:
```ts
try { report = await resyncHandbook({...}); }
catch (e) { rmSync(caseDir, { recursive: true, force: true }); throw e; }
```
and in `resyncHandbook`, move `rmSync(stagingRoot, …)` into a `finally` so the staging dir never
outlives the call. Belt-and-braces: have `listEvolutions`/`countEvolutions` skip directories
with no `evolution.json`.

### 9. MEDIUM-LOW — UI swallows every API error: failed actions look like dead buttons
`index.html:303-321` (`startAnalyze`/`startGenerate`/`startPlan`/`startResync`), `:279-289`
(`renderHistory`), `:335-341` (done handler's `await refresh(true)`).

**Defect.** Each action is `onclick="startX()"` on an `async` function whose `await api(...)`
sits outside any `try/catch` (`addRepo`, `:292-301`, is the only one that catches). A rejected
`api()` produces an unhandled rejection in the console and **no UI change at all** — the drawer
never opens, no error text appears.

**Scenario.** Double-clicking 「开始生成」 → the second POST returns 400
`repo "x" already has a running job` (`jobs.ts:34-36`); the user sees nothing and clicks again.
Same for a missing `OPENAI_API_KEY` (the whole point of the hint at `:157`), an unknown repo
after a DELETE, and a 500 on `/history` (which leaves the previous tab's DOM in place, so the
old repo's history stays on screen under the new repo's header).

**Minimal fix.** Wrap each handler body in `try { … } catch (e) { showError(e.message) }`, where
`showError` writes into the drawer (open it with `status: 'failed'`) or a shared error line;
`renderHistory` should render the message into `c` on failure.

---

## Low

### 10. LOW — Jobs are never evicted; each retains up to 2000 log lines plus its full result
`jobs.ts:28` (`jobs` map), `:45` (insert), `server.ts:362` (`/api/jobs/:id` returns the whole
job, log and result included).

**Defect.** Nothing ever removes entries. `result` for `plan` includes the planner's full
`trace` (`server.ts:196`), and for `generate` the render stats. A studio left running for days
across many generate/plan/resync cycles grows monotonically.

**Minimal fix.** After inserting in `start()`, evict finished jobs beyond a cap:
```ts
const finished = [...this.jobs.values()].filter((j) => j.status !== 'running')
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
for (const j of finished.slice(0, Math.max(0, finished.length - 100))) this.jobs.delete(j.id);
```

### 11. LOW — Deleting a repo with a running job orphans the job and wedges the name
`server.ts:273-277`, `jobs.ts:30`/`:73`.

**Defect.** `DELETE /api/repos/:name` never consults the job runner. The running job keeps its
captured `repo` object and continues writing into a work dir the registry no longer knows
about, and `busyRepos` still holds the name — so re-registering the same name and starting a job
returns 400 `already has a running job` until the orphan finishes.

**Minimal fix.** Add `isBusy(repo: string): boolean { return this.busyRepos.has(repo); }` to
`JobRunner` and return `json(res, 409, { error: 'repo has a running job' })` from the DELETE
branch when it is true.

### 12. LOW (latent) — A throwing SSE listener becomes an unhandled rejection and kills the process
`jobs.ts:48-52` (`emit` loop), `:71-76` (`emit` called inside `.finally()` on a `void`ed chain).

**Defect.** `emit` invokes listeners with no guard, and the terminal `emit(…, true)` runs inside
`.finally()` of a chain that is discarded with `void`. A listener exception therefore rejects a
promise nobody handles → Node terminates the process (verified: `unhandledRejection` fires for a
throw inside `.finally()` on a `void`ed chain).

**Reachability.** Not currently triggerable: the only listener (`server.ts:352-358`) does
`res.write`/`res.end`, and on an aborted client both are no-ops — verified against a hard client
abort (`write` returned `ok=false`, `destroyed=true`, no throw, process survived). It is one
future listener away from being fatal.

**Minimal fix.** `for (const l of this.listeners.get(job.id) ?? []) { try { l(line, done); } catch { /* a dead subscriber must not kill the job */ } }`

### 13. LOW (latent) — A synchronous throw in `work` wedges the repo forever
`jobs.ts:46` (`busyRepos.add`) vs `:61` (`work(logger)` invoked before `.then` is attached).

**Defect.** `busyRepos.add(repo)` happens before `work(logger)` is called. If `work` threw
synchronously — or returned a non-thenable, e.g. a future `switch` that falls through to
`undefined`, making `.then` a `TypeError` — the exception escapes `start()` before the
`.finally()` cleanup exists. `busyRepos` never releases and the job stays `status: 'running'`
forever, so every subsequent job for that repo 400s until the server restarts (a 400 the UI
does not even display — finding 9).

**Reachability.** All four current callbacks are `async` functions, so they reject rather than
throw. Latent, cheap to close.

**Minimal fix.** `void Promise.resolve().then(() => work(logger)).then(…)` — or move
`busyRepos.add` into the same `try` that owns the cleanup.

### 14. LOW — Resync silently reverts a custom handbook title
`server.ts:173` (generate honours `body.title`) vs `server.ts:217` (resync hardcodes
`` `${repo.name} Handbook` ``).

**Defect.** A handbook generated with `{"title":"Payments Platform"}` is re-rendered by the next
resync — every markdown page, HTML page, agent page and the single-page bundle — under
`"<name> Handbook"`. Nothing warns; the title is simply lost.

**Minimal fix.** Persist the title (add `title?: string` to `repoEntrySchema`, set it on
generate) and read it in both `runGenerate` and `runResync`.

### 15. LOW — UI: unescaped interpolations (not exploitable today) and stateful re-render glitches
`index.html:184` (`onclick="selectRepo('${r.name}')"`), `:185` (`${r.name}`), `:240`
(`${s.id}`), `:242` (register `${r.id}`), `:286` (`${e.at||e.id||''}`), `:345` (`escapeHtml`),
`:324-343` (`runJob`), `:219-246` (`renderOverview`).

**Escaping — audited site by site, no exploitable XSS found.** `escapeHtml` covers `& < >` but
**not quotes**, so it is not attribute-safe; five interpolations bypass it entirely. Each is
currently constrained by a schema:
- repo `name` — `state.ts:13` `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, enforced on `POST` (via
  `add`→`parse`) **and** on `studio.json` load (`readValidatedJson`). Anchors checked at
  runtime: no trailing-newline bypass, quotes rejected. Safe in the `onclick` attribute.
- stage `s.id` — `core/model.ts:98`, same regex, validated by `loadSkeleton`. `s.title`/
  `s.summary` (LLM prose) **are** escaped (`:239`, `:241`). ✔
- register `r.id` — `core/model.ts:165` `/^reg-[a-z0-9-]+$/`, validated by `loadRegisters`. ✔
- evolution `description` **is** escaped (`:284`); `e.at`/`e.id` are not, and this is the one
  weak link: `evolution.json` is read with `readJsonFile` (`server.ts:119`) with **no schema**,
  so those two fields are unvalidated JSON from disk (the fallback `{id: entry}` is a
  `readdirSync` directory name). Server-generated today, hence not exploitable.

The browsed handbook is served same-origin in an iframe, but it cannot inject script into the
Studio origin: `renderer/html.ts:150-151` runs markdown-it with `html: false, linkify: false`
and every interpolation goes through `esc()`. Checked because LLM prose reaches those pages.

**Minimal fix.** Escape all five sites; extend `escapeHtml` with `"`→`&quot;` and `'`→`&#39;`;
replace the inline `onclick` with `data-name` plus a delegated listener on `#repoList`.

**Re-render glitches (same file, real but cosmetic/annoying).**
- EventSource auto-reconnect (a dropped connection mid-job) re-runs the replay loop
  (`server.ts:346`) while the handler appends with `+=` (`:332`) → the whole log is duplicated in
  the drawer. No `id:`/`Last-Event-ID` handling.
- The done handler's `await refresh(true)` re-renders the current tab **before** `onDone`, so
  `renderEvolve` wipes the `planReq`/`resyncDesc` textareas and any previous plan output after
  every completed job.
- `renderBrowse` sets `c.style.padding='14px'` (`:250`) and only `renderEvolve`/`renderHistory`
  reset it (`:257`, `:280`) — `renderOverview` does not, so the overview keeps the iframe padding
  after a visit to the browse tab.
- `refresh(keepTab)` → `renderMain(keepScroll)`: the parameter is accepted and never used
  (`:205`); the tab survives only because `tab` is module state.

---

## Checked and NOT defects (with the trace that clears them)

1. **SSE replay-then-subscribe race — no lost lines.** `server.ts:341-359` contains no `await`
   between the replay loop (`:346`), the finished check (`:347`) and `subscribe` (`:352`), and
   `emit` only ever runs from the job promise's microtasks or an I/O callback. Nothing can
   interleave, so no line emitted between replay and subscribe can be dropped.
2. **Late subscriber after `listeners.delete(job.id)` — always gets `done`.** `/stream` checks
   `job.status !== 'running'` first and answers replay + `event: done` + `end` (`:347-351`).
   `status` is assigned in `.then`/`.catch` and `listeners.delete` in `.finally` — the same
   microtask drain, with no macrotask in between — so there is no window in which a stream can
   attach to a finished job and hang. `req.on('close', unsubscribe)` (`:359`) covers client
   disconnects, and the whole `Set` is dropped at completion, so subscribers cannot leak.
3. **`serveStatic` traversal guard is sound.** `server.ts:127-132` resolves **first** and then
   requires the result to be `root` or under `root + sep`. Rejected: `../..` sequences;
   `//etc/passwd` (`:327` strips only one leading slash, leaving an absolute path that `resolve`
   honours and the prefix check then rejects → 400); Windows `\` (a real separator there, so
   `normalize` collapses it and escapes are caught). `url.pathname` is never percent-decoded, so
   `..%2F..%2F` reaches the FS as a literal filename → 404 (the test at `server.test.ts:147-152`
   accepts 400|404 for that reason). Note the guard does **not** depend on the missing decode —
   keep the resolve-then-prefix check if a decode is ever added, as it was for the repo name
   (`:266`).
4. **`headersSent` handling and `json()` ordering are correct.** `server.ts:379-383` only writes
   a body when headers are unsent, and `json()` stringifies before `writeHead` (`:56-58`), so
   even a serialization failure yields a clean 400 rather than a half-written response. Only
   nit: every error maps to 400, including genuine 500s.
5. **Log cap is correct.** `jobs.ts:50` `splice(0, len - 2000)` keeps the newest 2000 lines.
6. **MIME map is complete for what is actually served.** The renderers emit only `.html`
   (`renderer/html.ts:321`), `.md` (`renderer/agent-site.ts:423-427`) and `.json` — all present
   at `server.ts:46-53`. (`extname` is case-sensitive and images are absent from the map, but no
   renderer produces either.)
7. **`StateStore` writes are safe for the single-process tool.** `writeJsonFile` is atomic
   (temp + rename, `core/util/fsx.ts:21-31`) and JS single-threading serialises the in-memory
   mutations. Two studios on one `stateDir` would diverge (each caches state from its
   constructor, last writer wins), and `add` pushes before `save` so a failed write leaves the
   entry in memory — both acceptable for a documented single-instance localhost tool.
8. **CLI `studio` command is fine.** `toInt` (`cli/main.ts:64-70`) rejects `NaN`, empty and
   `< 1`; an out-of-range port surfaces through `server.once('error', reject)` →
   `parseAsync().catch` → exit 1. `await new Promise(() => {})` (`:265`) is redundant (the
   listening handle already keeps the loop alive) but harmless, and Ctrl-C exits via the default
   SIGINT disposition. There is no graceful shutdown, so a mid-flight job dies with the process —
   tolerable because every artifact write is atomic per file and `generate` supports `resume`.
9. **`editedRoot` skipping `loadCase` is correct by design** — no `edited/` copy, no
   `change.diff`, and `caseDir` still receives both `resync-report.json` (`resync.ts:443`) and
   `evolution.json` (`server.ts:228`); distinct filenames, no clobbering. Runtime-confirmed:
   each case dir holds exactly those two files. The *consequence* of having no diff to widen
   with is finding 2.
