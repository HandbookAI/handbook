/**
 * Regression coverage for the class of bug that let P0-1 ship: an action
 * handler resolving a value from flags/env/config-file and then never
 * passing it to the thing that actually uses it. `main.ts` had 0% coverage,
 * which is exactly why that survived twelve reviews.
 *
 * Rather than re-implement each callee, these tests mock the two injectable
 * seams the finding named — `@handbook/studio`'s `startStudio` and
 * `@handbook/pipeline`'s `generateHandbook` — and drive the REAL `program`
 * (exported by main.ts for this purpose) through commander's real option
 * parsing and the real `resolveConfig` layering. A regression where a
 * resolved value is dropped before reaching the callee fails these tests;
 * the CLI's own `--help` / `handbook config` continuing to describe the
 * flag would not save it, same as it did not save P0-1.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '@handbook/llm';
import type { Logger } from '@handbook/core';
import type * as Pipeline from '@handbook/pipeline';
import type { GenerateOptions, GenerateStats } from '@handbook/pipeline';
import type { StudioOptions } from '@handbook/studio';
import type { Server } from 'node:http';

const startStudioMock = vi.fn((_options: StudioOptions) => Promise.resolve({} as Server));
const generateHandbookMock = vi.fn((_options: GenerateOptions) =>
  Promise.resolve({ phasesRun: [] } as GenerateStats),
);

// `boundPort` too: the action reads the port back off the socket rather than
// echoing the requested one, so a mock without it throws before startStudio is
// even reached — and the failure reads as "startStudio was never called".
vi.mock('@handbook/studio', () => ({ startStudio: startStudioMock, boundPort: () => 4860 }));
vi.mock('@handbook/pipeline', async () => {
  const actual = await vi.importActual<typeof Pipeline>('@handbook/pipeline');
  return { ...actual, generateHandbook: generateHandbookMock };
});

/** Matches `Logger`'s interface without a real `createLogger` instance. */
function noopLogger(): Logger {
  const self: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self,
  };
  return self;
}

// Imported AFTER the mocks (vitest hoists `vi.mock` regardless, but keeping
// the order matches the module's own resolution).
const { program } = await import('./main.js');
const { setConfigFile } = await import('./resolve-config.js');

const originalCwd = process.cwd();
let cwd: string;
let workDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  const created = mkdtempSync(join(tmpdir(), 'handbook-cli-test-'));
  // Isolates the test from this repo's own root `.env` / handbook.config.yaml
  // (if any) — the preAction hook discovers both from `process.cwd()`, and a
  // real ambient .env leaking into these assertions would be exactly the kind
  // of flaky, environment-dependent test this suite must not become.
  process.chdir(created);
  // macOS resolves `$TMPDIR` through a `/var` → `/private/var` symlink; reread
  // via `process.cwd()` so `cwd` matches what `discoverConfigFile` sees, not
  // the pre-symlink path `mkdtempSync` returned.
  cwd = process.cwd();
  workDir = join(cwd, 'work');
  // `resolve-config.ts`'s `configFile` is module-level state, set once by the
  // preAction hook per real CLI invocation (its own process) — but this suite
  // drives the same `program` repeatedly in one process, and the hook never
  // clears it back to undefined when a later cwd has no config file. Reset
  // explicitly so one test's config file cannot leak into the next.
  setConfigFile(undefined);
  process.env.OPENAI_API_KEY = 'test-key'; // OpenAiChatClient refuses to construct without one
  startStudioMock.mockClear();
  generateHandbookMock.mockClear();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe('studio action', () => {
  it('passes a clientFactory built from the resolved --model to startStudio (P0-1)', async () => {
    const parse = program.parseAsync(
      ['node', 'handbook', 'studio', '--port', '48699', '--model', 'gpt-9000-test'],
      { from: 'node' },
    );
    // The action never returns (`await new Promise(() => {})`, until Ctrl-C),
    // so this test races the mocked startStudio call instead of the action.
    await vi.waitFor(() => expect(startStudioMock).toHaveBeenCalledTimes(1));

    const options = startStudioMock.mock.calls[0]?.[0];
    expect(options?.clientFactory).toBeTypeOf('function');
    const client = options?.clientFactory?.(noopLogger()) as ChatClient;
    // The actual proof: the flag reached the client, not just the config
    // object main.ts built and then could still have discarded.
    expect(client.model).toBe('gpt-9000-test');

    void parse; // deliberately never awaited — see above
  });

  it('passes a clientFactory built from a handbook.config.yaml llm: block (P0-1)', async () => {
    writeFileSync(
      join(cwd, 'handbook.config.yaml'),
      'llm:\n  model: gpt-config-file-test\n  baseUrl: https://config-file.example/v1\n',
    );
    const parse = program.parseAsync(['node', 'handbook', 'studio', '--port', '48699'], { from: 'node' });
    await vi.waitFor(() => expect(startStudioMock).toHaveBeenCalledTimes(1));

    const options = startStudioMock.mock.calls[0]?.[0];
    const client = options?.clientFactory?.(noopLogger()) as ChatClient;
    expect(client.model).toBe('gpt-config-file-test');
    // baseUrl is private on OpenAiChatClient; reached through the same object
    // main.ts built the client from, which is exactly what P0-1 broke.
    expect((client as unknown as { config: { baseUrl: string } }).config.baseUrl).toBe(
      'https://config-file.example/v1',
    );

    void parse;
  });

  it('forwards the discovered config file to studio, so a generate job sees it too', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'generate:\n  detail: deep\n');
    const parse = program.parseAsync(['node', 'handbook', 'studio', '--port', '48699'], { from: 'node' });
    await vi.waitFor(() => expect(startStudioMock).toHaveBeenCalledTimes(1));

    const options = startStudioMock.mock.calls[0]?.[0];
    expect(options?.configFile?.path).toBe(join(cwd, 'handbook.config.yaml'));

    void parse;
  });
});

