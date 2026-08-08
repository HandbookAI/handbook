/**
 * OpenAI-compatible chat client.
 *
 * Every LLM touchpoint in the toolchain goes through the {@link ChatClient}
 * interface so pipelines can be tested offline with {@link MockChatClient}
 * (see mock.ts) and any OpenAI-compatible endpoint (hosted, vLLM, a proxy…)
 * works in production via {@link OpenAiChatClient}.
 */
import {
  ConfigError,
  PermanentError,
  extractJsonBlock,
  pLimit,
  resolveConfig,
  settingByKey,
  settingsFor,
  type Logger,
  silentLogger,
  type LimitFn,
} from '@handbook/core';

/** Every registry key in the llm* group — derived, not restated, so this list
 *  can never drift from registry.ts's own `LLM_COMMANDS` grouping. */
const LLM_SETTING_KEYS = settingsFor('studio')
  .filter((s) => s.key.startsWith('llm'))
  .map((s) => s.key);

export interface ChatOptions {
  /** Sampling temperature. Omitted automatically for reasoning-style models. */
  temperature?: number;
  /** Override the client's default max output tokens for this call. */
  maxTokens?: number;
  /**
   * Cooperative cancellation. An aborted call rejects with the signal's reason
   * (an `AbortError`, never wrapped), aborts the in-flight HTTP request, and is
   * never retried.
   */
  signal?: AbortSignal;
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
  /** Per-request deadline. A stalled endpoint must not hold a phase hostage. */
  timeoutMs: number;
  /**
   * Vendor-specific fields merged into every request body, from
   * `OPENAI_EXTRA_BODY` (JSON). The escape hatch for parameters outside the
   * OpenAI schema — e.g. `{"thinking":{"type":"disabled"}}` on an endpoint whose
   * model spends 90% of its token budget reasoning. Cannot override `model`,
   * `messages`, or the token/temperature fields this client manages.
   */
  extraBody: Record<string, unknown>;
}

/** Fields the client owns; extra-body must not fight them. */
const RESERVED_BODY_FIELDS = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream']);

/**
 * Every field `LlmEnvConfig` declares. A caller's `options.config` is
 * "complete" when it supplies every one of these — only then can the
 * environment be skipped entirely (see the constructor).
 */
const REQUIRED_CONFIG_FIELDS: readonly (keyof LlmEnvConfig)[] = [
  'apiKey',
  'model',
  'baseUrl',
  'maxTokens',
  'maxRetries',
  'retryBackoffMs',
  'timeoutMs',
  'extraBody',
];

/**
 * Resolve client configuration through the shared config registry, so the LLM
 * settings obey exactly the same precedence, naming and validation as every
 * other setting — and are reachable from flags, which they never were.
 *
 * Strict by design: a garbage value now throws with the variable named. The
 * previous silent fallback kept a bad value from poisoning a request, but it
 * also meant `OPENAI_MAX_TOKENS=lots` ran at 16000 and said nothing.
 *
 * Resolved as `studio` rather than `generate`: both carry the identical llm*
 * group (see `LLM_COMMANDS` in the registry), but `generate` also requires
 * `source`/`work` — settings this function has no way to supply and no
 * business demanding, since all it resolves is the llm* group. `studio` is
 * also the one real caller of this path with no config object of its own (see
 * `OpenAiChatClient`'s constructor and studio's default `clientFactory`).
 *
 * Restricted to `LLM_SETTING_KEYS` via `resolveConfig`'s `only`: this
 * function's job is the llm* group, nothing else, so a studio setting it has
 * no business validating — `HANDBOOK_PORT=abc`, `HANDBOOK_LOG_LEVEL=loud` —
 * must not abort every job and every bare `new OpenAiChatClient()` on a typo
 * that whoever actually resolves `studio`'s own settings will report.
 */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const { values, errors } = resolveConfig({ command: 'studio', flags: {}, env, only: LLM_SETTING_KEYS });
  if (errors.length > 0) throw new ConfigError(errors.join('; '));
  return llmConfigFromValues(values) as LlmEnvConfig;
}

