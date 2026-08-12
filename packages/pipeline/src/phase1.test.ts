import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverByExtension, registerAdapter, type LanguageAdapter } from '@handbooks/analyzer';
import {
  scanCoverageSchema,
  type AdapterCapabilities,
  type FunctionNode,
  type Logger,
} from '@handbooks/core';
import { runPhase1 } from './phase1.js';
import { WorkDir } from './workdir.js';

/**
 * Two fake adapters — one that declares capabilities, one that does not.
 *
 * Registered rather than exercising a built-in adapter on purpose: the point of
 * the test is what phase 1 records about DECLARATIONS, and a real adapter's
 * declaration is not this package's business. The bare one stands for a
 * third-party adapter, which the contract allows.
 */
const GENERIC_CAPS = {
  tier: 'generic',
  callTypes: ['internal_func', 'self_method', 'internal_constructor', 'boundary', 'unresolved'],
  selfAttrs: false,
  statementSpans: false,
} satisfies AdapterCapabilities;

function fakeFunction(file: string, name: string): FunctionNode {
  return {
    id: `${file}:${name}`,
    name,
    qualname: name,
    file,
    lineStart: 1,
    lineEnd: 2,
    signature: `fn ${name}()`,
    isAsync: false,
    isMethod: false,
    className: null,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes: {},
  };
}

/** Declared-capability adapter for `.faux` files. */
const declaring = {
  name: 'faux-generic',
  extensions: ['.faux'],
  discover: (sourceRoot: string): string[] => discoverByExtension(sourceRoot, ['.faux']),
  analyze: async (files: readonly string[]) => ({
    functions: files.map((f) => fakeFunction(f, 'genericFn')),
    edges: [],
  }),
  capabilities: GENERIC_CAPS,
};

/** Same, but silent about what it can do — the third-party case. */
const silent = {
  name: 'faux-bare',
  extensions: ['.bare'],
  discover: (sourceRoot: string): string[] => discoverByExtension(sourceRoot, ['.bare']),
  analyze: async (files: readonly string[]) => ({
    functions: files.map((f) => fakeFunction(f, 'bareFn')),
    edges: [],
  }),
};

/** The only one of the three that extracts types, so the merge below is mixed. */
const typed = {
  name: 'faux-typed',
  extensions: ['.typed'],
  discover: (sourceRoot: string): string[] => discoverByExtension(sourceRoot, ['.typed']),
  analyze: async (files: readonly string[]) => ({
    functions: files.map((f) => fakeFunction(f, 'typedFn')),
    edges: [],
    types: files.map((f) => ({
      id: `type:${f}:Shape`,
      name: 'Shape',
      qualname: 'Shape',
      file: f,
      lineStart: 1,
      lineEnd: 4,
      kind: 'interface' as const,
      signature: 'interface Shape',
      container: null,
    })),
  }),
  capabilities: { ...GENERIC_CAPS, typeKinds: ['interface'] } satisfies AdapterCapabilities,
};

let sourceRoot: string;

