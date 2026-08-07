#!/usr/bin/env node
// Enforces the monorepo's structural invariants — the conventions that are easy
// to state, easy to break, and invisible until something ships wrong.
//
// Every rule here exists because the repo already violated it at least once:
// packages/cli depended on @handbook/patcher and @handbook/studio without
// listing them as TypeScript project references (a root `tsc -b` hid it), and
// every package emitted its own tests into dist/ while declaring
// `"files": ["dist"]`.
//
// Run: node scripts/check-workspace.mjs   (wired into `pnpm check` and CI)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@handbook/';

const problems = [];
const fail = (where, message) => problems.push({ where, message });

/** Reads JSON that may contain `//` comments (tsconfig files do). */
function readJson(path) {
  const raw = readFileSync(path, 'utf8');
  const withoutComments = raw.replace(/^\s*\/\/.*$/gm, '');
  try {
    return JSON.parse(withoutComments);
  } catch (err) {
    fail(path, `not parseable as JSON: ${err.message}`);
    return null;
  }
}

const packageDirs = readdirSync(join(ROOT, 'packages')).filter((name) =>
  statSync(join(ROOT, 'packages', name)).isDirectory(),
);

// name -> { dir, manifest, tsconfig }
const packages = new Map();

for (const dir of packageDirs) {
  const manifestPath = join(ROOT, 'packages', dir, 'package.json');
  const tsconfigPath = join(ROOT, 'packages', dir, 'tsconfig.json');

  if (!existsSync(manifestPath)) {
    fail(`packages/${dir}`, 'has no package.json');
    continue;
  }
  if (!existsSync(tsconfigPath)) {
    fail(`packages/${dir}`, 'has no tsconfig.json');
    continue;
  }

  const manifest = readJson(manifestPath);
  const tsconfig = readJson(tsconfigPath);
  if (!manifest || !tsconfig) continue;

  if (manifest.name !== `${SCOPE}${dir}`) {
    fail(`packages/${dir}`, `directory name and package name disagree: "${manifest.name}"`);
  }
  packages.set(dir, { dir, manifest, tsconfig });
}

