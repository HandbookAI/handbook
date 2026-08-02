import { describe, expect, it } from 'vitest';
import { extractJsonBlock } from './json-extract.js';

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
