import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@handbook/core';
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
