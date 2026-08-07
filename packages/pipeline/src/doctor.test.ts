import { describe, expect, it } from 'vitest';
import { MockChatClient, type MockRule } from '@handbook/llm';
import type { Assignment, Skeleton, Stage } from '@handbook/core';
import {
  applyChange,
  computeStageStats,
  runDoctorRound,
  validateChange,
  type DoctorChange,
} from './doctor.js';

function stage(id: string, overrides: Partial<Stage> = {}): Stage {
  return {
    id,
    title: id.toUpperCase(),
    description: `${id} work.`,
    parent: null,
    children: [],
    crosscut: false,
    ...overrides,
  };
}

function makeSkeleton(stages: Stage[]): Skeleton {
  return { metadata: { version: 1, draftedBy: 'test' }, stages };
}

function makeAssignment(buckets: Record<string, string[]>, unassigned: string[] = []): Assignment {
  const fileStage: Assignment['fileStage'] = {};
  for (const [sid, files] of Object.entries(buckets)) {
    for (const file of files) fileStage[file] = { stage: sid, also: [] };
  }
  for (const file of unassigned) fileStage[file] = { stage: 'unassigned', also: [] };
  const nFiles = Object.keys(fileStage).length;
  return {
    version: 1,
    fileStage,
    buckets,
    coverage: { nFiles, nAssigned: nFiles - unassigned.length, unassigned: [...unassigned] },
  };
}

/** Fresh two-stage fixture: a (2 files), b (1 file), one unassigned file. */
function fixture(): { skeleton: Skeleton; assignment: Assignment } {
  return {
    skeleton: makeSkeleton([stage('a'), stage('b')]),
    assignment: makeAssignment({ a: ['a1.py', 'a2.py'], b: ['b1.py'] }, ['loose.py']),
  };
}

describe('validateChange — illegal proposals are rejected', () => {
  const { skeleton, assignment } = fixture();
  const reject = (change: DoctorChange): string | null => validateChange(change, skeleton, assignment);

  it('rejects an unknown action', () => {
    expect(reject({ action: 'rename_stage' })).toMatch(/unknown action/);
  });

  it('rejects add_stage without an id, or with a duplicate id', () => {
    expect(reject({ action: 'add_stage' })).toMatch(/missing new_stage\.id/);
    expect(reject({ action: 'add_stage', new_stage: { id: '   ' } })).toMatch(/missing new_stage\.id/);
    expect(reject({ action: 'add_stage', new_stage: { id: 'a' } })).toMatch(/already exists/);
  });

  it('rejects add_stage moves that misstate where a file currently lives', () => {
    const base = { action: 'add_stage', new_stage: { id: 'c' } };
    expect(reject({ ...base, move_files: [{ file: 'a1.py', from_stage: 'unassigned' }] })).toMatch(
      /not unassigned/,
    );
    expect(reject({ ...base, move_files: [{ file: 'loose.py', from_stage: 'a' }] })).toMatch(
      /not in stage a/,
    );
    expect(reject({ ...base, move_files: [{ from_stage: 'a' }] })).toMatch(/missing file/);
    expect(reject({ ...base, move_files: ['a1.py'] })).toMatch(/malformed/);
  });

  it('rejects remove_stage with an unknown id, or a populated stage without a landing spot', () => {
    expect(reject({ action: 'remove_stage', stage_id: 'nope' })).toMatch(/unknown stage_id/);
    expect(reject({ action: 'remove_stage', stage_id: 'a' })).toMatch(/needs a valid move_to/);
    expect(reject({ action: 'remove_stage', stage_id: 'a', move_to: 'gone' })).toMatch(
      /needs a valid move_to/,
    );
    expect(reject({ action: 'remove_stage', stage_id: 'a', move_to: 'a' })).toMatch(
      /move_to equals stage_id/,
    );
  });

  it('rejects malformed merge_stages', () => {
    expect(reject({ action: 'merge_stages' })).toMatch(/empty stages_to_merge/);
    expect(reject({ action: 'merge_stages', stages_to_merge: ['nope'], into: 'a' })).toMatch(
      /unknown source/,
    );
    expect(reject({ action: 'merge_stages', stages_to_merge: ['b'] })).toMatch(/missing into/);
    expect(reject({ action: 'merge_stages', stages_to_merge: ['b'], into: 'nope' })).toMatch(
      /unknown target/,
    );
  });

  // Actual behavior: {stages_to_merge:['a'], into:'a'} validates as null and applyChange
  // silently no-ops, yet still counts as an APPLIED change (skeletonChanged=true) in
  // runDoctorRound — a vacuous merge should be invalid, like split_stage's
  // "no non-source stage moves any files" guard.
  it('rejects merging a stage into itself (a no-op merge would count as progress)', () => {
    expect(reject({ action: 'merge_stages', stages_to_merge: ['a'], into: 'a' })).toMatch(/nothing to merge/);
  });

  it('rejects malformed split_stage', () => {
    expect(reject({ action: 'split_stage', source_stage: 'nope', new_stages: [] })).toMatch(
      /unknown source_stage/,
    );
    expect(reject({ action: 'split_stage', source_stage: 'a', new_stages: [] })).toMatch(/no new_stages/);
    expect(
      reject({ action: 'split_stage', source_stage: 'a', new_stages: [{ id: 'b', files: ['a1.py'] }] }),
    ).toMatch(/id collision b/);
    expect(
      reject({
        action: 'split_stage',
        source_stage: 'a',
        new_stages: [
          { id: 'a-1', files: ['a1.py'] },
          { id: 'a-1', files: ['a2.py'] },
        ],
      }),
    ).toMatch(/id collision a-1/);
    expect(
      reject({ action: 'split_stage', source_stage: 'a', new_stages: [{ id: 'a-1', files: ['b1.py'] }] }),
    ).toMatch(/not in source bucket/);
    expect(
      reject({ action: 'split_stage', source_stage: 'a', new_stages: [{ id: 'a-1', files: [] }] }),
    ).toMatch(/no non-source stage moves any files/);
  });

  it('accepts well-formed changes', () => {
    expect(
      reject({ action: 'add_stage', new_stage: { id: 'c' }, move_files: [{ file: 'loose.py' }] }),
    ).toBeNull();
    expect(reject({ action: 'remove_stage', stage_id: 'a', move_to: 'b' })).toBeNull();
    expect(reject({ action: 'merge_stages', stages_to_merge: ['b'], into: 'a' })).toBeNull();
    expect(
      reject({ action: 'split_stage', source_stage: 'a', new_stages: [{ id: 'a-1', files: ['a1.py'] }] }),
    ).toBeNull();
  });
});

