import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETTINGS, envName, type Logger } from '@handbooks/core';
import { MockChatClient, type MockRule } from '@handbooks/llm';
import { HANDBOOK_CSP, startStudio } from './server.js';

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
      // The planner re-sends its whole transcript each turn, and its system
      // prompt carries the tool protocol — so this identifies a planner prompt
      // without depending on the request text.
      match: (prompt) => plannerLoops && prompt.includes('"tool": "read_file"'),
      respond: { tool: 'read_file', path: 'app/engine.py', start_line: 1, end_line: 5 },
    },
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
/**
 * The suite authenticates like the page does. A fixed value rather than the
 * minted one so every request in this file can carry it; the auth behaviour
 * itself is asserted separately, with and without it.
 */
const TOKEN = 'test-token-for-the-suite';
const auth = { authorization: `Bearer ${TOKEN}` };

/** Per-call mock latency. Cancellation is cooperative — it needs a run that is
 *  actually MID-FLIGHT when the abort lands, so the cancel test dials this up. */
let llmDelayMs = 0;
/** Model calls the suite's client has been asked for. What a cancellation test
 *  has to assert: a job that merely REPORTS cancelled while the agent plays out
 *  its remaining turns costs exactly as much as one that was never cancelled. */
let llmCalls = 0;
/** While set, planner prompts are answered with another tool call instead of a
 *  finish — a run that ends in one turn has no middle to cancel. */
let plannerLoops = false;

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(
    `${base}${path}`,
    init
      ? { ...init, headers: { 'content-type': 'application/json', ...auth, ...(init.headers ?? {}) } }
      : { headers: auth },
  );
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok && res.status !== 202 && res.status !== 201) {
    throw new Error(`${res.status}: ${body.error ?? 'unknown'}`);
  }
  return body;
}

/**
 * Speak raw HTTP to a loopback port.
 *
 * `fetch` (undici) normalizes the request target before it reaches the wire —
 * `/./api/x` goes out as `/api/x` — so anything asserting how the SERVER reads a
 * weird target has to bypass it. Same reason the Host-header test below uses
 * node:http.
 */
