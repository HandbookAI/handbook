#!/usr/bin/env node
/**
 * The `handbook` CLI — one entry point for the whole toolchain:
 *
 *   analyze    static call graph only (no LLM)
 *   generate   full handbook pipeline (phases 1/2a/2b/2c/3)
 *   render     work dir → markdown / HTML site / agent locator index (no LLM)
 *   skill      rendered handbook → agent SKILL package (no LLM)
 *   validate   check a SKILL package structure + freshness (no LLM)
 *   plan       handbook-guided change localization (read-only agent)
 *   apply      apply a plan's EDIT blocks byte-exactly (backups + rollback)
 *   rollback   restore a source tree from a patch backup
 *   resync     roll a handbook forward after a code change
 *   studio     local web UI over all of the above
 *
 * Every subcommand's options are derived from the `@handbook/core` registry
 * (see options.ts) and resolved at action time (see resolve-config.ts) —
 * neither commander defaults nor hand-written parsing live here anymore.
 */
import { Command } from 'commander';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyEnvFile } from './env-file.js';
import { addSettings } from './options.js';
import { currentConfigFile, resolveOrThrow, setConfigFile } from './resolve-config.js';
import {
  createLogger,
  discoverConfigFile,
  loadConfigFile,
  resolveConfig,
  settingByKey,
  type LogLevel,
} from '@handbook/core';
import { renderConfigJson, renderConfigTable } from './config-command.js';
import { CachedChatClient, OpenAiChatClient, llmConfigFromValues, type ChatClient } from '@handbook/llm';
import { generateHandbook, loadHandbookModel, runPhase1, WorkDir } from '@handbook/pipeline';
import {
  renderAgentSite,
  renderHtmlSite,
  renderLlmsTxt,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbook/renderer';
import { buildSkill, validateSkill } from '@handbook/skill';
import { runPlanner } from '@handbook/planner';
import { resyncHandbook } from '@handbook/resync';
import { graphFidelity, refreshRenderedHandbook } from './render-refresh.js';

// Exported so a test can drive it with a controlled argv and mocked seams
// (`@handbook/studio`'s `startStudio`, `@handbook/pipeline`'s `generateHandbook`)
// instead of the real `process.argv` — see main.test.ts.
export const program = new Command();

program
  .name('handbook')
  .description('Turn any codebase into a navigable handbook — and use it to plan precise code changes.')
  .version('0.1.0')
  .option('-v, --verbose', 'debug logging')
  .option('-q, --quiet', 'errors only')
  .option(
    '--env-file <path>',
    'load KEY=VALUE pairs from a file (default: ./.env if present; shell env wins)',
  )
  .option('--config <path>', 'project config file (default: nearest handbook.config.yaml)');

// .env loading runs before every subcommand action, so OPENAI_* and
// HANDBOOK_* can live in a project-local file instead of the shell. The
// config file is discovered/loaded AFTER the env file on purpose: it sits
// below the environment in precedence, so HANDBOOK_* values from .env must
// already be in process.env before anything reads them, and loading the
// config file later cannot and must not override what .env supplied.
program.hook('preAction', (_thisCommand, actionCommand) => {
  let envNote: string | undefined;
  const explicit = program.opts<{ envFile?: string }>().envFile;
  if (explicit) {
    const applied = applyEnvFile(resolve(explicit)); // missing explicit file → loud error
    envNote = `[env] loaded ${applied.length} vars from ${explicit}`;
  } else if (existsSync('.env')) {
    const applied = applyEnvFile(resolve('.env'));
    if (applied.length > 0) envNote = `[env] loaded ${applied.length} vars from ./.env`;
  }

  let configNote: string | undefined;
  const explicitConfig = program.opts<{ config?: string }>().config;
  if (explicitConfig) {
    // An explicitly named file that is missing is a mistake, not a fallback.
    setConfigFile(loadConfigFile(resolve(explicitConfig)));
  } else {
    const found = discoverConfigFile(process.cwd());
    if (found) {
      setConfigFile(loadConfigFile(found));
      configNote = `[config] loaded ${found}`;
    }
  }

  // Resolve THIS command's log level now — env and the config file are both
  // in place above, so HANDBOOK_LOG_LEVEL=debug shows the two lines below the
  // same as -v does, instead of only -v/-q ever reaching them (the registry
  // calls -v mere "shorthand", which this now actually is). Errors are
  // ignored here on purpose: a broken --source is the action's problem to
  // report loudly, not bootstrap logging's.
  const { values } = resolveConfig({
    command: actionCommand.name(),
    flags: actionCommand.opts(),
    env: process.env,
    file: currentConfigFile(),
  });
  const log = logger(values);
  if (envNote) log.debug(envNote);
  if (configNote) log.debug(configNote);
});

/** Level comes from the resolved config; -v/-q are top-level shorthand that override it (quiet wins). */
function logger(cfg?: Record<string, unknown>): ReturnType<typeof createLogger> {
  const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
  const level: LogLevel = opts.quiet
    ? 'error'
    : opts.verbose
      ? 'debug'
      : ((cfg?.logLevel as LogLevel | undefined) ?? (settingByKey('logLevel')?.default as LogLevel));
  return createLogger('', level);
}

/** LLM settings come from the resolved config, so --model/--base-url/etc reach the client. */
function llmClient(cfg: Record<string, unknown>): ChatClient {
  return new OpenAiChatClient({
    config: llmConfigFromValues(cfg),
    concurrency: cfg.llmConcurrency as number | undefined,
    logger: logger(cfg),
  });
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

addSettings(
  program.command('analyze').description('Phase 1 only: build the static call graph (no LLM needed)'),
  'analyze',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('analyze', opts);
  const stats = await runPhase1({
    sourceRoot: cfg.source as string,
    workDir: cfg.work as string,
    lang: cfg.lang as string,
    logger: logger(cfg),
  });
  printJson(stats);
});

addSettings(
  program
    .command('generate')
    .description('Run the handbook generation pipeline (env: OPENAI_API_KEY/MODEL/BASE_URL)'),
  'generate',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('generate', opts);
  const phase = String(cfg.phase);
  // Build the client opportunistically: some selections need no LLM at all
  // (phase 1; member-strategy 2c). generateHandbook fails with a clear
  // message if a key is genuinely required but missing.
  let client: ChatClient | undefined;
  if (phase !== '1') {
    try {
      client = llmClient(cfg);
    } catch {
      client = undefined;
    }
  }
  if (client && cfg.llmCache && !cfg.refresh) {
    client = new CachedChatClient(client, join(cfg.work as string, 'phase3', 'cache'));
  }
  const stats = await generateHandbook({
    sourceRoot: cfg.source as string,
    workDir: cfg.work as string,
    client,
    phase,
    strategy: cfg.strategy as 'file' | 'member' | undefined,
    skeletonPath: cfg.skeleton as string | undefined,
    lang: cfg.lang as string,
    narrateLang: cfg.narrateLang as 'en' | 'zh',
    detail: cfg.detail as 'brief' | 'deep',
    synthMode: cfg.synthMode as 'oneshot' | 'doctor',
    maxDoctorRounds: cfg.maxDoctorRounds as number,
    readWorkers: cfg.readWorkers as number,
    readBatchSize: cfg.readBatchSize as number | undefined,
    maxCharsPerFile: cfg.maxCharsPerFile as number,
    assignBatchSize: cfg.assignBatchSize as number,
    assignWorkers: cfg.assignWorkers as number,
    organizeWorkers: cfg.organizeWorkers as number,
    narrateWorkers: cfg.narrateWorkers as number,
    resume: cfg.resume as boolean,
    refresh: cfg.refresh as boolean,
    logger: logger(cfg),
  });
  // Surface what the run cost right where it finished (also in run-manifest.json).
  const usage = (client as { usage?: () => unknown } | undefined)?.usage?.();
  printJson(usage ? { ...stats, usage } : stats);
});