describe('applyChange — legal changes are applied mechanically', () => {
  it('add_stage appends the stage and returns the moved files', () => {
    const { skeleton, assignment } = fixture();
    const affected = applyChange(
      skeleton,
      {
        action: 'add_stage',
        new_stage: { id: 'c', title: 'C', description: 'New home.', parent: 'null', crosscut: 'yes' },
        move_files: [{ file: 'loose.py', from_stage: 'unassigned' }],
      },
      assignment,
    );
    expect(affected).toEqual(['loose.py']);
    const added = skeleton.stages.find((s) => s.id === 'c');
    // String 'null' parent is coerced to null; a non-boolean crosscut is coerced to false.
    expect(added).toMatchObject({ id: 'c', title: 'C', parent: null, crosscut: false, children: [] });
  });

  it('remove_stage deletes the stage, re-parents its children, and returns its bucket', () => {
    const skeleton = makeSkeleton([
      stage('root'),
      stage('mid', { parent: 'root' }),
      stage('leaf', { parent: 'mid' }),
    ]);
    const assignment = makeAssignment({ root: [], mid: ['m1.py', 'm2.py'], leaf: [] });
    const affected = applyChange(
      skeleton,
      { action: 'remove_stage', stage_id: 'mid', move_to: 'root' },
      assignment,
    );
    expect(affected.sort()).toEqual(['m1.py', 'm2.py']);
    expect(skeleton.stages.map((s) => s.id)).toEqual(['root', 'leaf']);
    expect(skeleton.stages.find((s) => s.id === 'leaf')?.parent).toBe('root');
  });

  it('merge_stages removes the sources, re-parents their children, and returns their files', () => {
    const skeleton = makeSkeleton([stage('a'), stage('b'), stage('c'), stage('b-child', { parent: 'b' })]);
    const assignment = makeAssignment({ a: ['a1.py'], b: ['b1.py'], c: ['c1.py'], 'b-child': [] });
    const affected = applyChange(
      skeleton,
      { action: 'merge_stages', stages_to_merge: ['a', 'b', 'c'], into: 'a' },
      assignment,
    );
    expect(affected.sort()).toEqual(['b1.py', 'c1.py']); // target 'a' keeps its own files
    expect(skeleton.stages.map((s) => s.id)).toEqual(['a', 'b-child']);
    expect(skeleton.stages.find((s) => s.id === 'b-child')?.parent).toBe('a');
  });

  it('split_stage pushes the substages and returns the whole source bucket', () => {
    const { skeleton, assignment } = fixture();
    const affected = applyChange(
      skeleton,
      {
        action: 'split_stage',
        source_stage: 'a',
        new_stages: [
          { id: 'a', description: 'Narrowed to the core.' },
          { id: 'a-io', title: 'IO', files: ['a2.py'] },
        ],
      },
      assignment,
    );
    expect(affected.sort()).toEqual(['a1.py', 'a2.py']);
    expect(skeleton.stages.find((s) => s.id === 'a')?.description).toBe('Narrowed to the core.');
    expect(skeleton.stages.find((s) => s.id === 'a-io')).toMatchObject({
      title: 'IO',
      parent: 'a',
      crosscut: false,
    });
  });
});