function rawRequest(
  port: number,
  target: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolvePromise, reject) => {
    const method = body === undefined ? 'GET' : 'POST';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: target,
        method,
        headers: {
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Hand-written request bytes on a bare socket, for the cases node:http's own
 * client refuses to produce: a Content-Length that lies about the body, and a
 * connection that says nothing at all. Resolves with what came back and whether
 * the server closed the socket within `waitMs`.
 */
function rawSocket(port: number, send: string, waitMs: number): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolvePromise) => {
    const sock = connect(port, '127.0.0.1');
    let text = '';
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolvePromise({ text, closed });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    sock.on('connect', () => sock.write(send));
    sock.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    sock.on('close', () => finish(true));
    sock.on('error', () => finish(true));
  });
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
  let stateFile: string;
  const factoryLoggers: unknown[] = [];
  const factoryOverrides: Array<Record<string, unknown> | undefined> = [];

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-'));
    stateFile = join(stateDir, 'studio.json');
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-studio-src-'));
    writeFixtureRepo(sourceRoot);
    server = await startStudio({
      stateDir,
      port: PORT,
      authToken: TOKEN,
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
            llmCalls += 1;
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
    expect(await res.text()).toContain('Handbooks Studio');
  });

  it('serves the locale dictionaries from a fixed allowlist', async () => {
    // Which locales have a dictionary on disk changes as translations land, so
    // the expectation is derived from the file rather than naming a locale that
    // is "not translated yet" — that hard-coding went stale the moment one did.
    // Either way the response is a 200 JavaScript file: a locale still awaiting
    // its dictionary gets a harmless no-op script, not a 404, and the UI falls
    // back to English key by key.
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    for (const loc of ['en', 'zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de']) {
      const res = await fetch(`${base}/i18n.${loc}.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      const body = await res.text();
      expect(body).toContain(
        existsSync(join(publicDir, `i18n.${loc}.js`)) ? 'window.HB_DICT' : 'not translated yet',
      );
    }
    // Off the allowlist nothing is served: the file name is never joined from input.
    expect((await fetch(`${base}/i18n.xx.js`)).status).toBe(404);
    expect((await fetch(`${base}/i18n.%2e%2e.js`)).status).toBe(404);
  });

  it('registers a repo and reports empty status', async () => {
    const repo = await api('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', sourceRoot }),
    });
    expect(repo.name).toBe('demo');
    expect(repo.hasGraph).toBe(false);
    // No render has happened, so none of the three outputs can exist yet.
    expect(repo.outputs).toEqual({ html: false, single: false, agent: false, skill: false });
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

  it('refuses an llmBaseUrl in a job body — it decides where the API key is sent', async () => {
    // Not a secret itself, but redirecting the endpoint sends every prompt AND
    // the server's Authorization header to a host the caller chose. Rejecting
    // the key coming in is pointless if the key can be pointed out.
    for (const route of ['generate', 'resync', 'plan', 'render']) {
      const res = await fetch(`${base}/api/repos/demo/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ llmBaseUrl: 'http://attacker.example/v1', request: 'x' }),
      });
      expect(res.status, route).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/fixed at launch/);
    }
    // Every name the setting answers to, not just the camelCase one — the env
    // spellings come from the registry, so `HANDBOOK_LLM_BASE_URL` is covered
    // without anyone having had to think of it.
    for (const alias of ['OPENAI_BASE_URL', envName('llmBaseUrl'), 'llmProvider']) {
      const res = await fetch(`${base}/api/repos/demo/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ [alias]: 'http://attacker.example/v1' }),
      });
      expect(res.status, alias).toBe(400);
      expect(((await res.json()) as { error: string }).error, alias).toMatch(/fixed at launch/);
    }
  });

  it('serves the prose languages under their native names', async () => {
    // The generate dialog's language picker renders from this. It used to be a
    // hand-written pair of options while the registry carried eight — the same
    // drift `/api/languages` was introduced to end for source languages.
    const out = await api('/api/narrate-languages');
    const codes = out.languages.map((l: { code: string }) => l.code);
    expect(codes).toEqual(['en', 'zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de']);
    // Native names, so a reader picks their own language rather than a code.
    expect(out.languages.find((l: { code: string }) => l.code === 'ja')?.name).toBe('日本語');
    expect(out.languages.find((l: { code: string }) => l.code === 'de')?.name).toBe('Deutsch');
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

    const page = await fetch(`${base}/api/repos/demo/handbook/html/overview.html`, { headers: auth });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo Handbook');

    const status = (await api('/api/repos')).find((r: any) => r.name === 'demo');
    expect(status.hasHandbook).toBe(true);
    expect(status.chapters).toBe(2);
    // Every generate renders all three outputs; the status must say so, or the
    // UI has no way to offer the single-page and agent views.
    // `skill` is false here: a generate renders the three handbook outputs and
    // does NOT package a SKILL. The UI needs that distinction — gating Validate
    // on the handbook offered a button whose only answer could be a 409.
    expect(status.outputs).toEqual({ html: true, single: true, agent: true, skill: false });

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
    // An analyze is its own kind. Reported as a `generate`, the cancel refusal
    // read "a generate job cannot be cancelled" — naming the one kind that can.
    expect(out.jobs.find((j: any) => j.id === started.id)?.kind).toBe('analyze');
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
        headers: { 'content-type': 'application/json', ...auth },
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
    const res = await fetch(`${base}/api/repos/demo/handbook/..%2F..%2Fphase1%2Fgraph.json`, {
      headers: auth,
    });
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

  it('refuses every setting the REGISTRY marks secret, under every name it answers to', async () => {
    // Iterated from the registry, never restated. The hardcoded `llmApiKey`
    // check said nothing when `llmExtraBody` was declared secret — free-form
    // vendor fields cannot be scanned for credentials, and gateways do take
    // auth in the request body — so a secret was accepted over HTTP and written
    // into studio.json. A list of names goes wrong again the next time.
    const secrets = SETTINGS.filter((s) => s.secret === true);
    // If this ever drops to one, the test has stopped proving derivation: a
    // literal `llmApiKey` check would pass it.
    expect(secrets.length).toBeGreaterThan(1);
    for (const setting of secrets) {
      for (const alias of [setting.key, envName(setting.key), ...(setting.envAliases ?? [])]) {
        const res = await fetch(`${base}/api/repos/demo/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ [alias]: 'leaked-secret-value' }),
        });
        expect(res.status, alias).toBe(400);
        const { error } = (await res.json()) as { error: string };
        expect(error, alias).toContain('environment-only');
        // The refusal has to say where the value DOES go, or the reader is
        // left with a rejection and no route.
        expect(error, alias).toContain(envName(setting.key));
      }
    }
  });

  it('never writes a secret into studio.json, whichever name it arrived under', async () => {
    // The state file is exactly the kind of thing that ends up in a backup.
    const text = readFileSync(stateFile, 'utf8');
    for (const setting of SETTINGS.filter((s) => s.secret === true)) {
      for (const alias of [setting.key, envName(setting.key), ...(setting.envAliases ?? [])]) {
        expect(text, alias).not.toContain(`"${alias}"`);
      }
    }
    expect(text).not.toContain('leaked-secret-value');
  });

  it('does not offer the launch-fixed endpoint settings as form knobs', async () => {
    // The UI renders every non-managed, non-secret setting of a command. That
    // made `llmBaseUrl` a text field whose only outcome was a 400, and
    // `llmProvider` a field that was accepted and then ignored.
    const out = await api('/api/settings');
    const generate = out.commands.generate as Array<Record<string, unknown>>;
    for (const key of ['llmBaseUrl', 'llmProvider']) {
      expect(generate.find((s) => s.key === key)?.managed, key).toBe(true);
    }
    // ...while a genuine per-job knob stays offered.
    expect(generate.find((s) => s.key === 'llmMaxTokens')?.managed).toBe(false);
  });

  it('rejects an API key in any job body — secrets are environment-only', async () => {
    for (const path of ['/api/repos/demo/generate', '/api/repos/demo/resync', '/api/repos/demo/render']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
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
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ description: '', llmMaxTokens: 'lots' }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects registry-invalid input BEFORE starting a job, on every route', async () => {
    // Adversarial finding: generate and resync pre-validated, but render, skill,
    // plan and analyze resolved INSIDE the job — so `{"html":"yes-please"}` came
    // back 202 and only failed in the drawer seconds later. Bad input is the
    // caller's bug and deserves the status code that says so.
    const bad: Array<[string, Record<string, unknown>]> = [
      ['render', { html: 'yes-please' }],
      ['plan', { request: 'x', maxTurns: 'many' }],
      ['skill', { bodyLang: 'klingon' }],
      ['generate', { detail: 'exhaustive' }],
      ['resync', { cardDetail: 'medium' }],
      // `lang` declares dynamicChoices, so the resolver alone cannot catch this:
      // unchecked, an unknown language reached the analyzer and returned an empty
      // analysis, which reads as "your repo has no code".
      ['analyze', { lang: 'esperanto' }],
      ['generate', { lang: 'esperanto' }],
    ];
    for (const [route, body] of bad) {
      const res = await fetch(`${base}/api/repos/demo/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      });
      expect(res.status, `${route} ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('serves the locale dictionaries from a fixed allowlist only', async () => {
    expect((await fetch(`${base}/i18n.en.js`)).status).toBe(200);
    // A locale with no file yet is a no-op, not a 404: the UI falls back to
    // English and stays whole while translations land.
    const pending = await fetch(`${base}/i18n.hi.js`);
    expect([200]).toContain(pending.status);
    for (const path of ['/i18n.xx.js', '/i18n.%2e%2e%2fserver.js', '/i18n.en.js/../../etc/passwd']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
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
    const llms = await fetch(`${base}/api/repos/demo/handbook/llms.txt`, { headers: auth });
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

    // The status now says a SKILL exists, which is what lets the UI enable
    // Validate instead of offering it and then failing.
    expect((await api('/api/repos/demo')).outputs.skill).toBe(true);

    const verdict = await api('/api/repos/demo/validate', { method: 'POST', body: '{}' });
    expect(verdict.ok).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it('carries the advanced generate settings all the way through, cache included', async () => {
    // Adversarial round 5. Six of these were accepted, validated and then
    // silently dropped before reaching `generateHandbook`, and `llmCache` was
    // never honoured at all — studio never wrapped the client the way the CLI
    // does. A 202 followed by a green job proved nothing about either.
    //
    // Its OWN repo and source tree: the shared `demo` fixture accumulates
    // artifacts across the tests above, and a cache assertion that depends on
    // how much work a run still had left to do is a test that passes or fails
    // by position in the file.
    const own = mkdtempSync(join(tmpdir(), 'hb-studio-cache-'));
    writeFixtureRepo(own);
    await api('/api/repos', { method: 'POST', body: JSON.stringify({ name: 'cached', sourceRoot: own }) });
    const job = await api('/api/repos/cached/generate', {
      method: 'POST',
      body: JSON.stringify({
        narrateLang: 'en',
        readWorkers: 2,
        readBatchSize: 3,
        maxCharsPerFile: 4000,
        assignBatchSize: 5,
        assignWorkers: 2,
        organizeWorkers: 2,
        narrateWorkers: 2,
        llmCache: true,
        title: 'Cache Check',
      }),
    });
    const done = await waitJob(job.id);
    expect(done.status, done.error).toBe('succeeded');

    const repo = await api('/api/repos/cached');
    const cacheDir = join(repo.workDir as string, 'phase3', 'cache');
    expect(existsSync(cacheDir), `expected a reply cache at ${cacheDir}`).toBe(true);
    expect(readdirSync(cacheDir).length).toBeGreaterThan(0);
    expect(repo.lastParams?.generate?.readBatchSize).toBe(3);

    // Leave the registry as we found it: a later test asserts the list is
    // empty once the shared fixture repo is removed.
    await api('/api/repos/cached', { method: 'DELETE' });
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
    const res = await fetch(`${base}/api/jobs/${job.id}/stream`, { headers: auth });
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
    const bad = await fetch(`${base}/api/repos/demo/source?path=../../etc/passwd`, { headers: auth });
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
      const res = await fetch(`${base}/api/repos/demo/source?path=app/escape.py`, { headers: auth });
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
        headers: { 'content-type': 'application/json', ...auth },
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
        headers: { 'content-type': 'application/json', ...auth },
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
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      });
      expect(again.status).toBe(409);
      const ghost = await fetch(`${base}/api/jobs/no-such-job/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      });
      expect(ghost.status).toBe(404);
    } finally {
      llmDelayMs = 0;
    }
  });

  it('stops buying model calls the moment a plan is cancelled', async () => {
    // The signal was held by the job and consulted only AFTER runPlanner
    // returned, so a cancelled plan played out every remaining turn — up to
    // thirty model calls of real money — and then threw the result away. The
    // user saw "cancelled" and was billed for the whole run.
    //
    // Asserting the final status alone passes just as well when every call
    // still happens, so this counts the calls.
    plannerLoops = true;
    llmDelayMs = 100;
    try {
      llmCalls = 0;
      const job = await api('/api/repos/demo/plan', {
        method: 'POST',
        body: JSON.stringify({ request: 'add an rpm gauge', maxTurns: 25 }),
      });
      // Cancel from the MIDDLE of the run: a cancel that lands before the first
      // turn proves nothing about turns it never reached.
      for (let i = 0; i < 200 && llmCalls < 3; i += 1) await new Promise((r) => setTimeout(r, 25));
      expect(llmCalls).toBeGreaterThanOrEqual(3);
      const atCancel = llmCalls;

      const res = await fetch(`${base}/api/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: '{}',
      });
      expect(res.status).toBe(202);
      const done = await waitJob(job.id);
      expect(done.status).toBe('cancelled');

      // Let any straggler land. The one call already in flight may finish — the
      // mock cannot be aborted mid-await — but nothing beyond it may be bought.
      await new Promise((r) => setTimeout(r, 600));
      expect(llmCalls).toBeLessThanOrEqual(atCancel + 1);
      // ...and the budget the run was given is nowhere near spent.
      expect(llmCalls).toBeLessThan(25);
    } finally {
      plannerLoops = false;
      llmDelayMs = 0;
      llmCalls = 0;
    }
  });

  it('refuses to accept a cancel a job could never observe', async () => {
    // H5, re-verified now that generate, plan and resync all genuinely take a
    // signal: the ones that do NOT must still say so instead of answering 202
    // and running to completion. A render is synchronous work that never
    // yields, so there is no point at which it could stop.
    const job = await api('/api/repos/demo/render', { method: 'POST', body: '{}' });
    const res = await fetch(`${base}/api/jobs/${job.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{}',
    });
    // Either the run already finished (409 "already finished") or it is still
    // going and refuses on capability — never 202, which would be a promise
    // studio cannot keep.
    expect(res.status).toBe(409);
    const done = await waitJob(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.cancellable).toBe(false);

    // The refusal names the kind that actually ran. An analyze reported as a
    // `generate` produced "a generate job cannot be cancelled", which is false
    // about generate and unhelpful about analyze.
    const analyze = await api('/api/repos/demo/analyze', { method: 'POST', body: '{}' });
    const refusal = await fetch(`${base}/api/jobs/${analyze.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: '{}',
    });
    expect(refusal.status).toBe(409);
    expect(String(((await refusal.json()) as any).error)).not.toContain('generate');
    await waitJob(analyze.id);
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
        headers: { 'content-type': 'application/json', ...auth },
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
      const res = await fetch(`${base}${p}`, { method: 'HEAD', headers: auth });
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
        headers: { 'content-type': 'application/json', ...auth },
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
        const res = await fetch(`${base}/api/repos/demo/source?path=${encodeURIComponent(path)}`, {
          headers: auth,
        });
        expect([400, 404, 413]).toContain(res.status);
        expect(await res.text()).not.toContain(marker);
        // Same matrix against the static handbook route.
        const hb = await fetch(`${base}/api/repos/demo/handbook/${path}`, { headers: auth });
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
      [0, 1, 2].map(() =>
        fetch(`${base}/api/jobs/${job.id}/stream`, { headers: auth }).then((r) => r.text()),
      ),
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
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    server2 = await startStudio({
      authToken: TOKEN,
      stateDir: mkdtempSync(join(tmpdir(), 'hb-adopt-state-')),
      port: PORT2,
    });
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

describe('the API requires the token studio minted at launch', () => {
  /**
   * Studio drives a real toolchain: it reads any path on the machine, writes
   * work dirs, and spends money on a model. A browser tab on any origin can
   * POST to a loopback port, and every other process on a shared or multi-user
   * machine can reach one too. The Host-header check stops the first; only a
   * secret stops the second.
   */
  const TOK = 'a-token-only-the-page-was-given';
  let authed: Awaited<ReturnType<typeof startStudio>>;
  let url: string;

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-auth-'));
    authed = await startStudio({ stateDir, port: 0, authToken: TOK });
    url = `http://127.0.0.1:${(authed.address() as { port: number }).port}`;
  });
  afterAll(() => authed.close());

  it('refuses an API request that carries no token', async () => {
    const res = await fetch(`${url}/api/repos`);
    expect(res.status).toBe(401);
    // The message has to say what to DO, because the person reading it is
    // looking at their own tool refusing them.
    expect(((await res.json()) as { error: string }).error).toMatch(/token/i);
  });

  it('refuses a wrong token, and does not leak the right one', async () => {
    const res = await fetch(`${url}/api/repos`, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain(TOK);
  });

  it('accepts the token as a bearer header', async () => {
    const res = await fetch(`${url}/api/repos`, { headers: { authorization: `Bearer ${TOK}` } });
    expect(res.status).toBe(200);
  });

  it('accepts the token as a query parameter on the SSE route only', async () => {
    // EventSource cannot set a header, so the stream route has to take the token
    // in the URL. Every OTHER route must not: a query string is the part of a
    // request that ends up in shell history, a copied link and a Referer, so the
    // exception stays as narrow as the reason for it. The UI already only uses
    // `?token=` on the stream (see index.html's EventSource call).
    const stream = await fetch(`${url}/api/jobs/no-such-job/stream?token=${TOK}`);
    expect(stream.status).toBe(404); // past auth: the job is what is missing
    const elsewhere = await fetch(`${url}/api/repos?token=${TOK}`);
    expect(elsewhere.status).toBe(401);
  });

  it('requires the token on a target that only NORMALIZES to /api', async () => {
    // The gate matched the RAW request target with startsWith('/api/') while the
    // router matched `new URL(...).pathname`. Those disagree: `/./api/repos`,
    // `//evil/api/repos`, `/%2e/api/repos` and `/\evil/api/repos` are all
    // `/api/repos` to the router and none of them starts with `/api/` — so the
    // entire API was reachable with no token at all. `fetch` normalizes these
    // away before they hit the wire, so this speaks raw HTTP.
    const port = (authed.address() as { port: number }).port;
    for (const target of [
      '/./api/repos',
      '//evil.example/api/repos',
      '/%2e/api/repos',
      '/./../api/repos',
      '/a/../../api/repos',
    ]) {
      const anon = await rawRequest(port, target);
      expect([400, 401], `${target} unauthenticated`).toContain(anon.status);
      expect(anon.text, target).not.toContain('addedAt');
    }
    // The plain spelling still works with the token — the fix must not close the
    // door on the only client there is.
    const ok = await rawRequest(port, '/api/repos', { authorization: `Bearer ${TOK}` });
    expect(ok.status).toBe(200);
  });

  it('serves the page itself without a token, and hands it the token there', async () => {
    // The page is how you GET the token, so it cannot require it. What the page
    // carries is inert on its own: it is the injected value that unlocks /api.
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`content="${TOK}"`);
  });

  it('mints a token when none was configured, rather than defaulting to open', async () => {
    // Secure by default. A caller who forgets the option gets a locked API, not
    // an open one — the failure mode of forgetting must be a 401, never an
    // exposed toolchain.
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-mint-'));
    const minted = await startStudio({ stateDir, port: 0 });
    const at = `http://127.0.0.1:${(minted.address() as { port: number }).port}`;
    expect((await fetch(`${at}/api/repos`)).status).toBe(401);

    // ...and the page it serves carries the token it minted, so the UI works
    // without anyone having to be told what the value is.
    const token = /name="hb-token" content="([^"]+)"/.exec(await (await fetch(at)).text())?.[1];
    expect(token).toBeTruthy();
    expect((await fetch(`${at}/api/repos`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
      200,
    );
    minted.close();
  });

  it('can be opened deliberately with an empty token, for an embedder with its own auth', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-open-'));
    const open = await startStudio({ stateDir, port: 0, authToken: '' });
    const res = await fetch(`http://127.0.0.1:${(open.address() as { port: number }).port}/api/repos`);
    expect(res.status).toBe(200);
    open.close();
  });
});

describe('studio survives a hostile local client', () => {
  /**
   * Everything here is about a caller that is authenticated and still behaving
   * badly — a stuck script, a runaway loop, a browser tab left open. Studio is
   * one process holding one work dir per repo, so "it eventually recovers" is
   * not good enough: a slot held forever, a body read into memory without a
   * ceiling, or two runs in one work dir are all the same failure.
   */
  const TOK = 'robustness-token';
  let server: Server;
  let port = 0;
  let base3: string;
  let src: string;

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-hostile-'));
    src = mkdtempSync(join(tmpdir(), 'hb-studio-hostile-src-'));
    writeFixtureRepo(src);
    server = await startStudio({
      stateDir,
      port: 0,
      authToken: TOK,
      // Deliberately tiny so the assertions are about the mechanism and not
      // about waiting: the shipped defaults are seconds, not milliseconds.
      headersTimeoutMs: 300,
      requestTimeoutMs: 600,
      // Slow enough that a job started here is unambiguously still running when
      // the next request lands — the mutex assertion is about a check and a
      // claim with no await between them, not about who happened to be faster.
      clientFactory: () => {
        const inner = new MockChatClient(mockRules());
        return {
          model: inner.model,
          complete: async (prompt, options) => {
            await new Promise((r) => setTimeout(r, 150));
            return inner.complete(prompt, options);
          },
        };
      },
    });
    port = (server.address() as { port: number }).port;
    base3 = `http://127.0.0.1:${port}`;
  });
  afterAll(() => server.close());

  const bearer = { authorization: `Bearer ${TOK}` };

  it('refuses an oversized body with 413, and starts no job', async () => {
    // Reading an arbitrary number of bytes into a Buffer before deciding
    // anything is a one-line local denial of service. The refusal must also be
    // the code that says WHY: a 400 reads as "your JSON is wrong".
    await fetch(`${base3}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ name: 'big', sourceRoot: src }),
    });
    const huge = JSON.stringify({ plan: 'x'.repeat(2_000_000) });
    const res = await rawRequest(port, '/api/repos/big/apply', bearer, huge);
    expect(res.status).toBe(413);
    expect(res.text).toMatch(/too large/i);
    const jobs = await fetch(`${base3}/api/jobs?repo=big`, { headers: bearer }).then((r) => r.json());
    expect((jobs as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it('refuses a declared Content-Length over the cap without reading a byte of it', async () => {
    // The body never arrives — only the promise of one. Waiting for a gigabyte
    // that a hostile client will send at one byte per second is the same denial
    // of service by another route, so the header alone has to be enough.
    const out = await rawSocket(
      port,
      [
        'POST /api/repos/big/apply HTTP/1.1',
        'Host: 127.0.0.1',
        'content-type: application/json',
        `authorization: Bearer ${TOK}`,
        'Content-Length: 999999999',
        '',
        '{',
      ].join('\r\n'),
      2000,
    );
    expect(out.text).toContain('413');
    expect(out.text).toMatch(/too large/i);
  });

  it('closes a socket that connects and never sends a request line', async () => {
    // No headers, no body, no intention of sending any. Node's own defaults are
    // a minute for headers and five for the whole request; for a single-process
    // local tool that is a slot handed to anyone who can open a socket.
    const out = await rawSocket(port, '', 3000);
    expect(out.closed).toBe(true);
  });

  it('closes a socket that sends headers and then stalls mid-body', async () => {
    const out = await rawSocket(
      port,
      [
        'POST /api/repos HTTP/1.1',
        'Host: 127.0.0.1',
        'content-type: application/json',
        `authorization: Bearer ${TOK}`,
        'Content-Length: 5000',
        '',
        '{"na',
      ].join('\r\n'),
      3000,
    );
    expect(out.closed).toBe(true);
  });

  it('lets exactly one of a burst of concurrent starts win the per-repo mutex', async () => {
    // One work dir, one writer. The check and the claim have to happen with no
    // await between them, or a burst slips several runs into the same phase
    // directories and the artifacts they leave behind are a mixture.
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(() =>
        fetch(`${base3}/api/repos/big/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...bearer },
          body: JSON.stringify({ narrateLang: 'en' }),
        }).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 202)).toHaveLength(1);
    expect(results.filter((s) => s === 409)).toHaveLength(5);
    for (let i = 0; i < 200; i += 1) {
      const jobs = (await fetch(`${base3}/api/jobs?repo=big`, { headers: bearer }).then((r) => r.json())) as {
        jobs: Array<{ status: string }>;
      };
      if (jobs.jobs.every((j) => j.status !== 'running')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('refuses the filesystem root as a source tree', async () => {
    // `sourceRoot: "/"` makes every file on the machine readable through the
    // viewer route and asks the analyzer to walk the whole disk. Nobody means
    // it, and the shape of the mistake (a blank field, a stray slash) is common.
    const res = await fetch(`${base3}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ name: 'rootrepo', sourceRoot: '/' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/filesystem root/i);
  });

  it('registers nothing when the work dir cannot be created', async () => {
    // The entry lands in studio.json before the directory is made, so a work dir
    // that cannot exist left a registered repo every action failed on — and
    // re-adding it met "already exists", with no way out but editing the file.
    const wall = join(mkdtempSync(join(tmpdir(), 'hb-studio-wall-')), 'a-file');
    writeFileSync(wall, 'not a directory');
    const ownSrc = mkdtempSync(join(tmpdir(), 'hb-studio-halfborn-'));
    writeFixtureRepo(ownSrc);
    const res = await fetch(`${base3}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer },
      body: JSON.stringify({ name: 'halfborn', sourceRoot: ownSrc, workDir: join(wall, 'work') }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/work dir/i);
    const repos = (await fetch(`${base3}/api/repos`, { headers: bearer }).then((r) => r.json())) as Array<{
      name: string;
    }>;
    expect(repos.map((r) => r.name)).not.toContain('halfborn');
  });

  it('refuses a name, sourceRoot or workDir that is not a string', async () => {
    // `String(body.sourceRoot)` turned `["/etc"]` into `/etc` and `{}` into
    // `[object Object]` — a coercion that either obeys something the caller
    // never wrote or invents a nonsense relative path off the server's cwd.
    for (const body of [
      { name: ['a', 'b'], sourceRoot: src },
      { name: 'typed', sourceRoot: { path: src } },
      { name: 'typed', sourceRoot: src, workDir: 42 },
    ]) {
      const res = await fetch(`${base3}/api/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/must be a string/i);
    }
  });
});

describe('studio bounds how much work it will run at once', () => {
  /**
   * The per-repo mutex says nothing about how many repos may run together, and
   * every generate holds a whole call graph plus a grammar in memory while it
   * fans out LLM calls. Ten clicks is ten of those in one process.
   */
  const TOK = 'cap-token';
  let server: Server;
  let base4: string;

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-cap-'));
    server = await startStudio({
      stateDir,
      port: 0,
      authToken: TOK,
      maxConcurrentJobs: 1,
      // Slow enough that the first job is unambiguously still holding the only
      // slot when the second request arrives.
      clientFactory: () => {
        const inner = new MockChatClient(mockRules());
        return {
          model: inner.model,
          complete: async (prompt, options) => {
            await new Promise((r) => setTimeout(r, 150));
            return inner.complete(prompt, options);
          },
        };
      },
    });
    base4 = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const name of ['one', 'two']) {
      const root = mkdtempSync(join(tmpdir(), `hb-studio-cap-${name}-`));
      writeFixtureRepo(root);
      await fetch(`${base4}/api/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
        body: JSON.stringify({ name, sourceRoot: root }),
      });
    }
  });
  afterAll(() => server.close());

  it('answers 429 for a job beyond the cap, instead of piling them up', async () => {
    const post = (repo: string): Promise<Response> =>
      fetch(`${base4}/api/repos/${repo}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
        body: JSON.stringify({ narrateLang: 'en' }),
      });
    // `start()` marks the job running synchronously, so by the time the 202 is
    // read the slot is already taken — no sleep, no race.
    const first = await post('one');
    expect(first.status).toBe(202);
    const second = await post('two');
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toMatch(/at once/i);

    // ...and the slot comes back when the first job ends.
    const id = ((await first.json()) as { id: string }).id;
    for (let i = 0; i < 200; i += 1) {
      const job = (await fetch(`${base4}/api/jobs/${id}`, {
        headers: { authorization: `Bearer ${TOK}` },
      }).then((r) => r.json())) as { status: string };
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await post('two')).status).toBe(202);
  });
});

describe('the SSE job stream against a subscriber that stopped reading', () => {
  /**
   * `res.write()` never refuses. A subscriber that connects and then stops
   * reading — a tab throttled in the background, a paused debugger, a `curl`
   * piped into something slow, a half-open socket — makes Node buffer every
   * further byte in this process, without bound, for as long as the job runs.
   *
   * Nothing about that is visible to a test that uses a normal HTTP client,
   * because a normal client reads. So this suite speaks raw HTTP on a socket it
   * never reads from, and watches the SERVER's own response object: the test and
   * the server share a process, so `writableLength` and `writableNeedDrain` are
   * readable directly, which is the only way to tell "we stopped writing" from
   * "the kernel happened to swallow it".
   *
   * The gate below is what makes it deterministic: the first model call parks
   * until the test releases it, so the job is unambiguously still RUNNING while
   * the stream is being watched. No sleeps, no timing assumptions.
   */
  const TOK = 'sse-backpressure-token';
  /** Log lines the flood offers. ~2 KB each, so ~8 MB — far past any kernel
   *  socket buffer on any platform, which is what makes the stall certain
   *  rather than dependent on how much loopback happens to absorb. */
  const FLOOD = 4000;
  let server: Server;
  let at = '';
  let port = 0;
  /** The running job's own logger, captured from the client factory. Flooding
   *  through it uses the REAL emit path — a fake listener would prove nothing
   *  about what the route does with a real job's lines. */
  let jobLogger: Logger | null = null;
  let openGate: () => void = () => {};
  let gate: Promise<void>;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-sse-'));
    const source = mkdtempSync(join(tmpdir(), 'hb-sse-src-'));
    writeFixtureRepo(source);
    gate = new Promise<void>((r) => {
      openGate = () => r();
    });
    server = await startStudio({
      stateDir,
      port: 0,
      authToken: TOK,
      clientFactory: (logger) => {
        jobLogger = logger;
        const inner = new MockChatClient(mockRules());
        return {
          model: inner.model,
          complete: async (prompt, options) => {
            await gate;
            return inner.complete(prompt, options);
          },
        };
      },
    });
    port = (server.address() as { port: number }).port;
    at = `http://127.0.0.1:${port}`;
    await fetch(`${at}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
      body: JSON.stringify({ name: 'sse', sourceRoot: source }),
    });
  });

  afterAll(() => {
    openGate();
    for (const sock of sockets) sock.destroy();
    server.close();
  });

  const get = async (path: string): Promise<any> =>
    (await fetch(`${at}${path}`, { headers: { authorization: `Bearer ${TOK}` } })).json();

  /** A socket that sends the SSE request and never reads the answer. Attaching
   *  no 'data' listener is what does it: a net.Socket stays paused until one
   *  arrives, so the kernel receive window closes and stays closed. */
  const deafSubscriber = (jobId: string): Socket => {
    const sock = connect(port, '127.0.0.1');
    sockets.push(sock);
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(
        `GET /api/jobs/${jobId}/stream HTTP/1.1\r\n` +
          `host: 127.0.0.1:${port}\r\n` +
          `authorization: Bearer ${TOK}\r\n\r\n`,
      );
    });
    return sock;
  };

  const until = async (what: string, ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      if (ready()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
  };

  let floodedJobId = '';

  it('stops writing, drops the oldest lines and says how many, instead of buffering forever', async () => {
    // The server's own response object for the stream, so the assertions can be
    // about what the server holds rather than about what a client observed.
    let streamRes: ServerResponse | null = null;
    const spy = (req: any, res: ServerResponse): void => {
      if (String(req.url ?? '').includes('/stream')) streamRes = res;
    };
    server.on('request', spy);
    try {
      const started = (await (
        await fetch(`${at}/api/repos/sse/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
          body: JSON.stringify({ narrateLang: 'en' }),
        })
      ).json()) as { id: string };
      floodedJobId = started.id;
      await until('the job to reach its first model call', () => jobLogger !== null);

      deafSubscriber(floodedJobId);
      await until('the server to answer the stream', () => streamRes !== null && streamRes.headersSent);
      const res = streamRes as unknown as ServerResponse;

      // Count what the route hands to the socket. Bytes alone are not portable:
      // how much a loopback connection swallows before pushing back differs per
      // platform, where "how many frames did we even attempt" does not.
      const realWrite = res.write.bind(res) as (chunk: string) => boolean;
      let writes = 0;
      (res as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        writes += 1;
        return realWrite(chunk);
      };

      const line = 'y'.repeat(1980);
      for (let i = 0; i < FLOOD; i += 1) (jobLogger as Logger).info(`flood ${i} ${line}`);
      // `data: ` + the JSON-quoted line + the blank line that terminates a frame.
      const offered = FLOOD * (line.length + 18);

      // Non-vacuity guard first: if the peer had somehow absorbed all of this,
      // the stream would not be backpressured and everything below would pass
      // for the wrong reason.
      expect(res.writableNeedDrain).toBe(true);
      // We stopped. Before this change every one of the 4000 frames was handed
      // straight to the socket.
      expect(writes).toBeGreaterThan(0);
      expect(writes).toBeLessThan(800);
      // And Node is not holding the rest of it for us: measured against the
      // plain `res.write` this replaced, the same flood parked ~8 MB here.
      expect(res.writableLength).toBeLessThan(2_000_000);
      expect(offered).toBeGreaterThan(7_500_000);

      // Now read. What comes back has to SAY there is a hole — a silent gap in
      // a log is worse than a gap, and an unbounded queue would never have had
      // one to report.
      const sock = sockets[sockets.length - 1] as Socket;
      let text = '';
      sock.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      await until('the drop disclosure', () => /event: dropped/.test(text));
      const disclosed = /event: dropped\ndata: (\{[^\n]*\})/.exec(text);
      expect(disclosed).not.toBeNull();
      const { lines } = JSON.parse((disclosed as RegExpExecArray)[1] as string) as { lines: number };
      // 4000 offered, at most ~500 held: the overwhelming majority is disclosed,
      // not silently missing.
      expect(lines).toBeGreaterThan(3000);

      // Dropped from the FRONT: the line a watcher is waiting for is the newest
      // one, so the tail must survive and the middle must be the casualty.
      await until('the tail of the flood', () => text.includes(`flood ${FLOOD - 1} `));
      expect(text).not.toContain(`flood ${Math.floor(FLOOD / 2)} `);
      // ...and the disclosure sits where the hole is, not tacked on at the end.
      expect(text.indexOf('event: dropped')).toBeLessThan(text.indexOf(`flood ${FLOOD - 1} `));
    } finally {
      server.off('request', spy);
    }
  });

  it('keeps the full log on the job, so "reload to see it" is true', async () => {
    // The reason dropping is acceptable at all: the stream is a live view, and
    // the log itself is still there to be fetched.
    const job = await get(`/api/jobs/${floodedJobId}`);
    expect(job.log.length).toBeGreaterThan(1000);
    expect(job.log[job.log.length - 1]).toContain(`flood ${FLOOD - 1}`);
  });

  it('never slows the run down for a spectator', async () => {
    // The other half of the policy. The deaf subscriber is still attached and
    // still backpressured; the job must reach a terminal state anyway.
    openGate();
    let status = 'running';
    for (let i = 0; i < 400; i += 1) {
      status = (await get(`/api/jobs/${floodedJobId}`)).status;
      if (status !== 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status).not.toBe('running');
  });

  it('replays a multi-megabyte backlog to a healthy subscriber without dropping any of it', async () => {
    // The regression this design has to avoid: the backlog of a long run is
    // megabytes, so it trips backpressure within the first ~30 lines even for a
    // subscriber that is reading as fast as it can. Queueing the replay would
    // have made a perfectly healthy client lose most of it — which is why the
    // replay is an INDEX into `job.log` rather than something enqueued.
    const job = await get(`/api/jobs/${floodedJobId}`);
    const backlog = job.log as string[];
    expect(backlog.length).toBeGreaterThan(1000);
    expect(backlog.join('').length).toBeGreaterThan(2_000_000);

    const res = await fetch(`${at}/api/jobs/${floodedJobId}/stream`, {
      headers: { authorization: `Bearer ${TOK}` },
    });
    const body = await res.text();
    const frames = body.split('\n\n').filter((f) => f.startsWith('data: '));
    expect(frames.length).toBe(backlog.length);
    expect(JSON.parse(frames[0]!.slice(6))).toBe(backlog[0]);
    expect(JSON.parse(frames[frames.length - 1]!.slice(6))).toBe(backlog[backlog.length - 1]);
    // Nothing was dropped, and the stream closed itself rather than hanging.
    expect(body).not.toContain('event: dropped');
    expect(body).toContain('event: done');
  });
});

