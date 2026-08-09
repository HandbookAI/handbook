/**
 * The Studio server: a dependency-free node:http JSON API + SSE job streams +
 * static serving of rendered handbooks. Binds 127.0.0.1 by default — a local
 * tool; source paths and prose never leave the machine except via the
 * configured LLM endpoint used by the pipeline itself. The bind address is
 * configurable (a container needs 0.0.0.0), but the Host-header CSRF guard
 * below is unaffected by that: it is what actually decides who may talk to
 * this server, not the socket it happens to be listening on.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NARRATE_LANGUAGES,
  ensureDir,
  fileExists,
  readJsonFile,
  resolveConfig,
  settingByKey,
  settingsFor,
  silentLogger,
  truncate,
  writeJsonFile,
  type ConfigFileData,
  type Logger,
  type Setting,
} from '@handbook/core';
import { CachedChatClient, OpenAiChatClient, llmConfigFromValues, type ChatClient } from '@handbook/llm';
import { availableLanguages, registerBuiltinAdapters } from '@handbook/analyzer';
import { WorkDir, generateHandbook, loadHandbookModel, runPhase1 } from '@handbook/pipeline';
import { isInternalNode } from '@handbook/core';
import {
  renderAgentSite,
  renderHtmlSite,
  renderLlmsTxt,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbook/renderer';
import { parseDeclarations, runPlanner } from '@handbook/planner';
import { resyncHandbook } from '@handbook/resync';
import { buildSkill, validateSkill } from '@handbook/skill';
import { applyPlan, listBackups, rollback } from '@handbook/patcher';
import { REPO_NAME_RE, StateStore, type RepoEntry } from './state.js';
import { JobRunner, type Job, type JobKind } from './jobs.js';

export interface StudioOptions {
  /** Directory for studio.json and default work dirs. */
  stateDir: string;
  /** Port to listen on. Default: the registry default for `port`. */
  port?: number;
  /** Bind address. Default: the registry default for `host` (loopback) — a
   *  container passes 0.0.0.0. The Host-header guard in createStudioServer is
   *  unaffected and must stay as it is. */
  host?: string;
  /**
   * Injectable LLM client. Receives the job logger so retries reach its log,
   * and the per-job LLM overrides (`llmModel`, `llmBaseUrl`, …) the request
   * carried — already validated against the registry, never the API key, which
   * is env-only. Default reads OPENAI_* env and applies the overrides on top.
   */
  clientFactory?: (logger: Logger, llmOverrides?: Record<string, unknown>) => ChatClient;
  /**
   * The project config file (`handbook.config.yaml`), already discovered and
   * loaded by the CLI's `preAction` hook. Passed through so a generate job's
   * parameters — `detail`, `narrateLang`, `readWorkers`, etc. — see the same
   * file layer as every other command, not just the environment. Absent when
   * studio is embedded without one (e.g. tests, or no file present).
   */
  configFile?: ConfigFileData;
  logger?: Logger;
}

interface Ctx {
  store: StateStore;
  jobs: JobRunner;
  clientFactory: (logger: Logger, llmOverrides?: Record<string, unknown>) => ChatClient;
  configFile?: ConfigFileData;
  logger: Logger;
  /** Default parent dir for auto-created work dirs. */
  stateDirWork: string;
}

/** The per-job tunable LLM settings. `llmApiKey` is deliberately absent — see rejectSecrets. */
const LLM_OVERRIDE_KEYS = [
  'llmModel',
  'llmBaseUrl',
  'llmMaxTokens',
  'llmTimeout',
  'llmMaxRetries',
  'llmRetryBackoff',
  'llmConcurrency',
  'llmExtraBody',
] as const;

/**
 * Refuse a request that carries a secret.
 *
 * The registry's own rule is that secrets are never a flag and are rejected in
 * a config file, because those surfaces get persisted and shared. An HTTP body
 * is the same kind of surface — it lands in logs, dev-tools HAR exports and
 * `lastParams` — so the key travels by environment only. Silently dropping it
 * (what this API used to do) is worse than refusing: the caller believes the
 * key was used.
 */
function rejectSecrets(body: Record<string, unknown>): void {
  if ('llmApiKey' in body || 'OPENAI_API_KEY' in body) {
    throw new Error(
      'llmApiKey is environment-only — set OPENAI_API_KEY where studio runs; it is never accepted over HTTP',
    );
  }
}

/**
 * The llm-group overrides this request actually carried, post-validation.
 *
 * Only keys present in the BODY are forwarded: `values` also contains what env
 * and the config file supplied, and re-sending those to the client factory
 * would overwrite the factory's own launch-time configuration with a copy of
 * itself at best, and with registry defaults at worst.
 */
function llmOverridesFrom(
  body: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const key of LLM_OVERRIDE_KEYS) {
    if (body[key] !== undefined) overrides[key] = values[key];
  }
  return overrides;
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
  // typeof [] === 'object' and [] !== null, so a JSON array slips past a bare
  // object check and gets cast to Record — then `body.plan`/`body.name` read as
  // undefined and a doomed (or silently defaulted) job starts on a 202 instead of
  // this request failing loud as a 400. Arrays are not the object the API expects.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * An existing work dir built from THIS source tree, if one is sitting in a
 * conventional place.
 *
 * Matching is by evidence, not by name: `phase1/graph.json` records the
 * `sourceRoot` it was analyzed from, so a directory can be claimed only when it
 * says it belongs to this tree. Guessing directory names does not work — this
 * repo's own handbook lives in `examples/work/self`, which matches neither the
 * repo name nor the source basename.
 *
 * Only conventional containers are listed, one level deep — never a disk search.
 * Without this, someone who generated a handbook with the CLI and then
 * registered the same tree in studio got a fresh empty work dir, concluded the
 * handbook was lost, and paid to regenerate it.
 */
