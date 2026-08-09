import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAiChatClient } from './client.js';
import { anthropicProvider, geminiProvider } from './providers.js';

/**
 * Wire-format tests against a REAL HTTP server, not a mocked client object.
 *
 * A provider is exactly three things — URL and headers, request body, response
 * parse — and every one of them is only observable on the wire. Asserting them
 * against a stubbed `complete()` would test the stub. These start a listener,
 * record what was actually sent, and answer with what the real API answers.
 *
 * The last two cases are the point of the seam: a provider inherits the shared
 * retry and permanent-error rules, so it cannot grow its own retry bug.
 */
interface Seen {
  url: string;
  headers: Record<string, string | undefined>;
  body: Record<string, any>;
}

type Reply = { status?: number; payload: unknown };

const running: Server[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

async function serve(handler: (seen: Seen) => Reply): Promise<{ seen: Seen[]; port: number }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += String(c);
    });
    req.on('end', () => {
      const record: Seen = {
        url: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: JSON.parse(raw || '{}'),
      };
      seen.push(record);
      const out = handler(record);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  running.push(server);
  return { seen, port: (server.address() as { port: number }).port };
}

const cfg = (port: number, path: string) => ({
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: `http://127.0.0.1:${port}${path}`,
  maxTokens: 500,
  maxRetries: 1,
  retryBackoffMs: 1,
  timeoutMs: 8000,
});

describe('anthropic wire format', () => {
  it('sends the Messages shape and reads only the text block', async () => {
    const { seen, port } = await serve(() => ({
      payload: {
        // A thinking block is the model's scratchpad, not the answer.
        content: [
          { type: 'thinking', thinking: 'scratchpad' },
          { type: 'text', text: 'Anthropic says hi.' },
        ],
        usage: { input_tokens: 11, output_tokens: 5 },
        stop_reason: 'end_turn',
      },
    }));
    const client = new OpenAiChatClient({ provider: anthropicProvider, config: cfg(port, '/v1') });
    const result = await client.complete('hello', { temperature: 0 });

    const request = seen[0] as Seen;
    expect(request.url).toBe('/v1/messages');
    // The key is a header of its own, not a bearer token.
    expect(request.headers['x-api-key']).toBe('test-key');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(Array.isArray(request.body.messages[0].content)).toBe(true);
    expect(request.body.max_tokens).toBe(500); // required, not optional
    expect(result.text).toBe('Anthropic says hi.');
    expect(client.usage()).toMatchObject({ promptTokens: 11, completionTokens: 5 });
  });
});

describe('gemini wire format', () => {
  it('puts the model in the path and the key in a header', async () => {
    const { seen, port } = await serve(() => ({
      payload: {
        candidates: [{ content: { parts: [{ text: 'Gemini says hi.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
      },
    }));
    const client = new OpenAiChatClient({
      provider: geminiProvider,
      config: { ...cfg(port, '/v1beta'), model: 'gemini-2.0' },
    });
    const result = await client.complete('hello');

    const request = seen[0] as Seen;
    expect(request.url).toBe('/v1beta/models/gemini-2.0:generateContent');
    expect(request.headers['x-goog-api-key']).toBe('test-key');
    // A query-string key is written to every proxy and access log in between.
    expect(request.url).not.toContain('key=');
    expect(request.body.contents[0].parts[0].text).toBe('hello');
    expect(request.body.generationConfig.maxOutputTokens).toBe(500);
    expect(result.text).toBe('Gemini says hi.');
    expect(client.usage()).toMatchObject({ promptTokens: 7, completionTokens: 4 });
  });

  it('treats a safety refusal as a failure, not as an empty answer', async () => {
    // No candidate at all. Accepting it would blank a card silently.
    const { port } = await serve(() => ({ payload: { candidates: [{ finishReason: 'SAFETY' }] } }));
    const client = new OpenAiChatClient({ provider: geminiProvider, config: cfg(port, '/v1beta') });
    await expect(client.complete('x')).rejects.toThrow(/empty completion/);
  });
});

describe('a provider inherits the shared resilience', () => {
  it('retries a 503 like any other client', async () => {
    let calls = 0;
    const { port } = await serve(() => {
      calls += 1;
      return calls === 1
        ? { status: 503, payload: { error: 'overloaded' } }
        : { payload: { content: [{ type: 'text', text: 'recovered' }], stop_reason: 'end_turn' } };
    });
    const client = new OpenAiChatClient({
      provider: anthropicProvider,
      config: { ...cfg(port, '/v1'), maxRetries: 3, retryBackoffMs: 10 },
    });
    expect((await client.complete('x')).text).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry a 401, like any other client', async () => {
    let calls = 0;
    const { port } = await serve(() => {
      calls += 1;
      return { status: 401, payload: { error: 'bad key' } };
    });
    const client = new OpenAiChatClient({
      provider: anthropicProvider,
      config: { ...cfg(port, '/v1'), maxRetries: 5, retryBackoffMs: 10 },
    });
    await expect(client.complete('x')).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });
});

describe('a malformed reply is a failure, never a plausible-looking answer', () => {
  /**
   * These are the shapes an endpoint really produces when something is wrong:
   * a truncated body, a schema change, an error object where content belongs.
   * Every one of them must fail loudly — a provider that returns `''` here
   * writes a blank card and reports success.
   */
  const anthropicJunk: Array<[string, unknown]> = [
    ['no content key', { usage: {} }],
    ['content is not an array', { content: 'oops' }],
    ['content has no text block', { content: [{ type: 'tool_use', id: 'x' }] }],
    ['text block has no text', { content: [{ type: 'text' }] }],
    ['an error object', { error: { type: 'overloaded_error' } }],
  ];
  it.each(anthropicJunk)('anthropic: %s', async (_name, payload) => {
    const { port } = await serve(() => ({ payload }));
    const client = new OpenAiChatClient({ provider: anthropicProvider, config: cfg(port, '/v1') });
    await expect(client.complete('x')).rejects.toThrow(/empty completion/);
  });

  const geminiJunk: Array<[string, unknown]> = [
    ['no candidates', { usageMetadata: {} }],
    ['candidates is empty', { candidates: [] }],
    ['candidate has no content', { candidates: [{ finishReason: 'STOP' }] }],
    ['parts is not an array', { candidates: [{ content: { parts: 'oops' } }] }],
    ['a part with no text', { candidates: [{ content: { parts: [{ inlineData: {} }] } }] }],
  ];
  it.each(geminiJunk)('gemini: %s', async (_name, payload) => {
    const { port } = await serve(() => ({ payload }));
    const client = new OpenAiChatClient({ provider: geminiProvider, config: cfg(port, '/v1beta') });
    await expect(client.complete('x')).rejects.toThrow(/empty completion/);
  });

  it('counts a non-numeric usage field as zero rather than NaN', async () => {
    const { port } = await serve(() => ({
      payload: {
        content: [{ type: 'text', text: 'fine' }],
        usage: { input_tokens: 'lots', output_tokens: null },
        stop_reason: 'end_turn',
      },
    }));
    const client = new OpenAiChatClient({ provider: anthropicProvider, config: cfg(port, '/v1') });
    await client.complete('x');
    // A NaN here propagates into the run manifest's cost report.
    expect(client.usage()).toMatchObject({ promptTokens: 0, completionTokens: 0 });
  });

  it('keeps truncated prose but refuses truncated structure', async () => {
    // Same rule the OpenAI path enforces: a paragraph missing its last clause
    // beats the canned fallback; a broken JSON document is useless.
    const prose = await serve(() => ({
      payload: {
        content: [{ type: 'text', text: 'A sentence that stops mid-' }],
        stop_reason: 'max_tokens',
      },
    }));
    const proseClient = new OpenAiChatClient({ provider: anthropicProvider, config: cfg(prose.port, '/v1') });
    expect((await proseClient.complete('x')).text).toContain('stops mid-');

    const broken = await serve(() => ({
      payload: {
        content: [{ type: 'text', text: '{"stages": [{"id": "stage-1"' }],
        stop_reason: 'max_tokens',
      },
    }));
    const brokenClient = new OpenAiChatClient({
      provider: anthropicProvider,
      config: { ...cfg(broken.port, '/v1'), maxRetries: 1 },
    });
    await expect(brokenClient.complete('x')).rejects.toThrow(/truncated mid-structure/);
  });

  it('honours an explicit extraBody on both providers', async () => {
    for (const [provider, path] of [
      [anthropicProvider, '/v1'],
      [geminiProvider, '/v1beta'],
    ] as const) {
      const { seen, port } = await serve(() => ({
        payload:
          provider === anthropicProvider
            ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }
            : { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
      }));
      const client = new OpenAiChatClient({
        provider,
        config: { ...cfg(port, path), extraBody: { vendor_flag: true } },
      });
      await client.complete('x');
      expect((seen[0] as Seen).body.vendor_flag, provider.id).toBe(true);
    }
  });
});
