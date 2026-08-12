# Security Policy

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: the **Security** tab → **Report a
vulnerability**. That opens a private advisory visible only to you and the maintainers, and
it is the only channel that lets a fix ship before the details are public.

Please include:

- What an attacker gains, and what they need in order to get it.
- A reproduction — ideally a minimal synthetic fixture rather than a real repository. The
  analyzer runs entirely locally, so a handful of files is usually enough.
- The version or commit, your OS and Node version.

You can expect an acknowledgement within **7 days** and an assessment within **30**. This is
a volunteer-maintained project; if the report is valid we will tell you what we intend to do
and when, and credit you in the advisory unless you'd rather we didn't. Please give us
**90 days** before disclosing publicly, or less by agreement if a fix is out sooner.

## Supported versions

Only the latest published minor of each `@handbooks/*` package receives fixes. There are no
long-term support branches. Versions are managed by
[changesets](https://github.com/changesets/changesets); see each package's `CHANGELOG.md`.

## Threat model

It is worth being precise about what this toolchain does, because two of its jobs are
security-relevant: it feeds **untrusted source code** to a language model, and it **writes
files into your repository**.

### Trust boundaries

| Input                                | Treated as                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| The analyzed repository (`--source`) | **Untrusted.** Parsed, never executed. Its contents reach LLM prompts.              |
| LLM responses                        | **Untrusted.** Validated mechanically before anything is written; prose is escaped. |
| A handbook work directory (`--work`) | Trusted-ish — derived output. Don't consume one you didn't generate.                |
| A plan handed to `handbook apply`    | **Requires your review.** `apply` writes to disk; that is the point of it.          |
| A resync case directory              | Untrusted the same way `--source` is.                                               |

### In scope

Report any of these:

- **Escaping the source root.** `handbook apply` resolves every write against the real path
  of the source root and refuses one that escapes it, including through a dangling symlink.
  A path, symlink or archive that gets a write outside the root — or past the backup and
  `rollback` path — is a vulnerability.
- **Code execution.** Anything that gets the analyzer, the renderer or the pipeline to
  execute code from the repository it is reading, or from a model response. Nothing in the
  pipeline should ever `exec`, `eval` or `import` analyzed source.
- **Injection into rendered output.** The HTML site is built from model-written prose and
  from source identifiers. Text is escaped on the way in; a payload that survives into
  `handbook.html` or the multi-page site and executes when opened is in scope.
- **Secret leakage.** The LLM API key is marked `secret` in the config registry: it has no
  CLI flag and no config-file route on purpose, so it cannot end up in a committed file
  through this tool. If you find a key in a work directory, a rendered artifact, a log line
  or an error message, that is a bug — report it.
- **Studio reachable off-host.** The Studio server binds `127.0.0.1` only and rejects
  non-loopback `Host` and `Origin` headers. Anything that makes it reachable from another
  machine, or that gets a browser page to drive it cross-origin, is in scope.
- **Path traversal in artifact serving.** Studio serves rendered files; a request that reads
  outside the work directory is in scope.
- Denial of service against the **directory lock** — a lock that can be stolen or that
  leaves a half-applied patch set behind.

### Out of scope

- **Prompt injection changing the _content_ of a handbook.** A repository can contain
  comments that steer a model's prose, and no prompting defends against that in general.
  The mitigations are structural, and they are the architecture: facts come from static
  analysis and are never invented by a model, structure is validated mechanically in an
  actor–critic loop, `plan` is read-only, and `apply` is a separate command you invoke after
  reading the plan. Injected prose is a correctness problem. Injected prose that turns into
  a **write you did not approve** is a vulnerability — report that.
- **Sending your source to your own LLM endpoint.** That is what the tool does. Which
  endpoint, and what its operator retains, is your configuration decision — `--no-llm`,
  `analyze`, `render` and `skill` never make a network call, and the demo runs against a
  bundled local mock.
- **Known documented parser crashes.** The Swift grammar aborts the process on V8 ≥ 13 and
  the adapter refuses at discovery rather than crashing; a shell script containing `case`
  is skipped. Both are reported in the scan log. A crash on hostile input is a bug worth
  filing as an issue; it is not a privilege boundary.
- Vulnerabilities in dependencies with no exploitable path through this code — file them
  upstream. Dependabot already opens PRs here weekly.
- Anything requiring an attacker who can already write to your repository or read your
  environment.

## Hardening notes for users

- Run `handbook analyze` (no LLM, no network) before anything else on a repository you don't
  trust.
- Keep the key in `.env`, which is git-ignored, and never in `handbook.config.yaml` — the
  config layer will refuse it there anyway.
- Read the plan before `handbook apply`. It prints a backup directory; `handbook rollback
--backup <dir>` undoes the whole set.
- Point `OPENAI_BASE_URL` at an endpoint you control if the source is confidential.
