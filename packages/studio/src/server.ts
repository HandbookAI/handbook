/**
 * The Studio server: a dependency-free node:http JSON API + SSE job streams +
 * static serving of rendered handbooks, all bound to 127.0.0.1 (local tool —
 * source paths and prose never leave the machine except via the configured
 * LLM endpoint used by the pipeline itself).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir,
  fileExists,
  readJsonFile,
  silentLogger,
  writeJsonFile,
  type Logger,
} from '@handbook/core';
import { OpenAiChatClient, type ChatClient } from '@handbook/llm';
import { WorkDir, generateHandbook, loadHandbookModel, runPhase1 } from '@handbook/pipeline';
import { renderAgentSite, renderHtmlSite, renderMarkdownHandbook, renderSinglePageHtml } from '@handbook/renderer';
import { runPlanner } from '@handbook/planner';
import { resyncHandbook } from '@handbook/resync';
import { StateStore, type RepoEntry } from './state.js';
import { JobRunner, type Job } from './jobs.js';

export interface StudioOptions {
  /** Directory for studio.json and default work dirs. */
  stateDir: string;
  /** Port to listen on (127.0.0.1 only). Default 4860. */
  port?: number;
  /** LLM client factory — injectable for tests; default reads OPENAI_* env. */
  clientFactory?: () => ChatClient;
  logger?: Logger;
}

interface Ctx {
  store: StateStore;
  jobs: JobRunner;
  clientFactory: () => ChatClient;
  logger: Logger;
  /** Default parent dir for auto-created work dirs. */
  stateDirWork: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 1);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8'); // decode ONCE — multi-byte chars can straddle chunks
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/** Repo status summary for the dashboard. */
function repoStatus(repo: RepoEntry): Record<string, unknown> {
  const work = new WorkDir(repo.workDir);
  const handbookDir = join(repo.workDir, 'handbook');
  let chapters = 0;
  let title: string | undefined;
  if (fileExists(join(handbookDir, 'index.md'))) {
    chapters = readdirSync(handbookDir).filter(
      (f) => f.endsWith('.md') && !['overview.md', 'index.md', 'register.md'].includes(f),
    ).length;
    title = readFileSync(join(handbookDir, 'index.md'), 'utf8').split('\n')[0]?.replace(/^#\s*/, '');
  }
  return {
    ...repo,
    hasGraph: fileExists(work.graphPath),
    hasNarration: fileExists(work.narrationPath),
    hasHandbook: fileExists(join(handbookDir, 'html', 'overview.html')),
    strategy: work.loadStrategy(),
    chapters,
    title,
    evolutions: countEvolutions(repo),
  };
}

function evolutionsDir(repo: RepoEntry): string {
  return join(repo.workDir, 'evolutions');
}

function countEvolutions(repo: RepoEntry): number {
  try {
    return readdirSync(evolutionsDir(repo)).filter(
      (d) => !d.startsWith('.') && fileExists(join(evolutionsDir(repo), d, 'evolution.json')),
    ).length;
  } catch {
    return 0;
  }
}

function listEvolutions(repo: RepoEntry): unknown[] {
  const dir = evolutionsDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => !d.startsWith('.') && fileExists(join(dir, d, 'evolution.json')))
    .sort()
    .reverse()
    .map((entry) => {
      try {
        return readJsonFile(join(dir, entry, 'evolution.json'));
      } catch {
        return { id: entry, error: 'unreadable' };
      }
    });
}

/** Serve a file from inside `root` (path-traversal safe). */
function serveStatic(res: ServerResponse, root: string, relPath: string): void {
  const full = resolve(root, normalize(relPath));
  if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) {
    json(res, 400, { error: 'path escapes root' });
    return;
  }
  let target = full;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    const body = readFileSync(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, 404, { error: `not found: ${relPath}` });
  }
}

function jobSummary(job: Job): Record<string, unknown> {
  return { ...job, log: undefined, logLines: job.log.length };
}

// ---------------------------------------------------------------------------
// Job bodies
// ---------------------------------------------------------------------------

