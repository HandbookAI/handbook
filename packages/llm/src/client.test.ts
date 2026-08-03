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
    // First attempt uses the configured budget; later attempts get more room
    // because the endpoint proved it spends the budget on reasoning.
    expect(bodies[0]?.max_tokens).toBe(1000);
    expect(bodies[1]?.max_tokens).toBe(2000);
    expect(bodies[2]?.max_tokens).toBe(3000);
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
    await expect(client.complete('p')).rejects.toThrow(/spent its budget on reasoning \(4096 reasoning tokens\)/);
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
