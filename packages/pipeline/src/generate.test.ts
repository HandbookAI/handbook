import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { expandPhases, generateHandbook, loadHandbookModel, runManifestSchema } from './generate.js';
import { WorkDir } from './workdir.js';

/** A tiny two-module python project. */
function writeFixtureRepo(root: string): void {
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'main.py'),
    `from app.engine import Engine

def main():
    e = Engine()
    e.spin()
`,
  );
  writeFileSync(
    join(root, 'app', 'engine.py'),
    `class Engine:
    def __init__(self):
        self.rpm = 0

    def spin(self):
        self.rpm += 1
        return self.rpm
`,
  );
}

/** Deterministic responses for every pipeline prompt, as reusable rules. */
function mockRules(): MockRule[] {
  return [
    {
      match: 'Files to describe',
      respond: (prompt) => {
        const files = [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => m[1]);
        return {
          purposes: files.map((file) => ({
            file,
            purpose: `Handles ${file}.`,
            role: file?.includes('main') ? 'entrypoint' : 'domain_logic',
            lifecycle: file?.includes('main') ? 'startup' : 'main loop',
          })),
        };
      },
    },
    {
      match: 'dividing a large codebase into the STAGES',
      respond: {
        metadata: { archetype: 'demo engine' },
        stages: [
          { id: 'stage-1', title: 'Boot', description: 'Entry point wiring.', parent: null, crosscut: false },
          {
            id: 'stage-2',
            title: 'Engine',
            description: 'Core spinning work.',
            parent: null,
            crosscut: false,
          },
        ],
      },
    },
    {
      match: 'assigning whole SOURCE FILES',
      respond: (prompt) => {
        const files = [...prompt.matchAll(/^- (\S+)  \(/gm)].map((m) => m[1]);
        return {
          assignments: files.map((file) => ({
            file,
            stage: file?.includes('main') ? 'stage-1' : 'stage-2',
            also: [],
          })),
        };
      },
    },
    {
      match: 'organizing the files of ONE stage',
      respond: (prompt) => {
        const files = [...prompt.matchAll(/^- (\S+?)(?:  \[|\n)/gm)].map((m) => m[1]);
        return { groups: [{ title: 'Core', summary: 'The work.', files }] };
      },
    },
    {
      match: 'STATE REGISTERS',
      respond: {
        // Two stages, because a register is cross-stage state by definition and a
        // single-stage one is now discarded — see extractRegisters.
        registers: [{ id: 'reg-rpm', semantics: 'Current engine rpm.', stages: ['stage-1', 'stage-2'] }],
      },
    },
    { match: 'COMPLETING a list of state registers', respond: { registers: [] } },
    {
      match: 'writing the OVERVIEW for one stage',
      respond: 'This stage boots the demo and hands control to the engine.',
    },
    {
      match: 'top-level overview of a system handbook',
      respond: 'The demo system spins an engine from a tiny entry point.',
    },
  ];
}

/** Mock LLM covering every pipeline prompt with deterministic responses. */
function mockClient(): MockChatClient {
  return new MockChatClient(mockRules());
}

describe('expandPhases', () => {
  it('expands aliases and comma lists', () => {
    expect([...expandPhases('all')].sort()).toEqual(['1', '2a', '2b', '2c', '3']);
    expect([...expandPhases('2')].sort()).toEqual(['2a', '2b', '2c']);
    expect([...expandPhases('2c,3')].sort()).toEqual(['2c', '3']);
  });
  it('rejects unknown tokens', () => {
    expect(() => expandPhases('9')).toThrow(/unknown phase/);
  });
});

describe('generateHandbook (file strategy, mock LLM)', () => {
  let sourceRoot: string;
  let workDir: string;

  beforeAll(async () => {
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-'));
    workDir = mkdtempSync(join(tmpdir(), 'hb-work-'));
    writeFixtureRepo(sourceRoot);
    await generateHandbook({
      sourceRoot,
      workDir,
      client: mockClient(),
      phase: 'all',
      narrateLang: 'en',
    });
  });

  it('writes every artifact', () => {
    const work = new WorkDir(workDir);
    for (const path of [
      work.graphPath,
      work.skeletonPath,
      work.assignmentPath,
      work.organizationPath,
      work.narrationPath,
      work.registersPath,
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(existsSync(work.cardPath('app/main.py'))).toBe(true);
  });

  it('assigns every file and organizes every stage', () => {
    const work = new WorkDir(workDir);
    const assignment = work.loadAssignment();
    expect(assignment.coverage.unassigned).toEqual([]);
    expect(assignment.buckets['stage-1']).toContain('app/main.py');
    const organization = work.loadOrganization();
    expect(organization.coverage.nOrganized).toBe(organization.coverage.nFiles);
  });

  it('produces narration with summaries for content stages and caches them', () => {
    const work = new WorkDir(workDir);
    const narration = work.loadNarration();
    expect(narration.systemOverview).toContain('demo system');
    expect(Object.keys(narration.stageSummaries).sort()).toEqual(['stage-1', 'stage-2']);
    expect(existsSync(work.cacheDir)).toBe(true);
  });

  it('loads a complete HandbookModel', () => {
    const model = loadHandbookModel(workDir, 'Demo Handbook');
    expect(model.title).toBe('Demo Handbook');
    expect(model.registers).toHaveLength(1);
    expect(model.skeleton.stages).toHaveLength(2);
    expect(Object.keys(model.cards)).toHaveLength(2);
  });

  it('writes a run manifest recording model, phases, timing and stats', () => {
    const raw = JSON.parse(readFileSync(join(workDir, 'run-manifest.json'), 'utf8'));
    const manifest = runManifestSchema.parse(raw);
    expect(manifest.model).toBe('mock');
    expect(manifest.phases).toEqual(['1', '2a', '2b', '2c', '3']);
    expect(manifest.usage).toBeNull(); // MockChatClient reports no usage
    expect(manifest.stats).toMatchObject({ nCards: 2, nStages: 2, nRegisters: 1 });
    expect(Date.parse(manifest.startedAt)).not.toBeNaN();
    expect(Date.parse(manifest.finishedAt)).not.toBeNaN();
    expect(Date.parse(manifest.finishedAt)).toBeGreaterThanOrEqual(Date.parse(manifest.startedAt));
  });

  it('phase 3 rerun hits the narration cache (no new LLM calls for summaries)', async () => {
    const client = mockClient();
    await generateHandbook({ sourceRoot, workDir, client, phase: '3', narrateLang: 'en' });
    const summaryCalls = client.calls.filter((c) => c.prompt.includes('writing the OVERVIEW'));
    expect(summaryCalls).toHaveLength(0);
  });

  it('refuses to run while another process holds the work-dir lock', async () => {
    const src = mkdtempSync(join(tmpdir(), 'hb-gen-lock-src-'));
    writeFixtureRepo(src);
    const lockedWork = mkdtempSync(join(tmpdir(), 'hb-gen-lock-work-'));
    writeFileSync(
      join(lockedWork, '.lock'),
      JSON.stringify({ pid: 2147483646, host: 'some-other-machine', startedAt: '2000-01-01T00:00:00Z' }),
    );
    await expect(
      generateHandbook({ sourceRoot: src, workDir: lockedWork, client: mockClient(), phase: '1' }),
    ).rejects.toThrow(/another handbook run/);
  });
});

describe('run manifest', () => {
  it('records usage from a client that reports it, refreshed on every run', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-manifest-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-manifest-'));
    writeFixtureRepo(sourceRoot);
    // Phase 1 needs no LLM, but a supplied client must still be identified in
    // the manifest — usage() is optional on ChatClient, discovered by shape.
    const client = Object.assign(mockClient(), {
      usage: () => ({ calls: 3, promptTokens: 120, completionTokens: 45 }),
    });
    await generateHandbook({ sourceRoot, workDir, client, phase: '1' });
    const first = runManifestSchema.parse(
      JSON.parse(readFileSync(join(workDir, 'run-manifest.json'), 'utf8')),
    );
    expect(first.model).toBe('mock');
    expect(first.phases).toEqual(['1']);
    expect(first.usage).toEqual({ calls: 3, promptTokens: 120, completionTokens: 45 });

    // A later run replaces the manifest: it describes the LAST successful run.
    await generateHandbook({ sourceRoot, workDir, client: mockClient(), phase: '1' });
    const second = runManifestSchema.parse(
      JSON.parse(readFileSync(join(workDir, 'run-manifest.json'), 'utf8')),
    );
    expect(second.usage).toBeNull();
  });

  it('records null model and usage for a clientless phase-1 run', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-manifest2-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-manifest2-'));
    writeFixtureRepo(sourceRoot);
    await generateHandbook({ sourceRoot, workDir, phase: '1' });
    const manifest = runManifestSchema.parse(
      JSON.parse(readFileSync(join(workDir, 'run-manifest.json'), 'utf8')),
    );
    expect(manifest.model).toBeNull();
    expect(manifest.usage).toBeNull();
  });

  it('does not write a manifest for a failed run', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-manifest3-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-manifest3-'));
    writeFixtureRepo(sourceRoot);
    // Phase 2a without a client fails the prerequisite check.
    await expect(generateHandbook({ sourceRoot, workDir, phase: '2a' })).rejects.toThrow(/LLM client/);
    expect(existsSync(join(workDir, 'run-manifest.json'))).toBe(false);
  });
});

describe('generateHandbook cooperative cancellation', () => {
  it('rejects a pre-aborted run with an AbortError and writes no run manifest', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-abort1-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-abort1-'));
    writeFixtureRepo(sourceRoot);
    const client = mockClient();
    const controller = new AbortController();
    controller.abort();
    const error = await generateHandbook({
      sourceRoot,
      workDir,
      client,
      phase: 'all',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(existsSync(join(workDir, 'run-manifest.json'))).toBe(false);
    expect(client.calls).toHaveLength(0); // no LLM call was ever issued
  });

  it('mid-run abort rejects, keeps already-written cards, writes no manifest, and releases the lock', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-abort2-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-abort2-'));
    writeFixtureRepo(sourceRoot);
    // The first cards batch flips the controller from INSIDE the mock — the
    // abort lands while the run is mid-phase, before the second batch starts.
    const controller = new AbortController();
    const abortingClient = new MockChatClient([
      {
        match: 'Files to describe',
        respond: (prompt) => {
          const files = [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => m[1]);
          controller.abort();
          return {
            purposes: files.map((file) => ({
              file,
              purpose: `Handles ${file}.`,
              role: 'other',
              lifecycle: 'none',
            })),
          };
        },
      },
    ]);
    const error = await generateHandbook({
      sourceRoot,
      workDir,
      client: abortingClient,
      phase: 'all',
      readBatchSize: 1,
      readWorkers: 1, // sequential batches: batch 1 answers (and aborts), batch 2 must never start
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(abortingClient.calls).toHaveLength(1);

    // Partial artifacts stay on disk (same contract as a crash)…
    const cards = new WorkDir(workDir).loadCards();
    expect(Object.keys(cards)).toHaveLength(1);
    // …but the manifest describes only SUCCESSFUL runs, so there is none.
    expect(existsSync(join(workDir, 'run-manifest.json'))).toBe(false);

    // The work-dir lock was released: a follow-up run succeeds.
    await generateHandbook({ sourceRoot, workDir, client: mockClient(), phase: 'all' });
    expect(existsSync(join(workDir, 'run-manifest.json'))).toBe(true);
  });

  it('an abort inside the skeleton doctor rejects and leaves no phase-2b artifact', async () => {
    // The doctor is the deepest LLM path in the pipeline — generate → doctor →
    // actor/critic panel — and it was the one the signal never reached. A
    // cancelled panel came back as a healthy no-op round, so the loop broke out
    // with a "converged" skeleton and phase 2b wrote it to disk.
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src-abort4-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work-abort4-'));
    writeFixtureRepo(sourceRoot);
    await generateHandbook({ sourceRoot, workDir, client: mockClient(), phase: '1,2a' });

    const controller = new AbortController();
    const client = new MockChatClient([
      { match: 'You are the SKELETON DOCTOR', respond: { changes: [], rationale: 'healthy' } },
      {
        match: 'reviewing a proposed change to a codebase handbook',
        respond: () => {
          controller.abort();
          return { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'ok' };
        },
      },
      ...mockRules(),
    ]);
    const error = await generateHandbook({
      sourceRoot,
      workDir,
      client,
      phase: '2b',
      synthMode: 'doctor',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    // Nothing phase 2b would have written landed, and the manifest still
    // describes the earlier run — so the work dir reads as "2b never ran".
    expect(existsSync(join(workDir, 'phase2', 'skeleton.yaml'))).toBe(false);
    expect(existsSync(join(workDir, 'phase2', 'assignment.json'))).toBe(false);
    const manifest = runManifestSchema.parse(
      JSON.parse(readFileSync(join(workDir, 'run-manifest.json'), 'utf8')),
    );
    expect(manifest.phases).toEqual(['1', '2a']);
  });
});

describe('generateHandbook (member strategy, mock LLM)', () => {
  it('classifies members against a user skeleton and derives file artifacts', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-src2-'));
    const workDir = mkdtempSync(join(tmpdir(), 'hb-work2-'));
    writeFixtureRepo(sourceRoot);
    const skeletonPath = join(workDir, 'skeleton.yaml');
    writeFileSync(
      skeletonPath,
      `metadata:
  version: 1
  archetype: demo engine
stages:
  - id: stage-1
    title: Boot
    description: Entry point wiring.
    parent: null
    children: []
    crosscut: false
  - id: stage-2
    title: Engine
    description: Core spinning work.
    parent: null
    children: []
    crosscut: false
`,
    );
    const client = new MockChatClient([
      {
        match: 'Files to describe',
        respond: (prompt) => ({
          purposes: [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => ({
            file: m[1],
            purpose: 'x',
            role: 'other',
            lifecycle: 'none',
          })),
        }),
      },
      {
        match: 'assigning individual FUNCTIONS',
        respond: (prompt) => ({
          assignments: [...prompt.matchAll(/^- (\S+)$/gm)].map((m) => ({
            member: m[1],
            stage: m[1]?.includes('main') ? 'stage-1' : 'stage-2',
          })),
        }),
      },
      { match: 'STATE REGISTERS', respond: { registers: [] } },
      { match: 'COMPLETING a list', respond: { registers: [] } },
      { match: 'writing the OVERVIEW for one stage', respond: 'Stage prose.' },
      { match: 'top-level overview', respond: 'System prose.' },
    ]);
    await generateHandbook({
      sourceRoot,
      workDir,
      client,
      phase: 'all',
      strategy: 'member',
      skeletonPath,
    });
    const work = new WorkDir(workDir);
    const assignment = work.loadAssignment();
    expect(assignment.buckets['stage-1']).toContain('app/main.py');
    expect(assignment.buckets['stage-2']).toContain('app/engine.py');
    const members = JSON.parse(readFileSync(join(work.phase2Dir, 'members.json'), 'utf8'));
    expect(members.coverage.nMembers).toBeGreaterThanOrEqual(3);
    expect(existsSync(work.organizationPath)).toBe(true);
  });
});

describe('normalizeSkeleton — reserved ids and cycles (round-2 review)', () => {
  it('suffixes stage ids that collide with fixed page names', async () => {
    const { normalizeSkeleton } = await import('./skeleton.js');
    const skeleton = normalizeSkeleton({
      stages: [
        { id: 'overview', title: 'O', description: 'x' },
        { id: 'Index', title: 'I', description: 'x' },
        { id: 'stage-1', title: 'S', description: 'x' },
      ],
    });
    const ids = skeleton.stages.map((s) => s.id);
    expect(ids).toContain('stage-1');
    expect(ids).not.toContain('overview');
    expect(ids.map((i) => i.toLowerCase())).not.toContain('index');
  });

  it('breaks parent cycles at a cycle member, keeping innocent descendants attached', async () => {
    const { normalizeSkeleton } = await import('./skeleton.js');
    const skeleton = normalizeSkeleton({
      stages: [
        { id: 'd', title: 'D', description: 'x', parent: 'a' },
        { id: 'a', title: 'A', description: 'x', parent: 'b' },
        { id: 'b', title: 'B', description: 'x', parent: 'a' },
      ],
    });
    const byId = new Map(skeleton.stages.map((s) => [s.id, s]));
    expect(byId.get('d')?.parent).toBe('a');
    const cycleParents = [byId.get('a')?.parent, byId.get('b')?.parent];
    expect(cycleParents).toContain(null);
  });
});

describe('normalizeSkeleton — rename remap (round-3 review)', () => {
  it('re-points children at the renamed id instead of orphaning them', async () => {
    const { normalizeSkeleton } = await import('./skeleton.js');
    const skeleton = normalizeSkeleton({
      stages: [
        { id: 'overview', title: 'O', description: 'x' },
        { id: 'child', title: 'C', description: 'x', parent: 'overview' },
      ],
    });
    const byId = new Map(skeleton.stages.map((s) => [s.id, s]));
    const renamed = skeleton.stages.find((s) => s.title === 'O');
    expect(renamed?.id).not.toBe('overview');
    expect(byId.get('child')?.parent).toBe(renamed?.id);
  });
});
