import { describe, expect, it } from 'vitest';
import { actorCriticLoop, parseVerdict } from './critic.js';
import { MockChatClient } from './mock.js';

const approve = { decision: 'APPROVE', concerns: [], suggested_revision: null, rationale: 'ok' };
const reject = { decision: 'REJECT', concerns: ['bad'], suggested_revision: null, rationale: 'no' };

describe('parseVerdict', () => {
  it('parses and uppercases decisions', () => {
    expect(parseVerdict({ decision: 'approve', concerns: [] })?.decision).toBe('APPROVE');
  });

  it('normalizes a vacuous REVISE to APPROVE', () => {
    const v = parseVerdict({ decision: 'REVISE', concerns: [] });
    expect(v?.decision).toBe('APPROVE');
  });

  it('rejects unknown decisions and non-object revisions', () => {
    expect(parseVerdict({ decision: 'MAYBE' })).toBeUndefined();
    expect(parseVerdict({ decision: 'APPROVE', suggested_revision: 'yes' })).toBeUndefined();
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
