import { describe, expect, it } from 'vitest';
import type { ChatClient, ChatResult } from './client.js';
import { LanguageReport, completeInLanguage } from './lang-guard.js';

const JA =
  'このステージはシステムの受付です。生のコマンドラインを受け取り、他の部分が安全に利用できる構造化された設定に変換します。';
const EN =
  'This stage is the front desk of the system. It takes the raw command line and turns it into a structured configuration the rest of the application can use safely.';
const CODE = 'export async function loadAll(root: string): Promise<Source[]>';

/** A client that answers with each reply in turn, and counts its calls. */
function scripted(replies: string[]): ChatClient & { calls: () => number } {
  let i = 0;
  let calls = 0;
  return {
    model: 'test',
    complete: async (): Promise<ChatResult> => {
      calls += 1;
      return { text: replies[Math.min(i++, replies.length - 1)] as string, json: undefined, elapsedSec: 0 };
    },
    calls: () => calls,
  };
}

function collectingLogger(): { lines: string[]; logger: Parameters<typeof completeInLanguage>[3]['logger'] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: () => {},
    debug: () => {},
    child: () => logger,
  };
  return { lines, logger };
}

describe('completeInLanguage — layer 2: detect', () => {
  it('costs exactly one call when the answer is already right', async () => {
    const client = scripted([JA]);
    const report = new LanguageReport();
    await completeInLanguage(client, 'p', 'ja', { where: 'stage-1', report });
    expect(client.calls()).toBe(1);
    expect(report.lapses).toEqual([]);
  });

  it('never accuses text that carries no language, and never retries it', async () => {
    // A signature is not in the wrong language; it is in no language. Spending
    // a retry on it costs money and teaches the report to be ignored.
    const client = scripted([CODE]);
    const report = new LanguageReport();
    await completeInLanguage(client, 'p', 'ja', { where: 'sig', report });
    expect(client.calls()).toBe(1);
    expect(report.lapses).toEqual([]);
  });
});

describe('completeInLanguage — layer 3: correct once', () => {
  it('retries a wrong answer exactly once and takes the fix', async () => {
    const client = scripted([EN, JA]);
    const report = new LanguageReport();
    const { lines, logger } = collectingLogger();
    const result = await completeInLanguage(client, 'p', 'ja', { where: 'stage-2', report, logger });
    expect(result.text).toBe(JA);
    expect(client.calls()).toBe(2);
    // A run that self-corrected is not a lapse — nothing shipped in the wrong language.
    expect(report.lapses).toEqual([]);
    expect(lines.some((l) => l.includes('retrying once'))).toBe(true);
  });

  it('does not retry when retries are switched off, but still reports', async () => {
    const client = scripted([EN]);
    const report = new LanguageReport();
    await completeInLanguage(client, 'p', 'ja', { where: 'x', report, retry: false });
    expect(client.calls()).toBe(1);
    expect(report.lapses).toHaveLength(1);
    expect(report.lapses[0]?.retried).toBe(false);
  });
});

describe('completeInLanguage — layer 4: disclose, never drop and never hide', () => {
  it('keeps prose that stayed wrong, and records it', async () => {
    const client = scripted([EN, EN]);
    const report = new LanguageReport();
    const result = await completeInLanguage(client, 'p', 'ja', { where: 'stage-3', report });
    // Dropping it would lose content that is merely in the wrong language.
    expect(result.text).toBe(EN);
    expect(client.calls()).toBe(2);
    expect(report.lapses).toHaveLength(1);
    expect(report.lapses[0]).toMatchObject({ where: 'stage-3', wanted: 'ja', retried: true });
    // And the run says so out loud rather than shipping quietly.
    expect(report.summary()).toMatch(/wrong language/);
  });

  it('says nothing when there is nothing to say', () => {
    expect(new LanguageReport().summary()).toBe('');
  });
});

describe('completeInLanguage — judging the prose, not the envelope', () => {
  it('uses pickText so JSON key names cannot pass for prose', async () => {
    const payload = { id: 'stage-1', summary: JA };
    const client: ChatClient = {
      model: 'test',
      complete: async () => ({ text: JSON.stringify(payload), json: payload, elapsedSec: 0 }),
    };
    const report = new LanguageReport();
    await completeInLanguage(client, 'p', 'ja', {
      where: 'y',
      report,
      pickText: (r) => String((r.json as { summary?: string })?.summary ?? ''),
    });
    expect(report.lapses).toEqual([]);
  });
});
