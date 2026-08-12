import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@handbooks/core';
import { maskSecret, renderConfigJson, renderConfigTable } from './config-command.js';

const resolved = (env: NodeJS.ProcessEnv = {}, flags: Record<string, unknown> = {}) =>
  resolveConfig({ command: 'generate', flags, env, cwd: '/repo' });

describe('maskSecret', () => {
  it('shows enough to identify a key without printing it', () => {
    expect(maskSecret('sk-abcdefgh1234')).toBe('sk-…1234');
  });

  it('never leaks a short value by showing most of it', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('')).toBe('');
  });
});

describe('renderConfigTable', () => {
  it('shows the value and the source for each setting', () => {
    const text = renderConfigTable(resolved({ HANDBOOK_LLM_MODEL: 'm' }), 'generate');
    expect(text).toMatch(/llmModel\s+m\s+env HANDBOOK_LLM_MODEL/);
    expect(text).toMatch(/llmMaxTokens\s+16000\s+default/);
  });

  it('masks a secret even though it resolved from the environment', () => {
    const text = renderConfigTable(resolved({ OPENAI_API_KEY: 'sk-abcdefgh1234' }), 'generate');
    expect(text).toContain('sk-…1234');
    expect(text).not.toContain('sk-abcdefgh1234');
  });

  it('marks a pass-through setting as unset rather than inventing a value', () => {
    expect(renderConfigTable(resolved(), 'generate')).toMatch(/readBatchSize\s+—\s+unset/);
  });

  it('shows the file layer with its path and key when a setting resolved from a config file', () => {
    const result = resolveConfig({
      command: 'generate',
      flags: {},
      env: {},
      file: { path: '/repo/handbook.config.yaml', flat: { generateReadWorkers: 3 } },
      cwd: '/repo',
    });
    const text = renderConfigTable(result, 'generate');
    expect(text).toMatch(/readWorkers\s+3\s+file \/repo\/handbook\.config\.yaml \(generateReadWorkers\)/);
  });

  it('marks a required setting missing from every layer as unset (required) rather than plain unset', () => {
    const text = renderConfigTable(resolved(), 'generate');
    expect(text).toMatch(/source\s+—\s+unset \(required\)/);
  });
});

describe('renderConfigJson', () => {
  it('emits values and sources as machine-readable JSON with secrets masked', () => {
    const parsed = JSON.parse(
      renderConfigJson(resolved({ OPENAI_API_KEY: 'sk-abcdefgh1234', HANDBOOK_DETAIL: 'deep' }), 'generate'),
    ) as { command: string; settings: Record<string, { value: unknown; source: string }> };
    expect(parsed.command).toBe('generate');
    expect(parsed.settings.detail).toEqual({ value: 'deep', source: 'env HANDBOOK_DETAIL' });
    expect(parsed.settings.llmApiKey?.value).toBe('sk-…1234');
  });

  it('carries environment, envFiles, and configFile even when none of them is set', () => {
    // A cascade of up to eight sources is unauditable unless --json exposes
    // these three the same as the table does; null/[] here is the honest
    // "nothing named" case, not an omitted field.
    const parsed = JSON.parse(renderConfigJson(resolved(), 'generate')) as Record<string, unknown>;
    expect(parsed.environment).toBeNull();
    expect(parsed.envFiles).toEqual([]);
    expect(parsed.configFile).toBeNull();
  });

  it('reports the active environment, its source, the loaded files, and the config file', () => {
    const parsed = JSON.parse(
      renderConfigJson(resolved(), 'generate', {
        name: 'prod',
        source: 'flag',
        envFiles: ['/repo/.env.prod', '/repo/.env'],
        configFile: '/repo/handbook.config.prod.yaml',
      }),
    ) as Record<string, unknown>;
    expect(parsed.environment).toEqual({ name: 'prod', source: '--env' });
    expect(parsed.envFiles).toEqual(['/repo/.env.prod', '/repo/.env']);
    expect(parsed.configFile).toBe('/repo/handbook.config.prod.yaml');
  });

  it('labels an environment named via HANDBOOK_ENV distinctly from one named via --env', () => {
    const parsed = JSON.parse(
      renderConfigJson(resolved(), 'generate', { name: 'staging', source: 'env', envFiles: [] }),
    ) as Record<string, unknown>;
    expect(parsed.environment).toEqual({ name: 'staging', source: 'HANDBOOK_ENV' });
  });
});

