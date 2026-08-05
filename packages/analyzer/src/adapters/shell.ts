/**
 * Shell adapter (tree-sitter grammar `bash`).
 *
 * Free-function model only: one function node per `function_definition`,
 * id `<moduleId>.<name>`. Every `command` inside a function body becomes an
 * edge: to the defining module when the name is a function defined in ANY
 * scanned file (first definition wins), else `boundary:<name>` — real
 * dependency info like "this script calls git/cargo".
 *
 * Shell has no classes and no type learning, so this adapter declares the
 * `generic` tier and only the two callTypes it can actually produce. SP6 raises
 * it to full fidelity.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge } from '@handbook/core';
import { truncate } from '@handbook/core';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import { SpineAdapter, type BaseScan, type LanguageSpec } from '../spine.js';

interface ModuleScan extends BaseScan {
  /** function id → its body node for pass 2. */
  fnContext: Map<string, Node>;
}

/** Global function-name index across all scanned files (first definition wins). */
type ShellIndexes = Map<string, string>;

export function moduleIdForFile(file: string): string {
  return file.replace(/\.(sh|bash)$/, '').split('/').join('.');
}

const CAPABILITIES: AdapterCapabilities = {
  tier: 'generic',
  // Every command is either a scanned function or an external program; there is
  // nothing else to say without classes or types.
  callTypes: ['internal_func', 'boundary'],
  selfAttrs: false,
  statementSpans: false,
};

const SHELL_SPEC: LanguageSpec<ModuleScan, ShellIndexes> = {
  name: 'shell',
  extensions: ['.sh', '.bash'],
  grammarFor: () => 'bash',
  moduleIdForFile,
  capabilities: CAPABILITIES,

  emptyScan(moduleId) {
    return {
      moduleId,
      files: [],
      functions: [],
      fnContext: new Map(),
      imports: new Map(),
      ownerMethods: new Map(),
      fieldTypes: new Map(),
      freeFunctions: new Set(),
    };
  },

  scan(scan, root, file) {
    walk(root, (node) => {
      if (node.type !== 'function_definition') return undefined;
      const name = fieldText(node, 'name');
      if (!name) return undefined;
      const id = `${scan.moduleId}.${name}`;
      if (scan.fnContext.has(id)) return undefined;
      const firstLine = node.text.split('\n', 1)[0] ?? '';
      scan.freeFunctions.add(name);
      scan.functions.push({
        id,
        name,
        qualname: name,
        file,
        lineStart: lineStart(node),
        lineEnd: lineEnd(node),
        signature: truncate(firstLine.trim(), 200),
        isAsync: false,
        isMethod: false,
        className: null,
        decorators: [],
        kind: 'internal',
        synthetic: false,
        selfAttrsRead: [],
        selfAttrsWritten: [],
        paramTypes: {},
      });
      const body = node.childForFieldName('body');
      if (body) scan.fnContext.set(id, body);
      return undefined;
    });
  },

  buildIndexes(scans) {
    // Shell has no imports: a command name is looked up in one flat namespace
    // spanning every scanned file, so this index is global rather than one of
    // the spine's per-module tables.
    const nameToModule: ShellIndexes = new Map();
    for (const scan of scans) {
      for (const fn of scan.functions) {
        if (!nameToModule.has(fn.name)) nameToModule.set(fn.name, scan.moduleId);
      }
    }
    return nameToModule;
  },

  extractCalls(scan, _std, nameToModule) {
    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const body = scan.fnContext.get(fn.id);
      if (!body) continue;
      walk(body, (node) => {
        if (node.type === 'function_definition') return false;
        if (node.type !== 'command') return undefined;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return undefined;
        // `/usr/bin/git` → `git`
        const name = nameNode.text.split('/').pop() ?? nameNode.text;
        if (!name) return undefined;
        const definedIn = nameToModule.get(name);
        edges.push({
          callerId: fn.id,
          calleeId: definedIn ? `${definedIn}.${name}` : `boundary:${name}`,
          isAwait: false,
          callType: definedIn ? 'internal_func' : 'boundary',
          line: lineStart(node),
          raw: truncate(nameNode.text, 80),
        });
        return undefined;
      });
    }
    return edges;
  },
};

export class ShellAdapter extends SpineAdapter<ModuleScan, ShellIndexes> {
  constructor() {
    super(SHELL_SPEC);
  }
}
