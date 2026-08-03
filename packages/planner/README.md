# @handbook/planner

A handbook-guided, read-only planning agent. Given a natural-language change request, it routes through a mounted handbook (or skill `references/` directory) to find the sites in scope, reads the real source through a sandboxed tool belt, and emits a precise, self-contained edit plan — verbatim old/new edit blocks plus a machine-readable declarations JSON that `@handbook/resync` later uses to scope its update. It plans; it never edits.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Run the agent loop (`runPlanner`): route with the handbook, read real source, emit the plan within a turn budget.
- Provide the read-only tool belt (`ReadOnlyTools`): `list_dir`, `read_file` (line-ranged, numbered), `grep` — all confined to a sandbox root.
- Own the planner prompt (`buildPlannerSystemPrompt`, `TOOL_PROTOCOL`) including the exact EDIT-block format a mechanical executor relies on.
- Parse the final declarations JSON (`parseDeclarations`) into `{ willModify, willAdd, willRemove }`.
- Does NOT write, edit, or execute anything — its only output is text; path escapes from the sandbox are rejected.
- Does NOT require a function-calling API — any plain-text `ChatClient` endpoint works.

## Public API

Planner (`planner.ts`):
- `runPlanner(options: PlannerOptions): Promise<PlannerResult>` — the agent loop.
  - `PlannerOptions` — `{ client, sourceRoot, handbookDir?, request, promptVars?, maxTurns? (default 30), logger? }`.
  - `PlannerResult` — `{ plan, declarations?, turns, trace }` (`trace` is one line per tool call).
- `Declarations` — `{ willModify: string[], willAdd: string[], willRemove: string[] }`.
- `parseDeclarations(plan): Declarations | undefined` — last ` ```json ` block with `will_modify`/`will_add`/`will_remove` keys.
- `handbookDirFromSkill(skillDir)` — mount a skill's `references/` directory as the planner handbook.

Tools (`tools.ts`):
- `ReadOnlyTools` — `new ReadOnlyTools(root)`; `listDir(relPath?)`, `readFile(relPath, startLine?, endLine?)`, `grep(pattern, dirOrFile?)`, each returning `ToolResult` (`{ ok, content }`). Reads are capped (60k chars, 100 grep hits, 5 MB file limit) and `.git`/build dirs are skipped.

Prompt (`prompt.ts`):
- `buildPlannerSystemPrompt(vars: PlannerPromptVars)` — the planning rules: route with the handbook, read real source, emit byte-exact EDIT blocks and declarations.
- `PlannerPromptVars` / `DEFAULT_PROMPT_VARS` — project-specific substitutions (`projectIntro`, `pathExample`, `whereExample`, `qualnameNote`, `declExample`).
- `TOOL_PROTOCOL` — the JSON-action protocol appended to the system prompt (`list_dir` / `read_file` / `grep` / `finish`).

## Usage

```ts
import { runPlanner, handbookDirFromSkill } from '@handbook/planner';
import { OpenAiChatClient } from '@handbook/llm';

const result = await runPlanner({
  client: new OpenAiChatClient(),
  sourceRoot: '/path/to/project',
  handbookDir: handbookDirFromSkill('/path/to/skills/myproject'),
  request: 'Rename the retry backoff env var and update every read site.',
  maxTurns: 30,
});

console.log(result.plan);          // summary + EDIT blocks + declarations JSON
console.log(result.declarations); // { willModify, willAdd, willRemove }
console.log(result.trace);        // e.g. ['read_file(__handbook__/index.md)', 'grep(BACKOFF)']
```

## Design notes

- Single-turn transcript protocol: the whole transcript is re-sent each turn as one prompt and the model answers with exactly one JSON action block, so the planner works against ANY OpenAI-compatible endpoint (no function-calling API) and is trivially scriptable with `MockChatClient`.
- Read-only sandbox: every path is resolved inside the tool root and escape attempts throw; the handbook is mounted under a virtual `__handbook__/` prefix with its own separate sandbox, so the agent can never confuse handbook pages with source files.
- The handbook and the source have distinct roles baked into the prompt: the handbook is a location index that decides WHICH sites are in scope (surfacing scattered/mirror sites plain search misses); the real source is the only ground truth for WHAT to change — every edit's old text must be copied verbatim from a `read_file` result.
- Graceful degradation at the edges: prose replies containing `### EDIT` are accepted as the plan, the final turn forces a `finish`, and oversized tool results are truncated with a hint to narrow the range.

## Dependencies

Internal:
- `@handbook/core` — `listFilesRecursive`, `toPosix`, `truncate`, `Logger`.
- `@handbook/llm` — the `ChatClient` seam the agent loop drives.

External: none.
