/**
 * Browser test for the documentation site (`docs/`).
 *
 *   node scripts/browser/docs-site.mjs [base-url]      # default http://127.0.0.1:3000
 *
 * Drives the four things that are pure client-side behaviour, and therefore the
 * four things every other kind of test in this repo is blind to: search, the
 * theme toggle, the language menu and the sidebar collapse. A build that serves
 * perfect HTML and loads none of its JavaScript passes a fetch check and fails
 * every assertion here.
 *
 * Each control is exercised in a FRESH browser. Reusing one tab across four
 * feature areas makes failures that only reproduce after a specific sequence,
 * which is a property of the harness rather than of the site.
 */
import { launch, tally } from './cdp.mjs';

const BASE = (process.argv[2] ?? process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const PAGE = `${BASE}/docs/reference/cli`;
const t = tally('docs-site');

/** Console errors we accept, with the reason each one is not a defect. */
const IGNORED = [
  // `next dev` only: the HMR socket is not part of the product.
  /_next\/hmr/,
  // React 19 warns about any <script> reconciled on the client. Ours is the
  // JSON-LD block, which must NOT execute — crawlers read it out of the served
  // HTML. Dev-only; the production build does not emit it.
  /Encountered a script tag while rendering React component/,
];
const realProblems = (browser) => browser.problems().filter((p) => !IGNORED.some((re) => re.test(p)));

async function open(url = PAGE) {
  const b = await launch();
  await b.setViewport(1440, 900);
  await b.goto(url, { waitMs: 3000 });
  return b;
}

// ── 1. the page loads, and its JavaScript actually arrives ──────────────────
{
  const b = await open();
  const state = await b.eval(`(() => ({
    title: document.title,
    h1: (document.querySelector('h1')||{}).textContent || '',
    // The tell for "HTML served, JS blocked": React never took over, so no
    // element carries a listener and the buttons below would all be inert.
    hydrated: !!document.querySelector('[data-radix-scroll-area-viewport], #nd-sidebar, nav'),
    chunks: performance.getEntriesByType('resource').filter((r) => /\\/_next\\/.*\\.js/.test(r.name)).length,
    // \`responseStatus\` is what catches a chunk the server REFUSED: a 403 still
    // produces a resource entry with a plausible size, so counting entries or
    // bytes reports a fully blocked page as healthy.
    failedChunks: performance.getEntriesByType('resource').filter((r) =>
      /\\/_next\\/.*\\.js/.test(r.name) && (r.responseStatus >= 400 || (r.transferSize === 0 && r.decodedBodySize === 0))).length,
  }))()`);
  t.ok('the page renders', state.h1.length > 0, `h1="${state.h1}"`);
  t.ok('its JavaScript chunks load', state.chunks > 0 && state.failedChunks === 0, JSON.stringify(state));
  t.ok(
    'no console errors on load',
    realProblems(b).length === 0,
    JSON.stringify(realProblems(b)).slice(0, 300),
  );
  b.close();
}

// ── 2. search ───────────────────────────────────────────────────────────────
{
  const b = await open();
  t.ok('the search trigger exists', await b.clickLabel('Open Search'));
  // The dialog and its chunk are loaded on demand, so give it a moment to mount.
  await new Promise((r) => setTimeout(r, 1500));
  const dialog = await b.eval(
    `(() => { const d = document.querySelector('[role="dialog"]'); return d ? d.querySelectorAll('input').length : 0; })()`,
  );
  t.ok('clicking it opens a dialog with an input', dialog > 0, `inputs=${dialog}`);
  if (dialog > 0) {
    await b.eval(`document.querySelector('[role="dialog"] input').focus()`);
    await b.type('cli');
    await new Promise((r) => setTimeout(r, 2000));
    // Results are buttons, not anchors: fumadocs routes them through the router.
    const hits = await b.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      return [...d.querySelectorAll('button')].filter((x) => (x.textContent||'').trim().length > 3 && x.textContent.trim() !== 'ESC').length;
    })()`);
    t.ok('typing returns results', hits > 0, `${hits} hits`);
    if (hits > 0) {
      await b.eval(
        `[...document.querySelectorAll('[role="dialog"] button')].filter((x) => (x.textContent||'').trim().length > 3 && x.textContent.trim() !== 'ESC')[0].click()`,
      );
      await new Promise((r) => setTimeout(r, 2200));
      const where = await b.eval(`location.pathname`);
      t.ok('choosing a result navigates', where !== '/docs/reference/cli', `→ ${where}`);
    }
  }
  b.close();
}

// ── 3. theme ────────────────────────────────────────────────────────────────
{
  const b = await open();
  const before = await b.eval(`document.documentElement.className`);
  t.ok('the theme control exists', await b.clickLabel('Toggle Theme'));
  await new Promise((r) => setTimeout(r, 1400));
  const after = await b.eval(`document.documentElement.className`);
  t.ok('toggling changes the theme', before !== after, `"${before}" → "${after}"`);
  b.close();
}

// ── 4. language ─────────────────────────────────────────────────────────────
{
  const b = await open();
  t.ok('the language control exists', await b.clickLabel('Choose a language'));
  await new Promise((r) => setTimeout(r, 900));
  const listed = await b.eval(`(() => [...new Set(
    [...document.querySelectorAll('[role="menu"] *, [data-state="open"] *')]
      .map((e) => (e.textContent || '').trim()).filter((s) => s.length > 0 && s.length < 20))])()`);
  t.ok('a language menu opens', listed.includes('简体中文'), JSON.stringify(listed).slice(0, 200));
  if (listed.includes('简体中文')) {
    await b.eval(`(() => {
      const el = [...document.querySelectorAll('[role="menu"] *, [data-state="open"] *')]
        .find((e) => (e.textContent || '').trim() === '简体中文' && e.children.length === 0);
      (el.closest('button,a,[role="menuitem"]') || el).click();
    })()`);
    await new Promise((r) => setTimeout(r, 2400));
    const where = await b.eval(`location.pathname`);
    t.ok('choosing 简体中文 navigates to that locale', where.startsWith('/zh/'), `→ ${where}`);
  }
  b.close();
}

// ── 5. sidebar collapse ─────────────────────────────────────────────────────
{
  const b = await open();
  const probe = () =>
    b.eval(`(() => { const a = document.getElementById('nd-sidebar'); if (!a) return null;
      const r = a.getBoundingClientRect();
      return { collapsed: a.getAttribute('data-collapsed'), x: Math.round(r.x),
               track: Math.round(a.parentElement.getBoundingClientRect().width) }; })()`);
  const before = await probe();
  t.ok('the collapse control exists', await b.clickLabel('Collapse Sidebar'));
  // A collapsed sidebar stays on screen while hovered, by design — and the
  // button that collapsed it is inside the sidebar. Measure from elsewhere.
  await b.moveAway(1200, 600);
  await new Promise((r) => setTimeout(r, 1600));
  const after = await probe();
  t.ok(
    'it collapses off-canvas and narrows its track',
    before?.collapsed === 'false' &&
      after?.collapsed === 'true' &&
      after.x < before.x - 100 &&
      after.track < before.track - 100,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
  );
  await b.clickLabel('Collapse Sidebar');
  await new Promise((r) => setTimeout(r, 1400));
  t.ok('and expands again', (await probe())?.collapsed === 'false');
  b.close();
}

process.exit(t.done() ? 0 : 1);