describe('computeStageStats', () => {
  it('counts per-stage files, flags overload, and lists unassigned files', () => {
    const files = (prefix: string, n: number): string[] =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}.py`);
    const stages = [stage('big'), ...Array.from({ length: 9 }, (_, i) => stage(`s${i}`))];
    const buckets: Record<string, string[]> = { big: files('big/', 30) };
    for (let i = 0; i < 9; i += 1) buckets[`s${i}`] = files(`s${i}/`, 1);
    const stats = computeStageStats(makeSkeleton(stages), makeAssignment(buckets, ['stray.py']));
    // mean bucket size = 39/10 = 3.9 → floor = max(20, 9.75) = 20 → only 'big' (30) overloads.
    expect(stats.overloadFloor).toBe(20);
    expect(stats.perStage['big']).toEqual({ nFiles: 30, overloaded: true });
    expect(stats.perStage['s0']).toEqual({ nFiles: 1, overloaded: false });
    expect(stats.nUnassigned).toBe(1);
    expect(stats.unassigned).toEqual(['stray.py']);
    expect(stats.nFiles).toBe(40);
  });

  it('reports zero files for a stage with no bucket', () => {
    const stats = computeStageStats(makeSkeleton([stage('ghost')]), makeAssignment({}));
    expect(stats.perStage['ghost']).toEqual({ nFiles: 0, overloaded: false });
  });
});

describe('runDoctorRound — mechanical validate/apply/normalize interplay (mock LLM)', () => {
  it('applies valid changes, rejects invalid ones, and normalizeSkeleton renames a reserved id', async () => {
    const { skeleton, assignment } = fixture();
    const rules: MockRule[] = [
      {
        match: 'You are the SKELETON DOCTOR',
        respond: {
          changes: [
            {
              action: 'add_stage',
              // 'overview' collides with a fixed page name — validateChange accepts it,
              // normalizeSkeleton must rename it after apply.
              new_stage: {
                id: 'overview',
                title: 'Loose ends',
                description: 'Home for strays.',
                parent: null,
              },
              move_files: [{ file: 'loose.py', from_stage: 'unassigned' }],
            },
            { action: 'remove_stage', stage_id: 'does-not-exist' },
          ],
          rationale: 'house the unassigned file',
        },
      },
      {
        match: 'reviewing a proposed change to a codebase handbook',
        respond: { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'ok' },
      },
    ];
    const result = await runDoctorRound(new MockChatClient(rules), skeleton, assignment, {});

    expect(result).toMatchObject({ skeletonChanged: true, nProposed: 2, nApplied: 1, nRejected: 1 });
    expect(result.affectedFiles).toEqual(['loose.py']);
    const ids = skeleton.stages.map((s) => s.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).not.toContain('overview');
    const renamed = skeleton.stages.find((s) => s.title === 'Loose ends');
    expect(renamed).toBeDefined();
    expect(renamed?.id).toMatch(/^overview-/);
  });

  it('reports no change when the actor proposes nothing', async () => {
    const { skeleton, assignment } = fixture();
    const before = skeleton.stages.map((s) => s.id);
    const rules: MockRule[] = [
      { match: 'You are the SKELETON DOCTOR', respond: { changes: [], rationale: 'healthy' } },
      {
        match: 'reviewing a proposed change to a codebase handbook',
        respond: { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'ok' },
      },
    ];
    const result = await runDoctorRound(new MockChatClient(rules), skeleton, assignment, {});
    expect(result).toEqual({
      skeletonChanged: false,
      affectedFiles: [],
      nApplied: 0,
      nProposed: 0,
      nRejected: 0,
    });
    expect(skeleton.stages.map((s) => s.id)).toEqual(before);
  });
});
