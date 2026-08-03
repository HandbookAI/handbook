/**
 * OpenAI-compatible chat client.
 *
 * Every LLM touchpoint in the toolchain goes through the {@link ChatClient}
 * interface so pipelines can be tested offline with {@link MockChatClient}
 * (see mock.ts) and any OpenAI-compatible endpoint (hosted, vLLM, a proxy…)
 * works in production via {@link OpenAiChatClient}.
 */
import {
  PermanentError,
  extractJsonBlock,
  pLimit,
  retry,
  type Logger,
  silentLogger,
  type LimitFn,
} from '@handbook/core';

export interface ChatOptions {
  /** Sampling temperature. Omitted automatically for reasoning-style models. */
  temperature?: number;
  /** Override the client's default max output tokens for this call. */
  maxTokens?: number;
}

export interface ChatResult {
  /** The assistant's raw text. */
  text: string;
  /** First JSON value found in the text, if any (fenced block or balanced scan). */
  json: unknown;
  /** Wall-clock seconds spent on the successful attempt. */
  elapsedSec: number;
}

/** The single seam between the toolchain and any LLM. */
export interface ChatClient {
  /** Single-turn completion. Rejects after retries are exhausted. */
  complete(prompt: string, options?: ChatOptions): Promise<ChatResult>;
  /** Model identifier, for logging and cache keys. */
  readonly model: string;
}

export interface LlmEnvConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxTokens: number;
  maxRetries: number;
  retryBackoffMs: number;
}

/**
 * Resolve client configuration from the standard OpenAI environment variables,
 * with `HANDBOOK_LLM_*` accepted as fallbacks:
 * `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`), `OPENAI_BASE_URL`
 * (default `https://api.openai.com/v1`), `OPENAI_MAX_TOKENS` (default 16000).
 * Use `OPENAI_API_KEY=EMPTY` for keyless local endpoints.
 */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const pick = (a: string, b: string, fallback: string): string => env[a] || env[b] || fallback;
  // Garbage numeric env values fall back to defaults instead of poisoning
  // requests (NaN max_tokens) or the retry loop (0/NaN attempts → throw undefined).
  const num = (raw: string, fallback: number, min: number): number => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= min ? value : fallback;
  };
  return {
    apiKey: pick('OPENAI_API_KEY', 'HANDBOOK_LLM_API_KEY', ''),
    model: pick('OPENAI_MODEL', 'HANDBOOK_LLM_MODEL', 'gpt-4o-mini'),
    baseUrl: pick('OPENAI_BASE_URL', 'HANDBOOK_LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    maxTokens: num(pick('OPENAI_MAX_TOKENS', 'HANDBOOK_LLM_MAX_TOKENS', '16000'), 16_000, 1),
    // 0 is a legitimate "no retries" request — clamp to 1 attempt, don't
    // silently replace it with the default.
    maxRetries: Math.max(1, num(env.HANDBOOK_LLM_MAX_RETRIES || '6', 6, 0)),
    retryBackoffMs: Math.round(num(env.HANDBOOK_LLM_RETRY_BACKOFF || '3', 3, 0) * 1000),
  };
}

export interface OpenAiChatClientOptions {
  config?: Partial<LlmEnvConfig>;
  /** Global cap on concurrent requests through this client. Default 16. */
  concurrency?: number;
  logger?: Logger;
  /** Request timeout in ms. Default 600_000. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** HTTP statuses that will never succeed on retry. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422]);

/**
 * Models that take `max_completion_tokens` and reject `temperature`.
 * (OpenAI's reasoning line; other vendors keep the classic parameters even when
 * they reason — those are detected from the RESPONSE instead, see `sawReasoning`.)
 */
const REASONING_MODEL_RE = /gpt-5|gpt-4\.1|o[1-9]/i;

/** Is this error body an edge/gateway HTML page rather than an API response? */
export function looksLikeGatewayPage(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml');
}

export interface LlmUsageStats {
  calls: number;
  failures: number;
  totalElapsedSec: number;
}

export class OpenAiChatClient implements ChatClient {
  readonly model: string;
  /**
   * True once a response carried `reasoning_content`. Reasoning tokens are
   * billed against the same budget as the answer, so a long prompt can consume
   * the whole allowance and come back with an EMPTY `content`. When that
   * happens we retry with a larger budget instead of silently accepting
   * nothing — the failure mode this closes produced 90 empty cards in a row.
   */
  private sawReasoning = false;
  /** True once a response was cut off at the token limit. */
  private sawTruncation = false;
  private readonly config: LlmEnvConfig;
  private readonly limit: LimitFn;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly stats: LlmUsageStats = { calls: 0, failures: 0, totalElapsedSec: 0 };

