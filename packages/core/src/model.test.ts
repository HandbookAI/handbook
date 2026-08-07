import { describe, expect, it } from 'vitest';
import { StageTree, coerceRole, type Skeleton } from './model.js';

const skeleton: Skeleton = {
  metadata: { version: 1, archetype: 'test system' },
  stages: [
    { id: 'stage-1', title: 'Boot', description: 'Startup.', parent: null, children: [], crosscut: false },
    {
      id: 'stage-1.1',
      title: 'Config',
      description: 'Load config.',
      parent: 'stage-1',
      children: [],
      crosscut: false,
    },
    { id: 'stage-2', title: 'Run', description: 'Main loop.', parent: null, children: [], crosscut: false },
    { id: 'crosscut-1', title: 'Logging', description: 'Logs.', parent: null, children: [], crosscut: true },
    {
      id: 'stage-9',
      title: 'Orphan',
      description: 'Dangling parent.',
      parent: 'ghost',
      children: [],
      crosscut: false,
    },
  ],
};

describe('StageTree', () => {
  const tree = new StageTree(skeleton);

  it('derives children from parents, ignoring stale children lists', () => {
    expect(tree.children('stage-1')).toEqual(['stage-1.1']);
    expect(tree.children('stage-2')).toEqual([]);
  });

  it('treats dangling parents as top-level', () => {
    expect(tree.topLevel).toEqual(['stage-1', 'stage-2', 'crosscut-1', 'stage-9']);
  });

  it('computes depth', () => {
    expect(tree.depth('stage-1')).toBe(0);
    expect(tree.depth('stage-1.1')).toBe(1);
    expect(tree.depth('stage-9')).toBe(0);
  });

  it('returns subtrees in skeleton order', () => {
    expect(tree.subtree('stage-1')).toEqual(['stage-1', 'stage-1.1']);
  });

  it('falls back to the id for unknown titles', () => {
    expect(tree.title('nope')).toBe('nope');
  });
});

describe('coerceRole', () => {
  it('keeps valid roles and coerces invalid ones', () => {
    expect(coerceRole('config')).toBe('config');
    expect(coerceRole('banana')).toBe('other');
    expect(coerceRole(undefined)).toBe('other');
  });
});

describe('StageTree — cycle safety (round-1 review)', () => {
  it('subtree terminates on a two-node parent cycle', () => {
    const cyclic: Skeleton = {
      metadata: { version: 1 },
      stages: [
        { id: 'a', title: 'A', description: '', parent: 'b', children: [], crosscut: false },
        { id: 'b', title: 'B', description: '', parent: 'a', children: [], crosscut: false },
      ],
    };
    const tree = new StageTree(cyclic);
    expect(tree.subtree('a').sort()).toEqual(['a', 'b']);
  });
});

describe('StageTree — stack safety (adversarial pass 2)', () => {
  it('subtree does not overflow on a deep parent chain in a corrupted skeleton', () => {
    // subtree used to recurse per level; a long chain (valid to zod) overflowed.
    const n = 20000;
    const stages: Skeleton['stages'] = [];
    for (let i = 0; i < n; i += 1) {
      stages.push({
        id: `s${i}`,
        title: '',
        description: '',
        parent: i === 0 ? null : `s${i - 1}`,
        children: [],
        crosscut: false,
      });
    }
    const tree = new StageTree({ metadata: { version: 1 }, stages });
    expect(() => tree.subtree('s0')).not.toThrow();
    expect(tree.subtree('s0')).toHaveLength(n);
  });
});