function findWorkDirFor(sourceRoot: string, stateDirWork: string): string | undefined {
  const parent = dirname(resolve(sourceRoot));
  const containers = [stateDirWork, join(parent, 'work'), join(parent, 'examples', 'work')];
  const wanted = realpathOrSelf(resolve(sourceRoot));
  for (const container of containers) {
    let entries: string[];
    try {
      entries = readdirSync(container);
    } catch {
      continue; // container absent — nothing to adopt here
    }
    for (const entry of entries.sort()) {
      const dir = join(container, entry);
      if (builtFrom(dir) === wanted) return dir;
    }
  }
  return undefined;
}

/** The source root a work dir was analyzed from, or undefined if it holds no graph. */
function builtFrom(workDir: string): string | undefined {
  try {
    const recorded = new WorkDir(workDir).loadGraph().metadata.sourceRoot;
    return realpathOrSelf(recorded);
  } catch {
    return undefined; // not a work dir, unreadable, or a graph we cannot validate
  }
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
    // Every generate renders three outputs (multi-page site, single page, agent
    // locator index) — report each one, so the UI only offers links that exist.
    outputs: {
      html: fileExists(join(handbookDir, 'html', 'overview.html')),
      single: fileExists(join(handbookDir, 'handbook.html')),
      agent: fileExists(join(handbookDir, 'agent', 'how_to_use.md')),
      // Whether a SKILL package has been built. Without this the UI cannot
      // tell a "validate" that is ready to run from one that will come back
      // 409, so the button was offered whenever a handbook existed and the
      // refusal read as a malfunction instead of "package it first".
      skill: fileExists(join(repo.workDir, 'skill', 'SKILL.md')),
    },
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
    functions: fileOf.size > 0 ? [...fileOf.entries()].filter(([, f]) => f === file).length : 0,
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

/**
 * Resolve `rel` under `root`, refusing anything that escapes the sandbox either
 * lexically (`../`, absolute paths) OR through a symlink. The lexical test alone
 * is not enough: a link that sits inside the tree but points outside it
 * (`…/app/link -> /etc/passwd`) passes the string check, and readFileSync would
 * happily follow it out. Returns the safe absolute path, or null on escape.
 */
function safeResolve(root: string, rel: string): string | null {
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, normalize(rel));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null;
  // Follow every symlink in the path and re-check containment. realpath throws
  // for a path that does not exist yet — that is not an escape (the lexical test
  // already proved the intended path is inside), so the caller's read can 404.
  try {
    const realRoot = realpathSync(rootAbs);
    const realFull = realpathSync(full);
    if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) return null;
  } catch {
    return full;
  }
  return full;
}

