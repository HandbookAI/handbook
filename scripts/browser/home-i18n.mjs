/**
 * Browser test: the landing page is actually in the reader's language.
 *
 *   node scripts/browser/home-i18n.mjs [base-url]     # default http://127.0.0.1:3000
 *
 * This exists because "renders in the wrong language" is invisible to every
 * other gate in this repo. The homepage shipped for its whole life with 42
 * hardcoded English strings in its JSX: `tsc` was happy, eslint was happy,
 * `next build` was happy, and `check-translations.mjs` only ever looks at MDX.
 * Switching to 简体中文 changed the URL, `<html lang>` and the nav bar, and left
 * every word of the page body in English.
 *
 * So the assertions here are about CONTENT, not wiring:
 *
 *   - the `<h1>` is not byte-equal to the English one;
 *   - the body is written in that locale's script (where the script differs);
 *   - a handful of that locale's own phrases are present;
 *   - none of the English page's distinctive phrases are;
 *   - the diagram is the locale's diagram, and it loaded;
 *   - the console is clean.
 *
 * Everything is scoped to `<main>`, so this file stays about page COPY. The
 * chrome outside it — Fumadocs' own labels, which were English in all eight
 * locales until the v16 dictionary keys were fixed — is the subject of
 * `docs-i18n.mjs`, which reads it off the rendered DOM label by label. Keeping
 * the two apart means a regression names itself: our strings table, or theirs.
 */
import { launch, tally } from './cdp.mjs';

