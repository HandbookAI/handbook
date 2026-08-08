# @handbook/planner

**English** · [中文](README.zh-CN.md)

> A read-only agent that routes with the handbook, reads the real source, and emits an
> edit plan precise enough to apply mechanically. It cannot write a single byte.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fplanner-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbook/planner)
[![read-only](https://img.shields.io/badge/filesystem-read--only-2dd4bf?style=flat-square)](#the-tool-belt)

---

## What it is

Give it a natural-language change request and a handbook. It runs an agent loop —
list, read, grep — until it knows enough, then produces a plan:

```
"Retry failed uploads three times"
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  route with the handbook  → WHICH files      │
  │  read the real source     → WHAT to change   │
  │  verify anchors           → byte-exact text  │
  └─────────────────────────────────────────────┘
        │
        ▼
  plan.md  →  handbook apply
```

Two artifacts, two distinct roles, and the prompt is explicit about it:

- **The handbook** is a pure **location index**. It surfaces the scattered, non-obvious
  sites a plain text search misses — mirror implementations, every read and write of a
  piece of state, cross-subsystem touch points.
- **The real source** is ground truth for **what** to change. The handbook gives the
  address; the code at that address gives the bytes.

---

## Install

```bash
pnpm add @handbook/planner
```

---

## Quick start

```ts
import { runPlanner, handbookDirFromSkill } from '@handbook/planner';
import { OpenAiChatClient, resolveLlmEnv } from '@handbook/llm';

const result = await runPlanner({
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  sourceRoot: '/path/to/repo',
  handbookDir: handbookDirFromSkill('skills/myrepo'), // → skills/myrepo/references
  request: 'Retry failed uploads three times before giving up',
  maxTurns: 30,
});

result.plan; // the markdown plan
result.declarations; // { willModify, willAdd, willRemove }
result.turns; // how many turns it took
result.trace; // one line per tool call
result.aborted; // 'fabrication' | 'turn-limit' | 'no-plan' — MUST be treated as failure
```

From the CLI:

```bash
handbook plan --source /path/to/repo --handbook skills/myrepo/references \
    --request "Retry failed uploads three times before giving up" \
    --out plan.md
```

---

## The plan format

````markdown
### EDIT 1

- file: `src/upload.py`
- where: `Uploader.send (~88)` — wrap the request in the retry helper

```old
    response = self._client.put(url, data)
```

```new
    response = self._retry(lambda: self._client.put(url, data), attempts=3)
```

### EDIT 2

- file: `src/upload.py`
- where: `Uploader` — add the helper

```old
    def send(self, url, data):
```

```new
    def _retry(self, call, attempts):
        last = None
        for _ in range(attempts):
            try:
                return call()
            except TransientError as exc:
                last = exc
        raise last

    def send(self, url, data):
```

Both sites now share one retry policy.

```json
{ "will_modify": ["Uploader.send"], "will_add": ["Uploader._retry"], "will_remove": [] }
```
````

- `old` must be **byte-exact** and appear **exactly once** in the file. An empty `old`
  means "create this file".
- Edits are numbered and must **ascend**, top to bottom.
- The trailing `json` block is the machine-readable declarations, consumed by `resync` to
  sharpen its refresh scope.

`@handbook/patcher` executes this format. It is deliberately hostile to ambiguity — see
that package's README for exactly what it refuses and why.

---

## The tool belt

```ts
class ReadOnlyTools {
  listDir(path): ToolResult;
  readFile(path, startLine?, endLine?): ToolResult;
  grep(pattern, path): ToolResult;
}
```

**There is no write tool.** Not disabled — not implemented. The planner's output is a
plan; something else decides whether to apply it.

Everything else is a sandbox rule:

- Every path resolves inside the sandbox root; escapes — including through symlinks —
  are rejected.
- The handbook is mounted read-only at `__handbook__/`, a separate sandbox from the source.
- Reads cap at 60,000 characters; grep caps at 100 hits and skips files over 5 MB.
- **Catastrophic regexes are refused.** A pattern with an unbounded quantifier applied to
  a group that itself contains one (`(a+)+`, `(.*)*`, `(\d+){2,}`) turns one long line
  into a multi-hour hang. `hasNestedUnboundedQuantifier` catches those and returns a
  graceful tool error instead of freezing the run. Character classes and escaped
  metacharacters are skipped, so `[+*]` and `\+` are not misread.

---

## Why the loop is built the way it is

The planner uses a **plain single-turn `ChatClient`** — the whole transcript is re-sent
each turn as one prompt. No function-calling API required, so it works against _any_
OpenAI-compatible endpoint, and it is trivially scriptable with `MockChatClient` in tests.

Four hard-won behaviours, each of which exists because the naive version failed in
production:

### 1. Fabricated tool results are rejected outright

A reply that writes the harness's own `## Tool result` heading has **invented file
contents and is reasoning on top of them**. One observed reply contained thirteen
fabricated results and a plan built from a line that does not exist in the file.

The planner refuses it — not even the plan at the end of it, because that plan was derived
from fiction. It pushes back and asks again, and gives up after three such replies with
`aborted: 'fabrication'`.

### 2. The reminder goes _last_, not in the system prompt

If the last thing the model reads is a tool result, that is the shape it starts imitating
— generating tens of thousands of characters of invented conversation until it hits the
token cap. Repeating the instruction after the transcript every turn fixes it.

### 3. A run that gave up exits non-zero

Returning an apology as `plan` with no `aborted` flag reports an abandoned run as a
success — and a script would then feed that apology straight into `apply`. So:

| Situation                              | `aborted`       |
| -------------------------------------- | --------------- |
| Kept inventing tool results            | `'fabrication'` |
| Hit the turn limit with no EDIT blocks | `'turn-limit'`  |
| Called `finish` with nothing usable    | `'no-plan'`     |

The CLI turns any of these into a non-zero exit.

### 4. One dangling fence is repaired; anything else is refused

A complete, correct two-edit plan was once refused wholesale because the trailing
declarations block was missing its closing ` ``` `. The executor's strictness must
not be relaxed — a tolerated unclosed fence is how a truncated anchor once slipped
through — so the slip is repaired _here_, where we can see it is a delimiter and not
content: **only one fence may be open, and only at end of text.** Anything else is left
for the executor to refuse.

Other guards: tool arguments come straight from model JSON, so a non-string `path` is a
graceful tool error rather than a `TypeError` that rejects the whole run; and a prose
reply containing EDIT blocks _is_ the plan, even if some fenced JSON inside it happens to
parse as an action.

---

## API

```ts
runPlanner(options: PlannerOptions): Promise<PlannerResult>
handbookDirFromSkill(skillDir: string): string
parseDeclarations(plan: string): Declarations | undefined
closeDanglingFence(plan: string): { plan: string; repaired: boolean }
buildPlannerSystemPrompt(vars: PlannerPromptVars): string
class ReadOnlyTools
hasNestedUnboundedQuantifier(src: string): boolean
DEFAULT_PROMPT_VARS, TOOL_PROTOCOL
```

The prompt is parameterized (`projectIntro`, `pathExample`, `whereExample`,
`qualnameNote`, `declExample`), so you can teach it your codebase's idiom for qualified
names without forking the prompt.

---

## Testing

```bash
pnpm --filter @handbook/planner test
```

Every failure path has a scripted test: fabricated results, malformed actions, non-string
tool arguments, turn-limit exhaustion, unclosed fences, sandbox escape attempts and
catastrophic regexes.

---

Part of [Handbook](../../README.md) · [Prompt catalogue](../../docs/content/docs/reference/prompts.mdx) ·
[`@handbook/patcher`](../patcher/README.md) applies what this produces · MIT
