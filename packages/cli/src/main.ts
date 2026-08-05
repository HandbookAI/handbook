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
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { applyEnvFile } from './env-file.js';
import { createLogger, type LogLevel } from '@handbook/core';
import { CachedChatClient, OpenAiChatClient, type ChatClient } from '@handbook/llm';
import { generateHandbook, loadHandbookModel, runPhase1 } from '@handbook/pipeline';
import { availableLanguages, registerBuiltinAdapters } from '@handbook/analyzer';
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
import { WorkDir } from '@handbook/pipeline';
import { graphFidelity, refreshRenderedHandbook, resolveTitle } from './render-refresh.js';
import { parseEnum, toInt } from './args.js';

const program = new Command();

program
  .name('handbook')
  .description('Turn any codebase into a navigable handbook — and use it to plan precise code changes.')
  .version('0.1.0')
  .option('-v, --verbose', 'debug logging')
  .option('-q, --quiet', 'errors only')
  .option('--env-file <path>', 'load KEY=VALUE pairs from a file (default: ./.env if present; shell env wins)');

// .env loading runs before every subcommand action, so OPENAI_* and
// HANDBOOK_* can live in a project-local file instead of the shell.
program.hook('preAction', () => {
  const explicit = program.opts<{ envFile?: string }>().envFile;
  if (explicit) {
    const applied = applyEnvFile(resolve(explicit)); // missing explicit file → loud error
    logger().debug(`[env] loaded ${applied.length} vars from ${explicit}`);
  } else if (existsSync('.env')) {
    const applied = applyEnvFile(resolve('.env'));
    if (applied.length > 0) logger().debug(`[env] loaded ${applied.length} vars from ./.env`);
  }
});

function logger(): ReturnType<typeof createLogger> {
  const opts = program.opts<{ verbose?: boolean; quiet?: boolean }>();
  const level: LogLevel = opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info';
  return createLogger('', level);
}

function llmClient(): ChatClient {
  return new OpenAiChatClient({ logger: logger() });
}

/**
 * `auto|<every registered language>` — derived, never hand-written: this help
 * string had drifted five languages behind the registry.
 */
