import { describe, expect, it } from 'vitest';
import { OpenAiChatClient, extractAssistantText, resolveLlmEnv } from './client.js';
import { PermanentError } from '@handbook/core';

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
  it('prefers OPENAI_* and strips trailing slashes', () => {
    const env = resolveLlmEnv({
      OPENAI_API_KEY: 'k',
      HANDBOOK_LLM_API_KEY: 'ignored',
      OPENAI_BASE_URL: 'http://localhost:8000/v1///',
    } as NodeJS.ProcessEnv);
    expect(env.apiKey).toBe('k');
    expect(env.baseUrl).toBe('http://localhost:8000/v1');
  });

  it('falls back to HANDBOOK_LLM_*', () => {
    const env = resolveLlmEnv({ HANDBOOK_LLM_MODEL: 'm1' } as NodeJS.ProcessEnv);
    expect(env.model).toBe('m1');
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
    const client = new OpenAiChatClient({ config: base, fetchImpl: fakeFetch(() => ({ status: 200, body: okBody })) });
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

describe('extractAssistantText', () => {
  it('walks the fallback shapes', () => {
    expect(extractAssistantText({ response: 'r' })).toBe('r');
    expect(extractAssistantText({ data: { content: 'c' } })).toBe('c');
    expect(extractAssistantText({})).toBeUndefined();
  });
});
