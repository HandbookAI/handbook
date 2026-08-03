# @handbook/studio

A local web UI over the handbook toolchain: register repositories, run generation with
live logs, browse rendered handbooks, plan changes with the handbook-guided planner, and
roll handbooks forward after code changes — all on `127.0.0.1`, with source code leaving
the machine only via the LLM endpoint the pipeline itself is configured to use.

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
- Deliberately does NOT apply edit plans to source code: `plan` produces the byte-exact
  plan; applying it stays with you (or your coding agent).

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /` | the dashboard UI |
| `GET/POST /api/repos`, `GET/DELETE /api/repos/:name` | registry + status (chapters, strategy, evolutions) |
| `POST /api/repos/:name/analyze` | phase-1 static analysis job (free, no LLM) |
| `POST /api/repos/:name/generate` | full pipeline + render job (`{narrateLang, detail, synthMode, resume, title}`) |
| `POST /api/repos/:name/plan` | planner job (`{request}` → plan + declarations) |
| `POST /api/repos/:name/resync` | live-tree resync job (`{description, noLlm, narrateLang}`) + re-render |
| `GET /api/repos/:name/overview` | stages/summaries/registers/coverage JSON |
| `GET /api/repos/:name/history` | evolution timeline |
| `GET /api/repos/:name/handbook/*` | static serving of the rendered handbook (traversal-safe) |
| `GET /api/jobs/:id`, `GET /api/jobs/:id/stream` | job status / SSE log stream |

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

## Dependencies

Internal: `@handbook/{core,llm,pipeline,planner,renderer,resync,skill}` — Studio is a
thin orchestration shell; every capability lives in the underlying packages. External:
`zod` (state file validation) only.
