import { describe, expect, it } from 'vitest';
import {
  OpenAiChatClient,
  extractAssistantText,
  llmConfigFromValues,
  looksLikeGatewayPage,
  resolveLlmEnv,
} from './client.js';
import { PermanentError, settingByKey, silentLogger } from '@handbook/core';

function fakeFetch(handler: (calls: number) => { status: number; body: unknown }): typeof fetch {
  let calls = 0;
  return (async () => {
    calls += 1;
    const { status, body } = handler(calls);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const okBody = { choices: [{ message: { content: 'hello ```json\n{"a":1}\n```' } }] };

describe('resolveLlmEnv', () => {
  it('reads a configurable request timeout, in seconds', () => {
    expect(resolveLlmEnv({} as NodeJS.ProcessEnv).timeoutMs).toBe(300_000);
    expect(resolveLlmEnv({ OPENAI_TIMEOUT: '90' } as NodeJS.ProcessEnv).timeoutMs).toBe(90_000);
    expect(resolveLlmEnv({ HANDBOOK_LLM_TIMEOUT: '45' } as NodeJS.ProcessEnv).timeoutMs).toBe(45_000);
    // Behaviour change, deliberate: a garbage timeout used to fall back to the
    // default silently; it now throws, naming the variable.
    expect(() => resolveLlmEnv({ OPENAI_TIMEOUT: 'nonsense' } as NodeJS.ProcessEnv)).toThrow(
      /OPENAI_TIMEOUT/,
    );
  });

  it('accepts OPENAI_* as a fallback and strips trailing slashes', () => {
    const env = resolveLlmEnv({
      OPENAI_API_KEY: 'k',
      OPENAI_BASE_URL: 'http://localhost:8000/v1///',
    } as NodeJS.ProcessEnv);
    expect(env.apiKey).toBe('k');
    expect(env.baseUrl).toBe('http://localhost:8000/v1');
  });

  it('ranks the HANDBOOK_LLM_* alias above the vendor name, like every other registry setting', () => {
    // Behaviour change, deliberate: resolveLlmEnv now goes through the shared
    // registry, whose precedence rule is "handbook names beat vendor aliases"
    // (see core/config/resolve.test.ts, "ranks it below the handbook names") —
    // the opposite of this function's old, bespoke
    // `pick(OPENAI_*, HANDBOOK_LLM_*)` order, which put the vendor name first.
    const env = resolveLlmEnv({
      OPENAI_API_KEY: 'vendor',
      HANDBOOK_LLM_API_KEY: 'ours',
    } as NodeJS.ProcessEnv);
    expect(env.apiKey).toBe('ours');
  });

  it('falls back to HANDBOOK_LLM_*', () => {
    const env = resolveLlmEnv({ HANDBOOK_LLM_MODEL: 'm1' } as NodeJS.ProcessEnv);
    expect(env.model).toBe('m1');
  });
});

describe('llmConfigFromValues', () => {
  it('falls back to the registry default for every field when values is empty', () => {
    // No hand-built `values` object standing in for a real resolveConfig()
    // output: the point is that the client's own fallbacks and the registry's
    // declared defaults are the same values, read from the registry itself so
    // this test cannot drift from it either.
    const config = llmConfigFromValues({});
    expect(config.apiKey).toBe(settingByKey('llmApiKey')?.default);
    expect(config.model).toBe(settingByKey('llmModel')?.default);
    expect(config.baseUrl).toBe(settingByKey('llmBaseUrl')?.default);
    expect(config.maxTokens).toBe(settingByKey('llmMaxTokens')?.default);
    // maxRetries default is 6, already >= 1, so the clamp is a no-op here —
    // the clamp's own behaviour (0 -> 1) is covered separately below.
    expect(config.maxRetries).toBe(settingByKey('llmMaxRetries')?.default);
    expect(config.retryBackoffMs).toBe(Number(settingByKey('llmRetryBackoff')?.default) * 1000);
    expect(config.timeoutMs).toBe(Number(settingByKey('llmTimeout')?.default) * 1000);
    // llmExtraBody is a pass-through with no registry default; its absence
    // must still produce an empty object, not undefined.
    expect(settingByKey('llmExtraBody')?.default).toBeUndefined();
    expect(config.extraBody).toEqual({});
  });
});

describe('OPENAI_EXTRA_BODY', () => {
  it('merges vendor fields and refuses to fight the client', async () => {
    const env = { OPENAI_EXTRA_BODY: '{"thinking":{"type":"disabled"},"model":"hijacked","max_tokens":1}' };
    const config = resolveLlmEnv(env as NodeJS.ProcessEnv);
    expect(config.extraBody).toEqual({ thinking: { type: 'disabled' } });

    const bodies: Array<Record<string, any>> = [];
    const client = new OpenAiChatClient({
      config: {
        apiKey: 'k',
        baseUrl: 'http://x/v1',
        maxRetries: 1,
        extraBody: config.extraBody,
        maxTokens: 800,
      },
      fetchImpl: (async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.complete('p');
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 800 });
    expect(bodies[0]?.model).not.toBe('hijacked');
  });

  it('fails loudly on malformed or non-object JSON instead of silently dropping it', () => {
    // Behaviour change, deliberate: this used to resolve to `{}` for both a
    // syntax error and a JSON array; a bad value now throws, naming the var.
    expect(() => resolveLlmEnv({ OPENAI_EXTRA_BODY: 'not json' } as NodeJS.ProcessEnv)).toThrow(
      /OPENAI_EXTRA_BODY/,
    );
    expect(() => resolveLlmEnv({ OPENAI_EXTRA_BODY: '[1,2]' } as NodeJS.ProcessEnv)).toThrow(
      /OPENAI_EXTRA_BODY/,
    );
  });
});

describe('resolveLlmEnv strictness', () => {
  it('still reads the vendor env names and the handbook aliases', () => {
    const cfg = resolveLlmEnv({ OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'https://x/v1/', OPENAI_API_KEY: 'k' });
    expect(cfg.model).toBe('m');
    expect(cfg.baseUrl).toBe('https://x/v1'); // trailing slashes still stripped
    expect(cfg.apiKey).toBe('k');
  });

  it('fails loudly on a garbage numeric instead of silently using the default', () => {
    // Behaviour change, deliberate: the old code documented falling back to
    // 16000 so a bad value could not poison a request, but that also meant a
    // typo'd tuning var did nothing and said nothing.
    expect(() => resolveLlmEnv({ OPENAI_MAX_TOKENS: 'lots' })).toThrow(
      /OPENAI_MAX_TOKENS: llmMaxTokens must be an integer >= 1/,
    );
    expect(() => resolveLlmEnv({ OPENAI_TIMEOUT: '-5' })).toThrow(/OPENAI_TIMEOUT/);
  });

  it('fails loudly on malformed extra body instead of dropping the vendor field', () => {
    expect(() => resolveLlmEnv({ OPENAI_EXTRA_BODY: '{"thinking":}' })).toThrow(
      /OPENAI_EXTRA_BODY: llmExtraBody must be valid JSON/,
    );
  });

  it('still refuses to let extra body override the fields the client owns', () => {
    const cfg = resolveLlmEnv({ OPENAI_EXTRA_BODY: '{"model":"evil","thinking":{"type":"disabled"}}' });
    expect(cfg.extraBody).toEqual({ thinking: { type: 'disabled' } });
  });

  it('keeps 0 retries meaningful (one attempt), not replaced by the default', () => {
    expect(resolveLlmEnv({ HANDBOOK_LLM_MAX_RETRIES: '0' }).maxRetries).toBe(1);
  });

  it('ignores a broken setting outside the llm* group entirely', () => {
    // Regression: resolveConfig resolved as command 'studio' pulls in EVERY
    // studio setting, so a typo'd HANDBOOK_PORT or HANDBOOK_LOG_LEVEL used to
    // abort every LLM call and every bare `new OpenAiChatClient()` — an error
    // that belongs to whoever actually resolves studio's own settings.
    const cfg = resolveLlmEnv({
      HANDBOOK_PORT: 'abc',
      HANDBOOK_LOG_LEVEL: 'loud',
      OPENAI_API_KEY: 'k',
    } as NodeJS.ProcessEnv);
    expect(cfg.apiKey).toBe('k');
  });
});

describe('OpenAiChatClient', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', maxRetries: 3, retryBackoffMs: 1 };

  it('requires an api key', () => {
    const saved = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.HANDBOOK_LLM_API_KEY;
    try {
      expect(() => new OpenAiChatClient()).toThrow(PermanentError);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it('returns text and extracted json', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch(() => ({ status: 200, body: okBody })),
    });
    const result = await client.complete('hi');
    expect(result.json).toEqual({ a: 1 });
    expect(client.usage().calls).toBe(1);
  });

  it('retries transient 5xx and succeeds', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch((n) => (n < 3 ? { status: 500, body: {} } : { status: 200, body: okBody })),
    });
    const result = await client.complete('hi');
    expect(result.text).toContain('hello');
  });

  it('accumulates token usage across calls', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: { ...okBody, usage: { prompt_tokens: 100, completion_tokens: 25 } },
      })),
    });
    await client.complete('one');
    await client.complete('two');
    expect(client.usage()).toMatchObject({ calls: 2, promptTokens: 200, completionTokens: 50 });
  });

  it('accepts the input_tokens/output_tokens spelling some endpoints use', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: { ...okBody, usage: { input_tokens: 40, output_tokens: 7 } },
      })),
    });
    await client.complete('p');
    expect(client.usage()).toMatchObject({ promptTokens: 40, completionTokens: 7 });
  });

  it('tolerates responses without a usage block', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch(() => ({ status: 200, body: okBody })),
    });
    await client.complete('p');
    expect(client.usage()).toMatchObject({ calls: 1, promptTokens: 0, completionTokens: 0 });
  });

  it('counts tokens spent on replies that were rejected and retried', async () => {
    // A blank reasoning reply still burned real tokens; the meter must say so.
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch((n) => ({
        status: 200,
        body:
          n === 1
            ? {
                choices: [{ finish_reason: 'length', message: { content: '' } }],
                usage: { prompt_tokens: 10, completion_tokens: 500 },
              }
            : { ...okBody, usage: { prompt_tokens: 10, completion_tokens: 20 } },
      })),
    });
    await client.complete('p');
    expect(client.usage()).toMatchObject({ calls: 1, promptTokens: 20, completionTokens: 520 });
  });

  it('fails fast on permanent 4xx', async () => {
    let attempts = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: fakeFetch((n) => {
        attempts = n;
        return { status: 401, body: {} };
      }),
    });
    await expect(client.complete('hi')).rejects.toThrow(PermanentError);
    expect(attempts).toBe(1);
  });
});

