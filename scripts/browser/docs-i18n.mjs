/**
 * Browser test: Fumadocs' OWN chrome is in the reader's language, on every route.
 *
 *   node scripts/browser/docs-i18n.mjs [base-url]     # default http://127.0.0.1:3000
 *
 * `home-i18n.mjs` covers the words the landing page writes. This covers the
 * words the LIBRARY writes — the table of contents heading, the search box, the
 * page-action buttons, the theme and language menus, the sidebar, the code-block
 * copy buttons, the heading anchors — because those failed in a way that no
 * other gate in this repo could see.
 *
 * ## The bug this exists for
 *
 * Fumadocs 16 translates through `@fuma-translate/react`, whose dictionary key
 * is the English source string plus a context suffix: `t("On this page")` inside
 * a `useTranslations({ note: 'table of contents' })` looks up
 * `"On this page(table of contents)"`, and the lookup is
 * `translations[key] ?? rawText`. A key that does not match is not an error — it
 * renders English.
 *
 * This site supplied v15-era camelCase keys (`toc`, `search`, `lastUpdate`, …).
 * None of the ten matched. So all eight localized routes rendered "On this
 * page", "Open Search" and "Copy Markdown", for the whole life of the page,
 * while `tsc`, eslint, `next build` and `check-translations.mjs` were all green.
 *
 * ## Why the assertions look the way they do
 *
 * The Chinese strings WERE in the page source the whole time — inside the
 * serialized props (`"translations":{"toc":"本页目录"}`). Anything that read the
 * payload, the React props or `lib/fumadocs-strings.ts` would have reported the
 * broken page as healthy. So:
 *
 *   - every visible-label assertion reads the RENDERED DOM, and aria-labels are
 *     read off the elements that carry them;
 *   - the expected strings are spelled out in this file rather than imported
 *     from `lib/fumadocs-strings.ts`. A test that reads the same table as the
 *     page passes even when the page never reads it, which is the failure mode;
 *   - the list of English strings that must NOT appear is read from the LIBRARY
 *     (`fumadocs-ui/dist/.translations/keys.js`), so a label fumadocs adds in a
 *     future version is covered the moment it renders.
 *
 * Section 0 is not a browser check: it compares our dictionary's key set against
 * that same library file. It is here rather than in `check-translations.mjs`
 * because it is the cheap half of the same question, and because it explains a
 * red section 1 in one line instead of eight.
 *
 * ## Labels this site does not render anywhere
 *
 * Section 0 is the only cover for these; see the list in
 * `docs/lib/fumadocs-strings.ts` for why each one is unreachable. The pagination
 * pair is the notable one: the footer renders `item.description ?? t("Next
 * Page")`, and every page under `content/docs` has a description, so the label
 * never shows. Section 1 still asserts that the footer contains no English
 * pagination label, so the day a page loses its description this goes red
 * instead of quietly reverting to English.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, tally } from './cdp.mjs';

const BASE = (process.argv[2] ?? process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const t = tally('docs-i18n');

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
 * Split a dictionary key back into the source string and its context notes.
 *
 * This is the inverse of `@fuma-translate/react`'s `encodeKey`, which is
 * `text + notes.map((n) => `(${n})`).join('')`. Stripping the trailing
 * parenthesised groups is unambiguous here because no source string contains a
 * bracket — `Read {url}, …` uses braces, and the placeholder is why.
 */
function decodeKey(key) {
  const notes = [];
  let text = key;
  for (;;) {
    const m = /^(.*)\(([^()]*)\)$/.exec(text);
    if (!m) break;
    notes.unshift(m[2]);
    text = m[1];
  }
  return { text, notes };
}

