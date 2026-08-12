import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listFilesRecursive, readTextFileBounded } from './fsx.js';

/**
 * Real directories in a temp dir, never a mocked fs: every property under test
 * here — symlink handling, an unreadable directory, recursion depth — is a
 * property of the operating system, and a mock would only assert that the mock
 * was written to match the assertion.
 */
const made: Array<() => void> = [];
afterAll(() => {
  for (const undo of made.splice(0)) undo();
});

function tree(): string {
  return mkdtempSync(join(tmpdir(), 'hb-fsx-'));
}

describe('listFilesRecursive', () => {
  it('returns relative POSIX paths, sorted, and does not follow symlinks', () => {
    const root = tree();
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'b.ts'), '');
    writeFileSync(join(root, 'src', 'a.ts'), '');
    writeFileSync(join(root, 'src', 'deep', 'c.ts'), '');
    const outside = tree();
    writeFileSync(join(outside, 'elsewhere.ts'), '');
    symlinkSync(outside, join(root, 'link'));

    expect(listFilesRecursive(root, { extensions: ['.ts'] })).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/deep/c.ts',
    ]);
  });

  describe('a directory it cannot enter', () => {
    it('is reported rather than silently erased', () => {
      // Every path beneath an unreadable directory vanishes from the results.
      // Saying nothing makes that indistinguishable from "there was nothing
      // there" — the same silent erasure the unparsed-file record exists to
      // prevent, one level up.
      const root = tree();
      mkdirSync(join(root, 'ok'));
      writeFileSync(join(root, 'ok', 'seen.ts'), '');
      const locked = join(root, 'locked');
      mkdirSync(locked);
      writeFileSync(join(locked, 'hidden.ts'), '');
      chmodSync(locked, 0o000);
      made.push(() => chmodSync(locked, 0o755));

      const skipped: Array<[string, string]> = [];
      const files = listFilesRecursive(root, {
        extensions: ['.ts'],
        onSkip: (path, reason) => skipped.push([path, reason]),
      });

      // Running as root defeats a 000 mode, so the file is simply visible and
      // there is nothing to report. Assert the pair, not one half of it.
      if (files.includes('locked/hidden.ts')) {
        expect(skipped).toEqual([]);
      } else {
        expect(files).toEqual(['ok/seen.ts']);
        expect(skipped.map(([path]) => path)).toEqual(['locked']);
        expect(skipped[0]?.[1]).toBeTruthy();
      }
    });

    it('still returns everything it could reach', () => {
      const root = tree();
      writeFileSync(join(root, 'top.ts'), '');
      const locked = join(root, 'nope');
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      made.push(() => chmodSync(locked, 0o755));
      expect(listFilesRecursive(root, { extensions: ['.ts'] })).toContain('top.ts');
    });
  });

  describe('depth', () => {
    it('refuses to descend past the ceiling, and says which directory it stopped at', () => {
      const root = tree();
      let path = root;
      for (let i = 0; i < 8; i += 1) {
        path = join(path, `d${i}`);
        mkdirSync(path);
        writeFileSync(join(path, `f${i}.ts`), '');
      }
      const skipped: string[] = [];
      const files = listFilesRecursive(root, {
        extensions: ['.ts'],
        maxDepth: 3,
        onSkip: (p) => skipped.push(p),
      });
      expect(files).toEqual(['d0/f0.ts', 'd0/d1/f1.ts', 'd0/d1/d2/f2.ts'].sort());
      expect(skipped).toEqual(['d0/d1/d2/d3']);
    });

    it('reaches an ordinary tree without complaint', () => {
      // The ceiling must be far above any real layout, or it becomes a bug that
      // only shows up on somebody else's repository.
      const root = tree();
      let path = root;
      for (let i = 0; i < 12; i += 1) {
        path = join(path, `d${i}`);
        mkdirSync(path);
      }
      writeFileSync(join(path, 'deep.ts'), '');
      const skipped: string[] = [];
      const files = listFilesRecursive(root, { extensions: ['.ts'], onSkip: (p) => skipped.push(p) });
      expect(skipped).toEqual([]);
      expect(files).toHaveLength(1);
    });

    it('does not die of a RangeError on a tree deeper than the stack', () => {
      // The walk is recursive. Without the ceiling this throws out of the whole
      // run, and a discovery crash reads as an analyzer bug rather than as an
      // unusual repository.
      const root = tree();
      let path = root;
      for (let i = 0; i < 200; i += 1) {
        path = join(path, 'd');
        mkdirSync(path);
      }
      writeFileSync(join(path, 'bottom.ts'), '');
      expect(() => listFilesRecursive(root, { extensions: ['.ts'], maxDepth: 20 })).not.toThrow();
    });
  });

  it('reports the root itself when the root is what cannot be read', () => {
    const root = tree();
    const inner = join(root, 'sealed');
    mkdirSync(inner);
    chmodSync(inner, 0o000);
    made.push(() => chmodSync(inner, 0o755));
    const skipped: string[] = [];
    const files = listFilesRecursive(inner, { onSkip: (p) => skipped.push(p) });
    if (files.length === 0) expect(skipped).toEqual(['.']);
  });
});

describe('readTextFileBounded', () => {
  it('reads a file that fits', () => {
    const root = tree();
    writeFileSync(join(root, 'small.txt'), 'hello');
    expect(readTextFileBounded(join(root, 'small.txt'), 1024, 'the thing')).toBe('hello');
  });

  it('refuses a file above the ceiling, naming the thing and both sizes', () => {
    // "A file was too big" sends the reader nowhere. The message has to say
    // WHICH input, how big it actually is, and what the limit was.
    const root = tree();
    const path = join(root, 'big.diff');
    writeFileSync(path, 'x'.repeat(4096));
    expect(() => readTextFileBounded(path, 1024, 'the diff')).toThrow(/the diff/);
    expect(() => readTextFileBounded(path, 1024, 'the diff')).toThrow(/MiB.*limit/);
    expect(() => readTextFileBounded(path, 1024, 'the diff')).toThrow(
      new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('does not read the file it refuses', () => {
    // The whole point is never to hold it in memory. A `stat` decides.
    const root = tree();
    const path = join(root, 'huge.diff');
    writeFileSync(path, 'y'.repeat(8192));
    let threw = false;
    try {
      readTextFileBounded(path, 100, 'the diff');
    } catch (error) {
      threw = true;
      // The size in the message comes from stat, so it is exact even though
      // nothing was read.
      expect(String(error)).toContain('0.0 MiB');
    }
    expect(threw).toBe(true);
  });
});