describe('renderConfigTable — environment header', () => {
  it('shows the active environment, its source, the env files in precedence order, and the config file', () => {
    const text = renderConfigTable(resolved(), 'generate', {
      name: 'prod',
      source: 'flag',
      envFiles: ['/repo/.env.prod', '/repo/.env.local', '/repo/.env'],
      configFile: '/repo/handbook.config.prod.yaml',
    });
    expect(text).toMatch(/^environment: prod\s+\(--env\)/);
    expect(text).toMatch(/env files:\s+\.env\.prod, \.env\.local, \.env/);
    expect(text).toMatch(/config file: \/repo\/handbook\.config\.prod\.yaml/);
  });

  it('marks the environment as not set, and the env files as none loaded, absent --env/HANDBOOK_ENV', () => {
    const text = renderConfigTable(resolved(), 'generate');
    expect(text).toMatch(/^environment: \(not set\)/);
    expect(text).toMatch(/env files:\s+\(none loaded\)/);
    expect(text).toMatch(/config file: \(none\)/);
  });
});

describe('renderConfigTable — a config file that is itself broken (M24)', () => {
  it('names the file, marks it as not loaded, and prints the reason on one line', () => {
    // Without this the table is identical to a project that has no config file
    // at all — the worst possible answer for someone running this command
    // because the file is broken.
    const text = renderConfigTable(resolved(), 'generate', {
      envFiles: [],
      configFile: '/repo/handbook.config.yaml',
      configFileError: '/repo/handbook.config.yaml: Missing closing "quote\n\n  detail: deep\n  ^\n',
    });
    expect(text).toMatch(/config file: \/repo\/handbook\.config\.yaml {2}\(NOT LOADED\)/);
    expect(text).toMatch(/error:\s+\/repo\/handbook\.config\.yaml: Missing closing "quote detail: deep \^/);
    // A multi-line parser error must not wreck the table it is printed into.
    expect(text.split('\n')[3]).toContain('error:');
  });

  it('lists every unknown key as its own warning row (M25)', () => {
    const text = renderConfigTable(resolved(), 'generate', {
      envFiles: [],
      configFile: '/repo/handbook.config.yaml',
      configFileWarnings: ['/repo/handbook.config.yaml: unknown key "generate.readWorker" is ignored'],
    });
    expect(text).toMatch(/config file: \/repo\/handbook\.config\.yaml\n/); // no NOT LOADED: it loaded
    expect(text).toMatch(/warning:\s+.*unknown key "generate\.readWorker" is ignored/);
  });
});

describe('renderConfigJson — file-level problems', () => {
  it('reports the load failure and the unknown keys separately from per-setting errors', () => {
    // A consumer that only checked `errors` would read a config file that never
    // loaded as a clean run.
    const parsed = JSON.parse(
      renderConfigJson(resolved(), 'generate', {
        envFiles: [],
        configFile: '/repo/handbook.config.yaml',
        configFileError: 'boom',
        configFileWarnings: ['unknown key "generate.readWorker" is ignored'],
      }),
    ) as Record<string, unknown>;
    expect(parsed.configFileError).toBe('boom');
    expect(parsed.configFileWarnings).toEqual(['unknown key "generate.readWorker" is ignored']);
  });

  it('reports both as null/[] when the file is fine', () => {
    const parsed = JSON.parse(renderConfigJson(resolved(), 'generate')) as Record<string, unknown>;
    expect(parsed.configFileError).toBeNull();
    expect(parsed.configFileWarnings).toEqual([]);
  });

  it('masks an object-valued secret from its JSON text, not from [object Object] (M23)', () => {
    // `llmExtraBody` is a secret now, and it is the only `json`-typed one:
    // `String({})` masks to something that reads like a real short value.
    const parsed = JSON.parse(
      renderConfigJson(
        resolved({ OPENAI_EXTRA_BODY: '{"authorization":"Bearer sk-abcdefgh1234"}' }),
        'generate',
      ),
    ) as { settings: Record<string, { value: unknown }> };
    expect(parsed.settings.llmExtraBody?.value).toBe('{"a…34"}');
    expect(JSON.stringify(parsed)).not.toContain('sk-abcdefgh1234');
  });
});
