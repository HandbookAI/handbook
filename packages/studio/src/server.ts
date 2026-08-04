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
  truncate,
  writeJsonFile,
  type Logger,
} from '@handbook/core';
import { OpenAiChatClient, type ChatClient } from '@handbook/llm';
import { WorkDir, generateHandbook, loadHandbookModel, runPhase1 } from '@handbook/pipeline';
import { isInternalNode } from '@handbook/core';
import { renderAgentSite, renderHtmlSite, renderMarkdownHandbook, renderSinglePageHtml } from '@handbook/renderer';
import { parseDeclarations, runPlanner } from '@handbook/planner';
import { resyncHandbook } from '@handbook/resync';
import { applyPlan, listBackups, rollback } from '@handbook/patcher';
import { StateStore, type RepoEntry } from './state.js';
import { JobRunner, type Job, type JobKind } from './jobs.js';

export interface StudioOptions {
  /** Directory for studio.json and default work dirs. */
  stateDir: string;
  /** Port to listen on (127.0.0.1 only). Default 4860. */
  port?: number;
  /** LLM client factory — injectable for tests; default reads OPENAI_* env. */
  /** Injectable LLM client. Receives the job logger so retries reach its log. */
  clientFactory?: (logger: Logger) => ChatClient;
  logger?: Logger;
}

interface Ctx {
  store: StateStore;
  jobs: JobRunner;
  clientFactory: (logger: Logger) => ChatClient;
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
function repoStatus(repo: RepoEntry, jobs?: JobRunner): Record<string, unknown> {
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
    // The UI had no way to know a job was running here, so its buttons stayed
    // enabled and a second click met a bare "already has a running job"; and a
    // collapsed drawer left no way back to the job that was still going.
    runningJob: (() => {
      const live = jobs?.list(repo.name).find((j) => j.status === 'running');
      return live ? { id: live.id, kind: live.kind, startedAt: live.startedAt } : null;
    })(),
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

/**
 * File-level impact graph for visualization: nodes are files (optionally
 * restricted to one stage's bucket plus its immediate neighbours), edges are
 * internal call relations aggregated per file pair.
 */
function impactGraph(repo: RepoEntry, stage: string | null, limit: number): Record<string, unknown> {
  const work = new WorkDir(repo.workDir);
  const graph = work.loadGraph();
  const fileOf = new Map<string, string>();
  for (const node of Object.values(graph.nodes)) {
    if (isInternalNode(node)) fileOf.set(node.id, node.file);
  }
  const weights = new Map<string, number>();
  for (const edge of graph.edges) {
    const from = fileOf.get(edge.callerId);
    const to = fileOf.get(edge.calleeId);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }

  let focus: Set<string> | undefined;
  if (stage) {
    const bucket = work.loadAssignment().buckets[stage] ?? [];
    focus = new Set(bucket);
    for (const key of weights.keys()) {
      const [from, to] = key.split('\u0000') as [string, string];
      if (focus.has(from)) focus.add(to);
      else if (focus.has(to)) focus.add(from);
    }
  }

  const degree = new Map<string, number>();
  for (const [key, weight] of weights) {
    const [from, to] = key.split('\u0000') as [string, string];
    if (focus && !(focus.has(from) && focus.has(to))) continue;
    degree.set(from, (degree.get(from) ?? 0) + weight);
    degree.set(to, (degree.get(to) ?? 0) + weight);
  }
  const keep = new Set(
    [...degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(4, Math.min(200, limit)))
      .map(([file]) => file),
  );

  const assignment = work.loadAssignment();
  const stageOf = (file: string): string => assignment.fileStage[file]?.stage ?? 'unassigned';
  const nodes = [...keep].sort().map((file) => ({
    file,
    stage: stageOf(file),
    degree: degree.get(file) ?? 0,
    functions: (fileOf.size > 0 ? [...fileOf.entries()].filter(([, f]) => f === file).length : 0),
  }));
  const links = [...weights.entries()]
    .map(([key, weight]) => {
      const [from, to] = key.split('\u0000') as [string, string];
      return { from, to, weight };
    })
    .filter((l) => keep.has(l.from) && keep.has(l.to))
    .sort((a, b) => b.weight - a.weight);
  return { stage, nodes, links, totalFiles: graph.metadata.scannedFiles.length };
}

/** Function anchors (name + line range) for one file, from the call graph. */
function fileFunctions(repo: RepoEntry, relFile: string): Array<Record<string, unknown>> {
  try {
    const graph = new WorkDir(repo.workDir).loadGraph();
    return Object.values(graph.nodes)
      .filter((n) => isInternalNode(n) && n.file === relFile && !n.synthetic && n.lineStart > 0)
      .map((n) => ({
        qualname: (n as { qualname: string }).qualname,
        lineStart: (n as { lineStart: number }).lineStart,
        lineEnd: (n as { lineEnd: number }).lineEnd,
      }))
      .sort((a, b) => (a.lineStart as number) - (b.lineStart as number));
  } catch {
    return [];
  }
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

/** Read an optional artifact: a malformed one must not 404 the whole overview. */
function readOptional<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

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
    client: needsLlm ? ctx.clientFactory(logger) : undefined,
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
    client: ctx.clientFactory(logger),
    sourceRoot: repo.sourceRoot,
    handbookDir: fileExists(join(handbookDir, 'index.md')) ? handbookDir : undefined,
    request,
    logger,
  });
  return { plan: result.plan, declarations: result.declarations, turns: result.turns, trace: result.trace };
}

