# @handbook/renderer

The presentation arm of the toolchain. It takes a completed `HandbookModel` (loaded from a finished work directory by `@handbook/pipeline`) and renders it four ways: a markdown handbook for humans, an "agent locator" site optimized for coding agents, self-contained HTML (multi-page or single-page), and the `llms.txt` / `llms-full.txt` AI-agent entry files. Rendering is fully deterministic — no LLM, no network.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Render the markdown handbook: one page per content-bearing stage plus `overview.md` (including a mermaid stage map when the skeleton has more than one stage), `index.md`, and `register.md`.
- Render the llms.txt entry files: `llms.txt` (title, summary blockquote, linked table of contents over the markdown pages) and `llms-full.txt` (the whole handbook flattened into one plain-markdown document).
- Render the agent locator site: fixed-schema stage blocks (`Duty`, `Entry concepts`, `State`, `Exemplar`, `Strong co-change`, `Core files`), `how_to_use.md`, and a `disambiguation.md` built from a title-token collision index.
- Render self-contained HTML: a multi-page site with sidebar TOC/theme toggle, and a single-page variant with numbered collapsible sections.
- Render the per-file leaf content shared by all outputs (`renderFileCardMd`), including graph-fact call lines.
- Support both narration languages (`en`/`zh`) through internal label tables.
- Does NOT generate or modify handbook content — narration gaps fall back to stage descriptions/titles, never to new prose.
- Does NOT read the work directory; its only input is the `HandbookModel` boundary type.

## Public API

Markdown handbook (`markdown.ts`):

- `renderMarkdownHandbook(model, outDir, options?): { nStagePages, files }` — write `<sid>.md` per content stage plus `overview.md` (with the mermaid stage map), `index.md`, and (when registers exist) `register.md`; appends idempotent per-stage register sections. `options: { sourceBaseUrl? }` — see below.
- `stageSectionMarker(lang)` — the marker heading used for those idempotent appends.

llms.txt entry files (`llms-txt.ts`):

- `renderLlmsTxt(model, outDir): { files }` — write `llms.txt` and `llms-full.txt` into `outDir` (the same directory the markdown handbook was rendered into, so the `llms.txt` links resolve). `llms.txt` follows the llms.txt convention: `# title`, a `>` summary blockquote derived from the system-overview narration, then a `## Handbook` link list (overview, top-level stages, register page) with one short description per line. `llms-full.txt` is the full handbook content in reading order — overview prose, stage map, each stage's narration plus its organized file listing with purposes, registers — as plain link-free markdown.

Agent locator site (`agent-site.ts`):

- `renderAgentSite(model, outDir): { nStagePages, nCollisions }` — write `how_to_use.md`, `index.md`, `disambiguation.md`, and one locator page per content stage.

HTML (`html.ts`):

- `renderHtmlSite(model, outDir, options?): { nPages }` — multi-page site (`index.html` redirect, `overview.html`, `register.html`, `<sid>.html`) with a shared shell (sticky sidebar, breadcrumb, persisted theme toggle, expand/collapse-all). `options: { sourceBaseUrl? }` — see below.
- `renderSinglePageHtml(model, outPath): { bytes }` — one self-contained page; every stage is a numbered, collapsed `<details>` section.

Source links (`SourceLinkOptions`):

- `renderMarkdownHandbook` and `renderHtmlSite` accept an optional `{ sourceBaseUrl }`. When set, every file card's path becomes a hyperlink to `<base>/<path>` (trailing `/` stripped from the base, path segments URL-encoded, `/` kept), e.g. a repo blob URL. When not set, output is byte-identical to before the option existed and contains no external URLs.

File cards (`file-card.ts`):

- `renderFileCardMd(rel, card, lang, options?)` — full markdown card for one file: role/lifecycle badges, description (falling back to purpose), per-function details; `options: { sourceBaseUrl? }` links the heading path to the source file.
- `fileOneLiner(rel, card)` — one-line `- \`rel\` — purpose [role]` entry.
- `callFactsLine(fn, lang)` — the structural call-graph fact line for one `FunctionNote`.
- `REL_NAMES_CAP` — names shown per relation list before collapsing to `(+K more)`.

## Usage

```ts
import {
  renderMarkdownHandbook,
  renderAgentSite,
  renderHtmlSite,
  renderSinglePageHtml,
  renderLlmsTxt,
} from '@handbook/renderer';
import { loadHandbookModel } from '@handbook/pipeline';

const model = loadHandbookModel('/path/to/work', 'My Project Handbook');

const md = renderMarkdownHandbook(model, '/path/to/out');
const llms = renderLlmsTxt(model, '/path/to/out'); // same dir so llms.txt links resolve
const agent = renderAgentSite(model, '/path/to/out/agent');
const html = renderHtmlSite(model, '/path/to/out/html');
const single = renderSinglePageHtml(model, '/path/to/out/handbook.html');

// Opt in to source links (markdown + multi-page HTML only):
renderMarkdownHandbook(model, '/path/to/out', { sourceBaseUrl: 'https://forge.example/repo/blob/main' });

console.log(md.nStagePages, llms.files, agent.nCollisions, html.nPages, single.bytes);
```

## Design notes

- No LLM anywhere: every output is a pure function of the `HandbookModel`, so rendering is instant, reproducible, and safe to re-run.
- Self-contained HTML: all CSS/JS is inlined, every link is relative, and there are no external assets, so both HTML outputs work over `file://` and can be shipped as-is. External URLs appear only when `sourceBaseUrl` is explicitly passed.
- The mermaid stage map is emitted into the markdown outputs only (`overview.md` and `llms-full.txt`) — the HTML outputs deliberately do NOT embed it, because rendering mermaid would require a JS library and the HTML must stay dependency-free.
- Agent locator fields are gated on structural signals: a field (co-change twins, register hits, collisions, exemplars) is emitted iff its signal exists, and `how_to_use.md` tells agents that an empty field is information — never something to invent.
- Content gating is uniform: a stage gets a page/summary iff it has children or directly assigned files (`HandbookView.hasContent`), so empty skeleton nodes never produce empty pages.
- The disambiguation index is computed from stage-title token collisions (document frequency 2–6, pure ancestor chains excluded), giving agents a deterministic "this word lands in several stages" map.
- Markdown register sections are appended behind a marker heading, so re-rendering over an existing output directory stays idempotent.

## Dependencies

Internal:

- `@handbook/core` — `HandbookModel` and friends, `StageTree`, atomic writes, text helpers.

External:

- `markdown-it` — renders narration/description markdown to HTML for the two HTML outputs (markdown outputs need no dependency).