beforeAll(() => {
  registerAdapter('faux-generic', () => declaring);
  // Cast on purpose: the adapter TYPE may require a declaration, but the registry
  // is a runtime door (`registerAdapter` is public API, and a plain-JS or
  // out-of-tree adapter arrives untyped). Phase 1's tolerance of a missing
  // declaration is a runtime promise, so it needs a runtime violation to test.
  registerAdapter('faux-bare', () => silent as unknown as LanguageAdapter);
  registerAdapter('faux-typed', () => typed);
  sourceRoot = mkdtempSync(join(tmpdir(), 'hb-phase1-caps-'));
  mkdirSync(join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(join(sourceRoot, 'src', 'a.faux'), 'fn genericFn() {}\n');
  writeFileSync(join(sourceRoot, 'src', 'b.bare'), 'fn bareFn() {}\n');
  writeFileSync(join(sourceRoot, 'src', 'c.typed'), 'fn typedFn() {}\n');
});

afterAll(() => {
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe('runPhase1 — metadata.languages', () => {
  it('records the capabilities of every adapter that contributed, and omits undeclared ones', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-work-'));
    try {
      const stats = await runPhase1({ sourceRoot, workDir });
      expect(stats.language).toBe('multi');
      const graph = new WorkDir(workDir).loadGraph();
      expect(graph.metadata.languages?.['faux-generic']).toEqual(GENERIC_CAPS);
      // A graph must never claim fidelity nobody declared — no placeholder entry.
      expect(graph.metadata.languages).not.toHaveProperty('faux-bare');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('omits the field entirely when no contributing adapter declares anything', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-work-bare-'));
    try {
      await runPhase1({ sourceRoot, workDir, lang: 'faux-bare' });
      const graph = new WorkDir(workDir).loadGraph();
      // Absent, not `{}`: an empty map would read as "asked and got nothing".
      expect(graph.metadata.languages).toBeUndefined();
      expect(graph.metadata.language).toBe('faux-bare');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('records only the analyzed language when one is named explicitly', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-work-one-'));
    try {
      await runPhase1({ sourceRoot, workDir, lang: 'faux-generic' });
      const graph = new WorkDir(workDir).loadGraph();
      expect(Object.keys(graph.metadata.languages ?? {})).toEqual(['faux-generic']);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('runPhase1 — merging types across languages', () => {
  it('records the types of the one adapter that extracts them, in a mixed run', async () => {
    // A multi-language repository mixes adapters that do and do not extract types.
    // Skipping the merge when ANY adapter declines would lose the facts that exist;
    // merging blindly would let a language that never looked contribute an entry.
    const workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-types-'));
    try {
      const stats = await runPhase1({ sourceRoot, workDir });
      const graph = new WorkDir(workDir).loadGraph();
      expect(graph.types?.map((t) => `${t.file}:${t.name}`)).toEqual(['src/c.typed:Shape']);
      expect(graph.metadata.nTypes).toBe(1);
      expect(stats.functions).toBe(3);
      // The declaration travels with it, which is what makes the row trustworthy.
      expect(graph.metadata.languages?.['faux-typed']?.typeKinds).toEqual(['interface']);
      expect(graph.metadata.languages?.['faux-generic']?.typeKinds).toBeUndefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('leaves the field off entirely when no contributing adapter looked', async () => {
    // Absent, not `[]`. An empty array would state "these languages declare no
    // types", about languages nobody examined for them.
    const workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-types-none-'));
    try {
      await runPhase1({ sourceRoot, workDir, lang: 'faux-generic' });
      const graph = new WorkDir(workDir).loadGraph();
      expect(graph.types).toBeUndefined();
      expect(graph.metadata.nTypes).toBeUndefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('names the type count in the closing build line only when someone looked', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (m) => lines.push(m),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const withTypes = mkdtempSync(join(tmpdir(), 'hb-phase1-types-log-'));
    const without = mkdtempSync(join(tmpdir(), 'hb-phase1-types-log-2-'));
    try {
      await runPhase1({ sourceRoot, workDir: withTypes, lang: 'faux-typed', logger });
      expect(lines.some((l) => l.includes('[build]') && l.includes('types=1'))).toBe(true);
      lines.length = 0;
      await runPhase1({ sourceRoot, workDir: without, lang: 'faux-generic', logger });
      // A silent `types=0` would imply the codebase declares none.
      expect(lines.some((l) => l.includes('[build]') && l.includes('types='))).toBe(false);
    } finally {
      rmSync(withTypes, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });
});

describe('runPhase1 — scan coverage', () => {
  /**
   * A real TypeScript mini-repo, because the question is what the grammar does
   * with broken source. `unreadable.ts` is a DIRECTORY: `readFileSync` raises
   * EISDIR for every user, where a chmod-000 file is readable by root and the
   * test would pass vacuously in a container.
   *
   * The load-bearing assertion is `scannedFiles`. That list is what
   * `allFileDescriptors` widens the cards pass with, so a file left in it after
   * yielding nothing gets a card, gets counted as described in
   * `_coverage.json`, and reaches the handbook as "a file with 0 functions" —
   * a parser fact about a file no parser read.
   */
  let broken: string;
  let workDir: string;

  beforeAll(() => {
    broken = mkdtempSync(join(tmpdir(), 'hb-phase1-broken-'));
    workDir = mkdtempSync(join(tmpdir(), 'hb-phase1-broken-work-'));
    writeFileSync(join(broken, 'ok.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
    mkdirSync(join(broken, 'unreadable.ts'));
    writeFileSync(
      join(broken, 'partial.ts'),
      'export function beta(): number {\n  return 2;\n}\n\nconst x = ;\n',
    );
  });

  afterAll(() => {
    rmSync(broken, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('keeps a file it could not read out of scannedFiles, and records why', async () => {
    const stats = await runPhase1({
      sourceRoot: broken,
      workDir,
      lang: 'typescript',
      files: ['ok.ts', 'unreadable.ts', 'partial.ts'],
    });
    const graph = new WorkDir(workDir).loadGraph();
    expect(graph.metadata.scannedFiles).toEqual(['ok.ts', 'partial.ts']);
    expect(graph.metadata.unparsedFiles).toContainEqual(
      expect.objectContaining({ file: 'unreadable.ts', reason: 'unreadable' }),
    );
    expect(stats.files).toBe(2);
    expect(stats.filesUnparsed).toBe(2);
  });

  it('keeps a partially parsed file, whose facts are incomplete rather than absent', async () => {
    const graph = new WorkDir(workDir).loadGraph();
    expect(graph.metadata.scannedFiles).toContain('partial.ts');
    expect(graph.metadata.unparsedFiles).toContainEqual(
      expect.objectContaining({ file: 'partial.ts', reason: 'partial' }),
    );
  });

  it('writes scan-coverage.json beside dropped-calls.json', () => {
    const dir = new WorkDir(workDir).phase1Dir;
    expect(existsSync(join(dir, 'dropped-calls.json'))).toBe(true);
    const coverage = scanCoverageSchema.parse(
      JSON.parse(readFileSync(join(dir, 'scan-coverage.json'), 'utf8')),
    );
    expect(coverage.metadata.nScanned).toBe(2);
    expect(coverage.metadata.byReason).toEqual({ unreadable: 1, partial: 1 });
    expect(coverage.files.map((f) => f.file)).toEqual(['partial.ts', 'unreadable.ts']);
  });

  it('closes phase 1 with a line naming the gap', async () => {
    const lines: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (m) => lines.push(m),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const quiet = mkdtempSync(join(tmpdir(), 'hb-phase1-broken-log-'));
    try {
      await runPhase1({
        sourceRoot: broken,
        workDir: quiet,
        lang: 'typescript',
        files: ['ok.ts', 'unreadable.ts', 'partial.ts'],
        logger,
      });
      // A silent scan and one that lost a file must not end identically.
      expect(lines.some((l) => /\[scan\] coverage: 2 files analyzed; 2 recorded/.test(l))).toBe(true);
    } finally {
      rmSync(quiet, { recursive: true, force: true });
    }
  });
});
