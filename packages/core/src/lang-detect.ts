/**
 * Did the model answer in the language we asked for?
 *
 * A prompt directive is a request, not a guarantee — models drift to English,
 * or to the language of the code they were shown, especially deep into a long
 * run. This is the deterministic check that turns "we asked nicely" into
 * something the pipeline can act on, and it is free: no model call, no network.
 *
 * Two mechanisms, because two kinds of language need them:
 *
 *  - **Script languages** (zh, ja, ru, hi) are decided by Unicode range. If the
 *    prose is meant to be Japanese and carries no kana or kanji, it is not
 *    Japanese. This is close to certain.
 *  - **Latin-script languages** (en, es, pt, de) share an alphabet, so they are
 *    decided by function words — the small, high-frequency words a sentence
 *    cannot avoid. This is a judgement, not a proof, and it is treated as one.
 *
 * The single most important rule here is that a verdict is only issued when
 * there is enough signal to justify one. A file card that reads
 * "`parseConfig` → `Config`" has no language at all; calling that "wrong
 * language" would be a false accusation that costs a retry and, worse, would
 * teach whoever reads the report to ignore it.
 */
import { NARRATE_LANGUAGES, type NarrateLang } from './model.js';

/** Unicode ranges that identify a language by script alone. */
const SCRIPTS: Partial<Record<NarrateLang, RegExp>> = {
  // CJK ideographs. Shared with Japanese, so the ja check runs first.
  zh: /[一-鿿㐀-䶿]/u,
  // Hiragana or katakana — present in any real Japanese sentence, and absent
  // from Chinese, which is what separates the two.
  ja: /[぀-ゟ゠-ヿ]/u,
  ru: /[Ѐ-ӿ]/u,
  hi: /[ऀ-ॿ]/u,
};

/**
 * Function words per Latin-script language. Deliberately words that carry no
 * meaning on their own: they are the ones a writer cannot route around, and
 * they rarely appear inside identifiers or code.
 */
const FUNCTION_WORDS: Partial<Record<NarrateLang, readonly string[]>> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'for', 'with', 'this', 'are', 'from', 'it', 'which'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'en', 'con', 'para', 'una', 'por', 'del', 'se', 'es'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'em', 'com', 'para', 'uma', 'por', 'do', 'da', 'é', 'não'],
  de: ['der', 'die', 'das', 'und', 'ist', 'für', 'mit', 'den', 'von', 'auf', 'ein', 'eine', 'nicht'],
};

/** Words that are ambiguous between two of our Latin languages, so they cannot decide. */
const AMBIGUOUS = new Set(['a', 'o', 'de', 'que', 'en', 'con', 'para', 'por', 'es', 'la', 'no', 'e']);

export interface LanguageVerdict {
  /** `true` = looks like the requested language, `false` = looks like something else. */
  ok: boolean;
  /**
   * `false` when the text carries too little natural language to judge — a
   * signature, a path, three identifiers. Callers must treat this as "no
   * opinion", never as a pass or a failure.
   */
  decided: boolean;
  /** The language it looks like instead, when one stands out. */
  looksLike?: NarrateLang;
  /** One line, for a log or a report. */
  detail: string;
}

/**
 * Strip everything that has no language: fenced and inline code, URLs, paths,
 * and bare identifiers. What is left is the prose the directive was about.
 */
export function proseOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\w.-]+\/[\w./-]+/g, ' ')
    .replace(/\b[A-Za-z_]+(?:[._][A-Za-z_]+)+\b/g, ' ')
    .replace(/\b[a-z]+[A-Z][A-Za-z]*\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How much of the text is punctuation that belongs to code rather than prose.
 * A signature or a type is not written in any language, and saying it is in the
 * wrong one is a false accusation that costs a retry and teaches the reader to
 * ignore the report.
 */
function codeRatio(text: string): number {
  if (text.length === 0) return 0;
  return (text.match(/[(){}[\]<>;=|&/\\]/g) ?? []).length / text.length;
}

/** Latin letters, ignoring the CJK/Cyrillic/Devanagari that the script test owns. */
function latinWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-zà-öø-ÿ]+/gu) ?? []).filter((w) => w.length > 0);
}

/**
 * Is `text` plausibly written in `lang`?
 *
 * Answers `decided: false` rather than guessing whenever the sample is too
 * small or too code-like to carry a language.
 */
