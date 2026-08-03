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