describe('the rendered handbook is served with a policy that cannot reach the API', () => {
  /**
   * The handbook is built from an arbitrary source repository and its prose is
   * written by a model reading that repository, so its HTML is untrusted — and
   * it is served from studio's own origin. Without a policy, a script that
   * survives into a page can `fetch('/')` and read the API token out of the
   * UI's `<meta>` tag, which defeats the token entirely.
   */
  let server: Awaited<ReturnType<typeof startStudio>>;
  let at: string;
  const TOK = 'csp-suite-token';

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-csp-'));
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-csp-src-'));
    writeFileSync(join(sourceRoot, 'a.ts'), 'export const a = 1;\n');
    const workDir = mkdtempSync(join(tmpdir(), 'hb-csp-work-'));
    mkdirSync(join(workDir, 'handbook'), { recursive: true });
    writeFileSync(join(workDir, 'handbook', 'index.html'), '<!doctype html><p>rendered</p>');
    server = await startStudio({ stateDir, port: 0, authToken: TOK });
    at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await fetch(`${at}/api/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOK}` },
      body: JSON.stringify({ name: 'csp', sourceRoot, workDir }),
    });
  });
  afterAll(() => server.close());

  it('forbids the handbook page every network verb', async () => {
    const res = await fetch(`${at}/api/repos/csp/handbook/index.html`, {
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    // This directive is the one doing the work: a script that still runs cannot
    // send what it read anywhere, and cannot fetch the page holding the token.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
  });

  it('still allows what the handbook legitimately needs', () => {
    // Inline script and style, because opening by double-click with no server
    // is the artifact's whole point; and `'self'` scripts, because the
    // multi-page render loads `search-index.js` as a sibling rather than
    // inlining the index into every page. A policy that broke either would be
    // reverted by the first person who noticed, taking the protection with it.
    expect(HANDBOOK_CSP).toContain("script-src 'self' 'unsafe-inline'");
    expect(HANDBOOK_CSP).toContain("style-src 'unsafe-inline'");
  });

  it("does not put the policy on studio's own UI", async () => {
    // The UI genuinely needs to call its API. Applying the handbook's policy
    // here would break every button in the product.
    const res = await fetch(at);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  describe('and a browser can actually load it', () => {
    /**
     * The handbook is shown in an IFRAME, and an iframe navigation carries no
     * `Authorization` header — nor do the sub-resources the handbook then loads
     * relative to itself. Adding the token to the iframe's URL would not have
     * covered those either. So the shell sets a cookie, which is the one
     * credential a browser sends for these loads on its own.
     *
     * Without this the whole preview 401s, which is exactly what happened when
     * the token was introduced.
     */
    const cookieFrom = async (): Promise<string> =>
      ((await fetch(at)).headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    it('sets the token as a cookie when it serves the shell', async () => {
      const raw = (await fetch(at)).headers.get('set-cookie') ?? '';
      expect(raw).toContain(`hb_token=${TOK}`);
      // HttpOnly so script cannot read it back out; Strict so no other origin
      // can make the browser send it. Together with the Host/Origin check, that
      // is the CSRF story for a credential the browser attaches automatically.
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Strict/i);
    });

    it('accepts that cookie for an iframe-style load', async () => {
      const res = await fetch(`${at}/api/repos/csp/handbook/index.html`, {
        headers: { cookie: await cookieFrom() },
      });
      expect(res.status).toBe(200);
    });

    it('refuses a wrong cookie', async () => {
      const res = await fetch(`${at}/api/repos/csp/handbook/index.html`, {
        headers: { cookie: 'hb_token=not-the-token' },
      });
      expect(res.status).toBe(401);
    });

    it('refuses a load with no credential at all', async () => {
      expect((await fetch(`${at}/api/repos/csp/handbook/index.html`)).status).toBe(401);
    });
  });
});