export function checkLanguage(text: string, lang: NarrateLang): LanguageVerdict {
  const prose = proseOnly(text);
  const scripted = Object.entries(SCRIPTS) as Array<[NarrateLang, RegExp]>;

  // --- script languages ---------------------------------------------------
  if (SCRIPTS[lang]) {
    // Enough characters to be a sentence rather than a label.
    if (prose.replace(/[\s\p{P}]/gu, '').length < 12) {
      return { ok: true, decided: false, detail: 'too short to judge' };
    }
    // A bare signature survives `proseOnly` — it has spaces, so the identifier
    // patterns cannot claim all of it — and would then be reported as "not
    // Japanese", which is true and useless: it is not any language. Code
    // punctuation is the tell.
    if (codeRatio(prose) > 0.08) return { ok: true, decided: false, detail: 'reads as code, not prose' };
    // Japanese first: Chinese ideographs appear in Japanese too, so testing zh
    // before ja would call every Japanese sentence Chinese.
    if (lang === 'ja') {
      if (SCRIPTS.ja!.test(prose)) return { ok: true, decided: true, detail: 'kana present' };
      const zhOnly = SCRIPTS.zh!.test(prose);
      return {
        ok: false,
        decided: true,
        looksLike: zhOnly ? 'zh' : undefined,
        detail: zhOnly ? 'ideographs but no kana — reads as Chinese' : 'no Japanese script',
      };
    }
    if (SCRIPTS[lang]!.test(prose)) {
      // Chinese must not be satisfied by a Japanese sentence's kanji.
      if (lang === 'zh' && SCRIPTS.ja!.test(prose)) {
        return { ok: false, decided: true, looksLike: 'ja', detail: 'kana present — reads as Japanese' };
      }
      return { ok: true, decided: true, detail: 'expected script present' };
    }
    const other = scripted.find(([code, re]) => code !== lang && re.test(prose));
    return {
      ok: false,
      decided: true,
      looksLike: other?.[0],
      detail: other ? `wrong script — reads as ${other[0]}` : 'no text in the expected script',
    };
  }

  // --- Latin-script languages --------------------------------------------
  // Before counting function words, rule out the obvious: prose in a script
  // this language does not use. Without this a Japanese answer to an English
  // request scored "too few words to judge" and sailed through as no-opinion —
  // the single loudest failure the check exists to catch.
  const nonLatin = (prose.match(/[一-鿿㐀-䶿぀-ゟ゠-ヿЀ-ӿऀ-ॿ]/gu) ?? []).length;
  if (nonLatin >= 8) {
    const other = scripted.find(([, re]) => re.test(prose));
    // Kana beats ideographs: a Japanese sentence contains both.
    const looksLike = SCRIPTS.ja!.test(prose) ? 'ja' : other?.[0];
    return {
      ok: false,
      decided: true,
      looksLike,
      detail: looksLike
        ? `written in a non-Latin script — reads as ${looksLike}`
        : 'written in a non-Latin script',
    };
  }

  const words = latinWords(prose);
  // Function-word frequency needs a sample. Under ~25 words the counts are
  // noise, and a wrong verdict is more expensive than no verdict.
  if (words.length < 25) return { ok: true, decided: false, detail: 'too few words to judge' };

  const score = (candidate: NarrateLang): number => {
    const list = FUNCTION_WORDS[candidate] ?? [];
    let hits = 0;
    for (const word of words) {
      if (!list.includes(word)) continue;
      // An ambiguous word counts for less than a decisive one.
      hits += AMBIGUOUS.has(word) ? 0.35 : 1;
    }
    return hits / words.length;
  };

  const ranked = (['en', 'es', 'pt', 'de'] as NarrateLang[])
    .map((code) => ({ code, score: score(code) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const mine = ranked.find((r) => r.code === lang)!;

  // No language scores meaningfully: the text is names and numbers, not prose.
  if (best.score < 0.02) return { ok: true, decided: false, detail: 'no function-word signal' };
  // A near-tie between two Latin languages is not evidence of an error.
  // Spanish and Portuguese in particular share most of this vocabulary.
  if (best.code !== lang && best.score - mine.score < 0.02) {
    return { ok: true, decided: false, detail: `ambiguous between ${best.code} and ${lang}` };
  }
  if (best.code === lang) return { ok: true, decided: true, detail: 'function words match' };
  return {
    ok: false,
    decided: true,
    looksLike: best.code,
    detail: `function words read as ${best.code}, not ${lang}`,
  };
}

/** The English name of a language, for a message a person will read. */
export function languageName(lang: NarrateLang): string {
  return NARRATE_LANGUAGES.find((l) => l.code === lang)?.english ?? lang;
}
