import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAll, registerAdapter } from './adapter.js';
import { registerBuiltinAdapters } from './index.js';

describe('discoverAll — broken adapter handling', () => {
  it('logs a warning instead of silently swallowing an adapter crash', () => {
    registerBuiltinAdapters();
    registerAdapter('broken', () => ({
      name: 'broken',
      extensions: ['.broken'],
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
