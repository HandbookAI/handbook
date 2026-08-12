#!/usr/bin/env node
// Writes `repository`, `homepage` and `bugs` into the root manifest and all
// eleven package manifests.
//
// This exists because npm needs those fields as literal values in each
// manifest, and getting them right by hand is twelve edits where `directory`
// differs in every one. Two things depend on them:
//
//   - The npm page for each package links back to source. Without it a
//     published `@handbooks/*` is a tarball with no visible origin.
//   - npm provenance (`NPM_CONFIG_PROVENANCE`) *requires* `repository` to point
//     at the public repo the build ran in. Turning provenance on before these
//     fields exist fails the publish rather than securing it — see the comment
//     at the end of .github/workflows/release.yml.
//
// Idempotent: run it again after moving the repo and it rewrites the values.
//
//   node scripts/set-repo-url.mjs https://github.com/OWNER/handbook
//   node scripts/set-repo-url.mjs --check        # verify, don't write
//
// Deliberately not wired into `pnpm check`. Until the repo has a public URL
// there is nothing to check against, and a gate that fails on a fresh clone
// teaches people to ignore gates.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const url = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

const manifests = [
  { path: join(ROOT, 'package.json'), directory: null },
  ...readdirSync(join(ROOT, 'packages'))
    .filter((name) => statSync(join(ROOT, 'packages', name)).isDirectory())
    .sort()
    .map((name) => ({ path: join(ROOT, 'packages', name, 'package.json'), directory: `packages/${name}` })),
];

if (checkOnly) {
  const missing = manifests
    .filter(({ path }) => !JSON.parse(readFileSync(path, 'utf8')).repository)
    .map(({ path }) => path.slice(ROOT.length + 1));
  if (missing.length) {
    console.error(`no "repository" field in ${missing.length} manifest(s):`);
    for (const path of missing) console.error(`  ${path}`);
    console.error('\nfix: node scripts/set-repo-url.mjs https://github.com/OWNER/handbook');
    process.exit(1);
  }
  console.log(`repository fields present in all ${manifests.length} manifests`);
  process.exit(0);
}

if (!url || !/^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(url)) {
  console.error('usage: node scripts/set-repo-url.mjs https://github.com/OWNER/REPO');
  console.error('       node scripts/set-repo-url.mjs --check');
  process.exit(1);
}

for (const { path, directory } of manifests) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));

  // `git+…` is the form npm normalises to anyway, and the form provenance
  // matches against. `directory` is what tells npm which subdirectory of the
  // monorepo a package came from; the root manifest has none.
  manifest.repository = { type: 'git', url: `git+${url}.git`, ...(directory ? { directory } : {}) };
  manifest.homepage = directory ? `${url}/tree/main/${directory}#readme` : `${url}#readme`;
  manifest.bugs = { url: `${url}/issues` };

  // Trailing newline: prettier owns this file's formatting and checks for one.
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`updated ${path.slice(ROOT.length + 1)}`);
}

console.log(`\n${manifests.length} manifests now point at ${url}`);
console.log('next: pnpm format && pnpm check:packaging');
console.log(
  'then, to sign published tarballs: set NPM_CONFIG_PROVENANCE: true in .github/workflows/release.yml',
);
