# @handbook/renderer

The presentation arm of the toolchain. It takes a completed `HandbookModel` (loaded from a finished work directory by `@handbook/pipeline`) and renders it three ways: a markdown handbook for humans, an "agent locator" site optimized for coding agents, and self-contained HTML (multi-page or single-page). Rendering is fully deterministic — no LLM, no network.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Render the markdown handbook: one page per content-bearing stage plus `overview.md`, `index.md`, and `register.md`.
- Render the agent locator site: fixed-schema stage blocks (`Duty`, `Entry concepts`, `State`, `Exemplar`, `Strong co-change`, `Core files`), `how_to_use.md`, and a `disambiguation.md` built from a title-token collision index.
- Render self-contained HTML: a multi-page site with sidebar TOC/theme toggle, and a single-page variant with numbered collapsible sections.
- Render the per-file leaf content shared by all outputs (`renderFileCardMd`), including graph-fact call lines.
- Support both narration languages (`en`/`zh`) through internal label tables.
- Does NOT generate or modify handbook content — narration gaps fall back to stage descriptions/titles, never to new prose.
- Does NOT read the work directory; its only input is the `HandbookModel` boundary type.

## Public API

Markdown handbook (`markdown.ts`):
- `renderMarkdownHandbook(model, outDir): { nStagePages, files }` — write `<sid>.md` per content stage plus `overview.md`, `index.md`, and (when registers exist) `register.md`; appends idempotent per-stage register sections.
- `stageSectionMarker(lang)` — the marker heading used for those idempotent appends.

Agent locator site (`agent-site.ts`):
- `renderAgentSite(model, outDir): { nStagePages, nCollisions }` — write `how_to_use.md`, `index.md`, `disambiguation.md`, and one locator page per content stage.

HTML (`html.ts`):
- `renderHtmlSite(model, outDir): { nPages }` — multi-page site (`index.html` redirect, `overview.html`, `register.html`, `<sid>.html`) with a shared shell (sticky sidebar, breadcrumb, persisted theme toggle, expand/collapse-all).
- `renderSinglePageHtml(model, outPath): { bytes }` — one self-contained page; every stage is a numbered, collapsed `<details>` section.

File cards (`file-card.ts`):
- `renderFileCardMd(rel, card, lang)` — full markdown card for one file: role/lifecycle badges, description (falling back to purpose), per-function details.
- `fileOneLiner(rel, card)` — one-line `- \`rel\` — purpose [role]` entry.
- `callFactsLine(fn, lang)` — the structural call-graph fact line for one `FunctionNote`.
- `REL_NAMES_CAP` — names shown per relation list before collapsing to `(+K more)`.

## Usage

```ts
import { renderMarkdownHandbook, renderAgentSite, renderHtmlSite, renderSinglePageHtml } from '@handbook/renderer';
import { loadHandbookModel } from '@handbook/pipeline';

const model = loadHandbookModel('/path/to/work', 'My Project Handbook');

const md = renderMarkdownHandbook(model, '/path/to/out');
const agent = renderAgentSite(model, '/path/to/out/agent');
const html = renderHtmlSite(model, '/path/to/out/html');
const single = renderSinglePageHtml(model, '/path/to/out/handbook.html');

console.log(md.nStagePages, agent.nCollisions, html.nPages, single.bytes);
```

## Design notes

- No LLM anywhere: every output is a pure function of the `HandbookModel`, so rendering is instant, reproducible, and safe to re-run.
- Self-contained HTML: all CSS/JS is inlined, every link is relative, and there are no external assets, so both HTML outputs work over `file://` and can be shipped as-is.
- Agent locator fields are gated on structural signals: a field (co-change twins, register hits, collisions, exemplars) is emitted iff its signal exists, and `how_to_use.md` tells agents that an empty field is information — never something to invent.
- Content gating is uniform: a stage gets a page/summary iff it has children or directly assigned files (`HandbookView.hasContent`), so empty skeleton nodes never produce empty pages.
- The disambiguation index is computed from stage-title token collisions (document frequency 2–6, pure ancestor chains excluded), giving agents a deterministic "this word lands in several stages" map.
- Markdown register sections are appended behind a marker heading, so re-rendering over an existing output directory stays idempotent.

## Dependencies

Internal:
- `@handbook/core` — `HandbookModel` and friends, `StageTree`, atomic writes, text helpers.

External:
- `markdown-it` — renders narration/description markdown to HTML for the two HTML outputs (markdown outputs need no dependency).
