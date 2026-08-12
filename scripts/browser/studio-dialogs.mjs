/**
 * Browser test for Studio's render / skill / validate actions.
 *
 *   pnpm demo                                  # produces examples/work/demo
 *   handbook studio --port 4860 &
 *   node scripts/browser/studio-dialogs.mjs http://127.0.0.1:4860
 *
 * These three were covered only at the API level, which says nothing about the
 * half that lives in the browser: whether the buttons are reachable at all,
 * whether the dialogs open, whether the fields are wired to the request that
 * goes out, and whether a refusal comes back to somewhere a person can see it
 * instead of the dialog closing on nothing. Studio's UI is one hand-written HTML
 * file with no framework and no build, so nothing else checks any of that.
 *
 * Every assertion here is about an OUTCOME, not about the absence of a crash:
 * a checkbox that was turned off must leave its artifact absent, a checkbox that
 * was turned on must make one appear, a typed title must come back inside the
 * rendered `<title>`, a typed slug must come back inside `SKILL.md`, and a
 * `validate` that fails must be red on screen with the reason in it.
 *
 * Offline and key-free: `render`, `skill` and `validate` are the commands that
 * never reach a model. All this needs is a work dir with a handbook already in
 * it, which `pnpm demo` produces.
 */
import { cpSync, existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, tally } from './cdp.mjs';

const BASE = (process.argv[2] ?? process.env.STUDIO_BASE_URL ?? 'http://127.0.0.1:4860').replace(/\/+$/, '');
const SRC_FIXTURE = process.argv[3] ?? new URL('../../examples/demo-project', import.meta.url).pathname;
const WORK_FIXTURE = process.argv[4] ?? new URL('../../examples/work/demo', import.meta.url).pathname;
const t = tally('studio-dialogs');

if (!existsSync(join(WORK_FIXTURE, 'handbook', 'index.md'))) {
  console.error(
    `studio-dialogs: no generated handbook at ${WORK_FIXTURE}\n` + 'Run `pnpm demo` first (offline, ~30s).',
  );
  process.exit(1);
}

// COPIES of both fixtures, never the fixtures themselves.
//
// The work dir, because this suite renders over the handbook, packages a skill
// from it and then corrupts that skill on purpose — doing any of that to
// examples/work/demo would silently change what the next suite in CI reads.
//
// The source tree, because studio refuses two repos that share one (correctly:
// one tree, one repo). Registering the real path would make a second run of this
// suite fail on a collision with the first, which reads as a broken UI rather
// than a suite that did not clean up.
const WORK = mkdtempSync(join(tmpdir(), 'hb-dlg-work-'));
const SOURCE = mkdtempSync(join(tmpdir(), 'hb-dlg-src-'));
cpSync(WORK_FIXTURE, WORK, { recursive: true });
cpSync(SRC_FIXTURE, SOURCE, { recursive: true });
// Three deliberate absences, each one an assertion later:
//  - no skill/    → `validate` must start out gated, and the skill dialog is
//                   what un-gates it.
//  - no handbook.html → the single-page box gets turned OFF, so this file must
//                   still be absent afterwards. A form that only ever transmits
//                   `true` looks identical to a correct one until you check this.
//  - no llms.txt  → that box gets turned ON, so this file must appear.
rmSync(join(WORK, 'skill'), { recursive: true, force: true });
rmSync(join(WORK, 'handbook', 'handbook.html'), { force: true });
rmSync(join(WORK, 'handbook', 'llms.txt'), { force: true });
rmSync(join(WORK, 'handbook', 'llms-full.txt'), { force: true });

