#!/usr/bin/env node
// Writes the three generated configuration surfaces. The rendering itself lives
// in @handbook/core so the drift test can call exactly the same functions —
// a generator and a checker that could disagree would defeat the point.
//
// Run: pnpm run config:docs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from '../packages/core/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['.env.example', renderEnvExample()],
  ['docs/content/docs/reference/configuration.md', renderConfigDocs()],
  ['handbook.config.example.yaml', renderConfigExampleYaml()],
];
for (const [rel, content] of files) {
  writeFileSync(join(ROOT, rel), content);
  console.log(`wrote ${rel}`);
}
