#!/usr/bin/env node
// Copies the repo's shared diagram assets into the site's public directory.
//
// They live in `assets/` at the repo root because both READMEs reference them
// from there, and a second hand-maintained copy under `docs/public/` would drift
// the first time one of them is edited. Copying at build time keeps exactly one
// source of truth; `docs/public/diagrams/` is gitignored for that reason.
//
// Run automatically by `pnpm dev` and `pnpm build` in this directory.

import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'assets');
const to = join(here, '..', 'public', 'diagrams');

mkdirSync(to, { recursive: true });
let n = 0;
for (const file of readdirSync(from)) {
  if (!file.endsWith('.svg')) continue;
  cpSync(join(from, file), join(to, file));
  n += 1;
}
console.log(`sync-generated: copied ${n} diagram(s) into public/diagrams`);
