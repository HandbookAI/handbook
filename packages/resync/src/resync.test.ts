import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeGraph, FileCard } from '@handbook/core';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { WorkDir, generateHandbook } from '@handbook/pipeline';
import {
  detectCardDetail,
  diffGraphs,
  filesFromDiff,
  loadCase,
  parsePlanDeclarations,
  resyncHandbook,
} from './resync.js';

function writeRepo(root: string): void {
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(
    join(root, 'app', 'main.py'),
    'from app.engine import Engine\n\ndef main():\n    e = Engine()\n    e.spin()\n',
  );
  writeFileSync(
    join(root, 'app', 'engine.py'),
    'class Engine:\n    def __init__(self):\n        self.rpm = 0\n\n    def spin(self):\n        self.rpm += 1\n        return self.rpm\n',
  );
}

function pipelineMock(): MockChatClient {
  const rules: MockRule[] = [
    {
      match: 'Files to describe',
      respond: (prompt) => ({
        purposes: [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => ({
          file: m[1],
          purpose: `Fresh purpose for ${m[1]}.`,
          role: 'domain_logic',
          lifecycle: 'main loop',
        })),
      }),
    },
    {
      match: 'dividing a large codebase into the STAGES',
      respond: {
        metadata: { archetype: 'demo' },
        stages: [
          { id: 'stage-1', title: 'Boot', description: 'Entry.', parent: null, crosscut: false },
          { id: 'stage-2', title: 'Engine', description: 'Work.', parent: null, crosscut: false },
        ],
      },
    },
    {
      match: 'assigning whole SOURCE FILES',
      respond: (prompt) => ({
        assignments: [...prompt.matchAll(/^- (\S+)  \(/gm)].map((m) => ({
          file: m[1],
          stage: m[1]?.includes('main') ? 'stage-1' : 'stage-2',
          also: [],
        })),
      }),
    },
    {
      match: 'organizing the files of ONE stage',
      respond: (prompt) => ({
        groups: [{ title: 'Core', summary: '', files: [...prompt.matchAll(/^- (\S+?)(?:  \[|\n)/gm)].map((m) => m[1]) }],
      }),
    },
    { match: 'STATE REGISTERS', respond: { registers: [] } },
    { match: 'COMPLETING a list of state registers', respond: { registers: [] } },
    { match: 'writing the OVERVIEW for one stage', respond: (p) => `Overview: ${p.length % 97}` },
    { match: 'top-level overview of a system handbook', respond: 'System overview.' },
  ];
  return new MockChatClient(rules);
}

function graphOf(
  files: Array<{ file: string; hash?: string; fns?: Array<{ name: string; lineStart: number }> }>,
): CodeGraph {
  const nodes: CodeGraph['nodes'] = {};
  for (const f of files) {
    for (const fn of f.fns ?? [{ name: 'f', lineStart: 1 }]) {
      const qual = `${f.file.replace(/\.py$/, '').split('/').join('.')}.${fn.name}`;
      nodes[qual] = {
        kind: 'internal',
        id: qual,
        name: fn.name,
        qualname: qual,
        file: f.file,
        lineStart: fn.lineStart,
        lineEnd: fn.lineStart + 2,
        signature: `${fn.name}()`,
        isAsync: false,
        isMethod: false,
        className: null,
        decorators: [],
        synthetic: false,
        selfAttrsRead: [],
        selfAttrsWritten: [],
        paramTypes: {},
        nCallees: 0,
        nCallers: 0,
      };
    }
  }
  const fileHashes: Record<string, string> = {};
  for (const f of files) {
    if (f.hash !== undefined) fileHashes[f.file] = f.hash;
  }
  return {
    version: 1,
    metadata: {
      generatedAt: 't',
      language: 'python',
      sourceRoot: '/tmp/x',
      scannedFiles: files.map((f) => f.file),
      fileHashes,
      nInternalFunctions: Object.keys(nodes).length,
      nBoundaryNodes: 0,
      nEdges: 0,
      policy: 'test',
    },
    nodes,
    edges: [],
    selfAttrs: {},
  };
}

describe('diffGraphs — per-file hash fallback (audit A3)', () => {
  it('does not flag a file that lacks a hash on both sides when its structure is unchanged', () => {
    const before = graphOf([{ file: 'a.py', hash: 'h1' }, { file: 'weird.py' }]);
    const after = graphOf([{ file: 'a.py', hash: 'h1' }, { file: 'weird.py' }]);
    const delta = diffGraphs(before, after);
    expect(delta.added).toEqual([]);
    expect(delta.changed).toEqual([]);
    expect(delta.deleted).toEqual([]);
  });

  it('falls back to structural fingerprints when a hash is missing on either side', () => {
    const before = graphOf([
      { file: 'a.py', hash: 'h1' },
      { file: 'weird.py', fns: [{ name: 'f', lineStart: 1 }] },
    ]);
    const after = graphOf([
      { file: 'a.py', hash: 'h1' },
      { file: 'weird.py', fns: [{ name: 'f', lineStart: 9 }] },
    ]);
    const delta = diffGraphs(before, after);
    expect(delta.changed).toEqual(['weird.py']);
    expect(delta.added).toEqual([]);
  });

  it('reports genuinely new scan-set entries as added', () => {
    const before = graphOf([{ file: 'a.py', hash: 'h1' }]);
    const after = graphOf([{ file: 'a.py', hash: 'h1' }, { file: 'b.py', hash: 'h2' }]);
    expect(diffGraphs(before, after).added).toEqual(['b.py']);
  });
});

describe('detectCardDetail (audit A5)', () => {
  const brief = { file: 'a.py', purpose: 'x', role: 'other', lifecycle: 'none' } as unknown as FileCard;
  const deep = {
    file: 'b.py',
    purpose: 'x',
    role: 'other',
    lifecycle: 'none',
    description: 'walkthrough',
    functions: [{ qualname: 'b.f' }],
  } as unknown as FileCard;

  it('detects brief from cards that carry no deep artifacts', () => {
    expect(detectCardDetail({ 'a.py': brief })).toBe('brief');
  });

  it('detects deep when any card carries function notes or a description', () => {
    expect(detectCardDetail({ 'a.py': brief, 'b.py': deep })).toBe('deep');
  });

  it('defaults to brief for an empty card set', () => {
    expect(detectCardDetail({})).toBe('brief');
  });
});

describe('resync helpers', () => {
  it('parses declarations from the last matching json block', () => {
    const plan = 'blah\n```json\n{"will_modify": ["Engine.spin"], "will_add": ["Engine.report"], "will_remove": []}\n```';
    const decl = parsePlanDeclarations(plan);
    expect(decl?.willModify).toEqual(['Engine.spin']);
    expect(decl?.willAdd).toEqual(['Engine.report']);
  });

  it('extracts files from a unified diff', () => {
    const diff = `--- a/app/engine.py\n+++ b/app/engine.py\n@@ -1 +1 @@\n-x\n+y\n--- /dev/null\n+++ b/app/new.py\n@@ -0,0 +1 @@\n+z\n`;
    expect(filesFromDiff(diff)).toEqual(['app/engine.py', 'app/new.py']);
  });
});

describe('resyncHandbook', () => {
  let sourceRoot: string;
  let workDir: string;
  let caseDir: string;

  beforeAll(async () => {
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-rs-src-'));
    workDir = mkdtempSync(join(tmpdir(), 'hb-rs-work-'));
    caseDir = mkdtempSync(join(tmpdir(), 'hb-rs-case-'));
    writeRepo(sourceRoot);
    await generateHandbook({ sourceRoot, workDir, client: pipelineMock(), phase: 'all' });

    // Build the case: edited tree = spin() gains a guard + a brand-new file; main.py untouched.
    const edited = join(caseDir, 'edited');
    cpSync(sourceRoot, edited, { recursive: true });
    writeFileSync(
      join(edited, 'app', 'engine.py'),
      'class Engine:\n    def __init__(self):\n        self.rpm = 0\n\n    def spin(self):\n        if self.rpm < 0:\n            self.rpm = 0\n        self.rpm += 1\n        return self.rpm\n',
    );
    writeFileSync(join(edited, 'app', 'report.py'), 'def report(rpm):\n    return f"rpm={rpm}"\n');
    writeFileSync(
      join(caseDir, 'plan.md'),
      'Guard spin against negatives; add report helper.\n```json\n{"will_modify": ["Engine.spin"], "will_add": ["report"], "will_remove": []}\n```\n',
    );
  });

  it('loadCase returns undefined for an empty diff', () => {
    const emptyCase = mkdtempSync(join(tmpdir(), 'hb-rs-empty-'));
    mkdirSync(join(emptyCase, 'edited'));
    writeFileSync(join(emptyCase, 'change.diff'), '\n');
    expect(loadCase(emptyCase)).toBeUndefined();
  });

  it('detects the delta and rolls cards/assignment/organization/narration forward', async () => {
    const report = await resyncHandbook({
      caseDir,
      workDir,
      client: pipelineMock(),
      detail: 'brief',
    });
    expect(report.skipped).toBe(false);
    expect(report.changedFiles).toContain('app/engine.py');
    expect(report.addedFiles).toContain('app/report.py');
    expect(report.deletedFiles).toEqual([]);
    expect(report.affectedStages.length).toBeGreaterThan(0);
    expect(report.narrated).toBe(true);

    const work = new WorkDir(workDir);
    const cards = work.loadCards();
    expect(cards['app/report.py']?.purpose).toContain('Fresh purpose');
    const assignment = work.loadAssignment();
    expect(assignment.fileStage['app/report.py']?.stage).toBe('stage-2');
    const graph = work.loadGraph();
    expect(graph.metadata.scannedFiles).toContain('app/report.py');
  });

  it('preserves surviving organization groups and appends added files in a new group (audit A4)', () => {
    const work = new WorkDir(workDir);
    const org = work.loadOrganization();
    const stage2 = org.stages['stage-2'];
    // The pre-existing grouping must survive a resync — only pruned/appended,
    // never replaced wholesale by a synthetic group.
    const engineGroup = stage2?.groups.find((g) => g.files.some((f) => f.file === 'app/engine.py'));
    expect(engineGroup).toBeDefined();
    expect(engineGroup?.title).not.toBe('(resynced)');
    const resynced = stage2?.groups.find((g) => g.title === '(resynced)');
    expect(resynced?.files.map((f) => f.file)).toContain('app/report.py');
    expect(stage2?.orderedFiles).toContain('app/report.py');
  });

  it('detects card detail from the existing handbook when not specified (audit A5)', async () => {
    const source3 = mkdtempSync(join(tmpdir(), 'hb-rs-src3-'));
    const work3 = mkdtempSync(join(tmpdir(), 'hb-rs-work3-'));
    const case3 = mkdtempSync(join(tmpdir(), 'hb-rs-case3-'));
    writeRepo(source3);
    // Brief-built handbook (pipeline default detail is brief).
    await generateHandbook({ sourceRoot: source3, workDir: work3, client: pipelineMock(), phase: 'all' });
    const edited = join(case3, 'edited');
    cpSync(source3, edited, { recursive: true });
    writeFileSync(join(edited, 'app', 'engine.py'), 'class Engine:\n    def spin(self):\n        return 7\n');

    const client = pipelineMock();
    await resyncHandbook({ caseDir: case3, workDir: work3, client });
    const cardPrompts = client.calls.filter((c) => c.prompt.includes('Files to describe'));
    expect(cardPrompts.length).toBeGreaterThan(0);
    // A brief handbook must resync with brief card prompts, not silently upgrade to deep.
    expect(cardPrompts.some((c) => c.prompt.includes('SOURCE FILES IN FULL'))).toBe(false);
  });

  it('noLlm mode refreshes structure and marks prose stale', async () => {
    const source2 = mkdtempSync(join(tmpdir(), 'hb-rs-src2-'));
    const work2 = mkdtempSync(join(tmpdir(), 'hb-rs-work2-'));
    const case2 = mkdtempSync(join(tmpdir(), 'hb-rs-case2-'));
    writeRepo(source2);
    await generateHandbook({ sourceRoot: source2, workDir: work2, client: pipelineMock(), phase: 'all' });
    const edited = join(case2, 'edited');
    cpSync(source2, edited, { recursive: true });
    writeFileSync(join(edited, 'app', 'engine.py'), 'class Engine:\n    def spin(self):\n        return 7\n');
    rmSync(join(edited, 'app', 'main.py'));

    const report = await resyncHandbook({ caseDir: case2, workDir: work2, noLlm: true });
    expect(report.narrated).toBe(false);
    expect(report.deletedFiles).toContain('app/main.py');
    const work = new WorkDir(work2);
    expect(work.loadCards()['app/engine.py']?.purpose).toMatch(/stale/);
    expect(work.loadAssignment().fileStage['app/main.py']).toBeUndefined();
    // A stage emptied by a deletion is pruned, not replaced with a synthetic group (audit A4).
    const org = work.loadOrganization();
    expect(org.stages['stage-1']?.groups).toEqual([]);
    expect(org.stages['stage-1']?.orderedFiles).toEqual([]);
  });
});
