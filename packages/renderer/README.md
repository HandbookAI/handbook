# @handbook/renderer

**English** · [中文](README.zh-CN.md)

> Turn a generated handbook into things people open and things agents route with.
> Four output formats, no LLM, no network, no build step.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Frenderer-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbook/renderer)
[![no LLM](https://img.shields.io/badge/LLM-never-2dd4bf?style=flat-square)](#)

---

## What it is

The presentation arm of the [Handbook](../../README.md) toolchain. It takes a
`HandbookModel` — the boundary type produced by `@handbook/pipeline` — and writes:

| Function                 | Output                                                                 | Audience |
| ------------------------ | ---------------------------------------------------------------------- | -------- |
| `renderMarkdownHandbook` | `overview.md`, `index.md`, `register.md`, one page per stage           | humans   |
| `renderHtmlSite`         | A multi-page site with a shared shell                                  | humans   |
| `renderSinglePageHtml`   | One self-contained `.html` file                                        | humans   |
| `renderAgentSite`        | `index.md`, `symbols.tsv`, `files.tsv`, `calls.tsv`, `stages/<sid>.md` | agents   |
| `renderLlmsTxt`          | `llms.txt` + `llms-full.txt`                                           | agents   |

**Generation is expensive and happens once. Rendering is free and can happen on every
commit.** That split is the whole reason this is a separate package.

---

## Install

```bash
pnpm add @handbook/renderer
```

---

## Quick start

```ts
import { loadHandbookModel } from '@handbook/pipeline';
import {
  renderMarkdownHandbook,
  renderHtmlSite,
  renderSinglePageHtml,
  renderAgentSite,
  renderLlmsTxt,
} from '@handbook/renderer';

const model = loadHandbookModel('work/myrepo', 'MyRepo Handbook');
const out = 'work/myrepo/handbook';

renderMarkdownHandbook(model, out, { sourceBaseUrl: 'https://github.com/me/repo/blob/main' });
renderHtmlSite(model, `${out}/html`);
renderSinglePageHtml(model, `${out}/handbook.html`);
renderAgentSite(model, `${out}/agent`);
renderLlmsTxt(model, out);
```

Or:

```bash
handbook render --work work/myrepo --title "MyRepo Handbook" \
    --html --html-single --agent-site --llms-txt \
    --source-base-url https://github.com/me/repo/blob/main
```

---

## The markdown handbook

```
overview.md      system prose + a mermaid stage map + "see also" links
index.md         every stage, nested by depth, with a paragraph each,
                 plus the files no stage claims
<stage-id>.md    one page per content-bearing stage
register.md      the cross-stage state table (only when registers exist)
```

A stage page carries the stage's summary, links to sub-stages, then its files — grouped
and ordered as phase 2c decided, each rendered as a **file card**: purpose, role,
lifecycle, call facts, and (for deep cards) per-function notes.

Two details that matter more than they look:

- **Stale pages are cleaned up.** Stage ids change between generations. Each render
  writes a manifest of what it produced and removes the previous render's pages first, so
  a renamed stage does not leave a ghost page behind for the skill packager to scoop up.
- **The per-stage register section is idempotent.** It is appended under a marker and
  only if the marker is absent, so re-rendering never stacks duplicates.
- **Files in no stage are named, not silently dropped.** Every page is built from
  `assignment.buckets`, which excludes them, while the headline count is
  `coverage.nFiles`, which includes them — so the index, the HTML overview, the agent
  index and `llms-full.txt` all list them explicitly, and any printed total says
  `assigned / total` rather than a number the pages contradict.

Both English and Chinese are first-class: every label, heading and table header is
localized from `model.lang`. **The structure is identical in both**, so tooling that reads
the output does not need to know which language it is in.

---

## The HTML site

`renderHtmlSite` writes `index.html`, `overview.html`, `register.html` and one page per
stage, all sharing one shell:

- sticky sidebar table of contents with the current page highlighted
- breadcrumb navigation
- a theme toggle that persists your choice
- expand-all / collapse-all for function details

`renderSinglePageHtml` writes the whole handbook as **one file** with numbered sections
and every stage as a collapsed `<details>`.

**All CSS and JS is inlined and every link is relative.** Both work over `file://` — no
server, no CDN, no fonts fetched from anywhere. You can attach the single-page output to
a ticket and it just opens.

---

## The agent locator index

This is the format built specifically for code agents, and it is deliberately _not_ prose.
Each stage gets a fixed-schema locator block:

| Field                | Meaning                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **duty**             | What this stage is responsible for                                                                                                                                                                                      |
| **entry concepts**   | The vocabulary that routes here — derived from file stems, with generic tokens (`util`, `main`, `index`, `types`, …) filtered out                                                                                       |
| **state**            | Registers this stage reads or writes                                                                                                                                                                                    |
| **exemplars**        | The files that best represent the stage                                                                                                                                                                                 |
| **strong co-change** | A test file sitting _beside_ its source (`engine.go` + `engine_test.go`). Deliberately the sparsest field: most projects put tests in a separate tree, so it is usually absent — which is the gating working, not a gap |
| **core files**       | Highest-degree files in the stage                                                                                                                                                                                       |

### The data-gating invariant

**A field is emitted if and only if its structural signal exists.** No placeholders, no
"N/A", no hedging. An empty field means _"the graph has no signal here"_ — which is real
information — rather than _"the model did not know"_, which is noise an agent will
happily reason on top of.

### Facts, not prose

The agent artifact and the human handbook used to render the **same prose in different
shapes**, which is how the agent one ended up 2.1× the size of the human one while
containing no symbol locations at all. The split now:

**The human artifact explains. The agent artifact locates.**

Where an agent needs the explanation it is one hop away — the stage page links
`../<sid>.md` — rather than copied.

| file              | answers                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.md`        | the only always-read file: grep recipes, a stage table, the register table, coverage. Hard cap 4 KB, because it is paid on every session _and_ every subagent spawn |
| `symbols.tsv`     | `name → path:startLine-endLine`, plus kind, stage, nCalledBy, signature                                                                                             |
| `files.tsv`       | `path → stage, role, nSymbols, purpose[prose]`                                                                                                                      |
| `calls.tsv`       | resolved call edges, both endpoints located                                                                                                                         |
| `stages/<sid>.md` | second hop: the stage's files and its co-change pairs                                                                                                               |

TSV rather than markdown tables, for reasons measured on this repo: 338 signature rows
contain `|` (TypeScript union types) which a table would mangle silently; one fact per
line survives truncation, where a table's header, alignment row and body only mean
something together; and a tab anchors a whole column in grep where a bare name matches
any substring of any column.

Column order is **value order** — what you looked up first, prose last — because
consumers clip long lines, and clipping must eat prose before it eats a path.

### What is a fact and what is not

Invariant 1 says parser facts and model prose are never mixed. In this artifact that is
enforced by position and by label: prose appears in exactly one column, it is last, it is
clipped to 120 characters, and its header says `purpose[prose]`.

Two places where the artifact could have quietly invented something and does not:

- **A type row says whether its span was parsed or inferred.** `kind=type:<class|interface|
struct|record|enum|trait|alias|other>` is a real declaration, its span read off the
  declaration node. `kind=class-derived` is the fallback for a language whose adapter
  extracts no types: the span is `min..max` of the class's _methods_ — where the members
  are, not where the declaration is. Emitting that unmarked would put an invented number in
  the column an agent trusts most. And because type extraction is partial,
  `index.md` names **which languages are indexed and which are not** (from
  `graph.metadata.languages[…].typeKinds`) — an agent that greps a type, finds nothing, and
  concludes the type does not exist is a _wrong pointer_, the failure this artifact exists
  to avoid. `nCalledBy` is `-` on any non-function row rather than `0`, because a type has
  no callers and `0` in that column reads as dead code.
- **A call that leaves the scanned set gets `boundary:<specifier>` as its location**, never
  a path. In a monorepo this matters more than it sounds: cross-package calls arrive as
  unfollowed imports, and with resolved edges only, a function called exclusively from
  another package showed zero callers — which reads as dead code.

---

## llms.txt

Follows the [llms.txt](https://llmstxt.org/) convention:

- **`llms.txt`** — an H1 title, a one-sentence summary blockquote, then a `## Handbook`
  section linking each markdown page with a short description.
- **`llms-full.txt`** — the entire handbook flattened into one plain-markdown document in
  reading order: overview prose, the mermaid stage map, each stage's narration and file
  listing, then the registers.

Both are self-contained and honour `model.lang`.

---

## Options

```ts
interface RenderOptions {
  /** Turn every file-card path into a link to the source. Opt-in. */
  sourceBaseUrl?: string;
  /** Per-language analysis capabilities; drives the fidelity disclosure. Opt-in. */
  languages?: Record<string, AdapterCapabilities>;
}
```

Both are opt-in and both are no-ops when absent — without `sourceBaseUrl` the output
contains **no external URLs at all**, which matters if you are shipping a handbook for a
private codebase.

When `languages` shows any generic-tier language, the overview gains one disclosure line:

> **Analysis fidelity** — call relations for Kotlin, Scala come from the generic
> (config-driven) analyzer: they are best-effort and may be incomplete. The file inventory
> and the structure of these languages are exact.

It appears right under the overview prose, where a reader forms their trust in the call
facts — and **nowhere at all** when every language is full-tier, so the common case stays
noise-free.

---

## API

```ts
renderMarkdownHandbook(model, outDir, options?): { nStagePages: number; files: string[] }
renderHtmlSite(model, outDir, options?)
renderSinglePageHtml(model, outPath, options?)
renderAgentSite(model, outDir, options?)
renderLlmsTxt(model, outDir, options?)

// building blocks, exported because they are useful on their own
class HandbookView                  // stage tree + cards + organization, resolved
stageMapMermaid(tree): string
renderFileCardMd(file, card, lang, options): string
fileOneLiner(rel, card): string
callFactsLine(fn, lang): string
genericTierLanguages(languages): string[]
stageSectionMarker(lang): string
```

`HandbookView` is the shared resolver every renderer sits on: which stages have content,
which files belong directly to a stage, how groups resolve, which registers touch a
stage. Writing a new output format means using it, not re-deriving it.

---

## Guarantees

- **Deterministic.** Same model in, byte-identical files out. Safe to commit and diff.
- **Offline.** No network, no LLM, no external assets, no fonts.
- **Injection-safe tables.** Register semantics and stage titles are free text from an
  LLM; `|` is escaped and newlines are flattened so a stray character cannot break a table
  or open a column.
- **Path-safe filenames.** Stage ids are schema-restricted to filename-safe characters, so
  a `/` or `..` in LLM output can never write outside the output directory.

---

## Testing

```bash
pnpm --filter @handbook/renderer test
```

Rendering is asserted on real fixture models, including the ugly ones: empty stages,
missing prose, zero registers, mixed fidelity, CJK titles and pipe characters in table
cells.

---

Part of [Handbook](../../README.md) · [Artifact formats](../../docs/content/docs/reference/artifacts.mdx) · MIT
