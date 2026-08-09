/**
 * Wire formats for endpoints that are NOT OpenAI-compatible.
 *
 * Everything hard about talking to a model — retry with backoff, per-request
 * deadlines, cancellation that tears down in flight, permanent-vs-retryable
 * classification, gateway-page detection, token-budget learning, usage
 * metering — is provider-independent and already lives in `OpenAiChatClient`.
 * Duplicating it per provider is how three clients end up with three different
 * retry bugs.
 *
 * So a provider supplies only the three things that genuinely differ:
 *
 *   1. the URL and headers,
 *   2. how a prompt becomes a request body,
 *   3. how a response becomes text and a token count.
 *
 * Everything else is shared. Adding a provider is this file plus one registry
 * choice — not another client.
 */
import type { LlmEnvConfig } from './client.js';

/** What a provider must answer for one request. */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** What a provider reads back out of a successful response. */
export interface ProviderReply {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** True when the reply was cut off by the token budget rather than finished. */
  truncated: boolean;
}

export interface Provider {
  readonly id: string;
  /** Build the request. `maxTokens` is already clamped to the learned ceiling. */
  request(input: {
    config: LlmEnvConfig;
    model: string;
    prompt: string;
    maxTokens: number;
    temperature?: number;
  }): ProviderRequest;
  /** Read a successful response body. Returning empty text is treated as a failure upstream. */
  reply(payload: Record<string, unknown>): ProviderReply;
}

/** A number from a usage field; anything else is zero, never NaN. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Anthropic's Messages API.
 *
 * Differences that matter: the key is `x-api-key` rather than a bearer token,
 * `anthropic-version` is mandatory, `max_tokens` is required rather than
 * optional, the system prompt is a top-level field rather than a message, and
 * the reply is a list of content blocks of which only the text ones count.
 */
export const anthropicProvider: Provider = {
  id: 'anthropic',
  request({ config, model, prompt, maxTokens, temperature }) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };
    if (temperature !== undefined) body.temperature = temperature;
    Object.assign(body, config.extraBody);
    return {
      // The configured base URL is honoured as given so a gateway or proxy
      // still works; only the path is ours.
      url: `${config.baseUrl.replace(/\/+$/, '')}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey,
        // Required by the API. Pinned rather than tracked: a version this code
        // was not written against can change the reply shape underneath it.
        'anthropic-version': '2023-06-01',
      },
      body,
    };
  },
  reply(payload) {
    const blocks = Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
    // Only text blocks. A `thinking` or `tool_use` block is not the answer, and
    // concatenating it would put the model's scratchpad into the handbook.
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    return {
      text,
      promptTokens: count(usage.input_tokens),
      completionTokens: count(usage.output_tokens),
      truncated: payload.stop_reason === 'max_tokens',
    };
  },
};

/**
 * Google's Gemini `generateContent`.
 *
 * Differences that matter: the model is in the PATH rather than the body, the
 * key is a header (`x-goog-api-key` — not the query string, which lands in
 * access logs), generation settings live under `generationConfig`, and a reply
 * can come back with no candidate at all when a safety filter fires, which is
 * a refusal rather than an empty answer and must not read as one.
 */
export const geminiProvider: Provider = {
  id: 'gemini',
  request({ config, model, prompt, maxTokens, temperature }) {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
    if (temperature !== undefined) generationConfig.temperature = temperature;
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    };
    Object.assign(body, config.extraBody);
    return {
      url: `${config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`,
      headers: {
        'content-type': 'application/json',
        // A header, never `?key=` — a query string is written to every proxy
        // and access log between here and Google.
        'x-goog-api-key': config.apiKey,
      },
      body,
    };
  },
  reply(payload) {
    const candidates = Array.isArray(payload.candidates)
      ? (payload.candidates as Array<Record<string, unknown>>)
      : [];
    const first = candidates[0] ?? {};
    const content = (first.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? (content.parts as Array<Record<string, unknown>>) : [];
    const text = parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
    const usage = (payload.usageMetadata ?? {}) as Record<string, unknown>;
    return {
      text,
      promptTokens: count(usage.promptTokenCount),
      completionTokens: count(usage.candidatesTokenCount),
      // `SAFETY`/`RECITATION` also produce no usable text; they are reported as
      // an empty reply upstream, which is already treated as a failure rather
      // than as an answer.
      truncated: first.finishReason === 'MAX_TOKENS',
    };
  },
};

export const PROVIDERS: Record<string, Provider> = {
  anthropic: anthropicProvider,
  gemini: geminiProvider,
};

/** Default endpoint per provider, so only the key is mandatory. */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