describe('OpenAiChatClient config vs. environment isolation', () => {
  // Every field LlmEnvConfig declares — a caller supplying all of them needs
  // nothing from the environment.
  const complete = {
    apiKey: 'k',
    model: 'm',
    baseUrl: 'http://x/v1',
    maxTokens: 500,
    maxRetries: 3,
    retryBackoffMs: 1,
    timeoutMs: 1000,
    extraBody: {},
  };

  it('a complete config is not broken by an unrelated malformed env var', () => {
    const saved = process.env.OPENAI_MAX_TOKENS;
    process.env.OPENAI_MAX_TOKENS = 'not-a-number'; // would make resolveLlmEnv() throw if consulted
    try {
      expect(() => new OpenAiChatClient({ config: complete })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.OPENAI_MAX_TOKENS;
      else process.env.OPENAI_MAX_TOKENS = saved;
    }
  });

  it('an incomplete config still surfaces the loud environment error', () => {
    const saved = process.env.OPENAI_MAX_TOKENS;
    process.env.OPENAI_MAX_TOKENS = 'not-a-number';
    try {
      // Missing `model` (among other fields) means the environment is still
      // consulted, and its malformed value must still be reported loudly.
      expect(() => new OpenAiChatClient({ config: { apiKey: 'k', baseUrl: 'http://x/v1' } })).toThrow(
        /OPENAI_MAX_TOKENS/,
      );
    } finally {
      if (saved === undefined) delete process.env.OPENAI_MAX_TOKENS;
      else process.env.OPENAI_MAX_TOKENS = saved;
    }
  });
});

describe('OpenAiChatClient degenerate retry caps (never reject-with-undefined, never hang)', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', retryBackoffMs: 1 };

  it('makes the request (not zero attempts) and never rejects with undefined when maxRetries is NaN', async () => {
    // Math.max(1, Math.trunc(NaN)) === NaN, so the retry loop body was skipped
    // entirely and `throw lastError` rejected with a bare `undefined` — a call
    // that never even fired a fetch.
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: NaN },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await client.complete('p');
    expect(result.text).toContain('hello');
    expect(fetches).toBe(1);
  });

  it('a NaN cap over a failing endpoint rejects with the real error, not undefined', async () => {
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: NaN },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch,
    });
    const error = await client.complete('p').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/500/);
    expect(fetches).toBe(1); // clamped to a single attempt, not zero, not infinite
  });

  it('terminates (does not loop forever) when maxRetries is Infinity', async () => {
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: Infinity },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(/500/);
    expect(fetches).toBeLessThan(1000); // bounded: Infinity is clamped, not honored
  }, 10_000);
});