addSettings(
  program
    .command('render')
    .description('Render a completed work dir to markdown (+ optional HTML site / agent index); no LLM'),
  'render',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('render', opts);
  const workDir = cfg.work as string;
  const outDir = (cfg.out as string | undefined) ?? join(workDir, 'handbook');
  const model = loadHandbookModel(workDir, cfg.title as string);
  const languages = graphFidelity(workDir);
  const render = {
    languages,
    ...(cfg.sourceBaseUrl ? { sourceBaseUrl: cfg.sourceBaseUrl as string } : {}),
  };
  const md = renderMarkdownHandbook(model, outDir, render);
  const result: Record<string, unknown> = { outDir, nStagePages: md.nStagePages };
  if (cfg.agentSite) {
    result.agent = renderAgentSite(model, `${outDir}/agent`, { languages });
  }
  if (cfg.html) {
    result.html = renderHtmlSite(model, `${outDir}/html`, render);
  }
  if (cfg.htmlSingle) {
    result.htmlSingle = renderSinglePageHtml(model, `${outDir}/handbook.html`, { languages });
  }
  if (cfg.llmsTxt) {
    result.llms = renderLlmsTxt(model, outDir, { languages });
  }
  printJson(result);
});

addSettings(
  program.command('skill').description('Package a rendered handbook as an agent SKILL; no LLM'),
  'skill',
).action((opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('skill', opts);
  let coverage;
  if (cfg.work) {
    const work = new WorkDir(cfg.work as string);
    // `work` is env-reachable, so a project .env with HANDBOOK_WORK must not turn
    // an unrelated skill build into a failure. Coverage is an enrichment; a work
    // dir without a phase-2 assignment simply has nothing to contribute.
    if (existsSync(join(cfg.work as string, 'phase2', 'assignment.json'))) {
      coverage = { assignment: work.loadAssignment(), sourceRoot: cfg.source as string | undefined };
    } else {
      logger(cfg).debug(`[skill] no phase-2 assignment under ${String(cfg.work)} — skipping coverage.json`);
    }
  }
  const result = buildSkill({
    handbookDir: cfg.handbook as string,
    outDir: cfg.out as string,
    name: cfg.name as string,
    project: cfg.project as string | undefined,
    coverage,
    agentDir: cfg.agentDir as string | undefined,
    lang: cfg.bodyLang as 'en' | 'zh',
  });
  printJson(result);
});