function patchBackupRoot(repo: RepoEntry): string {
  return join(repo.workDir, 'patches');
}

async function runApply(repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const plan = typeof body.plan === 'string' ? body.plan : '';
  if (!plan.trim()) throw new Error('missing "plan"');
  const dryRun = body.dryRun === true;
  // A plan with no edit blocks AND empty declarations is the planner saying "no
  // code change is needed" — a legitimate conclusion, not a malformed plan. Both
  // used to surface as the same red failure, which reads as "the tool is broken".
  const hasEditBlock = /^ {0,3}###\s+EDIT\s+\d+\s*$/m.test(plan);
  if (!hasEditBlock) {
    const decl = parseDeclarations(plan);
    const declaredNothing =
      decl !== undefined && decl.willModify.length + decl.willAdd.length + decl.willRemove.length === 0;
    if (declaredNothing) {
      logger.info('[patch] the plan contains no edit blocks and declares no changes — nothing to apply');
      return { ok: true, noChanges: true, dryRun, outcomes: [], changedFiles: [], problems: [] };
    }
  }
  const result = applyPlan({
    sourceRoot: repo.sourceRoot,
    plan,
    dryRun,
    backupRoot: patchBackupRoot(repo),
    logger,
  });
  for (const problem of result.problems) logger.warn(`plan problem: ${problem}`);
  for (const outcome of result.outcomes) {
    const mark = outcome.status === 'applied' || outcome.status === 'created' ? '✓' : '✗';
    logger.info(`${mark} EDIT ${outcome.index} ${outcome.file} — ${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}`);
  }
  if (!result.ok) {
    const why = result.problems.length > 0 ? `: ${result.problems.join('; ')}` : ' (see the per-edit results)';
    throw new Error(`plan did not verify — nothing was written${why}`);
  }
  return result;
}

async function runRollback(repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const known = listBackups(patchBackupRoot(repo));
  const requested = typeof body.backup === 'string' && body.backup ? body.backup : known[0];
  if (!requested) throw new Error('no patch backups to roll back');
  // Allow-list the stamp: never join user input into a filesystem path.
  if (!known.includes(requested)) throw new Error(`unknown backup "${requested}"`);
  const result = rollback(join(patchBackupRoot(repo), requested), {
    force: body.force === true,
    expectedSourceRoot: repo.sourceRoot,
    logger,
  });
  if (result.skipped.length > 0) {
    for (const s of result.skipped) logger.warn(`skipped ${s.file}: ${s.reason}`);
  }
  return { backup: requested, ...result };
}

