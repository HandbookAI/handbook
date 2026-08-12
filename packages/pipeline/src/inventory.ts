/**
 * Deterministic per-file function inventory derived from the call graph.
 * These are the FACTS merged into deep cards — the LLM adds prose, never facts.
 */
import type { CodeGraph, FunctionNote, TypeNote } from '@handbooks/core';
import { isInternalNode, truncate } from '@handbooks/core';

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

/**
 * Per-file type inventory — the same deterministic FACTS, for `graph.types`.
 *
 * Returns `undefined`, not `{}`, when the graph carries no `types` field at all:
 * that means no adapter in the run extracts types, and an empty record would be
 * indistinguishable from "every scanned file happens to declare none". The cards
 * pass passes the distinction on by leaving `FileCard.types` off, and the
 * artifact discloses which languages were actually indexed from
 * `graph.metadata.languages`.
 *
 * A separate function from {@link buildInventory} rather than a second return
 * value, because the two have different callers: this one runs in brief mode too
 * (a type note has no prose to wait for), while the function inventory only
 * exists to be annotated.
 */
export function buildTypeInventory(graph: CodeGraph): Record<string, TypeNote[]> | undefined {
  if (!graph.types) return undefined;
  const byFile: Record<string, TypeNote[]> = {};
  for (const type of graph.types) {
    (byFile[type.file] ??= []).push({
      name: type.name,
      qualname: type.qualname,
      kind: type.kind,
      lineRange: [type.lineStart, type.lineEnd],
      // Capped exactly as a function signature is, and for the same reason: a
      // 4,000-character declaration is a fact nobody can read in a table cell.
      signature: truncate(type.signature, 200),
      container: type.container,
    });
  }
  for (const notes of Object.values(byFile)) {
    notes.sort((a, b) => a.lineRange[0] - b.lineRange[0]);
  }
  return byFile;
}
