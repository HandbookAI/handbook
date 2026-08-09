/**
 * Keeping generated prose in the language that was asked for.
 *
 * A directive in the prompt is layer one, and it is not enough on its own:
 * models drift to English, or to the language of the code they were just shown,
 * and they do it more often deep into a long run than in the first few calls.
 * So the request is followed by three more layers:
 *
 *   2. **Detect.** `checkLanguage` reads the answer and says whether it is in
 *      the requested language. Deterministic, free, and — importantly — allowed
 *      to say "no opinion" when the text is a path or a signature.
 *   3. **Correct once.** A single retry that shows the model what it produced
 *      and names the language again. One, not many: a model that ignored two
 *      explicit instructions will usually ignore the third, and every retry is
 *      real money and latency.
 *   4. **Disclose.** If it still comes back wrong, the text is KEPT and the
 *      failure is recorded. Dropping it would lose content that is merely in
 *      the wrong language; silently shipping it would tell a Japanese reader
 *      that this is what the tool produces. The run reports it instead.
 *
 * The fourth layer is the one that matters most. Everything else is an attempt;
 * this is the promise: the output never claims a language it did not deliver.
 */
import { checkLanguage, languageName, type Logger, type NarrateLang } from '@handbook/core';
import type { ChatClient, ChatOptions, ChatResult } from './client.js';

/** One wrong-language answer that survived the retry. */
export interface LanguageLapse {
  /** What was being written — a stage id, a file path, `system-overview`. */
  where: string;
  /** The language that was asked for. */
  wanted: NarrateLang;
  /** What it looked like instead, when the detector could name one. */
  gotLanguage?: NarrateLang;
  /** The detector's one-line reason. */
  detail: string;
  /** Whether the retry was attempted (false when retries were disabled). */
  retried: boolean;
}

/** Collects lapses across a run so the pipeline can report them in one place. */
export class LanguageReport {
  private readonly entries: LanguageLapse[] = [];
  private checkedCount = 0;

  record(lapse: LanguageLapse): void {
    this.entries.push(lapse);
  }

  counted(): void {
    this.checkedCount += 1;
  }

  get lapses(): readonly LanguageLapse[] {
    return this.entries;
  }

  get checked(): number {
    return this.checkedCount;
  }

  /** A single line for the run log, or '' when there is nothing to say. */
  summary(): string {
    if (this.entries.length === 0) return '';
    const byLang = new Map<string, number>();
    for (const e of this.entries)
      byLang.set(e.gotLanguage ?? 'unknown', (byLang.get(e.gotLanguage ?? 'unknown') ?? 0) + 1);
    const breakdown = [...byLang].map(([lang, n]) => `${n}×${lang}`).join(', ');
    return `${this.entries.length}/${this.checkedCount} generated passage(s) came back in the wrong language after a retry (${breakdown}) — kept as produced, listed in the run manifest`;
  }
}

export interface LanguageGuardOptions {
  /** Where this text belongs, for the report: a stage id, a file path. */
  where: string;
  /** Set false to detect and report without spending a retry. */
  retry?: boolean;
  report?: LanguageReport;
  logger?: Logger;
}

/**
 * Ask for a completion, and make sure the prose comes back in `lang`.
 *
 * Returns whatever the model produced — never nothing. `pickText` exists
 * because some callers care about a field inside the JSON rather than the whole
 * reply: checking the raw envelope would test the key names, not the prose.
 */
export async function completeInLanguage(
  client: ChatClient,
  prompt: string,
  lang: NarrateLang,
  options: LanguageGuardOptions & { chat?: ChatOptions; pickText?: (result: ChatResult) => string },
): Promise<ChatResult> {
  const { where, report, logger, chat, pickText } = options;
  const retry = options.retry !== false;
  const first = await client.complete(prompt, chat);
  report?.counted();

  const proseOf = (result: ChatResult): string => (pickText ? pickText(result) : result.text);
  const verdict = checkLanguage(proseOf(first), lang);
  // No opinion is not a failure. The text may simply be a path or a signature.
  if (verdict.ok || !verdict.decided) return first;

  const name = languageName(lang);
  logger?.warn(`[lang] ${where}: expected ${name} — ${verdict.detail}${retry ? '; retrying once' : ''}`);
  if (!retry) {
    report?.record({
      where,
      wanted: lang,
      gotLanguage: verdict.looksLike,
      detail: verdict.detail,
      retried: false,
    });
    return first;
  }

  // Layer 3: ask it to TRANSLATE what it just produced, rather than re-sending
  // the original prompt with a correction appended.
  //
  // Measured against a real endpoint, appending a correction recovered 1 case
  // in 4. The reason is structural: the original prompt is still in the
  // message, and anything in it that biases the language — an instruction, an
  // English code sample, English field names — competes with the correction.
  // Re-deriving the answer is also the harder task, so the model has more room
  // to drift again.
  //
  // Translating a text that is already correct in substance removes the
  // conflict entirely and is a task models are reliably good at. The original
  // prompt is deliberately NOT included.
  const correction = [
    `Translate the text below into ${name}. Output ONLY the translation.`,
    '',
    'Rules:',
    `- Every sentence must be in ${name}.`,
    '- Keep the structure exactly: same JSON shape and key names if it is JSON, same markdown, same line breaks.',
    '- Do NOT translate: code, identifiers, file paths, URLs, flags, or field names.',
    '- Do not add a preface, a note, or quotes around the result.',
    '',
    '--- TEXT TO TRANSLATE ---',
    first.text,
    '--- END ---',
    '',
    `Output the ${name} version now.`,
  ].join('\n');
  const second = await client.complete(correction, chat);
  const secondVerdict = checkLanguage(proseOf(second), lang);
  if (secondVerdict.ok || !secondVerdict.decided) {
    logger?.info(`[lang] ${where}: retry produced ${name}`);
    return second;
  }

  // Layer 4: keep it, and say so. Never silently, never dropped.
  logger?.warn(`[lang] ${where}: still not ${name} after a retry — keeping the text and recording it`);
  report?.record({
    where,
    wanted: lang,
    gotLanguage: secondVerdict.looksLike,
    detail: secondVerdict.detail,
    retried: true,
  });
  return second;
}
