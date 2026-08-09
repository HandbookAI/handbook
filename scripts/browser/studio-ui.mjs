/**
 * Browser test for the Studio UI.
 *
 *   handbook studio --port 4860 &
 *   node scripts/browser/studio-ui.mjs http://127.0.0.1:4860
 *
 * Studio's UI is one hand-written HTML file with no framework and no build, so
 * nothing type-checks it and nothing renders it except a browser. This drives
 * the parts that would fail silently: the eight locale dictionaries actually
 * loading and swapping the chrome, and the registry-driven settings surface
 * being reachable from the page.
 */
import { launch, tally } from './cdp.mjs';
const BASE = (process.argv[2] ?? process.env.STUDIO_BASE_URL ?? 'http://127.0.0.1:4860').replace(/\/+$/, '');
const t = tally('studio-ui');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();
await b.setViewport(1440, 900);
await b.goto(BASE, { waitMs: 2500 });

t.ok('no console errors on load', b.problems().length === 0, JSON.stringify(b.problems()).slice(0, 250));

const boot = await b.eval(`(() => ({
  dicts: Object.keys(window.HB_DICT || {}).sort(),
  langOptions: [...document.querySelectorAll('#langSel option')].map((o) => o.value),
  settings: window.__hbState ? 'exposed' : (typeof state !== 'undefined' ? Object.keys(state.settings?.commands || {}) : 'n/a'),
}))()`);
t.ok('all eight dictionaries loaded', boot.dicts.length === 8, JSON.stringify(boot.dicts));
t.ok('the language selector offers eight', boot.langOptions.length === 8, JSON.stringify(boot.langOptions));

// Switch through every locale and check the chrome actually changes and stays translated.
const seen = {};
for (const loc of boot.langOptions) {
  await b.eval(`(() => { const s=document.getElementById('langSel'); s.value=${JSON.stringify(loc)};
    s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await wait(500);
  const snap = await b.eval(`(() => ({
    addBtn: (document.getElementById('addBtn')||{}).textContent || '',
    nav: [...document.querySelectorAll('#mainnav *')].map(e=>e.textContent).join('|').slice(0,60),
    lang: localStorage.getItem('hb.lang'),
  }))()`);
  seen[loc] = snap.addBtn.trim();
  t.ok(
    `${loc}: chrome renders and persists`,
    snap.addBtn.trim().length > 0 && snap.lang === loc,
    `"${snap.addBtn.trim()}"`,
  );
}
const uniq = new Set(Object.values(seen));
t.ok('the eight locales are genuinely different text', uniq.size >= 7, JSON.stringify(seen));
t.ok(
  'no console errors after switching all eight',
  b.problems().length === 0,
  JSON.stringify(b.problems()).slice(0, 250),
);

// The registry-driven generate form.
await b.eval(
  `document.getElementById('langSel').value='en';document.getElementById('langSel').dispatchEvent(new Event('change',{bubbles:true}))`,
);
await wait(400);
const settings =
  await b.eval(`(async () => { const r = await fetch('/api/settings'); const s = await r.json();
  return { commands: Object.keys(s.commands), generate: s.commands.generate.length }; })()`);
t.ok('settings API reachable from the page', settings.commands.length === 9, JSON.stringify(settings));
b.close();
process.exit(t.done() ? 0 : 1);
