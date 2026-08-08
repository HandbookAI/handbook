import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Lints the whole repo (`eslint .`), not just packages/*/src. Root configs,
// build scripts and the example server used to sit outside every glob.
export default tseslint.config(
  {
    // Global ignores. Anything generated, vendored, or run-local.
    // The docs site is a separate Next.js app with its own toolchain (React,
    // JSX, Tailwind) and its own lint step; linting it with the library config
    // reports nothing but false positives.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      'examples/work/**',
      'work/**',
      'runs/**',
      'docs/**',
    ],
  },

  // TypeScript sources — the packages, plus root config files.
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Plain JavaScript: eslint.config.js, scripts/*.mjs, examples/*.mjs. These run
  // on Node with no type checker in front of them, so the base rules — and
  // no-undef in particular — are the only thing catching a typo'd global.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // The analyzer's fixture repo is sample source for the parser, not our code.
  {
    ignores: ['examples/demo-project/**'],
  },
);
