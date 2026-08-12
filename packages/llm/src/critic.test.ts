import { describe, expect, it } from 'vitest';
import { actorCriticLoop, parseVerdict } from './critic.js';
import { MockChatClient } from './mock.js';
import type { ChatClient, ChatResult } from './client.js';

const approve = { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'ok' };
const reject = { decision: 'REJECT', concerns: ['bad'], suggested_revision: null, rationale: 'no' };
const revise = { decision: 'REVISE', concerns: ['tighten it'], suggested_revision: null, rationale: '' };

describe('parseVerdict', () => {
  it('parses and uppercases decisions', () => {
    expect(parseVerdict({ decision: 'approve', concerns: [] })?.decision).toBe('APPROVE');
  });

  it('normalizes a vacuous REVISE to APPROVE', () => {
    const v = parseVerdict({ decision: 'REVISE', concerns: [] });
    expect(v?.decision).toBe('APPROVE');
  });

  it('rejects an unknown decision — that really is an unreadable verdict', () => {
    expect(parseVerdict({ decision: 'MAYBE' })).toBeUndefined();
  });

  it('does NOT reject a readable decision over the shape of suggested_revision', () => {
    // This assertion used to require `undefined` here, and that expectation was
    // the bug: the decision is perfectly readable, so voiding the review (which
    // counts as REJECT) throws away a real critic over a field the actor can
    // simply ignore. See the regression block at the end of this file.
    const verdict = parseVerdict({ decision: 'APPROVE', suggested_revision: 'yes' });
    expect(verdict?.decision).toBe('APPROVE');
    expect(verdict?.suggestedRevision).toBeNull();
  });
});

describe('actorCriticLoop', () => {
  it('accepts when all critics approve', async () => {
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: approve },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', {
      roles: ['engineer', 'architect'],
      taskContext: 'test',
    });
    expect(result.accepted).toBe(true);
    expect(result.proposal).toEqual({ plan: 1 });
  });

  it('discards on REJECT', async () => {
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: reject },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', { taskContext: 'test' });
    expect(result.accepted).toBe(false);
    expect(result.proposal).toBeUndefined();
  });

  it('runs a revision round on REVISE and accepts the revision', async () => {
    let review = 0;
    const client = new MockChatClient([
      {
        match: 'Proposal under review',
        respond: () => {
          review += 1;
          return review === 1
            ? { decision: 'REVISE', concerns: ['tighten it'], suggested_revision: null, rationale: '' }
            : approve;
        },
      },
      { match: "REVIEWER'S CONCERNS", respond: { plan: 2 } },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', { taskContext: 'test' });
    expect(result.accepted).toBe(true);
    expect(result.proposal).toEqual({ plan: 2 });
    expect(result.rounds).toBe(2);
  });

  it('treats a broken critic as REJECT', async () => {
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: 'not json at all' },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', { taskContext: 'test' });
    expect(result.accepted).toBe(false);
  });

  it('accepts vacuously with an empty critic panel instead of crashing', async () => {
    // roles: [] makes `criticConcurrency ?? roles.length` resolve to 0, which
    // used to hit pLimit(0) and throw a RangeError mid-pipeline.
    const client = new MockChatClient([{ match: 'ACTOR', respond: { plan: 1 } }]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', { roles: [], taskContext: 'test' });
    expect(result.accepted).toBe(true);
    expect(result.proposal).toEqual({ plan: 1 });
    expect(result.verdicts).toEqual([]);
  });

  it('tolerates criticConcurrency: 0 instead of crashing', async () => {
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: approve },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', {
      roles: ['engineer', 'architect'],
      criticConcurrency: 0,
      taskContext: 'test',
    });
    expect(result.accepted).toBe(true);
    expect(result.proposal).toEqual({ plan: 1 });
  });

  it('tolerates a non-integer / non-finite criticConcurrency instead of a RangeError', async () => {
    // Math.max(1, x) alone leaves NaN as NaN, 2.5 as 2.5 and Infinity as
    // Infinity — every one of which pLimit rejects with a RangeError, crashing
    // the whole loop. Each must be sanitized to a positive integer.
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: approve },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    for (const criticConcurrency of [NaN, 2.5, Infinity, -3, 1.999]) {
      const result = await actorCriticLoop(client, 'ACTOR: propose', {
        roles: ['engineer', 'architect', 'reader'],
        criticConcurrency,
        taskContext: 'test',
      });
      expect(result.accepted).toBe(true);
      expect(result.proposal).toEqual({ plan: 1 });
    }
  });

  it('terminates on an always-REVISE panel even with an absurd maxReviseRounds', async () => {
    // Infinity revise rounds + a critic that never stops asking for changes is
    // an infinite loop unless the round count is clamped to a finite integer.
    let revision = 0;
    const client = new MockChatClient([
      {
        match: 'Proposal under review',
        respond: { decision: 'REVISE', concerns: ['keep going'], suggested_revision: null, rationale: '' },
      },
      { match: "REVIEWER'S CONCERNS", respond: () => ({ plan: (revision += 1) }) },
      { match: 'ACTOR', respond: { plan: 0 } },
    ]);
    const result = await actorCriticLoop(client, 'ACTOR: propose', {
      taskContext: 'test',
      maxReviseRounds: Infinity,
    });
    // A lingering REVISE after the (clamped) last round ships the latest
    // revision; the point is that it TERMINATES with a bounded round count.
    expect(result.rounds).toBeLessThan(10);
  }, 10_000);
});

