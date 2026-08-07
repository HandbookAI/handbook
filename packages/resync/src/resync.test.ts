import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CodeGraph, FileCard } from '@handbook/core';
import { MockChatClient, type ChatClient, type MockRule } from '@handbook/llm';
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
        groups: [
          {
            title: 'Core',
            summary: '',
            files: [...prompt.matchAll(/^- (\S+?)(?:  \[|\n)/gm)].map((m) => m[1]),
          },
        ],
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
    const after = graphOf([
      { file: 'a.py', hash: 'h1' },
      { file: 'b.py', hash: 'h2' },
    ]);
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
    const plan =
      'blah\n```json\n{"will_modify": ["Engine.spin"], "will_add": ["Engine.report"], "will_remove": []}\n```';
    const decl = parsePlanDeclarations(plan);
    expect(decl?.willModify).toEqual(['Engine.spin']);
    expect(decl?.willAdd).toEqual(['Engine.report']);
  });

  it('extracts files from a unified diff', () => {
    const diff = `--- a/app/engine.py\n+++ b/app/engine.py\n@@ -1 +1 @@\n-x\n+y\n--- /dev/null\n+++ b/app/new.py\n@@ -0,0 +1 @@\n+z\n`;
    expect(filesFromDiff(diff)).toEqual(['app/engine.py', 'app/new.py']);
  });

  it('names a deleted file from its a/ side and skips the /dev/null target', () => {
    const diff = `--- a/app/gone.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
    expect(filesFromDiff(diff)).toEqual(['app/gone.py']);
  });

  it('returns [] for malformed or empty diff text (never throws)', () => {
    expect(filesFromDiff('this is not a diff at all\nrandom lines\n')).toEqual([]);
    expect(filesFromDiff('')).toEqual([]);
  });

  it('drops paths that are absolute on EITHER platform, not just this one', () => {
    // A leading-slash test answers only for the host. `C:/evil` and the UNC
    // form have no leading slash, so they used to survive here and would then
    // resolve outside the workspace on Windows. The check runs the same on
    // every platform, so this test proves it everywhere rather than only there.
    const diff = [
      '--- a/app/ok.py',
      '+++ b/app/ok.py',
      '--- a/C:/evil.py',
      '+++ b/C:/evil.py',
      '--- a/C:\\evil2.py',
      '+++ b/C:\\evil2.py',
      '--- a//etc/passwd',
      '+++ b//etc/passwd',
      '--- a/\\\\server\\share\\evil3.py',
      '+++ b/\\\\server\\share\\evil3.py',
      '',
    ].join('\n');
    expect(filesFromDiff(diff)).toEqual(['app/ok.py']);
  });

  it('drops diff paths that traverse out of the tree (.., absolute, backslash)', () => {
    // A unified diff can only legitimately name repo-relative paths. A hostile
    // diff naming `../../etc/passwd` or `/etc/passwd` must never survive into
    // the refresh set. (resync also guards with scannedFiles; this keeps the
    // public parser safe by construction for any caller.)
    const evil =
      '--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n' +
      '--- a//etc/hosts\n+++ b//etc/hosts\n@@ -1 +1 @@\n-x\n+y\n' +
      '--- a/..\\..\\secret\n+++ b/..\\..\\secret\n@@ -1 +1 @@\n-x\n+y\n' +
      '--- a/app/ok.py\n+++ b/app/ok.py\n@@ -1 +1 @@\n-x\n+y\n';
    const files = filesFromDiff(evil);
    expect(files).toEqual(['app/ok.py']); // only the safe relative path survives
    for (const f of files) {
      expect(f.startsWith('/')).toBe(false);
      expect(f.split(/[\\/]/).includes('..')).toBe(false);
    }
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

  it('folds agent corrections into the refresh set and archives them', async () => {
    const source5 = mkdtempSync(join(tmpdir(), 'hb-rs-src5-'));
    const work5 = mkdtempSync(join(tmpdir(), 'hb-rs-work5-'));
    const case5 = mkdtempSync(join(tmpdir(), 'hb-rs-case5-'));
    writeRepo(source5);
    await generateHandbook({ sourceRoot: source5, workDir: work5, client: pipelineMock(), phase: 'all' });
    // The tree is UNCHANGED: only a correction justifies redescribing the file.
    cpSync(source5, join(case5, 'edited'), { recursive: true });
    const correctionsPath = join(case5, 'corrections.jsonl');
    writeFileSync(
      correctionsPath,
      [
        JSON.stringify({ file: 'app/main.py', claim: 'main() retries', actual: 'it does not retry' }),
        JSON.stringify({ file: 'ghost/missing.py', claim: 'nonsense' }),
      ].join('\n') + '\n',
    );

    const report = await resyncHandbook({
      caseDir: case5,
      workDir: work5,
      client: pipelineMock(),
      correctionsPath,
    });
    expect(report.changedFiles).toContain('app/main.py');
    expect(report.corrections?.applied).toBe(1);
    expect(report.corrections?.files).toEqual(['app/main.py']);
    // A file outside the analyzed set is reported, never silently dropped.
    expect(report.corrections?.problems.join(' ')).toMatch(/ghost\/missing\.py/);
    // Consumed corrections are archived so the next resync does not redo them.
    expect(existsSync(correctionsPath)).toBe(false);
    expect(report.corrections?.archivedTo).toMatch(/corrections\..*\.applied\.jsonl$/);
    expect(existsSync(String(report.corrections?.archivedTo))).toBe(true);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const report = resyncHandbook({
      caseDir,
      workDir,
      noLlm: true,
      signal: AbortSignal.abort(),
    });
    await expect(report).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops a mid-flight resync at the next checkpoint', async () => {
    const source4 = mkdtempSync(join(tmpdir(), 'hb-rs-src4-'));
    const work4 = mkdtempSync(join(tmpdir(), 'hb-rs-work4-'));
    const case4 = mkdtempSync(join(tmpdir(), 'hb-rs-case4-'));
    writeRepo(source4);
    await generateHandbook({ sourceRoot: source4, workDir: work4, client: pipelineMock(), phase: 'all' });
    const edited = join(case4, 'edited');
    cpSync(source4, edited, { recursive: true });
    writeFileSync(join(edited, 'app', 'engine.py'), 'class Engine:\n    def spin(self):\n        return 7\n');

    // Abort from inside the first card call — the pass must not continue.
    const controller = new AbortController();
    const base = pipelineMock();
    const client: ChatClient = {
      model: 'mock-abort',
      complete: (prompt, options) => {
        if (prompt.includes('Files to describe')) controller.abort();
        return base.complete(prompt, options);
      },
    };
    await expect(
      resyncHandbook({ caseDir: case4, workDir: work4, client, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // The lock must be released so a later run can proceed.
    expect(existsSync(join(work4, '.lock'))).toBe(false);
  });

  it('refuses to resync while another process holds the work-dir lock', async () => {
    const lockPath = join(workDir, '.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2147483646, host: 'some-other-machine', startedAt: '2000-01-01T00:00:00Z' }),
    );
    try {
      await expect(resyncHandbook({ caseDir, workDir, noLlm: true })).rejects.toThrow(/another handbook run/);
    } finally {
      rmSync(lockPath, { force: true });
    }
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

  it('is idempotent: a second resync of the same edited tree is a no-op delta', async () => {
    const src = mkdtempSync(join(tmpdir(), 'hb-rs-idem-src-'));
    const work6 = mkdtempSync(join(tmpdir(), 'hb-rs-idem-work-'));
    const case6 = mkdtempSync(join(tmpdir(), 'hb-rs-idem-case-'));
    writeRepo(src);
    await generateHandbook({ sourceRoot: src, workDir: work6, client: pipelineMock(), phase: 'all' });
    const edited = join(case6, 'edited');
    cpSync(src, edited, { recursive: true });
    writeFileSync(
      join(edited, 'app', 'engine.py'),
      'class Engine:\n    def __init__(self):\n        self.rpm = 0\n\n    def spin(self):\n        self.rpm += 2\n        return self.rpm\n',
    );

    const first = await resyncHandbook({
      caseDir: case6,
      workDir: work6,
      client: pipelineMock(),
      detail: 'brief',
    });
    expect(first.changedFiles).toContain('app/engine.py');
    const orgAfterFirst = JSON.stringify(new WorkDir(work6).loadOrganization());

    // The first resync promoted the new graph as the baseline; re-running against
    // the unchanged tree must detect nothing and leave the artifacts untouched.
    const second = await resyncHandbook({
      caseDir: case6,
      workDir: work6,
      client: pipelineMock(),
      detail: 'brief',
    });
    expect(second.changedFiles).toEqual([]);
    expect(second.addedFiles).toEqual([]);
    expect(second.deletedFiles).toEqual([]);
    expect(JSON.stringify(new WorkDir(work6).loadOrganization())).toBe(orgAfterFirst);
  });

  it('treats a rename as delete + add and drops the old card', async () => {
    const src = mkdtempSync(join(tmpdir(), 'hb-rs-ren-src-'));
    const work7 = mkdtempSync(join(tmpdir(), 'hb-rs-ren-work-'));
    const case7 = mkdtempSync(join(tmpdir(), 'hb-rs-ren-case-'));
    writeRepo(src);
    await generateHandbook({ sourceRoot: src, workDir: work7, client: pipelineMock(), phase: 'all' });
    const edited = join(case7, 'edited');
    cpSync(src, edited, { recursive: true });
    // engine.py → motor.py (identical body), with main.py's import updated.
    rmSync(join(edited, 'app', 'engine.py'));
    writeFileSync(
      join(edited, 'app', 'motor.py'),
      'class Engine:\n    def __init__(self):\n        self.rpm = 0\n\n    def spin(self):\n        self.rpm += 1\n        return self.rpm\n',
    );
    writeFileSync(
      join(edited, 'app', 'main.py'),
      'from app.motor import Engine\n\ndef main():\n    e = Engine()\n    e.spin()\n',
    );

    const report = await resyncHandbook({
      caseDir: case7,
      workDir: work7,
      client: pipelineMock(),
      detail: 'brief',
    });
    expect(report.deletedFiles).toContain('app/engine.py');
    expect(report.addedFiles).toContain('app/motor.py');
    const work = new WorkDir(work7);
    expect(existsSync(work.cardPath('app/engine.py'))).toBe(false);
    expect(work.loadCards()['app/motor.py']?.purpose).toContain('Fresh purpose');
    expect(work.loadAssignment().fileStage['app/engine.py']).toBeUndefined();
    expect(work.loadAssignment().fileStage['app/motor.py']?.stage).toBe('stage-2');
  });
});
