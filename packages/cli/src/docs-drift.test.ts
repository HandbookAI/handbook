/**
 * The language list in the docs is a promise about what the tool supports, and
 * it had drifted six languages behind the registry before anyone noticed (the
 * CLI's own `--lang` help text was stale too, which is why that one is now
 * derived). Prose cannot be derived, so it is pinned here instead: adding an
 * adapter and forgetting the docs fails the build.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { availableLanguages, registerBuiltinAdapters } from '@handbook/analyzer';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

/** Display name per registry key, for the prose lists. */
const DISPLAY: Record<string, string> = {
  python: 'Python',
  typescript: 'TypeScript',
  go: 'Go',
  rust: 'Rust',
  shell: 'Shell',
  java: 'Java',
  csharp: 'C#',
  cpp: 'C/C++',
  kotlin: 'Kotlin',
  scala: 'Scala',
  zig: 'Zig',
  objc: 'Objective-C',
  ocaml: 'OCaml',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  dart: 'Dart',
  solidity: 'Solidity',
};

describe('documented language support matches the registry', () => {
  registerBuiltinAdapters();
  const registered = availableLanguages();

  it('every registered language has a display name here', () => {
    // A new adapter must be named before this file can check the docs for it —
    // failing here is the reminder, not an oversight.
    expect(registered.filter((l) => !DISPLAY[l])).toEqual([]);
  });

  for (const doc of ['README.md', 'README.zh-CN.md']) {
    it(`${doc} names every supported language`, () => {
      const text = read(doc);
      const missing = registered.filter((lang) => {
        const name = DISPLAY[lang] ?? lang;
        // C# and C/C++ need a looser probe than a word boundary allows.
        return !text.includes(name);
      });
      expect(missing, `${doc} does not mention: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the analyzer README does not claim a fixed adapter count', () => {
    // "five built-in adapters" was true for exactly one week.
    expect(read('packages/analyzer/README.md')).not.toMatch(
      /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(built-in\s+)?adapters\b/i,
    );
  });
});

describe('documented pnpm scripts exist', () => {
  const scripts = Object.keys(
    (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
  );
  // `pnpm <x>` may legitimately be a pnpm builtin (`pnpm install`) or a local
  // binary (`pnpm commitlint`), neither of which is a script in this manifest.
  // Reading .bin keeps that allowlist self-maintaining instead of hand-listed.
  const binDir = join(repoRoot, 'node_modules', '.bin');
  const bins = existsSync(binDir) ? readdirSync(binDir) : [];
  const BUILTINS = new Set([
    'install',
    'add',
    'remove',
    'update',
    'why',
    'store',
    'dlx',
    'exec',
    'run',
    'test',
    'list',
    'ls',
    'outdated',
    'licenses',
    'publish',
    'pack',
    'config',
    'env',
    'setup',
    'link',
    'unlink',
    'import',
    'rebuild',
    'prune',
    'fetch',
    'deploy',
    'patch',
    'audit',
    'bin',
    'root',
    'recursive',
    'dedupe',
    'up',
    'init',
    'create',
    'doctor',
    'start',
    'version',
  ]);

  for (const doc of ['README.md', 'README.zh-CN.md']) {
    it(`${doc} names no nonexistent pnpm script`, () => {
      const named = [...read(doc).matchAll(/\bpnpm (?:run )?([a-z][a-z0-9:-]*)/g)].map((m) => m[1] as string);
      const missing = [...new Set(named)].filter(
        (name) => !scripts.includes(name) && !BUILTINS.has(name) && !bins.includes(name),
      );
      expect(missing, `${doc} references missing script(s): ${missing.join(', ')}`).toEqual([]);
    });
  }
});
