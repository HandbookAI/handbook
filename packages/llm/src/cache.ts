/**
 * Disk-backed caching decorator for {@link ChatClient}.
 *
 * Phases 2a/2b/2c re-ask identical prompts on every re-run; wrapping the real
 * client in {@link CachedChatClient} makes those re-runs free without any phase
 * knowing a cache exists. The key covers model, prompt and options, so a model
 * switch or a temperature change never serves stale text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractJsonBlock, sha256Hex, writeFileAtomic } from '@handbook/core';
import type { ChatClient, ChatOptions, ChatResult } from './client.js';

/** On-disk entry shape; bump the version to invalidate every existing entry. */
const CACHE_VERSION = 1;

interface CacheEntry {
  version: typeof CACHE_VERSION;
  text: string;
}

/** Parse a cache file's content; anything unusable is a miss, never an error. */
function parseEntry(raw: string): CacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = parsed as Record<string, unknown>;
  // An empty `text` must never be served: the same rule as narrate's prose
  // cache — a blank reply pinned under a stable key poisons every future run.
  if (entry.version !== CACHE_VERSION || typeof entry.text !== 'string' || entry.text.trim() === '') {
    return undefined;
  }
  return { version: CACHE_VERSION, text: entry.text };
}

export class CachedChatClient implements ChatClient {
  readonly model: string;
  /** Present only when the inner client reports usage, so callers that
   * type-guard for an optional `usage()` see the truth through the decorator. */
  readonly usage?: () => unknown;
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private readonly inner: ChatClient,
    private readonly cacheDir: string,
  ) {
    this.model = inner.model;
    const maybeUsage = (inner as { usage?: unknown }).usage;
    if (typeof maybeUsage === 'function') {
      this.usage = () => (maybeUsage as () => unknown).call(inner);
    }
  }

  get hits(): number {
    return this.hitCount;
  }

  get misses(): number {
    return this.missCount;
  }

  async complete(prompt: string, options?: ChatOptions): Promise<ChatResult> {
    // A signal identifies a RUN, never an answer: it is stripped from the key
    // (or the same prompt would miss on every new run) but still honored — an
    // already-cancelled call must not serve a hit — and passed to the inner
    // client so a miss's real request stays abortable.
    const { signal, ...keyedOptions } = options ?? {};
    signal?.throwIfAborted();
    const key = sha256Hex(`${this.inner.model}\n${prompt}\n${JSON.stringify(keyedOptions)}`);
    const path = join(this.cacheDir, `${key}.json`);

    let raw: string | undefined;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      raw = undefined; // missing file — the ordinary miss
    }
    const entry = raw === undefined ? undefined : parseEntry(raw);
    if (entry) {
      this.hitCount += 1;
      return { text: entry.text, json: extractJsonBlock(entry.text), elapsedSec: 0 };
    }

    this.missCount += 1;
    // A thrown call propagates uncached: retries/fallbacks stay the inner
    // client's business, and a transient failure must not become permanent.
    const result = await this.inner.complete(prompt, options);
    // Only successful, non-empty text is cached (empty replies burned this
    // repo before — see the identical rule in the narration cache).
    if (result.text.trim() !== '') {
      const stored: CacheEntry = { version: CACHE_VERSION, text: result.text };
      // A cache is an optimization, never a dependency: a write that fails
      // (cacheDir is a file, the disk is full, the dir is unwritable, the
      // rename races another writer) must NOT turn a paid-for success into a
      // failure. The read side already swallows every error as a miss; the
      // write side must be just as transparent, or the very re-runs the cache
      // exists to speed up would instead crash on a read-only cache directory.
      try {
        writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);
      } catch {
        // best-effort: the next run simply re-asks instead of serving a hit
      }
    }
    return result;
  }
}
