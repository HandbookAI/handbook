/**
 * Choosing the rule block for a prose language.
 *
 * The prompts in this package come in hand-written English and Chinese pairs.
 * That does not scale to the eight languages the product now offers, and it
 * does not need to: a rule block is an instruction TO the model, never text a
 * reader sees, so it does not have to be translated at all. What must be
 * unambiguous is the language the ANSWER is written in.
 *
 * So English and Chinese keep the blocks they already had — proven, and the
 * only two anyone has reviewed — and every other language gets the English
 * block plus an explicit directive naming the target language. Adding a ninth
 * language is then one entry in `NARRATE_LANGUAGES`, not six new prompts.
 */
import { languageDirective, type NarrateLang } from '@handbook/core';

/**
 * The rules to send for `lang`, given the hand-written English and Chinese
 * blocks. The directive is appended for every non-English language — including
 * Chinese, whose block already asks for Chinese: saying it twice costs one line
 * and removes the chance that a future edit to the block drops the instruction.
 */
export function rulesFor(lang: NarrateLang, en: string, zh: string): string {
  if (lang === 'en') return en;
  const base = lang === 'zh' ? zh : en;
  return `${base}\n\n${languageDirective(lang)}`;
}

/**
 * A short instruction line in the target language, for the places a prompt ends
 * with "now write the answer". English and Chinese keep their existing wording;
 * everything else gets the generic directive, which names the language.
 */
export function closingLine(lang: NarrateLang, en: string, zh: string): string {
  if (lang === 'en') return en;
  if (lang === 'zh') return zh;
  return `${en} ${languageDirective(lang)}`;
}
