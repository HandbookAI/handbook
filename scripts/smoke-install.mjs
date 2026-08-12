#!/usr/bin/env node
// Installs the packages the way a stranger would, and runs the CLI.
//
// Every other gate in this repo tests the workspace: tests import from src,
// the demo runs `node packages/cli/dist/main.js`, and pnpm's symlinks make
// cross-package imports resolve whether or not `exports` is right. None of that
// exercises the thing users actually get.
//
// This packs every publishable package, installs the tarballs into an empty
// project with plain npm — no workspace, no symlinks, no pnpm — and drives the
// CLI through its whole pipeline against the bundled offline mock. It is the
// only check here that would notice a missing `files` entry, a runtime asset
// that never got published, or a bin that does not start.
//
// Run: node scripts/smoke-install.mjs   (needs a current `tsc -b`)

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = join(ROOT, 'examples', 'demo-project');
const MOCK_PORT = 8231;

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

let workdir;
let mock;
let failed = false;

const step = (msg) => console.log(`\n== ${msg}`);
const ok = (msg) => console.log(`   OK   ${msg}`);
const bad = (msg) => {
  console.error(`   FAIL ${msg}`);
  failed = true;
};

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A `.cmd` is a batch script, not an executable, so Windows can only run it
    // through the shell. Node used to do that implicitly and stopped in 2024,
    // when the fix for the argument-injection advisory made `execFile` refuse a
    // `.cmd` outright: `spawnSync npm.cmd EINVAL`, thrown before this script
    // reaches a single assertion. That is why `smoke (windows-latest)` failed
    // for a reason no test change could address.
    //
    // Scoped to the three `.cmd` invocations rather than turned on everywhere:
    // `shell: true` re-parses the arguments, and every other call here passes
    // paths from `mkdtemp` that must not be re-split.
    shell: cmd.endsWith('.cmd'),
    ...opts,
  });
}