/** Serve a file from inside `root` (path-traversal AND symlink safe). */
function serveStatic(res: ServerResponse, root: string, relPath: string): void {
  let target = safeResolve(root, relPath);
  if (!target) {
    json(res, 400, { error: 'path escapes root' });
    return;
  }
  try {
    if (statSync(target).isDirectory()) {
      // A directory rewrite to index.html must itself stay inside the sandbox.
      const idx = safeResolve(root, join(target, 'index.html'));
      if (!idx) {
        json(res, 400, { error: 'path escapes root' });
        return;
      }
      target = idx;
    }
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

/** Everything the generate dialog / CLI can say, already validated. */
interface GenerateParams {
  phase: string;
  strategy?: 'file' | 'member';
  skeletonPath?: string;
  lang: string;
  narrateLang: 'en' | 'zh';
  detail: 'brief' | 'deep';
  synthMode: 'oneshot' | 'doctor';
  maxDoctorRounds: number;
  readWorkers: number;
  readBatchSize?: number;
  maxCharsPerFile: number;
  assignBatchSize: number;
  assignWorkers: number;
  organizeWorkers: number;
  narrateWorkers: number;
  resume: boolean;
  refresh: boolean;
  llmCache: boolean;
  debug: boolean;
  llmOverrides: Record<string, unknown>;
  title?: string;
}

/**
 * Validate a generate request BEFORE the job starts: bad input is the
 * caller's bug and deserves a 400, not a job that fails ten seconds later.
 *
 * Routed through the shared `resolveConfig` — the same one the CLI's
 * `generate` action uses — so a studio job honours `.env` and
 * `handbook.config.yaml` exactly like the command line, and an invalid enum
 * (`{"detail":"typo"}`) is a 400 naming the field, not a silent fallback to
 * the default. `source`/`work` are supplied from the repo entry only to
 * satisfy the resolver's required check for `generate`; studio manages those
 * two itself and the resolved values are discarded below.
 */
function parseGenerateParams(
  body: Record<string, unknown>,
  repo: RepoEntry,
  configFile?: ConfigFileData,
): GenerateParams {
  rejectSecrets(body);
  preflight('generate', body, configFile, { source: repo.sourceRoot, work: repo.workDir });
  const { values, errors } = resolveConfig({
    command: 'generate',
    flags: { ...body, source: repo.sourceRoot, work: repo.workDir },
    env: process.env,
    file: configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return {
    phase: values.phase as string,
    // Unspecified strategy stays undefined so the work dir's recorded one wins,
    // exactly like the CLI — a hard 'file' default would cross strategies.
    strategy: values.strategy as 'file' | 'member' | undefined,
    skeletonPath: values.skeleton as string | undefined,
    lang: values.lang as string,
    narrateLang: values.narrateLang as 'en' | 'zh',
    detail: values.detail as 'brief' | 'deep',
    synthMode: values.synthMode as 'oneshot' | 'doctor',
    maxDoctorRounds: values.maxDoctorRounds as number,
    readWorkers: values.readWorkers as number,
    readBatchSize: values.readBatchSize as number | undefined,
    maxCharsPerFile: values.maxCharsPerFile as number,
    assignBatchSize: values.assignBatchSize as number,
    assignWorkers: values.assignWorkers as number,
    organizeWorkers: values.organizeWorkers as number,
    narrateWorkers: values.narrateWorkers as number,
    resume: values.resume as boolean,
    refresh: values.refresh as boolean,
    llmCache: values.llmCache as boolean,
    debug: values.logLevel === 'debug',
    llmOverrides: llmOverridesFrom(body, values),
    // `title` belongs to render/resync in the registry, not generate — generate
    // only forwards it to the render step that runs at the end of the job, so it
    // stays a plain pass-through rather than a resolved setting.
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
  };
}

async function runGenerate(
  ctx: Ctx,
  repo: RepoEntry,
  params: GenerateParams,
  logger: Logger,
  signal: AbortSignal,
): Promise<unknown> {
  const needsLlm = params.phase !== '1';
  let client = needsLlm ? ctx.clientFactory(logger, params.llmOverrides) : undefined;
  // Same rule as the CLI: the reply cache only helps a re-run, and --refresh is
  // the explicit request to NOT reuse anything.
  if (client && params.llmCache && !params.refresh) {
    client = new CachedChatClient(client, join(repo.workDir, 'phase3', 'cache'));
  }
  const stats = await generateHandbook({
    sourceRoot: repo.sourceRoot,
    workDir: repo.workDir,
    client,
    phase: params.phase,
    strategy: params.strategy,
    skeletonPath: params.skeletonPath,
    lang: params.lang,
    narrateLang: params.narrateLang,
    detail: params.detail,
    synthMode: params.synthMode,
    maxDoctorRounds: params.maxDoctorRounds,
    readWorkers: params.readWorkers,
    readBatchSize: params.readBatchSize,
    maxCharsPerFile: params.maxCharsPerFile,
    assignBatchSize: params.assignBatchSize,
    assignWorkers: params.assignWorkers,
    organizeWorkers: params.organizeWorkers,
    narrateWorkers: params.narrateWorkers,
    resume: params.resume,
    refresh: params.refresh,
    logger,
    signal,
  });
  // Cooperative checkpoint: a cancel that arrived while the pipeline was busy
  // stops the run here rather than spending a render on a result nobody wants.
  signal.throwIfAborted();
  const work = new WorkDir(repo.workDir);
  if (!fileExists(work.narrationPath)) {
    logger.info('narration not present — partial phase run, skipping render');
    return { ...stats, render: null };
  }
  logger.info('rendering handbook…');
  const outDir = join(repo.workDir, 'handbook');
  const title = params.title ?? repo.title ?? `${repo.name} Handbook`;
  ctx.store.setTitle(repo.name, title);
  const model = loadHandbookModel(repo.workDir, title);
  // The handbook model carries no graph metadata, so the renderers are handed the
  // per-language capability map separately — without it a generic-tier language's
  // call relations would read, in the rendered handbook, as hard as Python's.
  const languages = readOptional(() => work.loadGraph().metadata.languages) ?? undefined;
  const md = renderMarkdownHandbook(model, outDir, { languages });
  const agent = renderAgentSite(model, join(outDir, 'agent'));
  const html = renderHtmlSite(model, join(outDir, 'html'), { languages });
  const single = renderSinglePageHtml(model, join(outDir, 'handbook.html'), { languages });
  return { ...stats, render: { ...md, files: undefined, agent, html, single } };
}

async function runAnalyzeOnly(
  repo: RepoEntry,
  body: Record<string, unknown>,
  configFile: ConfigFileData | undefined,
  logger: Logger,
): Promise<unknown> {
  // Same resolver as the CLI's `analyze`, so `lang` accepts exactly the
  // registered adapter names and a typo is a 400, not a silent 'auto'.
  const { values, errors } = resolveConfig({
    command: 'analyze',
    flags: { ...body, source: repo.sourceRoot, work: repo.workDir },
    env: process.env,
    file: configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return runPhase1({
    sourceRoot: repo.sourceRoot,
    workDir: repo.workDir,
    lang: values.lang as string,
    logger,
  });
}

async function runPlan(
  ctx: Ctx,
  repo: RepoEntry,
  body: Record<string, unknown>,
  logger: Logger,
  signal: AbortSignal,
): Promise<unknown> {
  const request = typeof body.request === 'string' ? body.request.trim() : '';
  if (!request) throw new Error('missing "request"');
  const { values, errors } = resolveConfig({
    command: 'plan',
    flags: { ...body, source: repo.sourceRoot, request },
    env: process.env,
    file: ctx.configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  const handbookDir = join(repo.workDir, 'handbook');
  const result = await runPlanner({
    client: ctx.clientFactory(logger, llmOverridesFrom(body, values)),
    sourceRoot: repo.sourceRoot,
    handbookDir: fileExists(join(handbookDir, 'index.md')) ? handbookDir : undefined,
    request,
    maxTurns: values.maxTurns as number,
    logger,
  });
  // Cooperative checkpoint: a cancelled planning run must not come back green.
  signal.throwIfAborted();
  // A run that gave up must not come back green. The planner's own log said
  // "rejected (3/3)" while the drawer showed SUCCEEDED.
  if (result.aborted) {
    const why =
      result.aborted === 'fabrication'
        ? 'the model kept inventing tool results instead of reading the code'
        : result.aborted === 'turn-limit'
          ? `hit the turn limit (${result.turns}) without finishing`
          : 'finished without producing a plan';
    throw new Error(`planner produced no usable plan — ${why}. Nothing from this run is trustworthy.`);
  }
  return { plan: result.plan, declarations: result.declarations, turns: result.turns, trace: result.trace };
}

function patchBackupRoot(repo: RepoEntry): string {
  return join(repo.workDir, 'patches');
}

async function runApply(repo: RepoEntry, body: Record<string, unknown>, logger: Logger): Promise<unknown> {
  const plan = typeof body.plan === 'string' ? body.plan : '';
  if (!plan.trim()) throw new Error('missing "plan"');
  const dryRun = body.dryRun === true;
  // Registry `backupRoot`, honoured at last: an absolute path is used as given;
  // a relative one is anchored on the WORK dir (studio's own territory), never
  // resolved against the server's cwd, which the caller cannot see.
  const requestedBackupRoot =
    typeof body.backupRoot === 'string' && body.backupRoot.trim() ? body.backupRoot.trim() : undefined;
  const backupRoot =
    requestedBackupRoot === undefined
      ? patchBackupRoot(repo)
      : requestedBackupRoot.startsWith('/')
        ? requestedBackupRoot
        : join(repo.workDir, requestedBackupRoot);
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
    backupRoot,
    logger,
  });
  for (const problem of result.problems) logger.warn(`plan problem: ${problem}`);
  for (const outcome of result.outcomes) {
    const mark = outcome.status === 'applied' || outcome.status === 'created' ? '✓' : '✗';
    logger.info(
      `${mark} EDIT ${outcome.index} ${outcome.file} — ${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}`,
    );
  }
  if (!result.ok) {
    const why =
      result.problems.length > 0 ? `: ${result.problems.join('; ')}` : ' (see the per-edit results)';
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
  lang: 'en' | 'zh',
  logger: Logger,
): Promise<{ text: string; source: DescriptionSource } | undefined> {
  const touched = [...report.changedFiles, ...report.addedFiles];
  const removed = report.deletedFiles;
  // The caller resolves this from the handbook's own prose language. It used to
  // read `body.narrateLang !== 'en'` — a key the UI never sent (and the wrong
  // key besides; resync's is `proseLang`), so an English-UI user's evolution
  // descriptions were always written in Chinese.
  const zh = lang === 'zh';
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
    const text =
      reply.text
        .trim()
        .split(/\r?\n/)[0]
        ?.replace(/^["'「『]|["'」』。.]+$/g, '')
        .trim() ?? '';
    if (text.length >= 4 && text.length <= 120) return { text, source: 'auto' };
    logger.warn(`[resync] auto-summary unusable (${text.length} chars) — falling back to the file list`);
  } catch (error) {
    logger.warn(`[resync] auto-summary failed: ${String(error)} — falling back to the file list`);
  }
  return fromFiles();
}

interface ResyncParams {
  proseLang?: 'en' | 'zh';
  cardDetail?: 'brief' | 'deep';
  refreshRendered: boolean;
  correctionsPath?: string;
  noLlm: boolean;
  debug: boolean;
  llmOverrides: Record<string, unknown>;
}

/**
 * Validate a resync request BEFORE the job starts — same contract as
 * `parseGenerateParams`: garbage input is a 400 on this request, not a failed
 * job discovered in the drawer later.
 *
 * The registry's resync settings, resolved like the CLI's — `proseLang` and
 * `cardDetail` were previously unreachable from studio, and the body key
 * `narrateLang` (a generate-only setting) was silently read instead.
 */
function parseResyncParams(
  body: Record<string, unknown>,
  repo: RepoEntry,
  configFile?: ConfigFileData,
): ResyncParams {
  rejectSecrets(body);
  const { values, errors } = resolveConfig({
    command: 'resync',
    // `case` is studio-managed (the stamp dir the job creates); a placeholder
    // satisfies the resolver's required check and is never used.
    flags: { ...body, work: repo.workDir, case: '(studio)' },
    env: process.env,
    file: configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  return {
    proseLang: (values.proseLang ??
      (body.narrateLang === 'zh' || body.narrateLang === 'en' ? body.narrateLang : undefined)) as
      'en' | 'zh' | undefined,
    cardDetail: values.cardDetail as 'brief' | 'deep' | undefined,
    refreshRendered: values.refreshRendered as boolean,
    correctionsPath: values.corrections as string | undefined,
    noLlm: body.noLlm === true || values.useLlm === false,
    debug: values.logLevel === 'debug',
    llmOverrides: llmOverridesFrom(body, values),
  };
}

async function runResync(
  ctx: Ctx,
  repo: RepoEntry,
  body: Record<string, unknown>,
  params: ResyncParams,
  logger: Logger,
  signal: AbortSignal,
): Promise<unknown> {
  const { proseLang, cardDetail, refreshRendered, correctionsPath, noLlm } = params;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const caseDir = join(evolutionsDir(repo), stamp);
  ensureDir(caseDir);
  const planText = typeof body.description === 'string' ? body.description : undefined;
  const client = noLlm ? undefined : ctx.clientFactory(logger, params.llmOverrides);
  let report;
  try {
    report = await resyncHandbook({
      caseDir,
      editedRoot: repo.sourceRoot,
      planText,
      workDir: repo.workDir,
      client,
      noLlm,
      lang: proseLang,
      detail: cardDetail,
      correctionsPath,
      logger,
      signal,
    });
    // Cooperative checkpoint, still inside the try: a cancelled resync must
    // clean up its case dir exactly like a failed one — no phantom history.
    signal.throwIfAborted();
  } catch (error) {
    // A failed resync must not leave a phantom history entry behind.
    rmSync(caseDir, { recursive: true, force: true });
    throw error;
  }
  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : (repo.title ?? `${repo.name} Handbook`);
  if (title !== repo.title) ctx.store.setTitle(repo.name, title);
  if (refreshRendered) {
    logger.info('re-rendering handbook…');
    const outDir = join(repo.workDir, 'handbook');
    const model = loadHandbookModel(repo.workDir, title);
    // Same fidelity disclosure as a full generate: a resync re-renders the whole
    // handbook, so dropping it here would silently un-say it.
    const languages =
      readOptional(() => new WorkDir(repo.workDir).loadGraph().metadata.languages) ?? undefined;
    renderMarkdownHandbook(model, outDir, { languages });
    renderAgentSite(model, join(outDir, 'agent'));
    renderHtmlSite(model, join(outDir, 'html'), { languages });
    renderSinglePageHtml(model, join(outDir, 'handbook.html'), { languages });
  } else {
    // Registry `refreshRendered` (`--no-render`): the artifacts are refreshed,
    // the rendered outputs deliberately are not — say so where the reader looks.
    logger.info('skipping the re-render (refreshRendered=false) — rendered outputs are now stale');
  }
  // A resync with no description used to leave a bare dash in the timeline while
  // the facts needed to label it sat in the report. Fill it in — but never let the
  // reader mistake a machine summary for the author's own intent, and never let a
  // cosmetic summary fail the resync that already succeeded.
  // The summary language follows the handbook's own prose: the explicit
  // `proseLang` when given, else whatever language the narration on disk is in.
  const summaryLang =
    proseLang ??
    (readOptional(() => (readJsonFile(new WorkDir(repo.workDir).narrationPath) as { lang?: string }).lang) ===
    'zh'
      ? 'zh'
      : 'en');
  const typed = (planText ?? '').trim();
  const auto = typed ? undefined : await summariseChange(repo, report, client, summaryLang, logger);
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

/**
 * Re-render the existing artifacts — the CLI's `render`, jobified. No LLM.
 *
 * Output formats follow the registry defaults (all opt-in) rather than the
 * everything-on behaviour of the generate job's render step: this endpoint
 * exists precisely so the caller can choose. `out` stays studio-managed at
 * `<work>/handbook` — every viewer route serves from there.
 */
async function runRender(
  ctx: Ctx,
  repo: RepoEntry,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  rejectSecrets(body);
  const { values, errors } = resolveConfig({
    command: 'render',
    flags: { ...body, work: repo.workDir },
    env: process.env,
    file: ctx.configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  const outDir = join(repo.workDir, 'handbook');
  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : (repo.title ?? (values.title as string));
  if (title !== repo.title) ctx.store.setTitle(repo.name, title);
  const model = loadHandbookModel(repo.workDir, title);
  const languages = readOptional(() => new WorkDir(repo.workDir).loadGraph().metadata.languages) ?? undefined;
  const render = {
    languages,
    ...(values.sourceBaseUrl ? { sourceBaseUrl: values.sourceBaseUrl as string } : {}),
  };
  logger.info(`rendering markdown handbook → ${outDir}`);
  const md = renderMarkdownHandbook(model, outDir, render);
  const result: Record<string, unknown> = { outDir, nStagePages: md.nStagePages };
  if (values.agentSite) {
    logger.info('rendering the agent locator index…');
    result.agent = renderAgentSite(model, join(outDir, 'agent'), { languages });
  }
  if (values.html) {
    logger.info('rendering the multi-page HTML site…');
    result.html = renderHtmlSite(model, join(outDir, 'html'), render);
  }
  if (values.htmlSingle) {
    logger.info('rendering the single-page HTML…');
    result.htmlSingle = renderSinglePageHtml(model, join(outDir, 'handbook.html'), { languages });
  }
  if (values.llmsTxt) {
    logger.info('writing llms.txt / llms-full.txt…');
    result.llms = renderLlmsTxt(model, outDir, { languages });
  }
  return result;
}

/** Package the rendered handbook as an agent SKILL — the CLI's `skill`, jobified. No LLM. */
async function runSkillBuild(
  ctx: Ctx,
  repo: RepoEntry,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  rejectSecrets(body);
  const handbookDir = join(repo.workDir, 'handbook');
  if (!fileExists(join(handbookDir, 'index.md'))) {
    throw new Error('no rendered handbook yet — run generate (or render) first');
  }
  const outDir = join(repo.workDir, 'skill');
  const { values, errors } = resolveConfig({
    command: 'skill',
    flags: {
      ...body,
      source: repo.sourceRoot,
      work: repo.workDir,
      handbook: handbookDir,
      out: outDir,
      // A sensible slug from the repo name when the caller does not pass one.
      name:
        typeof body.name === 'string' && body.name.trim()
          ? body.name
          : `${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-handbook`,
    },
    env: process.env,
    file: ctx.configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  let coverage;
  if (fileExists(join(repo.workDir, 'phase2', 'assignment.json'))) {
    coverage = { assignment: new WorkDir(repo.workDir).loadAssignment(), sourceRoot: repo.sourceRoot };
  }
  const agentDir = join(handbookDir, 'agent');
  logger.info(`packaging SKILL "${values.name as string}" → ${outDir}`);
  return buildSkill({
    handbookDir,
    outDir,
    name: values.name as string,
    project: (values.project as string | undefined) ?? repo.name,
    coverage,
    agentDir: fileExists(join(agentDir, 'how_to_use.md')) ? agentDir : undefined,
    lang: values.bodyLang as 'en' | 'zh',
  });
}

/** The studio-relevant command surface, served for the UI to build its forms from. */
const SETTINGS_COMMANDS = [
  'analyze',
  'generate',
  'render',
  'skill',
  'validate',
  'plan',
  'apply',
  'rollback',
  'resync',
] as const;

/**
 * Settings studio supplies itself; a form rendering them would offer a knob
 * that does nothing (or worse, one that fights the repo entry).
 */
const MANAGED_KEYS: Record<string, readonly string[]> = {
  '*': ['source', 'work', 'logLevel'],
  render: ['out'],
  skill: ['handbook', 'out', 'agentDir'],
  validate: ['skill'],
  apply: ['plan'],
  rollback: ['backup'],
  resync: ['case'],
};

function settingsPayload(): unknown {
  registerBuiltinAdapters();
  const languages = ['auto', ...availableLanguages()];
  const describe = (setting: Setting, command: string): Record<string, unknown> => ({
    key: setting.key,
    type: setting.type,
    doc: setting.doc,
    flag: setting.flag,
    default: setting.default,
    min: setting.min,
    choices: setting.dynamicChoices === 'languages' ? languages : setting.choices,
    negated: setting.negated === true,
    secret: setting.secret === true,
    required: setting.required === true || (setting.requiredFor?.includes(command) ?? false),
    managed:
      MANAGED_KEYS['*']!.includes(setting.key) || (MANAGED_KEYS[command]?.includes(setting.key) ?? false),
  });
  return {
    commands: Object.fromEntries(
      SETTINGS_COMMANDS.map((command) => [
        command,
        settingsFor(command).map((setting) => describe(setting, command)),
      ]),
    ),
  };
}

/** The UI's locale files, as a fixed allowlist — never joined from user input. */
const I18N_LOCALES = ['en', 'zh', 'hi', 'es', 'pt', 'ru', 'ja', 'de'] as const;

/**
 * Validate a job request against the registry BEFORE the job exists.
 *
 * `generate` and `resync` have their own parsers that do this; `render`,
 * `skill` and `plan` resolve inside the job, which means a value the registry
 * would reject — `{"html":"yes-please"}`, `{"maxTurns":"many"}` — came back as
 * a 202 and only surfaced as a failed job in the drawer seconds later. Bad
 * input is the caller's bug and deserves the status code that says so.
 *
 * The job re-resolves the same flags afterwards. That is deliberate duplicated
 * work: it is deterministic and microseconds, and threading the values through
 * would give the run a second source of truth to drift from.
 */
function preflight(
  command: string,
  body: Record<string, unknown>,
  configFile: ConfigFileData | undefined,
  managed: Record<string, unknown>,
): void {
  const { errors } = resolveConfig({
    command,
    flags: { ...body, ...managed },
    env: process.env,
    file: configFile,
  });
  if (errors.length > 0) throw new Error(errors.join('; '));
  // `lang` declares `dynamicChoices`, so the resolver cannot check it — the
  // valid set only exists once adapters are registered. Unchecked, an unknown
  // language reached the analyzer and came back as an empty analysis, which
  // reads as "your repo has no code" rather than "that is not a language".
  if (typeof body.lang === 'string') {
    registerBuiltinAdapters();
    const known = ['auto', ...availableLanguages()];
    if (!known.includes(body.lang)) {
      throw new Error(`lang must be one of ${known.join(' | ')}, got "${body.lang}"`);
    }
  }
}

/** Body minus anything that must not be persisted, for `lastParams`. */
function persistableParams(body: Record<string, unknown>): Record<string, unknown> {
  const { llmApiKey: _key, OPENAI_API_KEY: _envKey, ...rest } = body;
  return rest;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // HEAD must mirror GET for the shell: a probe (curl -I, uptime check) that gets
  // a 404 on `/` while GET returns 200 is a lie about the resource. Node strips the
  // body from a HEAD response automatically, so we can share the one code path.
  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/index.html')) {
    const uiPath = fileURLToPath(new URL('../public/index.html', import.meta.url));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(uiPath));
    return;
  }

  // UI dictionaries. The path is matched against a FIXED allowlist — the file
  // name served is always one of these eight literals, never user input — and a
  // locale whose dictionary has not landed yet gets a harmless no-op script, so
  // the UI falls back to English key by key instead of breaking on a 404.
  if (method === 'GET' || method === 'HEAD') {
    const locale = I18N_LOCALES.find((loc) => path === `/i18n.${loc}.js`);
    if (locale) {
      const file = fileURLToPath(new URL(`../public/i18n.${locale}.js`, import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(existsSync(file) ? readFileSync(file) : '/* not translated yet */\n');
      return;
    }
  }

  if (path === '/api/repos' && method === 'GET') {
    json(
      res,
      200,
      ctx.store.list().map((r) => repoStatus(r, ctx.jobs)),
    );
    return;
  }

  // Served, not hand-maintained: the UI's source-language picker used to hard-code
  // six languages against eighteen registered adapters — exactly the drift this
  // registry-driven work exists to remove (see options.ts's own `languageChoices`).
  if (path === '/api/languages' && method === 'GET') {
    registerBuiltinAdapters();
    json(res, 200, { languages: ['auto', ...availableLanguages()] });
    return;
  }

  // The whole registry surface for every studio-runnable command, so the UI
  // renders its forms FROM the registry instead of hand-maintaining a subset —
  // which is how six of generate's parameters came to be silently discarded.
  if (path === '/api/settings' && method === 'GET') {
    json(res, 200, settingsPayload());
    return;
  }

  // The prose languages, with the native name each should be offered under.
  // Served rather than hand-listed for the same reason `/api/languages` is:
  // the generate dialog's picker had drifted to two options against eight
  // registered languages, which is the exact failure that endpoint exists for.
  if (path === '/api/narrate-languages' && method === 'GET') {
    json(res, 200, { languages: NARRATE_LANGUAGES.map((l) => ({ code: l.code, name: l.native })) });
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
    // Reject a bad name with a readable message. Left to store.add(), the schema's
    // .parse() throws a ZodError whose .message is a raw JSON array — which used to
    // land verbatim in the "Add repository" dialog.
    if (!REPO_NAME_RE.test(name)) {
      json(res, 400, {
        error: 'name must be URL-safe: letters, digits, . _ - and start with a letter or digit',
      });
      return;
    }
    const sourceRoot = resolve(rawSource);
    // An explicit path is obeyed as given; a blank one adopts an existing
    // handbook when one is sitting in a conventional spot.
    const explicit = body.workDir ? resolve(String(body.workDir)) : undefined;
    const adopted = explicit ? undefined : findWorkDirFor(String(body.sourceRoot ?? ''), ctx.stateDirWork);
    const workDir = explicit ?? adopted ?? join(ctx.stateDirWork, name);
    const entry = ctx.store.add({ name, sourceRoot, workDir });
    ensureDir(workDir);
    json(res, 201, { ...repoStatus(entry, ctx.jobs), adoptedWorkDir: adopted !== undefined });
    return;
  }

  if (path === '/api/history' && method === 'GET') {
    const all: Array<Record<string, unknown>> = ctx.store
      .list()
      .flatMap((repo) =>
        listEvolutions(repo).map((e) => ({ repo: repo.name, ...(e as Record<string, unknown>) })),
      );
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
      (sub === '/generate' ||
        sub === '/analyze' ||
        sub === '/render' ||
        sub === '/skill' ||
        sub === '/plan' ||
        sub === '/resync' ||
        sub === '/apply' ||
        sub === '/rollback')
    ) {
      const body = await readBody(req);
      // Secrets never travel over HTTP, whichever endpoint this is. The per-run
      // parsers repeat the check; this one catches every route at the door.
      rejectSecrets(body);
      const kind = sub.slice(1) as
        'generate' | 'analyze' | 'render' | 'skill' | 'plan' | 'resync' | 'apply' | 'rollback';
      const jobKind: JobKind = kind === 'analyze' ? 'generate' : (kind as JobKind);
      // Validate BEFORE the job exists: a garbage readWorkers must be a 400 on
      // this request, not a failed job discovered in the drawer later.
      const genParams = kind === 'generate' ? parseGenerateParams(body, repo, ctx.configFile) : undefined;
      const resyncParams = kind === 'resync' ? parseResyncParams(body, repo, ctx.configFile) : undefined;
      // The other registry-backed jobs get the same contract. `analyze`'s own
      // resolve happens in the run, but its only setting is `lang`, so it is
      // checked here too rather than being the one route that differs.
      if (kind === 'render') {
        preflight('render', body, ctx.configFile, { work: repo.workDir });
      } else if (kind === 'analyze') {
        preflight('analyze', body, ctx.configFile, { source: repo.sourceRoot, work: repo.workDir });
      } else if (kind === 'plan') {
        preflight('plan', body, ctx.configFile, {
          source: repo.sourceRoot,
          request: typeof body.request === 'string' ? body.request : '',
        });
      } else if (kind === 'skill') {
        preflight('skill', body, ctx.configFile, {
          source: repo.sourceRoot,
          work: repo.workDir,
          handbook: join(repo.workDir, 'handbook'),
          out: join(repo.workDir, 'skill'),
          name:
            typeof body.name === 'string' && body.name.trim()
              ? body.name
              : `${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-handbook`,
        });
      }
      // A repo already running a job is a state CONFLICT (409), like DELETE and
      // cancel report — not a malformed request (400). Check before start(), whose
      // own throw would otherwise surface as a misleading 400 via the catch-all.
      if (ctx.jobs.isBusy(repo.name)) {
        json(res, 409, { error: `repo "${repo.name}" already has a running job — wait for it to finish` });
        return;
      }
      // What this job was run with, remembered per kind so the UI can pre-fill
      // the next dialog with the values that produced the current handbook.
      ctx.store.setLastParams(repo.name, kind, persistableParams(body));
      const debug = body.logLevel === 'debug' || genParams?.debug === true || resyncParams?.debug === true;
      const job = ctx.jobs.start(
        repo.name,
        jobKind,
        (logger, signal) => {
          switch (kind) {
            case 'analyze':
              return runAnalyzeOnly(repo, body, ctx.configFile, logger);
            case 'generate':
              return runGenerate(ctx, repo, genParams as GenerateParams, logger, signal);
            case 'render':
              return runRender(ctx, repo, body, logger);
            case 'skill':
              return runSkillBuild(ctx, repo, body, logger);
            case 'plan':
              return runPlan(ctx, repo, body, logger, signal);
            case 'resync':
              return runResync(ctx, repo, body, resyncParams as ResyncParams, logger, signal);
            case 'apply':
              return runApply(repo, body, logger);
            case 'rollback':
              return runRollback(repo, body, logger);
          }
        },
        { debug },
      );
      json(res, 202, jobSummary(job));
      return;
    }
    // Validation is read-only and fast — a plain response, not a job. Exit-code
    // semantics carry over as fields: `ok:false` is the tool working and the
    // answer being no, exactly like the CLI's exit 2.
    if (method === 'POST' && sub === '/validate') {
      const skillDir = join(repo.workDir, 'skill');
      if (!fileExists(join(skillDir, 'SKILL.md'))) {
        json(res, 409, { error: 'no SKILL package yet — build one with the skill action first' });
        return;
      }
      const result = validateSkill({ skillDir, sourceRoot: repo.sourceRoot });
      json(res, 200, result);
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
          // Which languages were analyzed at which fidelity tier. A multi-language
          // graph mixes tiers, and nothing in the nodes/edges reveals it — so the
          // UI is told, instead of letting a generic-tier language's call facts
          // read as hard as a full-tier one's. Null covers both "no graph" and a
          // graph written before capabilities were recorded.
          languages: readOptional(() => work.loadGraph().metadata.languages ?? null),
          registers,
        });
      } catch (error) {
        json(res, 409, {
          error: `handbook not generated yet: ${error instanceof Error ? error.message : error}`,
        });
      }
      return;
    }
    if (method === 'GET' && sub === '/graph') {
      try {
        // A non-numeric ?limit must fall back to the default cap, not collapse
        // the graph to empty via a NaN slice.
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam !== null && Number.isFinite(Number(limitParam)) ? Number(limitParam) : 60;
        json(res, 200, impactGraph(repo, url.searchParams.get('stage'), limit));
      } catch (error) {
        json(res, 409, { error: `no call graph yet: ${error instanceof Error ? error.message : error}` });
      }
      return;
    }
    if (method === 'GET' && sub === '/source') {
      const rel = url.searchParams.get('path') ?? '';
      const full = rel ? safeResolve(repo.sourceRoot, rel) : null;
      if (!full) {
        json(res, 400, { error: 'path escapes the source root' });
        return;
      }
      try {
        if (statSync(full).size > 2_000_000) {
          json(res, 413, { error: 'file too large to display' });
          return;
        }
        json(res, 200, {
          path: rel,
          content: readFileSync(full, 'utf8'),
          functions: fileFunctions(repo, rel),
        });
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

  if (path === '/api/jobs' && method === 'GET') {
    // Summaries only (no raw logs): this is what a freshly reloaded page uses
    // to find a job that is still running and reattach its log drawer.
    const repoFilter = url.searchParams.get('repo');
    json(res, 200, { jobs: ctx.jobs.list(repoFilter ?? undefined).map(jobSummary) });
    return;
  }

  const cancelMatch = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const job = ctx.jobs.get(cancelMatch[1] ?? '');
    if (!job) {
      json(res, 404, { error: 'unknown job' });
      return;
    }
    if (job.status !== 'running') {
      json(res, 409, { error: `job already finished: ${job.status}` });
      return;
    }
    // 202, not 200: cancellation is cooperative — the run stops at its next
    // checkpoint, and the job's own status transition is what confirms it.
    ctx.jobs.cancel(job.id);
    json(res, 202, { ok: true });
    return;
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
    // The overrides are the per-job llm settings a request carried (already
    // registry-validated, never the API key); they are re-resolved through the
    // same cascade as a CLI launch so env and the config file still apply
    // underneath them.
    clientFactory:
      options.clientFactory ??
      ((logger: Logger, llmOverrides?: Record<string, unknown>) => {
        const { values } = resolveConfig({
          command: 'studio',
          flags: llmOverrides ?? {},
          env: process.env,
          file: options.configFile,
        });
        return new OpenAiChatClient({
          config: llmConfigFromValues(values),
          concurrency: values.llmConcurrency as number | undefined,
          logger,
        });
      }),
    configFile: options.configFile,
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

/** Start the server and return it once listening.
 *
 * Defaults to the registry's loopback default — a container needs 0.0.0.0 or
 * a published port is unreachable from the host. The CSRF defence in createStudioServer checks
 * the Host *header*, not the socket, so binding wide does not widen who may
 * talk to it: browsing http://localhost:<port> still passes, and a LAN IP or
 * container name still gets 403.
 */
export function startStudio(options: StudioOptions): Promise<Server> {
  const server = createStudioServer(options);
  const port = options.port ?? (settingByKey('port')?.default as number);
  const host = options.host ?? (settingByKey('host')?.default as string);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise(server));
  });
}
