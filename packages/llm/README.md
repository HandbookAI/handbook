# @handbooks/llm

**English** · [中文](README.zh-CN.md)

> One small, honest client for any OpenAI-compatible endpoint — plus a disk cache, an
> offline mock, and the actor–critic loop the pipeline uses to make an LLM argue with
> itself until the answer holds up.

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fllm-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/llm)
[![deps](https://img.shields.io/badge/runtime%20deps-none-2dd4bf?style=flat-square)](#)

---

## What it is

Every LLM touchpoint in the [Handbook](../../README.md) toolchain goes through one tiny
interface:

```ts
interface ChatClient {
  readonly model: string;
  complete(prompt: string, options?: ChatOptions): Promise<ChatResult>;
}
```

That is the whole contract. Three implementations satisfy it:

| Implementation     | Use                                                                |
| ------------------ | ------------------------------------------------------------------ |
| `OpenAiChatClient` | Production. Any endpoint that speaks `/v1/chat/completions`.       |
| `CachedChatClient` | A decorator. Disk-backed, content-addressed — re-runs become free. |
| `MockChatClient`   | Tests and offline demos. Scripted rules, zero network.             |

Because the surface is this small, the entire pipeline is testable offline, and swapping
your endpoint is a URL change.

**No SDK dependency.** It is a thin `fetch` client — which is why it works against
endpoints that only implement 80% of the OpenAI API.

---

## Install

```bash
pnpm add @handbooks/llm
```

---

## Quick start

```ts
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const client = new OpenAiChatClient({ config: resolveLlmEnv(), concurrency: 16 });

const result = await client.complete('Summarize this module in one sentence: …', {
  temperature: 0,
  maxTokens: 400,
});

result.text; // the raw reply
result.json; // JSON parsed out of it, if there was any — see "JSON extraction"
```

### Configuration

`resolveLlmEnv()` reads the shared registry, so it accepts both the vendor names people
already have exported and the toolchain's own:

| Setting                 | Env (vendor alias first)                        | Default                                 |
| ----------------------- | ----------------------------------------------- | --------------------------------------- |
| API key                 | `OPENAI_API_KEY` · `HANDBOOK_LLM_API_KEY`       | — (`EMPTY` for keyless local endpoints) |
| Model                   | `OPENAI_MODEL` · `HANDBOOK_LLM_MODEL`           | `gpt-4o-mini`                           |
| Base URL                | `OPENAI_BASE_URL` · `HANDBOOK_LLM_BASE_URL`     | `https://api.openai.com/v1`             |
| Max output tokens       | `OPENAI_MAX_TOKENS` · `HANDBOOK_LLM_MAX_TOKENS` | `16000`                                 |
| Per-request timeout (s) | `OPENAI_TIMEOUT` · `HANDBOOK_LLM_TIMEOUT`       | `300`                                   |
| Retries                 | `HANDBOOK_LLM_MAX_RETRIES`                      | `6`                                     |
| Backoff base (s)        | `HANDBOOK_LLM_RETRY_BACKOFF`                    | `3`                                     |
| Concurrency cap         | `HANDBOOK_LLM_CONCURRENCY`                      | `16`                                    |
| Vendor extras           | `OPENAI_EXTRA_BODY` (JSON)                      | —                                       |

`llmConfigFromValues(values)` does the same job starting from an already-resolved config
object, which is how the CLI gets `--model` and `--base-url` into the client.

---

## What the client actually handles for you

- **Retries with exponential backoff and jitter** on transient failures, honouring
  `Retry-After` when the endpoint sends one. A `PermanentError` (a genuinely bad request)
  is never retried.
- **A global concurrency cap** across every call through one client — not per call site.
  Phase 2a can ask for 12 workers without any risk of 12 × N in-flight requests.
- **Per-request deadlines.** A stalled call is aborted and retried rather than allowed to
  hold a phase hostage forever.
- **Cooperative cancellation.** Pass an `AbortSignal`; an aborted call rejects with the
  signal's reason (an `AbortError`, never wrapped), aborts the in-flight HTTP request, and
  is never retried.
- **Reasoning-model quirks.** `temperature` is omitted automatically for models that
  reject it.
- **Gateway-page detection.** `looksLikeGatewayPage(body)` catches the case where a
  corporate proxy returns an HTML login page with a `200`, so you get _"your gateway
  returned HTML, not JSON"_ instead of a baffling parse error.
- **Token accounting.** `client.usage()` returns prompt/completion/total counts, which the
  pipeline writes into `run-manifest.json` so you can see what a run cost.

### JSON extraction

Models wrap JSON in prose, in fences, in explanations, or emit it with a trailing comma.
`ChatResult.json` is the result of a tolerant extraction pass that handles all of that —
and returns `undefined` rather than a wrong object when it genuinely cannot find one.
When it fails, `replyExcerpt` and `describeJsonShape` (from `@handbooks/core`) turn the
reply into a readable diagnostic instead of a wall of text.

---

## Caching

```ts
import { CachedChatClient } from '@handbooks/llm';

const cached = new CachedChatClient(client, '<work>/phase3/cache');
```

A decorator, so no phase knows a cache exists. The key covers **model, prompt and
options**, so switching models or changing the temperature never serves stale text. An
empty reply is never cached — a blank response pinned under a stable key would poison
every future run.

From the CLI: `handbook generate --llm-cache` (and `--refresh` to ignore caches).

---

## Offline mock

```ts
import { MockChatClient } from '@handbooks/llm';

const client = new MockChatClient(
  [
    { match: /Summarize this file/, respond: { purpose: 'Parses config', role: 'config' } },
    { match: (p) => p.includes('skeleton'), respond: (prompt, i) => `stage-${i}` },
  ],
  /* fallback */ '{}',
);

client.calls; // every recorded prompt, options and response
```

The first rule whose matcher accepts the prompt wins. Matchers can be a substring, a
regex, or a predicate; responses can be a string, an object, or a function of the prompt.
That is enough to script an entire pipeline run — which is exactly how the repo's tests
cover phases 2a → 3 without ever touching a network.

There is also a **mock HTTP endpoint** (`examples/mock-llm-server.mjs`) for testing the
real client end to end:

```bash
pnpm mock-llm    # → http://127.0.0.1:8099/v1
```

---

## Actor–critic orchestration

The interesting part. An **actor** proposes a structured change; one or more **critics**,
each role-played against a different failure mode, review it against ground-truth
evidence; then the actor gets one revision round to address the aggregated concerns.

```ts
import { actorCriticLoop, ROLE_PROMPTS } from '@handbooks/llm';

const result = await actorCriticLoop({
  client,
  actorPrompt,
  evidence, // ground truth the critics check against
  critics: ['engineer', 'architect', 'reader'],
  schemaHint: '{ "stages": [...] }',
});
```

| Critic      | Reviews for                                                                                |
| ----------- | ------------------------------------------------------------------------------------------ |
| `engineer`  | Does the proposal match what the code actually does? Are the referenced items real?        |
| `architect` | Structural problems — unclear boundaries, bloated stages, misplaced cross-cutting concerns |
| `reader`    | Is it _more readable_? Cohesive pages, intuitive titles, a narrative a newcomer can follow |
| `editor`    | Does the ordering within a section read as a story rather than a directory listing?        |

Each returns a `Verdict`: `APPROVE` / `REVISE` / `REJECT`, plus concerns, a suggested
revision and a rationale.

This module is deliberately **domain-agnostic** — the pipeline supplies the actor prompt,
the evidence block and the schema hint. It is what `handbook generate --synth-mode doctor`
runs under the hood.

---

## API

```ts
// client
class OpenAiChatClient implements ChatClient
resolveLlmEnv(env?): LlmEnvConfig
llmConfigFromValues(values): Partial<LlmEnvConfig>
looksLikeGatewayPage(body: string): boolean
extractAssistantText(payload: unknown): string | undefined

// cache & mock
class CachedChatClient implements ChatClient
class MockChatClient implements ChatClient

// actor–critic
actorCriticLoop(options): Promise<ActorCriticResult>
parseVerdict(json, text?): Verdict | undefined
buildCriticPrompt(args): string
buildRevisePrompt(args): string
ROLE_PROMPTS: Record<CriticRole, string>
```

---

## Testing

```bash
pnpm --filter @handbooks/llm test
```

The client is tested against a local HTTP server — retries, timeouts, rate limits,
aborts, gateway pages and malformed payloads all have real tests. **No test needs an API
key.**

---

Part of [Handbook](../../README.md) · [Prompt catalogue](../../docs/content/docs/reference/prompts.mdx) · MIT
