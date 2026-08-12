import type { Translations } from 'fumadocs-ui/i18n';
import { LOCALES, type Locale } from './i18n';

/**
 * One locale's 50 labels, with `displayName` pinned to that locale's endonym.
 *
 * `displayName` is the name fumadocs prints in the language menu, and `LOCALES`
 * in `lib/i18n.ts` already holds it — that list is documented as the source of
 * both the menu's order and its labels, and `<html lang>` and the `hreflang`
 * alternates are built from the same entries. Typing the key as the literal from
 * there, rather than as `string`, means the menu cannot drift away from the rest
 * of the site: rename a language in `i18n.ts` and this file stops compiling
 * until it is renamed here too.
 */
type LocaleTranslations<C extends Locale> = Omit<Translations, 'displayName'> & {
  displayName: Extract<(typeof LOCALES)[number], { code: C }>['name'];
};

/**
 * Every label Fumadocs' own components render, per locale.
 *
 * ## Why this file exists, separately from `ui-strings.ts`
 *
 * Fumadocs 16 translates through `@fuma-translate/react`, whose dictionary key
 * is *the English source string plus a context suffix* — `t("On this page")`
 * inside a `useTranslations({ note: 'table of contents' })` looks up
 * `"On this page(table of contents)"`. The lookup is
 * `translations[encodeKey(rawText, notes)] ?? rawText`: a key that does not
 * match is not an error, it silently renders English.
 *
 * That is exactly how this site shipped eight localized routes whose every
 * piece of chrome was English. `ui-strings.ts` supplied v15-era camelCase keys
 * (`toc`, `search`, `lastUpdate`, …); not one of the ten matched, so all ten
 * fell back. `displayName` was the single key whose name did not change, which
 * is why the language menu looked translated and nothing else did.
 *
 * So the two tables are split by *who owns the key*, not by what the string is
 * for:
 *
 *   - **This file** is the library's contract. Its keys are dictated by
 *     fumadocs, ugly on purpose, and mechanically regenerable from
 *     `node_modules/fumadocs-ui/dist/.translations/index.d.ts`. Nobody may
 *     invent, shorten or tidy one.
 *   - **`ui-strings.ts`** is the strings *we* author, under names we choose.
 *
 * Keeping them in one table forced a lie: the old doc comment claimed its keys
 * were "a subset of ours", and a reader had no way to see that ten of them were
 * load-bearing library keys that had to be spelled a particular way while the
 * other five were free-form. Splitting makes the boundary visible, and it means
 * a fumadocs upgrade touches one file whose entire job is to track fumadocs.
 *
 * ## Why a missing key is a type error now
 *
 * `Translations` is exported from `fumadocs-ui/i18n` (it is the shape of
 * `.translations/index.d.ts`, 50 required string properties). Annotating the
 * table with it makes both halves of a rename fail `tsc`: the new key is
 * *missing* (TS2322/TS2741) and the stale key is an *excess property* on an
 * object literal (TS2353). `defineI18nUI` itself only asks for
 * `Record<string, string>`, which is what let the mismatch compile for the life
 * of the page — so the annotation has to be here, at the table, not at the call
 * site, and `app/[lang]/layout.tsx` must pass the table through unreshaped.
 *
 * `scripts/browser/docs-i18n.mjs` repeats the check at runtime against the
 * library's own `dist/.translations/keys.js`, and then reads the labels back out
 * of the rendered DOM in all eight locales.
 *
 * ## Register
 *
 * These are UI labels, so: short, conventional for the platform, and consistent
 * with the already-translated pages under `content/docs/**` and the chrome in
 * `ui-strings.ts`. Specifically:
 *
 *   - The renderings `ui-strings.ts` had already settled for search, the table
 *     of contents, last-update, language and theme are carried over verbatim
 *     where the slot is the same kind of thing.
 *   - Where a v16 key reveals the slot is an **action or an aria-label** and the
 *     old value was a bare noun, the noun is kept as vocabulary and wrapped in
 *     the verb the control actually performs. A screen reader announcing
 *     "主题, 按钮" tells a reader what the button is *about*; "切换主题, 按钮"
 *     tells them what pressing it *does*. Fumadocs gives the visible text and
 *     the aria-label separate keys precisely so they can differ.
 *   - Each language keeps its own preposition for GitHub, matching the
 *     already-settled `Edit on GitHub` — 在 GitHub 上, GitHub पर, на GitHub,
 *     Auf GitHub — rather than importing English's "in".
 *   - `AI` follows the content pages, which localize the acronym where the
 *     language has one (es `IA`, pt `IA`, ru `ИИ`, de `KI`) and keep `AI` where
 *     it does not (zh, ja, hi).
 *   - German is informal `du`, as on every German content page.
 *   - Hindi keeps technical nouns in Latin script with Devanagari grammar, as on
 *     every Hindi content page — which is why the type-table headers below read
 *     `Type`, `Default`, `Prop`, `Parameters`, `Returns`. Those pages already
 *     write `Flag`, `Environment` and `Config-फ़ाइल key` that way; translating
 *     only this table would give a Hindi reader two vocabularies for one idea.
 *
 * ## Labels this site cannot currently render
 *
 * Translated anyway — the cost is one line each, and the alternative is an
 * English label appearing the day someone enables the feature:
 *
 *   - `Ask AI`, `Layout Tab`, `Hide Sidebar`, `Show Sidebar` — the `glass`
 *     layout only; this site uses `docs` and `home`.
 *   - the three `404 page` keys — there is no `not-found.tsx` yet.
 *   - the five `type table` keys and `Table of Contents(inline table of
 *     contents)` — `TypeTable` and `InlineTOC` are registered in
 *     `components/mdx.tsx` but no page uses one yet.
 *   - `Edit on GitHub(edit page)` and `Last updated on(page footer)` — the docs
 *     page does not pass `editOnGithub` or `lastUpdate`.
 *   - `Close Banner(banner)(aria-label)` and `Copy Link(accordion)(aria-label)`
 *     — no `<Banner>`, no `<Accordions>` in the content.
 *   - `Light`/`Dark`/`System(theme switcher)(aria-label)` — only the
 *     `light-dark-system` switcher renders three buttons; the default
 *     `light-dark` one renders a single `Toggle Theme` button.
 *   - `Next Page`/`Previous Page(pagination)` — the footer renders
 *     `item.description ?? t("Next Page")`, and every page in `content/docs`
 *     has a description, so the fallback never shows.
 *   - `Close Sidebar(aria-label)` — the unnoted variant. No component in
 *     fumadocs 16.14 reads it; the `(sidebar)`-noted key is the live one. Given
 *     the same value so that a component which starts reading it is correct.
 */
