import { describe, expect, it } from 'vitest';
import type { Node } from 'web-tree-sitter';
import { createParser } from './languages.js';
import { collectLineSpans, descendantsOfType, walk } from './tsx-util.js';

/** Reference recursive pre-order traversal to pin down `walk`'s visit order. */
function recursivePreorder(node: Node, out: string[]): void {
  out.push(node.type);
  for (const child of node.namedChildren) if (child) recursivePreorder(child, out);
}

describe('tsx-util walk — adversarial deep-nesting (pass 2)', () => {
  it('visits nodes in the exact same pre-order as a recursive traversal', async () => {
    const parser = await createParser('python');
    const tree = parser.parse(
      'class C:\n    def m(self, x):\n        return f(g(x), h())\n\ndef top():\n    return 1\n',
    );
    const reference: string[] = [];
    recursivePreorder(tree!.rootNode, reference);
    const got: string[] = [];
    walk(tree!.rootNode, (n) => {
      got.push(n.type);
    });
    expect(got).toEqual(reference);
  });

  it('honors `return false` to skip a node’s children (and only that subtree)', async () => {
    const parser = await createParser('python');
    const tree = parser.parse('def a():\n    return inner_call()\n\ndef b():\n    return 2\n');
    const visited: string[] = [];
    walk(tree!.rootNode, (n) => {
      visited.push(n.type);
      if (n.type === 'function_definition') return false; // skip function bodies
    });
    // both function_definitions are visited, but neither body's `call`/`inner_call` is
    expect(visited.filter((t) => t === 'function_definition')).toHaveLength(2);
    expect(visited).not.toContain('call');
  });

  it('does NOT stack-overflow on a pathologically deep tree (was recursive)', async () => {
    // 40k nested parens → a 40k-deep tree. The old recursive walk blew the JS
    // call stack here; the iterative walk must not.
    const depth = 40000;
    const parser = await createParser('python');
    const tree = parser.parse(`${'('.repeat(depth)}1${')'.repeat(depth)}\n`);
    let count = 0;
    expect(() =>
      walk(tree!.rootNode, () => {
        count += 1;
      }),
    ).not.toThrow();
    expect(count).toBeGreaterThan(depth);
  });

  it('collectLineSpans and descendantsOfType are stack-safe on deep trees', async () => {
    const depth = 30000;
    const parser = await createParser('python');
    const tree = parser.parse(`def f():\n    return ${'g('.repeat(depth)}1${')'.repeat(depth)}\n`);
    expect(() => collectLineSpans(tree!.rootNode)).not.toThrow();
    expect(descendantsOfType(tree!.rootNode, 'call')).toHaveLength(depth);
  });
});
