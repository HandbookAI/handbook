import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { WorkDir, generateHandbook } from '@handbook/pipeline';
import { filesFromDiff, loadCase, parsePlanDeclarations, resyncHandbook } from './resync.js';

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
  });
});