const STAMP = String(Date.now()).slice(-7);
const REPO = `dlg-${STAMP}`;
const TITLE = `Dialogs Suite ${STAMP}`;
const SLUG = `dialogs-suite-${STAMP}`;
const PROJECT = `Dialogs Project ${STAMP}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch();
await b.setViewport(1440, 900);
await b.goto(BASE, { waitMs: 2500 });

/** Poll a page expression until it is truthy. Returns the last value seen. */
async function waitFor(what, expression, { tries = 120, everyMs = 250 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    last = await b.eval(expression);
    if (last) return last;
    await wait(everyMs);
  }
  return last;
}

// The token the server injected into this page's head. Anything this suite
// fetches for itself has to carry it; the page's own api() helper does that on
// its own, which is exactly what the UI-driven steps below rely on.
const TOK = `(document.querySelector('meta[name=hb-token]')||{}).content||''`;
const apiJson = (path, init = '{}') =>
  b.eval(
    `(async () => { const T=${TOK};
      const r = await fetch(${JSON.stringify(path)}, Object.assign({}, ${init}, { headers: Object.assign({'content-type':'application/json', authorization: 'Bearer '+T}, (${init}).headers||{}) }));
      const text = await r.text();
      try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; } })()`,
  );
const apiText = (path) =>
  b.eval(
    `(async () => { const T=${TOK}; const r = await fetch(${JSON.stringify(path)},{headers:{authorization:'Bearer '+T}});
      return { status: r.status, text: await r.text() }; })()`,
  );

/** The English dictionary, read from the page, so no expectation is hard-coded
 *  here and a renamed key fails loudly instead of comparing two literals. */
const D = await b.eval(`JSON.parse(JSON.stringify(window.HB_DICT.en))`);

// English for the whole run: the assertions below compare against dictionary
// values, and a browser that picked another locale from the OS would compare
// English expectations against translated chrome.
await b.eval(
  `(() => { const s=document.getElementById('langSel'); s.value='en'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`,
);
await wait(400);
t.ok('no console errors on load', b.problems().length === 0, JSON.stringify(b.problems()).slice(0, 250));

// ---------------------------------------------------------------- register
// Through the Add dialog, with an explicit work dir — the one add-dialog field
// nothing exercised, and the only way to point studio at an existing handbook.
await b.clickSel('#addBtn', { waitMs: 500 });
await b.eval(`(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('fName', ${JSON.stringify(REPO)});
  set('fSource', ${JSON.stringify(SOURCE)});
  set('fWork', ${JSON.stringify(WORK)});
})()`);
await b.clickSel('#addSubmit', { waitMs: 1500 });
const registered = await waitFor(
  'the repo overview to open',
  // The coverage card, not one of the buttons under test: a readiness probe that
  // waits on the very control the next assertion is about turns one failure into
  // a cascade and hides which of the two actually broke.
  `document.getElementById('ovCov') ? { ok: true } : null`,
);
t.ok(
  'the add dialog honours an explicit work dir and opens the repo',
  !!(registered && registered.ok),
  JSON.stringify(await b.eval(`(document.getElementById('fErr')||{}).textContent||''`)),
);

// ------------------------------------------------------------------ gating
const gates = await b.eval(`(() => {
  const at = (act) => document.querySelector('[data-act="' + act + '"]');
  const info = (act) => { const el = at(act); return el ? { present: true, disabled: el.disabled, title: el.title, text: el.textContent.trim() } : { present: false }; };
  return { render: info('render-open'), skill: info('skill-open'), validate: info('validate-run') };
})()`);
t.ok(
  'render and skill are offered and enabled once a handbook exists',
  gates.render.present && !gates.render.disabled && gates.skill.present && !gates.skill.disabled,
  JSON.stringify(gates),
);
t.ok(
  'the buttons carry their translated labels',
  gates.render.text === D.ov.render &&
    gates.skill.text === D.ov.skill &&
    gates.validate.text === D.ov.validate,
  JSON.stringify([gates.render.text, gates.skill.text, gates.validate.text]),
);
t.ok(
  'validate is gated on a SKILL package, and says so',
  gates.validate.present && gates.validate.disabled && gates.validate.title === D.ov.needSkill,
  JSON.stringify(gates.validate),
);

// ---------------------------------------------------------- render dialog
t.ok('the render button opens its dialog', await b.clickSel('[data-act="render-open"]', { waitMs: 600 }));
const rOpen = await b.eval(`(() => {
  const d = document.getElementById('dlgRender');
  return { open: d.open, title: document.getElementById('renderTitle').textContent.trim(),
    html: document.getElementById('rHtml').checked, single: document.getElementById('rSingle').checked,
    agent: document.getElementById('rAgent').checked, llms: document.getElementById('rLlms').checked,
    titleField: document.getElementById('rTitle').value };
})()`);
t.ok(
  'dlgRender is really open and titled',
  rOpen.open && rOpen.title === D.dlg.render,
  JSON.stringify(rOpen),
);
t.ok(
  'it opens on the documented defaults',
  rOpen.html && rOpen.single && rOpen.agent && !rOpen.llms && rOpen.titleField === '',
  JSON.stringify(rOpen),
);

// Cancel really cancels — an untested button that quietly submitted would be
// indistinguishable from one that closed.
await b.clickSel('[data-act="render-cancel"]', { waitMs: 400 });
t.ok(
  'render-cancel closes it without starting anything',
  (await b.eval(`document.getElementById('dlgRender').open`)) === false &&
    (await b.eval(`document.getElementById('drawer').classList.contains('show')`)) === false,
);

await b.clickSel('[data-act="render-open"]', { waitMs: 600 });
// Real pointer clicks on the checkboxes inside the modal: this is the part that
// proves the dialog's fields are reachable, not just present in the DOM.
for (const sel of ['#rSingle', '#rAgent', '#rLlms']) await b.clickSel(sel, { waitMs: 200 });
// ...and a real focus + real keystrokes for the title.
await b.clickSel('#rTitle', { waitMs: 200 });
await b.type(TITLE, { waitMs: 300 });
const rFilled = await b.eval(`(() => ({
  single: document.getElementById('rSingle').checked, agent: document.getElementById('rAgent').checked,
  llms: document.getElementById('rLlms').checked, title: document.getElementById('rTitle').value }))()`);
t.ok(
  'pointer clicks toggle the dialog checkboxes and typing reaches the field',
  rFilled.single === false && rFilled.agent === false && rFilled.llms === true && rFilled.title === TITLE,
  JSON.stringify(rFilled),
);

await b.clickSel('#renderSubmit', { waitMs: 800 });
t.ok(
  'submitting closes the dialog and opens the job drawer',
  (await b.eval(`document.getElementById('dlgRender').open`)) === false &&
    (await b.eval(`document.getElementById('drawer').classList.contains('show')`)) === true &&
    (await b.eval(`document.getElementById('jobTitle').textContent.trim()`)) === D.dlg.render,
);
const rDone = await waitFor(
  'the render job to finish',
  `(() => { const s = document.getElementById('jobStatus');
     return s.textContent.trim() === ${JSON.stringify(D.job.succeeded)} ? { cls: s.className, log: document.getElementById('jobLog').textContent } : null; })()`,
);
t.ok(
  'the render job reports success in the drawer',
  !!rDone && rDone.cls.includes('ok'),
  JSON.stringify(rDone && rDone.log.slice(-160)),
);

// What the form said is what the server was told.
const afterRender = (await apiJson(`/api/repos/${REPO}`)).body;
const lastRender = (afterRender.lastParams || {}).render || {};
t.ok(
  'every render field reached the request, false as faithfully as true',
  lastRender.html === true &&
    lastRender.htmlSingle === false &&
    lastRender.agentSite === false &&
    lastRender.llmsTxt === true &&
    lastRender.title === TITLE,
  JSON.stringify(lastRender),
);
// ...and the request did what it said. These are the outcomes, on disk.
const overview = await apiText(`/api/repos/${REPO}/handbook/html/overview.html`);
t.ok(
  'the typed title is inside the re-rendered HTML site',
  overview.status === 200 && overview.text.includes(`<title>${TITLE}</title>`),
  `status=${overview.status}`,
);
t.ok('the box that was ticked produced llms.txt', existsSync(join(WORK, 'handbook', 'llms.txt')));
t.ok(
  'the boxes that were unticked produced nothing',
  !existsSync(join(WORK, 'handbook', 'handbook.html')) && afterRender.outputs.single === false,
  JSON.stringify(afterRender.outputs),
);
// `startsWith`, not equality: the repo's reported title is read back out of the
// rendered `index.md` heading, which the markdown renderer suffixes ("— Stage
// Index"). Asserting equality here would be asserting the renderer's suffix.
t.ok(
  'the repo reports the new title back through the API',
  typeof afterRender.title === 'string' && afterRender.title.startsWith(TITLE),
  JSON.stringify(afterRender.title),
);

// ----------------------------------------------------------- skill dialog
t.ok('the skill button opens its dialog', await b.clickSel('[data-act="skill-open"]', { waitMs: 600 }));
const sOpen = await b.eval(`(() => {
  const d = document.getElementById('dlgSkill');
  return { open: d.open, title: document.getElementById('skillTitle').textContent.trim(),
    placeholder: document.getElementById('sName').placeholder,
    name: document.getElementById('sName').value, lang: document.getElementById('sLang').value };
})()`);
t.ok('dlgSkill is really open and titled', sOpen.open && sOpen.title === D.dlg.skill, JSON.stringify(sOpen));
t.ok(
  "the slug field previews the server's own auto-slug",
  sOpen.placeholder === `${REPO.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-handbook` && sOpen.name === '',
  JSON.stringify(sOpen),
);

await b.clickSel('#sName', { waitMs: 200 });
await b.type(SLUG, { waitMs: 200 });
await b.clickSel('#sProject', { waitMs: 200 });
await b.type(PROJECT, { waitMs: 200 });
// The body-language select is a field too, and it is the one whose effect is
// invisible in English.
await b.eval(
  `(() => { const s=document.getElementById('sLang'); s.value='zh'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`,
);
await b.clickSel('#skillSubmit', { waitMs: 800 });
t.ok(
  'submitting closes the dialog and opens the job drawer',
  (await b.eval(`document.getElementById('dlgSkill').open`)) === false &&
    (await b.eval(`document.getElementById('jobTitle').textContent.trim()`)) === D.dlg.skill,
);
const sDone = await waitFor(
  'the skill job to finish',
  `(() => { const s = document.getElementById('jobStatus');
     return s.textContent.trim() === ${JSON.stringify(D.job.succeeded)} ? { cls: s.className, log: document.getElementById('jobLog').textContent } : null; })()`,
);
t.ok(
  'the skill job reports success in the drawer',
  !!sDone && sDone.cls.includes('ok'),
  JSON.stringify(sDone && sDone.log.slice(-160)),
);

const skillMd = existsSync(join(WORK, 'skill', 'SKILL.md'))
  ? readFileSync(join(WORK, 'skill', 'SKILL.md'), 'utf8')
  : '';
t.ok(
  'the typed slug and project name are inside the built SKILL.md',
  skillMd.includes(`name: ${SLUG}`) && skillMd.includes(PROJECT),
  `${skillMd.length} bytes`,
);
const afterSkill = (await apiJson(`/api/repos/${REPO}`)).body;
t.ok(
  'the language select reached the request too',
  ((afterSkill.lastParams || {}).skill || {}).bodyLang === 'zh',
  JSON.stringify((afterSkill.lastParams || {}).skill),
);

// -------------------------------------------------------------- validate
// The gate must have re-evaluated on its own: the job's completion reloads the
// repo list and re-renders, which is the only thing that can un-disable this.
const enabled = await waitFor(
  'validate to become enabled',
  `(() => { const el = document.querySelector('[data-act="validate-run"]'); return el && !el.disabled ? { title: el.title } : null; })()`,
);
t.ok('building a skill un-gates validate without a reload', !!enabled, JSON.stringify(enabled));

const verdict = (await apiJson(`/api/repos/${REPO}/validate`, `{method:'POST',body:'{}'}`)).body;
await b.clickSel('[data-act="validate-run"]', { waitMs: 1200 });
const shown = await b.eval(`(() => ({
  shown: document.getElementById('drawer').classList.contains('show'),
  title: document.getElementById('jobTitle').textContent.trim(),
  cls: document.getElementById('jobStatus').className,
  log: document.getElementById('jobLog').textContent }))()`);
t.ok(
  'validate reports the real verdict in the drawer, ice not red when it passes',
  shown.shown &&
    shown.title === D.ov.validate &&
    (verdict.ok
      ? shown.cls.includes('ice') && shown.log.includes(D.validate.ok)
      : shown.cls.includes('bad') && (verdict.errors || []).every((e) => shown.log.includes(e))),
  JSON.stringify({ ok: verdict.ok, cls: shown.cls, log: shown.log.slice(0, 200) }),
);

// A package that is NOT valid: exit-code-2 semantics ("the tool worked and the
// answer is no") have to arrive as a visible, specific refusal. A verdict that
// vanished would leave the reader believing the last thing they saw.
rmSync(join(WORK, 'skill', 'references', 'index.md'), { force: true });
await b.clickSel('[data-act="validate-run"]', { waitMs: 1200 });
const refused = await b.eval(`(() => ({
  cls: document.getElementById('jobStatus').className,
  log: document.getElementById('jobLog').textContent }))()`);
t.ok(
  'a failing validate comes back red, naming what is wrong',
  refused.cls.includes('bad') && /references\/index\.md is missing/.test(refused.log),
  JSON.stringify(refused.log.slice(0, 220)),
);

t.ok(
  'no console errors through the whole happy path',
  b.problems().length === 0,
  JSON.stringify(b.problems()).slice(0, 250),
);

// -------------------------------------------------- a refusal must not vanish
// The repo goes away behind the page's back — a second tab, or a studio
// restarted with a fresh state dir. Both dialogs close on submit, so if the POST
// that follows is not surfaced, the user is left looking at a page that shows no
// sign anything happened.
//
// From here the page is EXPECTED to log failed requests, so the running tally of
// console problems is reset: what must still hold is that nothing but those 404s
// shows up — an exception thrown inside the error handler is the precise way a
// refusal ends up vanishing.
await apiJson(`/api/repos/${REPO}`, `{method:'DELETE'}`);
b.clearEvents();
for (const [open, submit, label] of [
  ['render-open', '#renderSubmit', D.dlg.render],
  ['skill-open', '#skillSubmit', D.dlg.skill],
]) {
  await b.eval(`document.getElementById('jobLog').textContent = ''`);
  await b.clickSel(`[data-act="${open}"]`, { waitMs: 500 });
  await b.clickSel(submit, { waitMs: 1200 });
  const surfaced = await b.eval(`(() => ({
    dialogs: [...document.querySelectorAll('dialog')].filter((d) => d.open).length,
    shown: document.getElementById('drawer').classList.contains('show'),
    title: document.getElementById('jobTitle').textContent.trim(),
    cls: document.getElementById('jobStatus').className,
    log: document.getElementById('jobLog').textContent }))()`);
  t.ok(
    `${open}: a server refusal lands in the drawer instead of vanishing`,
    surfaced.dialogs === 0 &&
      surfaced.shown &&
      surfaced.title === label &&
      surfaced.cls.includes('bad') &&
      /unknown repo/i.test(surfaced.log),
    JSON.stringify(surfaced).slice(0, 240),
  );
}

const noise = b.problems().filter((p) => !/404 \(Not Found\)/.test(p));
t.ok(
  'the refused submits logged nothing but their own 404s',
  noise.length === 0 && b.problems().length > 0,
  JSON.stringify(b.problems()).slice(0, 250),
);

b.close();
for (const dir of [WORK, SOURCE]) rmSync(dir, { recursive: true, force: true });
process.exit(t.done() ? 0 : 1);
