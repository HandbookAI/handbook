import { describe, expect, it } from 'vitest';
import { extractJsonBlock, repairJson } from './json-extract.js';

describe('extractJsonBlock', () => {
  it('parses a fenced json block', () => {
    const text = 'Here you go:\n```json\n{"a": 1}\n```\nthanks';
    expect(extractJsonBlock(text)).toEqual({ a: 1 });
  });

  it('parses a bare fenced block', () => {
    expect(extractJsonBlock('```\n[1, 2]\n```')).toEqual([1, 2]);
  });

  it('skips unparseable fences and uses the next one', () => {
    const text = '```json\n{oops\n```\n```json\n{"ok": true}\n```';
    expect(extractJsonBlock(text)).toEqual({ ok: true });
  });

  it('falls back to a balanced-brace scan', () => {
    expect(extractJsonBlock('noise {"x": {"y": "}"}} trailing')).toEqual({ x: { y: '}' } });
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonBlock('{"s": "a \\" b"}')).toEqual({ s: 'a " b' });
  });

  it('advances past false openers', () => {
    expect(extractJsonBlock('{not json} then {"real": 1}')).toEqual({ real: 1 });
  });

  it('returns undefined when nothing parses', () => {
    expect(extractJsonBlock('no json here')).toBeUndefined();
  });
});