addSettings(
  program
    .command('validate')
    .description('Validate a SKILL package (structure, index links, coverage freshness); no LLM'),
  'validate',
).action((opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('validate', opts);
  const result = validateSkill({
    skillDir: cfg.skill as string,
    sourceRoot: cfg.source as string | undefined,
  });
  for (const warning of result.warnings) process.stderr.write(`validate: warning: ${warning}\n`);
  for (const error of result.errors) process.stderr.write(`validate: error: ${error}\n`);
  process.stderr.write(result.ok ? 'validate: OK\n' : 'validate: FAILED\n');
  process.exitCode = result.ok ? 0 : 2;
});

addSettings(
  program
    .command('plan')
    .description('Localize a change request with the handbook and emit a precise edit plan'),
  'plan',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('plan', opts);
  const result = await runPlanner({
    client: llmClient(cfg),
    sourceRoot: cfg.source as string,
    handbookDir: cfg.handbook as string | undefined,
    request: cfg.request as string,
    maxTurns: cfg.maxTurns as number,
    logger: logger(cfg),
  });
  // A run that gave up must exit non-zero: writing its abort message to
  // plan.md and returning 0 would let a script feed it straight into `apply`.
  if (result.aborted) {
    throw new Error(
      `planner produced no usable plan (${result.aborted}) after ${result.turns} turn(s): ${result.plan}`,
    );
  }
  if (cfg.out) {
    writeFileSync(cfg.out as string, `${result.plan}\n`);
    printJson({ out: cfg.out, turns: result.turns, declarations: result.declarations });
  } else {
    process.stdout.write(`${result.plan}\n`);
  }
});

addSettings(
  program
    .command('resync')
    .description('Roll a handbook forward after a code change (case dir: edited/ + plan.md + change.diff)'),
  'resync',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('resync', opts);
  const workDir = cfg.work as string;
  const useLlm = cfg.useLlm as boolean;
  const report = await resyncHandbook({
    caseDir: cfg.case as string,
    workDir,
    client: useLlm ? llmClient(cfg) : undefined,
    noLlm: !useLlm,
    detail: cfg.cardDetail as 'brief' | 'deep' | undefined,
    correctionsPath: cfg.corrections as string | undefined,
    lang: cfg.proseLang as 'en' | 'zh' | undefined,
    logger: logger(cfg),
  });
  const rendered =
    !(cfg.refreshRendered as boolean) || report.skipped
      ? []
      : refreshRenderedHandbook(workDir, cfg.title as string, logger(cfg));
  printJson({ ...report, rendered });
});

