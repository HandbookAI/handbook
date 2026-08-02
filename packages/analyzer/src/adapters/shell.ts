/**
 * Shell adapter (tree-sitter grammar `bash`).
 *
 * Free-function model only: one {@link FunctionNode} per `function_definition`,
 * id `<moduleId>.<name>`. Every `command` inside a function body becomes an
 * edge: to the defining module when the name is a function defined in ANY
 * scanned file (first definition wins), else `boundary:<name>` — real
 * dependency info like "this script calls git/cargo".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { CallEdge, FunctionNode, ModuleAnalysis } from '@handbook/core';
import { truncate } from '@handbook/core';
import { createParser } from '../languages.js';
import { discoverByExtension, type LanguageAdapter } from '../adapter.js';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';

interface ModuleScan {
  moduleId: string;
  file: string;
  functions: FunctionNode[];
  fnContext: Map<string, Node>;
}

export class ShellAdapter implements LanguageAdapter {
  readonly name = 'shell';
  readonly extensions = ['.sh', '.bash'];

  discover(sourceRoot: string): string[] {
    return discoverByExtension(sourceRoot, this.extensions);
  }

  async analyze(files: readonly string[], sourceRoot: string): Promise<ModuleAnalysis> {
    const parser = await createParser('bash');
    const scans: ModuleScan[] = [];
    for (const file of files) {
      let source: string;
      try {
        source = readFileSync(join(sourceRoot, file), 'utf8');
      } catch {
        continue;
      }
      const tree = parser.parse(source);
      if (!tree) continue;
      scans.push(scanModule(tree.rootNode, file));
    }

    // Global function-name index across all scanned files (first wins).
    const nameToModule = new Map<string, string>();
    for (const scan of scans) {
      for (const fn of scan.functions) {
        if (!nameToModule.has(fn.name)) nameToModule.set(fn.name, scan.moduleId);
      }
    }

    const functions = scans.flatMap((s) => s.functions);
    const edges = scans.flatMap((s) => extractCalls(s, nameToModule));
    return { functions, edges };
  }
}

export function moduleIdForFile(file: string): string {
  return file.replace(/\.(sh|bash)$/, '').split('/').join('.');
}

function scanModule(root: Node, file: string): ModuleScan {
  const scan: ModuleScan = {
    moduleId: moduleIdForFile(file),
    file,
    functions: [],
    fnContext: new Map(),
  };
  walk(root, (node) => {
    if (node.type !== 'function_definition') return undefined;
    const name = fieldText(node, 'name');
    if (!name) return undefined;
    const id = `${scan.moduleId}.${name}`;
    if (scan.fnContext.has(id)) return undefined;
    const firstLine = node.text.split('\n', 1)[0] ?? '';
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
  return scan;
}

function extractCalls(scan: ModuleScan, nameToModule: Map<string, string>): CallEdge[] {
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
}
