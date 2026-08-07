import { describe, expect, it } from 'vitest';
import { ConfigError, coerceValue } from './coerce.js';
import type { Setting } from './types.js';

const s = (over: Partial<Setting>): Setting => ({
  key: 'x',
  type: 'string',
  commands: ['generate'],
  doc: 'd',
  ...over,
});

describe('coerceValue: int', () => {
  const n = s({ key: 'readWorkers', type: 'int', min: 1 });

  it('accepts integers, whitespace padding and exponent notation', () => {
    expect(coerceValue(n, '12', 'flag --read-workers')).toBe(12);
    expect(coerceValue(n, '  3  ', 'flag --read-workers')).toBe(3);
    expect(coerceValue(n, '1e9', 'flag --read-workers')).toBe(1_000_000_000);
  });

  it('truncates fractional values toward zero (documented contract)', () => {
    expect(coerceValue(n, '3.9', 'flag --read-workers')).toBe(3);
  });

  it('rejects garbage loudly and names the source', () => {
    // Regression: HANDBOOK_READ_WORKERS=twelve silently running at the default
    // is the hour-wasting failure this replaces.
    expect(() => coerceValue(n, 'twelve', 'env HANDBOOK_READ_WORKERS')).toThrow(
      /env HANDBOOK_READ_WORKERS: readWorkers must be an integer >= 1, got "twelve"/,
    );
    for (const bad of ['NaN', 'Infinity', '1_000', '٣', '', '   ', '-0', '0']) {
      expect(() => coerceValue(n, bad, 'env HANDBOOK_READ_WORKERS')).toThrow(ConfigError);
    }
  });

  it('honours min 0 for the retry count, where 0 is meaningful', () => {
    expect(coerceValue(s({ key: 'llmMaxRetries', type: 'int', min: 0 }), '0', 'x')).toBe(0);
  });
});

describe('coerceValue: bool', () => {
  const b = s({ key: 'resume', type: 'bool' });

  it('accepts the four truthy and four falsey spellings, case-insensitively', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) expect(coerceValue(b, raw, 'x')).toBe(true);
    for (const raw of ['0', 'false', 'No', 'off']) expect(coerceValue(b, raw, 'x')).toBe(false);
  });

  it('passes a real boolean through (commander gives booleans, not strings)', () => {
    expect(coerceValue(b, true, 'flag --resume')).toBe(true);
    expect(coerceValue(b, false, 'flag --no-llm')).toBe(false);
  });

  it('rejects anything else loudly', () => {
    expect(() => coerceValue(b, 'maybe', 'env HANDBOOK_RESUME')).toThrow(
      /env HANDBOOK_RESUME: resume must be one of 1\|true\|yes\|on or 0\|false\|no\|off/,
    );
  });
});

describe('coerceValue: enum', () => {
  const e = s({ key: 'narrateLang', type: 'enum', choices: ['en', 'zh'] });

  it('accepts a listed value', () => {
    expect(coerceValue(e, 'zh', 'x')).toBe('zh');
  });

  it('rejects a near-miss loudly instead of silently narrating in English', () => {
    // Regression: `--narrate-lang cn` (a typo for zh) must not quietly produce
    // English prose.
    expect(() => coerceValue(e, 'cn', 'flag --narrate-lang')).toThrow(
      'flag --narrate-lang: narrateLang must be one of en | zh, got "cn"',
    );
    expect(() => coerceValue(e, '', 'x')).toThrow(ConfigError);
  });
});

describe('coerceValue: json', () => {
  const j = s({ key: 'llmExtraBody', type: 'json' });

  it('parses a JSON object', () => {
    expect(coerceValue(j, '{"thinking":{"type":"disabled"}}', 'x')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('rejects malformed JSON and non-objects loudly', () => {
    // Changed behaviour: parseExtraBody used to swallow both silently, so a
    // trailing comma meant the vendor field was never sent and nothing said so.
    expect(() => coerceValue(j, '{bad}', 'env OPENAI_EXTRA_BODY')).toThrow(
      /env OPENAI_EXTRA_BODY: llmExtraBody must be valid JSON/,
    );
    expect(() => coerceValue(j, '[1,2]', 'x')).toThrow(/must be a JSON object/);
    expect(() => coerceValue(j, 'null', 'x')).toThrow(/must be a JSON object/);
  });
});

describe('coerceValue: path', () => {
  const p = s({ key: 'work', type: 'path' });

  it('resolves a relative path against the supplied base', () => {
    expect(coerceValue(p, './out', 'x', '/repo')).toBe('/repo/out');
  });

  it('leaves an absolute path alone', () => {
    expect(coerceValue(p, '/tmp/w', 'x', '/repo')).toBe('/tmp/w');
  });

  it('rejects an empty path loudly', () => {
    expect(() => coerceValue(p, '   ', 'env HANDBOOK_WORK', '/repo')).toThrow(
      /env HANDBOOK_WORK: work must not be empty/,
    );
  });
});