const BASE = (process.argv[2] ?? process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const t = tally('home-i18n');

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

/**
 * Phrases that are distinctive to the ENGLISH page. Finding any of them inside
 * `<main>` on a translated page means that part of the page was never wired to
 * the strings table — which is exactly the bug this file is here to catch.
 *
 * Short enough to be stable, long enough that no other language contains them:
 * `NO LLM` is not a substring of `KEIN LLM`, `SIN LLM`, `SEM LLM` or `БЕЗ LLM`.
 */
const ENGLISH_MARKERS = [
  'One codebase in. Two handbooks out',
  'one your agent routes with',
  'Read the docs',
  'Seven commands, one loop',
  'NO LLM',
  'Facts come from a parser',
  'Applying is boring on purpose',
  'Why you can trust what you read',
  'One run. Six shipping formats.',
  'Start with the free command',
];

/**
 * Per locale: the script its prose is written in, and phrases from its own copy.
 *
 * `script` is null for the locales that share the Latin alphabet with English —
 * there, `expect` and `ENGLISH_MARKERS` do the work instead. The expectations are
 * spelled out here rather than imported from `lib/home-strings.ts` on purpose: a
 * test that reads the same table as the page would pass even if the page never
 * read it, which is the failure being guarded against.
 */
const LOCALES = [
  {
    code: 'en',
    script: null,
    expect: ['Seven commands, one loop', 'Why you can trust what you read', 'Six shipping formats'],
  },
  {
    code: 'zh',
    // Han, and specifically NOT kana — a kana hit means the ja copy leaked in.
    script: /[一-鿿]/u,
    forbid: /[぀-ヿ]/u,
    expect: ['七个命令', '为什么你可以信任读到的内容', '无 LLM', '六种可交付的格式'],
  },
  {
    code: 'hi',
    script: /[ऀ-ॿ]/u,
    expect: ['सात commands', 'भरोसा क्यों कर सकते हैं', 'बिना LLM', 'छह shipping formats'],
  },
  {
    code: 'es',
    script: null,
    expect: ['Siete comandos', 'confiar en lo que lees', 'SIN LLM', 'Seis formatos'],
  },
  {
    code: 'pt',
    script: null,
    expect: ['Sete comandos', 'confiar no que lê', 'SEM LLM', 'Seis formatos de entrega'],
  },
  {
    code: 'ru',
    script: /[Ѐ-ӿ]/u,
    expect: ['Семь команд', 'доверять', 'БЕЗ LLM', 'Шесть готовых форматов'],
  },
  {
    code: 'ja',
    // Kana. Han alone would also match the Chinese copy.
    script: /[぀-ヿ]/u,
    expect: ['7 つのコマンド', '読んだ内容を信頼できる理由', 'LLM なし', '6 つの出荷形式'],
  },
  {
    code: 'de',
    script: null,
    expect: ['Sieben Befehle', 'trauen kannst', 'KEIN LLM', 'Sechs Lieferformate'],
  },
];

/** The rendered state of the landing page, everything scoped to the page body. */
const PROBE = `(() => {
  // There are TWO <main> elements: fumadocs' HomeLayout wraps the page in one,
  // and the page is one. \`querySelector('main')\` returns the layout's, whose
  // text includes the nav and the search box — so scope from the heading
  // outwards instead, which lands on the page's own <main> and nothing else.
  const h1el = document.querySelector('h1');
  const main = h1el ? h1el.closest('main') : null;
  if (!main) return null;
  const img = main.querySelector('figure img');
  const src = img ? img.getAttribute('src') : '';
  const entry = performance.getEntriesByType('resource').find((r) => r.name.endsWith(src));
  return {
    lang: document.documentElement.getAttribute('lang'),
    h1: h1el.innerText || '',
    text: main.innerText || '',
    diagram: src,
    diagramAlt: img ? img.getAttribute('alt') : '',
    // A 404 SVG still yields a resource entry, so the status is what matters.
    diagramStatus: entry ? entry.responseStatus : 0,
  };
})()`;

/** Dev compiles a route on first request; poll rather than guess a duration. */
async function open(browser, path) {
  await browser.goto(`${BASE}${path}`, { waitMs: 1200 });
  for (let i = 0; i < 40; i += 1) {
    const state = await browser.eval(PROBE);
    if (state && state.h1.length > 0) return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  return browser.eval(PROBE);
}

// ── 1. the default-locale root ──────────────────────────────────────────────
const english = await (async () => {
  const b = await launch();
  await b.setViewport(1440, 900);
  const state = await open(b, '/');
  t.ok('/ renders the landing page', state !== null && state.h1.length > 0, `h1="${state?.h1}"`);
  t.ok('/ is English', state.h1.includes('One codebase in. Two handbooks out'), `h1="${state?.h1}"`);
  t.ok('/ serves the unsuffixed diagram', state.diagram === '/diagrams/pipeline.svg', state.diagram);
  t.ok('no console errors on /', realProblems(b).length === 0, JSON.stringify(realProblems(b)).slice(0, 300));
  b.close();
  return state.h1;
})();

// ── 2. every locale, at its own URL ─────────────────────────────────────────
// One browser walked across the eight routes rather than eight browsers: the
// thing under test is per-URL server output, and a shared tab additionally
// catches copy that survives a client-side navigation between locales.
{
  const b = await launch();
  await b.setViewport(1440, 900);

  for (const locale of LOCALES) {
    const { code } = locale;
    b.clearEvents();
    const state = await open(b, `/${code}`);
    const label = `[${code}]`;

    if (!state || state.h1.length === 0) {
      t.ok(`${label} the page renders`, false, `no <main><h1> at /${code}`);
      continue;
    }
    t.ok(`${label} the page renders`, true, `h1="${state.h1.replace(/\n/g, ' ').slice(0, 60)}"`);
    t.ok(`${label} <html lang> is set`, (state.lang ?? '').startsWith(code), `lang="${state.lang}"`);

    if (code === 'en') {
      t.ok(`${label} the h1 is the English h1`, state.h1 === english);
    } else {
      t.ok(`${label} the h1 is NOT the English h1`, state.h1 !== english, `h1="${state.h1}"`);
      const leaked = ENGLISH_MARKERS.filter((m) => state.text.includes(m));
      t.ok(`${label} no English copy in the body`, leaked.length === 0, JSON.stringify(leaked));
    }

    if (locale.script) {
      t.ok(`${label} the h1 is in this locale's script`, locale.script.test(state.h1), `h1="${state.h1}"`);
    }
    if (locale.forbid) {
      t.ok(`${label} no other locale's script leaked in`, !locale.forbid.test(state.text));
    }

    const missing = locale.expect.filter((phrase) => !state.text.includes(phrase));
    t.ok(
      `${label} its own copy is present (${locale.expect.length} phrases)`,
      missing.length === 0,
      JSON.stringify(missing),
    );

    // The diagram is a picture full of words, and there is one per locale.
    const want = code === 'en' ? '/diagrams/pipeline.svg' : `/diagrams/pipeline.${code}.svg`;
    t.ok(`${label} the diagram is this locale's`, state.diagram === want, state.diagram);
    t.ok(`${label} the diagram loaded`, state.diagramStatus > 0 && state.diagramStatus < 400, [
      state.diagram,
      state.diagramStatus,
    ]);
    t.ok(
      `${label} the diagram's alt text is translated`,
      code === 'en' ? true : state.diagramAlt !== '' && !state.diagramAlt.startsWith('The Handbook pipeline'),
      `alt="${(state.diagramAlt ?? '').slice(0, 50)}"`,
    );

    t.ok(
      `${label} no console errors`,
      realProblems(b).length === 0,
      JSON.stringify(realProblems(b)).slice(0, 300),
    );
  }
  b.close();
}

// ── 3. the reported bug, as the reader hit it ───────────────────────────────
// Picking a language from the menu on `/`. This is the path the defect was
// reported through: the URL changed, `<html lang>` changed, the nav bar changed,
// and the body stayed English. A per-URL check alone would not prove the menu
// leads anywhere, so it is exercised as a click.
{
  const b = await launch();
  await b.setViewport(1440, 900);
  const before = await open(b, '/');
  t.ok('the language control exists on the homepage', await b.clickLabel('Choose a language'));
  await new Promise((r) => setTimeout(r, 900));
  const picked = await b.eval(`(() => {
    const el = [...document.querySelectorAll('[role="menu"] *, [data-state="open"] *')]
      .find((e) => (e.textContent || '').trim() === '简体中文' && e.children.length === 0);
    if (!el) return false;
    (el.closest('button,a,[role="menuitem"]') || el).click();
    return true;
  })()`);
  t.ok('简体中文 is offered in the menu', picked);
  if (picked) {
    let after = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      after = await b.eval(PROBE);
      if (after && after.h1 !== before.h1) break;
    }
    const where = await b.eval('location.pathname');
    t.ok('choosing it navigates to /zh', where.startsWith('/zh'), `→ ${where}`);
    t.ok('and the BODY becomes Chinese', /[一-鿿]/u.test(after?.h1 ?? ''), `h1="${after?.h1}"`);
    t.ok('and no English copy is left behind', !(after?.text ?? '').includes('Seven commands, one loop'));
  }
  b.close();
}

process.exit(t.done() ? 0 : 1);
