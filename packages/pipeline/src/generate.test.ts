import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { expandPhases, generateHandbook, loadHandbookModel } from './generate.js';
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

/** Mock LLM covering every pipeline prompt with deterministic responses. */
function mockClient(): MockChatClient {
  const rules: MockRule[] = [
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
          { id: 'stage-2', title: 'Engine', description: 'Core spinning work.', parent: null, crosscut: false },
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
    { match: 'STATE REGISTERS', respond: { registers: [{ id: 'reg-rpm', semantics: 'Current engine rpm.', stages: ['stage-2'] }] } },
    { match: 'COMPLETING a list of state registers', respond: { registers: [] } },
    { match: 'writing the OVERVIEW for one stage', respond: 'This stage boots the demo and hands control to the engine.' },
    { match: 'top-level overview of a system handbook', respond: 'The demo system spins an engine from a tiny entry point.' },
  ];
  return new MockChatClient(rules);
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

  it('phase 3 rerun hits the narration cache (no new LLM calls for summaries)', async () => {
    const client = mockClient();
    await generateHandbook({ sourceRoot, workDir, client, phase: '3', narrateLang: 'en' });
    const summaryCalls = client.calls.filter((c) => c.prompt.includes('writing the OVERVIEW'));
    expect(summaryCalls).toHaveLength(0);
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
