import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverConfigFile,
  flattenConfig,
  loadConfigFile,
  readConfigFile,
  unknownKeyWarnings,
} from './file.js';
import { ConfigError } from './coerce.js';
import { renderConfigExampleYaml } from './render-docs.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'hb-config-'));

/** Writes `body` as the config file in a fresh temp dir and returns its path. */
const configWith = (body: string): string => {
  const path = join(tmp(), 'handbook.config.yaml');
  writeFileSync(path, body);
  return path;
};

/** Can this process read `path` right now, whatever its mode claims? */
const stillReadable = (path: string): boolean => {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
};

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

  it('refuses a secret written as a nested map, which flattening hides (M23)', () => {
    // `llm: { extraBody: { … } }` never arrives as `llmExtraBody` — it arrives
    // as `llmExtraBodyAuthorization`, which the equality/suffix check the
    // guard used to do walked straight past.
    const path = configWith('llm:\n  extraBody:\n    authorization: Bearer sk-leaked\n');
    expect(() => loadConfigFile(path)).toThrow(/llmExtraBody must not appear in a config file/);
    expect(() => loadConfigFile(path)).toThrow(/llm\.extraBody\.authorization/);
  });

  it('refuses a secret written as a JSON string too, and names the env route', () => {
    const path = configWith('llm:\n  extraBody: \'{"authorization":"Bearer sk-leaked"}\'\n');
    expect(() => loadConfigFile(path)).toThrow(/HANDBOOK_LLM_EXTRA_BODY or OPENAI_EXTRA_BODY/);
  });
});

describe('loadConfigFile — credentials embedded in a value (M23)', () => {
  it('refuses a base URL carrying userinfo, and says what to do instead', () => {
    // A committed gateway URL is legitimate; a committed `user:pass@` in it is
    // a committed credential.
    const path = configWith('llm:\n  baseUrl: https://user:pass@gw.internal/v1\n');
    expect(() => loadConfigFile(path)).toThrow(ConfigError);
    expect(() => loadConfigFile(path)).toThrow(/llm\.baseUrl embeds credentials in the URL/);
    expect(() => loadConfigFile(path)).toThrow(
      /set the whole URL through HANDBOOK_LLM_BASE_URL or OPENAI_BASE_URL/,
    );
  });

  it('refuses a token-only userinfo, not just user:pass', () => {
    expect(() => loadConfigFile(configWith('llm:\n  baseUrl: https://sk-tok3n@gw.internal/v1\n'))).toThrow(
      /embeds credentials/,
    );
  });

  it('refuses it under a command scope as well as at the llm group', () => {
    expect(() => loadConfigFile(configWith('generate:\n  llmBaseUrl: https://u:p@gw.internal/v1\n'))).toThrow(
      /generate\.llmBaseUrl embeds credentials/,
    );
  });

  it('still accepts the plain shared-gateway URL this setting exists for', () => {
    // The whole point of not marking `llmBaseUrl` secret: a team pointing every
    // checkout at one endpoint must keep working.
    const file = loadConfigFile(configWith('llm:\n  baseUrl: https://gw.internal/v1\n'));
    expect(file.flat).toEqual({ llmBaseUrl: 'https://gw.internal/v1' });
  });

  it('leaves a path segment alone — a token baked into a path is not guessed at', () => {
    const url = 'https://gw.internal/proxy/sk-not-userinfo/v1';
    expect(loadConfigFile(configWith(`llm:\n  baseUrl: ${url}\n`)).flat.llmBaseUrl).toBe(url);
  });
});

