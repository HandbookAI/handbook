import { describe, expect, it } from 'vitest';
import { envCandidates, resolveConfig } from './resolve.js';
import { settingByKey } from './registry.js';

const need = (key: string) => {
  const s = settingByKey(key);
  if (!s) throw new Error(`registry is missing ${key}`);
  return s;
};

describe('envCandidates', () => {
  it('puts the command-scoped name ahead of the flat one, aliases last', () => {
    expect(envCandidates('generate', need('llmModel'))).toEqual([
      'HANDBOOK_GENERATE_LLM_MODEL',
      'HANDBOOK_LLM_MODEL',
      'OPENAI_MODEL',
    ]);
  });
});

describe('resolveConfig precedence', () => {
  const base = { command: 'generate', flags: {}, env: {}, cwd: '/repo' };

  it('falls back to the declared default and says so', () => {
    const r = resolveConfig(base);
    expect(r.values.llmModel).toBe('gpt-4o-mini');
    expect(r.sources.llmModel).toEqual({ kind: 'default' });
    expect(r.errors).toEqual([]);
  });

  it('lets a flat env var beat the default', () => {
    const r = resolveConfig({ ...base, env: { HANDBOOK_LLM_MODEL: 'from-env' } });
    expect(r.values.llmModel).toBe('from-env');
    expect(r.sources.llmModel).toEqual({ kind: 'env', name: 'HANDBOOK_LLM_MODEL' });
  });

  it('lets a scoped env var beat a flat one', () => {
    const r = resolveConfig({
      ...base,
      env: { HANDBOOK_LLM_MODEL: 'flat', HANDBOOK_GENERATE_LLM_MODEL: 'scoped' },
    });
    expect(r.values.llmModel).toBe('scoped');
  });

  it('accepts a vendor alias, but ranks it below the handbook names', () => {
    expect(resolveConfig({ ...base, env: { OPENAI_MODEL: 'vendor' } }).values.llmModel).toBe('vendor');
    const both = resolveConfig({
      ...base,
      env: { OPENAI_MODEL: 'vendor', HANDBOOK_LLM_MODEL: 'ours' },
    });
    expect(both.values.llmModel).toBe('ours');
  });

  it('lets a flag beat every env var', () => {
    const r = resolveConfig({
      ...base,
      flags: { llmModel: 'from-flag' },
      env: { HANDBOOK_GENERATE_LLM_MODEL: 'scoped', OPENAI_MODEL: 'vendor' },
    });
    expect(r.values.llmModel).toBe('from-flag');
    expect(r.sources.llmModel).toEqual({ kind: 'flag', name: '--model' });
  });

  it('lets shell env beat the config file, and the file beat the default', () => {
    const file = { path: '/repo/handbook.config.yaml', flat: { llmModel: 'from-file' } };
    expect(resolveConfig({ ...base, file }).values.llmModel).toBe('from-file');
    expect(resolveConfig({ ...base, file }).sources.llmModel).toEqual({
      kind: 'file',
      path: '/repo/handbook.config.yaml',
      keyPath: 'llmModel',
    });
    expect(resolveConfig({ ...base, file, env: { HANDBOOK_LLM_MODEL: 'env' } }).values.llmModel).toBe('env');
  });

  it('treats an empty env value as unset, not as a value', () => {
    // applyEnvFile already skips empties; the layers must agree.
    const r = resolveConfig({ ...base, env: { HANDBOOK_LLM_MODEL: '' } });
    expect(r.values.llmModel).toBe('gpt-4o-mini');
    expect(r.sources.llmModel).toEqual({ kind: 'default' });
  });
});

describe('resolveConfig behaviour', () => {
  const base = { command: 'generate', flags: {}, env: {}, cwd: '/repo' };

  it('omits a pass-through setting entirely when no layer supplies it', () => {
    // `default: undefined` means the pipeline's own default must still apply,
    // so the key must be ABSENT rather than present-and-undefined.
    const r = resolveConfig(base);
    expect('llmExtraBody' in r.values).toBe(false);
  });

  // unskipped in Task 5, once `source`/`detail` are in the registry
  it.skip('collects every error instead of throwing on the first', () => {
    const r = resolveConfig({
      ...base,
      env: { HANDBOOK_LLM_MAX_TOKENS: 'lots', HANDBOOK_GENERATE_DETAIL: 'shallow' },
    });
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join('\n')).toMatch(/HANDBOOK_LLM_MAX_TOKENS/);
    expect(r.errors.join('\n')).toMatch(/HANDBOOK_GENERATE_DETAIL/);
  });

  // unskipped in Task 5, once `source`/`detail` are in the registry
  it.skip('reports a required setting that no layer supplied, naming the routes', () => {
    const r = resolveConfig({ command: 'analyze', flags: {}, env: {}, cwd: '/repo' });
    expect(r.errors.join('\n')).toMatch(
      /source is required: pass --source, set HANDBOOK_(ANALYZE_)?SOURCE, or add it to handbook\.config\.yaml/,
    );
  });

  it('ignores settings that belong to other commands', () => {
    const r = resolveConfig({ ...base, env: { HANDBOOK_RENDER_OUT: '/x' } });
    expect('out' in r.values).toBe(false);
  });
});
