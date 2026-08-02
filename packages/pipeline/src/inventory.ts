/**
 * Deterministic per-file function inventory derived from the call graph.
 * These are the FACTS merged into deep cards — the LLM adds prose, never facts.
 */
import type { CodeGraph, FunctionNote } from '@handbook/core';
import { isInternalNode, truncate } from '@handbook/core';

const REL_CAP = 25;

/** Structural part of a {@link FunctionNote} (prose fields left empty). */
export function buildInventory(graph: CodeGraph): Record<string, FunctionNote[]> {
  const calls = new Map<string, string[]>();
  const calledBy = new Map<string, string[]>();
  const extCalls = new Map<string, string[]>();

  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key) ?? [];
    if (list.length < REL_CAP && !list.includes(value)) list.push(value);
    map.set(key, list);
  };

  for (const edge of graph.edges) {
    const caller = graph.nodes[edge.callerId];
    if (!caller || !isInternalNode(caller)) continue;
    if (edge.callerId === edge.calleeId) continue;
    const callee = graph.nodes[edge.calleeId];
    if (callee && isInternalNode(callee)) {
      push(calls, edge.callerId, edge.calleeId);
      push(calledBy, edge.calleeId, edge.callerId);
    } else {
      const qual = callee?.qualname ?? edge.calleeId.replace(/^boundary:/, '');
      push(extCalls, edge.callerId, qual);
    }
  }

  const byFile: Record<string, FunctionNote[]> = {};
  for (const node of Object.values(graph.nodes)) {
    if (!isInternalNode(node) || node.synthetic || node.lineStart <= 0) continue;
    const note: FunctionNote = {
      id: node.id,
      qualname: node.qualname,
      name: node.name,
      className: node.className,
      lineRange: [node.lineStart, node.lineEnd],
      signature: truncate(node.signature, 200),
      calls: calls.get(node.id) ?? [],
      calledBy: calledBy.get(node.id) ?? [],
      extCalls: extCalls.get(node.id) ?? [],
      nCalls: (calls.get(node.id) ?? []).length,
      nCalledBy: (calledBy.get(node.id) ?? []).length,
      nExtCalls: (extCalls.get(node.id) ?? []).length,
      purpose: '',
      dataFlow: '',
      relations: '',
    };
    (byFile[node.file] ??= []).push(note);
  }
  for (const notes of Object.values(byFile)) {
    notes.sort((a, b) => a.lineRange[0] - b.lineRange[0]);
  }
  return byFile;
}