addSettings(
  program
    .command('apply')
    .description("Apply a plan's EDIT blocks to a source tree (byte-exact, all-or-nothing, with backups)"),
  'apply',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('apply', opts);
  const { applyPlan } = await import('@handbook/patcher');
  const result = applyPlan({
    sourceRoot: cfg.source as string,
    plan: readFileSync(cfg.plan as string, 'utf8'),
    dryRun: cfg.dryRun as boolean,
    backupRoot: cfg.backupRoot as string | undefined,
    logger: logger(cfg),
  });
  printJson(result);
  process.exitCode = result.ok ? 0 : 2;
});

addSettings(
  program
    .command('rollback')
    .description('Restore a source tree from a patch backup produced by `handbook apply`'),
  'rollback',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('rollback', opts);
  const { rollback } = await import('@handbook/patcher');
  printJson(
    rollback(cfg.backup as string, {
      force: cfg.force as boolean,
      expectedSourceRoot: cfg.source as string | undefined,
      logger: logger(cfg),
    }),
  );
});

addSettings(
  program
    .command('studio')
    .description(
      'Launch the local web UI (repos · generate · browse · evolve); binds to 127.0.0.1 by default',
    ),
  'studio',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('studio', opts);
  const { startStudio } = await import('@handbook/studio');
  const port = cfg.port as number;
  const host = cfg.host as string;
  const stateDir =
    (cfg.stateDir as string | undefined) ?? resolve(`${process.env.HOME ?? '.'}/.handbook-studio`);
  await startStudio({
    stateDir,
    port,
    host,
    logger: logger(cfg),
    // Resolved once, from the same flags/env/config-file layers as every other
    // command — otherwise --model, --base-url and a config-file `llm:` block
    // all silently do nothing for studio (P0-1), while --help and `handbook
    // config` both claim they work. Receives the job logger, not the top-level
    // one: a silent client hides retries and gateway blocks.
    clientFactory: (jobLogger) =>
      new OpenAiChatClient({
        config: llmConfigFromValues(cfg),
        concurrency: cfg.llmConcurrency as number | undefined,
        logger: jobLogger,
      }),
    // Same file layer studio's own launch settings just used, so a generate
    // job's parameters (detail, narrateLang, readWorkers, …) also see it.
    configFile: currentConfigFile(),
  });
  process.stderr.write(`handbook studio → http://${host}:${port}\n`);
  await new Promise(() => {}); // run until Ctrl-C
});

addSettings(
  program.command('config').description('Print the resolved configuration and where each value came from'),
  'config',
).action((opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('config', opts);
  const target = (cfg.forCommand as string | undefined) ?? 'generate';
  // Plain resolveConfig, not resolveOrThrow: this command's job is to show
  // configuration, including when it is broken, so a missing --source on
  // `generate` must render as a visible row (`— unset (required)`) rather
  // than throw and take down the one tool for debugging that exact problem.
  const result = resolveConfig({
    command: target,
    flags: opts,
    env: process.env,
    file: currentConfigFile(),
  });
  if (cfg.check) {
    for (const error of result.errors) process.stderr.write(`config: ${error}\n`);
    process.stderr.write(result.errors.length ? 'config: FAILED\n' : 'config: OK\n');
    process.exitCode = result.errors.length ? 2 : 0;
    return;
  }
  process.stdout.write(cfg.json ? renderConfigJson(result, target) : renderConfigTable(result, target));
});

// Only when run as the actual entry point — not when a test imports this
// module to drive `program` directly with its own argv (see main.test.ts).
// `process.argv[1]` is the script path either way (`handbook ...` or
// `node dist/main.js ...`), so comparing it to this module's own path is a
// safe run-as-main check that needs no environment flag of its own. Both
// sides go through `realpathSync` before comparing: Node's loader resolves
// symlinks when computing `import.meta.url` for the main entry (this is
// exactly what `--preserve-symlinks-main` opts out of), but leaves
// `process.argv[1]` exactly as typed — so on a symlinked path (a real bin
// install, or macOS's `/var` → `/private/var`) the two strings differ even
// though they name the same file. Missing either path (`argv[1]` unset, or
// a path that no longer exists) means "not the main module", not a crash.
function runningAsMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runningAsMain()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    process.stderr.write(`handbook: error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