  constructor(options: OpenAiChatClientOptions = {}) {
    const env = resolveLlmEnv();
    this.config = { ...env, ...options.config };
    if (!this.config.apiKey) {
      throw new PermanentError(
        'no API key: set OPENAI_API_KEY (use OPENAI_API_KEY=EMPTY for a keyless local endpoint)',
      );
    }
    this.model = this.config.model;
    this.limit = pLimit(options.concurrency ?? 16);
    this.logger = options.logger ?? silentLogger;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  usage(): Readonly<LlmUsageStats> {
    return { ...this.stats };
  }

  async complete(prompt: string, options: ChatOptions = {}): Promise<ChatResult> {
    return this.limit(() =>
      retry(
        async (attempt) => {
          const startedAt = Date.now();
          const text = await this.request(prompt, options, attempt);
          const elapsedSec = (Date.now() - startedAt) / 1000;
          this.stats.calls += 1;
          this.stats.totalElapsedSec += elapsedSec;
          return { text, json: extractJsonBlock(text), elapsedSec };
        },
        {
          attempts: this.config.maxRetries,
          backoffMs: this.config.retryBackoffMs,
          onRetry: (error, attempt) => {
            this.stats.failures += 1;
            this.logger.warn(`LLM call failed (attempt ${attempt}): ${String(error)}`);
          },
        },
      ),
    );
  }

  private async request(prompt: string, options: ChatOptions, attempt = 1): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    };
    // A reasoning endpoint spends part of the budget thinking, so give a retry
    // more room rather than asking the same impossible question again.
    const growth = this.sawReasoning || this.sawTruncation ? Math.min(4, attempt) : 1;
    const maxTokens = Math.min(200_000, (options.maxTokens ?? this.config.maxTokens) * growth);
    if (REASONING_MODEL_RE.test(this.model)) {
      body.max_completion_tokens = maxTokens; // reasoning models also reject `temperature`
    } else {
      body.max_tokens = maxTokens;
      if (options.temperature !== undefined) body.temperature = options.temperature;
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body.slice(0, 300);
      const message = `LLM endpoint returned ${response.status}: ${detail}`;
      // An HTML body means the API never saw the request — a gateway, WAF or
      // load balancer answered instead. Its verdict says nothing permanent
      // about the request, so retry it even on a normally-permanent status.
      if (PERMANENT_STATUSES.has(response.status) && !looksLikeGatewayPage(body)) {
        throw new PermanentError(message);
      }
      throw new Error(message); // 408/429/5xx, and any edge-served page → retryable
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const choice = ((payload.choices as Array<Record<string, any>> | undefined) ?? [])[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      this.sawReasoning = true;
    }
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
    const text = extractAssistantText(payload);
    if (text === undefined) throw new Error('LLM response had no assistant text');
    if (finishReason === 'length' && text.trim() !== '') {
      // A completion cut off at the token limit is a PARTIAL answer: its JSON
      // will not parse and its prose stops mid-sentence. Treated as success it
      // becomes silently missing output, so fail and retry with more room.
      this.sawTruncation = true;
      throw new Error(
        `LLM response was truncated at the token limit (max_tokens=${maxTokens}, ${text.length} chars) — ` +
          'raise OPENAI_MAX_TOKENS if this persists',
      );
    }
    if (text.trim() === '') {
      // Empty content is a FAILURE, not an empty answer: accepting it silently
      // is how a whole run ends up with blank cards.
      const usage = (payload.usage ?? {}) as Record<string, any>;
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
      const hint = this.sawReasoning
        ? ` — the model spent its budget on reasoning${
            reasoningTokens ? ` (${String(reasoningTokens)} reasoning tokens)` : ''
          }; raise OPENAI_MAX_TOKENS or pick a non-reasoning model`
        : '';
      throw new Error(`LLM returned empty content (finish_reason=${finishReason}, max_tokens=${maxTokens})${hint}`);
    }
    return text;
  }
}

/** Pull the assistant text out of the common OpenAI-compatible response shapes. */
export function extractAssistantText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, any>;
  const candidates = [
    p.choices?.[0]?.message?.content,
    p.data?.choices?.[0]?.message?.content,
    p.data?.response,
    p.response,
    p.result?.content,
    p.data?.content,
    p.text,
  ];
  const hit = candidates.find((c) => typeof c === 'string');
  return hit as string | undefined;
}
