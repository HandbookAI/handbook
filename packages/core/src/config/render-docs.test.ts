import { describe, expect, it } from 'vitest';
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from './render-docs.js';
import { SETTINGS } from './registry.js';
import { envName } from './names.js';

describe('renderEnvExample', () => {
  const text = renderEnvExample();

  it('documents every non-secret setting that has a flat env name', () => {
    const missing = SETTINGS.filter((s) => !s.scopedOnly && !text.includes(envName(s.key)));
    expect(missing.map((s) => s.key)).toEqual([]);
  });

  it('keeps the vendor alias for the api key, which existing .env files use', () => {
    expect(text).toContain('OPENAI_API_KEY');
  });

  it('leaves every line commented out except the api key, so copying it is safe', () => {
    // An uncommented default would override a shell value the user already set.
    const assignments = text.split('\n').filter((l) => /^[A-Z]/.test(l));
    expect(assignments).toEqual(['OPENAI_API_KEY=sk-...']);
  });

  it('says which values are secret and where they may live', () => {
    expect(text).toMatch(/never.*config file/i);
  });
});

describe('renderConfigDocs', () => {
  const text = renderConfigDocs();

  it('has a row for every setting, with its flag and env name', () => {
    for (const s of SETTINGS) {
      expect(text, `missing ${s.key}`).toContain(s.key);
      if (s.flag) expect(text).toContain(s.flag.split(/[ ,]/)[0] as string);
    }
  });

  it('states the precedence order once, unambiguously', () => {
    expect(text).toMatch(/flag.*shell env.*\.env.*handbook\.config\.yaml.*default/s);
  });
});

describe('renderConfigExampleYaml', () => {
  it('nests the llm group and a command section, and omits secrets', () => {
    const text = renderConfigExampleYaml();
    expect(text).toMatch(/^llm:/m);
    expect(text).toMatch(/^ {2}model:/m);
    expect(text).not.toContain('apiKey');
  });
});
