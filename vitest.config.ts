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
        // @handbook/cli used to sit at 22/22/21/20 with a note saying nothing
        // drove it. That is no longer true: the config-resolution, env-cascade
        // and broken-config-file paths are now covered in-process, and
        // `scripts/smoke-cli.sh` drives the built binary from the outside for
        // everything a unit test cannot see — exit codes, signals, real files.
        // Still the lowest floor in the workspace, because `main.ts` is mostly
        // commander wiring that only the smoke suite executes.
        'packages/cli/src/**': { statements: 65, branches: 68, functions: 75, lines: 64 },

        'packages/resync/src/**': { statements: 78, branches: 70, functions: 85, lines: 80 },
        // Ratcheted 2026-08-12 with the SSE backpressure work: measured
        // 89.64/77.39/93.46/91.96, so these sit the usual ~2 points under.
        'packages/studio/src/**': { statements: 87, branches: 75, functions: 92, lines: 90 },
        'packages/pipeline/src/**': { statements: 86, branches: 71, functions: 86, lines: 88 },
        'packages/analyzer/src/**': { statements: 85, branches: 72, functions: 94, lines: 89 },
        'packages/core/src/**': { statements: 90, branches: 83, functions: 92, lines: 91 },
        'packages/skill/src/**': { statements: 88, branches: 80, functions: 98, lines: 92 },
        'packages/patcher/src/**': { statements: 87, branches: 83, functions: 94, lines: 88 },
        'packages/planner/src/**': { statements: 93, branches: 87, functions: 92, lines: 93 },
        'packages/llm/src/**': { statements: 94, branches: 89, functions: 96, lines: 96 },
        'packages/renderer/src/**': { statements: 95, branches: 83, functions: 94, lines: 96 },
      },
    },
  },
});
