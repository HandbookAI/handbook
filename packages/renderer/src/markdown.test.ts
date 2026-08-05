import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterCapabilities } from '@handbook/core';
import { ENGINE, makeFixtureModel } from './fixture.test-helper.js';
import { renderMarkdownHandbook, stageSectionMarker } from './markdown.js';
import type { RenderOptions } from './shared.js';

const model = makeFixtureModel();
let dir: string;
let result: { nStagePages: number; files: string[] };

const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-renderer-md-'));
  result = renderMarkdownHandbook(model, dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderMarkdownHandbook', () => {
  it('writes one page per content-bearing stage plus the top-level pages', () => {
    expect(result.nStagePages).toBe(4);
    for (const name of ['overview.md', 'register.md', 'index.md', 'stage-1.md', 'stage-1.1.md', 'stage-2.md', 'crosscut-1.md']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });

  it('renders the stage page header with sid and crosscut badge', () => {
    expect(read('stage-1.md')).toContain('# Ingestion Pipeline `stage-1`');
    expect(read('crosscut-1.md')).toContain('# Test Harness `crosscut-1` (cross-cutting infrastructure)');
  });

  it('links content-bearing children under Sub-stages with file counts', () => {
    const page = read('stage-1.md');
    expect(page).toContain('## Sub-stages');
    expect(page).toContain('- [Ingestion Parser](stage-1.1.md) `stage-1.1` — 1 files');
  });

  it('groups files by organization under Files in this stage', () => {
    const page = read('stage-1.md');
    expect(page).toContain('## Files in this stage');
    expect(page).toContain('### Loading');
    expect(page).toContain('Source loading machinery.');
    expect(page).toContain('### `src/ingest/loader.ts`');
  });

  it('uses depth-derived heading levels in index.md', () => {
    const index = read('index.md');
    expect(index).toContain('# Fixture Handbook — Stage Index');
    expect(index).toContain('\n## [Ingestion Pipeline](stage-1.md) `stage-1` — 2 files');
    expect(index).toContain('\n### [Ingestion Parser](stage-1.1.md) `stage-1.1` — 1 files');
    expect(index).toContain('\n## [Test Harness](crosscut-1.md) `crosscut-1` · (cross-cutting) — 1 files');
  });

  it('renders the register table with stage links and pipe-escaped semantics', () => {
    const register = read('register.md');
    expect(register).toContain('# Fixture Handbook — State Flow');
    expect(register).toContain('## 🔄 State Flow Overview');
    expect(register).toContain('| State register | Semantics | Stages touched |');
    expect(register).toContain('| `reg-parser-cache` | Parsed AST cache shared between load \\| query paths. | [Ingestion Pipeline](stage-1.md) |');
    expect(register).toContain('[Query Pipeline](stage-2.md)');
  });

  it('keeps a register row on one line with pipes/newlines in the title and semantics', () => {
    const dirty = structuredClone(model);
    // A `|` in a title used to open an extra column; a newline in semantics
    // used to split the row across two lines — both break the markdown table.
    dirty.skeleton.stages[0].title = 'Ingestion | Pipeline';
    dirty.registers[0].semantics = 'line one\nline two';
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-cell-'));
    try {
      renderMarkdownHandbook(dirty, out);
      const reg = readFileSync(join(out, 'register.md'), 'utf8');
      const row = reg.split('\n').find((l) => l.startsWith('| `reg-parser-cache`')) ?? '';
      // Exactly three data cells → four unescaped pipe delimiters.
      const delimiters = row.split(/(?<!\\)\|/).length - 1;
      expect(delimiters, row).toBe(4);
      expect(row).toContain('[Ingestion \\| Pipeline](stage-1.md)');
      expect(row).toContain('line one line two');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('keeps internal links valid when a title has an unbalanced bracket', () => {
    // An LLM title like `Ingest] beta` used to terminate `[text](sid.md)` at
    // the stray `]`, dead-ending the stage link in index.md and register.md.
    const dirty = structuredClone(model);
    dirty.skeleton.stages[0].title = 'Ingest] beta';
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-brk-'));
    try {
      renderMarkdownHandbook(dirty, out);
      const index = readFileSync(join(out, 'index.md'), 'utf8');
      const register = readFileSync(join(out, 'register.md'), 'utf8');
      // The bracket is escaped, so the link text stays intact.
      expect(index).toContain('[Ingest\\] beta](stage-1.md)');
      expect(register).toContain('[Ingest\\] beta](stage-1.md)');
      // And it renders as a real link (before the fix there was no anchor).
      const html = new MarkdownIt({ html: false, linkify: false }).render(index);
      expect(html).toContain('href="stage-1.md"');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('links register.md and index.md from the overview See also', () => {
    const overview = read('overview.md');
    expect(overview).toContain('# Fixture Handbook');
    expect(overview).toContain('## 🗺️ System Overview');
    expect(overview).toContain('The system ingests sources, parses them, and answers queries.');
    expect(overview).toContain('## See also');
    expect(overview).toContain('](register.md)');
    expect(overview).toContain('](index.md)');
  });

  it('appends the per-stage register section exactly once (idempotent marker)', () => {
    const marker = stageSectionMarker('en');
    expect(marker).toBe('## 📊 State Registers Touched');
    const before = read('stage-1.md');
    expect(before).toContain(marker);
    expect(before).toContain('- `reg-parser-cache` — Parsed AST cache shared between load | query paths.');
    renderMarkdownHandbook(model, dir); // second run must not duplicate
    const after = read('stage-1.md');
    expect(after.split(marker).length - 1).toBe(1);
  });

  it('does not annotate stages no register touches', () => {
    expect(read('stage-1.1.md')).not.toContain(stageSectionMarker('en'));
  });
});

describe('renderMarkdownHandbook — mermaid stage map', () => {
  it('embeds a flowchart of the stage tree in overview.md', () => {
    const overview = read('overview.md');
    expect(overview).toContain('## 🧭 Stage Map');
    expect(overview).toContain('```mermaid');
    expect(overview).toContain('flowchart TD');
    expect(overview).toContain('stage-1["Ingestion Pipeline"]');
    expect(overview).toContain('stage-1_1["Ingestion Parser"]');
    expect(overview).toContain('stage-1 --> stage-1_1');
    expect(overview).toContain('crosscut-1["Test Harness"]:::crosscut');
    expect(overview).toContain('classDef crosscut');
    expect(overview).not.toContain('stage-1.1["');
  });

  it('keeps every node label on one line when a stage title contains newlines', () => {
    const dirty = structuredClone(model);
    // A title with a hard newline used to split the mermaid node across lines,
    // producing an unterminated `["…` statement that breaks the whole diagram.
    dirty.skeleton.stages[0].title = 'Ingestion\nPipeline\twide';
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-nl-'));
    try {
      renderMarkdownHandbook(dirty, out);
      const overview = readFileSync(join(out, 'overview.md'), 'utf8');
      const fence = overview.slice(overview.indexOf('```mermaid'), overview.indexOf('```', overview.indexOf('```mermaid') + 3));
      // Invariant: any line that opens a node label also closes it.
      for (const line of fence.split('\n')) {
        if (line.includes('["')) expect(line, line).toContain('"]');
      }
      expect(fence).toContain('stage-1["Ingestion Pipeline wide"]');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('omits the diagram for a single-stage skeleton', () => {
    const solo = structuredClone(model);
    solo.skeleton.stages = solo.skeleton.stages
      .filter((s) => s.id === 'stage-2')
      .map((s) => ({ ...s, parent: null, children: [] }));
    solo.assignment.buckets = { 'stage-2': [ENGINE] };
    solo.registers = [];
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-solo-'));
    try {
      renderMarkdownHandbook(solo, out);
      expect(readFileSync(join(out, 'overview.md'), 'utf8')).not.toContain('```mermaid');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('renderMarkdownHandbook — source links (opt-in)', () => {
  it('links each file card path to the source base URL (trailing slash stripped)', () => {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-src-'));
    try {
      renderMarkdownHandbook(model, out, { sourceBaseUrl: 'https://example.com/repo/' });
      const page = readFileSync(join(out, 'stage-1.md'), 'utf8');
      expect(page).toContain(
        '### [`src/ingest/loader.ts`](https://example.com/repo/src/ingest/loader.ts)',
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('keeps the default output link-free', () => {
    const page = read('stage-1.md');
    expect(page).toContain('### `src/ingest/loader.ts`');
    expect(page).not.toMatch(/https?:\/\//);
  });
});

describe('renderMarkdownHandbook — analysis-fidelity disclosure', () => {
  const FULL: AdapterCapabilities = {
    tier: 'full',
    callTypes: ['self_method', 'internal_func', 'boundary'],
    selfAttrs: true,
    statementSpans: true,
  };
  const GENERIC: AdapterCapabilities = {
    tier: 'generic',
    callTypes: ['internal_func', 'boundary'],
    selfAttrs: false,
    statementSpans: false,
  };

  /** Render a fresh copy and return its overview.md. */
  function overviewOf(options: RenderOptions, lang: 'en' | 'zh' = 'en'): string {
    const m = makeFixtureModel();
    if (lang === 'zh') {
      m.lang = 'zh';
      m.narration.lang = 'zh';
    }
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-md-fid-'));
    try {
      renderMarkdownHandbook(m, out, options);
      return readFileSync(join(out, 'overview.md'), 'utf8');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  it('names every generic-tier language and says exactly what is best-effort', () => {
    const overview = overviewOf({ languages: { python: FULL, lua: GENERIC, kotlin: GENERIC } });
    expect(overview).toContain('**Analysis fidelity**');
    expect(overview).toContain('call relations for kotlin, lua come from the generic');
    expect(overview).toContain('best-effort');
    // Structure is NOT best-effort — the note must not overstate the doubt.
    expect(overview).toContain('The file inventory and the structure of these languages are exact.');
    // A full-tier language is not dragged into the warning.
    expect(overview).not.toContain('python');
  });

  it('says nothing when every contributing language is full-tier', () => {
    // No noise for the common case: identical to a render that was told nothing.
    expect(overviewOf({ languages: { python: FULL, typescript: FULL } })).toBe(overviewOf({}));
  });

  it('leaves the default output untouched when the option is absent', () => {
    expect(overviewOf({})).not.toContain('fidelity');
    expect(overviewOf({ sourceBaseUrl: 'https://example.com/repo' })).not.toContain('fidelity');
  });

  it('writes the note in the handbook language', () => {
    const overview = overviewOf({ languages: { kotlin: GENERIC } }, 'zh');
    expect(overview).toContain('**保真度说明**');
    expect(overview).toContain('kotlin 的调用关系来自通用（配置驱动）分析器');
    expect(overview).toContain('这些语言的文件清单与结构仍是精确的。');
  });
});

describe('renderMarkdownHandbook — orphan-page cleanup (manifest)', () => {
  it('removes stage pages from a previous render when ids change', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');
    const outDir = mkdtempSync(join(tmpdir(), 'hb-rerender-'));

    const modelA = makeFixtureModel();
    renderMarkdownHandbook(modelA, outDir);
    const oldStage = modelA.skeleton.stages.find((s) => s.id !== 'crosscut-1')?.id as string;
    expect(existsSync(join(outDir, `${oldStage}.md`))).toBe(true);

    // Second generation renames every stage.
    const modelB = structuredClone(modelA);
    modelB.skeleton.stages = modelB.skeleton.stages.map((s, i) => ({ ...s, id: `renamed-${i + 1}`, parent: null, children: [] }));
    modelB.assignment.buckets = Object.fromEntries(
      Object.values(modelB.assignment.buckets).map((files, i) => [`renamed-${i + 1}`, files]),
    );
    modelB.assignment.fileStage = Object.fromEntries(
      Object.entries(modelB.assignment.fileStage).map(([f], i) => [f, { stage: Object.keys(modelB.assignment.buckets)[i % Object.keys(modelB.assignment.buckets).length] as string, also: [] }]),
    );
    modelB.organization.stages = {};
    modelB.narration.stageSummaries = Object.fromEntries(
      modelB.skeleton.stages.map((s) => [s.id, 'renamed summary']),
    );
    modelB.registers = [];
    renderMarkdownHandbook(modelB, outDir);

    expect(existsSync(join(outDir, `${oldStage}.md`)), 'stale page must be deleted').toBe(false);
    expect(existsSync(join(outDir, 'renamed-1.md'))).toBe(true);
    expect(existsSync(join(outDir, 'overview.md'))).toBe(true);
  });
});