// ---------------------------------------------------------------------------
// 1. TypeScript project references must mirror workspace dependencies.
//    A missing reference makes `tsc -b packages/<x>` build in the wrong order;
//    a stale one keeps a dropped dependency alive in the build graph.
// ---------------------------------------------------------------------------
for (const { dir, manifest, tsconfig } of packages.values()) {
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((d) => d.startsWith(SCOPE))
    .map((d) => d.slice(SCOPE.length));

  const refs = (tsconfig.references ?? []).map((r) => r.path.replace(/^\.\.\//, ''));

  for (const missing of deps.filter((d) => !refs.includes(d))) {
    fail(
      `packages/${dir}/tsconfig.json`,
      `depends on ${SCOPE}${missing} but does not reference ../${missing}`,
    );
  }
  for (const extra of refs.filter((r) => !deps.includes(r))) {
    fail(`packages/${dir}/tsconfig.json`, `references ../${extra} but does not depend on ${SCOPE}${extra}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Workspace dependencies must use the workspace: protocol and exist.
// ---------------------------------------------------------------------------
for (const { dir, manifest } of packages.values()) {
  for (const [dep, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (!dep.startsWith(SCOPE)) continue;
    const target = dep.slice(SCOPE.length);
    if (!packages.has(target)) {
      fail(`packages/${dir}/package.json`, `depends on ${dep}, which is not a workspace package`);
    } else if (!range.startsWith('workspace:')) {
      fail(`packages/${dir}/package.json`, `${dep} must use the workspace: protocol, found "${range}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. The root solution file must reference every package, so `tsc -b` at the
//    root is genuinely a whole-repo build.
// ---------------------------------------------------------------------------
{
  const rootTsconfig = readJson(join(ROOT, 'tsconfig.json'));
  if (rootTsconfig) {
    const referenced = (rootTsconfig.references ?? []).map((r) => r.path.replace(/^packages\//, ''));
    for (const dir of packages.keys()) {
      if (!referenced.includes(dir)) {
        fail('tsconfig.json', `does not reference packages/${dir} — a root build would skip it`);
      }
    }
    for (const ref of referenced) {
      if (!packages.has(ref)) fail('tsconfig.json', `references packages/${ref}, which does not exist`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Build projects must exclude tests, and dist must not contain any. The
//    exclusion is the cause; the dist scan is the effect — check both, because
//    a stale dist from before the rule existed is still a shipping hazard.
// ---------------------------------------------------------------------------
const TEST_PATTERNS = ['src/**/*.test.ts', 'src/**/*.test-helper.ts'];
for (const { dir, tsconfig } of packages.values()) {
  const exclude = tsconfig.exclude ?? [];
  for (const pattern of TEST_PATTERNS) {
    if (!exclude.includes(pattern)) {
      fail(
        `packages/${dir}/tsconfig.json`,
        `exclude is missing "${pattern}" — tests would be emitted into dist`,
      );
    }
  }

  const dist = join(ROOT, 'packages', dir, 'dist');
  if (!existsSync(dist)) continue;
  const leaked = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test(-helper)?\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(entry.name)) leaked.push(entry.name);
    }
  };
  walk(dist);
  if (leaked.length > 0) {
    fail(
      `packages/${dir}/dist`,
      `contains ${leaked.length} test artifact(s) (e.g. ${leaked[0]}) — run \`pnpm clean && pnpm build\``,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Manifest shape must be uniform. Eleven packages that each describe
//    themselves slightly differently is how a publish goes wrong quietly.
// ---------------------------------------------------------------------------
for (const { dir, manifest } of packages.values()) {
  if (manifest.type !== 'module') fail(`packages/${dir}/package.json`, 'must declare "type": "module"');
  if (!manifest.description) fail(`packages/${dir}/package.json`, 'has no description');
  if (!manifest.license) fail(`packages/${dir}/package.json`, 'has no license');
  if (!Array.isArray(manifest.files) || !manifest.files.includes('dist')) {
    fail(`packages/${dir}/package.json`, '"files" must be an array containing "dist"');
  }
  // Source maps name `../../src/*.ts`, which `files` never ships. Publishing
  // them is 36% of the tarball pointing at nothing. They stay for local
  // development, where the sources they reference actually exist.
  if (!manifest.files?.includes('!dist/**/*.map')) {
    fail(
      `packages/${dir}/package.json`,
      '"files" must exclude "!dist/**/*.map" — maps dangle once published',
    );
  }
  if (manifest.engines?.node !== '>=20.11') {
    fail(`packages/${dir}/package.json`, 'must declare engines.node ">=20.11", matching the root manifest');
  }
  if (manifest.exports?.['.']?.types !== './dist/index.d.ts') {
    fail(`packages/${dir}/package.json`, 'exports["."].types must be "./dist/index.d.ts"');
  }
  if (manifest.exports?.['.']?.default !== './dist/index.js') {
    fail(`packages/${dir}/package.json`, 'exports["."].default must be "./dist/index.js"');
  }
  for (const script of ['build', 'test']) {
    if (!manifest.scripts?.[script]) fail(`packages/${dir}/package.json`, `has no "${script}" script`);
  }
  if (manifest.private !== true && manifest.publishConfig?.access !== 'public') {
    fail(`packages/${dir}/package.json`, 'is publishable but does not set publishConfig.access to "public"');
  }
}

// ---------------------------------------------------------------------------
// 6. A publishable package may not depend on a private one — npm install would
//    resolve a package that was never published.
// ---------------------------------------------------------------------------
for (const { dir, manifest } of packages.values()) {
  if (manifest.private === true) continue;
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith(SCOPE)) continue;
    const target = packages.get(dep.slice(SCOPE.length));
    if (target?.manifest.private === true) {
      fail(`packages/${dir}/package.json`, `is publishable but depends on private ${dep}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Third-party versions live in the pnpm catalog and nowhere else. A literal
//    range in a package manifest is how two packages end up on two versions of
//    the same library without anyone noticing.
// ---------------------------------------------------------------------------
{
  const workspaceYaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const catalogSection = workspaceYaml.slice(workspaceYaml.indexOf('\ncatalog:'));
  const catalogNames = new Set(
    [...catalogSection.matchAll(/^ {2}(?:'([^']+)'|"([^"]+)"|([\w@/.-]+)):/gm)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    ),
  );

  const rootManifest = readJson(join(ROOT, 'package.json'));
  const manifests = [
    { where: 'package.json', manifest: rootManifest },
    ...[...packages.values()].map(({ dir, manifest }) => ({
      where: `packages/${dir}/package.json`,
      manifest,
    })),
  ];

  const declared = new Set();
  for (const { where, manifest } of manifests) {
    if (!manifest) continue;
    for (const [dep, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (dep.startsWith(SCOPE)) continue;
      declared.add(dep);
      if (range !== 'catalog:') {
        fail(
          where,
          `${dep} pins "${range}" directly — declare the version in the catalog and depend on "catalog:"`,
        );
      } else if (!catalogNames.has(dep)) {
        fail('pnpm-workspace.yaml', `${dep} is declared as "catalog:" but the catalog has no entry for it`);
      }
    }
  }

  for (const name of catalogNames) {
    if (!declared.has(name)) fail('pnpm-workspace.yaml', `catalog entry "${name}" is unused — drop it`);
  }
}

// ---------------------------------------------------------------------------

if (problems.length === 0) {
  console.log(`workspace invariants OK — ${packages.size} packages checked`);
  process.exit(0);
}

console.error(`workspace invariants FAILED — ${problems.length} problem(s):\n`);
for (const { where, message } of problems) console.error(`  ${where}\n    ${message}\n`);
process.exit(1);
