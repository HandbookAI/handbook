import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsonBlock, sha256Hex } from '@handbook/core';
import { CachedChatClient } from './cache.js';
import type { ChatClient, ChatResult } from './client.js';

/** Counting inner client: every completion is observable. */
function countingClient(respond: (prompt: string) => string, model = 'test-model') {
  const state = { calls: 0 };
  const client: ChatClient = {
    model,
    async complete(prompt: string): Promise<ChatResult> {
      state.calls += 1;
      const text = respond(prompt);
      return { text, json: extractJsonBlock(text), elapsedSec: 1.5 };
    },
  };
  return { client, state };
}

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'hb-llm-cache-'));
}

describe('CachedChatClient', () => {
  it('exposes the inner model and calls through on a miss', async () => {
    const { client, state } = countingClient(() => 'answer ```json\n{"a":1}\n```');
    const cached = new CachedChatClient(client, tempCacheDir());
    expect(cached.model).toBe('test-model');
    const result = await cached.complete('p1');
    expect(result.text).toContain('answer');
    expect(result.json).toEqual({ a: 1 });
    expect(state.calls).toBe(1);
    expect(cached.misses).toBe(1);
    expect(cached.hits).toBe(0);
  });

  it('serves a repeat prompt from disk without calling the inner client', async () => {
    const { client, state } = countingClient(() => 'stable ```json\n{"b":2}\n```');
    const dir = tempCacheDir();
    const first = await new CachedChatClient(client, dir).complete('same prompt');
    // A fresh decorator instance proves the hit comes from disk, not memory.
    const cached = new CachedChatClient(client, dir);
    const second = await cached.complete('same prompt');
    expect(state.calls).toBe(1);
    expect(cached.hits).toBe(1);
    expect(cached.misses).toBe(0);
    expect(second.text).toBe(first.text);
    expect(second.json).toEqual({ b: 2 });
    expect(second.elapsedSec).toBe(0);
  });

  it('stores entries under the documented sha256 key as {version:1, text}', async () => {
    const { client } = countingClient(() => 'keyed');
    const dir = tempCacheDir();
    await new CachedChatClient(client, dir).complete('p', { temperature: 0.2 });
    const key = sha256Hex(`test-model\np\n${JSON.stringify({ temperature: 0.2 })}`);
    const stored = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'));
    expect(stored).toEqual({ version: 1, text: 'keyed' });
  });

  it('keys on model, prompt AND options', async () => {
    const { client, state } = countingClient((p) => `echo:${p}`);
    const dir = tempCacheDir();
    const cached = new CachedChatClient(client, dir);
    await cached.complete('p');
    await cached.complete('p', { temperature: 0 });
    await cached.complete('q');
    expect(state.calls).toBe(3);
    const other = new CachedChatClient(countingClient(() => 'x', 'other-model').client, dir);
    await other.complete('p');
    expect(other.misses).toBe(1);
  });

  it('treats an omitted options object the same as {} for the key', async () => {
    const { client, state } = countingClient(() => 'same');
    const cached = new CachedChatClient(client, tempCacheDir());
    await cached.complete('p');
    await cached.complete('p', {});
    expect(state.calls).toBe(1);
    expect(cached.hits).toBe(1);
  });

  it('never caches a thrown call', async () => {
    let calls = 0;
    const flaky: ChatClient = {
      model: 'm',
      async complete(): Promise<ChatResult> {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { text: 'recovered', json: undefined, elapsedSec: 0.1 };
      },
    };
    const dir = tempCacheDir();
    const cached = new CachedChatClient(flaky, dir);
    await expect(cached.complete('p')).rejects.toThrow('boom');
    expect(readdirSync(dir)).toEqual([]);
    await expect(cached.complete('p')).resolves.toMatchObject({ text: 'recovered' });
    expect(calls).toBe(2);
  });

  it('never caches an empty or whitespace-only reply', async () => {
    const { client, state } = countingClient(() => '   \n\t ');
    const dir = tempCacheDir();
    const cached = new CachedChatClient(client, dir);
    await cached.complete('p');
    expect(readdirSync(dir)).toEqual([]);
    await cached.complete('p');
    expect(state.calls).toBe(2); // second call must reach the inner client again
  });

  it('treats a corrupt cache file as a miss, not an error', async () => {
    const { client, state } = countingClient(() => 'fresh');
    const dir = tempCacheDir();
    const key = sha256Hex(`test-model\np\n${JSON.stringify({})}`);
    writeFileSync(join(dir, `${key}.json`), 'not json at all');
    const cached = new CachedChatClient(client, dir);
    await expect(cached.complete('p')).resolves.toMatchObject({ text: 'fresh' });
    expect(state.calls).toBe(1);
    expect(cached.misses).toBe(1);
    // The bad entry was replaced by the fresh result.
    expect(JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8'))).toEqual({ version: 1, text: 'fresh' });
  });

  it('treats a wrong-shape cache file (bad version / empty text) as a miss', async () => {
    const { client, state } = countingClient(() => 'fresh');
    const dir = tempCacheDir();
    const key = sha256Hex(`test-model\np\n${JSON.stringify({})}`);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ version: 99, text: 'stale' }));
    const cached = new CachedChatClient(client, dir);
    await expect(cached.complete('p')).resolves.toMatchObject({ text: 'fresh' });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ version: 1, text: '' }));
    await expect(cached.complete('p')).resolves.toMatchObject({ text: 'fresh' });
    expect(state.calls).toBe(2);
  });

  it('passes through usage() when the inner client has one', async () => {
    const withUsage = Object.assign(countingClient(() => 'x').client, {
      usage: () => ({ calls: 7 }),
    });
    const cached = new CachedChatClient(withUsage, tempCacheDir());
    expect(cached.usage?.()).toEqual({ calls: 7 });
    const bare = new CachedChatClient(countingClient(() => 'x').client, tempCacheDir());
    expect(bare.usage).toBeUndefined();
  });
});
