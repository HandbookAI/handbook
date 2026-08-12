import type { Locale } from './i18n';

/**
 * The chrome this site authors itself, per locale — the nav bar, plus the notice
 * a reader gets on a page that has no translation yet.
 *
 * Kept as one table rather than eight files because it is small and because a
 * missing key should be obvious at a glance.
 *
 * The labels Fumadocs' OWN components render used to live here too, and that is
 * how they came to be English on all eight localized routes: fumadocs 16 keys
 * its dictionary by the English source string plus a context suffix, and the
 * camelCase names that used to sit above `navDocs` matched none of them — a
 * mismatch that renders English rather than failing. They now live in
 * `fumadocs-strings.ts`, typed against the library's own `Translations`, so the
 * next rename is a compile error instead of a silent regression. The dividing
 * line is ownership: keys fumadocs dictates go there, names we choose stay here.
 */
export interface UiStrings {
  navDocs: string;
  navQuickstart: string;
  navCli: string;
  navConfig: string;
  untranslated: string;
}

export const UI: Record<Locale, UiStrings> = {
  en: {
    navDocs: 'Docs',
    navQuickstart: 'Quick start',
    navCli: 'CLI reference',
    navConfig: 'Configuration',
    untranslated:
      'This page has not been translated yet, so you are reading the English original. Translations are welcome.',
  },
  zh: {
    navDocs: '文档',
    navQuickstart: '快速上手',
    navCli: 'CLI 参考',
    navConfig: '配置',
    untranslated: '本页尚未翻译，你看到的是英文原文。欢迎参与翻译。',
  },
  hi: {
    navDocs: 'दस्तावेज़',
    navQuickstart: 'त्वरित शुरुआत',
    navCli: 'CLI संदर्भ',
    navConfig: 'कॉन्फ़िगरेशन',
    untranslated:
      'यह पृष्ठ अभी तक अनुवादित नहीं है, इसलिए आप अंग्रेज़ी मूल पढ़ रहे हैं। अनुवाद का स्वागत है।',
  },
  es: {
    navDocs: 'Documentación',
    navQuickstart: 'Inicio rápido',
    navCli: 'Referencia de CLI',
    navConfig: 'Configuración',
    untranslated:
      'Esta página aún no está traducida, así que estás leyendo el original en inglés. Las traducciones son bienvenidas.',
  },
  pt: {
    navDocs: 'Documentação',
    navQuickstart: 'Início rápido',
    navCli: 'Referência da CLI',
    navConfig: 'Configuração',
    untranslated:
      'Esta página ainda não foi traduzida, portanto você está lendo o original em inglês. Traduções são bem-vindas.',
  },
  ru: {
    navDocs: 'Документация',
    navQuickstart: 'Быстрый старт',
    navCli: 'Справочник CLI',
    navConfig: 'Конфигурация',
    untranslated:
      'Эта страница ещё не переведена, поэтому вы читаете английский оригинал. Переводы приветствуются.',
  },
  ja: {
    navDocs: 'ドキュメント',
    navQuickstart: 'クイックスタート',
    navCli: 'CLI リファレンス',
    navConfig: '設定',
    untranslated:
      'このページはまだ翻訳されていないため、英語の原文を表示しています。翻訳の貢献を歓迎します。',
  },
  de: {
    navDocs: 'Dokumentation',
    navQuickstart: 'Schnellstart',
    navCli: 'CLI-Referenz',
    navConfig: 'Konfiguration',
    untranslated:
      'Diese Seite ist noch nicht übersetzt, du liest daher das englische Original. Übersetzungen sind willkommen.',
  },
};

export function ui(locale: string): UiStrings {
  return UI[(locale as Locale) in UI ? (locale as Locale) : 'en'];
}
