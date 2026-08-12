#!/usr/bin/env node
// Publishing correctness, checked by tools instead of by hand.
//
// The packaging defects this repo shipped — tests emitted into dist, source
// maps naming sources that were never published — were all found by manually
// packing a tarball and reading it. That does not scale and does not repeat.
// These two tools check the same class of thing on every run:
//
//   publint  — manifest and tarball sanity: files that `exports` points at but
//              the tarball omits, a `bin` without a shebang, wrong `types`
//              ordering, publishing a package that cannot be resolved.
//   attw     — "are the types wrong": resolves the package's type declarations
//              the way each module system actually would, and fails when a
//              consumer would get `any` or nothing.
//
// attw runs under the `esm-only` profile deliberately. Every package here is
// `"type": "module"` with a NodeNext build and engines >=20.11, so the node10
// algorithm (which predates `exports`) and CommonJS `require` are not supported
// targets — they are decisions, not oversights. If a package ever needs to
// support CJS consumers, drop the profile and fix what it reports.
//
// Run: node scripts/check-packaging.mjs   (needs a current `tsc -b`)

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { scoped } from './scope.mjs';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'esm-only';

const packages = readdirSync(join(ROOT, 'packages'))
  .filter((name) => statSync(join(ROOT, 'packages', name)).isDirectory())
  .filter((name) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
    // A private package is never published, so publishing rules do not apply.
    return manifest.private !== true;
  });

/** Runs one tool in a package directory, returning its combined output. */
async function check(tool, args, dir) {
  const cwd = join(ROOT, 'packages', dir);
  try {
    const { stdout, stderr } = await run('node', [toolPath(tool), ...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, output: stdout + stderr };
  } catch (err) {
    return { ok: false, output: (err.stdout ?? '') + (err.stderr ?? '') || String(err) };
  }
}

/**
 * Resolve each CLI's entry point from its own manifest rather than hardcoding a
 * path inside the package — that path is an implementation detail the tool is
 * free to move between versions, and hardcoding it turns an upgrade into a
 * confusing "module not found" for all eleven packages at once.
 */
const TOOL_PACKAGES = { publint: 'publint', attw: '@arethetypeswrong/cli' };

function toolPath(tool) {
  const pkgDir = join(ROOT, 'node_modules', TOOL_PACKAGES[tool]);
  const { bin } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin[tool];
  if (!entry) throw new Error(`${TOOL_PACKAGES[tool]} declares no "${tool}" bin`);
  return join(pkgDir, entry);
}

const failures = [];

// Each package's two checks are independent; the packages are too. Packing
// dominates the wall clock, so run them together.
const results = await Promise.all(
  packages.map(async (dir) => {
    const [publint, attw] = await Promise.all([
      check('publint', [], dir),
      check('attw', ['--pack', '.', '--profile', PROFILE], dir),
    ]);
    return { dir, publint, attw };
  }),
);

for (const { dir, publint, attw } of results) {
  const status = publint.ok && attw.ok ? 'OK  ' : 'FAIL';
  console.log(`  ${status} ${scoped(dir)}`);
  if (!publint.ok) failures.push({ dir, tool: 'publint', output: publint.output });
  if (!attw.ok) failures.push({ dir, tool: `attw (profile: ${PROFILE})`, output: attw.output });
}

if (failures.length === 0) {
  console.log(`\npackaging OK — ${packages.length} publishable packages pass publint and attw`);
  process.exit(0);
}

console.error(`\npackaging FAILED — ${failures.length} problem(s):\n`);
for (const { dir, tool, output } of failures) {
  console.error(`── ${scoped(dir)} — ${tool} ${'─'.repeat(Math.max(0, 50 - dir.length))}`);
  console.error(output.trim());
  console.error('');
}
process.exit(1);
