# @handbooks/cli

## 1.2.0

### Minor Changes

- d98c19f: Three fixes to the one config layer that gets committed.

  `llmExtraBody` is now declared secret: it is free-form, gateways do take auth in
  the request body, and a key-name heuristic would pass whatever shape it was not
  taught — so it loses its `--extra-body` flag (shell history, `ps`) and is
  refused in a config file, leaving `OPENAI_EXTRA_BODY` /
  `HANDBOOK_LLM_EXTRA_BODY` as the route. `llmBaseUrl` stays a flag and stays
  welcome in a committed file, because a shared gateway URL is exactly what that
  file is for; what is refused there is a URL carrying RFC 3986 userinfo
  (`https://user:pass@gw.internal/v1`), which is a credential by position and so
  needs no guessing.

  `handbook config` no longer dies when the config **file** is the broken thing.
  Unparseable YAML, a path that is a directory, a file the process cannot read —
  each used to throw during bootstrap and take down the one command whose job is
  to explain that situation. It now prints the file, the reason, and the rest of
  the resolved configuration, and still exits 2 under `--check`. Every other
  command still refuses to run rather than falling back to defaults.

  An unknown config-file key is reported instead of silently doing nothing:
  `generate: {readWorker: 4}` warns and names `generate.readWorkers`. A warning,
  not a failure, so a file written for a newer Handbook keeps working — but
  `handbook config --check` counts it as a problem and exits 2.

- 8141e26: Configuration is declared once and derived everywhere. A registry in
  `@handbooks/core` is the single source for every setting, and the CLI options, the
  environment variables, `handbook.config.yaml`, `.env.example` and
  `docs/configuration.md` are all generated or resolved from it. Precedence is
  flag > shell env > .env > config file > default, and every resolved value carries
  its source.

  Before this, exactly one of ~45 flags (`--title`) could also be set from the
  environment. Now all of them can, and eight LLM endpoint flags exist that did not
  (`--model`, `--base-url`, `--max-tokens`, `--timeout`, `--llm-retries`,
  `--llm-retry-backoff`, `--llm-concurrency`, `--extra-body`), along with six
  pipeline tuning knobs that were reachable from neither a flag nor an env var
  (`--read-batch-size`, `--max-chars-per-file`, `--assign-batch-size`,
  `--assign-workers`, `--organize-workers`, `--narrate-workers`).

  `handbook config` prints every setting, its value and where that value came from,
  with secrets masked. `--check` validates and exits non-zero.

  Studio's bind address is configurable (`--host`, default `127.0.0.1`) and the
  repo ships a container image. The Host-header CSRF guard is unchanged: binding
  wide does not widen who may talk to it.

  BREAKING: an invalid `OPENAI_*` / `HANDBOOK_*` value now fails loudly instead of
  falling back to a default. `OPENAI_MAX_TOKENS=lots` used to run at 16000 in
  silence; it now names the variable and exits non-zero.

- 7e5bf54: First published release, with all eleven packages on one version.

  They are used as a set — a `@handbooks/cli` run loads the pipeline, which loads
  the analyzer, the renderer and the LLM seam — so a reader picking a version
  should not have to work out why `@handbooks/patcher` is two patch releases
  behind `@handbooks/core`. The changesets accumulated before this point would
  have produced exactly that: seven packages at one minor and four at a patch.

  Listing every package at `minor` is what holds them together: changesets takes
  the highest bump per package, so the ones whose pending changes were patches
  come along to the same version instead of lagging.

- bc4b62c: Support endpoints that are not OpenAI-compatible: `--provider anthropic` and
  `--provider gemini` alongside the default `openai`. A provider supplies only its
  wire format (URL and headers, request body, response parse); retries, deadlines,
  cancellation, permanent-error classification and usage metering stay shared.

### Patch Changes

- 9550a4b: Add `HANDBOOK_ENV_FILE` as a collision-free equivalent of `--env-file`.

  Node 20.6 introduced its own `--env-file` flag, and node pre-scans the entire command
  line for it — including the part after the script path, where it does not apply the
  file. A path that exists therefore reaches the CLI untouched, but a path that does not
  exist kills the process first:

      $ handbook --env-file /gone.env config
      node: /gone.env: not found        # node, exit 9, before main.ts runs

  which is precisely the case `--env-file` is documented to report loudly. An environment
  variable cannot be intercepted, so `HANDBOOK_ENV_FILE` is now the reliable route. The
  flag keeps working whenever the file is actually there, and still wins when both are set.

- b983e84: Studio now exposes the whole config registry, and the rendered HTML got a real docs UI.

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

- c5223da: Take `handbook --version` from the CLI's own manifest instead of a second copy of it.

  It was `.version('0.1.0')`, a literal, while the manifests had moved to `1.1.0` — so
  the flag whose only job is to say which version is installed named one that had not
  existed for two minor releases. That is worse than unhelpful in a bug report: a
  version string is what a maintainer trusts to decide whether a fix is already present.

  The cause is structural, not a typo. `changeset version` rewrites `package.json` and
  nothing else, so any literal elsewhere drifts by one release every time the tool does
  its job — which is why the fix reads the manifest rather than correcting the number.
  `rootDir` is `src` and `outDir` is `dist`, so `../package.json` is the manifest both
  from source and from the published tarball; npm includes it regardless of `files`.

  An unreadable or versionless manifest yields `0.0.0-unknown` rather than throwing:
  `--version` is built at module load, so a damaged install must not take every other
  command down with it, and a deliberately implausible string cannot be mistaken for a
  real release. `scripts/smoke-install.mjs` already compared the two — it is what caught
  this, against a real `npm install` of the packed tarballs — but only under
  `check:all`; the drift now also fails `pnpm check`.

- Updated dependencies [1fac45b]
- Updated dependencies [d98c19f]
- Updated dependencies [8141e26]
- Updated dependencies [088fd93]
- Updated dependencies [7e5bf54]
- Updated dependencies [1fac45b]
- Updated dependencies [bc4b62c]
- Updated dependencies [6457d66]
- Updated dependencies [d7628b3]
- Updated dependencies [088fd93]
- Updated dependencies [b983e84]
- Updated dependencies [0abe557]
- Updated dependencies [2a83a09]
  - @handbooks/analyzer@1.2.0
  - @handbooks/core@1.2.0
  - @handbooks/llm@1.2.0
  - @handbooks/pipeline@1.2.0
  - @handbooks/studio@1.2.0
  - @handbooks/patcher@1.2.0
  - @handbooks/planner@1.2.0
  - @handbooks/renderer@1.2.0
  - @handbooks/resync@1.2.0
  - @handbooks/skill@1.2.0
