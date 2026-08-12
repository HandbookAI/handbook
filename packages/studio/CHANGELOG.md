# @handbooks/studio

## 1.2.0

### Minor Changes

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

### Patch Changes

- 088fd93: Studio's SSE job stream no longer lets a subscriber that stopped reading grow the
  server's memory without bound.

  `res.write()` never refuses, so a subscriber that connects and then stops reading —
  a browser tab throttled in the background, a paused debugger, a `curl` piped into
  something slow, a half-open socket — made Node buffer every log line in the studio
  process for as long as the job ran. Measured: one non-reading loopback socket held
  8 MB after 4000 lines and would have kept going, and a `generate` on a large repo
  emits thousands.

  Writes now stop the moment the response reports backpressure, live lines queue into
  a bounded buffer (512 lines / 1 MB), and once it is full the OLDEST are dropped and
  the gap is disclosed as its own `dropped` SSE event, in the position it happened —
  the drawer prints "N log lines dropped … reload to see the full log", in all eight
  locales. The two alternatives were both worse: pausing the producer slows a run down
  for a spectator, and hanging up on the subscriber makes this UI report a job that is
  still running as finished. The full log is still kept on the job and re-fetchable,
  which is what makes a gap in the live view affordable.

  Two details this depends on: the backlog replay walks `job.log` by index rather than
  being queued, so a healthy subscriber — whose multi-megabyte replay trips
  backpressure within its first ~30 lines — still receives all of it; and `progress` is
  coalesced rather than queued, because a progress event is a snapshot and an older one
  is worthless.

- 2a83a09: Fix three path guards that were quietly platform-dependent, all found by running the
  suite on Windows for the first time in a while.

  `apply`'s "the parent path is a regular file" refusal never ran on Windows. It split the
  edit's path on `/` after `path.normalize`, which hands back NATIVE separators there, so
  `blocker/child.py` became one segment, the ancestor loop had nothing to walk, and the
  refusal the caller was owed arrived as a raw `EEXIST: mkdir` thrown out of the write
  phase — a `not-a-file` outcome on every other platform. Plan paths are POSIX by rule
  (`parse` rejects a backslash as "must use forward slashes"), so the path is converted
  back with `toPosix` rather than split on both separators: on POSIX a backslash is a legal
  filename character and must not split.

  `apply` also could not patch a read-only file on Windows. A rename needs a writable
  PARENT directory on POSIX, and the file's own mode is irrelevant; Windows additionally
  consults the destination's read-only attribute and refuses with `EPERM`, so one
  `mode 444` file failed the entire apply — after staging, mid-rename, reported as an
  errno rather than an outcome. The write bit is now added only after the OS has actually
  refused, and the recorded mode is restored either way, so the file's mode is unchanged
  by the time `apply` returns and no platform pays for the extra syscalls on the path
  where the rename works.

  Studio's registry accepted a work dir whose symlink target does not exist yet — the
  normal case, since studio creates the work dir AFTER the entry is accepted, and the run
  that creates it is exactly the run that would drop artifacts inside the source tree.
  `realpath` fails on a dangling link, and the containment check fell back to comparing the
  link's own path, which turns every overlap test in that file back into the string
  comparison it exists to replace. It now reads the link and resolves its target (bounded,
  so a link pointing at itself cannot spin). Windows reached the same fallback for a link
  that was NOT dangling: a file-typed symlink to a directory does not resolve there at all.

- Updated dependencies [1fac45b]
- Updated dependencies [d98c19f]
- Updated dependencies [8141e26]
- Updated dependencies [088fd93]
- Updated dependencies [7e5bf54]
- Updated dependencies [1fac45b]
- Updated dependencies [bc4b62c]
- Updated dependencies [6457d66]
- Updated dependencies [d7628b3]
- Updated dependencies [b983e84]
- Updated dependencies [0abe557]
- Updated dependencies [2a83a09]
  - @handbooks/analyzer@1.2.0
  - @handbooks/core@1.2.0
  - @handbooks/llm@1.2.0
  - @handbooks/pipeline@1.2.0
  - @handbooks/patcher@1.2.0
  - @handbooks/planner@1.2.0
  - @handbooks/renderer@1.2.0
  - @handbooks/resync@1.2.0
  - @handbooks/skill@1.2.0
