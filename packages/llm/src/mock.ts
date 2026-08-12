/**
 * Deterministic, offline stand-in for {@link ChatClient}.
 *
 * A mock is a list of rules; the first rule whose matcher accepts the prompt
 * produces the response. Responses can be static strings/objects or functions
 * of the prompt, which is enough to script entire pipeline runs in tests.
 */
import type { ChatClient, ChatOptions, ChatResult } from './client.js';
import { extractJsonBlock } from '@handbooks/core';

export type MockResponse = string | object | ((prompt: string, callIndex: number) => string | object);

export interface MockRule {
  /** Substring or regex the prompt must match, or a predicate. */
  match: string | RegExp | ((prompt: string) => boolean);
  respond: MockResponse;
}

export interface RecordedCall {
  prompt: string;
  options: ChatOptions | undefined;
  responseText: string;
}

export class MockChatClient implements ChatClient {
  readonly model = 'mock';
  readonly calls: RecordedCall[] = [];

  constructor(
    private readonly rules: MockRule[],
    private readonly fallback?: MockResponse,
  ) {}

  async complete(prompt: string, options?: ChatOptions): Promise<ChatResult> {
    const rule = this.rules.find((r) => matches(r.match, prompt));
    const respond = rule?.respond ?? this.fallback;
    if (respond === undefined) {
      throw new Error(`MockChatClient: no rule matched prompt: ${prompt.slice(0, 120)}…`);
    }
    const raw = typeof respond === 'function' ? respond(prompt, this.calls.length) : respond;
    const text = typeof raw === 'string' ? raw : `\`\`\`json\n${JSON.stringify(raw, null, 2)}\n\`\`\``;
    this.calls.push({ prompt, options, responseText: text });
    return { text, json: extractJsonBlock(text), elapsedSec: 0 };
  }
}

function matches(matcher: MockRule['match'], prompt: string): boolean {
  if (typeof matcher === 'string') return prompt.includes(matcher);
  if (matcher instanceof RegExp) {
    // `.test()` on a global/sticky regex advances `lastIndex`, so the same
    // prompt would match on one call and miss on the next — the mock must be
    // deterministic. Reset the cursor before every test.
    matcher.lastIndex = 0;
    return matcher.test(prompt);
  }
  return matcher(prompt);
}
