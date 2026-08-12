---
'@handbooks/studio': minor
'@handbooks/renderer': minor
'@handbooks/cli': patch
---

Studio now exposes the whole config registry, and the rendered HTML got a real docs UI.

Studio: a registry-served `/api/settings` surface; new `render`, `skill` and
`validate` endpoints; generate forwards all six batch/worker settings it used to
discard; `llmCache` wraps the client like the CLI does; per-job LLM overrides
(model, base URL, tokens, timeouts — never the API key, which is now explicitly
rejected over HTTP); `analyze` honours `lang`; `plan` honours `maxTurns`; `apply`
honours `backupRoot`; resync honours `proseLang`/`cardDetail`/`refreshRendered`/
`corrections` and pre-validates to a 400; evolution auto-descriptions follow the
handbook's own prose language instead of always Chinese; `logLevel: debug`
reaches job logs; last-used params are remembered per job kind.

Renderer: the multi-page site and single-page HTML are a full documentation UI —
numbered sidebar tree, per-page table of contents with scroll-spy, ⌘K search
over stages/files/functions/registers, deep links that open enclosing
disclosures, tri-state theme, prev/next paging, copy buttons, mobile drawer —
all dependency-free and file:// -safe.