// ── 0. the dictionary contract ──────────────────────────────────────────────
// Our key set must equal the library's, exactly, in all eight locales. This is
// belt and braces: `lib/fumadocs-strings.ts` is annotated with the library's own
// `Translations` type, so a rename already fails `tsc`. It is repeated here
// because the failure it guards against cost a release, and because the same
// load gives us the English source strings for section 1's negative check.
//
// Loading a `.ts` module from Node: type stripping is on by default from Node
// 23, but bare Node ESM will not resolve the extensionless relative imports that
// `moduleResolution: bundler` allows, so the resolve hook below supplies the
// extension. Nothing is transformed — the module that runs is the module the
// site ships.
// Node also prints MODULE_TYPELESS_PACKAGE_JSON for every `.ts` it strips out of
// a package with no `"type": "module"`. It is advice about a parse cost, not a
// problem, and adding that field to `docs/package.json` would be a change to the
// app for a test's benefit. Filtered instead, so a red run is easy to read.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const typeless = (v) => v === 'MODULE_TYPELESS_PACKAGE_JSON' || v?.code === 'MODULE_TYPELESS_PACKAGE_JSON';
  if (rest.some(typeless)) return;
  emitWarning(warning, ...rest);
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const LIBRARY_KEYS = (
  await import(pathToFileURL(join(DOCS, 'node_modules/fumadocs-ui/dist/.translations/keys.js')).href)
).default;
const OURS = (await import(pathToFileURL(join(DOCS, 'lib/fumadocs-strings.ts')).href)).FUMADOCS_TRANSLATIONS;

/** The English source strings, straight from the library. */
const ENGLISH_SOURCES = new Set(
  LIBRARY_KEYS.map((key) => decodeKey(key).text).filter((text) => text !== 'displayName'),
);

/**
 * Keys whose translation is legitimately byte-equal to the English.
 *
 * Every other key differing from English is what proves a locale was actually
 * translated rather than copied, so the exceptions are enumerated with a reason
 * rather than tolerated as a class.
 */
const SAME_AS_ENGLISH = {
  // Hindi content pages keep technical nouns in Latin script — they already
  // write `Flag`, `Environment` and `Config-फ़ाइल key` — so the type-table
  // headers stay in Latin too.
  hi: [
    'Default(type table)',
    'Parameters(type table)',
    'Prop(type table)',
    'Returns(type table)',
    'Type(type table)',
  ],
  // "System" is the German word too.
  de: ['System(theme switcher)(aria-label)'],
};

t.ok(
  `the library declares ${LIBRARY_KEYS.length} keys`,
  LIBRARY_KEYS.length === 50,
  `${LIBRARY_KEYS.length}`,
);

