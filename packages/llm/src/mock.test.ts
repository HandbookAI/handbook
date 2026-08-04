import { describe, expect, it } from 'vitest';
import { MockChatClient } from './mock.js';

describe('MockChatClient', () => {
  it('matches deterministically with a global-flag regex (lastIndex must not leak)', async () => {
    // A /…/g (or sticky /…/y) matcher carries mutable `lastIndex`; calling
    // `.test()` on it advances that cursor, so identical prompts alternated
    // between match and miss. A mock that is documented as deterministic must
    // return the same answer for the same prompt every time.
    const mock = new MockChatClient([{ match: /Proposal/g, respond: 'matched' }], 'fallback');
    const prompt = 'Proposal under review';
    const texts = [
      (await mock.complete(prompt)).text,
      (await mock.complete(prompt)).text,
      (await mock.complete(prompt)).text,
    ];
    expect(texts).toEqual(['matched', 'matched', 'matched']);
  });

  it('matches deterministically with a sticky-flag regex', async () => {
    const mock = new MockChatClient([{ match: /needle/y, respond: 'hit' }], 'miss');
    const prompt = 'needle here';
    expect((await mock.complete(prompt)).text).toBe('hit');
    expect((await mock.complete(prompt)).text).toBe('hit');
  });

  it('uses the first matching rule, then the fallback, then throws', async () => {
    const mock = new MockChatClient(
      [
        { match: 'alpha', respond: 'A' },
        { match: /beta/, respond: 'B' },
        { match: (p) => p.startsWith('pred'), respond: 'P' },
      ],
      'FB',
    );
    expect((await mock.complete('has alpha')).text).toBe('A');
    expect((await mock.complete('has beta')).text).toBe('B');
    expect((await mock.complete('predicate')).text).toBe('P');
    expect((await mock.complete('nothing here')).text).toBe('FB');

    const noFallback = new MockChatClient([{ match: 'x', respond: 'X' }]);
    await expect(noFallback.complete('unmatched prompt')).rejects.toThrow(/no rule matched/);
  });

  it('serializes object responses into a json fence and extracts them, and records calls', async () => {
    let seen = -1;
    const mock = new MockChatClient([
      { match: 'obj', respond: { a: 1 } },
      {
        match: 'fn',
        respond: (prompt, callIndex) => {
          seen = callIndex;
          return `idx:${callIndex}:${prompt}`;
        },
      },
    ]);
    const objResult = await mock.complete('obj please', { temperature: 0.4 });
    expect(objResult.json).toEqual({ a: 1 });
    expect(objResult.text).toContain('```json');

    const fnResult = await mock.complete('fn call');
    expect(seen).toBe(1); // callIndex is the number of prior recorded calls
    expect(fnResult.text).toBe('idx:1:fn call');

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.options).toEqual({ temperature: 0.4 });
    expect(mock.calls[1]?.prompt).toBe('fn call');
  });
});
