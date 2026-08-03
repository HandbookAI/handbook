import { describe, expect, it } from 'vitest';
import { describeJsonShape, extractEntryList, replyExcerpt } from './reply-shape.js';

describe('extractEntryList', () => {
  const keys = ['assignments'];

  it('reads the requested container', () => {
    expect(extractEntryList({ assignments: [{ file: 'a.ts' }] }, keys)).toEqual([{ file: 'a.ts' }]);
  });

  it('accepts a bare array', () => {
    expect(extractEntryList([{ file: 'a.ts' }], keys)).toEqual([{ file: 'a.ts' }]);
  });

  it('accepts an alternative container name', () => {
    expect(extractEntryList({ files: [{ file: 'a.ts' }] }, ['assignments', 'files'])).toEqual([{ file: 'a.ts' }]);
  });

  it('accepts a generic container the caller never asked for', () => {
    expect(extractEntryList({ results: [{ file: 'a.ts' }] }, keys)).toEqual([{ file: 'a.ts' }]);
  });

  it('unwraps one level of nesting', () => {
    expect(extractEntryList({ result: { assignments: [{ file: 'a.ts' }] } }, keys)).toEqual([{ file: 'a.ts' }]);
  });

  it('accepts a lone object only when it carries an expected field', () => {
    const single = { single: { fields: ['stage'] } };
    expect(extractEntryList({ stage: 'x' }, keys, single)).toEqual([{ stage: 'x' }]);
    expect(extractEntryList({ unrelated: 1 }, keys, single)).toEqual([]);
    expect(extractEntryList({ stage: 'x' }, keys)).toEqual([]); // opt-in only
  });

  it('drops non-objects inside the list and never invents entries', () => {
    expect(extractEntryList({ assignments: ['nope', 3, null, { file: 'a.ts' }] }, keys)).toEqual([{ file: 'a.ts' }]);
    expect(extractEntryList('a string', keys)).toEqual([]);
    expect(extractEntryList(undefined, keys)).toEqual([]);
  });
});

describe('describeJsonShape', () => {
  it('names what actually arrived', () => {
    expect(describeJsonShape(undefined)).toMatch(/no JSON block/);
    expect(describeJsonShape([1, 2])).toBe('top-level array of 2');
    expect(describeJsonShape({ a: 1, b: 2 })).toBe('keys: a, b');
    expect(describeJsonShape(7)).toBe('top-level number');
  });
});

describe('replyExcerpt', () => {
  it('collapses whitespace and bounds the length', () => {
    expect(replyExcerpt('  a\n\n  b  ')).toBe('"a b"');
    expect(replyExcerpt('x'.repeat(500)).length).toBe(202);
  });
});