for (const [locale, dict] of Object.entries(OURS)) {
  const ours = Object.keys(dict);
  const missing = LIBRARY_KEYS.filter((k) => !(k in dict));
  const extra = ours.filter((k) => !LIBRARY_KEYS.includes(k));
  t.ok(
    `[${locale}] supplies exactly the library's keys`,
    missing.length === 0 && extra.length === 0,
    `${ours.length} keys${missing.length ? `, missing ${JSON.stringify(missing.slice(0, 3))}` : ''}${extra.length ? `, unknown ${JSON.stringify(extra.slice(0, 3))}` : ''}`,
  );
  t.ok(
    `[${locale}] every value is non-empty`,
    ours.every((k) => typeof dict[k] === 'string' && dict[k].trim().length > 0),
    JSON.stringify(ours.filter((k) => !dict[k]?.trim())),
  );

  // Placeholders are substituted by name, so a dropped or renamed `{url}` turns
  // the AI prompt into a sentence with a literal brace in it.
  const holders = (s) => [...String(s).matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
  const wrongHolders = ours.filter(
    (k) => JSON.stringify(holders(dict[k])) !== JSON.stringify(holders(OURS.en[k])),
  );
  t.ok(`[${locale}] keeps every placeholder intact`, wrongHolders.length === 0, JSON.stringify(wrongHolders));

  if (locale === 'en') continue;
  const allowed = new Set(SAME_AS_ENGLISH[locale] ?? []);
  const untranslated = ours.filter((k) => dict[k] === OURS.en[k] && !allowed.has(k));
  t.ok(
    `[${locale}] no value is left in English`,
    untranslated.length === 0,
    JSON.stringify(untranslated.slice(0, 5)),
  );
}

/**
 * What each locale must actually render, spelled out independently of the table
 * the page reads. Deliberate duplication: see the header.
 *
 * `openInGithub` is here because the preposition is language-specific and the
 * already-settled `Edit on GitHub` picked one per language — 在 GitHub 上,
 * GitHub पर, на GitHub, Auf GitHub — which English's "in" would flatten.
 * `promptFragment` is a distinctive slice of the "Read {url}, I want to ask
 * questions about it." prompt, checked inside the real outbound href alongside
 * the page's own URL, which is what proves the `{url}` placeholder survived.
 */
const LOCALES = [
  {
    code: 'en',
    toc: 'On this page',
    search: 'Search',
    openSearch: 'Open Search',
    closeSearch: 'Close Search',
    noResults: 'No results found',
    toggleTheme: 'Toggle Theme',
    chooseLanguage: 'Choose a language',
    chooseLanguageAria: 'Choose a language',
    collapseSidebar: 'Collapse Sidebar',
    openSidebar: 'Open Sidebar',
    copyCode: 'Copy Text',
    copiedCode: 'Copied Text',
    copyAnchor: 'Copy Anchor Link',
    copyMarkdown: 'Copy Markdown',
    openActions: 'Open',
    openInGithub: 'Open in GitHub',
    viewAsMarkdown: 'View as Markdown',
    promptFragment: 'I want to ask questions about it.',
    toggleMenu: 'Toggle Menu',
  },
  {
    code: 'zh',
    toc: '本页目录',
    search: '搜索',
    openSearch: '打开搜索',
    closeSearch: '关闭搜索',
    noResults: '没有结果',
    toggleTheme: '切换主题',
    chooseLanguage: '语言',
    chooseLanguageAria: '选择语言',
    collapseSidebar: '折叠侧边栏',
    openSidebar: '打开侧边栏',
    copyCode: '复制代码',
    copiedCode: '已复制',
    copyAnchor: '复制本节链接',
    copyMarkdown: '复制 Markdown',
    openActions: '打开方式',
    openInGithub: '在 GitHub 上打开',
    viewAsMarkdown: '以 Markdown 查看',
    promptFragment: '我想就它提问。',
    toggleMenu: '切换菜单',
  },
  {
    code: 'hi',
    toc: 'इस पृष्ठ पर',
    search: 'खोजें',
    openSearch: 'खोज खोलें',
    closeSearch: 'खोज बंद करें',
    noResults: 'कोई परिणाम नहीं',
    toggleTheme: 'थीम बदलें',
    chooseLanguage: 'भाषा',
    chooseLanguageAria: 'भाषा चुनें',
    collapseSidebar: 'साइडबार समेटें',
    openSidebar: 'साइडबार खोलें',
    copyCode: 'Code कॉपी करें',
    copiedCode: 'कॉपी हो गया',
    copyAnchor: 'इस अनुभाग का लिंक कॉपी करें',
    copyMarkdown: 'Markdown कॉपी करें',
    openActions: 'खोलें',
    openInGithub: 'GitHub पर खोलें',
    viewAsMarkdown: 'Markdown में देखें',
    promptFragment: 'मैं इसके बारे में सवाल पूछना चाहता हूँ।',
    toggleMenu: 'मेनू खोलें या बंद करें',
  },
  {
    code: 'es',
    toc: 'En esta página',
    search: 'Buscar',
    openSearch: 'Abrir la búsqueda',
    closeSearch: 'Cerrar la búsqueda',
    noResults: 'Sin resultados',
    toggleTheme: 'Cambiar de tema',
    chooseLanguage: 'Idioma',
    chooseLanguageAria: 'Elegir idioma',
    collapseSidebar: 'Contraer la barra lateral',
    openSidebar: 'Abrir la barra lateral',
    copyCode: 'Copiar el código',
    copiedCode: 'Copiado',
    copyAnchor: 'Copiar el enlace a esta sección',
    copyMarkdown: 'Copiar el Markdown',
    openActions: 'Abrir',
    openInGithub: 'Abrir en GitHub',
    viewAsMarkdown: 'Ver como Markdown',
    promptFragment: 'quiero hacerte preguntas al respecto.',
    toggleMenu: 'Abrir o cerrar el menú',
  },
  {
    code: 'pt',
    toc: 'Nesta página',
    search: 'Pesquisar',
    openSearch: 'Abrir a pesquisa',
    closeSearch: 'Fechar a pesquisa',
    noResults: 'Nenhum resultado',
    toggleTheme: 'Alternar o tema',
    chooseLanguage: 'Idioma',
    chooseLanguageAria: 'Escolher idioma',
    collapseSidebar: 'Recolher a barra lateral',
    openSidebar: 'Abrir a barra lateral',
    copyCode: 'Copiar o código',
    copiedCode: 'Copiado',
    copyAnchor: 'Copiar o link desta seção',
    copyMarkdown: 'Copiar o Markdown',
    openActions: 'Abrir',
    openInGithub: 'Abrir no GitHub',
    viewAsMarkdown: 'Ver como Markdown',
    promptFragment: 'quero fazer perguntas sobre ela.',
    toggleMenu: 'Abrir ou fechar o menu',
  },
  {
    code: 'ru',
    toc: 'На этой странице',
    search: 'Поиск',
    openSearch: 'Открыть поиск',
    closeSearch: 'Закрыть поиск',
    noResults: 'Ничего не найдено',
    toggleTheme: 'Переключить тему',
    chooseLanguage: 'Язык',
    chooseLanguageAria: 'Выбрать язык',
    collapseSidebar: 'Свернуть боковую панель',
    openSidebar: 'Открыть боковую панель',
    copyCode: 'Скопировать код',
    copiedCode: 'Скопировано',
    copyAnchor: 'Скопировать ссылку на этот раздел',
    copyMarkdown: 'Скопировать Markdown',
    openActions: 'Открыть',
    openInGithub: 'Открыть на GitHub',
    viewAsMarkdown: 'Открыть как Markdown',
    promptFragment: 'я хочу задать вопросы по этой странице.',
    toggleMenu: 'Открыть или закрыть меню',
  },
  {
    code: 'ja',
    toc: 'このページの内容',
    search: '検索',
    openSearch: '検索を開く',
    closeSearch: '検索を閉じる',
    noResults: '結果がありません',
    toggleTheme: 'テーマを切り替える',
    chooseLanguage: '言語',
    chooseLanguageAria: '言語を選択',
    collapseSidebar: 'サイドバーを折りたたむ',
    openSidebar: 'サイドバーを開く',
    copyCode: 'コードをコピー',
    copiedCode: 'コピーしました',
    copyAnchor: 'この見出しへのリンクをコピー',
    copyMarkdown: 'Markdown をコピー',
    openActions: '開く',
    openInGithub: 'GitHub で開く',
    viewAsMarkdown: 'Markdown で表示',
    promptFragment: 'その内容について質問したいです。',
    toggleMenu: 'メニューを開閉',
  },
  {
    code: 'de',
    toc: 'Auf dieser Seite',
    search: 'Suchen',
    openSearch: 'Suche öffnen',
    closeSearch: 'Suche schließen',
    noResults: 'Keine Ergebnisse',
    toggleTheme: 'Design wechseln',
    chooseLanguage: 'Sprache',
    chooseLanguageAria: 'Sprache wählen',
    collapseSidebar: 'Seitenleiste einklappen',
    openSidebar: 'Seitenleiste öffnen',
    copyCode: 'Code kopieren',
    copiedCode: 'Kopiert',
    copyAnchor: 'Link zu dieser Überschrift kopieren',
    copyMarkdown: 'Markdown kopieren',
    openActions: 'Öffnen',
    openInGithub: 'Auf GitHub öffnen',
    viewAsMarkdown: 'Als Markdown ansehen',
    promptFragment: 'ich möchte dir dazu Fragen stellen.',
    toggleMenu: 'Menü öffnen oder schließen',
  },
];

/** English keeps the bare `/docs/...` URLs; every other locale is prefixed. */
const docsPath = (code) => (code === 'en' ? '/docs/reference/cli' : `/${code}/docs/reference/cli`);

/** Everything the docs chrome renders, read off the elements that carry it. */
const CHROME = `(() => {
  const text = (el) => (el && el.innerText ? el.innerText.trim() : null);
  const label = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute('aria-label') : null;
  };
  const page = (document.querySelector('h1') || {}).closest ? document.querySelector('h1').closest('article, main') : null;
  return {
    h1: text(document.querySelector('h1')),
    toc: text(document.querySelector('#toc-title')),
    // "検索\\n⌘\\nK" — the label, then the hot key.
    searchFull: (text(document.querySelector('[data-search-full]')) || '').split('\\n')[0],
    openSearch: label('[data-search]'),
    toggleTheme: label('[data-theme-toggle]'),
    ariaLabels: [...new Set([...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')))],
    buttonTexts: [...new Set([...document.querySelectorAll('button')].map((e) => (e.innerText || '').trim()))],
    navLines: (text(document.querySelector('#nd-nav, header')) || '').split('\\n').map((s) => s.trim()),
    // The two secondary lines of the previous/next cards.
    pagination: [...document.querySelectorAll('a > p.truncate, a > .truncate')].map((e) => (e.innerText || '').trim()),
  };
})()`;

/** Dev compiles a route on first request; poll rather than guess a duration. */
async function open(browser, path) {
  await browser.goto(`${BASE}${path}`, { waitMs: 1200 });
  for (let i = 0; i < 40; i += 1) {
    const state = await browser.eval(CHROME);
    // `#toc-title` only exists once the client TOC has mounted, which is also
    // when the dictionary has reached the components under test.
    if (state && state.h1 && state.toc) return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  return browser.eval(CHROME);
}

// ── 1. every locale's docs page, as rendered ────────────────────────────────
{
  const b = await launch();
  await b.setViewport(1440, 900);
  // The code-block copy button calls `navigator.clipboard`; without this the
  // rejected promise lands in the console and the "no errors" check goes red for
  // a reason that is not a defect.
  try {
    await b.send('Browser.grantPermissions', {
      origin: BASE,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch {
    /* older Chrome: the copy assertion may then be noisy, not wrong */
  }

  for (const locale of LOCALES) {
    const { code } = locale;
    const label = `[${code}]`;
    b.clearEvents();
    const state = await open(b, docsPath(code));

    if (!state || !state.h1) {
      t.ok(`${label} the docs page renders`, false, `no <h1> at ${docsPath(code)}`);
      continue;
    }

    t.ok(`${label} the table of contents heading`, state.toc === locale.toc, `"${state.toc}"`);
    t.ok(`${label} the search trigger's label`, state.searchFull === locale.search, `"${state.searchFull}"`);
    t.ok(
      `${label} the search trigger's aria-label`,
      state.openSearch === locale.openSearch,
      `"${state.openSearch}"`,
    );
    t.ok(
      `${label} the theme switcher's aria-label`,
      state.toggleTheme === locale.toggleTheme,
      `"${state.toggleTheme}"`,
    );
    for (const key of ['chooseLanguageAria', 'collapseSidebar', 'openSidebar', 'copyCode', 'copyAnchor']) {
      t.ok(
        `${label} the ${key} aria-label`,
        state.ariaLabels.includes(locale[key]),
        `want "${locale[key]}" in ${JSON.stringify(state.ariaLabels)}`,
      );
    }
    t.ok(
      `${label} the page-actions copy button`,
      state.buttonTexts.includes(locale.copyMarkdown),
      `want "${locale.copyMarkdown}"`,
    );

    // The negative half, and the reason it is exact-match rather than substring:
    // this page's code blocks are full of English CLI help, so "contains an
    // English word" would be permanently red. An aria-label that IS an English
    // source string, on the other hand, can only be a dictionary miss.
    if (code !== 'en') {
      const leaked = state.ariaLabels.filter((a) => ENGLISH_SOURCES.has(a));
      t.ok(`${label} no aria-label fell back to English`, leaked.length === 0, JSON.stringify(leaked));
      const navLeaked = state.navLines.filter((line) => ENGLISH_SOURCES.has(line));
      t.ok(`${label} no nav label fell back to English`, navLeaked.length === 0, JSON.stringify(navLeaked));
      const pagLeaked = state.pagination.filter((line) => ENGLISH_SOURCES.has(line));
      t.ok(
        `${label} no pagination label fell back to English`,
        pagLeaked.length === 0,
        JSON.stringify(pagLeaked),
      );
    }

    // ── the language menu ──
    t.ok(`${label} the language menu opens`, await b.clickLabel(locale.chooseLanguageAria));
    const menu = await b.eval(
      `[...document.querySelectorAll('[data-radix-popper-content-wrapper]')].map((x) => (x.innerText || '').trim()).join('\\n')`,
    );
    t.ok(
      `${label} its heading is this locale's`,
      menu.split('\n')[0] === locale.chooseLanguage,
      `"${menu.split('\n')[0]}"`,
    );
    await b.key('Escape');

    // ── the page-actions popover ──
    t.ok(`${label} the page-actions menu opens`, await b.clickLabel(locale.openActions));
    const actions = await b.eval(`(() => {
      const w = document.querySelector('[data-radix-popper-content-wrapper]');
      if (!w) return null;
      return {
        items: (w.innerText || '').trim().split('\\n').map((s) => s.trim()).filter(Boolean),
        // The prompt is a query PARAMETER, so it must be read through
        // URLSearchParams: \`decodeURIComponent\` leaves the '+' that stands for
        // a space, which silently fails to match any language whose sentence
        // has spaces in it — six of the eight.
        prompts: [...w.querySelectorAll('a')].map((a) => {
          const href = a.getAttribute('href') || '';
          try {
            return [...new URL(href, location.origin).searchParams.values()].join(' ');
          } catch {
            return href;
          }
        }),
      };
    })()`);
    if (!actions) {
      t.ok(`${label} the page-actions menu has items`, false, 'no popover content');
    } else {
      t.ok(`${label} it lists six destinations`, actions.items.length === 6, JSON.stringify(actions.items));
      t.ok(
        `${label} "open in GitHub" uses this language's preposition`,
        actions.items.includes(locale.openInGithub),
        `want "${locale.openInGithub}" in ${JSON.stringify(actions.items)}`,
      );
      t.ok(
        `${label} "view as Markdown" is this locale's`,
        actions.items.includes(locale.viewAsMarkdown),
        `want "${locale.viewAsMarkdown}"`,
      );
      if (code !== 'en') {
        const leaked = actions.items.filter((i) => ENGLISH_SOURCES.has(i));
        t.ok(`${label} no destination fell back to English`, leaked.length === 0, JSON.stringify(leaked));
      }
      // The AI prompt: localized AND with `{url}` replaced by this page's URL.
      const prompt = actions.prompts.find((p) => p.includes(locale.promptFragment));
      t.ok(
        `${label} the AI prompt is this locale's`,
        prompt !== undefined,
        JSON.stringify(actions.prompts.filter(Boolean).slice(0, 2)).slice(0, 160),
      );
      t.ok(
        `${label} and its {url} placeholder was substituted`,
        prompt !== undefined && prompt.includes(`${BASE}${docsPath(code)}`) && !prompt.includes('{url}'),
        `${(prompt ?? '').slice(0, 90)}…`,
      );
    }
    await b.key('Escape');

    // ── the search dialog ──
    t.ok(`${label} the search dialog opens`, await b.clickSel('[data-search-full]'));
    await new Promise((r) => setTimeout(r, 1500));
    const dialog = await b.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const input = d.querySelector('input');
      return {
        placeholder: input ? input.placeholder : null,
        labels: [...d.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
      };
    })()`);
    if (!dialog) {
      t.ok(`${label} the search dialog rendered`, false, 'no [role=dialog]');
    } else {
      t.ok(
        `${label} the search input's placeholder`,
        dialog.placeholder === locale.search,
        `"${dialog.placeholder}"`,
      );
      t.ok(
        `${label} the dialog's close aria-label`,
        dialog.labels.includes(locale.closeSearch),
        JSON.stringify(dialog.labels),
      );
      await b.eval(`document.querySelector('[role="dialog"] input').focus()`);
      await b.type('zzqqxxnothingmatches');
      await new Promise((r) => setTimeout(r, 2200));
      const empty = await b.eval(`(document.querySelector('[role="dialog"]').innerText || '').trim()`);
      t.ok(
        `${label} the empty-result message`,
        empty.split('\n').some((line) => line.trim() === locale.noResults),
        JSON.stringify(empty).slice(0, 120),
      );
    }
    await b.key('Escape');

    // ── the code block's copy button, before and after ──
    // Two keys share one element: the aria-label swaps to `Copied Text` once the
    // click lands, which is the only way to see that key rendered at all.
    const before = await b.eval(
      `(document.querySelector('figure button[aria-label]') || {}).getAttribute ? document.querySelector('figure button[aria-label]').getAttribute('aria-label') : null`,
    );
    t.ok(`${label} a code block's copy button`, before === locale.copyCode, `"${before}"`);
    await b.clickSel('figure button[aria-label]');
    await new Promise((r) => setTimeout(r, 400));
    const after = await b.eval(
      `document.querySelector('figure button[aria-label]').getAttribute('aria-label')`,
    );
    t.ok(`${label} and its copied state`, after === locale.copiedCode, `"${after}"`);

    t.ok(
      `${label} no console errors`,
      realProblems(b).length === 0,
      JSON.stringify(realProblems(b)).slice(0, 300),
    );
  }
  b.close();
}

// ── 2. the mobile menu ──────────────────────────────────────────────────────
// `Toggle Menu` belongs to HomeLayout's header and only renders below `lg`, so
// it is the one label that needs a narrow viewport and the landing page.
{
  const b = await launch();
  await b.setViewport(430, 900, true);
  for (const locale of LOCALES) {
    const { code } = locale;
    b.clearEvents();
    await b.goto(`${BASE}${code === 'en' ? '/' : `/${code}`}`, { waitMs: 1500 });
    let labels = [];
    for (let i = 0; i < 40; i += 1) {
      labels = await b.eval(
        `[...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))`,
      );
      if (labels.length > 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    t.ok(
      `[${code}] the mobile menu's aria-label`,
      labels.includes(locale.toggleMenu),
      `want "${locale.toggleMenu}" in ${JSON.stringify(labels)}`,
    );
    if (code !== 'en') {
      const leaked = labels.filter((a) => ENGLISH_SOURCES.has(a));
      t.ok(
        `[${code}] no mobile aria-label fell back to English`,
        leaked.length === 0,
        JSON.stringify(leaked),
      );
    }
  }
  b.close();
}

process.exit(t.done() ? 0 : 1);