async function runGenerate(
  ctx: Ctx,
  repo: RepoEntry,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const phase = typeof body.phase === 'string' ? body.phase : 'all';
  const needsLlm = phase !== '1';
  const stats = await generateHandbook({
    sourceRoot: repo.sourceRoot,
    workDir: repo.workDir,
    client: needsLlm ? ctx.clientFactory() : undefined,
    phase,
    detail: body.detail === 'deep' ? 'deep' : 'brief',
    narrateLang: body.narrateLang === 'zh' ? 'zh' : 'en',
    synthMode: body.synthMode === 'doctor' ? 'doctor' : 'oneshot',
    resume: body.resume === true,
    logger,
  });
  const work = new WorkDir(repo.workDir);
  if (!fileExists(work.narrationPath)) {
    logger.info('narration not present — partial phase run, skipping render');
    return { ...stats, render: null };
  }
  logger.info('rendering handbook…');
  const outDir = join(repo.workDir, 'handbook');
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : (repo.title ?? `${repo.name} Handbook`);
  ctx.store.setTitle(repo.name, title);
  const model = loadHandbookModel(repo.workDir, title);
  const md = renderMarkdownHandbook(model, outDir);
  const agent = renderAgentSite(model, join(outDir, 'agent'));
  const html = renderHtmlSite(model, join(outDir, 'html'));
  const single = renderSinglePageHtml(model, join(outDir, 'handbook.html'));
  return { ...stats, render: { ...md, files: undefined, agent, html, single } };
}

async function runAnalyzeOnly(repo: RepoEntry, logger: Logger): Promise<unknown> {
  return runPhase1({ sourceRoot: repo.sourceRoot, workDir: repo.workDir, logger });
}

async function runPlan(ctx: Ctx, repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const request = typeof body.request === 'string' ? body.request.trim() : '';
  if (!request) throw new Error('missing "request"');
  const handbookDir = join(repo.workDir, 'handbook');
  const result = await runPlanner({
    client: ctx.clientFactory(),
    sourceRoot: repo.sourceRoot,
    handbookDir: fileExists(join(handbookDir, 'index.md')) ? handbookDir : undefined,
    request,
    logger,
  });
  return { plan: result.plan, declarations: result.declarations, turns: result.turns, trace: result.trace };
}

