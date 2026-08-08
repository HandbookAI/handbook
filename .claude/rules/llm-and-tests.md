---
description: How LLM-touching code is fenced, and why every test in this repo runs offline.
paths:
  - packages/llm/**
  - packages/pipeline/**
  - packages/planner/**
  - packages/resync/**
  - '**/*.test.ts'
---

# LLM code and tests

**One seam.** Every LLM call in this repo goes through:

```ts
interface ChatClient {
  readonly model: string;
  complete(prompt: string, options?: ChatOptions): Promise<ChatResult>;
}
```

Do not add a second way to reach a model. `analyzer`, `renderer`, `skill` and `patcher`
**do not depend on `@handbook/llm` at all**, and that boundary is what makes `render`,
`skill`, `validate`, `apply` and `rollback` free to run in CI.

**No test needs an API key. Ever.** LLM-dependent flows are tested against
`MockChatClient` (a list of rules, first match wins); the real client is tested against a
local HTTP server. If a change would make a test need a key, the change is wrong.

**Test the failure paths, not just the happy one.** This codebase's value is in what it
refuses to do, so the tests that matter cover: unparseable replies, partial batches,
each degradation tier, mid-run aborts, resume, sandbox escapes, ambiguous anchors,
catastrophic regexes, and every parser rejection.

**Degrade, never block.** Organization falls back to call-graph order. Narration falls
back to the stage description. Register extraction failure yields an empty list. A card
that could not be written is empty and listed in `_coverage.json` — it is never dropped
and never invented.

**A run that gave up must exit non-zero.** Returning an apology as a result reports an
abandoned run as a success, and something downstream will act on it.

**Coverage floors are per package and ratchet.** Raising a floor when your change raises
coverage is expected. Lowering one to make a red run green is not.
