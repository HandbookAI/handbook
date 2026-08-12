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
 * Every subcommand's options are derived from the `@handbooks/core` registry
 * (see options.ts) and resolved at action time (see resolve-config.ts) —
 * neither commander defaults nor hand-written parsing live here anymore.
 */
import { Command } from 'commander';
import { basename, join, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyEnvFile } from './env-file.js';
import { addSettings } from './options.js';
import {
  currentConfigFile,
  currentConfigFileFailure,
  currentEnvironment,
  resolveOrThrow,
  setConfigFile,
  setEnvironment,
} from './resolve-config.js';
import {
  applyEnvFiles,
  createLogger,
  discoverConfigFile,
  readConfigFile,
  resolveConfig,
  settingByKey,
  SETTINGS,
  unknownKeyWarnings,
  type LogLevel,
} from '@handbooks/core';
import { renderConfigJson, renderConfigTable } from './config-command.js';
import {
  CachedChatClient,
  OpenAiChatClient,
  llmConfigFromValues,
  providerFromValues,
  type ChatClient,
} from '@handbooks/llm';
import { generateHandbook, loadHandbookModel, runPhase1, WorkDir } from '@handbooks/pipeline';
import {
  renderAgentSite,
  renderHtmlSite,
  renderLlmsTxt,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbooks/renderer';
import { buildSkill, validateSkill } from '@handbooks/skill';
import { runPlanner } from '@handbooks/planner';
import { resyncHandbook } from '@handbooks/resync';
import { graphFidelity, graphFileLanguages, refreshRenderedHandbook } from './render-refresh.js';
import { readCliVersion } from './version.js';

// Exported so a test can drive it with a controlled argv and mocked seams
// (`@handbooks/studio`'s `startStudio`, `@handbooks/pipeline`'s `generateHandbook`)
// instead of the real `process.argv` — see main.test.ts.
export const program = new Command();

program
  .name('handbook')
  .description('Turn any codebase into a navigable handbook — and use it to plan precise code changes.')
  .version(readCliVersion())
  .option('-v, --verbose', 'debug logging')
  .option('-q, --quiet', 'errors only')
  .option(
    '--env <name>',
    'select an environment (bootstrap only; same as HANDBOOK_ENV): loads ' +
      '.env.<name>.local and .env.<name> ahead of .env.local and .env, and prefers ' +
      'handbook.config.<name>.yaml over the plain file',
  )
  .option(
    '--env-file <path>',
    'load KEY=VALUE pairs from exactly this file, bypassing the .env cascade above ' +
      '(same as HANDBOOK_ENV_FILE, which is the safer form — see below)',
  )
  .option('--config <path>', 'project config file (default: nearest handbook.config.yaml)');

// The env cascade runs before every subcommand action, so OPENAI_* and
// HANDBOOK_* can live in project-local files instead of the shell. --env is
// read FIRST — the cascade and the config-file discovery below both depend
// on it — and the config file is discovered/loaded AFTER the env files on
// purpose: it sits below the environment in precedence, so HANDBOOK_* values
// from a .env file must already be in process.env before anything reads
// them, and loading the config file later cannot and must not override what
// the env files supplied.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const envFlag = program.opts<{ env?: string }>().env;
  const envName = envFlag || process.env.HANDBOOK_ENV || undefined;
  const envSource: 'flag' | 'env' | undefined = envFlag ? 'flag' : envName ? 'env' : undefined;

  let envNote: string | undefined;
  let envFiles: string[];
  // `HANDBOOK_ENV_FILE` is not a convenience: on Node >= 20.6 `--env-file` is
  // ALSO a node flag, and node pre-scans the whole command line for it — even
  // in the position after the script path, where it does not apply the file.
  // A path that exists therefore passes through to us untouched, but a path
  // that does NOT exist kills the process first:
  //
  //     $ handbook --env-file /gone.env config
  //     node: /gone.env: not found          ← node, exit 9, before main.ts runs
  //
  // So the one case the flag is documented to handle loudly — a named file that
  // is missing — is precisely the case we never get to report. The environment
  // variable cannot be intercepted, which makes it the reliable form; the flag
  // stays because it is the conventional spelling and works whenever the file
  // is actually there. Read from the shell only: this is bootstrap, running
  // before any .env is loaded, so a value in one of those files could not have
  // been read in time to select itself.
  const explicit = program.opts<{ envFile?: string }>().envFile ?? process.env.HANDBOOK_ENV_FILE;
  if (explicit) {
    const applied = applyEnvFile(resolve(explicit)); // missing explicit file → loud error
    envFiles = [resolve(explicit)];
    envNote = `[env] loaded ${applied.length} vars from ${explicit}`;
  } else {
    envFiles = applyEnvFiles(process.cwd(), envName);
    if (envFiles.length > 0) {
      envNote = `[env] loaded from ${envFiles.map((f) => basename(f)).join(', ')}`;
    }
  }
  setEnvironment({ name: envName, source: envSource, envFiles });

  // An explicitly named file that is missing is still a mistake, not a
  // fallback — but the mistake is REPORTED rather than thrown here. A file
  // that cannot be parsed, read, or is not a file at all used to abort
  // bootstrap, which took `handbook config` down with it: the one command
  // whose job is to show broken configuration could not run once the
  // configuration was broken. Recording the failure keeps every other command
  // refusing (see `resolveOrThrow`) while leaving `config` able to explain it.
  const explicitConfig = program.opts<{ config?: string }>().config;
  const configPath = explicitConfig ? resolve(explicitConfig) : discoverConfigFile(process.cwd(), envName);
  let configNote: string | undefined;
  let configWarnings: readonly string[] = [];
  if (configPath === undefined) {
    setConfigFile(undefined);
  } else {
    const read = readConfigFile(configPath);
    setConfigFile(
      read.file,
      read.error === undefined ? undefined : { path: configPath, message: read.error },
    );
    configNote = read.error === undefined ? `[config] loaded ${configPath}` : undefined;
    configWarnings = unknownKeyWarnings(read.file);
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
  // A key nothing recognises is a WARNING, not a failure: a config file
  // written for a newer Handbooks release has to keep working, and hard-failing on it
  // would make forward compatibility impossible. But silence is what let a
  // typo'd `readWorker` look applied for a whole run, so it is reported on
  // every command, at a level that shows without -v. `config --check` treats
  // the same warning as a problem — that gate exists to be strict.
  for (const warning of configWarnings) log.warn(`[config] ${warning}`);
});

