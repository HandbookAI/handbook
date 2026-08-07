#!/usr/bin/env node
// `rm -rf` is not a command on Windows, and npm scripts there run through
// cmd.exe. This is the same removal, in a form every platform in the CI matrix
// can execute.

import { rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const removed = [];

// `clean:all` also drops installed dependencies. Kept in this script rather
// than an `rm -rf` in package.json for the same reason the rest of it is here:
// cmd.exe has no rm.
const alsoNodeModules = process.argv.includes('--node-modules');

const drop = (path) => {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(path.slice(ROOT.length + 1));
};

// dist and .tsbuildinfo must go together. Removing dist alone leaves tsc -b
// believing the build is current, so the next build emits nothing and every
// cross-package import fails to resolve — a confusing state to land someone in.
for (const dir of readdirSync(join(ROOT, 'packages'))) {
  const pkg = join(ROOT, 'packages', dir);
  if (!statSync(pkg).isDirectory()) continue;
  drop(join(pkg, 'dist'));
  for (const entry of readdirSync(pkg)) {
    if (entry.endsWith('.tsbuildinfo')) drop(join(pkg, entry));
  }
}
drop(join(ROOT, 'coverage'));

// Last, so the packages/ walk above still has directories to read.
if (alsoNodeModules) {
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const pkg = join(ROOT, 'packages', dir);
    if (statSync(pkg).isDirectory()) drop(join(pkg, 'node_modules'));
  }
  drop(join(ROOT, 'node_modules'));
}

console.log(removed.length ? `removed ${removed.length} path(s)` : 'nothing to remove');