export const FUMADOCS_TRANSLATIONS: { [C in Locale]: LocaleTranslations<C> } = {
  en: {
    displayName: 'English',
    'Ask AI(AI chat button)': 'Ask AI',
    'Back to Home(404 page)': 'Back to Home',
    'Choose a language(language switcher)': 'Choose a language',
    'Choose a language(language switcher)(aria-label)': 'Choose a language',
    'Close Banner(banner)(aria-label)': 'Close Banner',
    'Close Search(search dialog)(aria-label)': 'Close Search',
    'Close Sidebar(aria-label)': 'Close Sidebar',
    'Close Sidebar(sidebar)(aria-label)': 'Close Sidebar',
    'Collapse Sidebar(sidebar)(aria-label)': 'Collapse Sidebar',
    'Copied Text(code block)(aria-label)': 'Copied Text',
    'Copy Anchor Link(heading anchor)(aria-label)': 'Copy Anchor Link',
    'Copy Link(accordion)(aria-label)': 'Copy Link',
    'Copy Markdown(page actions)': 'Copy Markdown',
    'Copy Text(code block)(aria-label)': 'Copy Text',
    'Dark(theme switcher)(aria-label)': 'Dark',
    'Default(type table)': 'Default',
    'Edit on GitHub(edit page)': 'Edit on GitHub',
    'Hide Sidebar(sidebar)': 'Hide Sidebar',
    'Last updated on(page footer)': 'Last updated on',
    'Layout Tab(layout tab trigger)': 'Layout Tab',
    'Light(theme switcher)(aria-label)': 'Light',
    'Next Page(pagination)': 'Next Page',
    'No Headings(table of contents)': 'No Headings',
    'No results found(search dialog)': 'No results found',
    'On this page(table of contents)': 'On this page',
    'Open Search(search trigger)(aria-label)': 'Open Search',
    'Open Sidebar(sidebar)(aria-label)': 'Open Sidebar',
    'Open in ChatGPT(page actions)': 'Open in ChatGPT',
    'Open in Claude(page actions)': 'Open in Claude',
    'Open in Cursor(page actions)': 'Open in Cursor',
    'Open in GitHub(page actions)': 'Open in GitHub',
    'Open in Scira AI(page actions)': 'Open in Scira AI',
    'Open(page actions)': 'Open',
    'Page Not Found(404 page)': 'Page Not Found',
    'Parameters(type table)': 'Parameters',
    'Previous Page(pagination)': 'Previous Page',
    'Prop(type table)': 'Prop',
    'Read {url}, I want to ask questions about it.(page actions)':
      'Read {url}, I want to ask questions about it.',
    'Returns(type table)': 'Returns',
    'Search(search dialog)': 'Search',
    'Search(search trigger)': 'Search',
    'Show Sidebar(sidebar)': 'Show Sidebar',
    'System(theme switcher)(aria-label)': 'System',
    'Table of Contents(inline table of contents)': 'Table of Contents',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.',
    'Toggle Menu(mobile menu)(aria-label)': 'Toggle Menu',
    'Toggle Theme(theme switcher)(aria-label)': 'Toggle Theme',
    'Type(type table)': 'Type',
    'View as Markdown(page actions)': 'View as Markdown',
  },

  // 全角标点，Latin 与汉字之间留半角空格 —— 与 content/docs/*.zh.mdx 一致。
  zh: {
    displayName: '简体中文',
    'Ask AI(AI chat button)': '询问 AI',
    'Back to Home(404 page)': '返回首页',
    'Choose a language(language switcher)': '语言',
    'Choose a language(language switcher)(aria-label)': '选择语言',
    'Close Banner(banner)(aria-label)': '关闭横幅',
    'Close Search(search dialog)(aria-label)': '关闭搜索',
    'Close Sidebar(aria-label)': '关闭侧边栏',
    'Close Sidebar(sidebar)(aria-label)': '关闭侧边栏',
    'Collapse Sidebar(sidebar)(aria-label)': '折叠侧边栏',
    'Copied Text(code block)(aria-label)': '已复制',
    'Copy Anchor Link(heading anchor)(aria-label)': '复制本节链接',
    'Copy Link(accordion)(aria-label)': '复制链接',
    'Copy Markdown(page actions)': '复制 Markdown',
    // The button copies a code block, and 复制代码 is what a Chinese reader
    // expects there — the library's generic "Text" is less informative than
    // its own `(code block)` note already is.
    'Copy Text(code block)(aria-label)': '复制代码',
    'Dark(theme switcher)(aria-label)': '深色',
    'Default(type table)': '默认值',
    'Edit on GitHub(edit page)': '在 GitHub 上编辑',
    'Hide Sidebar(sidebar)': '隐藏侧边栏',
    'Last updated on(page footer)': '最后更新',
    'Layout Tab(layout tab trigger)': '分区',
    'Light(theme switcher)(aria-label)': '浅色',
    'Next Page(pagination)': '下一页',
    'No Headings(table of contents)': '没有标题',
    'No results found(search dialog)': '没有结果',
    'On this page(table of contents)': '本页目录',
    'Open Search(search trigger)(aria-label)': '打开搜索',
    'Open Sidebar(sidebar)(aria-label)': '打开侧边栏',
    'Open in ChatGPT(page actions)': '在 ChatGPT 中打开',
    'Open in Claude(page actions)': '在 Claude 中打开',
    'Open in Cursor(page actions)': '在 Cursor 中打开',
    'Open in GitHub(page actions)': '在 GitHub 上打开',
    'Open in Scira AI(page actions)': '在 Scira AI 中打开',
    // The trigger of a menu of "open in …" destinations, so 打开方式 rather
    // than a bare 打开, which would read as "open (this)".
    'Open(page actions)': '打开方式',
    'Page Not Found(404 page)': '页面未找到',
    'Parameters(type table)': '参数',
    'Previous Page(pagination)': '上一页',
    'Prop(type table)': '属性',
    'Read {url}, I want to ask questions about it.(page actions)': '请阅读 {url}，我想就它提问。',
    'Returns(type table)': '返回值',
    'Search(search dialog)': '搜索',
    'Search(search trigger)': '搜索',
    'Show Sidebar(sidebar)': '显示侧边栏',
    'System(theme switcher)(aria-label)': '跟随系统',
    'Table of Contents(inline table of contents)': '目录',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      '你要找的页面可能已被删除、改名，或暂时无法访问。',
    'Toggle Menu(mobile menu)(aria-label)': '切换菜单',
    'Toggle Theme(theme switcher)(aria-label)': '切换主题',
    'Type(type table)': '类型',
    'View as Markdown(page actions)': '以 Markdown 查看',
  },

  // Devanagari grammar, technical nouns in Latin — as in content/docs/*.hi.mdx.
  hi: {
    displayName: 'हिन्दी',
    'Ask AI(AI chat button)': 'AI से पूछें',
    'Back to Home(404 page)': 'होम पर लौटें',
    'Choose a language(language switcher)': 'भाषा',
    'Choose a language(language switcher)(aria-label)': 'भाषा चुनें',
    'Close Banner(banner)(aria-label)': 'बैनर बंद करें',
    'Close Search(search dialog)(aria-label)': 'खोज बंद करें',
    'Close Sidebar(aria-label)': 'साइडबार बंद करें',
    'Close Sidebar(sidebar)(aria-label)': 'साइडबार बंद करें',
    'Collapse Sidebar(sidebar)(aria-label)': 'साइडबार समेटें',
    'Copied Text(code block)(aria-label)': 'कॉपी हो गया',
    'Copy Anchor Link(heading anchor)(aria-label)': 'इस अनुभाग का लिंक कॉपी करें',
    'Copy Link(accordion)(aria-label)': 'लिंक कॉपी करें',
    'Copy Markdown(page actions)': 'Markdown कॉपी करें',
    'Copy Text(code block)(aria-label)': 'Code कॉपी करें',
    'Dark(theme switcher)(aria-label)': 'डार्क',
    'Default(type table)': 'Default',
    'Edit on GitHub(edit page)': 'GitHub पर संपादित करें',
    'Hide Sidebar(sidebar)': 'साइडबार छिपाएँ',
    'Last updated on(page footer)': 'अंतिम अद्यतन',
    'Layout Tab(layout tab trigger)': 'अनुभाग',
    'Light(theme switcher)(aria-label)': 'लाइट',
    'Next Page(pagination)': 'अगला पृष्ठ',
    'No Headings(table of contents)': 'कोई शीर्षक नहीं',
    'No results found(search dialog)': 'कोई परिणाम नहीं',
    'On this page(table of contents)': 'इस पृष्ठ पर',
    'Open Search(search trigger)(aria-label)': 'खोज खोलें',
    'Open Sidebar(sidebar)(aria-label)': 'साइडबार खोलें',
    'Open in ChatGPT(page actions)': 'ChatGPT में खोलें',
    'Open in Claude(page actions)': 'Claude में खोलें',
    'Open in Cursor(page actions)': 'Cursor में खोलें',
    'Open in GitHub(page actions)': 'GitHub पर खोलें',
    'Open in Scira AI(page actions)': 'Scira AI में खोलें',
    'Open(page actions)': 'खोलें',
    'Page Not Found(404 page)': 'पृष्ठ नहीं मिला',
    'Parameters(type table)': 'Parameters',
    'Previous Page(pagination)': 'पिछला पृष्ठ',
    'Prop(type table)': 'Prop',
    'Read {url}, I want to ask questions about it.(page actions)':
      '{url} पढ़ें, मैं इसके बारे में सवाल पूछना चाहता हूँ।',
    'Returns(type table)': 'Returns',
    'Search(search dialog)': 'खोजें',
    'Search(search trigger)': 'खोजें',
    'Show Sidebar(sidebar)': 'साइडबार दिखाएँ',
    'System(theme switcher)(aria-label)': 'सिस्टम',
    'Table of Contents(inline table of contents)': 'विषय-सूची',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'आप जो पृष्ठ खोज रहे हैं वह हटाया जा चुका हो सकता है, उसका नाम बदल गया हो सकता है, या वह कुछ समय के लिए उपलब्ध नहीं है।',
    'Toggle Menu(mobile menu)(aria-label)': 'मेनू खोलें या बंद करें',
    'Toggle Theme(theme switcher)(aria-label)': 'थीम बदलें',
    'Type(type table)': 'Type',
    'View as Markdown(page actions)': 'Markdown में देखें',
  },

  // Informal "tú", as on every Spanish content page here.
  es: {
    displayName: 'Español',
    'Ask AI(AI chat button)': 'Preguntar a la IA',
    'Back to Home(404 page)': 'Volver al inicio',
    'Choose a language(language switcher)': 'Idioma',
    'Choose a language(language switcher)(aria-label)': 'Elegir idioma',
    'Close Banner(banner)(aria-label)': 'Cerrar el aviso',
    'Close Search(search dialog)(aria-label)': 'Cerrar la búsqueda',
    'Close Sidebar(aria-label)': 'Cerrar la barra lateral',
    'Close Sidebar(sidebar)(aria-label)': 'Cerrar la barra lateral',
    'Collapse Sidebar(sidebar)(aria-label)': 'Contraer la barra lateral',
    'Copied Text(code block)(aria-label)': 'Copiado',
    'Copy Anchor Link(heading anchor)(aria-label)': 'Copiar el enlace a esta sección',
    'Copy Link(accordion)(aria-label)': 'Copiar el enlace',
    'Copy Markdown(page actions)': 'Copiar el Markdown',
    'Copy Text(code block)(aria-label)': 'Copiar el código',
    'Dark(theme switcher)(aria-label)': 'Oscuro',
    'Default(type table)': 'Valor predeterminado',
    'Edit on GitHub(edit page)': 'Editar en GitHub',
    'Hide Sidebar(sidebar)': 'Ocultar la barra lateral',
    'Last updated on(page footer)': 'Última actualización',
    'Layout Tab(layout tab trigger)': 'Sección',
    'Light(theme switcher)(aria-label)': 'Claro',
    'Next Page(pagination)': 'Página siguiente',
    'No Headings(table of contents)': 'Sin encabezados',
    'No results found(search dialog)': 'Sin resultados',
    'On this page(table of contents)': 'En esta página',
    'Open Search(search trigger)(aria-label)': 'Abrir la búsqueda',
    'Open Sidebar(sidebar)(aria-label)': 'Abrir la barra lateral',
    'Open in ChatGPT(page actions)': 'Abrir en ChatGPT',
    'Open in Claude(page actions)': 'Abrir en Claude',
    'Open in Cursor(page actions)': 'Abrir en Cursor',
    'Open in GitHub(page actions)': 'Abrir en GitHub',
    'Open in Scira AI(page actions)': 'Abrir en Scira AI',
    'Open(page actions)': 'Abrir',
    'Page Not Found(404 page)': 'Página no encontrada',
    'Parameters(type table)': 'Parámetros',
    'Previous Page(pagination)': 'Página anterior',
    'Prop(type table)': 'Propiedad',
    'Read {url}, I want to ask questions about it.(page actions)':
      'Lee {url}, quiero hacerte preguntas al respecto.',
    'Returns(type table)': 'Valor devuelto',
    'Search(search dialog)': 'Buscar',
    'Search(search trigger)': 'Buscar',
    'Show Sidebar(sidebar)': 'Mostrar la barra lateral',
    'System(theme switcher)(aria-label)': 'Sistema',
    'Table of Contents(inline table of contents)': 'Índice',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'La página que buscas puede haberse eliminado, haber cambiado de nombre o no estar disponible temporalmente.',
    'Toggle Menu(mobile menu)(aria-label)': 'Abrir o cerrar el menú',
    'Toggle Theme(theme switcher)(aria-label)': 'Cambiar de tema',
    'Type(type table)': 'Tipo',
    'View as Markdown(page actions)': 'Ver como Markdown',
  },

  // Brazilian Portuguese, "você" — as on every Portuguese content page here.
  pt: {
    displayName: 'Português',
    'Ask AI(AI chat button)': 'Perguntar à IA',
    'Back to Home(404 page)': 'Voltar ao início',
    'Choose a language(language switcher)': 'Idioma',
    'Choose a language(language switcher)(aria-label)': 'Escolher idioma',
    'Close Banner(banner)(aria-label)': 'Fechar o aviso',
    'Close Search(search dialog)(aria-label)': 'Fechar a pesquisa',
    'Close Sidebar(aria-label)': 'Fechar a barra lateral',
    'Close Sidebar(sidebar)(aria-label)': 'Fechar a barra lateral',
    'Collapse Sidebar(sidebar)(aria-label)': 'Recolher a barra lateral',
    'Copied Text(code block)(aria-label)': 'Copiado',
    'Copy Anchor Link(heading anchor)(aria-label)': 'Copiar o link desta seção',
    'Copy Link(accordion)(aria-label)': 'Copiar o link',
    'Copy Markdown(page actions)': 'Copiar o Markdown',
    'Copy Text(code block)(aria-label)': 'Copiar o código',
    'Dark(theme switcher)(aria-label)': 'Escuro',
    'Default(type table)': 'Valor padrão',
    'Edit on GitHub(edit page)': 'Editar no GitHub',
    'Hide Sidebar(sidebar)': 'Ocultar a barra lateral',
    'Last updated on(page footer)': 'Última atualização',
    'Layout Tab(layout tab trigger)': 'Seção',
    'Light(theme switcher)(aria-label)': 'Claro',
    'Next Page(pagination)': 'Próxima página',
    'No Headings(table of contents)': 'Sem títulos',
    'No results found(search dialog)': 'Nenhum resultado',
    'On this page(table of contents)': 'Nesta página',
    'Open Search(search trigger)(aria-label)': 'Abrir a pesquisa',
    'Open Sidebar(sidebar)(aria-label)': 'Abrir a barra lateral',
    'Open in ChatGPT(page actions)': 'Abrir no ChatGPT',
    'Open in Claude(page actions)': 'Abrir no Claude',
    'Open in Cursor(page actions)': 'Abrir no Cursor',
    'Open in GitHub(page actions)': 'Abrir no GitHub',
    'Open in Scira AI(page actions)': 'Abrir no Scira AI',
    'Open(page actions)': 'Abrir',
    'Page Not Found(404 page)': 'Página não encontrada',
    'Parameters(type table)': 'Parâmetros',
    'Previous Page(pagination)': 'Página anterior',
    'Prop(type table)': 'Propriedade',
    'Read {url}, I want to ask questions about it.(page actions)':
      'Leia {url}, quero fazer perguntas sobre ela.',
    'Returns(type table)': 'Valor retornado',
    'Search(search dialog)': 'Pesquisar',
    'Search(search trigger)': 'Pesquisar',
    'Show Sidebar(sidebar)': 'Mostrar a barra lateral',
    'System(theme switcher)(aria-label)': 'Sistema',
    'Table of Contents(inline table of contents)': 'Índice',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'A página que você procura pode ter sido removida, ter mudado de nome ou estar temporariamente indisponível.',
    'Toggle Menu(mobile menu)(aria-label)': 'Abrir ou fechar o menu',
    'Toggle Theme(theme switcher)(aria-label)': 'Alternar o tema',
    'Type(type table)': 'Tipo',
    'View as Markdown(page actions)': 'Ver como Markdown',
  },

  // Formal "вы" for the reader, as on every Russian content page here. The one
  // exception is the AI prompt, which is addressed to the model, not the reader.
  ru: {
    displayName: 'Русский',
    'Ask AI(AI chat button)': 'Спросить ИИ',
    'Back to Home(404 page)': 'На главную',
    'Choose a language(language switcher)': 'Язык',
    'Choose a language(language switcher)(aria-label)': 'Выбрать язык',
    'Close Banner(banner)(aria-label)': 'Закрыть баннер',
    'Close Search(search dialog)(aria-label)': 'Закрыть поиск',
    'Close Sidebar(aria-label)': 'Закрыть боковую панель',
    'Close Sidebar(sidebar)(aria-label)': 'Закрыть боковую панель',
    'Collapse Sidebar(sidebar)(aria-label)': 'Свернуть боковую панель',
    'Copied Text(code block)(aria-label)': 'Скопировано',
    'Copy Anchor Link(heading anchor)(aria-label)': 'Скопировать ссылку на этот раздел',
    'Copy Link(accordion)(aria-label)': 'Скопировать ссылку',
    'Copy Markdown(page actions)': 'Скопировать Markdown',
    'Copy Text(code block)(aria-label)': 'Скопировать код',
    'Dark(theme switcher)(aria-label)': 'Тёмная',
    'Default(type table)': 'Значение по умолчанию',
    'Edit on GitHub(edit page)': 'Редактировать на GitHub',
    'Hide Sidebar(sidebar)': 'Скрыть боковую панель',
    'Last updated on(page footer)': 'Обновлено',
    'Layout Tab(layout tab trigger)': 'Раздел',
    'Light(theme switcher)(aria-label)': 'Светлая',
    'Next Page(pagination)': 'Следующая страница',
    'No Headings(table of contents)': 'Нет заголовков',
    'No results found(search dialog)': 'Ничего не найдено',
    'On this page(table of contents)': 'На этой странице',
    'Open Search(search trigger)(aria-label)': 'Открыть поиск',
    'Open Sidebar(sidebar)(aria-label)': 'Открыть боковую панель',
    'Open in ChatGPT(page actions)': 'Открыть в ChatGPT',
    'Open in Claude(page actions)': 'Открыть в Claude',
    'Open in Cursor(page actions)': 'Открыть в Cursor',
    'Open in GitHub(page actions)': 'Открыть на GitHub',
    'Open in Scira AI(page actions)': 'Открыть в Scira AI',
    'Open(page actions)': 'Открыть',
    'Page Not Found(404 page)': 'Страница не найдена',
    'Parameters(type table)': 'Параметры',
    'Previous Page(pagination)': 'Предыдущая страница',
    'Prop(type table)': 'Свойство',
    'Read {url}, I want to ask questions about it.(page actions)':
      'Прочитай {url}, я хочу задать вопросы по этой странице.',
    'Returns(type table)': 'Возвращаемое значение',
    'Search(search dialog)': 'Поиск',
    'Search(search trigger)': 'Поиск',
    'Show Sidebar(sidebar)': 'Показать боковую панель',
    'System(theme switcher)(aria-label)': 'Системная',
    'Table of Contents(inline table of contents)': 'Содержание',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'Страница, которую вы ищете, могла быть удалена, переименована или временно недоступна.',
    'Toggle Menu(mobile menu)(aria-label)': 'Открыть или закрыть меню',
    'Toggle Theme(theme switcher)(aria-label)': 'Переключить тему',
    'Type(type table)': 'Тип',
    'View as Markdown(page actions)': 'Открыть как Markdown',
  },

  // A half-width space between Latin and kana, as in content/docs/*.ja.mdx.
  ja: {
    displayName: '日本語',
    'Ask AI(AI chat button)': 'AI に質問',
    'Back to Home(404 page)': 'ホームに戻る',
    'Choose a language(language switcher)': '言語',
    'Choose a language(language switcher)(aria-label)': '言語を選択',
    'Close Banner(banner)(aria-label)': 'バナーを閉じる',
    'Close Search(search dialog)(aria-label)': '検索を閉じる',
    'Close Sidebar(aria-label)': 'サイドバーを閉じる',
    'Close Sidebar(sidebar)(aria-label)': 'サイドバーを閉じる',
    'Collapse Sidebar(sidebar)(aria-label)': 'サイドバーを折りたたむ',
    'Copied Text(code block)(aria-label)': 'コピーしました',
    'Copy Anchor Link(heading anchor)(aria-label)': 'この見出しへのリンクをコピー',
    'Copy Link(accordion)(aria-label)': 'リンクをコピー',
    'Copy Markdown(page actions)': 'Markdown をコピー',
    'Copy Text(code block)(aria-label)': 'コードをコピー',
    'Dark(theme switcher)(aria-label)': 'ダーク',
    'Default(type table)': 'デフォルト値',
    'Edit on GitHub(edit page)': 'GitHub で編集',
    'Hide Sidebar(sidebar)': 'サイドバーを隠す',
    'Last updated on(page footer)': '最終更新',
    'Layout Tab(layout tab trigger)': 'セクション',
    'Light(theme switcher)(aria-label)': 'ライト',
    'Next Page(pagination)': '次のページ',
    'No Headings(table of contents)': '見出しがありません',
    'No results found(search dialog)': '結果がありません',
    'On this page(table of contents)': 'このページの内容',
    'Open Search(search trigger)(aria-label)': '検索を開く',
    'Open Sidebar(sidebar)(aria-label)': 'サイドバーを開く',
    'Open in ChatGPT(page actions)': 'ChatGPT で開く',
    'Open in Claude(page actions)': 'Claude で開く',
    'Open in Cursor(page actions)': 'Cursor で開く',
    'Open in GitHub(page actions)': 'GitHub で開く',
    'Open in Scira AI(page actions)': 'Scira AI で開く',
    'Open(page actions)': '開く',
    'Page Not Found(404 page)': 'ページが見つかりません',
    'Parameters(type table)': 'パラメータ',
    'Previous Page(pagination)': '前のページ',
    'Prop(type table)': 'プロパティ',
    'Read {url}, I want to ask questions about it.(page actions)':
      '{url} を読んでください。その内容について質問したいです。',
    'Returns(type table)': '戻り値',
    'Search(search dialog)': '検索',
    'Search(search trigger)': '検索',
    'Show Sidebar(sidebar)': 'サイドバーを表示',
    'System(theme switcher)(aria-label)': 'システム',
    'Table of Contents(inline table of contents)': '目次',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'お探しのページは、削除された、名前が変わった、または一時的に利用できない可能性があります。',
    'Toggle Menu(mobile menu)(aria-label)': 'メニューを開閉',
    'Toggle Theme(theme switcher)(aria-label)': 'テーマを切り替える',
    'Type(type table)': '型',
    'View as Markdown(page actions)': 'Markdown で表示',
  },

  // Informal "du", as on every German content page here. "Design" for theme,
  // matching the nav strings this site already shipped.
  de: {
    displayName: 'Deutsch',
    'Ask AI(AI chat button)': 'KI fragen',
    'Back to Home(404 page)': 'Zurück zur Startseite',
    'Choose a language(language switcher)': 'Sprache',
    'Choose a language(language switcher)(aria-label)': 'Sprache wählen',
    'Close Banner(banner)(aria-label)': 'Hinweis schließen',
    'Close Search(search dialog)(aria-label)': 'Suche schließen',
    'Close Sidebar(aria-label)': 'Seitenleiste schließen',
    'Close Sidebar(sidebar)(aria-label)': 'Seitenleiste schließen',
    'Collapse Sidebar(sidebar)(aria-label)': 'Seitenleiste einklappen',
    'Copied Text(code block)(aria-label)': 'Kopiert',
    'Copy Anchor Link(heading anchor)(aria-label)': 'Link zu dieser Überschrift kopieren',
    'Copy Link(accordion)(aria-label)': 'Link kopieren',
    'Copy Markdown(page actions)': 'Markdown kopieren',
    'Copy Text(code block)(aria-label)': 'Code kopieren',
    'Dark(theme switcher)(aria-label)': 'Dunkel',
    'Default(type table)': 'Standardwert',
    'Edit on GitHub(edit page)': 'Auf GitHub bearbeiten',
    'Hide Sidebar(sidebar)': 'Seitenleiste ausblenden',
    'Last updated on(page footer)': 'Zuletzt aktualisiert',
    'Layout Tab(layout tab trigger)': 'Bereich',
    'Light(theme switcher)(aria-label)': 'Hell',
    'Next Page(pagination)': 'Nächste Seite',
    'No Headings(table of contents)': 'Keine Überschriften',
    'No results found(search dialog)': 'Keine Ergebnisse',
    'On this page(table of contents)': 'Auf dieser Seite',
    'Open Search(search trigger)(aria-label)': 'Suche öffnen',
    'Open Sidebar(sidebar)(aria-label)': 'Seitenleiste öffnen',
    'Open in ChatGPT(page actions)': 'In ChatGPT öffnen',
    'Open in Claude(page actions)': 'In Claude öffnen',
    'Open in Cursor(page actions)': 'In Cursor öffnen',
    'Open in GitHub(page actions)': 'Auf GitHub öffnen',
    'Open in Scira AI(page actions)': 'In Scira AI öffnen',
    'Open(page actions)': 'Öffnen',
    'Page Not Found(404 page)': 'Seite nicht gefunden',
    'Parameters(type table)': 'Parameter',
    'Previous Page(pagination)': 'Vorherige Seite',
    'Prop(type table)': 'Eigenschaft',
    'Read {url}, I want to ask questions about it.(page actions)':
      'Lies {url}, ich möchte dir dazu Fragen stellen.',
    'Returns(type table)': 'Rückgabewert',
    'Search(search dialog)': 'Suchen',
    'Search(search trigger)': 'Suchen',
    'Show Sidebar(sidebar)': 'Seitenleiste einblenden',
    'System(theme switcher)(aria-label)': 'System',
    'Table of Contents(inline table of contents)': 'Inhaltsverzeichnis',
    'The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)':
      'Die Seite, die du suchst, wurde vielleicht entfernt, umbenannt oder ist vorübergehend nicht erreichbar.',
    'Toggle Menu(mobile menu)(aria-label)': 'Menü öffnen oder schließen',
    'Toggle Theme(theme switcher)(aria-label)': 'Design wechseln',
    'Type(type table)': 'Typ',
    'View as Markdown(page actions)': 'Als Markdown ansehen',
  },
};
