import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderAgentSite } from './agent-site.js';
import { makeFixtureModel } from './fixture.test-helper.js';

const model = makeFixtureModel();
let dir: string;
let result: { nStagePages: number; nCollisions: number };

const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-renderer-agent-'));
  result = renderAgentSite(model, dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderAgentSite', () => {
  it('writes the protocol pages and one locator page per content stage', () => {
    expect(result.nStagePages).toBe(4);
    for (const name of ['how_to_use.md', 'index.md', 'disambiguation.md', 'stage-1.md', 'stage-1.1.md', 'stage-2.md', 'crosscut-1.md']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });

  it('emits Duty as the first paragraph of the summary only', () => {
    const page = read('stage-1.md');
    expect(page).toContain('**Duty**: Loads and normalizes raw sources for downstream parsing.');
    expect(page).not.toContain('must not leak');
  });

  it('emits Entry concepts from distinctive file stems', () => {
    expect(read('stage-1.md')).toContain('**Entry concepts**: `loader`');
    expect(read('stage-2.md')).toContain('**Entry concepts**: `engine`');
  });

  it('emits direct State registers without an inherited annotation', () => {
    const page = read('stage-1.md');
    expect(page).toContain('**State**: `reg-parser-cache`');
    expect(page).not.toContain('inherited');
    expect(read('stage-2.md')).toContain('**State**: `reg-query-plan`');
  });

  it('sinks ancestor registers into leaf stages via concept words', () => {
    expect(read('stage-1.1.md')).toContain('**State**: `reg-parser-cache` (inherited, via parser)');
  });

  it('omits State entirely when no register hits the stage', () => {
    expect(read('crosscut-1.md')).not.toContain('**State**:');
  });

  it('emits the Exemplar iff a group has a function-bearing file', () => {
    expect(read('stage-1.md')).toContain('**Exemplar** (copy this when adding a new one):');
    expect(read('stage-1.md')).toContain('- `src/ingest/loader.ts` [Loading] (2 fns)');
    expect(read('crosscut-1.md')).not.toContain('**Exemplar**');
  });

  it('emits Strong co-change only for same-directory test twins', () => {
    const page = read('stage-2.md');
    expect(page).toContain('**⚠️ Strong co-change (change src → change its test)**:');
    expect(page).toContain('- `src/query/engine.ts` ↔ `src/query/engine_test.ts` [crosscut-1]');
    expect(read('stage-1.md')).not.toContain('Strong co-change');
  });

  it('emits Related sub-groups and role-ranked Core files', () => {
    const page = read('stage-2.md');
    expect(page).toContain('**Related (same sub-group — topical, verify before editing)**:\n- Execution (1 files)');
    expect(page).toContain('**Core files**:\n- `src/query/engine.ts` `entrypoint` (1 fns)');
  });

  it('keeps collision words within df bounds and outside ancestor chains', () => {
    expect(result.nCollisions).toBe(1);
    const disambiguation = read('disambiguation.md');
    expect(disambiguation).toContain('## `pipeline` (2 hits)');
    expect(disambiguation).toContain('- [`stage-1`](stage-1.md) Ingestion Pipeline —');
    expect(disambiguation).toContain('- [`stage-2`](stage-2.md) Query Pipeline —');
    expect(disambiguation).not.toContain('## `ingestion`'); // pure ancestor chain
    expect(disambiguation).not.toContain('## `query`'); // df 1
  });

  it('adds the collision back-link only to colliding stages', () => {
    expect(read('stage-1.md')).toContain('see [disambiguation.md](disambiguation.md)** (`pipeline`)');
    expect(read('stage-2.md')).toContain('(`pipeline`)');
    expect(read('stage-1.1.md')).not.toContain('Name collides');
  });

  it('appends the owned file cards after the locator block', () => {
    const page = read('stage-1.md');
    expect(page).toContain('\n---\n');
    expect(page).toContain('### `src/ingest/loader.ts`');
    expect(page).toContain('#### Function details');
  });

  it('walks the index with linked, depth-derived headings', () => {
    const index = read('index.md');
    expect(index).toContain('\n## [stage-1 · Ingestion Pipeline](stage-1.md)');
    expect(index).toContain('\n### [stage-1.1 · Ingestion Parser](stage-1.1.md)');
    expect(index).toContain('[how_to_use.md](how_to_use.md)');
  });

  it('states the fixed protocol in how_to_use.md', () => {
    const howTo = read('how_to_use.md');
    expect(howTo).toContain('locator index');
    expect(howTo).toContain('the code is the only source of truth');
    expect(howTo).toContain('An empty field is information');
  });
});
