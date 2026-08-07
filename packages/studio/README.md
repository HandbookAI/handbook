# @handbook/studio

A local web UI over the handbook toolchain: register repositories, run generation with
live logs, browse rendered handbooks, plan changes with the handbook-guided planner, and
roll handbooks forward after code changes — all on `127.0.0.1`, with source code leaving
the machine only via the LLM endpoint the pipeline itself is configured to use.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Serve a single-page dashboard (`public/index.html`) and a JSON API over `node:http` —
  zero web-framework dependencies.
- Maintain the repository registry (`studio.json` in the state dir); each repo pairs a
  source root with a work dir holding its handbook artifacts.
- Run pipeline operations as **jobs** (generate / analyze / plan / resync) with captured
  logs streamed over SSE; one running job per repo (work dirs are single-writer).
- Record every resync as an **evolution** under `<work>/evolutions/<stamp>/` and expose
  the timeline.
- Deliberately NOT a deployment server: binds localhost only, no auth, no TLS — it is a
  desktop tool.
- Apply edit plans through `@handbook/patcher`: dry-run verification, all-or-nothing
  writes, per-edit outcomes, and a rollback that refuses to clobber work done after the
  patch (an explicit override is offered in the UI).

## Endpoints

| Method & path                                        | Purpose                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /`                                              | the dashboard UI                                                                                     |
| `GET/POST /api/repos`, `GET/DELETE /api/repos/:name` | registry + status (chapters, strategy, evolutions)                                                   |
| `POST /api/repos/:name/analyze`                      | phase-1 static analysis job (free, no LLM)                                                           |
| `POST /api/repos/:name/generate`                     | full pipeline + render job — accepts every CLI generate option (see below)                           |
| `POST /api/repos/:name/plan`                         | planner job (`{request}` → plan + declarations)                                                      |
| `POST /api/repos/:name/resync`                       | live-tree resync job (`{description, noLlm, narrateLang}`) + re-render                               |
| `GET /api/repos/:name/overview`                      | stages/summaries/registers/coverage JSON                                                             |
| `GET /api/repos/:name/history`                       | evolution timeline                                                                                   |
| `GET /api/repos/:name/graph?stage=&limit=`           | file-level impact graph (nodes with degree + stage, weighted links)                                  |
| `GET /api/repos/:name/source?path=`                  | file content + function anchors (line ranges)                                                        |
| `POST /api/repos/:name/apply`                        | patch job (`{plan, dryRun}`) → per-edit outcomes, changedFiles, backupDir                            |
| `POST /api/repos/:name/rollback`                     | rollback job (`{backup?, force?}`) → restored / removed / skipped                                    |
| `GET /api/repos/:name/patches`                       | backup stamps, newest first                                                                          |
| `GET /api/history`                                   | evolutions across every repo, newest first                                                           |
| `GET /api/repos/:name/handbook/*`                    | static serving of the rendered handbook (traversal-safe)                                             |
| `GET /api/jobs?repo=`                                | `{jobs: [...]}` — recent job summaries (id/repo/kind/status/startedAt, no raw log), newest first     |
| `GET /api/jobs/:id`, `GET /api/jobs/:id/stream`      | job status / SSE log stream                                                                          |
| `POST /api/jobs/:id/cancel`                          | request cancellation: `202 {ok:true}` for a running job, `409` if it already finished, `404` unknown |

### Generate options

`POST /api/repos/:name/generate` accepts the full CLI surface; defaults mirror the CLI.

| Field                                                                                              | Meaning                                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `narrateLang` (`en`\|`zh`), `detail` (`brief`\|`deep`), `synthMode` (`oneshot`\|`doctor`), `title` | the common four, shown at the top of the dialog                                       |
| `phase`                                                                                            | `all \| 1 \| 2 \| 2a \| 2b \| 2c \| 3` or a comma list (default `all`)                |
| `strategy`                                                                                         | `file` \| `member`; omitted = keep the work dir's recorded strategy                   |
| `skeleton`                                                                                         | path to an authored `skeleton.yaml` — required for `member`                           |
| `lang`                                                                                             | source language: `auto \| python \| typescript \| go \| rust \| shell`                |
| `resume`, `refresh`                                                                                | booleans: skip completed cards / ignore phase-3 caches                                |
| `readWorkers` (default 12), `maxDoctorRounds` (default 6, doctor mode only)                        | numerics, validated server-side: garbage is a `400` on the request, never a NaN'd job |

### Cancellation

Cancellation is **cooperative**: `POST /api/jobs/:id/cancel` aborts the job's
`AbortSignal` and answers `202` immediately, but the run only stops when it
reaches its next checkpoint (between pipeline phases / before a render — and,
as the underlying packages learn to observe the signal, mid-phase). A job that
stopped this way finishes as **`cancelled`, which is an outcome, not a
failure**: the UI renders it in the neutral ice tone, `error` stays unset, and
the log ends with `[job] cancelled by user`. A cancelled job releases the
per-repo mutex and no longer blocks repo deletion, exactly like a succeeded or
failed one. The drawer shows a 取消/Cancel button while its job is running.

## Views

| View            | What it is for                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home            | the product's shape: the Request → Handbook → Plan → Patch → Sync loop, plus recent repositories and evolutions                                                              |
| Instructions    | in-app guide: the five-step loop, what each button does, cost and data-boundary facts                                                                                        |
| Overview        | status, chapter index with summaries, coverage, state registers                                                                                                              |
| Browse handbook | the rendered handbook, embedded — a switcher offers every output that exists: chapter site, single-page `handbook.html`, and the agent locator index (`agent/how_to_use.md`) |
| Impact graph    | file-level call relations as SVG — degree-sized nodes, stage colours, stage filter, click through to source                                                                  |
| Source          | the real file with line numbers and a function index that jumps and highlights                                                                                               |
| Evolve          | plan → dry-run → apply (per-edit table) → rollback → resync, with the backup list                                                                                            |
| History         | evolution timeline per repo, and across all repos from the sidebar                                                                                                           |

Chinese/English and dark/light are both toggles in the top bar, persisted per browser.

## Usage

```bash
handbook studio                      # http://127.0.0.1:4860
handbook studio --port 5000 --state-dir ~/.handbook-studio
```

Or programmatically:

```ts
import { startStudio } from '@handbook/studio';
import { MockChatClient } from '@handbook/llm';

const server = await startStudio({
  stateDir: '/tmp/studio',
  port: 4860,
  clientFactory: () => new MockChatClient([...]), // injectable — tests run fully offline
});
```

## Design notes

- The LLM client is created per job via `clientFactory`, defaulting to env-configured
  `OpenAiChatClient` — the CLI's `.env` auto-loading applies, and tests inject mocks.
- Resync uses the repo's **live source tree** (`editedRoot`) instead of a copied case
  dir: Studio's evolution flow is "you changed the code in place; the handbook catches
  up". The case dir still receives the report, staging area, and `evolution.json`.
- Static handbook serving resolves paths against the handbook root and rejects
  escapes — the API never serves arbitrary filesystem paths.
- Job logs are capped (last 2000 lines) and streamed with replay-then-follow SEE
  semantics so a late-opened drawer still shows the full recent log.
- Reloading the page mid-run does not orphan the job: the UI polls `GET /api/jobs`
  on boot and view changes, shows a "Job running" chip in the top bar while one is
  live, and clicking it reattaches the log drawer to the job's SSE stream (replay
  fills in the missed lines). If the job finished in the meantime, the chip click
  refreshes the repo status instead.

## Dependencies

Internal: `@handbook/{core,llm,pipeline,planner,renderer,resync,skill}` — Studio is a
thin orchestration shell; every capability lives in the underlying packages. External:
`zod` (state file validation) only.
