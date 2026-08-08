import type { Locale } from './i18n';

/**
 * The site's own chrome, per locale — everything that is not page content.
 *
 * Kept as one table rather than eight files because it is small and because a
 * missing key should be obvious at a glance. `search`, `toc` and friends are the
 * keys Fumadocs' own components read; the rest are ours.
 */
export interface UiStrings {
  /** Fumadocs component labels. */
  search: string;
  searchNoResult: string;
  toc: string;
  tocNoHeadings: string;
  lastUpdate: string;
  chooseLanguage: string;
  nextPage: string;
  previousPage: string;
  chooseTheme: string;
  editOnGithub: string;
  /** Ours. */
  navDocs: string;
  navQuickstart: string;
  navCli: string;
  navConfig: string;
  untranslated: string;
}

export const UI: Record<Locale, UiStrings> = {
  en: {
    search: 'Search',
    searchNoResult: 'No results',
    toc: 'On this page',
    tocNoHeadings: 'No headings',
    lastUpdate: 'Last updated',
    chooseLanguage: 'Language',
    nextPage: 'Next',
    previousPage: 'Previous',
    chooseTheme: 'Theme',
    editOnGithub: 'Edit on GitHub',
    navDocs: 'Docs',
    navQuickstart: 'Quick start',
    navCli: 'CLI reference',
    navConfig: 'Configuration',
    untranslated:
      'This page has not been translated yet, so you are reading the English original. Translations are welcome.',
  },
  zh: {
    search: '搜索',
    searchNoResult: '没有结果',
    toc: '本页目录',
    tocNoHeadings: '没有标题',
    lastUpdate: '最后更新',
    chooseLanguage: '语言',
    nextPage: '下一页',
    previousPage: '上一页',
    chooseTheme: '主题',
    editOnGithub: '在 GitHub 上编辑',
    navDocs: '文档',
    navQuickstart: '快速上手',
    navCli: 'CLI 参考',
    navConfig: '配置',
    untranslated: '本页尚未翻译，你看到的是英文原文。欢迎参与翻译。',
  },
  hi: {
    search: 'खोजें',
    searchNoResult: 'कोई परिणाम नहीं',
    toc: 'इस पृष्ठ पर',
    tocNoHeadings: 'कोई शीर्षक नहीं',
    lastUpdate: 'अंतिम अद्यतन',
    chooseLanguage: 'भाषा',
    nextPage: 'अगला',
    previousPage: 'पिछला',
    chooseTheme: 'थीम',
    editOnGithub: 'GitHub पर संपादित करें',
    navDocs: 'दस्तावेज़',
    navQuickstart: 'त्वरित शुरुआत',
    navCli: 'CLI संदर्भ',
    navConfig: 'कॉन्फ़िगरेशन',
    untranslated:
      'यह पृष्ठ अभी तक अनुवादित नहीं है, इसलिए आप अंग्रेज़ी मूल पढ़ रहे हैं। अनुवाद का स्वागत है।',
  },
  es: {
    search: 'Buscar',
    searchNoResult: 'Sin resultados',
    toc: 'En esta página',
    tocNoHeadings: 'Sin encabezados',
    lastUpdate: 'Última actualización',
    chooseLanguage: 'Idioma',
    nextPage: 'Siguiente',
    previousPage: 'Anterior',
    chooseTheme: 'Tema',
    editOnGithub: 'Editar en GitHub',
    navDocs: 'Documentación',
    navQuickstart: 'Inicio rápido',
    navCli: 'Referencia de CLI',
    navConfig: 'Configuración',
    untranslated:
      'Esta página aún no está traducida, así que estás leyendo el original en inglés. Las traducciones son bienvenidas.',
  },
  pt: {
    search: 'Pesquisar',
    searchNoResult: 'Nenhum resultado',
    toc: 'Nesta página',
    tocNoHeadings: 'Sem títulos',
    lastUpdate: 'Última atualização',
    chooseLanguage: 'Idioma',
    nextPage: 'Próxima',
    previousPage: 'Anterior',
    chooseTheme: 'Tema',
    editOnGithub: 'Editar no GitHub',
    navDocs: 'Documentação',
    navQuickstart: 'Início rápido',
    navCli: 'Referência da CLI',
    navConfig: 'Configuração',
    untranslated:
      'Esta página ainda não foi traduzida, portanto você está lendo o original em inglês. Traduções são bem-vindas.',
  },
  ru: {
    search: 'Поиск',
    searchNoResult: 'Ничего не найдено',
    toc: 'На этой странице',
    tocNoHeadings: 'Нет заголовков',
    lastUpdate: 'Обновлено',
    chooseLanguage: 'Язык',
    nextPage: 'Далее',
    previousPage: 'Назад',
    chooseTheme: 'Тема',
    editOnGithub: 'Редактировать на GitHub',
    navDocs: 'Документация',
    navQuickstart: 'Быстрый старт',
    navCli: 'Справочник CLI',
    navConfig: 'Конфигурация',
    untranslated:
      'Эта страница ещё не переведена, поэтому вы читаете английский оригинал. Переводы приветствуются.',
  },
  ja: {
    search: '検索',
    searchNoResult: '結果がありません',
    toc: 'このページの内容',
    tocNoHeadings: '見出しがありません',
    lastUpdate: '最終更新',
    chooseLanguage: '言語',
    nextPage: '次へ',
    previousPage: '前へ',
    chooseTheme: 'テーマ',
    editOnGithub: 'GitHub で編集',
    navDocs: 'ドキュメント',
    navQuickstart: 'クイックスタート',
    navCli: 'CLI リファレンス',
    navConfig: '設定',
    untranslated:
      'このページはまだ翻訳されていないため、英語の原文を表示しています。翻訳の貢献を歓迎します。',
  },
  de: {
    search: 'Suchen',
    searchNoResult: 'Keine Ergebnisse',
    toc: 'Auf dieser Seite',
    tocNoHeadings: 'Keine Überschriften',
    lastUpdate: 'Zuletzt aktualisiert',
    chooseLanguage: 'Sprache',
    nextPage: 'Weiter',
    previousPage: 'Zurück',
    chooseTheme: 'Design',
    editOnGithub: 'Auf GitHub bearbeiten',
    navDocs: 'Dokumentation',
    navQuickstart: 'Schnellstart',
    navCli: 'CLI-Referenz',
    navConfig: 'Konfiguration',
    untranslated:
      'Diese Seite ist noch nicht übersetzt, Sie lesen daher das englische Original. Übersetzungen sind willkommen.',
  },
};

export function ui(locale: string): UiStrings {
  return UI[(locale as Locale) in UI ? (locale as Locale) : 'en'];
}
