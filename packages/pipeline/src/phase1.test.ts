import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverByExtension, registerAdapter, type LanguageAdapter } from '@handbook/analyzer';
import type { AdapterCapabilities, FunctionNode } from '@handbook/core';
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

let sourceRoot: string;

beforeAll(() => {
  registerAdapter('faux-generic', () => declaring);
  // Cast on purpose: the adapter TYPE may require a declaration, but the registry
  // is a runtime door (`registerAdapter` is public API, and a plain-JS or
  // out-of-tree adapter arrives untyped). Phase 1's tolerance of a missing
  // declaration is a runtime promise, so it needs a runtime violation to test.
  registerAdapter('faux-bare', () => silent as unknown as LanguageAdapter);
  sourceRoot = mkdtempSync(join(tmpdir(), 'hb-phase1-caps-'));
  mkdirSync(join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(join(sourceRoot, 'src', 'a.faux'), 'fn genericFn() {}\n');
  writeFileSync(join(sourceRoot, 'src', 'b.bare'), 'fn bareFn() {}\n');
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
