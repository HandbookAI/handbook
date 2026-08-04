/**
 * Adversarial pass 2 — normalizeSkeleton must stay near-linear on large inputs.
 *
 * The parent-cycle walk used to resolve every hop with a linear `stages.find`,
 * making normalization O(n³): a 3000-stage skeleton (a hostile `--skeleton`
 * file, or a runaway hallucinated one) took ~12s for a deep chain and ~25s for
 * a giant cycle — enough to hang a run or a studio request. With id lookups
 * routed through a Map it is O(n²) and completes in well under a second.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSkeleton } from './skeleton.js';

describe('normalizeSkeleton — bounded time on large skeletons', () => {
  it('normalizes a 3000-stage GIANT CYCLE quickly, breaks the cycle, and drops no stage', () => {
    const n = 3000;
    // stage-i's parent is stage-(i+1); stage-(n-1) wraps back to stage-0 → one
    // big cycle through every node. This is the O(n³) worst case pre-fix.
    const stages = Array.from({ length: n }, (_, i) => ({
      id: `stage-${i}`,
      title: `T${i}`,
      description: 'x',
      parent: `stage-${(i + 1) % n}`,
    }));

    const started = Date.now();
    const skeleton = normalizeSkeleton({ stages });
    const elapsed = Date.now() - started;

    // Pre-fix this took ~25s (and blew the default 5s test timeout); post-fix
    // it is a couple hundred ms. A generous ceiling keeps CI machines happy.
    expect(elapsed).toBeLessThan(4000);
    // No stage lost.
    expect(skeleton.stages).toHaveLength(n);
    // The cycle is broken: walking parents from every node terminates at a root
    // without revisiting a node. (Plain-JS walk — no per-hop `expect`, which at
    // ~n² hops would itself dominate the runtime.)
    const byId = new Map(skeleton.stages.map((s) => [s.id, s]));
    let roots = 0;
    let residualCycle: string | null = null;
    for (const start of skeleton.stages) {
      const seen = new Set<string>([start.id]);
      let cursor = start.parent;
      while (cursor !== null) {
        if (seen.has(cursor)) {
          residualCycle = cursor;
          break;
        }
        seen.add(cursor);
        cursor = byId.get(cursor)?.parent ?? null;
      }
      if (start.parent === null) roots += 1;
      if (residualCycle) break;
    }
    expect(residualCycle, `residual cycle reached ${residualCycle}`).toBeNull();
    expect(roots).toBeGreaterThan(0); // at least one detached root exists
  }, 20000);

  it('normalizes a 3000-stage deep LINEAR chain quickly and keeps parents intact', () => {
    const n = 3000;
    const stages = Array.from({ length: n }, (_, i) => ({
      id: `stage-${i}`,
      title: `T${i}`,
      description: 'x',
      parent: i === 0 ? null : `stage-${i - 1}`,
    }));
    const started = Date.now();
    const skeleton = normalizeSkeleton({ stages });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(skeleton.stages).toHaveLength(n);
    // The acyclic chain is legal, so parents are preserved (root aside).
    expect(skeleton.stages[0]?.parent).toBeNull();
    expect(skeleton.stages[1]?.parent).toBe('stage-0');
    expect(skeleton.stages.at(-1)?.parent).toBe(`stage-${n - 2}`);
    // children back-links were built.
    expect(skeleton.stages[0]?.children).toEqual(['stage-1']);
  }, 20000);
});
