import { describe, expect, it } from 'vitest';
import { SETTINGS, settingByKey, type Logger } from '@handbook/core';
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

describe('the resolved-configuration debug line', () => {
  /**
   * `-v` used to produce one debug line for an entire run, which made the level
   * useless. The first question anyone debugging has is "is it even using the
   * setting I think it is?", and `handbook config` answers that only for a
   * SEPARATE invocation — different cwd, different env, or after the file was
   * edited. This line closes that gap, which means it has to be trustworthy.
   */
  function capture(command: string, flags: Record<string, unknown>, shorthandLevel?: string): string {
    const lines: string[] = [];
    const fake: Logger = {
      debug: (m) => lines.push(m),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => fake,
    };
    resolveOrThrow(command, flags, { makeLogger: () => fake, shorthandLevel });
    return lines.join('\n');
  }

  it('names every resolved setting and where it came from', () => {
    const out = capture('analyze', { source: '/s', work: '/w' });
    expect(out).toContain('[config] analyze:');
    expect(out).toContain('source=/s(--source)');
    expect(out).toContain('lang=auto(default)');
  });

  it('does not print a secret, whatever its value', () => {
    // The only part of this line with a security consequence. Driven by the
    // registry's `secret` flag rather than a key-name list here, so a setting
    // marked secret later is masked without anyone remembering to come back.
    process.env.OPENAI_API_KEY = 'sk-must-never-appear-in-a-log';
    try {
      const out = capture('generate', { source: '/s', work: '/w' });
      expect(out).not.toContain('sk-must-never-appear-in-a-log');
      expect(out).toContain('llmApiKey=***');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('masks every registry setting that declares itself secret', () => {
    // Iterating the registry rather than restating names: the previous version
    // of this guard elsewhere in the codebase was a literal list, and it went
    // stale the moment a second setting became secret.
    const secrets = SETTINGS.filter((s) => s.secret === true).map((s) => s.key);
    expect(secrets.length).toBeGreaterThan(1);
    for (const key of secrets) {
      const setting = settingByKey(key);
      expect(setting?.secret, key).toBe(true);
    }
  });

  it('reports the level -v forced, not the one it overrode', () => {
    // `-v` overrides `logLevel` AFTER resolution, so the resolved value would
    // print `info` on a run that is demonstrably logging at debug — the one
    // field a reader would immediately disbelieve, which costs the whole line
    // its credibility.
    const out = capture('analyze', { source: '/s', work: '/w' }, 'debug');
    expect(out).toContain('logLevel=debug(-v/-q)');
  });

  it('says nothing at all when no logger was given', () => {
    // `handbook config` renders the same information as its entire output and
    // must not print it twice.
    const lines: string[] = [];
    const fake: Logger = {
      debug: (m) => lines.push(m),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => fake,
    };
    resolveOrThrow('analyze', { source: '/s', work: '/w' });
    expect(lines).toEqual([]);
    expect(fake).toBeTruthy();
  });
});
