import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { startStudio } from './server.js';

function writeFixtureRepo(root: string): void {
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

function mockRules(): MockRule[] {
  return [
    {
      match: 'Files to describe',
      respond: (prompt) => ({
        purposes: [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => ({
          file: m[1],
          purpose: `Handles ${m[1]}.`,
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
        assignments: [...prompt.matchAll(/^- (\S+) {2}\(/gm)].map((m) => ({
          file: m[1],
          stage: m[1]?.includes('main') ? 'stage-1' : 'stage-2',
          also: [],
        })),
      }),
    },
    {
      match: 'organizing the files of ONE stage',
      respond: (prompt) => ({
        groups: [{ title: 'Core', summary: '', files: [...prompt.matchAll(/^- (\S+?)(?: {2}\[|\n)/gm)].map((m) => m[1]) }],
      }),
    },
    { match: 'STATE REGISTERS', respond: { registers: [] } },
    { match: 'COMPLETING a list of state registers', respond: { registers: [] } },
    { match: 'writing the OVERVIEW for one stage', respond: 'Stage prose.' },
    { match: 'top-level overview of a system handbook', respond: 'System prose.' },
    { match: () => true, respond: { tool: 'finish', plan: 'noop' } },
  ];
}

const PORT = 48611;
const base = `http://127.0.0.1:${PORT}`;

/** Per-call mock latency. Cancellation is cooperative — it needs a run that is
 *  actually MID-FLIGHT when the abort lands, so the cancel test dials this up. */
let llmDelayMs = 0;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${path}`, init ? { headers: { 'content-type': 'application/json' }, ...init } : undefined);
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok && res.status !== 202 && res.status !== 201) {
    throw new Error(`${res.status}: ${body.error ?? 'unknown'}`);
  }
  return body;
}

async function waitJob(id: string): Promise<any> {
  for (let i = 0; i < 200; i += 1) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job timed out');
}

describe('studio server (integration, mock LLM)', () => {
  let server: Server;
  let sourceRoot: string;
  const factoryLoggers: unknown[] = [];

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-'));
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-studio-src-'));
    writeFixtureRepo(sourceRoot);
    server = await startStudio({
      stateDir,
      port: PORT,
      clientFactory: (logger) => {
        // The client MUST receive the job logger: without it, retries, timeouts
        // and gateway blocks never reach the job log a user is watching.
        factoryLoggers.push(logger);
        logger.warn('[llm] client attached');
        const inner = new MockChatClient(mockRules());
        return {
          model: inner.model,
          complete: async (prompt, options) => {
            if (llmDelayMs > 0) await new Promise((r) => setTimeout(r, llmDelayMs));
            return inner.complete(prompt, options);
          },
        };
      },
    });
  });

  afterAll(() => {
    server.close();
  });

  it('serves the UI shell', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Handbook Studio');
  });

  it('registers a repo and reports empty status', async () => {
    const repo = await api('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'demo', sourceRoot }) });
    expect(repo.name).toBe('demo');
    expect(repo.hasGraph).toBe(false);
    // No render has happened, so none of the three outputs can exist yet.
    expect(repo.outputs).toEqual({ html: false, single: false, agent: false });
    const list = await api('/api/repos');
    expect(list).toHaveLength(1);
  });

  it('lists no jobs before any has run', async () => {
    expect(await api('/api/jobs')).toEqual({ jobs: [] });
  });

  it('rejects duplicate names and bad paths', async () => {
    await expect(api('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'demo', sourceRoot }) })).rejects.toThrow(/exists/);
    await expect(
      api('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'ghost', sourceRoot: '/nope/nope' }) }),
    ).rejects.toThrow(/not a directory/);
  });

  it('runs the full generate job and exposes overview + handbook site', async () => {
    const job = await api('/api/repos/demo/generate', { method: 'POST', body: JSON.stringify({ narrateLang: 'en' }) });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');

    const overview = await api('/api/repos/demo/overview');
    expect(overview.stages.map((s: any) => s.id).sort()).toEqual(['stage-1', 'stage-2']);
    expect(overview.systemOverview).toContain('System prose');

    const page = await fetch(`${base}/api/repos/demo/handbook/html/overview.html`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo Handbook');

    const status = (await api('/api/repos')).find((r: any) => r.name === 'demo');
    expect(status.hasHandbook).toBe(true);
    expect(status.chapters).toBe(2);
    // Every generate renders all three outputs; the status must say so, or the
    // UI has no way to offer the single-page and agent views.
    expect(status.outputs).toEqual({ html: true, single: true, agent: true });

    // The client was built with the job's logger, and what it logs is in the
    // job log — a silent client is how a failing run reads as a quiet one.
    expect(factoryLoggers.length).toBeGreaterThan(0);
    expect(done.log.join('\n')).toContain('[llm] client attached');

    // Described coverage is reported alongside assignment coverage.
    expect(overview.cardCoverage).toMatchObject({ nFiles: expect.any(Number), nDescribed: expect.any(Number) });
    expect(overview.cardCoverage.nDescribed).toBe(overview.cardCoverage.nFiles);
  });

  it('lists jobs with a stable summary shape, newest first', async () => {
    // The generate job above must be in the list, and a freshly started job
    // must appear immediately — that is what page-reload reattach hangs on.
    const started = await api('/api/repos/demo/analyze', { method: 'POST', body: '{}' });
    const out = await api('/api/jobs');
    expect(out.jobs.map((j: any) => j.id)).toContain(started.id);
    expect(out.jobs.some((j: any) => j.kind === 'generate' && j.status === 'succeeded')).toBe(true);
    for (const j of out.jobs) {
      expect(j).toMatchObject({
        id: expect.any(String),
        repo: 'demo',
        kind: expect.any(String),
        status: expect.stringMatching(/^(running|succeeded|failed|cancelled)$/),
        startedAt: expect.any(String),
      });
      // Summaries, not transcripts: the raw log stays behind /api/jobs/:id.
      expect(j.log).toBeUndefined();
      expect(typeof j.logLines).toBe('number');
    }
    const stamps = out.jobs.map((j: any) => j.startedAt as string);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // Optional repo filter mirrors JobRunner.list(repo).
    expect((await api('/api/jobs?repo=demo')).jobs).toHaveLength(out.jobs.length);
    expect((await api('/api/jobs?repo=nope')).jobs).toEqual([]);
    await waitJob(started.id); // leave no running job behind for later tests
  });

  it('forwards advanced generate options to the pipeline', async () => {
    // member strategy without a skeleton is the pipeline's own fail-loud case:
    // if the option had been dropped on the floor (as lang/strategy/readWorkers
    // once were), this run would sail through as a plain file-strategy generate.
    const job = await api('/api/repos/demo/generate', {
      method: 'POST',
      body: JSON.stringify({ strategy: 'member', phase: '2b' }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('failed');
    expect(done.log.join('\n')).toContain('skeleton');
  });

  it('rejects garbage numeric generate options with a 400, before any job starts', async () => {
    for (const body of [{ readWorkers: 'garbage' }, { readWorkers: 0 }, { maxDoctorRounds: 'many' }]) {
      const res = await fetch(`${base}/api/repos/demo/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const out = (await res.json()) as any;
      expect(String(out.error)).toContain(Object.keys(body)[0] as string);
    }
    // Fail-loud means fail EARLY: no job may have been created for these.
    expect((await api('/api/jobs?repo=demo')).jobs.every((j: any) => j.status !== 'running')).toBe(true);
  });

  it('blocks path traversal on the static handbook route', async () => {
    const res = await fetch(`${base}/api/repos/demo/handbook/..%2F..%2Fphase1%2Fgraph.json`);
    const body = await res.json().catch(() => ({}));
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(body)).not.toContain('"nodes"');
  });

  it('resyncs against the live tree and records an evolution', async () => {
    writeFileSync(
      join(sourceRoot, 'app', 'report.py'),
      'def report(rpm):\n    return f"rpm={rpm}"\n',
    );
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: 'add report helper', noLlm: false }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result.report.addedFiles).toContain('app/report.py');

    const history = await api('/api/repos/demo/history');
    expect(history).toHaveLength(1);
    expect(history[0].description).toBe('add report helper');
  });

  it('labels a resync the author did not describe, and marks where the label came from', async () => {
    // Empty description used to leave a bare dash in the timeline while the facts
    // needed to label it sat in the report.
    writeFileSync(join(sourceRoot, 'app', 'extra.py'), 'def extra():\n    return 1\n');
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '   ', noLlm: true }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    const evo = done.result;
    expect(evo.description).not.toBe('');
    expect(evo.description).not.toBe('(no description)');
    // structure-only resync has no client, so the label is the deterministic one
    expect(evo.descriptionSource).toBe('files');
    expect(evo.description).toContain('.py');
  });

  it('labels a resync that found nothing to do', async () => {
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '', noLlm: true }),
    });
    const done = await waitJob(job.id);
    expect(done.result.description).toBe('无文件变更');
    expect(done.result.descriptionSource).toBe('files');
  });

  it("keeps the author's own description untouched and marks it as theirs", async () => {
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '手写的说明', noLlm: true }),
    });
    const done = await waitJob(job.id);
    expect(done.result.description).toBe('手写的说明');
    expect(done.result.descriptionSource).toBe('user');
  });


  it('streams job logs over SSE', async () => {
    const job = await api('/api/repos/demo/analyze', { method: 'POST', body: '{}' });
    const res = await fetch(`${base}/api/jobs/${job.id}/stream`);
    const text = await res.text(); // stream closes when the job finishes
    expect(text).toContain('data:');
    expect(text).toContain('event: done');
  });

  it('rejects cross-origin requests (CSRF guard)', async () => {
    const res = await fetch(`${base}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'evil', sourceRoot }),
    });
    expect(res.status).toBe(403);
    const text = await fetch(`${base}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'evil2', sourceRoot }),
    });
    expect(text.status).toBe(415);
  });

  it('detects in-place body-only edits via content hashes', async () => {
    // Change ONLY a function body: same lines, same signature.
    writeFileSync(
      join(sourceRoot, 'app', 'engine.py'),
      'class Engine:\n    def __init__(self):\n        self.rpm = 0\n\n    def spin(self):\n        self.rpm += 7\n        return self.rpm\n',
    );
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: 'body-only tweak', noLlm: true }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result.report.changedFiles).toContain('app/engine.py');
  });

  it('rejects overlapping work dirs', async () => {
    const other = (await api('/api/repos')).find((r: any) => r.name === 'demo');
    await expect(
      api('/api/repos', {
        method: 'POST',
        body: JSON.stringify({ name: 'clone', sourceRoot, workDir: other.workDir }),
      }),
    ).rejects.toThrow(/overlaps/);
  });

  it('serves impact-graph data', async () => {
    const graph = await api('/api/repos/demo/graph');
    expect(graph.totalFiles).toBeGreaterThan(0);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(graph.nodes.every((n: any) => typeof n.file === 'string' && typeof n.degree === 'number')).toBe(true);
    const scoped = await api('/api/repos/demo/graph?stage=stage-2&limit=10');
    expect(scoped.stage).toBe('stage-2');
  });

  it('serves source with function anchors and blocks escapes', async () => {
    const src = await api('/api/repos/demo/source?path=app/engine.py');
    expect(src.content).toContain('class Engine');
    expect(src.functions.some((f: any) => f.qualname.includes('spin'))).toBe(true);
    const bad = await fetch(`${base}/api/repos/demo/source?path=../../etc/passwd`);
    expect(bad.status).toBe(400);
  });

  it('applies a plan for real, then rolls it back', async () => {
    const engine = join(sourceRoot, 'app', 'engine.py');
    const before = readFileSync(engine, 'utf8');
    const oldLine = '        self.rpm += 7';
    const plan = [
      '### EDIT 1',
      '- file: `app/engine.py`',
      '- where: `Engine.spin` — bump step',
      '```old',
      oldLine,
      '```',
      '```new',
      '        self.rpm += 11',
      '```',
    ].join('\n');

    // dry-run writes nothing
    const dry = await waitJob((await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan, dryRun: true }) })).id);
    expect(dry.status).toBe('succeeded');
    expect(dry.result.changedFiles).toEqual([]);
    expect(readFileSync(engine, 'utf8')).toBe(before);

    // real apply
    const applied = await waitJob((await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id);
    expect(applied.status).toBe('succeeded');
    expect(applied.result.changedFiles).toEqual(['app/engine.py']);
    expect(readFileSync(engine, 'utf8')).toContain('self.rpm += 11');

    // a stale plan fails the job and changes nothing
    const stale = await waitJob((await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id);
    expect(stale.status).toBe('failed');
    expect(readFileSync(engine, 'utf8')).toContain('self.rpm += 11');

    // backups are listed and rollback restores the bytes
    const backups = await api('/api/repos/demo/patches');
    expect(backups.length).toBeGreaterThan(0);
    const back = await waitJob((await api('/api/repos/demo/rollback', { method: 'POST', body: '{}' })).id);
    expect(back.status).toBe('succeeded');
    expect(readFileSync(engine, 'utf8')).toBe(before);
  });

  it('rollback reports skipped files and honours force', async () => {
    const engine = join(sourceRoot, 'app', 'engine.py');
    const before = readFileSync(engine, 'utf8');
    const anchor = before.split('\n').find((l) => l.includes('self.rpm')) as string;
    const plan = [
      '### EDIT 1',
      '- file: `app/engine.py`',
      '- where: `Engine.spin` — bump',
      '```old',
      anchor,
      '```',
      '```new',
      anchor.replace(/\d+$/, '42'),
      '```',
    ].join('\n');
    const applied = await waitJob((await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id);
    expect(applied.status).toBe('succeeded');

    // Someone edits the file after the patch: rollback must skip, not clobber.
    writeFileSync(engine, `${readFileSync(engine, 'utf8')}\n# later work\n`);
    const guarded = await waitJob((await api('/api/repos/demo/rollback', { method: 'POST', body: '{}' })).id);
    expect(guarded.status).toBe('succeeded');
    expect(guarded.result.restored).toEqual([]);
    expect(guarded.result.skipped[0].reason).toMatch(/changed after the patch/);
    expect(readFileSync(engine, 'utf8')).toContain('# later work');

    // Explicit override restores the pre-patch bytes.
    const forced = await waitJob(
      (await api('/api/repos/demo/rollback', { method: 'POST', body: JSON.stringify({ force: true }) })).id,
    );
    expect(forced.status).toBe('succeeded');
    expect(readFileSync(engine, 'utf8')).toBe(before);
  });

  it('cancels a running job cooperatively and frees the per-repo mutex', async () => {
    llmDelayMs = 120; // every mock LLM call now takes long enough to abort mid-run
    try {
      const job = await api('/api/repos/demo/generate', { method: 'POST', body: JSON.stringify({ narrateLang: 'en' }) });
      const res = await fetch(`${base}/api/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });

      // Cooperative: the run stops at its next checkpoint, then finishes as an
      // OUTCOME (cancelled), not an error (failed).
      const done = await waitJob(job.id);
      expect(done.status).toBe('cancelled');
      expect(done.error).toBeUndefined();
      expect(done.log.join('\n')).toContain('[job] cancelled by user');

      // The mutex must treat cancelled as finished: a follow-up job on the
      // same repo starts and completes instead of hitting "already running".
      llmDelayMs = 0;
      const follow = await api('/api/repos/demo/analyze', { method: 'POST', body: '{}' });
      expect((await waitJob(follow.id)).status).toBe('succeeded');

      // Cancelling a job that already finished is a conflict; unknown is a 404.
      const again = await fetch(`${base}/api/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(again.status).toBe(409);
      const ghost = await fetch(`${base}/api/jobs/no-such-job/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(ghost.status).toBe(404);
    } finally {
      llmDelayMs = 0;
    }
  });

  it('aggregates global history across repos', async () => {
    const all = await api('/api/history');
    expect(all.length).toBeGreaterThan(0);
    expect(all[0].repo).toBe('demo');
  });

  it('removes a repo', async () => {
    const out = await api('/api/repos/demo', { method: 'DELETE' });
    expect(out.removed).toBe(true);
    expect(await api('/api/repos')).toHaveLength(0);
  });
});
