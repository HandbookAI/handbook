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

const startStudioMock = vi.fn(async () => ({}) as unknown);
const generateHandbookMock = vi.fn(async () => ({ phasesRun: [] }));

vi.mock('@handbook/studio', () => ({ startStudio: startStudioMock }));
vi.mock('@handbook/pipeline', async () => {
  const actual = await vi.importActual<typeof Pipeline>('@handbook/pipeline');
  return { ...actual, generateHandbook: generateHandbookMock };
});

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

    const options = startStudioMock.mock.calls[0]?.[0] as {
      clientFactory: (logger: Logger) => ChatClient;
    };
    expect(options.clientFactory).toBeTypeOf('function');
    const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = options.clientFactory(silentLogger);
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

    const options = startStudioMock.mock.calls[0]?.[0] as {
      clientFactory: (logger: Logger) => ChatClient;
    };
    const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = options.clientFactory(silentLogger);
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

    const options = startStudioMock.mock.calls[0]?.[0] as { configFile?: { path: string } };
    expect(options.configFile?.path).toBe(join(cwd, 'handbook.config.yaml'));

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
    const options = generateHandbookMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.detail).toBe('deep');
    expect(options.readWorkers).toBe(3);
    expect(options.phase).toBe('1');
  });

  it('forwards a value from handbook.config.yaml, not just flags/env', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'generate:\n  readWorkers: 7\n');
    await program.parseAsync(
      ['node', 'handbook', 'generate', '--source', cwd, '--work', workDir, '--phase', '1'],
      { from: 'node' },
    );
    expect(generateHandbookMock).toHaveBeenCalledTimes(1);
    const options = generateHandbookMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.readWorkers).toBe(7);
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
    const debugLines = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(debugLines.some((line) => line.includes('[config] loaded'))).toBe(true);
  });

  it('stays quiet at the default level, with no -v and no HANDBOOK_LOG_LEVEL', async () => {
    writeFileSync(join(cwd, 'handbook.config.yaml'), 'port: 5000\n');
    await program.parseAsync(['node', 'handbook', 'config', '--command', 'studio', '--check'], {
      from: 'node',
    });
    const debugLines = stderrSpy.mock.calls.map((call) => String(call[0]));
    expect(debugLines.some((line) => line.includes('[config] loaded'))).toBe(false);
  });
});