describe('actorCriticLoop — cancellation', () => {
  it('threads the signal into the actor call and every critic call', async () => {
    const client = new MockChatClient([
      { match: 'Proposal under review', respond: approve },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const controller = new AbortController();
    await actorCriticLoop(client, 'ACTOR: propose', {
      roles: ['engineer', 'architect'],
      taskContext: 'test',
      signal: controller.signal,
    });
    expect(client.calls).toHaveLength(3); // one actor, two critics
    expect(client.calls.every((c) => c.options?.signal === controller.signal)).toBe(true);
  });

  it('rejects a pre-aborted loop without asking the actor', async () => {
    const client = new MockChatClient([{ match: 'ACTOR', respond: { plan: 1 } }]);
    const controller = new AbortController();
    controller.abort();
    const error = await actorCriticLoop(client, 'ACTOR: propose', {
      taskContext: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(client.calls).toHaveLength(0);
  });

  it('does not swallow an aborted actor call as "actor call failed"', async () => {
    // `catch → return undefined` reported a cancelled run as a proposal that
    // simply did not arrive: `{accepted: false}` is a verdict on the PROPOSAL,
    // and the doctor round above it counts that as a clean no-op round.
    const controller = new AbortController();
    const client: ChatClient = {
      model: 'aborting',
      async complete(): Promise<ChatResult> {
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error('unreachable');
      },
    };
    const error = await actorCriticLoop(client, 'ACTOR: propose', {
      taskContext: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });

  it('does not swallow an aborted critic call as a REJECT verdict', async () => {
    // An AbortError is not a broken reviewer. Counting it as REJECT discards the
    // proposal and returns normally, so a cancelled run reads as "the panel said
    // no" — a real answer, which something downstream then acts on.
    const controller = new AbortController();
    let call = 0;
    const client: ChatClient = {
      model: 'aborting',
      async complete(): Promise<ChatResult> {
        call += 1;
        if (call === 1) return { text: '```json\n{"plan":1}\n```', json: { plan: 1 }, elapsedSec: 0 };
        controller.abort();
        controller.signal.throwIfAborted();
        throw new Error('unreachable');
      },
    };
    const error = await actorCriticLoop(client, 'ACTOR: propose', {
      roles: ['engineer'],
      taskContext: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });

  it('never starts a queued critic once the signal has fired', async () => {
    // The panel is a fan-out through pLimit. A queued critic that starts anyway
    // is a model call bought by a run that was cancelled before it was queued.
    const controller = new AbortController();
    const client = new MockChatClient([
      {
        match: 'Proposal under review',
        respond: () => {
          controller.abort();
          return approve;
        },
      },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const error = await actorCriticLoop(client, 'ACTOR: propose', {
      roles: ['engineer', 'architect', 'reader'],
      criticConcurrency: 1,
      taskContext: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(client.calls).toHaveLength(2); // the actor and exactly one critic
  });

  it('stops between rounds instead of buying another revision', async () => {
    const controller = new AbortController();
    const client = new MockChatClient([
      {
        match: 'Proposal under review',
        respond: () => {
          controller.abort();
          return revise;
        },
      },
      { match: "REVIEWER'S CONCERNS", respond: { plan: 2 } },
      { match: 'ACTOR', respond: { plan: 1 } },
    ]);
    const error = await actorCriticLoop(client, 'ACTOR: propose', {
      taskContext: 'test',
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    // The revision actor call must never have been made.
    expect(client.calls.some((c) => c.prompt.includes("REVIEWER'S CONCERNS"))).toBe(false);
  });
});

describe('parseVerdict — bounded input', () => {
  it('caps how many concerns one verdict can carry, and says it did', () => {
    const verdict = parseVerdict({
      decision: 'REVISE',
      concerns: Array.from({ length: 500 }, (_, i) => `concern ${i}`),
    });
    expect(verdict?.concerns).toHaveLength(50);
    expect(verdict?.concerns[0]).toBe('concern 0');
    expect(verdict?.rationale).toContain('450');
  });

  it('caps the length of a single concern', () => {
    const verdict = parseVerdict({ decision: 'REVISE', concerns: ['c'.repeat(10_000)] });
    expect(verdict?.concerns[0]?.length).toBeLessThanOrEqual(2_000);
  });

  it('leaves the concerns of an ordinary verdict exactly as written', () => {
    const verdict = parseVerdict({ decision: 'REVISE', concerns: ['a', 'b'] });
    expect(verdict?.concerns).toEqual(['a', 'b']);
    expect(verdict?.rationale).toBe('');
  });
});

describe('parseVerdict shape tolerance', () => {
  it('accepts the alternative key names models use', () => {
    for (const key of ['decision', 'verdict', 'judgement', 'judgment', 'status']) {
      expect(parseVerdict({ [key]: 'approve' })?.decision).toBe('APPROVE');
    }
  });

  it('reads a reply that is only a decision word', () => {
    expect(parseVerdict(undefined, 'APPROVE')?.decision).toBe('APPROVE');
    expect(parseVerdict(undefined, 'decision: REJECT')?.decision).toBe('REJECT');
    expect(parseVerdict(undefined, '**Decision:** APPROVE.')?.decision).toBe('APPROVE');
    // A bare REVISE has no concerns to act on — same rule as the JSON path.
    expect(parseVerdict(undefined, 'REVISE')?.decision).toBe('APPROVE');
  });

  it('refuses to read a decision out of prose', () => {
    expect(parseVerdict(undefined, 'I would not approve this proposal.')).toBeUndefined();
    expect(parseVerdict(undefined, 'APPROVE the first part but REJECT the second')).toBeUndefined();
    expect(parseVerdict(undefined, 'Looks fine to me')).toBeUndefined();
    expect(parseVerdict(undefined, '')).toBeUndefined();
  });
});

describe('parseVerdict — an unusable suggested_revision must not void the review', () => {
  /**
   * Observed against a real endpoint: all three critics answered
   * `{decision:"REVISE", concerns:[…real…], suggested_revision:"<prose>", rationale}`
   * and every one was logged as "unparseable verdict … treating as REJECT".
   * The panel therefore never accepted anything, `runDoctorRound` returned all
   * zeros, and the doctor loop reported `applied=0 rejected=0` twice and gave
   * up with all 33 files still unassigned. The verdict was fine; only the
   * revision field was the wrong shape.
   */
  it('keeps a REVISE whose suggested_revision is prose, and preserves the prose', () => {
    const verdict = parseVerdict({
      decision: 'REVISE',
      concerns: ['barrel files are not tests'],
      suggested_revision: 'move analyzer/src/index.ts out of test_suites',
      rationale: 'r',
    });
    expect(verdict?.decision).toBe('REVISE');
    expect(verdict?.suggestedRevision).toBeNull();
    // Nothing the critic said is dropped — the prose becomes a concern.
    expect(verdict?.concerns).toEqual([
      'barrel files are not tests',
      'move analyzer/src/index.ts out of test_suites',
    ]);
  });

  it('keeps a verdict whose suggested_revision is a number or an array', () => {
    for (const suggested of [0, [{ a: 1 }], true]) {
      const verdict = parseVerdict({ decision: 'REVISE', concerns: ['c'], suggested_revision: suggested });
      expect(verdict?.decision, JSON.stringify(suggested)).toBe('REVISE');
      // An array is not an applicable revision either, even though
      // `typeof [] === 'object'` used to let it through.
      expect(verdict?.suggestedRevision, JSON.stringify(suggested)).toBeNull();
    }
  });

  it('still uses a genuine object revision', () => {
    const verdict = parseVerdict({
      decision: 'REVISE',
      concerns: ['c'],
      suggested_revision: { changes: [] },
    });
    expect(verdict?.suggestedRevision).toEqual({ changes: [] });
  });
});
