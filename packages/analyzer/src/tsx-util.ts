/** Small helpers over web-tree-sitter syntax nodes shared by all adapters. */
import type { Node } from 'web-tree-sitter';

/** Pre-order walk. Return `false` from `visit` to skip a node's children. */
export function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) {
    if (child) walk(child, visit);
  }
}

/** All descendants (pre-order) whose type is in `types`. */
export function descendantsOfType(node: Node, ...types: string[]): Node[] {
  const wanted = new Set(types);
  const hits: Node[] = [];
  walk(node, (n) => {
    if (wanted.has(n.type)) hits.push(n);
  });
  return hits;
}

/** First named child with the given type, if any. */
export function firstOfType(node: Node, ...types: string[]): Node | undefined {
  for (const child of node.namedChildren) {
    if (child && types.includes(child.type)) return child;
  }
  return undefined;
}

export function fieldText(node: Node, field: string): string {
  return node.childForFieldName(field)?.text ?? '';
}

/** 1-based start line. */
export function lineStart(node: Node): number {
  return node.startPosition.row + 1;
}

/** 1-based end line. */
export function lineEnd(node: Node): number {
  return node.endPosition.row + 1;
}

/** Every named node's 1-based (start, end) line span, deduped and sorted. */
export function collectLineSpans(body: Node): Array<[number, number]> {
  const spans = new Set<string>();
  walk(body, (n) => {
    spans.add(`${lineStart(n)}:${lineEnd(n)}`);
  });
  return [...spans]
    .map((s) => s.split(':').map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