describe('loadConfigFile — unknown keys (M25)', () => {
  it('reports a typo instead of silently ignoring it, and suggests the key that was meant', () => {
    const path = configWith('generate:\n  readWorker: 4\n');
    const file = loadConfigFile(path);
    // The value still resolves to nothing — that part is unchanged. What is
    // new is that the file says so.
    expect(file.flat.generateReadWorkers).toBeUndefined();
    expect(file.unknownKeys).toEqual([
      { path: 'generate.readWorker', key: 'generateReadWorker', suggestion: 'generate.readWorkers' },
    ]);
    expect(unknownKeyWarnings(file)).toEqual([
      `${path}: unknown key "generate.readWorker" is ignored — did you mean "generate.readWorkers"?`,
    ]);
  });

  it('writes the suggestion back in the shape the file already uses, flat or nested', () => {
    expect(loadConfigFile(configWith('generateReadWorker: 4\n')).unknownKeys?.[0]?.suggestion).toBe(
      'generateReadWorkers',
    );
  });

  it('offers no suggestion when nothing is close, and says so plainly', () => {
    const file = loadConfigFile(configWith('somethingNobodyDeclared: 1\n'));
    expect(file.unknownKeys?.[0]?.suggestion).toBeUndefined();
    expect(unknownKeyWarnings(file)[0]).toMatch(/no setting by that name/);
  });

  it('reports a bootstrap-only key, which the file genuinely cannot supply', () => {
    // `--env` selects the cascade that finds this file; a value here would
    // have nothing left to read it.
    expect(loadConfigFile(configWith('env: prod\n')).unknownKeys?.[0]?.path).toBe('env');
  });

  it('says nothing about a key with no value, which declares nothing', () => {
    expect(loadConfigFile(configWith('generate:\nllm:\n  model: m\n')).unknownKeys).toEqual([]);
  });

  it('accepts every key of the generated example config', () => {
    // The strongest guard available: the file this project tells people to copy
    // must not produce a single "unknown key" line. A drift between the
    // registry's file-key space and the example renderer fails here.
    const path = configWith(renderConfigExampleYaml());
    expect(unknownKeyWarnings(loadConfigFile(path))).toEqual([]);
  });

  it('reports nothing for an empty file', () => {
    expect(loadConfigFile(configWith('')).unknownKeys).toEqual([]);
  });

  it('has no unknown keys to report when there is no file at all', () => {
    expect(unknownKeyWarnings(undefined)).toEqual([]);
  });
});

describe('readConfigFile (M24)', () => {
  // `handbook config` runs BECAUSE something is broken. Throwing during
  // bootstrap took the whole command down before it could print a line.
  it('returns the parse error instead of throwing, and still names the path', () => {
    const path = configWith('llm:\n  model: "unterminated\ngenerate:\n  detail: deep\n');
    const read = readConfigFile(path);
    expect(read.file).toBeUndefined();
    expect(read.path).toBe(path);
    expect(read.error).toMatch(/handbook\.config\.yaml/);
  });

  it('returns an error for a config path that is a directory', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'handbook.config.yaml'));
    // `discoverConfigFile` finds it — `existsSync` is true for a directory —
    // so this is reachable without anybody naming it explicitly.
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
    expect(readConfigFile(join(dir, 'handbook.config.yaml')).error).toMatch(/EISDIR|directory/);
  });

  it('returns an error for a file that cannot be read', () => {
    // The mode is a request, and plenty of systems decline it: root reads
    // anything, and on Windows `chmod` only moves the read-only attribute — mode
    // 000 leaves the owner full read access, so `readConfigFile` correctly
    // returns the parsed file and there is no error to assert. Probing whether
    // this process can still read the file asks that directly, instead of
    // enumerating the reasons the mode might not have taken.
    const path = configWith('detail: deep\n');
    chmodSync(path, 0o000);
    if (stillReadable(path)) return;
    expect(readConfigFile(path).error).toMatch(/EACCES|permission/i);
  });

  it('returns an error for a named file that does not exist, rather than falling back', () => {
    expect(readConfigFile(join(tmp(), 'handbook.config.yaml')).error).toMatch(/ENOENT|no such file/);
  });

  it('returns an error for a secret in the file, so `config` can display that too', () => {
    expect(readConfigFile(configWith('llm:\n  apiKey: sk-leaked\n')).error).toMatch(/llmApiKey/);
  });

  it('returns the loaded file, with no error, when the file is fine', () => {
    const read = readConfigFile(configWith('generate:\n  detail: deep\n'));
    expect(read.error).toBeUndefined();
    expect(read.file?.flat).toEqual({ generateDetail: 'deep' });
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

  it('prefers the environment-named file over a plain one at the same directory level', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    writeFileSync(join(dir, 'handbook.config.prod.yaml'), 'detail: brief\n');
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    // Run from a subdirectory with neither file, so this also proves the
    // named check happens at every level of the upward walk, not just the
    // starting directory.
    expect(discoverConfigFile(sub, 'prod')).toBe(join(dir, 'handbook.config.prod.yaml'));
  });

  it('falls back to the plain file when no environment is named', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    writeFileSync(join(dir, 'handbook.config.prod.yaml'), 'detail: brief\n');
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
  });

  it('prefers .yaml over .yml over .json among environment-named files too', () => {
    const dir = tmp();
    for (const ext of ['yaml', 'yml', 'json']) {
      writeFileSync(join(dir, `handbook.config.prod.${ext}`), ext === 'json' ? '{}' : 'detail: deep\n');
    }
    expect(discoverConfigFile(dir, 'prod')).toBe(join(dir, 'handbook.config.prod.yaml'));
  });

  it('does not match a named file for an unrelated environment', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.staging.yaml'), 'detail: deep\n');
    expect(discoverConfigFile(dir, 'prod')).toBeUndefined();
  });
});