describe('extractJsonBlock — fence regressions (round-1 review)', () => {
  it('skips non-json fences without misaligning onto the next fence', () => {
    const text = 'Look:\n```python\nx = [1, 2]\n```\nverdict:\n```json\n{"decision": "APPROVE"}\n```';
    expect(extractJsonBlock(text)).toEqual({ decision: 'APPROVE' });
  });

  it('still accepts untagged fences', () => {
    expect(extractJsonBlock('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
});

describe('extractJsonBlock — info strings and meta-fences (round-2 review)', () => {
  it('consumes fences with info strings without misaligning', () => {
    const text = '```python title=x\n[9, 9]\n```\nthen\n```json\n{"want": true}\n```';
    expect(extractJsonBlock(text)).toEqual({ want: true });
  });

  it('keeps inner example fences of a four-backtick block literal', () => {
    const text = '````md\nexample:\n```json\n{"inner": true}\n```\n````\nreal:\n```json\n{"outer": true}\n```';
    expect(extractJsonBlock(text)).toEqual({ outer: true });
  });
});

describe('repairJson', () => {
  it('escapes an unescaped quote inside prose', () => {
    expect(repairJson('{"a": "he said "hi" loudly"}')).toEqual({ a: 'he said "hi" loudly' });
  });

  it('handles the Chinese-prose case that broke real replies', () => {
    const raw = '{"purpose": "把被测对象拿来"考一遍"。", "role": "test"}';
    expect(repairJson(raw)).toEqual({ purpose: '把被测对象拿来"考一遍"。', role: 'test' });
  });

  it('escapes raw newlines inside strings', () => {
    expect(repairJson('{"a": "one\ntwo"}')).toEqual({ a: 'one\ntwo' });
  });

  it('leaves valid JSON alone and refuses structural guesses', () => {
    expect(repairJson('{"a": 1}')).toEqual({ a: 1 });
    expect(repairJson('{"a": ')).toBeUndefined();
    expect(repairJson('not json at all')).toBeUndefined();
  });
});

describe('extractJsonBlock precedence', () => {
  it('prefers a REPAIRED fenced block over a parseable nested fragment', () => {
    // The fence is the declared answer but has a stray quote; the nested
    // `functions` object parses on its own and must not win.
    const reply = [
      '```json',
      '{',
      '  "purpose": "测试 "考一遍" 的行为",',
      '  "functions": {"parseVerdict": {"purpose": "解析裁决"}}',
      '}',
      '```',
    ].join('\n');
    const result = extractJsonBlock(reply) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['purpose', 'functions']);
  });

  it('still prefers a cleanly parsing fence over repair', () => {
    expect(extractJsonBlock('```json\n{"ok": true}\n```')).toEqual({ ok: true });
  });
});

describe('repairJson backtracking (review R1 F2/F8)', () => {
  /** Serialise the intended value, then un-escape the quotes a model forgets. */
  const wire = (value: unknown): string => JSON.stringify(value, null, 2).replace(/\\"/g, '"');

  const prose = [
    'the "config" file',
    'supports "list", "map" and "filter"',
    'she said "no", then left',
    'a "queue": a waiting line',
    '"main" is where it starts',
    'reads "cfg", writes state',
    '解析 "配置" 文件，然后写回',
    'ends with a "quote"',
  ];

  it.each(prose)('recovers an unescaped quote in prose: %s', (text) => {
    const intended = { purposes: [{ file: 'a.ts', purpose: text, role: 'util' }] };
    expect(repairJson(wire(intended))).toEqual(intended);
  });

  it('recovers a quoted term inside an array element without splitting it', () => {
    const intended = { also: ['sets "mode" to "on", "off"', 'stage-2'] };
    expect(repairJson(wire(intended))).toEqual(intended);
  });

  it('never invents structure: truncated input stays a failure', () => {
    expect(repairJson('{"a": "unterminated')).toBeUndefined();
    expect(repairJson('{"a": 1')).toBeUndefined();
    expect(repairJson('[1, 2')).toBeUndefined();
    expect(repairJson('{"a": [1,,2]}')).toBeUndefined(); // a hole is not repairable
  });

  it('accepts a trailing comma — unambiguous, so it costs nothing', () => {
    expect(repairJson('{"a": 1,}')).toEqual({ a: 1 });
    expect(repairJson('[1, 2,]')).toEqual([1, 2]);
  });

  it('leaves ordinary documents exactly as JSON.parse would', () => {
    for (const text of ['{"a":"plain"}', '["a", "b"]', '{"n":-1.5e3,"t":true,"z":null}', '{"u":"\\u4e2d"}']) {
      expect(repairJson(text)).toEqual(JSON.parse(text));
    }
  });

  it('is bounded on adversarial input', () => {
    // 400 ambiguous quotes: exponential backtracking would hang. Whatever it
    // decides, it must decide fast.
    const started = Date.now();
    repairJson(`{"a": "${'" '.repeat(400)}"}`);
    repairJson(`[${'"a" '.repeat(300)}]`);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('extractJsonBlock never returns a nested fragment (review R1 F1/F4)', () => {
  it('repairs the declared fence instead of scanning inside it', () => {
    const reply = [
      '```json',
      '{"purposes": [{"file": "app/queue.py", "purpose": "Holds waiting work.",',
      '  "description": "A "queue": a waiting line.",',
      '  "functions": [{"qualname": "Queue.push", "purpose": "Adds a job."}],',
      '  "role": "data_model"}]}',
      '```',
    ].join('\n');
    const result = extractJsonBlock(reply) as { purposes: Array<Record<string, unknown>> };
    expect(Object.keys(result)).toEqual(['purposes']);
    expect(result.purposes[0]?.description).toBe('A "queue": a waiting line.');
  });

  it('reports failure rather than a fragment when a fence cannot be repaired', () => {
    // Truncated mid-structure: the nested object parses on its own, and returning
    // it would let a function note masquerade as the answer.
    const reply = ['```json', '{"purposes": [{"file": "a.ts", "functions": [{"qualname": "f"}]', '```'].join('\n');
    expect(extractJsonBlock(reply)).toBeUndefined();
  });
});

describe('extractJsonBlock — algorithmic-complexity hardening (adversarial pass 2)', () => {
  const under = (ms: number, fn: () => void): void => {
    const t0 = performance.now();
    fn();
    expect(performance.now() - t0).toBeLessThan(ms);
  };

  it('a long run of unbalanced openers scans in ~linear time (was O(n²))', () => {
    // A code-heavy reply full of `{`/`[` with no matching closers used to make the
    // per-opener rescan take seconds; the string-aware single pass keeps it bounded.
    under(200, () => expect(extractJsonBlock('{'.repeat(50000))).toBeUndefined());
    under(200, () => expect(extractJsonBlock('['.repeat(50000))).toBeUndefined());
    under(200, () => expect(extractJsonBlock('{"'.repeat(50000))).toBeUndefined());
  });

  it('still finds the object after a run of false openers', () => {
    expect(extractJsonBlock('{{{{{ noise {"real": 1}')).toEqual({ real: 1 });
  });

  it('many opener-like fence lines with no valid closer stay bounded (was O(n²))', () => {
    let s = '';
    for (let i = 0; i < 20000; i++) s += '`'.repeat((i % 6) + 3) + 'json\n';
    under(200, () => extractJsonBlock(s));
  });

  it('a 1MB+ reply resolves quickly', () => {
    under(500, () => expect(extractJsonBlock('x'.repeat(1_100_000) + ' {"ok":true}')).toEqual({ ok: true }));
  });
});

describe('repairJson — regressions (adversarial pass 2)', () => {
  it('does not corrupt valid JSON that holds escaped quotes in several strings', () => {
    // The backtracker used to also read a properly-escaped closing quote as prose
    // and, via the odd-quote tiebreak, merge two values into one.
    const json = '{"a":"b\\"c","d":"e\\"f"}';
    expect(repairJson(json)).toEqual({ a: 'b"c', d: 'e"f' });
    expect(repairJson(json)).toEqual(JSON.parse(json));
  });

  it('gives up gracefully (no RangeError) on an enormous broken structure', () => {
    const wide = `[${Array.from({ length: 20000 }, (_, i) => `{"i":${i}}`).join(',')},{"s":"a "b" c"}]`;
    const deep = '['.repeat(6000) + '1' + ']'.repeat(6000) + ',]';
    expect(() => repairJson(wide)).not.toThrow();
    expect(() => repairJson(deep)).not.toThrow();
  });

  it('still repairs realistic-width lists below the stack limit', () => {
    const body = Array.from({ length: 400 }, (_, i) => `{"i":${i}}`).join(',');
    const out = repairJson(`[${body},]`) as unknown[];
    expect(out).toHaveLength(400);
  });
});