try {
  workdir = mkdtempSync(join(tmpdir(), 'handbook-smoke-'));
  const tarballDir = join(workdir, 'tarballs');
  const project = join(workdir, 'project');
  sh(npmCmd, ['init', '-y'], { cwd: mkdirp(project) });

  // ---------------------------------------------------------------------
  step('pack every publishable package');
  // ---------------------------------------------------------------------
  mkdirp(tarballDir);
  const publishable = readdirSync(join(ROOT, 'packages'))
    .filter((n) => statSync(join(ROOT, 'packages', n)).isDirectory())
    .filter((n) => {
      const m = JSON.parse(readFileSync(join(ROOT, 'packages', n, 'package.json'), 'utf8'));
      return m.private !== true;
    });

  for (const name of publishable) {
    sh(pnpmCmd, ['pack', '--pack-destination', tarballDir], { cwd: join(ROOT, 'packages', name) });
  }
  const tarballs = readdirSync(tarballDir).map((f) => join(tarballDir, f));
  if (tarballs.length !== publishable.length) {
    bad(`packed ${tarballs.length} tarballs for ${publishable.length} packages`);
  } else {
    ok(`${tarballs.length} tarballs`);
  }

  // ---------------------------------------------------------------------
  step('install them with plain npm, outside the workspace');
  // ---------------------------------------------------------------------
  sh(npmCmd, ['install', ...tarballs, '--no-audit', '--no-fund'], { cwd: project });
  const cliDir = join(project, 'node_modules', '@handbook', 'cli');
  if (!existsSync(cliDir)) throw new Error('@handbook/cli did not install');
  ok('installed');

  // The published bin must exist as a shim, and the entry it names must be real.
  const cliManifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
  const binEntry = join(cliDir, cliManifest.bin.handbook);
  if (!existsSync(binEntry)) bad(`bin entry missing: ${cliManifest.bin.handbook}`);
  else if (!readFileSync(binEntry, 'utf8').startsWith('#!')) bad('bin entry has no shebang');
  else ok('bin entry present, with a shebang');

  const shim = join(
    project,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'handbook.cmd' : 'handbook',
  );
  if (existsSync(shim)) ok('npm created the .bin shim');
  else bad('npm created no .bin shim');

  // Drive the CLI through node directly: the shim's exact form differs per
  // platform, but the entry point it targets must work identically everywhere.
  const hb = (...args) => sh(process.execPath, [binEntry, ...args], { cwd: project, env: cliEnv() });

  /** Same, but returns stdout and stderr together — the CLI logs to stderr. */
  const hbBoth = (...args) => {
    const r = spawnSync(process.execPath, [binEntry, ...args], {
      cwd: project,
      env: cliEnv(),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`handbook ${args[0]} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  };

  // ---------------------------------------------------------------------
  step('run the CLI');
  // ---------------------------------------------------------------------
  const version = hb('--version').trim();
  version === cliManifest.version ? ok(`--version reports ${version}`) : bad(`--version said ${version}`);

  // analyze needs no LLM, but it does need the tree-sitter WASM grammars to
  // resolve from the *installed* node_modules — a packaging concern, not a
  // code one.
  const analyzed = JSON.parse(hb('analyze', '--source', DEMO, '--work', join(project, 'work')));
  analyzed.functions > 0 ? ok(`analyze found ${analyzed.functions} functions`) : bad('analyze found nothing');

  // ---------------------------------------------------------------------
  step('drive the rest of the pipeline against the offline mock');
  // ---------------------------------------------------------------------
  mock = spawn(process.execPath, [join(ROOT, 'examples', 'mock-llm-server.mjs'), String(MOCK_PORT)], {
    stdio: 'ignore',
  });
  await waitForPort(MOCK_PORT);

  const work = join(project, 'work');
  hb('generate', '--source', DEMO, '--work', work, '--phase', '2,3');
  hb('render', '--work', work, '--title', 'Smoke', '--html', '--html-single');
  // prettier-ignore
  hb('skill', '--handbook', join(work, 'handbook'), '--out', join(project, 'skill'), '--name', 'smoke',
     '--project', 'Smoke', '--work', work, '--source', DEMO);

  // validate reports through the logger, which writes to stderr, so read both
  // streams. Exiting zero is most of the assertion; matching the message keeps
  // a silently-empty validate from passing as a verified one.
  const validated = hbBoth('validate', '--skill', join(project, 'skill'), '--source', DEMO);
  validated.includes('OK') ? ok('validate: OK') : bad(`validate said: ${validated.trim() || '(nothing)'}`);

  for (const artefact of [
    join(work, 'handbook', 'overview.md'),
    join(work, 'handbook', 'handbook.html'),
    join(project, 'skill', 'SKILL.md'),
  ]) {
    const size = existsSync(artefact) ? statSync(artefact).size : 0;
    size > 0
      ? ok(`${artefact.slice(project.length + 1)} (${size} bytes)`)
      : bad(`empty or missing: ${artefact}`);
  }

  // ---------------------------------------------------------------------
  step('studio serves the UI asset it publishes');
  // ---------------------------------------------------------------------
  const studioUi = join(project, 'node_modules', '@handbook', 'studio', 'public', 'index.html');
  existsSync(studioUi) ? ok('studio shipped public/index.html') : bad('studio did not ship its UI');
} catch (err) {
  bad(err.stdout ? `${err.message}\n${err.stdout}\n${err.stderr}` : String(err.stack ?? err));
} finally {
  mock?.kill();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}

console.log(
  failed ? '\nsmoke FAILED' : '\nsmoke OK — the published packages install and run outside the workspace',
);
process.exit(failed ? 1 : 0);

// ---------------------------------------------------------------------------

function mkdirp(dir) {
  execFileSync(process.execPath, [
    '-e',
    `require('node:fs').mkdirSync(${JSON.stringify(dir)},{recursive:true})`,
  ]);
  return dir;
}

function cliEnv() {
  return {
    ...process.env,
    OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    OPENAI_API_KEY: 'EMPTY',
    // The CLI auto-loads ./.env from the cwd; the temp project has none, and it
    // must not pick up the repo's real credentials.
    NARRATE_LANG: 'en',
  };
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/v1/models`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`mock LLM never came up on port ${port}`);
}
