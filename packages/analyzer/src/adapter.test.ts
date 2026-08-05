import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FunctionNode } from '@handbook/core';
import { dedupeFunctionsById, discoverAll, registerAdapter } from './adapter.js';
import { registerBuiltinAdapters } from './index.js';

function fn(id: string, overrides: Partial<FunctionNode> = {}): FunctionNode {
  const name = id.split(/[.:]/).at(-1) ?? id;
  return {
    id, name, qualname: name, file: 'a.py', lineStart: 1, lineEnd: 2, signature: `${name}()`,
    isAsync: false, isMethod: false, className: null, decorators: [], kind: 'internal',
    synthetic: false, selfAttrsRead: [], selfAttrsWritten: [], paramTypes: {}, ...overrides,
  };
}

describe('dedupeFunctionsById', () => {
  it('collapses same-id functions keeping the last (live) definition', () => {
    const stub = fn('m.f', { lineStart: 3, signature: 'def f(x: int) -> int' });
    const impl = fn('m.f', { lineStart: 7, signature: 'def f(x)' });
    const other = fn('m.g', { lineStart: 9 });
    const result = dedupeFunctionsById([stub, other, impl]);
    const fIds = result.filter((r) => r.id === 'm.f');
    expect(fIds).toHaveLength(1);
    expect(fIds[0]?.signature).toBe('def f(x)'); // impl, not the stub
    expect(result.map((r) => r.id)).toEqual(['m.g', 'm.f']); // last-occurrence position, order preserved
  });

  it('is a no-op when all ids are unique', () => {
    const input = [fn('m.a'), fn('m.b'), fn('m.c')];
    expect(dedupeFunctionsById(input)).toEqual(input);
  });
});

describe('discoverAll — broken adapter handling', () => {
  it('logs a warning instead of silently swallowing an adapter crash', () => {
    registerBuiltinAdapters();
    registerAdapter('broken', () => ({
      name: 'broken',
      extensions: ['.broken'],
      capabilities: { tier: 'generic', callTypes: [], selfAttrs: false, statementSpans: false },
      discover(): string[] {
        throw new Error('grammar exploded');
      },
      analyze: () => Promise.resolve({ functions: [], edges: [] }),
    }));
    const warnings: string[] = [];
    const root = mkdtempSync(join(tmpdir(), 'hb-disc-'));
    discoverAll(root, { warn: (m: string) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('broken') && w.includes('grammar exploded'))).toBe(true);
  });
});
