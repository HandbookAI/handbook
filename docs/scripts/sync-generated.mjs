#!/usr/bin/env node
// Copies the repo's shared diagram assets into the site's public directory.
//
// They live in `assets/` at the repo root because both READMEs reference them
// from there, and a second hand-maintained copy under `docs/public/` would drift
// the first time one of them is edited. Copying at build time keeps exactly one
// source of truth; `docs/public/diagrams/` is gitignored for that reason.
//
// Run automatically by `pnpm dev` and `pnpm build` in this directory.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', 'assets');
const to = join(here, '..', 'public', 'diagrams');

mkdirSync(to, { recursive: true });

// A missing `assets/` is a DEPLOYMENT CONFIGURATION problem, and it has to say
// so. 48 content pages reference these diagrams, so continuing without them
// would ship a site with 48 broken images and a green build — the worst
// outcome. But the raw failure was `ENOENT: scandir '/vercel/assets'`, which
// tells whoever is reading a build log nothing about the cause.
//
// The cause is always the same: something built `docs/` in isolation. This
// directory is its own pnpm workspace, but the diagrams live at the REPOSITORY
// root because both READMEs reference them from there, so the build needs the
// whole tree — on Vercel that means cloning the repo and setting Root Directory
// to `docs`, not uploading `docs/` alone.
if (!existsSync(from)) {
  console.error(`sync-generated: cannot find the shared diagrams at ${from}`);
  console.error('');
  console.error('  This build only has `docs/`, but the diagrams live at the repository root');
  console.error('  (`assets/`) because both READMEs reference them from there.');
  console.error('');
  console.error('  On Vercel: connect the Git repository and set Root Directory to `docs`,');
  console.error('  so the whole tree is checked out. `vercel deploy` from inside `docs/`');
  console.error('  uploads only this directory and cannot work.');
  console.error('');
  console.error('  Locally: run from a full checkout, not from an extracted `docs/`.');
  process.exit(1);
}

let n = 0;
for (const file of readdirSync(from)) {
  if (!file.endsWith('.svg')) continue;
  cpSync(join(from, file), join(to, file));
  n += 1;
}
console.log(`sync-generated: copied ${n} diagram(s) into public/diagrams`);
