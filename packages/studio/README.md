# @handbook/studio

**English** · [中文](README.zh-CN.md)

> The whole toolchain, in a browser tab. Register repositories, generate with live logs,
> browse the handbook, plan a change, dry-run it, apply it, roll it back, resync.
> Localhost only, by design.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fstudio-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbook/studio)
[![binds](https://img.shields.io/badge/binds-127.0.0.1-2dd4bf?style=flat-square)](#security-model)

---

## What it is

A local web UI over every other `@handbook/*` package. Same code paths as the CLI, same
config resolution, same artifacts on disk — just a different way to drive it.

```bash
handbook studio                    # → http://127.0.0.1:4860
handbook studio --port 5000        # or: pnpm studio --port 5000
```

**Zero build step.** The UI is one hand-written HTML file with inlined CSS and vanilla
JS — no bundler, no framework, no `node_modules` shipped to the browser, nothing fetched
from a CDN. It loads instantly and it works with the network cable unplugged.

---

## What you can do in it

| Area                 | What it does                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Repositories**     | Register a source tree + work dir under a URL-safe name. Persisted in one `studio.json`, so the server is stateless across restarts.                                 |
| **Generate**         | Kick off a run with the full parameter set (phase, strategy, detail, synth mode, narration language, worker counts). Logs stream live over SSE. Cancellable mid-run. |
| **Handbook browser** | Read the rendered handbook in place — overview, stage index, stage pages, register table.                                                                            |
| **Impact graph**     | Which files a stage owns, what calls into it, and what it calls out to.                                                                                              |
| **Source viewer**    | Open the real file behind any card, at the line the handbook cited.                                                                                                  |
| **Plan**             | Type a change request, watch the read-only agent work, read the resulting plan.                                                                                      |
| **Apply / rollback** | Dry-run first, then apply, with every backup listed and one-click rollback.                                                                                          |
| **Resync**           | Roll the handbook forward against the live tree — no case directory to assemble by hand.                                                                             |
| **History**          | Per-repo evolution: what each run changed, and when.                                                                                                                 |

---

## Install

```bash
pnpm add @handbook/studio
```

Or just use the CLI — `handbook studio` is this package.

---

## Embedding it

```ts
import { startStudio, createStudioServer } from '@handbook/studio';

await startStudio({
  stateDir: `${process.env.HOME}/.handbook-studio`,
  port: 4860,
  host: '127.0.0.1',
  clientFactory: (jobLogger) => new OpenAiChatClient({ config, logger: jobLogger }),
  configFile, // the already-loaded handbook.config.yaml layer
  logger,
});
```

Two parameters are worth explaining, because they are where a subtle bug used to live:

- **`clientFactory` receives the _job_ logger**, not the top-level one. A silent client
  hides retries and gateway blocks from the only log the user is actually watching.
- **`configFile` is passed through** so a generate job's parameters see the same
  `handbook.config.yaml` layer as every other command. Without it, `--model`, `--base-url`
  and a config-file `llm:` block silently did nothing for Studio while `--help` and
  `handbook config` both claimed they worked.

`createStudioServer` returns an unstarted `http.Server`, which is what the tests drive.

---

## Jobs

Generation, planning and resync run as **background jobs** with a captured log served over
Server-Sent Events.

- **One job per repo at a time.** The pipeline's artifacts are not safe for concurrent
  writers on the same work dir; a second start is refused with a clear message rather than
  allowed to interleave.
- **Cancellable.** Every job gets an `AbortController` whose signal is threaded all the
  way down into in-flight LLM requests. Cancel means cancel, not "stop showing me the log".
- **Statuses:** `running` → `succeeded` | `failed` | `cancelled`. The full log is kept, so
  you can read what happened after it finished.

---

## Security model

Studio is a **local tool**. It is not hardened for exposure and does not pretend to be.

- **It binds `127.0.0.1` by default.**
- **The CSRF guard checks the `Host` request header**, not the socket. Only loopback host
  names pass.
- **`POST` requires `application/json`**, which blocks the classic HTML-form cross-origin
  attack.
- **Repo names are validated** against `^[A-Za-z0-9][A-Za-z0-9._-]*$` before they touch
  the filesystem, and paths are realpath-normalized so two spellings of one tree compare
  equal.
- **Source and handbook file serving is sandboxed** to the registered roots.

### Running it in a container

A container must bind `0.0.0.0` for the published port to be reachable at all
(`HANDBOOK_STUDIO_HOST=0.0.0.0` in `docker-compose.yml`). **That does not widen who may
talk to it.** Browsing `http://localhost:4860` from the host still sends
`Host: localhost:4860` and passes; a request naming a LAN IP or the container hostname is
refused with `403`.

**Only `http://localhost:4860` works — not a LAN IP, not the container name.** Remote
access is a deliberately unimplemented, separate feature (it would need an explicit
allowlist), not a gap in this defence.

---

## HTTP API

The UI is just a client; the API is stable enough to script against.

| Method   | Path                          | Purpose                                                                   |
| -------- | ----------------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/`                           | The UI (also answers `HEAD`, so uptime probes get the truth)              |
| `GET`    | `/api/repos`                  | Registered repositories                                                   |
| `POST`   | `/api/repos`                  | Register one                                                              |
| `DELETE` | `/api/repos/:name`            | Unregister                                                                |
| `GET`    | `/api/repos/:name`            | One repo's state                                                          |
| `POST`   | `/api/repos/:name`            | Start a job: `analyze`, `generate`, `plan`, `resync`, `apply`, `rollback` |
| `GET`    | `/api/repos/:name/overview`   | Handbook overview + stage index                                           |
| `GET`    | `/api/repos/:name/graph`      | Impact graph data                                                         |
| `GET`    | `/api/repos/:name/source`     | A source file, sandboxed                                                  |
| `GET`    | `/api/repos/:name/handbook/*` | Rendered handbook files                                                   |
| `GET`    | `/api/repos/:name/patches`    | Backups available for rollback                                            |
| `GET`    | `/api/repos/:name/history`    | Evolution history                                                         |
| `GET`    | `/api/languages`              | Registered analyzer languages                                             |
| `GET`    | `/api/jobs`                   | All jobs                                                                  |
| `GET`    | `/api/jobs/:id`               | One job, or its SSE log stream                                            |
| `POST`   | `/api/jobs/:id/cancel`        | Cancel a running job                                                      |

---

## State

```
~/.handbook-studio/
  studio.json        the repository registry (schema-validated on read)
  work/<name>/       auto-created work dirs for repos that did not bring their own
```

`--state-dir` moves it. Everything else — handbook artifacts, evolution history — lives in
each repo's own work dir, so deleting the state directory loses the registry and nothing
that matters.

---

## Testing

```bash
pnpm --filter @handbook/studio test
```

The server is driven end to end over real HTTP: routing, the Host-header guard, the
content-type guard, path sandboxing, job lifecycle, cancellation and SSE streaming. There
is also a UI-drift test that keeps the hand-written HTML in step with the API it calls.

---

Part of [Handbook](../../README.md) · MIT
