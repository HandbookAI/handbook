import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ModuleAnalysis } from '@handbook/core';
import { ShellAdapter } from './shell.js';

const DEPLOY_SH = `#!/bin/bash

build() {
  echo "building"
  /usr/bin/git status
  lint
}

deploy() {
  build
  helper_util
  aws s3 sync . s3://bucket
}

deploy
`;

const UTIL_BASH = `
helper_util() {
  curl -s example.com
}

function lint {
  shellcheck deploy.sh
}
`;

describe('ShellAdapter', () => {
  let analysis: ModuleAnalysis;
  let root: string;
  const adapter = new ShellAdapter();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hb-shell-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'deploy.sh'), DEPLOY_SH);
    writeFileSync(join(root, 'lib', 'util.bash'), UTIL_BASH);
    analysis = await adapter.analyze(['scripts/deploy.sh', 'lib/util.bash'], root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it('discovers .sh and .bash files', () => {
    const files = adapter.discover(root);
    expect(files).toContain('scripts/deploy.sh');
    expect(files).toContain('lib/util.bash');
  });

  it('extracts one node per function definition (both syntaxes)', () => {
    expect(fn('scripts.deploy.build')).toBeDefined();
    expect(fn('scripts.deploy.deploy')).toBeDefined();
    expect(fn('lib.util.helper_util')).toBeDefined();
    expect(fn('lib.util.lint')).toBeDefined(); // "function name {" form
  });

  it('uses the first line as the signature', () => {
    expect(fn('scripts.deploy.build')?.signature).toBe('build() {');
    expect(fn('lib.util.lint')?.signature).toBe('function lint {');
  });

  it('resolves same-module function calls to internal_func', () => {
    expect(edge('scripts.deploy.deploy', 'scripts.deploy.build')?.callType).toBe('internal_func');
  });

  it('resolves cross-module function calls through the global index', () => {
    expect(edge('scripts.deploy.deploy', 'lib.util.helper_util')?.callType).toBe('internal_func');
    expect(edge('scripts.deploy.build', 'lib.util.lint')?.callType).toBe('internal_func');
  });

  it('strips leading paths from external commands', () => {
    const git = edge('scripts.deploy.build', 'boundary:git');
    expect(git?.callType).toBe('boundary');
    expect(git?.raw).toBe('/usr/bin/git');
  });

  it('routes unknown commands to boundary', () => {
    expect(edge('scripts.deploy.build', 'boundary:echo')?.callType).toBe('boundary');
    expect(edge('scripts.deploy.deploy', 'boundary:aws')?.callType).toBe('boundary');
    expect(edge('lib.util.helper_util', 'boundary:curl')?.callType).toBe('boundary');
  });

  it('never attributes top-level commands to a function', () => {
    const topLevel = analysis.edges.filter((e) => e.raw === 'deploy');
    expect(topLevel).toHaveLength(0);
  });
});
