import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CallType, ModuleAnalysis } from '@handbooks/core';
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

  /**
   * Was "never attributes top-level commands to a function". The intent — a
   * top-level command must not be blamed on some unrelated function — is kept,
   * but the outcome changed on purpose in SP6: a script's top level is now a
   * node of its own (`__main__`), because for most shell scripts it IS the
   * program, and it is what an invocation by path resolves to.
   */
  it('attributes a top-level command to the script body, not to a function', () => {
    const topLevel = analysis.edges.filter((e) => e.raw === 'deploy');
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0]?.callerId).toBe('scripts.deploy.__main__');
    expect(topLevel[0]?.calleeId).toBe('scripts.deploy.deploy');
    expect(topLevel[0]?.callType).toBe('internal_func');
  });

  it('gives every script a __main__ node spanning the file', () => {
    const main = fn('scripts.deploy.__main__');
    expect(main?.className).toBeNull();
    expect(main?.lineStart).toBe(1);
    expect(main?.signature).toBe('#!/bin/bash');
    // A file with no top-level command still gets one; sourcing it runs it.
    expect(fn('lib.util.__main__')).toBeDefined();
  });
});

/** Everything the upgrade to full fidelity added, on a second fixture. */
const MAIN_SH = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "\${SCRIPT_DIR}/lib/log.sh"
. ./lib/util.sh

trap 'cleanup' EXIT

cleanup() {
  log_info "bye"
}

function main {
  log_info "start"
  shared
  ./scripts/deploy.sh --force
  "$SCRIPT_DIR/scripts/deploy.sh"
  bash scripts/deploy.sh
  "$RUNNER" build
  git status
  cat <<'EOF'
not_a_call inside a heredoc
EOF
  (
    subshell_call
  )
}

main "$@"
`;

const LOG_SH = `log_info() {
  printf '%s\\n' "$1"
}