/** The level `-v`/`-q` forced, or undefined when neither was given. Quiet wins. */
function shorthandLevel(): LogLevel | undefined {
  const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
  return opts.quiet ? 'error' : opts.verbose ? 'debug' : undefined;
}

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

/**
 * Ctrl-C, wired to the cancellation the pipeline already understands.
 *
 * Without this, SIGINT kills the process where it stands: an in-flight model
 * call is abandoned mid-charge, and a work dir can be left with a half-written
 * artifact that looks finished. `runGenerate`, `runPlanner` and `resyncHandbook`
 * all accept an `AbortSignal` and unwind cleanly on it — nothing was ever
 * passing one.
 *
 * Two presses, because a cooperative stop is not instant and a person who has
 * decided to stop should not have to wait for a retry backoff to finish:
 *
 *   1. abort the run, say so, and let it unwind and record what it did;
 *   2. give up on unwinding and leave.
 *
 * Exit code 130 is the shell convention for "died on SIGINT" (128 + 2). It is
 * non-zero, which is what invariant 5 demands of a run that gave up.
 *
 * The listeners are installed ONLY when this file is the process's main module,
 * and only once. Signal handlers are process-global: registering them from an
 * imported action means the CLI's handler fires for signals aimed at whatever
 * host imported it — and the second-press branch calls `process.exit`, so it
 * would hijack that host's shutdown outright. This was not hypothetical: the
 * first version printed "SIGTERM — cancelling" three times during `vitest run`,
 * from workers being torn down. A library caller passes its own signal.
 */