/**
 * Map resolved registry values onto the client's own shape. Seconds become
 * milliseconds here, and `maxRetries` is clamped to at least one attempt: 0 is
 * a legitimate "no retries" request, not "never try".
 *
 * Every field below falls back to `settingByKey(...)?.default` rather than a
 * literal. Every `llm*` setting except `llmExtraBody` already declares a
 * default in the registry (see `registry.ts`), so restating it here — e.g.
 * `?? 'gpt-4o-mini'` — would just give that value a second home, one the
 * registry's whole point was to eliminate: a setting is declared exactly
 * once. Those literals were also *dead*: `resolveConfig`'s output always
 * carries these keys, so the `??` side never ran — which is exactly what the
 * coverage gate was reporting. `num`/`str` below fall back to `0`/`''` only as
 * a type guard for a registry entry that lost its default outright (a
 * registry bug, not a value this function owns); that is not a restatement of
 * any setting's actual default.
 */
export function llmConfigFromValues(values: Record<string, unknown>): Partial<LlmEnvConfig> {
  const registryDefault = (key: string): unknown => settingByKey(key)?.default;
  const resolved = (key: string): unknown => (values[key] !== undefined ? values[key] : registryDefault(key));

  const num = (key: string): number => {
    const v = resolved(key);
    return typeof v === 'number' ? v : 0;
  };
  const str = (key: string): string => {
    const v = resolved(key);
    return typeof v === 'string' ? v : '';
  };

  const maxRetries = num('llmMaxRetries');
  const backoffSec = num('llmRetryBackoff');
  const timeoutSec = num('llmTimeout');
  const extra = values.llmExtraBody;

  return {
    apiKey: str('llmApiKey'),
    model: str('llmModel'),
    baseUrl: str('llmBaseUrl').replace(/\/+$/, ''),
    maxTokens: num('llmMaxTokens'),
    maxRetries: Math.max(1, maxRetries),
    retryBackoffMs: Math.round(backoffSec * 1000),
    timeoutMs: Math.round(timeoutSec * 1000),
    extraBody: stripReservedBodyFields(extra),
  };
}

/** Fields the client owns; extra-body must not fight them. */
function stripReservedBodyFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => !RESERVED_BODY_FIELDS.has(key)),
  );
}

export interface OpenAiChatClientOptions {
  config?: Partial<LlmEnvConfig>;
  /** Global cap on concurrent requests through this client. Default: the registry default for `llmConcurrency`. */
  concurrency?: number;
  logger?: Logger;
  /** Request timeout in ms. Overrides `OPENAI_TIMEOUT`. */
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Per-call retry state: whether this call's retries should ask for more room. */
interface CallState {
  grow: boolean;
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
  /** Prompt/input tokens billed, summed over every response the endpoint returned. */
  promptTokens: number;
  /** Completion/output tokens billed, summed over every response the endpoint returned. */
  completionTokens: number;
}

export class OpenAiChatClient implements ChatClient {
  readonly model: string;
  /**
   * The highest budget this endpoint has accepted, learned from a 400 that
   * rejected a larger one. Shared across calls because it is a property of the
   * model, not of a request.
   */
  private budgetCeiling = Number.POSITIVE_INFINITY;
  private readonly config: LlmEnvConfig;
  private readonly limit: LimitFn;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly stats: LlmUsageStats = {
    calls: 0,
    failures: 0,
    totalElapsedSec: 0,
    promptTokens: 0,
    completionTokens: 0,
  };

