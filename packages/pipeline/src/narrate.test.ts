import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJsonBlock } from '@handbook/core';
import { MockChatClient } from '@handbook/llm';
import { extractRegisters, parseRegisterLines } from './narrate.js';
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
        respond: [{ name: 'reg-parser-cache', description: 'cached parsers', stages: ['stage-1'] }],
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

describe('parseRegisterLines', () => {
  it('reads the plain-text list a model sometimes answers with', () => {
    const reply = [
      '好的，我找到这些状态：',
      '- reg-telemetry-buffer: 遥测缓冲：累积各阶段的运行时指标，批量落盘。',
      '* `reg_job_queue` — 待执行任务队列，同一仓库不并发。',
      '2) reg-parser-cache: tree-sitter 解析器实例缓存。',
      '',
      '以上就是全部。',
    ].join('\n');
    expect(parseRegisterLines(reply)).toEqual([
      { id: 'reg-telemetry-buffer', semantics: '遥测缓冲：累积各阶段的运行时指标，批量落盘。' },
      { id: 'reg-job-queue', semantics: '待执行任务队列，同一仓库不并发。' },
      { id: 'reg-parser-cache', semantics: 'tree-sitter 解析器实例缓存。' },
    ]);
  });

  it('does not turn prose into registers', () => {
    const prose = [
      'The system keeps state in several places: the queue, the cache and the log.',
      '- the job queue: holds work',
      '- reg-x: holds one thing',
      'reg-only-an-id',
      '- reg-short: no', // too short to be a description
    ].join('\n');
    expect(parseRegisterLines(prose)).toEqual([{ id: 'reg-x', semantics: 'holds one thing' }]);
  });

  it('keeps the first definition of a repeated id', () => {
    expect(parseRegisterLines('- reg-a: first one here\n- reg-a: second one here')).toEqual([
      { id: 'reg-a', semantics: 'first one here' },
    ]);
  });
});

describe('extractRegisters caching', () => {
  const cacheNarration = {
    version: 1,
    lang: 'en',
    systemOverview: 'o',
    stageSummaries: Object.fromEntries(skeleton.stages.map((s) => [s.id, 'summary'])),
  } as Narration;

  function client(reply: string): { client: Parameters<typeof extractRegisters>[0]; calls: () => number } {
    let calls = 0;
    return {
      client: {
        model: 'test',
        async complete() {
          calls += 1;
          return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 };
        },
      },
      calls: () => calls,
    };
  }

  it('never remembers an empty result as an answer', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'hb-reg-'));
    const empty = client('nothing usable here');
    const first = await extractRegisters(
      empty.client,
      skeleton,
      cacheNarration,
      {},
      { cacheDir, maxRounds: 1 },
    );
    expect(first).toEqual([]);

    // A later run must ASK AGAIN rather than replay the failure.
    const good = client('```json\n{"registers":[{"id":"reg-a","semantics":"holds the queue"}]}\n```');
    const second = await extractRegisters(
      good.client,
      skeleton,
      cacheNarration,
      {},
      { cacheDir, maxRounds: 1 },
    );
    expect(second).toHaveLength(1);
    expect(good.calls()).toBeGreaterThan(0);
  });

  it('does reuse a non-empty result', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'hb-reg-'));
    const good = client('```json\n{"registers":[{"id":"reg-a","semantics":"holds the queue"}]}\n```');
    await extractRegisters(good.client, skeleton, cacheNarration, {}, { cacheDir, maxRounds: 1 });
    const before = good.calls();
    const again = await extractRegisters(
      good.client,
      skeleton,
      cacheNarration,
      {},
      { cacheDir, maxRounds: 1 },
    );
    expect(again).toHaveLength(1);
    expect(good.calls()).toBe(before); // served from cache
  });
});

describe('extractRegisters field-name tolerance', () => {
  const narration = {
    version: 1,
    lang: 'zh',
    systemOverview: 'o',
    stageSummaries: Object.fromEntries(skeleton.stages.map((s) => [s.id, 'summary'])),
  } as Narration;

  function client(reply: string) {
    return {
      model: 'test',
      async complete() {
        return { text: reply, json: extractJsonBlock(reply), elapsedSec: 0 };
      },
    };
  }

  it('reads `semantic` (singular) — the shape a live endpoint actually sent', async () => {
    const reply = [
      '```json',
      '[{"id":"reg-env-config","semantic":"环境配置与运行参数","stages":[]}]',
      '```',
    ].join('\n');
    const out = await extractRegisters(client(reply), skeleton, narration, {}, { maxRounds: 1, lang: 'zh' });
    expect(out).toEqual([{ id: 'reg-env-config', semantics: '环境配置与运行参数', stages: [] }]);
  });

  it('never drops an entry silently', async () => {
    const warnings: string[] = [];
    const logger = {
      info: () => {},
      warn: (m: string) => {
        warnings.push(m);
      },
      error: () => {},
      debug: () => {},
      child: () => logger,
    };
    const reply = ['```json', '[{"id":"reg-ok","note":"prose under a key nobody reads"}]', '```'].join('\n');
    const out = await extractRegisters(client(reply), skeleton, narration, {}, { maxRounds: 1, logger });
    expect(out).toEqual([]);
    expect(warnings.join(' ')).toMatch(/dropped 1\/1 entr\(ies\) the model did send/);
  });
});
