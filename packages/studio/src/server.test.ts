import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  beforeAll(async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'hb-studio-'));
    sourceRoot = mkdtempSync(join(tmpdir(), 'hb-studio-src-'));
    writeFixtureRepo(sourceRoot);
    server = await startStudio({
      stateDir,
      port: PORT,
      clientFactory: () => new MockChatClient(mockRules()),
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
    const list = await api('/api/repos');
    expect(list).toHaveLength(1);
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

  it('removes a repo', async () => {
    const out = await api('/api/repos/demo', { method: 'DELETE' });
    expect(out.removed).toBe(true);
    expect(await api('/api/repos')).toHaveLength(0);
  });
});