describe('OpenAiChatClient cooperative cancellation', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', maxRetries: 3, retryBackoffMs: 1 };

  it('rejects a pre-aborted signal with an AbortError and makes zero fetch attempts', async () => {
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();
    const error = await client.complete('p', { signal: controller.signal }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(fetches).toBe(0);
  });

  it('rejects promptly when aborted during the retry backoff, and stops retrying', async () => {
    // A huge backoff would hold the test hostage if the sleep ignored the signal.
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: { ...base, retryBackoffMs: 60_000 },
      fetchImpl: (async () => {
        fetches += 1;
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.complete('p', { signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 20);
    const error = await pending;
    expect((error as Error).name).toBe('AbortError');
    expect(fetches).toBe(1); // the abort was not retried
  }, 10_000);

  it('aborts the in-flight HTTP request (signal combined with the timeout) and never retries it', async () => {
    let fetches = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        fetches += 1;
        // Hang forever; only the request signal can end this call. A plain
        // AbortSignal.timeout(300s) would not fire when the caller aborts.
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = client.complete('p', { signal: controller.signal }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 10);
    const error = await pending;
    expect((error as Error).name).toBe('AbortError');
    expect(fetches).toBe(1);
  }, 10_000);

  it('keeps the plain timeout signal when no caller signal is given', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        signals.push(init.signal);
        return new Response(JSON.stringify(okBody), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.complete('p');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe('extractAssistantText', () => {
  it('walks the fallback shapes', () => {
    expect(extractAssistantText({ response: 'r' })).toBe('r');
    expect(extractAssistantText({ data: { content: 'c' } })).toBe('c');
    expect(extractAssistantText({})).toBeUndefined();
  });
});

describe('OpenAiChatClient with a reasoning endpoint', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', maxRetries: 3, retryBackoffMs: 1, model: 'glm-5.2' };

  /** Capture the request bodies so budget growth is observable. */
  function recordingFetch(bodies: Array<Record<string, any>>, handler: (n: number) => unknown): typeof fetch {
    let calls = 0;
    return (async (_url: string, init: RequestInit) => {
      calls += 1;
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(handler(calls)), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it('treats an empty completion as a retryable failure, not an empty answer', async () => {
    const bodies: Array<Record<string, any>> = [];
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: recordingFetch(bodies, () => ({
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
      })),
    });
    await expect(client.complete('describe this file')).rejects.toThrow(/empty content/i);
    expect(bodies.length).toBe(3); // retried, not silently accepted
  });

  it('names reasoning as the cause and grows the budget on retry', async () => {
    const bodies: Array<Record<string, any>> = [];
    const client = new OpenAiChatClient({
      config: { ...base, maxTokens: 1000 },
      fetchImpl: recordingFetch(bodies, (n) =>
        n < 3
          ? {
              choices: [
                {
                  finish_reason: 'length',
                  message: { role: 'assistant', content: '', reasoning_content: 'thinking…' },
                },
              ],
              usage: { completion_tokens_details: { reasoning_tokens: 999 } },
            }
          : { choices: [{ message: { content: '{"ok":1}' } }] },
      ),
    });
    const result = await client.complete('describe this file');
    expect(result.json).toEqual({ ok: 1 });
    // First attempt uses the configured budget; this call's retries get more
    // room, capped at 2× so an endpoint's own limit is not blown past.
    expect(bodies[0]?.max_tokens).toBe(1000);
    expect(bodies[1]?.max_tokens).toBe(2000);
    expect(bodies[2]?.max_tokens).toBe(2000);
  });

  it('keeps budget growth to the call that needed it', async () => {
    const bodies: Array<Record<string, any>> = [];
    const client = new OpenAiChatClient({
      config: { ...base, maxTokens: 1000 },
      fetchImpl: recordingFetch(bodies, (n) =>
        n === 1
          ? { choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] }
          : { choices: [{ message: { content: '{"ok":1}' } }] },
      ),
    });
    await client.complete('first call'); // truncated once, retried at 2×
    await client.complete('second call'); // unrelated: must start at 1× again
    expect(bodies.map((b) => b.max_tokens)).toEqual([1000, 2000, 1000]);
  });

  it('learns a budget ceiling from a 400 and stays retryable', async () => {
    const bodies: Array<Record<string, any>> = [];
    let calls = 0;
    const client = new OpenAiChatClient({
      config: { ...base, maxTokens: 4000, maxRetries: 4 },
      fetchImpl: (async (_u: string, init: RequestInit) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.max_tokens > 2000) {
          return new Response(JSON.stringify({ error: { message: 'max_tokens too large' } }), {
            status: 400,
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    // A 400 about the token parameter must not be permanent: it is a verdict on
    // our budget, so the ceiling is learned and the call still succeeds.
    await expect(client.complete('p')).resolves.toMatchObject({ json: { ok: 1 } });
    expect(bodies.map((b) => b.max_tokens)).toEqual([4000, 2000]);
    expect(calls).toBe(2);
  });

  it('reports the reasoning hint when every attempt comes back blank', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'x' } }],
            usage: { completion_tokens_details: { reasoning_tokens: 4096 } },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(
      /spent its budget on reasoning \(4096 reasoning tokens\)/,
    );
  });

  it('still rejects whitespace-only content', async () => {
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '   \n\t ' } }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(/empty content/i);
  });
});

describe('gateway pages vs API errors', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', maxRetries: 3, retryBackoffMs: 1 };
  const gateway = '<!doctypehtml><html lang="zh-cn"><title>405</title><body>blocked</body></html>';

  it('recognises an edge-served page', () => {
    expect(looksLikeGatewayPage(gateway)).toBe(true);
    expect(looksLikeGatewayPage('  <html><body>nope</body></html>')).toBe(true);
    expect(looksLikeGatewayPage('{"error":{"message":"bad request"}}')).toBe(false);
  });

  it('retries a normally-permanent status when a gateway answered', async () => {
    let calls = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async () => {
        calls += 1;
        return calls < 3
          ? new Response(gateway, { status: 405 })
          : new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' } }] }), {
              status: 200,
            });
      }) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).resolves.toMatchObject({ json: { ok: 1 } });
    expect(calls).toBe(3);
  });

  it('reports a gateway block in one line instead of dumping markup', async () => {
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: 1 },
      fetchImpl: (async () => new Response(gateway, { status: 405 })) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(
      /gateway refused the request \(HTTP 405, HTML error page\)/,
    );
    await expect(client.complete('p')).rejects.not.toThrow(/doctype/);
  });

  it('still refuses to retry a genuine API rejection', async () => {
    let calls = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'unsupported model' } }), { status: 400 });
      }) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(PermanentError);
    expect(calls).toBe(1);
  });
});