function languageChoices(): string {
  registerBuiltinAdapters();
  return ['auto', ...availableLanguages()].join('|');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program
  .command('analyze')
  .description('Phase 1 only: build the static call graph (no LLM needed)')
  .requiredOption('--source <dir>', 'source root to analyze')
  .requiredOption('--work <dir>', 'work directory for artifacts')
  .option('--lang <lang>', `language (${languageChoices()})`, 'auto')
  .action(async (opts: { source: string; work: string; lang: string }) => {
    const stats = await runPhase1({
      sourceRoot: resolve(opts.source),
      workDir: resolve(opts.work),
      lang: opts.lang,
      logger: logger(),
    });
    printJson(stats);
  });

program
  .command('generate')
  .description('Run the handbook generation pipeline (env: OPENAI_API_KEY/MODEL/BASE_URL)')
  .requiredOption('--source <dir>', 'source root')
  .requiredOption('--work <dir>', 'work directory')
  .option('--phase <spec>', 'all | 1 | 2 | 2a | 2b | 2c | 3 | comma list', 'all')
  .option('--strategy <s>', 'file | member (default: file, or the work dir\'s recorded strategy)')
  .option('--skeleton <path>', 'user-authored skeleton.yaml (required for member strategy)')
  .option('--lang <lang>', `source language, auto-detects (${languageChoices()})`, 'auto')
  .option('--narrate-lang <l>', 'prose language: en | zh', 'en')
  .option('--detail <d>', 'card depth: brief | deep', 'brief')
  .option('--synth-mode <m>', 'skeleton synthesis: oneshot | doctor', 'oneshot')
  .option('--max-doctor-rounds <n>', 'doctor convergence rounds', '6')
  .option('--read-workers <n>', 'concurrent card batches', '12')
  .option('--resume', 'skip files that already have a completed card')
  .option('--refresh', 'ignore phase-3 caches')
  .option('--llm-cache', 'cache raw LLM replies under <work>/phase3/cache (prompt-hash; disabled by --refresh)')
  .action(async (opts: Record<string, string | boolean>) => {
    const phase = String(opts.phase);
    // Build the client opportunistically: some selections need no LLM at all
    // (phase 1; member-strategy 2c). generateHandbook fails with a clear
    // message if a key is genuinely required but missing.
    let client: ChatClient | undefined;
    if (phase !== '1') {
      try {
        client = llmClient();
      } catch {
        client = undefined;
      }
    }
    if (client && opts.llmCache && !opts.refresh) {
      client = new CachedChatClient(client, `${resolve(String(opts.work))}/phase3/cache`);
    }
    const stats = await generateHandbook({
      sourceRoot: resolve(String(opts.source)),
      workDir: resolve(String(opts.work)),
      client,
      phase,
      strategy: parseEnum(opts.strategy, '--strategy', ['file', 'member'] as const),
      skeletonPath: opts.skeleton ? resolve(String(opts.skeleton)) : undefined,
      lang: String(opts.lang),
      narrateLang: parseEnum(opts.narrateLang, '--narrate-lang', ['en', 'zh'] as const) ?? 'en',
      detail: parseEnum(opts.detail, '--detail', ['brief', 'deep'] as const) ?? 'brief',
      synthMode: parseEnum(opts.synthMode, '--synth-mode', ['oneshot', 'doctor'] as const) ?? 'oneshot',
      maxDoctorRounds: toInt(opts.maxDoctorRounds, '--max-doctor-rounds', 1),
      readWorkers: toInt(opts.readWorkers, '--read-workers', 1),
      resume: Boolean(opts.resume),
      refresh: Boolean(opts.refresh),
      logger: logger(),
    });
    // Surface what the run cost right where it finished (also in run-manifest.json).
    const usage = (client as { usage?: () => unknown } | undefined)?.usage?.();
    printJson(usage ? { ...stats, usage } : stats);
  });

program
  .command('render')
  .description('Render a completed work dir to markdown (+ optional HTML site / agent index); no LLM')
  .requiredOption('--work <dir>', 'work directory with completed phase-3 artifacts')
  .option('--out <dir>', 'output directory (default <work>/handbook)')
  .option('--title <title>', 'handbook title (default: $HANDBOOK_TITLE or "System Handbook")')
  .option('--html', 'also render the multi-page HTML site under <out>/html')
  .option('--html-single', 'also render a single self-contained HTML page')
  .option('--agent-site', 'also render the agent locator index under <out>/agent')
  .option('--llms-txt', 'also write llms.txt + llms-full.txt next to the markdown')
  .option('--source-base-url <url>', 'link file cards to the source at <url>/<relative path>')
  .action(async (opts: Record<string, string | boolean>) => {
    const workDir = resolve(String(opts.work));
    const outDir = resolve(String(opts.out ?? `${workDir}/handbook`));
    const model = loadHandbookModel(workDir, resolveTitle(opts.title));
    const languages = graphFidelity(workDir);
    const render = { languages, ...(opts.sourceBaseUrl ? { sourceBaseUrl: String(opts.sourceBaseUrl) } : {}) };
    const md = renderMarkdownHandbook(model, outDir, render);
    const result: Record<string, unknown> = { outDir, nStagePages: md.nStagePages };
    if (opts.agentSite) {
      result.agent = renderAgentSite(model, `${outDir}/agent`, { languages });
    }
    if (opts.html) {
      result.html = renderHtmlSite(model, `${outDir}/html`, render);
    }
    if (opts.htmlSingle) {
      result.htmlSingle = renderSinglePageHtml(model, `${outDir}/handbook.html`, { languages });
    }
    if (opts.llmsTxt) {
      result.llms = renderLlmsTxt(model, outDir, { languages });
    }
    printJson(result);
  });

program
  .command('skill')
  .description('Package a rendered handbook as an agent SKILL; no LLM')
  .requiredOption('--handbook <dir>', 'rendered handbook directory')
  .requiredOption('--out <dir>', 'skill output directory')
  .requiredOption('--name <slug>', 'skill slug (lowercase-hyphen)')
  .option('--project <name>', 'human project name for prose')
  .option('--work <dir>', 'work dir — adds coverage.json from its assignment')
  .option('--source <dir>', 'source root — adds content hashes to coverage.json')
  .option('--agent-dir <dir>', 'rendered agent locator site — ships under references/agent/')
  .option('--lang <l>', 'SKILL.md body language: en | zh (frontmatter stays English for routing)', 'en')
  .action((opts: Record<string, string | undefined>) => {
    let coverage;
    if (opts.work) {
      const work = new WorkDir(resolve(opts.work));
      coverage = {
        assignment: work.loadAssignment(),
        sourceRoot: opts.source ? resolve(opts.source) : undefined,
      };
    }
    const result = buildSkill({
      handbookDir: resolve(String(opts.handbook)),
      outDir: resolve(String(opts.out)),
      name: String(opts.name),
      project: opts.project,
      coverage,
      agentDir: opts.agentDir ? resolve(opts.agentDir) : undefined,
      lang: parseEnum(opts.lang, '--lang', ['en', 'zh'] as const) ?? 'en',
    });
    printJson(result);
  });

program
  .command('validate')
  .description('Validate a SKILL package (structure, index links, coverage freshness); no LLM')
  .requiredOption('--skill <dir>', 'skill directory')
  .option('--source <dir>', 'source root for hash freshness checks')
  .action((opts: { skill: string; source?: string }) => {
    const result = validateSkill({
      skillDir: resolve(opts.skill),
      sourceRoot: opts.source ? resolve(opts.source) : undefined,
    });
    for (const warning of result.warnings) process.stderr.write(`validate: warning: ${warning}\n`);
    for (const error of result.errors) process.stderr.write(`validate: error: ${error}\n`);
    process.stderr.write(result.ok ? 'validate: OK\n' : 'validate: FAILED\n');
    process.exitCode = result.ok ? 0 : 2;
  });

program
  .command('plan')
  .description('Localize a change request with the handbook and emit a precise edit plan')
  .requiredOption('--source <dir>', 'codebase to plan against (read-only)')
  .requiredOption('--request <text>', 'the natural-language change request')
  .option('--handbook <dir>', 'rendered handbook or skill references dir')
  .option('--out <file>', 'write the plan to a file (default stdout)')
  .option('--max-turns <n>', 'agent turn budget', '30')
  .action(async (opts: Record<string, string | undefined>) => {
    const result = await runPlanner({
      client: llmClient(),
      sourceRoot: resolve(String(opts.source)),
      handbookDir: opts.handbook ? resolve(opts.handbook) : undefined,
      request: String(opts.request),
      maxTurns: toInt(opts.maxTurns, '--max-turns', 1),
      logger: logger(),
    });
    // A run that gave up must exit non-zero: writing its abort message to
    // plan.md and returning 0 would let a script feed it straight into `apply`.
    if (result.aborted) {
      throw new Error(
        `planner produced no usable plan (${result.aborted}) after ${result.turns} turn(s): ${result.plan}`,
      );
    }
    if (opts.out) {
      writeFileSync(resolve(opts.out), `${result.plan}\n`);
      printJson({ out: resolve(opts.out), turns: result.turns, declarations: result.declarations });
    } else {
      process.stdout.write(`${result.plan}\n`);
    }
  });

program
  .command('resync')
  .description('Roll a handbook forward after a code change (case dir: edited/ + plan.md + change.diff)')
  .requiredOption('--case <dir>', 'case directory')
  .requiredOption('--work <dir>', 'work directory holding the handbook artifacts')
  .option('--no-llm', 'structural refresh only (no LLM; prose marked stale)')
  .option('--detail <d>', 'card depth for regenerated cards: brief | deep (default: match the existing handbook)')
  .option('--narrate-lang <l>', 'prose language: en | zh')
  .option('--corrections <file>', 'agent-reported corrections.jsonl — its files widen the refresh set')
  .option('--no-render', 'skip refreshing already-rendered outputs under <work>/handbook')
  .option('--title <title>', 'handbook title for refreshed outputs (default: $HANDBOOK_TITLE or "System Handbook")')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    const noLlm = opts.llm === false; // commander maps --no-llm to llm:false
    const workDir = resolve(String(opts.work));
    const report = await resyncHandbook({
      caseDir: resolve(String(opts.case)),
      workDir,
      client: noLlm ? undefined : llmClient(),
      noLlm,
      detail: parseEnum(opts.detail, '--detail', ['brief', 'deep'] as const),
      correctionsPath: opts.corrections ? resolve(String(opts.corrections)) : undefined,
      lang: parseEnum(opts.narrateLang, '--narrate-lang', ['en', 'zh'] as const),
      logger: logger(),
    });
    const rendered =
      opts.render === false || report.skipped
        ? []
        : refreshRenderedHandbook(workDir, resolveTitle(opts.title), logger());
    printJson({ ...report, rendered });
  });

