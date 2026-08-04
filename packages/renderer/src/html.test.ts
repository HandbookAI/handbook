import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureModel } from './fixture.test-helper.js';
import { renderHtmlSite, renderSinglePageHtml } from './html.js';

const model = makeFixtureModel();
let dir: string;
let site: { nPages: number };
let single: { bytes: number };
let singlePath: string;

const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-renderer-html-'));
  site = renderHtmlSite(model, dir);
  singlePath = join(dir, 'handbook.html');
  single = renderSinglePageHtml(model, singlePath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderHtmlSite', () => {
  it('writes index + overview + register + one page per content stage', () => {
    expect(site.nPages).toBe(7);
    for (const name of ['index.html', 'overview.html', 'register.html', 'stage-1.html', 'stage-1.1.html', 'stage-2.html', 'crosscut-1.html']) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
  });

  it('redirects index.html to overview.html', () => {
    expect(read('index.html')).toContain('<meta http-equiv="refresh" content="0; url=overview.html">');
  });

  it('lists every stage in the sidebar and marks the current page', () => {
    const overview = read('overview.html');
    for (const sid of ['stage-1', 'stage-1.1', 'stage-2', 'crosscut-1']) {
      expect(overview).toContain(`href="${sid}.html"`);
    }
    expect(read('stage-1.html')).toContain(`<a class="cur" href="stage-1.html">`);
  });

  it('renders the overview with markdown prose and stage cards', () => {
    const overview = read('overview.html');
    expect(overview).toContain('<p>The system ingests sources, parses them, and answers queries.</p>');
    expect(overview).toContain('class="cards"');
    expect(overview).toContain('Ingestion Pipeline');
  });

  it('renders stage pages with collapsed details, functions and registers', () => {
    const page = read('stage-1.html');
    expect(page).toContain('<details><summary><code>src/ingest/loader.ts</code>');
    expect(page).toContain('<details class="fn"><summary><code>loader.loadAll</code>');
    expect(page).toContain('lines 10–42');
    expect(page).toContain('State Registers Touched');
    expect(page).toContain('reg-parser-cache');
    expect(page).toContain('Sub-stages');
  });

  it('builds the breadcrumb from the stage ancestry', () => {
    const page = read('stage-1.1.html');
    expect(page).toContain('<a href="overview.html">System</a> / <a href="stage-1.html">Ingestion Pipeline</a> / Ingestion Parser');
  });

  it('renders the register table with stage links', () => {
    const register = read('register.html');
    expect(register).toContain('<table>');
    expect(register).toContain('<a href="stage-1.html">Ingestion Pipeline</a>');
  });

  it('inlines all CSS/JS with a persisted theme toggle and expand/collapse controls', () => {
    const page = read('stage-1.html');
    expect(page).toContain('<style>');
    expect(page).toContain("localStorage.getItem('hb-theme')");
    expect(page).toContain('[data-theme="dark"]');
    expect(page).toContain('hbAll(true)');
    expect(page).toContain('hbAll(false)');
  });

  it('never references an external http(s) URL', () => {
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
      expect(read(name)).not.toMatch(/https?:\/\//);
    }
  });
});

describe('renderHtmlSite — source links (opt-in)', () => {
  it('links file paths to the source base URL', () => {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-html-src-'));
    try {
      renderHtmlSite(model, out, { sourceBaseUrl: 'https://example.com/repo/' });
      const page = readFileSync(join(out, 'stage-1.html'), 'utf8');
      expect(page).toContain(
        '<a href="https://example.com/repo/src/ingest/loader.ts"><code>src/ingest/loader.ts</code></a>',
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('HTML-escapes the href', () => {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-html-esc-'));
    try {
      renderHtmlSite(model, out, { sourceBaseUrl: 'https://example.com/r?a=1&b=2' });
      const page = readFileSync(join(out, 'stage-1.html'), 'utf8');
      expect(page).toContain('<a href="https://example.com/r?a=1&amp;b=2/src/ingest/loader.ts">');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('renderHtmlSite — untrusted content is escaped (no script/markup injection)', () => {
  // Titles, prose, register semantics, group titles, file paths and function
  // fields are all LLM/codebase text with no schema constraint. None may inject
  // executable markup into the self-contained site.
  const BREAK = '"><svg onload=alert(1)></svg>';
  const SCRIPT = '<script>alert(2)</script>';

  function poisoned(): ReturnType<typeof makeFixtureModel> {
    const m = makeFixtureModel();
    m.title = `T ${BREAK}`;
    m.skeleton.stages[0].title = `S ${SCRIPT}`;
    m.skeleton.stages[2].title = `Q ${BREAK}`;
    m.narration.systemOverview = `Overview ${SCRIPT}`;
    m.narration.stageSummaries['stage-1'] = `Duty ${SCRIPT} here.`;
    m.registers[0].semantics = `sem ${BREAK}`;
    m.organization.stages['stage-1'].groups[0].title = `G ${BREAK}`;
    m.organization.stages['stage-1'].groups[0].summary = `GS ${SCRIPT}`;
    const loader = m.cards['src/ingest/loader.ts'];
    loader.description = `Desc ${SCRIPT}`;
    loader.functions![0].qualname = `q ${BREAK}`;
    loader.functions![0].signature = `sig ${BREAK}`;
    loader.functions![0].purpose = `p ${SCRIPT}`;
    return m;
  }

  it('never emits a live <script> or attribute breakout in any page', () => {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-html-xss-'));
    const single = join(out, 'handbook.html');
    try {
      renderHtmlSite(poisoned(), out);
      renderSinglePageHtml(poisoned(), single);
      for (const name of readdirSync(out).filter((f) => f.endsWith('.html'))) {
        const c = readFileSync(join(out, name), 'utf8');
        // No injected <script>alert(2)> and no attribute breakout survives raw.
        expect(c, name).not.toContain('<script>alert(2)');
        expect(c.includes('"><svg onload=alert(1)'), name).toBe(false);
        expect(c, name).not.toContain('<svg onload=');
      }
      // The payload survives, but only in neutralised (escaped) form.
      const stage1 = readFileSync(join(out, 'stage-1.html'), 'utf8');
      expect(stage1).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('renderSinglePageHtml', () => {
  it('reports the written size', () => {
    expect(single.bytes).toBeGreaterThan(0);
    expect(single.bytes).toBe(readFileSync(singlePath).byteLength);
  });

  it('contains every content stage as a collapsed details with its id', () => {
    const html = read('handbook.html');
    for (const sid of ['stage-1', 'stage-1.1', 'stage-2', 'crosscut-1']) {
      expect(html).toContain(`<details class="stage" id="${sid}">`);
    }
    expect(html).not.toContain('<details class="stage" open');
  });

  it('numbers sections hierarchically and anchors the sidebar', () => {
    const html = read('handbook.html');
    expect(html).toContain('<a href="#stage-1">1 Ingestion Pipeline</a>');
    expect(html).toContain('<a href="#stage-1.1">1.1 Ingestion Parser</a>');
    expect(html).toContain('<a href="#stage-2">2 Query Pipeline</a>');
  });

  it('ends with an anchored registers table', () => {
    const html = read('handbook.html');
    expect(html).toContain('id="registers"');
    expect(html).toContain('<a href="#stage-1">Ingestion Pipeline</a>');
  });
});