describe('truncated completions', () => {
  const base = { apiKey: 'test', baseUrl: 'http://x/v1', maxRetries: 3, retryBackoffMs: 1, maxTokens: 500 };

  it('fails and retries with more room when the answer was cut off', async () => {
    const bodies: Array<Record<string, any>> = [];
    let calls = 0;
    const client = new OpenAiChatClient({
      config: base,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        calls += 1;
        bodies.push(JSON.parse(String(init.body)));
        return calls < 2
          ? new Response(
              JSON.stringify({
                choices: [{ finish_reason: 'length', message: { content: '{"stages": [{"id":' } }],
              }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":1}' } }] }),
              {
                status: 200,
              },
            );
      }) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).resolves.toMatchObject({ json: { ok: 1 } });
    expect(bodies[0]?.max_tokens).toBe(500);
    expect(bodies[1]?.max_tokens).toBe(1000); // more room on the retry
  });

  it('refuses a truncated answer whose structure is broken', async () => {
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: 1 },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '{"stages": [{"id": "a"' } }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).rejects.toThrow(/truncated mid-structure/);
  });

  it('keeps truncated PROSE rather than discarding a usable paragraph', async () => {
    const warnings: string[] = [];
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: 1 },
      logger: {
        info: () => {},
        warn: (m: string) => {
          warnings.push(m);
        },
        error: () => {},
        debug: () => {},
        child: () => silentLogger,
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              { finish_reason: 'length', message: { content: 'The queue stage takes work from the' } },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const result = await client.complete('write the stage overview');
    expect(result.text).toBe('The queue stage takes work from the');
    expect(warnings.join(' ')).toMatch(/hit the token limit/);
  });

  it('keeps a truncated reply whose JSON is nonetheless complete', async () => {
    const client = new OpenAiChatClient({
      config: { ...base, maxRetries: 1 },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content: '```json\n{"ok":1}\n```\nand then some trail' },
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    await expect(client.complete('p')).resolves.toMatchObject({ json: { ok: 1 } });
  });
});
