import { describe, expect, it } from 'vitest';
import { MockChatClient } from '@handbook/llm';
import { extractRegisters } from './narrate.js';
import type { Narration, Skeleton } from '@handbook/core';

const skeleton: Skeleton = {
  metadata: { version: 1 },
  stages: [
    { id: 'stage-1', title: 'A', description: 'a', parent: null, children: [], crosscut: false },
    { id: 'stage-2', title: 'B', description: 'b', parent: null, children: [], crosscut: false },
  ],
};
const narration: Narration = {
  version: 1,
  lang: 'en',
  systemOverview: 'x',
  stageSummaries: { 'stage-1': 's1', 'stage-2': 's2' },
};

describe('extractRegisters — id coercion (real-endpoint feedback)', () => {
  it('normalizes underscore/prefixless ids instead of dropping them', async () => {
    const client = new MockChatClient([
      {
        match: 'STATE REGISTERS',
        respond: {
          registers: [
            { id: 'reg_task_queue', semantics: 'underscores', stages: ['stage-1'] },
            { id: 'Shared Config', semantics: 'no prefix', stages: ['stage-2'] },
            { id: '###', semantics: 'hopeless', stages: [] },
          ],
        },
      },
      { match: 'COMPLETING a list', respond: { registers: [] } },
    ]);
    const registers = await extractRegisters(client, skeleton, narration, {});
    expect(registers.map((r) => r.id).sort()).toEqual(['reg-shared-config', 'reg-task-queue']);
  });

  it('accepts a top-level array with name/description entries', async () => {
    const client = new MockChatClient([
      {
        match: 'STATE REGISTERS',
        respond: [
          { name: 'reg-parser-cache', description: 'cached parsers', stages: ['stage-1'] },
        ],
      },
      { match: 'COMPLETING a list', respond: [] },
    ]);
    const registers = await extractRegisters(client, skeleton, narration, {});
    expect(registers).toEqual([{ id: 'reg-parser-cache', semantics: 'cached parsers', stages: ['stage-1'] }]);
  });
});

describe('extractRegisters — stage-fill pass', () => {
  it('fills empty stage lists via the menu-constrained mapping call', async () => {
    const client = new MockChatClient([
      {
        match: 'STATE REGISTERS',
        respond: [{ name: 'reg-cache', description: 'a cache' }], // shape without stages
      },
      { match: 'COMPLETING a list', respond: [] },
      {
        match: 'WHICH of the given stages',
        respond: { assignments: [{ id: 'reg-cache', stages: ['stage-2', 'stage-ghost'] }] },
      },
    ]);
    const registers = await extractRegisters(client, skeleton, narration, {});
    expect(registers).toEqual([{ id: 'reg-cache', semantics: 'a cache', stages: ['stage-2'] }]);
  });
});