program
  .command('apply')
  .description('Apply a plan\'s EDIT blocks to a source tree (byte-exact, all-or-nothing, with backups)')
  .requiredOption('--source <dir>', 'source tree to edit')
  .requiredOption('--plan <file>', 'plan file produced by `handbook plan`')
  .option('--dry-run', 'verify only — never write')
  .option('--backup-root <dir>', 'where backups go (default <source>/.handbook-patches)')
  .action(async (opts: { source: string; plan: string; dryRun?: boolean; backupRoot?: string }) => {
    const { applyPlan } = await import('@handbook/patcher');
    const result = applyPlan({
      sourceRoot: resolve(opts.source),
      plan: readFileSync(resolve(opts.plan), 'utf8'),
      dryRun: Boolean(opts.dryRun),
      backupRoot: opts.backupRoot ? resolve(opts.backupRoot) : undefined,
      logger: logger(),
    });
    printJson(result);
    process.exitCode = result.ok ? 0 : 2;
  });

program
  .command('rollback')
  .description('Restore a source tree from a patch backup produced by `handbook apply`')
  .requiredOption('--backup <dir>', 'backup directory (contains manifest.json)')
  .option('--source <dir>', 'the tree this backup belongs to (guards against restoring into the wrong repo)')
  .option('--force', 'restore even files that changed after the patch')
  .action(async (opts: { backup: string; source?: string; force?: boolean }) => {
    const { rollback } = await import('@handbook/patcher');
    printJson(
      rollback(resolve(opts.backup), {
        force: Boolean(opts.force),
        expectedSourceRoot: opts.source ? resolve(opts.source) : undefined,
        logger: logger(),
      }),
    );
  });

program
  .command('studio')
  .description('Launch the local web UI (repos · generate · browse · evolve); binds to 127.0.0.1')
  .option('--port <n>', 'port to listen on', '4860')
  .option('--state-dir <dir>', 'where studio.json and managed work dirs live', `${process.env.HOME ?? '.'}/.handbook-studio`)
  .action(async (opts: { port: string; stateDir: string }) => {
    const { startStudio } = await import('@handbook/studio');
    const port = toInt(opts.port, '--port', 1);
    await startStudio({ stateDir: resolve(opts.stateDir), port, logger: logger() });
    process.stderr.write(`handbook studio → http://127.0.0.1:${port}\n`);
    await new Promise(() => {}); // run until Ctrl-C
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`handbook: error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
