import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE, makeFixtureModel } from './fixture.test-helper.js';
import { renderMarkdownHandbook, stageSectionMarker } from './markdown.js';

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
