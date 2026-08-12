import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterCapabilities } from '@handbooks/core';
import { ORPHAN, makeFixtureModel, makeUnassignedFixtureModel } from './fixture.test-helper.js';
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
    for (const name of [
      'index.html',
      'overview.html',
      'register.html',
      'stage-1.html',
      'stage-1.1.html',
      'stage-2.html',
      'crosscut-1.html',
    ]) {
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
    // Every file and every function is a closed disclosure with a stable id, so
    // a search hit or a shared link can name one and have it revealed.
    expect(page).toContain('<details class="file" id="f-src-ingest-loader-ts">');
    expect(page).toContain('<code class="path">src/ingest/loader.ts</code>');
    expect(page).toContain('<details class="fn" id="fn-src-ingest-loader-ts-loader-loadall">');
    expect(page).toContain('<span class="fn-n">loader.loadAll</span>');
    expect(page).toContain('lines 10–42');
    expect(page).toContain('State Registers Touched');
    expect(page).toContain('reg-parser-cache');
    expect(page).toContain('Sub-stages');
    expect(page).not.toContain('<details class="file" id="f-src-ingest-loader-ts" open');
  });

  it('gives each file row a role chip, a lifecycle chip and a function count', () => {
    const page = read('stage-1.html');
    expect(page).toContain('<span class="chip role role-orchestration">orchestration</span>');
    expect(page).toContain('<span class="chip">startup</span>');
    expect(page).toContain('<span class="chip">2 functions</span>');
    // `lifecycle: 'none'` is not a lifecycle; it must not become a chip.
    expect(read('stage-1.1.html')).not.toContain('<span class="chip">none</span>');
    expect(read('stage-1.1.html')).toContain('<span class="chip">1 function</span>');
  });

  it('builds a table of contents from the headings it actually emitted', () => {
    const page = read('stage-1.html');
    expect(page).toContain('class="toc"');
    expect(page).toContain('On this page');
    // Each entry must resolve to a real id on the page, or scroll-spy tracks
    // nothing and the link dead-ends.
    for (const id of [...page.matchAll(/<li class="d\d"><a href="#([^"]+)"/g)].map((m) => m[1])) {
      expect(page, id).toContain(`id="${id}"`);
    }
    expect(page).toContain('<li class="d1"><a href="#stage-1-files">Files in this stage</a></li>');
  });

  it('links each stage to its neighbours in reading order', () => {
    // stage-1 → stage-1.1 → stage-2 → crosscut-1 is `contentStages()` order.
    expect(read('stage-1.1.html')).toContain('<a class="pv" href="stage-1.html">');
    expect(read('stage-1.1.html')).toContain('<a class="nx" href="stage-2.html">');
    // The ends have one neighbour each, not a dead link to nothing.
    expect(read('stage-1.html')).not.toContain('class="pv"');
    expect(read('crosscut-1.html')).not.toContain('class="nx"');
  });

  it('builds the breadcrumb from the stage ancestry', () => {
    const page = read('stage-1.1.html');
    expect(page).toContain(
      '<a href="overview.html">System</a> / <a href="stage-1.html">Ingestion Pipeline</a> / Ingestion Parser',
    );
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

describe('renderHtmlSite — the search index', () => {
  type Entry = [number, string, string, string];
  const entries = (): Entry[] => {
    const js = read('search-index.js');
    expect(js.startsWith('window.HB_INDEX=')).toBe(true);
    return JSON.parse(js.slice('window.HB_INDEX='.length).replace(/;\n?$/, '')) as Entry[];
  };

  it('is a sibling asset, not a counted page', () => {
    expect(existsSync(join(dir, 'search-index.js'))).toBe(true);
    // 7 pages, as asserted above — the index must not inflate what the CLI
    // reports to a human as "pages written".
    expect(site.nPages).toBe(7);
  });

  it('indexes every stage, file, function and register', () => {
    const all = entries();
    const kinds = (k: number): string[] => all.filter((e) => e[0] === k).map((e) => e[1]);
    expect(kinds(0)).toEqual(['Ingestion Pipeline', 'Ingestion Parser', 'Query Pipeline', 'Test Harness']);
    expect(kinds(1)).toContain('src/ingest/loader.ts');
    expect(kinds(2)).toContain('loader.loadAll');
    expect(kinds(3)).toContain('reg-parser-cache');
  });

  it('points every entry at a page that exists and an id that is on it', () => {
    for (const [, label, , url] of entries()) {
      const [file, hash] = url.split('#');
      expect(existsSync(join(dir, file)), `${label} → ${file}`).toBe(true);
      if (hash !== undefined) expect(read(file), `${label} → ${url}`).toContain(`id="${hash}"`);
    }
  });

  it('escapes markup so a model-written label cannot close the script element', () => {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-html-idx-'));
    try {
      const m = makeFixtureModel();
      m.skeleton.stages[0].title = '</script><svg onload=alert(1)>';
      renderHtmlSite(m, out);
      const js = readFileSync(join(out, 'search-index.js'), 'utf8');
      expect(js).not.toContain('</script>');
      expect(js).not.toContain('<svg');
      expect(js).toContain('\\u003c/script\\u003e');
      // Still readable as JS — the escaping must not corrupt the payload.
      const parsed = JSON.parse(js.slice('window.HB_INDEX='.length).replace(/;\n?$/, '')) as Entry[];
      expect(parsed.some((e) => e[1] === '</script><svg onload=alert(1)>')).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
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
        '<a href="https://example.com/repo/src/ingest/loader.ts"><code class="path">src/ingest/loader.ts</code></a>',
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

describe('HTML renderers — analysis-fidelity disclosure', () => {
  const FULL: AdapterCapabilities = {
    tier: 'full',
    callTypes: ['self_method', 'internal_func'],
    selfAttrs: true,
    statementSpans: true,
  };
  const GENERIC: AdapterCapabilities = {
    tier: 'generic',
    callTypes: ['internal_func'],
    selfAttrs: false,
    statementSpans: false,
  };

  function withTempDir<T>(run: (out: string) => T): T {
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-html-fid-'));
    try {
      return run(out);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  it('discloses generic-tier languages on the overview page', () => {
    withTempDir((out) => {
      renderHtmlSite(model, out, { languages: { python: FULL, kotlin: GENERIC } });
      const overview = readFileSync(join(out, 'overview.html'), 'utf8');
      expect(overview).toContain('<strong>Analysis fidelity</strong>');
      expect(overview).toContain('call relations for kotlin come from the generic');
      expect(overview).toContain('var(--warn)');
      // Only the overview carries the note; stage pages stay as they were.
      expect(readFileSync(join(out, 'stage-1.html'), 'utf8')).not.toContain('Analysis fidelity');
    });
  });

  it('discloses it on the single page too', () => {
    withTempDir((out) => {
      const page = join(out, 'handbook.html');
      renderSinglePageHtml(model, page, { languages: { kotlin: GENERIC } });
      expect(readFileSync(page, 'utf8')).toContain('<strong>Analysis fidelity</strong>');
    });
  });

  it('writes the note in the handbook language', () => {
    withTempDir((out) => {
      const zh = makeFixtureModel();
      zh.lang = 'zh';
      zh.narration.lang = 'zh';
      renderHtmlSite(zh, out, { languages: { kotlin: GENERIC } });
      const overview = readFileSync(join(out, 'overview.html'), 'utf8');
      expect(overview).toContain('<strong>保真度说明</strong>');
      expect(overview).toContain('kotlin 的调用关系来自通用（配置驱动）分析器');
    });
  });

  it('produces byte-identical output when nothing is generic-tier or the option is absent', () => {
    withTempDir((a) =>
      withTempDir((b) => {
        renderHtmlSite(model, a, { languages: { python: FULL } });
        renderHtmlSite(model, b);
        for (const name of ['overview.html', 'stage-1.html', 'register.html']) {
          expect(readFileSync(join(a, name), 'utf8'), name).toBe(readFileSync(join(b, name), 'utf8'));
        }
        const single = (dir: string): string => {
          const path = join(dir, 'handbook.html');
          renderSinglePageHtml(model, path, dir === a ? { languages: { python: FULL } } : {});
          return readFileSync(path, 'utf8');
        };
        expect(single(a)).toBe(single(b));
      }),
    );
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
    for (const [sid, number, title] of [
      ['stage-1', '1', 'Ingestion Pipeline'],
      ['stage-1.1', '1.1', 'Ingestion Parser'],
      ['stage-2', '2', 'Query Pipeline'],
    ] as const) {
      expect(html).toContain(
        `<a href="#${sid}"><span class="sb-num">${number}</span><span>${title}</span></a>`,
      );
    }
  });

  it('ends with an anchored registers table', () => {
    const html = read('handbook.html');
    expect(html).toContain('id="registers"');
    expect(html).toContain('<a href="#stage-1">Ingestion Pipeline</a>');
  });
});

describe('HTML — files in no stage', () => {
  /**
   * Same gap as the markdown index, in the output a reader is most likely to
   * open: the overview printed `coverage.nFiles` while every list under it came
   * from `assignment.buckets`, so the page contradicted its own headline and
   * never said which files were missing.
   */
  let outDir: string;
  let singleHtml: string;
  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'hb-renderer-html-unassigned-'));
    const unassignedModel = makeUnassignedFixtureModel();
    renderHtmlSite(unassignedModel, outDir);
    const path = join(outDir, 'single.html');
    renderSinglePageHtml(unassignedModel, path);
    singleHtml = readFileSync(path, 'utf8');
  });
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('lists them in an anchored overview section', () => {
    const overview = readFileSync(join(outDir, 'overview.html'), 'utf8');
    expect(overview).toContain('id="ov-unassigned"');
    expect(overview).toContain('Files in no stage');
    expect(overview).toContain(ORPHAN);
    expect(overview).toContain('4 of 5 files were placed in a stage. The 1 below');
  });

  it('prints the assigned/total split instead of a total the page contradicts', () => {
    const overview = readFileSync(join(outDir, 'overview.html'), 'utf8');
    expect(overview).toContain('4 of 5 files in a stage');
    expect(overview).not.toContain('>5 files<');
  });

  it('links the section from the sidebar of every page, not just the overview', () => {
    for (const name of ['overview.html', 'stage-1.html', 'register.html']) {
      expect(readFileSync(join(outDir, name), 'utf8'), name).toContain('href="overview.html#ov-unassigned"');
    }
  });

  it('indexes them for search so the path is not a dead end', () => {
    const index = readFileSync(join(outDir, 'search-index.js'), 'utf8');
    expect(index).toContain(ORPHAN);
    expect(index).toContain('overview.html#ov-unassigned');
  });

  it('carries the section in the single-page render too', () => {
    expect(singleHtml).toContain('id="ov-unassigned"');
    expect(singleHtml).toContain(ORPHAN);
  });

  it('adds nothing when every file was placed', () => {
    expect(read('overview.html')).not.toContain('ov-unassigned');
    expect(read('overview.html')).toContain('>4 files<');
  });
});
