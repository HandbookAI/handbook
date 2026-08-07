import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `@handbook/*` to each package's TypeScript source for the test run.
 *
 * Without this, a cross-package import resolves through the workspace symlink
 * into `dist`, and coverage attributes nothing back to `src` — so any code
 * consumed across a package boundary reads as untested even while the suite
 * exercises it heavily. `core/src/util/hash.ts` measured 0% that way despite
 * being called from the pipeline and the analyzer on every run, which makes a
 * per-package coverage floor meaningless.
 *
 * The build is still verified: `tsc -b` typechecks the real emit, and
 * `scripts/smoke-install.mjs` installs the packed tarballs with plain npm and
 * drives the CLI, which is a stronger check on dist than a unit test was.
 */
const workspaceAliases = Object.fromEntries(
  readdirSync(join(ROOT, 'packages'))
    .filter((name) => statSync(join(ROOT, 'packages', name)).isDirectory())
    .map((name) => [`@handbook/${name}`, join(ROOT, 'packages', name, 'src', 'index.ts')]),
);

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // tree-sitter-swift ABORTS the process (`Fatal process out of memory: Zone`,
    // exit 133) once V8 >= 13 tiers the wasm module up — measured fatal 5/5 on
    // Node 24, fine on Node 21, and unique to that one grammar among nineteen.
    // Liftoff-only compilation skips the tier-up, so the Swift tests can run for
    // real instead of being skipped. The adapter itself refuses at discovery on
    // an unflagged runtime, so production never hits the abort either.
    execArgv: ['--liftoff-only'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Report on every source file, not just the ones a test happened to
      // import — an untested module scoring 0% is the number worth seeing.
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.test-helper.ts',
        // Barrel files: re-exports only, no behaviour to cover.
        'packages/*/src/index.ts',
      ],
      // Floors sit roughly two points under what each package measured on
      // 2026-08-07, so they ratchet: a change that drops coverage fails the
      // gate, and a change that raises it is expected to raise the floor with
      // it. The gap absorbs run-to-run variance in the grammar-dependent
      // analyzer paths — do not widen it to make a red run pass.
      //
      // Per package, not just globally, because a single repo-wide number hides
      // exactly what matters: at 86% overall, @handbook/cli sits at 23%.
      // A global floor would let any one package rot to nothing unnoticed.
      thresholds: {
        // @handbook/cli is the product's entry point and is barely tested:
        // src/main.ts is 94 statements at 0%, because nothing imports the CLI
        // and no test drives it. `scripts/smoke-install.mjs` covers it from the
        // outside, which is why this is a low floor rather than a failing gate,
        // but the floor is deliberately honest about the hole. Raise it.
        'packages/cli/src/**': { statements: 22, branches: 22, functions: 21, lines: 20 },

        'packages/resync/src/**': { statements: 78, branches: 70, functions: 85, lines: 80 },
        'packages/studio/src/**': { statements: 81, branches: 69, functions: 87, lines: 83 },
        'packages/pipeline/src/**': { statements: 81, branches: 68, functions: 84, lines: 83 },
        'packages/analyzer/src/**': { statements: 84, branches: 70, functions: 94, lines: 89 },
        'packages/core/src/**': { statements: 84, branches: 78, functions: 81, lines: 86 },
        'packages/skill/src/**': { statements: 86, branches: 77, functions: 98, lines: 89 },
        'packages/patcher/src/**': { statements: 86, branches: 82, functions: 94, lines: 88 },
        'packages/planner/src/**': { statements: 93, branches: 87, functions: 92, lines: 93 },
        'packages/llm/src/**': { statements: 93, branches: 89, functions: 96, lines: 96 },
        'packages/renderer/src/**': { statements: 94, branches: 78, functions: 94, lines: 96 },
      },
    },
  },
});
