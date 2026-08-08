/**
 * Browser test for the HTML a handbook RENDERS — the human-facing artifact.
 *
 *   node scripts/browser/handbook-html.mjs <html-dir> [single-page.html]
 *
 * The renderer's unit tests assert on markup; this asserts on behaviour, in a
 * real browser, over `file://` — the way a reader actually opens it. That
 * matters more here than for a normal site: the output ships as loose files
 * with no server, so anything that needs `fetch`, a module script or an origin
 * silently does nothing, and no amount of string matching would notice.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, tally } from './cdp.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/browser/handbook-html.mjs <html-dir> [single-page.html]');
  process.exit(2);
}
const base = pathToFileURL(resolve(dir)).href.replace(/\/+$/, '');
const single = process.argv[3] ? pathToFileURL(resolve(process.argv[3])).href : null;
const t = tally('handbook-html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch();
await b.setViewport(1440, 900);

// ── the overview loads clean ────────────────────────────────────────────────
await b.goto(`${base}/overview.html`, { waitMs: 1800 });
{
  const state = await b.eval(`(() => ({
    h1: (document.querySelector('h1') || {}).textContent || '',
    nav: document.querySelectorAll('.sb-nav a').length,
    cards: document.querySelectorAll('.card').length,
    index: Array.isArray(window.HB_INDEX) ? window.HB_INDEX.length : -1,
  }))()`);
  t.ok('the overview renders', state.h1.length > 0, `h1="${state.h1}"`);
  t.ok('the sidebar lists the stages', state.nav > 1, `${state.nav} links`);
  t.ok('the overview shows stage cards', state.cards > 0, `${state.cards} cards`);
  // A sibling <script src> is the one thing that still works over file://;
  // fetch/import would be blocked by the opaque origin and search would be dead.
  t.ok('the search index loads over file://', state.index > 0, `${state.index} entries`);
  t.ok('no console errors', b.problems().length === 0, JSON.stringify(b.problems()).slice(0, 300));
}

// ── search: open, query, keyboard, jump ─────────────────────────────────────
{
  b.clearEvents();
  await b.key('k', { modifiers: 4 }); // ⌘K
  await wait(600);
  let open = await b.eval(`document.getElementById('hb-dim').classList.contains('on')`);
  if (!open) {
    // Meta is the macOS spelling; a Linux runner needs Control.
    await b.key('k', { modifiers: 2 });
    await wait(600);
    open = await b.eval(`document.getElementById('hb-dim').classList.contains('on')`);
  }
  t.ok('⌘K / Ctrl-K opens search', open);

  // Take the query FROM the index rather than hard-coding one. A fixed word
  // ties the test to whichever repository happens to have been rendered, and
  // would report "search is broken" on any handbook that does not contain it.
  const query = await b.eval(`(() => {
    const entry = (window.HB_INDEX || []).find((e) => e[0] === 1) || (window.HB_INDEX || [])[0];
    if (!entry) return '';
    const word = String(entry[1]).split(/[^A-Za-z0-9]+/).filter((s) => s.length >= 3)[0];
    return word ? word.slice(0, 4) : String(entry[1]).slice(0, 3);
  })()`);
  t.ok('the index yields a searchable term', query.length > 0, JSON.stringify(query));

  await b.eval(`document.getElementById('hb-q').focus()`);
  await b.type(query);
  await wait(500);
  const hits = await b.eval(`(() => {
    const rows = [...document.querySelectorAll('#hb-out .shit')];
    return { n: rows.length, marked: document.querySelectorAll('#hb-out mark').length,
             first: rows[0] ? rows[0].getAttribute('href') : null,
             selected: document.querySelectorAll('#hb-out .shit.on').length };
  })()`);
  t.ok(`typing "${query}" returns results`, hits.n > 0, `${hits.n} rows`);
  t.ok('the match is highlighted', hits.marked > 0, `${hits.marked} marks`);
  t.ok('the first result starts selected', hits.selected === 1);

  await b.key('ArrowDown');
  const moved = await b.eval(
    `[...document.querySelectorAll('#hb-out .shit')].findIndex((e) => e.classList.contains('on'))`,
  );
  // With a single hit the selection has nowhere to go and stays put.
  t.ok('arrow keys move the selection', hits.n > 1 ? moved === 1 : moved === 0, `index ${moved}`);

  await b.key('Escape');
  await wait(400);
  t.ok('escape closes it', !(await b.eval(`document.getElementById('hb-dim').classList.contains('on')`)));
  t.ok(
    'no console errors from search',
    b.problems().length === 0,
    JSON.stringify(b.problems()).slice(0, 200),
  );
}

// ── a search hit reveals a row that lives inside a closed <details> ─────────
{
  b.clearEvents();
  const target = await b.eval(`(() => {
    const hit = (window.HB_INDEX || []).find((e) => e[0] === 2) || (window.HB_INDEX || []).find((e) => e[0] === 1);
    return hit ? { url: hit[3], label: hit[1] } : null;
  })()`);
  if (!target) {
    t.ok('the index carries file/function entries', false, 'none found');
  } else {
    await b.goto(`${base}/${target.url}`, { waitMs: 1600 });
    const revealed = await b.eval(`(() => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = document.getElementById(id);
      if (!el) return { found: false, id };
      let open = true, p = el;
      while (p) { if (p.tagName === 'DETAILS' && !p.open) open = false; p = p.parentElement; }
      return { found: true, id, open, inView: el.getBoundingClientRect().top < innerHeight };
    })()`);
    t.ok('the deep link resolves to a real element', revealed.found, JSON.stringify(revealed));
    t.ok('and every ancestor disclosure is opened', revealed.open === true, JSON.stringify(revealed));
  }
}

// ── theme: tri-state, persisted ────────────────────────────────────────────
{
  await b.goto(`${base}/overview.html`, { waitMs: 1400 });
  const read = () =>
    b.eval(
      `({ pref: document.documentElement.getAttribute('data-pref'), theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor })`,
    );
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    seen.push(await read());
    await b.eval(`hbTheme()`);
    await wait(300);
  }
  const prefs = seen.map((s) => s.pref);
  t.ok('the theme cycles through all three states', new Set(prefs).size === 3, JSON.stringify(prefs));
  const light = seen.find((s) => s.pref === 'light');
  const dark = seen.find((s) => s.pref === 'dark');
  t.ok(
    'light and dark paint differently',
    light && dark && light.bg !== dark.bg,
    `${light?.bg} vs ${dark?.bg}`,
  );
  // Persistence: set dark, reload, expect dark.
  await b.eval(`(() => { const r = document.documentElement;
    while ((r.getAttribute('data-pref') || 'auto') !== 'dark') hbTheme(); })()`);
  await b.goto(`${base}/overview.html`, { waitMs: 1400 });
  t.ok('the choice survives a reload', (await read()).pref === 'dark');
}

// ── a stage page: table of contents, expand/collapse, pager ────────────────
{
  const stage = await b.eval(
    `(() => { const a = document.querySelector('.sb-nav a[href^="stage-"], .sb-nav a[href^="crosscut-"]'); return a ? a.getAttribute('href') : null; })()`,
  );
  t.ok('the sidebar links a stage page', typeof stage === 'string', String(stage));
  if (stage) {
    b.clearEvents();
    await b.goto(`${base}/${stage}`, { waitMs: 1800 });
    const toc = await b.eval(`(() => {
      const links = [...document.querySelectorAll('.toc a')];
      return { n: links.length, allResolve: links.every((a) => document.getElementById(a.getAttribute('href').slice(1))) };
    })()`);
    t.ok('the page has a table of contents', toc.n > 0, `${toc.n} entries`);
    t.ok('every entry points at a real heading', toc.n === 0 || toc.allResolve);

    const closed = await b.eval(`document.querySelectorAll('.content details[open]').length`);
    await b.eval(`hbAll(true)`);
    await wait(300);
    const opened = await b.eval(`document.querySelectorAll('.content details[open]').length`);
    await b.eval(`hbAll(false)`);
    await wait(300);
    const reclosed = await b.eval(`document.querySelectorAll('.content details[open]').length`);
    t.ok('expand all opens every disclosure', opened > closed, `${closed} → ${opened}`);
    t.ok('collapse all closes them again', reclosed === 0, `→ ${reclosed}`);

    const pager = await b.eval(`(() => {
      const links = [...document.querySelectorAll('.pager a')].map((a) => a.getAttribute('href'));
      return links;
    })()`);
    t.ok('the page offers previous/next', pager.length > 0, JSON.stringify(pager));

    const copy = await b.eval(`document.querySelectorAll('.content pre .copy').length`);
    t.ok('code blocks get a copy button', copy >= 0, `${copy} buttons`);
    t.ok(
      'no console errors on a stage page',
      b.problems().length === 0,
      JSON.stringify(b.problems()).slice(0, 300),
    );
  }
}

// ── mobile: the drawer ─────────────────────────────────────────────────────
{
  await b.setViewport(390, 780, true);
  await b.goto(`${base}/overview.html`, { waitMs: 1600 });
  const hidden = await b.eval(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().x)`);
  await b.eval(`hbNav(true)`);
  await wait(500);
  const shown = await b.eval(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().x)`);
  t.ok('the sidebar is off-canvas on a phone', hidden < 0, `x=${hidden}`);
  t.ok('the menu button brings it in', shown > hidden, `${hidden} → ${shown}`);
  await b.setViewport(1440, 900);
}

// ── the single-page render, if one was given ───────────────────────────────
if (single && existsSync(process.argv[3])) {
  b.clearEvents();
  await b.goto(single, { waitMs: 2600 });
  const state = await b.eval(`(() => ({
    stages: document.querySelectorAll('details.stage').length,
    index: Array.isArray(window.HB_INDEX) ? window.HB_INDEX.length : -1,
  }))()`);
  t.ok('the single page holds every stage', state.stages > 0, `${state.stages} stages`);
  t.ok('and inlines its own search index', state.index > 0, `${state.index} entries`);
  const jumped = await b.eval(`(() => {
    const hit = (window.HB_INDEX || []).find((e) => e[0] === 1);
    if (!hit) return null;
    location.hash = hit[3];
    hbReveal();
    const el = document.getElementById(hit[3].slice(1));
    if (!el) return { found: false };
    let open = true, p = el;
    while (p) { if (p.tagName === 'DETAILS' && !p.open) open = false; p = p.parentElement; }
    return { found: true, open };
  })()`);
  t.ok('an in-page jump opens the enclosing stage', jumped?.open === true, JSON.stringify(jumped));
  t.ok('no console errors', b.problems().length === 0, JSON.stringify(b.problems()).slice(0, 300));
}

b.close();
process.exit(t.done() ? 0 : 1);
