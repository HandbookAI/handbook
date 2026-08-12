# @handbooks/core

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

- 088fd93: Stop dropping two things the pipeline already knew: files no stage claims, and files the
  parser could not read.

  **Files in no stage.** `assignment.coverage.unassigned` was part of `HandbookModel` and
  no renderer read it. Every page is built from `assignment.buckets`, which excludes those
  files by construction, while the headline count is `coverage.nFiles`, which includes
  them — so a handbook could say "300 files", contain 260 cards, and name the other 40
  nowhere at all: no page, no `llms.txt`, no agent index. The markdown stage index, the
  HTML overview (and the single-page render), the agent locator index and `llms-full.txt`
  now list them explicitly with a one-line explanation, `llms.txt` discloses the split, the
  HTML search index resolves those paths instead of dead-ending, and any printed total now
  reads `assigned / total` rather than a number the pages themselves contradict.

  **Files the parser could not read.** The adapter driver had two silent `continue`s — an
  unreadable file and a null parse tree — and nothing anywhere consulted
  `rootNode.hasError`. All three left the file in `graph.metadata.scannedFiles` with zero
  functions, so the cards pass described it as "a file with 0 functions" and
  `_coverage.json` counted it as fully described: the handbook asserted, as a parser fact,
  something no parser had seen. Analyses now carry `unparsedFiles` (`unreadable` /
  `unparsable` / `partial`, each with its real cause), phase 1 writes them to
  `phase1/scan-coverage.json` beside `dropped-calls.json` and stamps them into
  `graph.metadata`, files that yielded no facts are kept out of `scannedFiles`, partially
  parsed files stay but are disclosed as incomplete, and phase 1 closes with a line naming
  the gap.

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
- 0abe557: Index named types — class, interface, struct, record, enum, trait, alias — as parsed facts,
  and declare per adapter which languages that covers.

  **The gap.** The IR had `functionNodeSchema` and `boundaryNodeSchema` and no node kind for
  a type, so the agent artifact's `symbols.tsv` was a function index wearing a symbol
  index's name. Measured on this repository, an exact-name lookup returned **zero rows** for
  `HandbookModel`, `StageTree`, `FileCard`, `FunctionNote`, `LanguageAdapter` and
  `ChatClient`. `core/src/model.ts` yielded eight rows — `children`, `coerceRole`,
  `constructor`, `depth`, `description`, `isCrosscut`, `subtree`, `title` — and not the two
  things the file is for. It now yields those two plus fourteen more, each with the line span
  of its own declaration.

  **`TypeNode` is a sibling of the call graph, not a third kind inside it.** `graph.nodes` is
  the call graph's vertex set: every member is a possible edge endpoint, and thirteen places
  walk it asking `isInternalNode(node)`. A third `kind` would make every one of them correct
  only by remembering to ask, and two are already wrong under that change — `graphDot`'s
  `else` files everything non-internal into the "boundary" cluster, and
  `metadata.nInternalFunctions` counts `kind === 'internal'`. Types therefore live in
  `graph.types` (and `FileCard.types`), so every existing consumer stays correct untouched
  and a new one has to name them. It also avoids a real id collision: in TypeScript
  `interface Foo {}` and `function Foo() {}` legally coexist, and ids carry a `type:` prefix.

  **A type's span is parsed or it does not exist.** `lineStart` is positive by schema. The
  interim it replaces derived a class's span from `min..max` of its **methods** — where the
  members are, not where the declaration is — and a fabricated line range is the one kind of
  wrong an agent cannot detect: a stale path fails to open and a stale name greps nothing,
  while a made-up range opens the wrong code in silence.

  **Coverage is partial and declared, per invariant 3.** `AdapterCapabilities` grows
  `typeKinds`, a list rather than a boolean because the honest answer is per kind — Go has no
  `class`, and an adapter could easily find classes and miss every interface. Real extraction
  ships for **all twelve full-tier adapters with types**: TypeScript, Python, Go, Rust, Java,
  C#, C/C++, Ruby, PHP, Swift, Dart and Solidity. Shell declares `typeKinds: []` because the
  language has no named types, and the whole generic tier declares `[]` on purpose — a
  pattern-matched type row would be indistinguishable from a parsed one at a lower fidelity,
  which is the trap invariant 3 exists to prevent. An empty list is a positive statement, not
  a silence. `register.test.ts` runs every adapter against a fixture and compares the
  declaration to what was emitted **in both directions**, so an under-claim and an over-claim
  both fail the build. `agent/index.md` names which languages are indexed (with their kinds)
  and which are not, so an agent that greps a Kotlin interface and finds nothing knows it has
  a gap rather than an answer. Where an adapter extracts no types, the labelled
  `class-derived` row still covers its classes.

  **The vocabulary is closed** — `class` `interface` `struct` `record` `enum` `trait` `alias`
  `other` — like `FILE_ROLES`. A construct that fits none of the first seven gets `other`
  rather than the nearest-looking bucket: a Go _defined_ type (`type Celsius float64`) is not
  an alias, a Rust or C++ `union` is not a struct, a Java `@interface` is not an interface, a
  C# `delegate` is not an alias (two with the same signature are distinct types), a Solidity
  `library` is not a class (not instantiable, no state) and a Solidity `type X is Y` is not an
  alias (it needs wrap/unwrap). A Ruby `module` is `other` for a different reason — one
  keyword doing two unrelated jobs, namespace and mixin, with nothing in the declaration
  saying which — whereas a Dart `mixin`, whose keyword has exactly one job, is a `trait`.
  `TypeNode.signature` carries the declaration **as written**, so `other` never loses the
  native keyword.

  `symbols.tsv` also stops printing `0` in `nCalledBy` on a row that is not a function: a
  type has no callers — `new T()` resolves to `T.constructor` — and `0` in the column an
  agent uses to judge blast radius reads as dead code. It is now `-`.
