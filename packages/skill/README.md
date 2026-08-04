# @handbook/skill

Packages a rendered handbook directory as an agent SKILL — a self-contained, shareable folder with a `SKILL.md` navigation guide and a `references/` tree (overview, index, registers, per-stage pages, optional agent locator pages, optional coverage manifest) — and validates such packages for structural integrity and freshness against the live source. It sits after `@handbook/renderer` in the toolchain and produces the artifact that `@handbook/planner` mounts as its handbook.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Build the skill layout from a rendered handbook: `SKILL.md` plus `references/{overview.md,index.md,registers.md,stages/<sid>.md}`.
- Generate `SKILL.md` frontmatter and body that teach an agent when to use the skill and how to route (index → stage pages → registers → real source).
- Optionally package the agent locator pages: with `agentDir` pointing at a rendered agent site, `how_to_use.md` and `disambiguation.md` ship under `references/agent/` and the routing protocol gains a disambiguation step.
- Optionally localize the `SKILL.md` body and synthetic fallback prose (`lang: 'zh'`); the frontmatter always stays English (see Design notes).
- Optionally emit `references/coverage.json`: file → stage mapping with per-file SHA-256 content hashes for drift detection.
- Teach the consuming agent the **corrections protocol**: the `SKILL.md` body (both languages) instructs agents to report handbook ↔ source contradictions by appending JSON lines to `corrections.jsonl` at the skill root — never by editing `references/` themselves.
- Validate a skill directory: structure, frontmatter contract, index ↔ stage-page link consistency, coverage-hash freshness, and pending/malformed correction records.
- Does NOT embed source code — the skill is a location index that always points agents back to the real files.
- Does NOT call any LLM; both building and validation are deterministic.

## Public API

Build (`build.ts`):
- `buildSkill(options: BuildSkillOptions): BuildSkillResult` — assemble the skill package (the output directory is recreated from scratch; an existing `corrections.jsonl` at the output root is the one exception — it is preserved byte-for-byte, and the builder never creates it).
  - `BuildSkillOptions` — `{ handbookDir, outDir, name, project?, coverage?: { assignment, sourceRoot? }, agentDir?, lang? }`; `name` is the slug (skill name becomes `<slug>-handbook`), `project` the human name used in prose.
    - `agentDir?: string` — a rendered agent locator site. When it contains both `how_to_use.md` and `disambiguation.md`, they are copied to `references/agent/` and the SKILL.md routing protocol gains a step ("when a term is ambiguous, check `references/agent/disambiguation.md`"). Locator pages ship only as a pair, so SKILL.md never routes to a missing file. Omitted (or pages missing): output is byte-identical to a build without the option.
    - `lang?: 'en' | 'zh'` (default `'en'`) — language of the SKILL.md body and the synthetic no-registers fallback. The YAML frontmatter is never translated.
  - `BuildSkillResult` — `{ outDir, nStagePages, references }` (`references` lists `agent/*.md` entries when packaged).

Validate (`validate.ts`):
- `validateSkill(options: ValidateSkillOptions): ValidationResult` — check the package.
  - `ValidateSkillOptions` — `{ skillDir, sourceRoot? }`; passing `sourceRoot` re-hashes source files against `coverage.json` to detect stale or deleted entries.
  - `ValidationResult` — `{ ok, errors, warnings }`.

Validation checks include: `SKILL.md` exists with exactly `name` + `description` frontmatter, the name is a lowercase-hyphen slug, the description states both "Use when …" and "Do not use …", the body references `references/index.md` and directs agents to the actual source (English or Chinese phrasing); `overview.md`/`index.md`/`registers.md` and `stages/` exist; every stage page is linked from `index.md`; if `references/agent/` exists, present locator pages must be non-empty (error) and a missing half of the pair is a warning — skills without the directory validate clean; `coverage.json` has no duplicate paths and (with `sourceRoot`) no stale hashes or deleted files; if `corrections.jsonl` exists at the skill root, every non-blank line must be a JSON object with a non-empty `file` string (violations error with their line number) and N valid records warn `"N unprocessed correction(s) — resync with --corrections to fold them in"` — an absent file is silent.

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
  agentDir: '/path/to/out/agent',       // optional: ship the agent locator pages
  lang: 'zh',                           // optional: Chinese body, English frontmatter
});
console.log(result.nStagePages, result.references);

const check = validateSkill({ skillDir: result.outDir, sourceRoot: '/path/to/project' });
if (!check.ok) console.error(check.errors);
```

## Design notes

- Coverage hashes are drift signals, not enforcement: `coverage.json` records a SHA-256 per source file at build time, and `validateSkill` (or any consumer) can re-hash later to detect which handbook pages lag the code — the generated `SKILL.md` explicitly tells agents to treat stale hashes as freshness warnings.
- The frontmatter contract is validated hard (exact `name`+`description` keys, "Use when"/"Do not use" phrasing) because agent runtimes route on the description; a vague description silently breaks skill selection.
- The frontmatter stays English even with `lang: 'zh'` for the same reason: skill routing runs on the description text, and the validated "Use when …" / "Do not use …" phrasing is part of that routing surface — translating it would silently break skill selection over a perfectly good Chinese handbook. Only the body (routing protocol prose) and synthetic fallback pages are localized.
- Stage-page discovery supports two layouts — a nested `stages/` directory wins; otherwise every root-level `.md` that is not a known top-level page (`overview.md`, `index.md`, `register(s).md`, …) is a stage page, since stage ids are arbitrary. Discovery never recurses, so sub-sites (`agent/`, `html/`) carrying their own stage-page copies are never double-collected.
- The agent locator pages live in a `references/agent/` subdirectory (not at the `references/` root) so root-level stage-page discovery and the existing index ↔ stage-page checks are untouched; only the two locator pages are copied — the agent site's own `index.md` and stage-page copies never ship twice.
- Deliberately zero code embedding: validation requires the `SKILL.md` body to direct agents to the real source, keeping the skill honest as the codebase evolves.
- The corrections channel turns consuming agents into quality sensors. When an agent finds the handbook contradicting the real source ("the handbook says X is in file A; it is actually in B"), it appends one JSON line to `corrections.jsonl`: `{"file": "<repo-relative source path>", "page": "<references/… page>", "claim": "<what the handbook said>", "actual": "<what the source shows>", "notedAt": "<ISO timestamp>"}` — only `file` is required. The file lives at the **skill root**, deliberately not under `references/`: planners mount `references/` read-only, so the root is the only place a consuming agent can write. Lifecycle: the agent appends (creating the file on first write) → `validateSkill` warns about unprocessed records → a resync run consumes them to refresh exactly the named files → the batch is archived next to the skill as `corrections.<stamp>.applied.jsonl`, so records are never folded in twice. `buildSkill` never creates the file and never overwrites an existing one on rebuild.

## Dependencies

Internal:
- `@handbook/core` — file I/O helpers (`writeFileAtomic`, `writeJsonFile`, `listFilesRecursive`), `sha256Hex`, the `Assignment` type.

External: none.
