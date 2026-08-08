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

| Function                 | Output                                                                       | Audience |
| ------------------------ | ---------------------------------------------------------------------------- | -------- |
| `renderMarkdownHandbook` | `overview.md`, `index.md`, `register.md`, one page per stage                 | humans   |
| `renderHtmlSite`         | A multi-page site with a shared shell                                        | humans   |
| `renderSinglePageHtml`   | One self-contained `.html` file                                              | humans   |
| `renderAgentSite`        | `how_to_use.md`, `index.md`, `disambiguation.md`, one locator page per stage | agents   |
| `renderLlmsTxt`          | `llms.txt` + `llms-full.txt`                                                 | agents   |

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
index.md         every stage, nested by depth, with a paragraph each
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

| Field               | Meaning                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **duty**            | What this stage is responsible for                                                                                                |
| **entry concepts**  | The vocabulary that routes here — derived from file stems, with generic tokens (`util`, `main`, `index`, `types`, …) filtered out |
| **state**           | Registers this stage reads or writes                                                                                              |
| **exemplars**       | The files that best represent the stage                                                                                           |
| **co-change hints** | Files that tend to move together, from call-graph adjacency                                                                       |
| **core files**      | Highest-degree files in the stage                                                                                                 |

### The data-gating invariant

**A field is emitted if and only if its structural signal exists.** No placeholders, no
"N/A", no hedging. An empty field means _"the graph has no signal here"_ — which is real
information — rather than _"the model did not know"_, which is noise an agent will
happily reason on top of.

`disambiguation.md` handles the opposite problem: when one term legitimately points at
several stages, it lists them side by side with what distinguishes them, so an agent can
choose instead of guessing. `strongTwins` and `buildCollisionIndex` are what detect those
collisions.

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