shared() {
  log_info "from log.sh"
}
`;

const UTIL_SH = `shared() {
  echo "a same-named function in a file that is NOT sourced first"
}
`;

const DEPLOY2_SH = `#!/bin/bash
echo deploying
`;

/** A `case` statement makes the pinned bash grammar's scanner throw. */
const CASEY_SH = `#!/bin/bash
pick() {
  case "$1" in
    a) echo one ;;
    *) echo other ;;
  esac
}
`;

describe('ShellAdapter — sourcing, script invocation and unparseable input', () => {
  let analysis: ModuleAnalysis;
  const adapter = new ShellAdapter();
  // lib/util.sh is analyzed BEFORE lib/log.sh on purpose: both define `shared`,
  // so the flat first-seen index would answer `lib.util.shared` and only the
  // source order can pick the right one.
  const files = ['main.sh', 'lib/util.sh', 'lib/log.sh', 'scripts/deploy.sh', 'casey.sh'];

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-shell2-'));
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'main.sh'), MAIN_SH);
    writeFileSync(join(root, 'lib', 'log.sh'), LOG_SH);
    writeFileSync(join(root, 'lib', 'util.sh'), UTIL_SH);
    writeFileSync(join(root, 'scripts', 'deploy.sh'), DEPLOY2_SH);
    writeFileSync(join(root, 'casey.sh'), CASEY_SH);
    analysis = await adapter.analyze(files, root);
  });

  const fn = (id: string) => analysis.functions.find((f) => f.id === id);
  const from = (caller: string) => analysis.edges.filter((e) => e.callerId === caller);
  const edge = (caller: string, callee: string) =>
    analysis.edges.find((e) => e.callerId === caller && e.calleeId === callee);

  it("makes a sourced script's functions internal", () => {
    expect(edge('main.main', 'lib.log.log_info')?.callType).toBe('internal_func');
    expect(edge('main.cleanup', 'lib.log.log_info')?.callType).toBe('internal_func');
  });

  it('resolves a source path written with an expansion', () => {
    // `source "${SCRIPT_DIR}/lib/log.sh"` — the expansion is dropped and the
    // literal tail matched against the scanned set.
    expect(fn('lib.log.log_info')).toBeDefined();
    expect(edge('main.main', 'lib.log.log_info')).toBeDefined();
  });

  it('prefers a sourced definition over another file that defines the same name', () => {
    // `shared` exists in both lib/log.sh and lib/util.sh; both are sourced, and
    // log.sh is sourced first, so it wins over the flat first-seen index.
    expect(edge('main.main', 'lib.log.shared')?.callType).toBe('internal_func');
    expect(edge('main.main', 'lib.util.shared')).toBeUndefined();
  });

  it('emits no edge for the source directive itself', () => {
    const raws = from('main.__main__').map((e) => e.raw);
    expect(raws).not.toContain('source');
    expect(raws).not.toContain('.');
  });

  it('treats a scanned script invoked by path as an internal call', () => {
    const byPath = from('main.main').filter((e) => e.calleeId === 'scripts.deploy.__main__');
    // `./scripts/deploy.sh`, `"$SCRIPT_DIR/scripts/deploy.sh"`, `bash scripts/deploy.sh`
    expect(byPath).toHaveLength(3);
    expect(byPath.every((e) => e.callType === 'internal_func')).toBe(true);
  });

  it('keeps an external binary at the boundary', () => {
    expect(edge('main.main', 'boundary:git')?.callType).toBe('boundary');
    expect(edge('main.main', 'boundary:cat')?.callType).toBe('boundary');
    expect(edge('main.__main__', 'boundary:set')?.callType).toBe('boundary');
  });

  it('leaves a command name that is only an expansion unresolved', () => {
    expect(edge('main.main', 'unresolved:"$RUNNER"')?.callType).toBe('unresolved');
  });

  it('does not read commands out of a heredoc body', () => {
    expect(from('main.main').map((e) => e.raw)).not.toContain('not_a_call');
  });

  it('still sees commands inside a subshell', () => {
    expect(edge('main.main', 'boundary:subshell_call')?.callType).toBe('boundary');
  });

  it('extracts both function-definition syntaxes in one file', () => {
    expect(fn('main.cleanup')).toBeDefined(); // `cleanup() { }`
    expect(fn('main.main')).toBeDefined(); // `function main { }`
  });

  it('drops a file the pinned grammar cannot parse, without losing the others', () => {
    // A `case` statement makes tree-sitter-bash's external scanner throw, which
    // would otherwise take down the whole run. The file contributes nothing.
    expect(fn('casey.pick')).toBeUndefined();
    expect(fn('casey.__main__')).toBeUndefined();
    expect(fn('main.main')).toBeDefined();
    expect(fn('scripts.deploy.__main__')).toBeDefined();
  });

  it('produces the whole fixture graph', () => {
    // 5 files in, 1 of them unparseable: 4 `__main__` nodes plus 5 functions.
    expect(analysis.functions).toHaveLength(9);
    expect(analysis.edges).toHaveLength(20);
  });

  it('produces exactly the callTypes it declares', () => {
    const produced = new Set<CallType>(analysis.edges.map((e) => e.callType));
    const declared = new Set<CallType>(adapter.capabilities.callTypes);
    expect([...produced].filter((t) => !declared.has(t)).sort()).toEqual([]);
    expect([...declared].filter((t) => !produced.has(t)).sort()).toEqual([]);
  });

  it('declares full fidelity with no invented capabilities', () => {
    expect(adapter.capabilities.tier).toBe('full');
    // There is no `self` in shell, and no statement spans are implemented.
    expect(adapter.capabilities.selfAttrs).toBe(false);
    expect(analysis.functions.every((f) => f.selfAttrsRead.length + f.selfAttrsWritten.length === 0)).toBe(
      true,
    );
    expect(adapter.capabilities.statementSpans).toBe(false);
    expect(adapter.statementSpans).toBeUndefined();
  });
});
