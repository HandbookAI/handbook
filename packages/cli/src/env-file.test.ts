import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnvFile, parseEnvFile } from './env-file.js';

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

describe('applyEnvFile', () => {
  it('applies file values but never overrides existing env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-env-'));
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
