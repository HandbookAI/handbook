import { describe, expect, it } from 'vitest';
import { resolveOrThrow } from './resolve-config.js';

describe('resolveOrThrow', () => {
  it('reads the environment at call time, not at module load', () => {
    // This is the whole point: --env-file is applied in a preAction hook, so a
    // value captured earlier than this call would silently lose to the shell.
    process.env.HANDBOOK_GENERATE_LLM_MODEL = 'set-after-import';
    try {
      expect(resolveOrThrow('generate', { source: '/s', work: '/w' }).llmModel).toBe('set-after-import');
    } finally {
      delete process.env.HANDBOOK_GENERATE_LLM_MODEL;
    }
  });

  it('throws one error listing every problem', () => {
    // Two problems here (missing --source/--work, plus a bad READ_WORKERS
    // value), and both must show up in the single thrown message.
    // `settingsFor('generate')` visits `source`/`work` before `readWorkers`,
    // so the "required" errors sort first — the regex follows that true order
    // rather than the reverse.
    process.env.HANDBOOK_GENERATE_READ_WORKERS = 'twelve';
    try {
      expect(() => resolveOrThrow('generate', {})).toThrow(/source is required[\s\S]*READ_WORKERS/);
    } finally {
      delete process.env.HANDBOOK_GENERATE_READ_WORKERS;
    }
  });
});