  constructor(options: OpenAiChatClientOptions = {}) {
    // Only ask the environment for what the caller did not supply. A caller
    // that passed a complete config must not be broken by an unrelated
    // malformed OPENAI_* var it never intended to use — resolveLlmEnv() is
    // strict, and a stray `OPENAI_TIMEOUT=abc` in the shell has nothing to do
    // with a request whose every field was already given explicitly.
    const supplied = options.config ?? {};
    const needsEnv = REQUIRED_CONFIG_FIELDS.some((field) => supplied[field] === undefined);
    this.config = needsEnv ? { ...resolveLlmEnv(), ...supplied } : (supplied as LlmEnvConfig);
    if (!this.config.apiKey) {
      throw new PermanentError(
        'no API key: set OPENAI_API_KEY (use OPENAI_API_KEY=EMPTY for a keyless local endpoint)',
      );
    }
    this.model = this.config.model;
    this.limit = pLimit(options.concurrency ?? (settingByKey('llmConcurrency')?.default as number));
    this.logger = options.logger ?? silentLogger;
    this.timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  usage(): Readonly<LlmUsageStats> {
    return { ...this.stats };
  }

  async complete(prompt: string, options: ChatOptions = {}): Promise<ChatResult> {
    // Budget growth is per CALL: one truncated reply must not inflate every
    // other request on a client shared by 16 concurrent workers.
    const call: CallState = { grow: false };
    return this.limit(() =>
      retryAbortable(
        async (attempt) => {
          // Checked before EVERY attempt: a cancelled run must not open one
          // more HTTP request just because a retry was already scheduled.
          options.signal?.throwIfAborted();
          const startedAt = Date.now();
          const text = await this.request(prompt, options, attempt, call);
          const elapsedSec = (Date.now() - startedAt) / 1000;
          this.stats.calls += 1;
          this.stats.totalElapsedSec += elapsedSec;
          return { text, json: extractJsonBlock(text), elapsedSec };
        },
        {
          attempts: this.config.maxRetries,
          backoffMs: this.config.retryBackoffMs,
          signal: options.signal,
          onRetry: (error, attempt) => {
            this.stats.failures += 1;
            this.logger.warn(`LLM call failed (attempt ${attempt}): ${String(error)}`);
          },
        },
      ),
    );
  }

  private async request(
    prompt: string,
    options: ChatOptions,
    attempt = 1,
    call: CallState = { grow: false },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
    };
    // A reasoning endpoint spends part of the budget thinking, and a truncated
    // reply needed more room, so grow the budget for THIS call's retries —
    // never past a ceiling the endpoint has already rejected.
    const base = options.maxTokens ?? this.config.maxTokens;
    const growth = call.grow ? Math.min(2, attempt) : 1;
    const maxTokens = Math.max(1, Math.min(base * growth, this.budgetCeiling));
    if (REASONING_MODEL_RE.test(this.model)) {
      body.max_completion_tokens = maxTokens; // reasoning models also reject `temperature`
    } else {
      body.max_tokens = maxTokens;
      if (options.temperature !== undefined) body.temperature = options.temperature;
    }

    Object.assign(body, this.config.extraBody);

    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      // The caller's signal rides along with the per-request deadline, so a
      // cancelled run tears down its in-flight requests instead of waiting
      // them out. Without a caller signal the plain timeout is kept as-is.
      signal: options.signal
        ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), options.signal])
        : AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // An HTML body means the API never saw the request — a gateway, WAF or
      // load balancer answered instead. Say so in one line rather than dumping
      // 300 characters of markup into the log, and retry it: an edge verdict
      // says nothing permanent about the request itself.
      if (looksLikeGatewayPage(body)) {
        throw new Error(
          `LLM endpoint's gateway refused the request (HTTP ${response.status}, HTML error page) — ` +
            'the payload never reached the API; a content filter is the usual cause',
        );
      }
      const message = `LLM endpoint returned ${response.status}: ${body.slice(0, 300)}`;
      // A 400 complaining about the token parameter is a verdict on OUR budget,
      // not on the request: remember the ceiling, stop growing, and retry.
      if (response.status === 400 && /max_?(completion_)?tokens|token limit|max output/i.test(body)) {
        this.budgetCeiling = Math.min(this.budgetCeiling, Math.max(1, Math.floor(maxTokens / 2)));
        call.grow = false;
        throw new Error(`${message} — retrying with max_tokens=${this.budgetCeiling}`);
      }
      if (PERMANENT_STATUSES.has(response.status)) throw new PermanentError(message);
      throw new Error(message); // 408/429/5xx → retryable
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const usage = (payload.usage ?? {}) as Record<string, any>;
    // Token spend is metered HERE, on every response the endpoint produced —
    // a blank or truncated reply that gets rejected and retried still burned
    // real tokens, and the meter must reflect cost, not just accepted answers.
    this.stats.promptTokens += countTokens(usage.prompt_tokens ?? usage.input_tokens);
    this.stats.completionTokens += countTokens(usage.completion_tokens ?? usage.output_tokens);
    const choice = ((payload.choices as Array<Record<string, any>> | undefined) ?? [])[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const reasoned = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
    const text = extractAssistantText(payload);
    if (text === undefined) throw new Error('LLM response had no assistant text');
    if (finishReason === 'length' && text.trim() !== '') {
      // A completion cut off at the limit is a PARTIAL answer. Whether that is
      // fatal depends on what was asked for: a broken JSON document is useless,
      // but a paragraph missing its last clause beats the canned fallback that
      // replaces it. So refuse it only when structure was wanted and is broken.
      const structureWanted = /[{[]/.test(text);
      const structureUsable = extractJsonBlock(text) !== undefined;
      if (structureWanted && !structureUsable) {
        call.grow = true;
        throw new Error(
          `LLM response was truncated mid-structure (max_tokens=${maxTokens}, ${text.length} chars) — ` +
            'raise OPENAI_MAX_TOKENS if this persists',
        );
      }
      this.logger.warn(
        `LLM response hit the token limit (max_tokens=${maxTokens}); using the ${text.length} characters returned`,
      );
    }
    if (text.trim() === '') {
      // Empty content is a FAILURE, not an empty answer: accepting it silently
      // is how a whole run ends up with blank cards.
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
      if (reasoned) call.grow = true;
      const hint = reasoned
        ? ` — the model spent its budget on reasoning${
            reasoningTokens ? ` (${String(reasoningTokens)} reasoning tokens)` : ''
          }; raise OPENAI_MAX_TOKENS or pick a non-reasoning model`
        : '';
      throw new Error(
        `LLM returned empty content (finish_reason=${finishReason}, max_tokens=${maxTokens})${hint}`,
      );
    }
    return text;
  }
}

interface RetryAbortableOptions {
  /** Total attempts including the first one. */
  attempts: number;
  /** Linear backoff base in ms: sleep `backoffMs * attempt` between tries. */
  backoffMs: number;
  /** Uniform random extra sleep in ms added to each backoff. Default 500. */
  jitterMs?: number;
  /** Cooperative cancellation: consulted before each sleep and while sleeping. */
  signal?: AbortSignal;
  /** Called before each re-attempt with the error that caused it. */
  onRetry?: (error: unknown, attempt: number) => void;
}

/**
 * Core's `retry` semantics (linear backoff + jitter, {@link PermanentError}
 * aborts immediately) plus cooperative cancellation: once the signal fires,
 * the AbortError is rethrown untouched — never retried, never wrapped — and a
 * backoff sleep already in progress wakes up and rejects at once.
 */
async function retryAbortable<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryAbortableOptions,
): Promise<T> {
  // `Math.max(1, Math.trunc(x))` does NOT tame every bad input: Math.trunc(NaN)
  // is NaN and `1 <= NaN` is false, so a NaN cap would skip the loop entirely
  // and `throw lastError` (undefined) without ever calling `fn` — a request that
  // rejects with `undefined` and never fires. Math.trunc(Infinity) is Infinity,
  // which loops forever on a persistently-failing endpoint. A misconfigured
  // config.maxRetries (bypassing `llmConfigFromValues`'s own >= 1 clamp) reaches
  // here raw, so clamp non-finite values to a single attempt before counting.
  const attempts = Math.max(1, Number.isFinite(options.attempts) ? Math.trunc(options.attempts) : 1);
  const jitterMs = Math.max(0, options.jitterMs ?? 500);
  const { signal } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      // An abort is a verdict on the RUN, not on this request — retrying would
      // keep a cancelled pipeline burning requests. throwIfAborted rethrows
      // the signal's own reason, so callers still see name === 'AbortError'.
      signal?.throwIfAborted();
      lastError = error;
      if (attempt < attempts) {
        options.onRetry?.(error, attempt);
        await abortableSleep(options.backoffMs * attempt + Math.random() * jitterMs, signal);
      }
    }
  }
  throw lastError;
}

/** Sleep that rejects with the signal's reason the moment it aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Numeric token count from a usage field; anything else counts as zero. */
function countTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
