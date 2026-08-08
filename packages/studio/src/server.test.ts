import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type Server } from 'node:http';
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
        groups: [
          {
            title: 'Core',
            summary: '',
            files: [...prompt.matchAll(/^- (\S+?)(?: {2}\[|\n)/gm)].map((m) => m[1]),
          },
        ],
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
  const res = await fetch(
    `${base}${path}`,
    init ? { headers: { 'content-type': 'application/json' }, ...init } : undefined,
  );
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
  const factoryOverrides: Array<Record<string, unknown> | undefined> = [];

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-'));
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-studio-src-'));
    writeFixtureRepo(sourceRoot);
    server = await startStudio({
      stateDir,
      port: PORT,
      clientFactory: (logger, llmOverrides) => {
        // The client MUST receive the job logger: without it, retries, timeouts
        // and gateway blocks never reach the job log a user is watching.
        factoryLoggers.push(logger);
        factoryOverrides.push(llmOverrides);
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
    const repo = await api('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', sourceRoot }),
    });
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

  it('serves the source-language choices from the adapter registry, not a hand-written list', async () => {
    // Regression: the UI used to hard-code six languages against eighteen
    // registered adapters (see ui-drift.test.ts for the UI side of this fix).
    const out = await api('/api/languages');
    expect(out.languages[0]).toBe('auto');
    expect(out.languages).toContain('python');
    expect(out.languages.length).toBeGreaterThan(6);
  });

  it('rejects duplicate names and bad paths', async () => {
    await expect(
      api('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'demo', sourceRoot }) }),
    ).rejects.toThrow(/exists/);
    await expect(
      api('/api/repos', {
        method: 'POST',
        body: JSON.stringify({ name: 'ghost', sourceRoot: '/nope/nope' }),
      }),
    ).rejects.toThrow(/not a directory/);
  });

  it('runs the full generate job and exposes overview + handbook site', async () => {
    const job = await api('/api/repos/demo/generate', {
      method: 'POST',
      body: JSON.stringify({ narrateLang: 'en' }),
    });
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
    expect(overview.cardCoverage).toMatchObject({
      nFiles: expect.any(Number),
      nDescribed: expect.any(Number),
    });
    expect(overview.cardCoverage.nDescribed).toBe(overview.cardCoverage.nFiles);
  });

  it('reports per-language analysis fidelity, and tolerates a graph that has none', async () => {
    // Two fidelity tiers can coexist in one graph, so the UI needs to be told
    // which languages are generic-tier — it cannot infer that from the nodes.
    const repo = (await api('/api/repos')).find((r: any) => r.name === 'demo');
    const graphPath = join(repo.workDir, 'phase1', 'graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8'));

    // A graph written before capabilities existed has no such field, and this
    // repo has no artifact migration: the overview must still answer 200.
    delete graph.metadata.languages;
    writeFileSync(graphPath, JSON.stringify(graph));
    expect((await api('/api/repos/demo/overview')).languages).toBe(null);

    const languages = {
      kotlin: { tier: 'generic', callTypes: ['internal_func'], selfAttrs: false, statementSpans: false },
      python: {
        tier: 'full',
        callTypes: ['self_method', 'internal_func'],
        selfAttrs: true,
        statementSpans: true,
      },
    };
    graph.metadata.languages = languages;
    writeFileSync(graphPath, JSON.stringify(graph));
    expect((await api('/api/repos/demo/overview')).languages).toEqual(languages);
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
    writeFileSync(join(sourceRoot, 'app', 'report.py'), 'def report(rpm):\n    return f"rpm={rpm}"\n');
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

  it("labels a resync that found nothing to do — in the handbook's own language", async () => {
    // Regression: this label used to be hard-coded Chinese via a body key the UI
    // never sent (`narrateLang`, a generate-only setting). The fixture handbook's
    // prose is English, so the label must be too.
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '', noLlm: true }),
    });
    const done = await waitJob(job.id);
    expect(done.result.description).toBe('no file changes');
    expect(done.result.descriptionSource).toBe('files');
  });

  it('honours the registry `proseLang` for the same label', async () => {
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '', noLlm: true, proseLang: 'zh' }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result.description).toBe('无文件变更');
  });

  it('rejects an API key in any job body — secrets are environment-only', async () => {
    for (const path of ['/api/repos/demo/generate', '/api/repos/demo/resync', '/api/repos/demo/render']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ llmApiKey: 'sk-nope' }),
      });
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('environment-only');
    }
  });

  it('passes per-job LLM overrides to the client factory — validated, without the defaults', async () => {
    factoryOverrides.length = 0;
    const job = await api('/api/repos/demo/resync', {
      method: 'POST',
      body: JSON.stringify({ description: '', noLlm: false, llmMaxTokens: 4321 }),
    });
    await waitJob(job.id);
    expect(factoryOverrides).toHaveLength(1);
    // Only what the body carried — resending env/config values would let a
    // registry default overwrite the factory's launch configuration.
    expect(factoryOverrides[0]).toEqual({ llmMaxTokens: 4321 });

    // And a garbage override is a 400 on the request, not a failed job.
    const bad = await fetch(`${base}/api/repos/demo/resync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '', llmMaxTokens: 'lots' }),
    });
    expect(bad.status).toBe(400);
  });

  it('serves the registry settings for every studio-runnable command', async () => {
    const out = await api('/api/settings');
    const commands = Object.keys(out.commands);
    for (const cmd of [
      'analyze',
      'generate',
      'render',
      'skill',
      'validate',
      'plan',
      'apply',
      'rollback',
      'resync',
    ]) {
      expect(commands).toContain(cmd);
    }
    const generate = out.commands.generate as Array<Record<string, unknown>>;
    const keys = generate.map((s) => s.key);
    // The six that used to be validated and then silently dropped.
    for (const key of [
      'readBatchSize',
      'maxCharsPerFile',
      'assignBatchSize',
      'assignWorkers',
      'organizeWorkers',
      'narrateWorkers',
    ]) {
      expect(keys).toContain(key);
    }
    // The secret is DESCRIBED (the UI shows an env hint) but marked as such.
    const apiKey = generate.find((s) => s.key === 'llmApiKey');
    expect(apiKey?.secret).toBe(true);
    // Dynamic language choices are resolved, not the placeholder.
    const lang = generate.find((s) => s.key === 'lang');
    expect(lang?.choices).toContain('python');
    // Studio-managed settings are flagged so the UI never renders a dead knob.
    const source = generate.find((s) => s.key === 'source');
    expect(source?.managed).toBe(true);
  });

  it('re-renders on demand with the registry render settings, llms.txt included', async () => {
    const job = await api('/api/repos/demo/render', {
      method: 'POST',
      body: JSON.stringify({ html: true, htmlSingle: true, agentSite: true, llmsTxt: true }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result.html.nPages).toBeGreaterThan(0);
    expect(done.result.llms).toBeDefined();
    // The artifact is actually served, not just reported.
    const llms = await fetch(`${base}/api/repos/demo/handbook/llms.txt`);
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain('#');
  });

  it('packages a SKILL and validates it', async () => {
    const job = await api('/api/repos/demo/skill', {
      method: 'POST',
      body: JSON.stringify({ project: 'Demo' }),
    });
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result.outDir).toContain('skill');
    expect(done.result.references.length).toBeGreaterThan(0);

    const verdict = await api('/api/repos/demo/validate', { method: 'POST', body: '{}' });
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it('remembers the last-used params per job kind, so the UI can pre-fill', async () => {
    const repo = await api('/api/repos/demo');
    expect(repo.lastParams?.render).toMatchObject({ html: true, llmsTxt: true });
    expect(repo.lastParams?.resync).toBeDefined();
    // Never a secret, even though the request that carried one was rejected anyway.
    expect(JSON.stringify(repo.lastParams)).not.toContain('sk-nope');
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
    expect(graph.nodes.every((n: any) => typeof n.file === 'string' && typeof n.degree === 'number')).toBe(
      true,
    );
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

  it('does not follow a symlink that escapes the source root', async () => {
    // A link that sits INSIDE the tree but points OUTSIDE it passes a lexical
    // ../ check — the read must still be refused, or the sandbox leaks any file.
    const secretDir = mkdtempSync(join(tmpdir(), 'hb-studio-secret-'));
    writeFileSync(join(secretDir, 'secret.txt'), 'TOP-SECRET-EXFIL');
    const link = join(sourceRoot, 'app', 'escape.py');
    symlinkSync(join(secretDir, 'secret.txt'), link);
    try {
      const res = await fetch(`${base}/api/repos/demo/source?path=app/escape.py`);
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('TOP-SECRET-EXFIL');
    } finally {
      rmSync(link, { force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('falls back to the default node cap when ?limit is not a number', async () => {
    // A garbage limit reached impactGraph as NaN and sliced the keep-set to
    // empty, so the whole graph came back with zero nodes. It must default to 60.
    const garbage = await api('/api/repos/demo/graph?limit=abc');
    const base60 = await api('/api/repos/demo/graph');
    expect(Array.isArray(garbage.nodes)).toBe(true);
    expect(base60.nodes.length).toBeGreaterThan(0);
    expect(garbage.nodes.length).toBe(base60.nodes.length);
  });

  it('returns 409 (not 400) when a second job starts on a busy repo', async () => {
    llmDelayMs = 200; // hold the first job mid-flight so the second lands on the mutex
    try {
      const first = await api('/api/repos/demo/generate', {
        method: 'POST',
        body: JSON.stringify({ narrateLang: 'en' }),
      });
      const res = await fetch(`${base}/api/repos/demo/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      // A busy repo is a CONFLICT, mirroring DELETE/cancel — never a 400.
      expect(res.status).toBe(409);
      expect(String(((await res.json()) as any).error)).toMatch(/running job/);
      await waitJob(first.id);
    } finally {
      llmDelayMs = 0;
    }
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
    const dry = await waitJob(
      (await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan, dryRun: true }) }))
        .id,
    );
    expect(dry.status).toBe('succeeded');
    expect(dry.result.changedFiles).toEqual([]);
    expect(readFileSync(engine, 'utf8')).toBe(before);

    // real apply
    const applied = await waitJob(
      (await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id,
    );
    expect(applied.status).toBe('succeeded');
    expect(applied.result.changedFiles).toEqual(['app/engine.py']);
    expect(readFileSync(engine, 'utf8')).toContain('self.rpm += 11');

    // a stale plan fails the job and changes nothing
    const stale = await waitJob(
      (await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id,
    );
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
    const applied = await waitJob(
      (await api('/api/repos/demo/apply', { method: 'POST', body: JSON.stringify({ plan }) })).id,
    );
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
      const job = await api('/api/repos/demo/generate', {
        method: 'POST',
        body: JSON.stringify({ narrateLang: 'en' }),
      });
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

  // --- Adversarial pass 2 -------------------------------------------------

  it('rejects a JSON array body with a 400 and starts no job', async () => {
    // typeof [] === 'object' and [] !== null, so an array used to slip past the
    // "must be a JSON object" guard: it cast to a Record, `body.plan` read as
    // undefined, and a doomed (apply) or silently defaulted (generate) job started
    // on a 202 instead of this malformed request failing loud.
    const before = (await api('/api/jobs?repo=demo')).jobs.length;
    for (const sub of ['/apply', '/generate', '/resync']) {
      const res = await fetch(`${base}/api/repos/demo${sub}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[1,2,3]',
      });
      expect(res.status).toBe(400);
      expect(String(((await res.json()) as any).error)).toMatch(/JSON object/);
    }
    // No job may have been created for any of those, and none may be running.
    const after = (await api('/api/jobs?repo=demo')).jobs;
    expect(after.length).toBe(before);
    expect(after.every((j: any) => j.status !== 'running')).toBe(true);
  });

  it('answers HEAD on the UI shell like GET (200, no body)', async () => {
    // A probe (curl -I, an uptime check) that gets a 404 on `/` while GET returns
    // 200 is a lie about the resource. HEAD must mirror GET for the shell.
    for (const p of ['/', '/index.html']) {
      const res = await fetch(`${base}${p}`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toBe(''); // Node strips the body for HEAD
    }
  });

  it('returns a friendly 400 (not a raw ZodError dump) for an invalid repo name', async () => {
    // A name failing the URL-safe pattern used to reach store.add()'s zod
    // .parse(), whose ZodError.message is a raw JSON array ([{ "code":
    // "invalid_format", ... }]) — and the handler returned it verbatim into the
    // "Add repository" dialog.
    for (const name of ['../evil-repo', '.hidden', 'has space', 'slash/inside', 'bad|pipe']) {
      const res = await fetch(`${base}/api/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, sourceRoot }),
      });
      expect(res.status).toBe(400);
      const msg = String(((await res.json()) as any).error);
      expect(msg).not.toContain('[{'); // no raw zod array
      expect(msg).not.toContain('invalid_format'); // no schema internals
      expect(msg).not.toContain('regex');
      expect(msg).toMatch(/URL-safe/);
    }
    // The rejection must not have registered anything.
    expect((await api('/api/repos')).some((r: any) => r.name.includes('evil'))).toBe(false);
  });

  it('holds the traversal line across an encoding matrix (no out-of-root byte leaks)', async () => {
    // Plant a secret one level ABOVE the source root, then try to reach it every
    // way an attacker might spell "../": raw, single- and double-encoded, mixed
    // separators, null bytes, absolute paths. Every one must refuse and — the real
    // invariant — never return a byte of the secret.
    const secretDir = mkdtempSync(join(tmpdir(), 'hb-studio-exfil-'));
    writeFileSync(join(secretDir, 'secret.txt'), 'OUT-OF-ROOT-SECRET-BYTES');
    const marker = 'OUT-OF-ROOT-SECRET-BYTES';
    const rel = `../${secretDir.split('/').pop()}/secret.txt`;
    const attempts = [
      rel,
      encodeURIComponent(rel),
      rel.replace(/\.\./g, '%2e%2e'),
      rel.replace(/\.\./g, '%252e%252e'),
      rel.replace(/\//g, '\\'),
      `/${join(secretDir, 'secret.txt')}`,
      `app/../${rel}`,
      `app/engine.py ${rel}`,
      `${'../'.repeat(40)}${secretDir.split('/').pop()}/secret.txt`,
    ];
    try {
      for (const path of attempts) {
        const res = await fetch(`${base}/api/repos/demo/source?path=${encodeURIComponent(path)}`);
        expect([400, 404, 413]).toContain(res.status);
        expect(await res.text()).not.toContain(marker);
        // Same matrix against the static handbook route.
        const hb = await fetch(`${base}/api/repos/demo/handbook/${path}`);
        expect(await hb.text()).not.toContain(marker);
      }
      // The server is still up and answering after the barrage.
      expect((await fetch(`${base}/`)).status).toBe(200);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('allows an in-root symlink that realpaths back inside (fix does not over-block)', async () => {
    // The symlink guard must refuse escapes WITHOUT breaking a link that points
    // to another file inside the same tree — otherwise the fix breaks real repos.
    const alias = join(sourceRoot, 'app', 'alias-link.py');
    symlinkSync(join(sourceRoot, 'app', 'engine.py'), alias);
    try {
      const src = await api('/api/repos/demo/source?path=app/alias-link.py');
      expect(src.content).toContain('class Engine');
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it('streams a finished job to completion for concurrent subscribers (no hang)', async () => {
    // Subscribing to an already-finished job, and several clients subscribing to
    // one job at once, must each replay the log and receive `event: done` — never
    // hang waiting on a listener that will never fire.
    const job = await api('/api/repos/demo/analyze', { method: 'POST', body: '{}' });
    await waitJob(job.id);
    const streams = await Promise.all(
      [0, 1, 2].map(() => fetch(`${base}/api/jobs/${job.id}/stream`).then((r) => r.text())),
    );
    for (const s of streams) {
      expect(s).toContain('data:');
      expect(s).toContain('event: done');
    }
  });

  it('removes a repo', async () => {
    const out = await api('/api/repos/demo', { method: 'DELETE' });
    expect(out.removed).toBe(true);
    expect(await api('/api/repos')).toHaveLength(0);
  });
});

describe('registering a repo adopts an existing handbook', () => {
  /**
   * The reported failure: a user who had already generated a handbook with the
   * CLI registered the same tree in studio, left the work dir blank, got a
   * fresh empty one, and concluded the handbook was lost — then paid to
   * regenerate it. Studio must find what is already sitting there.
   */
  const PORT2 = 48612;
  const base2 = `http://127.0.0.1:${PORT2}`;
  let server2: Server;

  const register = async (body: unknown): Promise<any> => {
    const res = await fetch(`${base2}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    server2 = await startStudio({ stateDir: mkdtempSync(join(tmpdir(), 'hb-adopt-state-')), port: PORT2 });
  });
  afterAll(() => server2.close());

  const repoWith = (stem: string): { root: string; src: string } => {
    const root = mkdtempSync(join(tmpdir(), `hb-adopt-${stem}-`));
    const src = join(root, stem);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'main.py'), 'def main():\n    return 1\n');
    return { root, src };
  };

  /** A work dir is claimed only if its graph says it came from `builtFrom`. */
  const plantHandbook = (dir: string, builtFrom: string): void => {
    mkdirSync(join(dir, 'phase1'), { recursive: true });
    writeFileSync(
      join(dir, 'phase1', 'graph.json'),
      JSON.stringify({
        version: 1,
        metadata: {
          generatedAt: 't',
          language: 'python',
          sourceRoot: builtFrom,
          scannedFiles: [],
          nInternalFunctions: 0,
          nBoundaryNodes: 0,
          nEdges: 0,
          policy: 'test',
        },
        nodes: {},
        edges: [],
        selfAttrs: {},
      }),
    );
    mkdirSync(join(dir, 'phase3'), { recursive: true });
    writeFileSync(join(dir, 'phase3', 'narration.json'), '{"version":1}');
  };

  it('adopts a conventional sibling work dir that already holds a handbook', async () => {
    const { root, src } = repoWith('alpha');
    plantHandbook(join(root, 'work', 'alpha'), src); // the README's own `--work work/<name>` convention
    const res = await register({ name: 'alpha', sourceRoot: src });
    expect(res.status).toBe(201);
    expect(res.body.workDir).toBe(join(root, 'work', 'alpha'));
    expect(res.body.adoptedWorkDir).toBe(true);
    expect(res.body.hasNarration).toBe(true);
  });

  it('falls back to a fresh state-dir work dir when nothing exists', async () => {
    const { src } = repoWith('beta');
    const res = await register({ name: 'beta', sourceRoot: src });
    expect(res.status).toBe(201);
    expect(res.body.adoptedWorkDir).toBe(false);
    expect(res.body.hasNarration).toBe(false);
  });

  it('never overrides an explicitly given work dir', async () => {
    const { root, src } = repoWith('gamma');
    plantHandbook(join(root, 'work', 'gamma'), src);
    const chosen = join(root, 'elsewhere');
    const res = await register({ name: 'gamma', sourceRoot: src, workDir: chosen });
    expect(res.status).toBe(201);
    expect(res.body.workDir).toBe(chosen);
    expect(res.body.adoptedWorkDir).toBe(false);
  });

  it('adopts a work dir whose NAME matches nothing, because its graph names this tree', async () => {
    // The real-world case: this repo's own handbook lives in examples/work/self,
    // matching neither the repo name nor the source basename.
    const { root, src } = repoWith('epsilon');
    plantHandbook(join(root, 'examples', 'work', 'self'), src);
    const res = await register({ name: 'epsilon', sourceRoot: src });
    expect(res.status).toBe(201);
    expect(res.body.workDir).toBe(join(root, 'examples', 'work', 'self'));
    expect(res.body.adoptedWorkDir).toBe(true);
  });

  it('never adopts a work dir built from a DIFFERENT tree', async () => {
    const { root, src } = repoWith('zeta');
    plantHandbook(join(root, 'work', 'zeta'), join(root, 'some-other-tree'));
    const res = await register({ name: 'zeta', sourceRoot: src });
    expect(res.status).toBe(201);
    expect(res.body.adoptedWorkDir).toBe(false);
  });

  it('ignores a candidate that exists but holds no handbook', async () => {
    const { root, src } = repoWith('delta');
    mkdirSync(join(root, 'work', 'delta'), { recursive: true }); // empty dir — not a handbook
    const res = await register({ name: 'delta', sourceRoot: src });
    expect(res.status).toBe(201);
    expect(res.body.adoptedWorkDir).toBe(false);
  });
});

describe('the bind address is configurable, and the Host-header guard is unaffected by it', () => {
  it('binds the requested address, defaulting to loopback', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-host-'));
    const server = await startStudio({ stateDir, port: 0, host: '0.0.0.0' });
    const address = server.address();
    expect(typeof address === 'object' && address?.address).toBe('0.0.0.0');
    server.close();
  });

  it('still refuses a non-loopback Host header when bound to 0.0.0.0', async () => {
    // The CSRF defence is about the Host HEADER, not the socket. Binding wide
    // for a container must not widen who may talk to it.
    //
    // `fetch` (undici) will not let a caller override the Host header — it
    // always reflects the actual connection target, not whatever value is
    // passed in `headers` — so this uses node:http's `request`, which does.
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-host-'));
    const server = await startStudio({ stateDir, port: 0, host: '0.0.0.0' });
    const port = (server.address() as { port: number }).port;
    const status = await new Promise<number>((resolvePromise, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/api/repos', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolvePromise(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    server.close();
  });
});
