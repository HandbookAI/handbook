# @handbook/skill

Packages a rendered handbook directory as an agent SKILL — a self-contained, shareable folder with a `SKILL.md` navigation guide and a `references/` tree (overview, index, registers, per-stage pages, optional coverage manifest) — and validates such packages for structural integrity and freshness against the live source. It sits after `@handbook/renderer` in the toolchain and produces the artifact that `@handbook/planner` mounts as its handbook.

## Responsibilities

- Build the skill layout from a rendered handbook: `SKILL.md` plus `references/{overview.md,index.md,registers.md,stages/<sid>.md}`.
- Generate `SKILL.md` frontmatter and body that teach an agent when to use the skill and how to route (index → stage pages → registers → real source).
- Optionally emit `references/coverage.json`: file → stage mapping with per-file SHA-256 content hashes for drift detection.
- Validate a skill directory: structure, frontmatter contract, index ↔ stage-page link consistency, and coverage-hash freshness.
- Does NOT embed source code — the skill is a location index that always points agents back to the real files.
- Does NOT call any LLM; both building and validation are deterministic.

## Public API

Build (`build.ts`):
- `buildSkill(options: BuildSkillOptions): BuildSkillResult` — assemble the skill package (the output directory is recreated from scratch).
  - `BuildSkillOptions` — `{ handbookDir, outDir, name, project?, coverage?: { assignment, sourceRoot? } }`; `name` is the slug (skill name becomes `<slug>-handbook`), `project` the human name used in prose.
  - `BuildSkillResult` — `{ outDir, nStagePages, references }`.

Validate (`validate.ts`):
- `validateSkill(options: ValidateSkillOptions): ValidationResult` — check the package.
  - `ValidateSkillOptions` — `{ skillDir, sourceRoot? }`; passing `sourceRoot` re-hashes source files against `coverage.json` to detect stale or deleted entries.
  - `ValidationResult` — `{ ok, errors, warnings }`.

Validation checks include: `SKILL.md` exists with exactly `name` + `description` frontmatter, the name is a lowercase-hyphen slug, the description states both "Use when …" and "Do not use …", the body references `references/index.md` and directs agents to the actual source; `overview.md`/`index.md`/`registers.md` and `stages/` exist; every stage page is linked from `index.md`; `coverage.json` has no duplicate paths and (with `sourceRoot`) no stale hashes or deleted files.

## Usage

```ts
import { buildSkill, validateSkill } from '@handbook/skill';
import { WorkDir } from '@handbook/pipeline';

const work = new WorkDir('/path/to/work');
const result = buildSkill({
  handbookDir: '/path/to/out',          // rendered markdown handbook
  outDir: '/path/to/skills/myproject',
  name: 'myproject',
  project: 'MyProject',
  coverage: { assignment: work.loadAssignment(), sourceRoot: '/path/to/project' },
});
console.log(result.nStagePages, result.references);

const check = validateSkill({ skillDir: result.outDir, sourceRoot: '/path/to/project' });
if (!check.ok) console.error(check.errors);
```

## Design notes

- Coverage hashes are drift signals, not enforcement: `coverage.json` records a SHA-256 per source file at build time, and `validateSkill` (or any consumer) can re-hash later to detect which handbook pages lag the code — the generated `SKILL.md` explicitly tells agents to treat stale hashes as freshness warnings.
- The frontmatter contract is validated hard (exact `name`+`description` keys, "Use when"/"Do not use" phrasing) because agent runtimes route on the description; a vague description silently breaks skill selection.
- Stage-page discovery supports two layouts — a nested `stages/` directory wins; otherwise flat root-level `<sid>.md` files are matched by pattern without recursing, so sub-sites (`agent/`, `html/`) carrying their own stage-page copies are never double-collected.
- Deliberately zero code embedding: validation requires the `SKILL.md` body to direct agents to the real source, keeping the skill honest as the codebase evolves.

## Dependencies

Internal:
- `@handbook/core` — file I/O helpers (`writeFileAtomic`, `writeJsonFile`, `listFilesRecursive`), `sha256Hex`, the `Assignment` type.

External: none.