async function runResync(ctx: Ctx, repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caseDir = join(evolutionsDir(repo), stamp);
  ensureDir(caseDir);
  const planText = typeof body.description === 'string' ? body.description : undefined;
  const noLlm = body.noLlm === true;
  let report;
  try {
    report = await resyncHandbook({
    caseDir,
    editedRoot: repo.sourceRoot,
    planText,
    workDir: repo.workDir,
    client: noLlm ? undefined : ctx.clientFactory(),
    noLlm,
    lang: body.narrateLang === 'zh' ? 'zh' : body.narrateLang === 'en' ? 'en' : undefined,
    logger,
    });
  } catch (error) {
    // A failed resync must not leave a phantom history entry behind.
    rmSync(caseDir, { recursive: true, force: true });
    throw error;
  }
  logger.info('re-rendering handbook…');
  const outDir = join(repo.workDir, 'handbook');
  const model = loadHandbookModel(repo.workDir, repo.title ?? `${repo.name} Handbook`);
  renderMarkdownHandbook(model, outDir);
  renderAgentSite(model, join(outDir, 'agent'));
  renderHtmlSite(model, join(outDir, 'html'));
  renderSinglePageHtml(model, join(outDir, 'handbook.html'));
  const evolution = {
    id: stamp,
    at: new Date().toISOString(),
    description: planText ?? '(no description)',
    report,
  };
  writeJsonFile(join(caseDir, 'evolution.json'), evolution);
  return evolution;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    const uiPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(uiPath));
    return;
  }

  if (path === '/api/repos' && method === 'GET') {
    json(res, 200, ctx.store.list().map(repoStatus));
    return;
  }

  if (path === '/api/repos' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    const rawSource = String(body.sourceRoot ?? '').trim();
    if (!name || !rawSource) {
      json(res, 400, { error: 'name and sourceRoot are required' });
      return;
    }
    const sourceRoot = resolve(rawSource);
    const workDir = body.workDir ? resolve(String(body.workDir)) : join(ctx.stateDirWork, name);
    const entry = ctx.store.add({ name, sourceRoot, workDir });
    ensureDir(workDir);
    json(res, 201, repoStatus(entry));
    return;
  }

  const repoMatch = path.match(/^\/api\/repos\/([^/]+)(\/.*)?$/);
  if (repoMatch) {
    const repo = ctx.store.get(decodeURIComponent(repoMatch[1] ?? ''));
    if (!repo) {
      json(res, 404, { error: 'unknown repo' });
      return;
    }
    const sub = repoMatch[2] ?? '';

    if (method === 'DELETE' && sub === '') {
      if (ctx.jobs.isBusy(repo.name)) {
        json(res, 409, { error: 'repo has a running job — wait for it to finish' });
        return;
      }
      ctx.store.remove(repo.name);
      json(res, 200, { removed: true });
      return;
    }
    if (method === 'GET' && sub === '') {
      json(res, 200, repoStatus(repo));
      return;
    }
    if (method === 'POST' && (sub === '/generate' || sub === '/analyze' || sub === '/plan' || sub === '/resync')) {
      const body = await readBody(req);
      const kind = sub.slice(1) as 'generate' | 'analyze' | 'plan' | 'resync';
      const job = ctx.jobs.start(repo.name, kind === 'analyze' ? 'generate' : kind, (logger) => {
        switch (kind) {
          case 'analyze':
            return runAnalyzeOnly(repo, logger);
          case 'generate':
            return runGenerate(ctx, repo, body, logger);
          case 'plan':
            return runPlan(ctx, repo, body, logger);
          case 'resync':
            return runResync(ctx, repo, body, logger);
        }
      });
      json(res, 202, jobSummary(job));
      return;
    }
    if (method === 'GET' && sub === '/overview') {
      try {
        const work = new WorkDir(repo.workDir);
        const skeleton = work.loadSkeleton();
        const assignment = work.loadAssignment();
        const narration = fileExists(work.narrationPath) ? work.loadNarration() : undefined;
        const registers = work.loadRegisters().registers;
        json(res, 200, {
          stages: skeleton.stages.map((s) => ({
            ...s,
            files: assignment.buckets[s.id]?.length ?? 0,
            summary: narration?.stageSummaries[s.id] ?? '',
          })),
          systemOverview: narration?.systemOverview ?? '',
          coverage: assignment.coverage,
          registers,
        });
      } catch (error) {
        json(res, 409, { error: `handbook not generated yet: ${error instanceof Error ? error.message : error}` });
      }
      return;
    }
    if (method === 'GET' && sub === '/history') {
      json(res, 200, listEvolutions(repo));
      return;
    }
    if (method === 'GET' && sub.startsWith('/handbook')) {
      const rel = sub.slice('/handbook'.length).replace(/^\//, '') || 'html/overview.html';
      serveStatic(res, join(repo.workDir, 'handbook'), rel);
      return;
    }
  }

  const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/stream)?$/);
  if (jobMatch && method === 'GET') {
    const job = ctx.jobs.get(jobMatch[1] ?? '');
    if (!job) {
      json(res, 404, { error: 'unknown job' });
      return;
    }
    if (jobMatch[2] === '/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const line of job.log) res.write(`data: ${JSON.stringify(line)}\n\n`);
      if (job.status !== 'running') {
        res.write('event: done\ndata: {}\n\n');
        res.end();
        return;
      }
      const unsubscribe = ctx.jobs.subscribe(job.id, (line, done) => {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
        if (done) {
          res.write('event: done\ndata: {}\n\n');
          res.end();
        }
      });
      req.on('close', unsubscribe);
      return;
    }
    json(res, 200, { ...job });
    return;
  }

  json(res, 404, { error: `no route: ${method} ${path}` });
}

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function isLoopbackRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOST_RE.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN_RE.test(origin)) return false;
  return true;
}

export function createStudioServer(options: StudioOptions): Server {
  ensureDir(options.stateDir);
  const ctx: Ctx = {
    store: new StateStore(options.stateDir),
    jobs: new JobRunner(),
    clientFactory: options.clientFactory ?? (() => new OpenAiChatClient()),
    logger: options.logger ?? silentLogger,
    stateDirWork: join(options.stateDir, 'work'),
  };
  return createServer((req, res) => {
    // Local-tool CSRF defence: a hostile web page can fire requests at
    // 127.0.0.1, so only loopback Hosts and (when present) loopback Origins
    // are accepted, and mutating requests must be real JSON.
    if (!isLoopbackRequest(req)) {
      json(res, 403, { error: 'forbidden: studio only accepts local requests' });
      return;
    }
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) {
      json(res, 415, { error: 'POST bodies must be application/json' });
      return;
    }
    route(ctx, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    });
  });
}

/** Start the server on 127.0.0.1 and return it once listening. */
export function startStudio(options: StudioOptions): Promise<Server> {
  const server = createStudioServer(options);
  const port = options.port ?? 4860;
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}