/** Where an evolution's description came from — the UI must not blur these. */
type DescriptionSource = 'user' | 'auto' | 'files' | 'none';

/**
 * Label a resync the author did not describe.
 *
 * It states which CAPABILITIES the change touched, never why: this path has no
 * diff, only the changed paths and those files' handbook purposes, so intent is
 * not something it could know. Falls back to a deterministic file list when there
 * is no client (structure-only resync) or the call fails — a missing label must
 * never cost the run.
 */
async function summariseChange(
  repo: RepoEntry,
  report: { changedFiles: string[]; addedFiles: string[]; deletedFiles: string[]; affectedStages: string[] },
  client: ChatClient | undefined,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<{ text: string; source: DescriptionSource } | undefined> {
  const touched = [...report.changedFiles, ...report.addedFiles];
  const removed = report.deletedFiles;
  const zh = body.narrateLang !== 'en';
  // Nothing changed is itself a fact worth writing down: a timeline entry reading
  // "no file changes" tells the reader something, "(no description)" does not.
  if (touched.length === 0 && removed.length === 0) {
    return { text: zh ? '无文件变更' : 'no file changes', source: 'files' };
  }

  /** Deterministic, free, always available. */
  const fromFiles = (): { text: string; source: DescriptionSource } => {
    const all = [...touched, ...removed];
    const head = all[0] ?? '';
    const rest = all.length - 1;
    return {
      text: zh
        ? `${head}${rest > 0 ? ` 等 ${all.length} 个文件` : ''}`
        : `${head}${rest > 0 ? ` and ${rest} more file(s)` : ''}`,
      source: 'files',
    };
  };
  if (!client) return fromFiles();

  try {
    const cards = new WorkDir(repo.workDir).loadCards();
    const lines = touched.slice(0, 12).map((file) => {
      const purpose = cards[file]?.purpose?.trim();
      return `- ${file}${purpose ? `：${truncate(purpose, 120)}` : ''}`;
    });
    for (const file of removed.slice(0, 6)) lines.push(`- ${file}（已删除）`);
    const prompt = zh
      ? [
          '下面是一次代码改动涉及的文件，以及每个文件在手册里的用途。',
          '请用一句不超过 40 字的中文，概括这次改动**涉及哪些能力/模块**。',
          '只描述涉及范围，不要猜测改动的目的或原因，不要加任何前后缀、引号或标点结尾。',
          '',
          ...lines,
        ].join('\n')
      : [
          'Below are the files a code change touched, with each file’s purpose from the handbook.',
          'In one sentence under 20 words, name which capabilities/modules the change touched.',
          'Describe scope only — never guess the intent or reason. No prefix, quotes, or trailing period.',
          '',
          ...lines,
        ].join('\n');
    const reply = await client.complete(prompt, { temperature: 0, maxTokens: 200 });
    const text = reply.text.trim().split(/\r?\n/)[0]?.replace(/^["'「『]|["'」』。.]+$/g, '').trim() ?? '';
    if (text.length >= 4 && text.length <= 120) return { text, source: 'auto' };
    logger.warn(`[resync] auto-summary unusable (${text.length} chars) — falling back to the file list`);
  } catch (error) {
    logger.warn(`[resync] auto-summary failed: ${String(error)} — falling back to the file list`);
  }
  return fromFiles();
}

async function runResync(ctx: Ctx, repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caseDir = join(evolutionsDir(repo), stamp);
  ensureDir(caseDir);
  const planText = typeof body.description === 'string' ? body.description : undefined;
  const noLlm = body.noLlm === true;
  const client = noLlm ? undefined : ctx.clientFactory(logger);
  let report;
  try {
    report = await resyncHandbook({
    caseDir,
    editedRoot: repo.sourceRoot,
    planText,
    workDir: repo.workDir,
    client,
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
  // A resync with no description used to leave a bare dash in the timeline while
  // the facts needed to label it sat in the report. Fill it in — but never let the
  // reader mistake a machine summary for the author's own intent, and never let a
  // cosmetic summary fail the resync that already succeeded.
  const typed = (planText ?? '').trim();
  const auto = typed ? undefined : await summariseChange(repo, report, client, body, logger);
  const evolution = {
    id: stamp,
    at: new Date().toISOString(),
    description: typed || auto?.text || '(no description)',
    descriptionSource: typed ? ('user' as const) : (auto?.source ?? ('none' as const)),
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
    json(res, 200, ctx.store.list().map((r) => repoStatus(r, ctx.jobs)));
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
    json(res, 201, repoStatus(entry, ctx.jobs));
    return;
  }

  if (path === '/api/history' && method === 'GET') {
    const all: Array<Record<string, unknown>> = ctx.store
      .list()
      .flatMap((repo) => listEvolutions(repo).map((e) => ({ repo: repo.name, ...(e as Record<string, unknown>) })));
    all.sort((a, b) => String(b.at ?? b.id ?? '').localeCompare(String(a.at ?? a.id ?? '')));
    json(res, 200, all);
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
      json(res, 200, repoStatus(repo, ctx.jobs));
      return;
    }
    if (
      method === 'POST' &&
      (sub === '/generate' || sub === '/analyze' || sub === '/plan' || sub === '/resync' || sub === '/apply' || sub === '/rollback')
    ) {
      const body = await readBody(req);
      const kind = sub.slice(1) as 'generate' | 'analyze' | 'plan' | 'resync' | 'apply' | 'rollback';
      const jobKind: JobKind = kind === 'analyze' ? 'generate' : (kind as JobKind);
      const job = ctx.jobs.start(repo.name, jobKind, (logger) => {
        switch (kind) {
          case 'analyze':
            return runAnalyzeOnly(repo, logger);
          case 'generate':
            return runGenerate(ctx, repo, body, logger);
          case 'plan':
            return runPlan(ctx, repo, body, logger);
          case 'resync':
            return runResync(ctx, repo, body, logger);
          case 'apply':
            return runApply(repo, body, logger);
          case 'rollback':
            return runRollback(repo, body, logger);
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
          // Assignment coverage says every file found a chapter; it says nothing
          // about whether the files were actually DESCRIBED. Report both, so a
          // run whose cards came back empty cannot look complete.
          cardCoverage: readOptional(() => work.loadCardCoverage() ?? null),
          registers,
        });
      } catch (error) {
        json(res, 409, { error: `handbook not generated yet: ${error instanceof Error ? error.message : error}` });
      }
      return;
    }
    if (method === 'GET' && sub === '/graph') {
      try {
        json(res, 200, impactGraph(repo, url.searchParams.get('stage'), Number(url.searchParams.get('limit') ?? '60')));
      } catch (error) {
        json(res, 409, { error: `no call graph yet: ${error instanceof Error ? error.message : error}` });
      }
      return;
    }
    if (method === 'GET' && sub === '/source') {
      const rel = url.searchParams.get('path') ?? '';
      const full = resolve(repo.sourceRoot, normalize(rel));
      if (!rel || (full !== resolve(repo.sourceRoot) && !full.startsWith(resolve(repo.sourceRoot) + sep))) {
        json(res, 400, { error: 'path escapes the source root' });
        return;
      }
      try {
        if (statSync(full).size > 2_000_000) {
          json(res, 413, { error: 'file too large to display' });
          return;
        }
        json(res, 200, { path: rel, content: readFileSync(full, 'utf8'), functions: fileFunctions(repo, rel) });
      } catch {
        json(res, 404, { error: `not found: ${rel}` });
      }
      return;
    }
    if (method === 'GET' && sub === '/patches') {
      json(res, 200, listBackups(patchBackupRoot(repo)));
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
    // Pass the job logger: a silent client hides retries, timeouts and
    // gateway blocks, which is how a failing run looks like a quiet one.
    clientFactory: options.clientFactory ?? ((logger: Logger) => new OpenAiChatClient({ logger })),
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
