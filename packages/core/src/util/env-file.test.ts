import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnvFile, applyEnvFiles, parseEnvFile } from './env-file.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'hb-env-'));

describe('parseEnvFile', () => {
  it('parses plain, exported, quoted, and commented lines', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'OPENAI_API_KEY=sk-plain',
        'export OPENAI_MODEL=gpt-4o-mini',
        'OPENAI_BASE_URL="http://localhost:8000/v1"',
        "HANDBOOK_TITLE='My # Handbook'",
        'WORKERS=12 # inline comment',
        'not a valid line',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      OPENAI_API_KEY: 'sk-plain',
      OPENAI_MODEL: 'gpt-4o-mini',
      OPENAI_BASE_URL: 'http://localhost:8000/v1',
      HANDBOOK_TITLE: 'My # Handbook',
      WORKERS: '12',
    });
  });
});

describe('parseEnvFile — quoted values with inline comments (adversarial)', () => {
  it('strips quotes AND a trailing comment on a double-quoted value', () => {
    // Regression: a `"url" # note` line used to keep its quotes, yielding the
    // literal value `"http://h:8000/v1"` — a broken URL the shell never sees.
    expect(parseEnvFile('OPENAI_BASE_URL="http://h:8000/v1"  # local endpoint')).toEqual({
      OPENAI_BASE_URL: 'http://h:8000/v1',
    });
  });

  it('strips quotes and a trailing comment on a single-quoted value', () => {
    expect(parseEnvFile("A='hello world' # greeting")).toEqual({ A: 'hello world' });
  });

  it('keeps a `#` that lives inside the quoted span', () => {
    expect(parseEnvFile('T="a # b" # trailing')).toEqual({ T: 'a # b' });
  });

  it('leaves an unterminated opening quote untouched', () => {
    expect(parseEnvFile('A="unterminated')).toEqual({ A: '"unterminated' });
  });

  it('does not treat non-comment garbage after a close quote as a comment', () => {
    expect(parseEnvFile('A="a"b')).toEqual({ A: '"a"b' });
  });

  it('still handles fully quoted values and unquoted inline comments', () => {
    expect(parseEnvFile('U="http://localhost:8000/v1"')).toEqual({ U: 'http://localhost:8000/v1' });
    expect(parseEnvFile('W=12 # workers')).toEqual({ W: '12' });
  });
});

describe('parseEnvFile — prototype-pollution-style keys', () => {
  it('preserves a literal `__proto__` key as data without polluting the prototype', () => {
    const parsed = parseEnvFile('__proto__=surprise\nA=1');
    expect(parsed.A).toBe('1');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect((parsed as Record<string, string>)['__proto__']).toBe('surprise');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).surprise).toBeUndefined();
  });

  it('treats `constructor` as an ordinary key', () => {
    expect(parseEnvFile('constructor=x')).toEqual({ constructor: 'x' });
  });
});

describe('parseEnvFile — empty values, comments, and line endings (adversarial pass 2)', () => {
  it('an empty value trailed by an inline comment is empty, not the comment', () => {
    // Regression: `KEY= # note` used to yield `# note` — a comment applied as a
    // secret. The `\s*` after `=` was eating the space that marks the comment.
    expect(parseEnvFile('KEY= # placeholder')).toEqual({ KEY: '' });
    expect(parseEnvFile('KEY=\t# c')).toEqual({ KEY: '' });
  });

  it('a value that begins with # and no leading space is kept verbatim', () => {
    expect(parseEnvFile('KEY=#notacomment')).toEqual({ KEY: '#notacomment' });
  });

  it('strips quotes even with whitespace between = and the value', () => {
    expect(parseEnvFile('KEY=  "value"')).toEqual({ KEY: 'value' });
  });

  it('splits classic-Mac CR-only line endings instead of dropping every line', () => {
    expect(parseEnvFile('A=1\rB=2\rC=3')).toEqual({ A: '1', B: '2', C: '3' });
  });
});

describe('applyEnvFile', () => {
  it('applies file values but never overrides existing env', () => {
    const dir = tmp();
    const path = join(dir, '.env');
    writeFileSync(path, 'OPENAI_API_KEY=from-file\nOPENAI_MODEL=file-model\n');
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'from-shell' };
    const applied = applyEnvFile(path, env);
    expect(env.OPENAI_API_KEY).toBe('from-shell');
    expect(env.OPENAI_MODEL).toBe('file-model');
    expect(applied).toEqual(['OPENAI_MODEL']);
  });

  it('throws on a missing file', () => {
    expect(() => applyEnvFile('/nonexistent/.env', {})).toThrow();
  });
});

describe('applyEnvFiles cascade', () => {
  it('lets a more specific file win, and never overrides the shell', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\nC=base\n');
    writeFileSync(join(dir, '.env.local'), 'B=local\nC=local\n');
    writeFileSync(join(dir, '.env.prod'), 'C=prod\nD=prod\n');
    const env: NodeJS.ProcessEnv = { A: 'shell' };
    const loaded = applyEnvFiles(dir, 'prod', env);
    expect(env.A).toBe('shell'); // shell always wins
    expect(env.B).toBe('local'); // .env.local beats .env
    expect(env.C).toBe('prod'); // .env.prod beats both
    expect(env.D).toBe('prod');
    expect(loaded).toEqual([join(dir, '.env.prod'), join(dir, '.env.local'), join(dir, '.env')]);
  });

  it('loads only .env.local and .env when no environment is named', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'A=base\n');
    writeFileSync(join(dir, '.env.prod'), 'A=prod\n');
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFiles(dir, undefined, env)).toEqual([join(dir, '.env')]);
    expect(env.A).toBe('base'); // an unnamed run must not pick up .env.prod
  });

  it('is silent about files that do not exist', () => {
    expect(applyEnvFiles(tmp(), 'nope', {})).toEqual([]);
  });

  it('also tries .env.<name>.local ahead of .env.<name>', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.env.prod'), 'A=team\n');
    writeFileSync(join(dir, '.env.prod.local'), 'A=personal\n');
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFiles(dir, 'prod', env)).toEqual([join(dir, '.env.prod.local'), join(dir, '.env.prod')]);
    expect(env.A).toBe('personal');
  });
});
