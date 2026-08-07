import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverConfigFile, flattenConfig, loadConfigFile } from './file.js';
import { ConfigError } from './coerce.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'hb-config-'));

describe('flattenConfig', () => {
  it('joins nested maps by camelCase, so one rule covers grouping and command scoping', () => {
    expect(flattenConfig({ llm: { model: 'm', baseUrl: 'u' }, generate: { readWorkers: 4 } })).toEqual({
      llmModel: 'm',
      llmBaseUrl: 'u',
      generateReadWorkers: 4,
    });
  });

  it('keeps an already-flat key as it is', () => {
    expect(flattenConfig({ llmModel: 'm', detail: 'deep' })).toEqual({ llmModel: 'm', detail: 'deep' });
  });

  it('treats arrays and null as leaves, not as maps to walk into', () => {
    expect(flattenConfig({ a: [1, 2], b: null })).toEqual({ a: [1, 2], b: null });
  });
});

describe('loadConfigFile', () => {
  it('parses YAML', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'llm:\n  model: from-yaml\ndetail: deep\n');
    const file = loadConfigFile(join(dir, 'handbook.config.yaml'));
    expect(file.flat).toEqual({ llmModel: 'from-yaml', detail: 'deep' });
  });

  it('parses JSON with the same parser, since JSON is valid YAML', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.json'), '{"detail":"brief"}');
    expect(loadConfigFile(join(dir, 'handbook.config.json')).flat).toEqual({ detail: 'brief' });
  });

  it('refuses a secret in the config file, and says where to put it instead', () => {
    // This file gets committed. A key in it is a key in the repo.
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'llm:\n  apiKey: sk-leaked\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(ConfigError);
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(
      /llmApiKey must not appear in a config file .* use \.env/,
    );
  });

  it('rejects a top-level list or scalar with a clear message', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), '- a\n- b\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(/must contain a mapping/);
  });

  it('reports the file and the YAML error on malformed input', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'a:\n  - b\n c: broken\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(/handbook\.config\.yaml/);
  });
});

describe('discoverConfigFile', () => {
  it('finds the file in the starting directory', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
  });

  it('walks up so a command run from a subdirectory still sees the project config', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    const deep = join(dir, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(discoverConfigFile(deep)).toBe(join(dir, 'handbook.config.yaml'));
  });

  it('stops at a git root rather than escaping into a parent project', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    const inner = join(dir, 'inner');
    mkdirSync(join(inner, '.git'), { recursive: true });
    expect(discoverConfigFile(inner)).toBeUndefined();
  });

  it('returns undefined when there is nothing to find', () => {
    expect(discoverConfigFile(tmp())).toBeUndefined();
  });

  it('prefers .yaml over .yml over .json when several exist', () => {
    const dir = tmp();
    for (const ext of ['yaml', 'yml', 'json']) {
      writeFileSync(join(dir, `handbook.config.${ext}`), ext === 'json' ? '{}' : 'detail: deep\n');
    }
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
  });
});
