# @handbook/llm

The toolchain's single seam to any LLM. It defines the `ChatClient` interface, an `OpenAiChatClient` that talks to any OpenAI-compatible `/chat/completions` endpoint (hosted APIs, vLLM, proxies) with retry, rate limiting, and JSON extraction, a deterministic `MockChatClient` for offline tests, and a domain-agnostic actor–critic review loop that the pipeline's skeleton doctor builds on.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

## Responsibilities

- Define `ChatClient` — the one interface every LLM touchpoint in the toolchain goes through.
- Implement `OpenAiChatClient`: env-driven config, bounded concurrency, retries with backoff, request timeout, usage stats.
- Classify HTTP failures: permanent 4xx statuses fail fast; 408/429/5xx are retried; an HTML error page from a gateway is retried whatever its status.
- Treat an empty or mid-structure-truncated completion as a failure rather than an answer.
- Provide `MockChatClient` so entire pipeline runs can be scripted offline.
- Provide the actor–critic orchestration (`actorCriticLoop` and its prompt builders/parsers) with role-played critic panels.
- Does NOT contain any handbook-specific prompts — task context, evidence, and schemas are supplied by callers.
- Does NOT stream or manage multi-turn chat state; `complete` is single-turn by design.

## Public API

Client (`client.ts`):

- `ChatClient` — `{ complete(prompt, options?): Promise<ChatResult>; readonly model: string }`.
- `ChatOptions` — `{ temperature?, maxTokens? }`; `ChatResult` — `{ text, json, elapsedSec }`.
- `OpenAiChatClient` — `new OpenAiChatClient(options?: OpenAiChatClientOptions)`; `complete(...)`, `usage(): Readonly<LlmUsageStats>` (`calls`, `failures`, `totalElapsedSec`).
- `OpenAiChatClientOptions` — `{ config?, concurrency? (default 16), logger?, timeoutMs? (defaults to `OPENAI_TIMEOUT`), fetchImpl? }`. Pass `logger`: without one the client is silent, and retries, timeouts and gateway blocks become invisible.
- `resolveLlmEnv(env?)` / `LlmEnvConfig` — config from `OPENAI_API_KEY`/`OPENAI_MODEL`/`OPENAI_BASE_URL`/`OPENAI_MAX_TOKENS`/`OPENAI_TIMEOUT` (seconds, default 300)/`OPENAI_EXTRA_BODY` (JSON, vendor fields) with `HANDBOOK_LLM_*` fallbacks; `OPENAI_API_KEY=EMPTY` for keyless local endpoints.
- `extractAssistantText(payload)` — assistant text from the common OpenAI-compatible response shapes.
- `looksLikeGatewayPage(body)` — is this error body an edge/gateway HTML page rather than an API answer?

Mock (`mock.ts`):

- `MockChatClient` — `new MockChatClient(rules: MockRule[], fallback?)`; records every call in `calls: RecordedCall[]`.
- `MockRule` — `{ match: string | RegExp | (prompt) => boolean; respond: MockResponse }`; `MockResponse` — string, object (auto-fenced as JSON), or `(prompt, callIndex) => …`.

Actor–critic (`critic.ts`):

- `actorCriticLoop(client, actorPrompt, options): Promise<ActorCriticResult>` — one actor proposal reviewed by a parallel critic panel with bounded revision rounds.
- `ActorCriticOptions` — `{ roles?, taskContext, schemaHint?, evidence?, maxReviseRounds? (default 1), criticConcurrency?, temperature?, logger? }`.
- `ActorCriticResult` — `{ proposal, accepted, rounds, verdicts }`.
- `CriticRole` (`'engineer' | 'architect' | 'reader' | 'editor'`), `ROLE_PROMPTS` — role-play framings per failure mode.
- `CriticDecision` (`'APPROVE' | 'REVISE' | 'REJECT'`), `Verdict`, `parseVerdict(json, text?)` — verdict parsing with vacuous-REVISE normalization, alternative key names, and a narrow plain-text fallback (prose cannot vote).
- `buildCriticPrompt(args)` / `buildRevisePrompt(args)` — the review and revision prompt builders.

## Usage

```ts
import { OpenAiChatClient, MockChatClient, actorCriticLoop, type ChatClient } from '@handbook/llm';

const client: ChatClient = process.env.OPENAI_API_KEY
  ? new OpenAiChatClient({ concurrency: 8 })
  : new MockChatClient([{ match: 'summarize', respond: { summary: 'stub' } }]);

const result = await client.complete('Summarize this module as JSON: {"summary": "..."}', {
  temperature: 0,
});
console.log(result.json);

const review = await actorCriticLoop(client, 'Propose a title for the module. Return JSON.', {
  roles: ['engineer', 'reader'],
  taskContext: 'Module titling for a codebase handbook.',
  evidence: 'The module parses CLI flags.',
});
console.log(review.accepted, review.proposal);
```

## Design notes

- One seam, two implementations: everything downstream is written against `ChatClient`, so any OpenAI-compatible endpoint works in production and `MockChatClient` scripts whole pipeline runs in tests with zero network.
- Permanent-4xx fail-fast: statuses 400/401/403/404/405/410/422 throw `PermanentError`, which `retry` never re-attempts; 408/429/5xx are retried with linear backoff + jitter.
- Reasoning-model parameter switch: models matching `gpt-5|gpt-4.1|o[1-9]` get `max_completion_tokens` and no `temperature`, others get classic `max_tokens`/`temperature` — callers never need to care. Vendor-specific fields (e.g. a "disable thinking" switch) go through `OPENAI_EXTRA_BODY`; fields the client manages are protected.
- An empty completion is a retryable failure, not an empty answer — accepting one silently is how a run produces 90 blank cards while reporting success. A completion truncated at the token limit is refused only when structure was wanted and is broken; truncated PROSE is kept with a warning, since a paragraph missing its last clause beats a canned fallback.
- Budget growth is per CALL (capped at 2x) and bounded by a ceiling learned from a 400 about the token parameter, which is itself retryable — one truncated reply must not poison 16 concurrent workers.
- Every `ChatResult` carries a pre-extracted `json` field (via `extractJsonBlock`), so callers parse structured output without re-implementing fence/brace scanning.
- The critic loop is conservative by construction: a critic whose call or parse fails counts as REJECT, unanimous APPROVE is required for early acceptance, and a REVISE with no concerns is normalized to APPROVE because it gives the actor nothing actionable.

## Dependencies

Internal:

- `@handbook/core` — `PermanentError`, `retry`, `pLimit`, `mapLimit`, `extractJsonBlock`, `Logger`.

External: none — HTTP goes through the global `fetch` (injectable for tests).
