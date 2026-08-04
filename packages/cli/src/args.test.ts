import { describe, expect, it } from 'vitest';
import { parseEnum, toInt } from './args.js';

describe('toInt', () => {
  it('accepts plain integers and whitespace-padded numbers', () => {
    expect(toInt('12', '--n', 1)).toBe(12);
    expect(toInt('  3  ', '--n', 1)).toBe(3);
    expect(toInt('1e9', '--n', 1)).toBe(1_000_000_000);
  });

  it('truncates fractional values toward zero (documented contract)', () => {
    expect(toInt('3.9', '--n', 1)).toBe(3);
  });

  it('rejects NaN, Infinity, and non-numeric garbage loudly', () => {
    // Regression: garbage must fail loudly, never NaN a loop away.
    expect(() => toInt('NaN', '--read-workers', 1)).toThrow(/--read-workers must be a number >= 1/);
    expect(() => toInt('Infinity', '--n', 1)).toThrow(/must be a number/);
    expect(() => toInt('abc', '--n', 1)).toThrow(/must be a number/);
    expect(() => toInt('1_000', '--n', 1)).toThrow(/must be a number/);
    expect(() => toInt('٣', '--n', 1)).toThrow(/must be a number/); // non-ASCII digit
  });

  it('rejects the empty / whitespace-only string (Number("") is 0, below min 1)', () => {
    expect(() => toInt('', '--n', 1)).toThrow(/must be a number >= 1/);
    expect(() => toInt('   ', '--n', 1)).toThrow(/must be a number >= 1/);
  });

  it('rejects values below the minimum, including -0', () => {
    expect(() => toInt('-0', '--n', 1)).toThrow(/must be a number >= 1/);
    expect(() => toInt('0', '--n', 1)).toThrow(/must be a number >= 1/);
  });
});

describe('parseEnum', () => {
  it('returns a supplied value that is in the allowed set', () => {
    expect(parseEnum('zh', '--narrate-lang', ['en', 'zh'] as const)).toBe('zh');
    expect(parseEnum('brief', '--detail', ['brief', 'deep'] as const)).toBe('brief');
  });

  it('passes an unsupplied (undefined) flag through as undefined', () => {
    // Lets callers apply their own default / "use the recorded value" semantics.
    expect(parseEnum(undefined, '--strategy', ['file', 'member'] as const)).toBeUndefined();
  });

  it('throws a loud, actionable error for a supplied-but-invalid value', () => {
    // Regression: `--narrate-lang cn` (a typo for zh) used to be silently
    // coerced to English prose; it must now fail with the valid set listed.
    expect(() => parseEnum('cn', '--narrate-lang', ['en', 'zh'] as const)).toThrow(
      '--narrate-lang must be one of en | zh, got "cn"',
    );
    expect(() => parseEnum('doktor', '--synth-mode', ['oneshot', 'doctor'] as const)).toThrow(
      /--synth-mode must be one of oneshot \| doctor/,
    );
    expect(() => parseEnum('membr', '--strategy', ['file', 'member'] as const)).toThrow(
      /--strategy must be one of file \| member/,
    );
  });

  it('treats an explicitly empty value as invalid (not as "unset")', () => {
    expect(() => parseEnum('', '--detail', ['brief', 'deep'] as const)).toThrow(/must be one of brief \| deep/);
  });

  it('rejects non-string supplied values', () => {
    expect(() => parseEnum(true, '--detail', ['brief', 'deep'] as const)).toThrow(/must be one of/);
  });
});
