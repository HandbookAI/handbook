/**
 * The repo registry's refusals, and how it survives its own file.
 *
 * `studio.json` is the only thing standing between two runs and one work dir:
 * the job mutex is keyed on repo NAME, so two entries that reach the same
 * directory are two writers in the same phase dirs with nothing between them.
 * Every check here is about paths that look different and are not.
 */
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from './state.js';

function scratch(stem: string): string {
  return mkdtempSync(join(tmpdir(), `hb-state-${stem}-`));
}

function sourceTree(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'main.py'), 'def main():\n    return 1\n');
  return dir;
}

describe('StateStore overlap refusals', () => {
  it('refuses a work dir that reaches another repo through a symlink', () => {
    // The lexical check compares two strings; a symlink makes two strings name
    // one directory. Both repos would then run in the same phase dirs, each
    // holding its own per-repo mutex and neither seeing the other.
    const root = scratch('worklink');
    const store = new StateStore(scratch('worklink-state'));
    const workA = join(root, 'work-a');
    mkdirSync(workA, { recursive: true });
    store.add({ name: 'a', sourceRoot: sourceTree(root, 'src-a'), workDir: workA });

    const alias = join(root, 'alias');
    symlinkSync(workA, alias);
    expect(() => store.add({ name: 'b', sourceRoot: sourceTree(root, 'src-b'), workDir: alias })).toThrow(
      /overlaps/,
    );
  });

  it('refuses a work dir that lands inside the source tree through a symlink', () => {
    // Artifacts inside the tree get re-analyzed on the next run: the handbook
    // starts describing itself, and every resync sees its own output as change.
    const root = scratch('inside');
    const store = new StateStore(scratch('inside-state'));
    const src = sourceTree(root, 'src');
    const link = join(root, 'link-into-src');
    symlinkSync(join(src, 'generated'), link);
    mkdirSync(join(src, 'generated'), { recursive: true });
    expect(() => store.add({ name: 'a', sourceRoot: src, workDir: link })).toThrow(/outside sourceRoot/);
  });

  it('still allows a work dir that only shares a name prefix', () => {
    // `/w/handbook` and `/w/handbook-2` are different directories. Refusing the
    // second would be the containment check reading a prefix as a parent.
    const root = scratch('prefix');
    const store = new StateStore(scratch('prefix-state'));
    store.add({ name: 'a', sourceRoot: sourceTree(root, 'src-a'), workDir: join(root, 'handbook') });
    expect(() =>
      store.add({ name: 'b', sourceRoot: sourceTree(root, 'src-b'), workDir: join(root, 'handbook-2') }),
    ).not.toThrow();
  });

  it('refuses a source tree already registered under another spelling', () => {
    const root = scratch('srclink');
    const store = new StateStore(scratch('srclink-state'));
    const src = sourceTree(root, 'src');
    store.add({ name: 'a', sourceRoot: src, workDir: join(root, 'w-a') });
    const alias = join(root, 'src-alias');
    symlinkSync(src, alias);
    expect(() => store.add({ name: 'b', sourceRoot: alias, workDir: join(root, 'w-b') })).toThrow(
      /one tree, one repo/,
    );
  });
});

describe('StateStore durability', () => {
  it('writes through a temp file and leaves no residue', () => {
    // A half-written studio.json is the whole registry gone: the next launch
    // cannot parse it and refuses to start. The write goes to a sibling and is
    // renamed over the target, so a reader sees the old file or the new one.
    const dir = scratch('durable');
    const root = scratch('durable-src');
    const store = new StateStore(dir);
    store.add({ name: 'a', sourceRoot: sourceTree(root, 'src'), workDir: join(root, 'w') });
    store.setTitle('a', 'A Handbook');
    const entries = readdirSync(dir);
    expect(entries).toContain('studio.json');
    expect(entries.filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(new StateStore(dir).get('a')?.title).toBe('A Handbook');
  });

  it('names the file and says what to do when the state file is unreadable', () => {
    // A raw zod issue list ("version: invalid literal") in a terminal at launch
    // tells the reader nothing about which file to look at or what to do next.
    const dir = scratch('corrupt');
    writeFileSync(join(dir, 'studio.json'), '{"version":1,"repos":[{"name');
    expect(() => new StateStore(dir)).toThrow(/studio\.json/);
    expect(() => new StateStore(dir)).toThrow(/remove/i);
  });
});
