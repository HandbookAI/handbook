import { defineI18n } from 'fumadocs-core/i18n';

/**
 * The locales this site ships, ordered by the size of each language's developer
 * population — English first because it is the field's lingua franca, then by
 * how many developers actually read in each language.
 *
 * This order IS the order of the language menu, so it is a product decision
 * rather than an alphabetical accident.
 */
export const LOCALES = [
  { code: 'en', name: 'English', english: 'English' },
  { code: 'zh', name: '简体中文', english: 'Chinese (Simplified)' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi' },
  { code: 'es', name: 'Español', english: 'Spanish' },
  { code: 'pt', name: 'Português', english: 'Portuguese (Brazil)' },
  { code: 'ru', name: 'Русский', english: 'Russian' },
  { code: 'ja', name: '日本語', english: 'Japanese' },
  { code: 'de', name: 'Deutsch', english: 'German' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

export const LOCALE_CODES = LOCALES.map((l) => l.code) as unknown as string[];

/**
 * BCP 47 tags, for `hreflang`, `og:locale` and `<html lang>`.
 *
 * Not the bare codes: `zh` alone leaves a crawler guessing between Simplified
 * and Traditional, and `pt` without a region reads as European Portuguese when
 * this is Brazilian.
 */
export const BCP47: Record<Locale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  hi: 'hi-IN',
  es: 'es-ES',
  pt: 'pt-BR',
  ru: 'ru-RU',
  ja: 'ja-JP',
  de: 'de-DE',
};

export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: LOCALE_CODES,
  // English keeps the bare `/docs/...` URLs it already had, so no existing link
  // or search-engine result breaks; every other locale is prefixed.
  hideLocale: 'default-locale',
});