describe('generate action', () => {
  it('forwards flags resolved from the command line to generateHandbook (P0-2 sibling check)', async () => {
    await program.parseAsync(
      [
        'node',
        'handbook',
        'generate',
        '--source',
        cwd,
        '--work',
        workDir,
        '--phase',
        '1',
        '--detail',
        'deep',
        '--read-workers',
        '3',
      ],
      { from: 'node' },
    );
    expect(generateHandbookMock).toHaveBeenCalledTimes(1);
    const options = generateHandbookMock.mock.calls[0]?.[0];
    expect(options?.detail).toBe('deep');
    expect(options?.readWorkers).toBe(3);
    expect(options?.phase).toBe('1');
  });

  it('forwards a value from handbook.config.yaml, not just flags/env', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'generate:\n  readWorkers: 7\n');
    await program.parseAsync(
      ['node', 'handbook', 'generate', '--source', cwd, '--work', workDir, '--phase', '1'],
      { from: 'node' },
    );
    expect(generateHandbookMock).toHaveBeenCalledTimes(1);
    const options = generateHandbookMock.mock.calls[0]?.[0];
    expect(options?.readWorkers).toBe(7);
  });

  it('rejects an invalid enum before generateHandbook is ever called', async () => {
    await expect(
      program.parseAsync(
        ['node', 'handbook', 'generate', '--source', cwd, '--work', workDir, '--detail', 'bogus'],
        { from: 'node' },
      ),
    ).rejects.toThrow(/detail must be one of brief \| deep/);
    expect(generateHandbookMock).not.toHaveBeenCalled();
  });
});

describe('preAction hook (P2-16)', () => {
  it('honours HANDBOOK_LOG_LEVEL=debug for the [config] loaded line, not just -v', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'port: 5000\n');
    process.env.HANDBOOK_LOG_LEVEL = 'debug';
    try {
      await program.parseAsync(['node', 'handbook', 'config', '--command', 'studio', '--check'], {
        from: 'node',
      });
    } finally {
      delete process.env.HANDBOOK_LOG_LEVEL;
    }
    const debugLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(debugLines.some((line: string) => line.includes('[config] loaded'))).toBe(true);
  });

  it('stays quiet at the default level, with no -v and no HANDBOOK_LOG_LEVEL', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'port: 5000\n');
    await program.parseAsync(['node', 'handbook', 'config', '--command', 'studio', '--check'], {
      from: 'node',
    });
    const debugLines = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(debugLines.some((line: string) => line.includes('[config] loaded'))).toBe(false);
  });
});

