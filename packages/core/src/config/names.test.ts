import { describe, expect, it } from 'vitest';
import { envName, scopedEnvName, fileKeyCandidates, joinKey, nearestKey } from './names.js';
import type { Setting } from './types.js';

const setting = (over: Partial<Setting> = {}): Setting => ({
  key: 'readWorkers',
  type: 'int',
  commands: ['generate'],
  doc: 'concurrent card batches',
  ...over,
});

describe('envName', () => {
  it('screaming-snakes a camelCase key under the HANDBOOK_ prefix', () => {
    expect(envName('readWorkers')).toBe('HANDBOOK_READ_WORKERS');
    expect(envName('detail')).toBe('HANDBOOK_DETAIL');
  });

  it('keeps consecutive capitals readable in the compound LLM keys', () => {
    // HANDBOOK_LLM_MODEL and HANDBOOK_LLM_BASE_URL already exist as aliases in
    // client.ts — the transformation must land on exactly those names.
    expect(envName('llmModel')).toBe('HANDBOOK_LLM_MODEL');
    expect(envName('llmBaseUrl')).toBe('HANDBOOK_LLM_BASE_URL');
    expect(envName('llmApiKey')).toBe('HANDBOOK_LLM_API_KEY');
    expect(envName('htmlSingle')).toBe('HANDBOOK_HTML_SINGLE');
  });
});

describe('scopedEnvName', () => {
  it('inserts the command between the prefix and the key', () => {
    expect(scopedEnvName('generate', 'readWorkers')).toBe('HANDBOOK_GENERATE_READ_WORKERS');
    expect(scopedEnvName('render', 'out')).toBe('HANDBOOK_RENDER_OUT');
  });
});

describe('fileKeyCandidates', () => {
  it('prefers the command-scoped flat key over the bare one', () => {
    expect(fileKeyCandidates('generate', setting())).toEqual(['generateReadWorkers', 'readWorkers']);
  });

  it('omits the bare key for scopedOnly settings', () => {
    // `--out` means three different things across render/skill/plan, so a bare
    // `out:` in the config file would be a footgun rather than a convenience.
    expect(fileKeyCandidates('render', setting({ key: 'out', scopedOnly: true }))).toEqual(['renderOut']);
  });
});

describe('joinKey', () => {
  it('camel-joins a prefix onto a key, and leaves an unprefixed key alone', () => {
    expect(joinKey('generate', 'readWorkers')).toBe('generateReadWorkers');
    expect(joinKey('', 'readWorkers')).toBe('readWorkers');
  });
});

describe('nearestKey', () => {
  const known = ['readWorkers', 'readBatchSize', 'generateReadWorkers', 'llmBaseUrl', 'logLevel'];

  it('finds the key a one-character typo meant', () => {
    expect(nearestKey('generateReadWorker', known)).toBe('generateReadWorkers');
    expect(nearestKey('logLevl', known)).toBe('logLevel');
  });

  it('folds case, so a capitalisation slip is zero edits away', () => {
    expect(nearestKey('llmbaseurl', known)).toBe('llmBaseUrl');
  });

  it('suggests nothing when nothing is close, rather than the least wrong candidate', () => {
    // A confident wrong suggestion sends the reader off to rewrite a key they
    // never meant — worse than saying nothing.
    expect(nearestKey('somethingEntirelyElse', known)).toBeUndefined();
    expect(nearestKey('out', known)).toBeUndefined();
  });

  it('returns nothing for an empty candidate list', () => {
    expect(nearestKey('readWorkers', [])).toBeUndefined();
  });
});
