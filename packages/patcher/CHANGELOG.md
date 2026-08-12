# @handbooks/patcher

## 1.2.0

### Minor Changes

- 7e5bf54: First published release, with all eleven packages on one version.

  They are used as a set — a `@handbooks/cli` run loads the pipeline, which loads
  the analyzer, the renderer and the LLM seam — so a reader picking a version
  should not have to work out why `@handbooks/patcher` is two patch releases
  behind `@handbooks/core`. The changesets accumulated before this point would
  have produced exactly that: seven packages at one minor and four at a patch.

  Listing every package at `minor` is what holds them together: changesets takes
  the highest bump per package, so the ones whose pending changes were patches
  come along to the same version instead of lagging.

### Patch Changes

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

- Updated dependencies [d98c19f]
- Updated dependencies [8141e26]
- Updated dependencies [088fd93]
- Updated dependencies [7e5bf54]
- Updated dependencies [bc4b62c]
- Updated dependencies [0abe557]
  - @handbooks/core@1.2.0
