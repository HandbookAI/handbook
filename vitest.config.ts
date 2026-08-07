import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
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
      // Set roughly a point under the suite's measured coverage on 2026-08-07
      // (statements 83.27, branches 71.44, functions 86.33, lines 85.91), so
      // they ratchet: a change that drops coverage fails the gate, and a change
      // that raises it is expected to raise the floor with it. The gap absorbs
      // run-to-run variance in the analyzer's grammar-dependent paths, nothing
      // more — do not widen it to make a red run pass.
      thresholds: {
        statements: 82,
        branches: 70,
        functions: 85,
        lines: 84,
      },
    },
  },
});