let cancellation: AbortSignal | undefined;

function installCancellation(): AbortSignal {
  if (cancellation) return cancellation;
  const controller = new AbortController();
  cancellation = controller.signal;
  if (!runningAsMain()) return cancellation;

  let pressed = 0;
  const onSignal = (name: string) => (): void => {
    pressed += 1;
    if (pressed === 1) {
      process.stderr.write(`\nhandbook: ${name} — cancelling; press again to stop waiting\n`);
      controller.abort(new DOMException(`cancelled by ${name}`, 'AbortError'));
      return;
    }
    process.stderr.write('handbook: forced\n');
    process.exit(130);
  };
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));
  return cancellation;
}

/** True for the rejection an aborted run produces, however deep it came from. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** LLM settings come from the resolved config, so --model/--base-url/etc reach the client. */
function llmClient(cfg: Record<string, unknown>): ChatClient {
  return new OpenAiChatClient({
    provider: providerFromValues(cfg),
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
  const cfg = resolveOrThrow('analyze', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
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
  const cfg = resolveOrThrow('generate', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
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
  const signal = installCancellation();
  const stats = await generateHandbook({
    signal,
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
  const cfg = resolveOrThrow('render', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const workDir = cfg.work as string;
  const outDir = (cfg.out as string | undefined) ?? join(workDir, 'handbook');
  const model = loadHandbookModel(workDir, cfg.title as string);
  const languages = graphFidelity(workDir);
  const fileLanguages = graphFileLanguages(workDir);
  const render = {
    languages,
    fileLanguages,
    ...(cfg.sourceBaseUrl ? { sourceBaseUrl: cfg.sourceBaseUrl as string } : {}),
  };
  const md = renderMarkdownHandbook(model, outDir, render);
  const result: Record<string, unknown> = { outDir, nStagePages: md.nStagePages };
  if (cfg.agentSite) {
    result.agent = renderAgentSite(model, `${outDir}/agent`, { languages, fileLanguages });
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
  const cfg = resolveOrThrow('skill', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
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
  const cfg = resolveOrThrow('validate', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
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
  const cfg = resolveOrThrow('plan', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const result = await runPlanner({
    signal: installCancellation(),
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
  const cfg = resolveOrThrow('resync', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const workDir = cfg.work as string;
  const useLlm = cfg.useLlm as boolean;
  const report = await resyncHandbook({
    signal: installCancellation(),
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
  const cfg = resolveOrThrow('apply', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const { applyPlan } = await import('@handbooks/patcher');
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
  const cfg = resolveOrThrow('rollback', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const { rollback } = await import('@handbooks/patcher');
  const result = rollback(cfg.backup as string, {
    force: cfg.force as boolean,
    expectedSourceRoot: cfg.source as string | undefined,
    logger: logger(cfg),
  });
  printJson(result);
  // Exit 2 = the tool worked and the answer is no, exactly as `apply` reports
  // it. A rollback that refused every file (changed since the patch, backup
  // copy missing) used to exit 0, so `handbook rollback && <deploy>` treated a
  // zero-file restore as a successful one.
  if (result.skipped.length > 0) {
    process.stderr.write(`rollback: ${result.skipped.length} file(s) were not restored\n`);
    process.exitCode = 2;
  }
});

addSettings(
  program
    .command('studio')
    .description(
      'Launch the local web UI (repos · generate · browse · evolve); binds to 127.0.0.1 by default',
    ),
  'studio',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('studio', opts, { makeLogger: logger, shorthandLevel: shorthandLevel() });
  const { startStudio, boundPort } = await import('@handbooks/studio');
  const port = cfg.port as number;
  const host = cfg.host as string;
  const stateDir =
    (cfg.stateDir as string | undefined) ?? resolve(`${process.env.HOME ?? '.'}/.handbook-studio`);
  const server = await startStudio({
    stateDir,
    port,
    host,
    logger: logger(cfg),
    // Resolved once, from the same flags/env/config-file layers as every other
    // command — otherwise --model, --base-url and a config-file `llm:` block
    // all silently do nothing for studio (P0-1), while --help and `handbook
    // config` both claim they work. Receives the job logger, not the top-level
    // one: a silent client hides retries and gateway blocks. Per-job overrides
    // (a request's own `llmModel`, `--max-tokens`-equivalent, …) land on top of
    // the launch configuration; the API key never does — studio rejects it.
    clientFactory: (jobLogger, llmOverrides) =>
      new OpenAiChatClient({
        provider: providerFromValues({ ...cfg, ...llmOverrides }),
        config: llmConfigFromValues({ ...cfg, ...llmOverrides }),
        concurrency: (llmOverrides?.llmConcurrency ?? cfg.llmConcurrency) as number | undefined,
        logger: jobLogger,
      }),
    // Same file layer studio's own launch settings just used, so a generate
    // job's parameters (detail, narrateLang, readWorkers, …) also see it.
    configFile: currentConfigFile(),
  });
  // The BOUND port, not the requested one: `--port 0` asks the OS to pick, so
  // echoing the request would print `http://127.0.0.1:0`.
  process.stderr.write(`handbook studio → http://${host}:${boundPort(server)}\n`);
  await new Promise(() => {}); // run until Ctrl-C
});

addSettings(
  program.command('config').description('Print the resolved configuration and where each value came from'),
  'config',
).action((opts: Record<string, unknown>) => {
  // Tolerant of a config file that could not be loaded at all (see
  // resolve-config.ts): this command has to survive exactly the situation it
  // exists to explain.
  const cfg = resolveOrThrow('config', opts, { tolerateBrokenConfigFile: true });
  const target = (cfg.forCommand as string | undefined) ?? 'generate';
  // An unknown command name makes `settingsFor` return an empty list, so every
  // check passed and `--check` printed OK — the one gate that exists to catch
  // misconfiguration in CI validated nothing, in green.
  const known = new Set(SETTINGS.flatMap((setting) => setting.commands));
  if (!known.has(target)) {
    process.stderr.write(
      `config: unknown command "${target}" — expected one of ${[...known].sort().join(', ')}\n`,
    );
    process.exitCode = 2;
    return;
  }
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
  // Problems with the FILE rather than with any one value: it could not be
  // loaded at all, or it sets keys no setting claims. Neither can appear as a
  // row below — there is no row for a key nothing recognises — so they are
  // carried separately, and both count as failures under --check.
  const failure = currentConfigFileFailure();
  const warnings = unknownKeyWarnings(currentConfigFile());
  if (cfg.check) {
    const problems = [...(failure ? [failure.message] : []), ...result.errors, ...warnings];
    for (const problem of problems) process.stderr.write(`config: ${problem}\n`);
    process.stderr.write(problems.length ? 'config: FAILED\n' : 'config: OK\n');
    process.exitCode = problems.length ? 2 : 0;
    return;
  }
  // The active environment, the files it cascaded from, and the config file
  // resolved from it: without these, a cascade of up to eight possible
  // sources is unauditable — see config-command.ts.
  const environment = currentEnvironment();
  const envDisplay = {
    ...environment,
    // The attempted path when the load failed, so a broken file is never
    // displayed as "(none)" — which reads as a project with no config file.
    configFile: currentConfigFile()?.path ?? failure?.path,
    configFileError: failure?.message,
    configFileWarnings: warnings,
  };
  process.stdout.write(
    cfg.json ? renderConfigJson(result, target, envDisplay) : renderConfigTable(result, target, envDisplay),
  );
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
    // A cancelled run is not a crash. Printing a stack for something the user
    // asked for reads as a bug, and exit 1 would put it in the same bucket as a
    // genuine failure.
    if (isAbort(error)) {
      process.stderr.write('handbook: cancelled\n');
      process.exit(130);
    }
    process.stderr.write(`handbook: error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
