// The history is already Conventional Commits — `feat(analyzer): ...`,
// `docs(internal): ...`, `fix(studio): ...`. This makes that a rule instead of
// a habit, which is also what lets changesets and the changelog stay coherent.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The scopes that exist: the eleven packages plus the repo-level areas.
    'scope-enum': [
      2,
      'always',
      [
        'analyzer',
        'cli',
        'core',
        'llm',
        'patcher',
        'pipeline',
        'planner',
        'renderer',
        'resync',
        'skill',
        'studio',
        'ci',
        'deps',
        'docs',
        'examples',
        'internal',
        'repo',
        'spec',
        'deck',
      ],
    ],
    // A comma-separated scope list (`feat(core,pipeline): ...`) is already used
    // for changes that genuinely span packages; keep it legal.
    'scope-case': [0],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'body-max-line-length': [1, 'always', 110],
  },
};
