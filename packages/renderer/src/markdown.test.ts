import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureModel } from './fixture.test-helper.js';
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