describe('--env cascade (Task 13)', () => {
  // applyEnvFiles writes into the REAL process.env (it is the default `env`
  // param), and never overrides an existing key — so a value one test's .env
  // sets would otherwise survive into the next test's cascade and mask it,
  // exactly the kind of leak `setConfigFile(undefined)` above guards against
  // for the config-file layer.
  afterEach(() => {
    delete process.env.HANDBOOK_LLM_MODEL;
  });

  it('with no --env and no HANDBOOK_ENV, loads only .env.local and .env — unchanged from before the cascade existed', async () => {
    writeFileSync(join(cwd, '.env'), 'HANDBOOK_LLM_MODEL=from-base\n');
    writeFileSync(join(cwd, '.env.prod'), 'HANDBOOK_LLM_MODEL=from-prod\n');
    await program.parseAsync(['node', 'handbook', 'config', '--command', 'generate', '--json'], {
      from: 'node',
    });
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      environment: unknown;
      envFiles: string[];
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.environment).toBeNull();
    expect(parsed.envFiles).toEqual([join(cwd, '.env')]); // .env.prod must NOT be picked up
    expect(parsed.settings.llmModel?.value).toBe('from-base');
  });

  it('--env prod loads .env.prod ahead of .env, and reports both in precedence order', async () => {
    writeFileSync(join(cwd, '.env'), 'HANDBOOK_LLM_MODEL=from-base\n');
    writeFileSync(join(cwd, '.env.prod'), 'HANDBOOK_LLM_MODEL=from-prod\n');
    await program.parseAsync(
      ['node', 'handbook', '--env', 'prod', 'config', '--command', 'generate', '--json'],
      { from: 'node' },
    );
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      environment: { name: string; source: string };
      envFiles: string[];
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.environment).toEqual({ name: 'prod', source: '--env' });
    expect(parsed.envFiles).toEqual([join(cwd, '.env.prod'), join(cwd, '.env')]);
    expect(parsed.settings.llmModel?.value).toBe('from-prod');
  });

  it('HANDBOOK_ENV selects the same cascade as --env, and is labelled distinctly in `config`', async () => {
    writeFileSync(join(cwd, '.env'), 'HANDBOOK_LLM_MODEL=from-base\n');
    writeFileSync(join(cwd, '.env.prod'), 'HANDBOOK_LLM_MODEL=from-prod\n');
    process.env.HANDBOOK_ENV = 'prod';
    try {
      await program.parseAsync(['node', 'handbook', 'config', '--command', 'generate', '--json'], {
        from: 'node',
      });
    } finally {
      delete process.env.HANDBOOK_ENV;
    }
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      environment: { name: string; source: string };
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.environment).toEqual({ name: 'prod', source: 'HANDBOOK_ENV' });
    expect(parsed.settings.llmModel?.value).toBe('from-prod');
  });

  it('HANDBOOK_ENV_FILE loads exactly that file and bypasses the cascade, like --env-file', async () => {
    // Not a convenience alias. On Node >= 20.6 `--env-file` is also a node flag,
    // and node pre-scans the whole command line for it — so
    // `handbook --env-file /gone.env` dies with `node: /gone.env: not found`
    // (exit 9) before main.ts ever runs, which is exactly the case the flag is
    // documented to report loudly. An environment variable cannot be
    // intercepted, so this is the reliable route and must keep working.
    writeFileSync(join(cwd, '.env'), 'HANDBOOK_LLM_MODEL=from-cascade\n');
    const explicit = join(cwd, 'somewhere-else.env');
    writeFileSync(explicit, 'HANDBOOK_LLM_MODEL=from-explicit-file\n');
    process.env.HANDBOOK_ENV_FILE = explicit;
    try {
      await program.parseAsync(['node', 'handbook', 'config', '--command', 'generate', '--json'], {
        from: 'node',
      });
    } finally {
      delete process.env.HANDBOOK_ENV_FILE;
    }
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      envFiles: string[];
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.envFiles).toEqual([explicit]); // the cascade was bypassed, not merged
    expect(parsed.settings.llmModel?.value).toBe('from-explicit-file');
  });

  it('--env-file wins over HANDBOOK_ENV_FILE, the same way every other flag beats its env form', async () => {
    const fromFlag = join(cwd, 'flag.env');
    const fromEnv = join(cwd, 'env.env');
    writeFileSync(fromFlag, 'HANDBOOK_LLM_MODEL=from-flag\n');
    writeFileSync(fromEnv, 'HANDBOOK_LLM_MODEL=from-env-var\n');
    process.env.HANDBOOK_ENV_FILE = fromEnv;
    try {
      await program.parseAsync(
        ['node', 'handbook', '--env-file', fromFlag, 'config', '--command', 'generate', '--json'],
        { from: 'node' },
      );
    } finally {
      delete process.env.HANDBOOK_ENV_FILE;
    }
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      envFiles: string[];
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.envFiles).toEqual([fromFlag]);
    expect(parsed.settings.llmModel?.value).toBe('from-flag');
  });

  it('a HANDBOOK_ENV_FILE naming a missing file fails loudly, exactly as --env-file promises to', async () => {
    process.env.HANDBOOK_ENV_FILE = join(cwd, 'does-not-exist.env');
    try {
      await expect(
        program.parseAsync(['node', 'handbook', 'config', '--command', 'generate'], { from: 'node' }),
      ).rejects.toThrow(/does-not-exist\.env/);
    } finally {
      delete process.env.HANDBOOK_ENV_FILE;
    }
  });

  it('prefers handbook.config.prod.yaml over the plain handbook.config.yaml when --env prod is set', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'llm:\n  model: from-plain-file\n');
    writeFileSync(join(cwd, 'handbook.config.prod.yaml'), 'llm:\n  model: from-prod-file\n');
    await program.parseAsync(
      ['node', 'handbook', '--env', 'prod', 'config', '--command', 'generate', '--json'],
      { from: 'node' },
    );
    const parsed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as {
      configFile: string;
      settings: Record<string, { value: unknown }>;
    };
    expect(parsed.configFile).toBe(join(cwd, 'handbook.config.prod.yaml'));
    expect(parsed.settings.llmModel?.value).toBe('from-prod-file');
  });
});
