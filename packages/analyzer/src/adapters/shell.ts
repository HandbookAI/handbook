/**
 * Shell adapter (tree-sitter grammar `bash`).
 *
 * Shell has no classes, no types and no constructors, so five of the eight
 * `CallType`s name constructs the language does not have. This adapter declares
 * the three it can actually produce — `internal_func`, `boundary`,
 * `unresolved` — and claims `tier: 'full'` on the strength of what it resolves,
 * not on the size of that list. The generic tier means "a declarative node-type
 * config with no language knowledge"; what this file implements is shell's own
 * name resolution:
 *
 * - **`source` / `.` is shell's import statement.** A sourced script's functions
 *   become visible to the sourcing one and are preferred over any other
 *   candidate, which is what disambiguates two scripts that define the same
 *   function name. The path is resolved against the scanned file set, including
 *   the near-universal `source "${SCRIPT_DIR}/lib/util.sh"` idiom — the
 *   expansion is dropped and the literal tail matched by path suffix, accepted
 *   only when exactly one scanned file matches.
 * - **Running a scanned script is an internal call, not a boundary.**
 *   `./deploy.sh`, `"$ROOT/scripts/build.sh"` and `bash scripts/build.sh` all
 *   resolve to that script's body; `git` and `curl` stay boundaries.
 * - **A script's top level is its main routine.** Most shell scripts in the wild
 *   are top-level code with few or no functions, and without a node for it the
 *   whole program would be invisible in the graph. Every scanned file therefore
 *   gets a `<moduleId>.__main__` node spanning the file, whose callees are the
 *   commands outside any function definition. That is also what an invocation by
 *   path resolves to.
 * - **A command name that is only an expansion is `unresolved`, not a
 *   boundary.** `"$RUNNER" build` calls something external, but `boundary:$RUNNER`
 *   would invent an external program named `$RUNNER`; `unresolved` says what is
 *   actually true, and the graph builder diverts it to dropped calls.
 *
 * `selfAttrs` stays false: there is no `self` in shell and nothing is invented
 * to fill it.
 *
 * Known limits, stated rather than hidden:
 *   - **The pinned bash grammar cannot parse a `case` statement.** Its external
 *     scanner imports `env.isalpha`, which `web-tree-sitter@0.25.10`'s dynamic
 *     linker does not provide, so `Parser.parse` THROWS a `TypeError` — and the
 *     parser instance stays poisoned afterwards, failing every later parse.
 *     Since `case` is ubiquitous, {@link ShellAdapter.analyze} pre-parses each
 *     file with a disposable parser and drops the ones that throw, so one such
 *     script costs only itself instead of the whole run. Those files are
 *     genuinely NOT ANALYZED, and the adapter has no channel to say so at
 *     runtime — this comment and the SP6 report are the disclosure.
 *   - Discovery is by extension (`.sh`, `.bash`), so an extensionless script
 *     with a shebang is never seen.
 *   - A `trap 'handler' EXIT` handler is not resolved: the argument is a command
 *     STRING, and parsing shell inside a string to catch only the single-name
 *     case would be a heuristic with no clear edge.
 *   - `eval`, aliases, and a `$PATH` binary shadowing a function are not
 *     modelled; a command name is matched literally.
 *   - Variables holding command output are not tracked: `X=$(which foo); $X`
 *     lands in `unresolved`, which is what it is.
 *   - A function name defined in two scanned files that neither sources the
 *     other keeps the old first-definition-wins fallback.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, FunctionNode } from '@handbooks/core';
import { truncate } from '@handbooks/core';
import { fieldText, lineEnd, lineStart, walk } from '../tsx-util.js';
import { dirOf, SpineAdapter, type BaseScan, type LanguageSpec, type Resolved } from '../spine.js';

/** The node id given to a script's top-level body. */
const MAIN = '__main__';

/** Commands whose first non-flag argument is a script to run. */
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);

/** The two spellings of shell's import statement. */
const SOURCE_COMMANDS = new Set(['source', '.']);

/** A path-ish literal, dropped down to what can be matched against the scan set. */
interface PathLiteral {
  /** Literal characters only; every expansion is dropped. */
  literal: string;
  /** True when an expansion was dropped, so only a suffix match is sound. */
  hadExpansion: boolean;
}

interface ModuleScan extends BaseScan {
  /** function id → its body node for pass 2 (`__main__`'s body is the root). */
  fnContext: Map<string, Node>;
  /** Targets of every `source` / `.` in this file, in written order. */
  sourced: PathLiteral[];
}

interface ShellIndexes {
  /** Global function-name index across all scanned files; first wins. */
  nameToModule: Map<string, string>;
  /** Normalized relative file path (extension included) → moduleId. */
  moduleOfPath: Map<string, string>;
  /** moduleId → the modules it sources, in written order. */
  sourcedModules: Map<string, string[]>;
}

export function moduleIdForFile(file: string): string {
  return file
    .replace(/\.(sh|bash)$/, '')
    .split('/')
    .join('.');
}

/** Collapse `a/./b` and `a/b/../c`; a `..` that escapes the root is kept. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * The literal characters of a word / string / concatenation, with expansions
 * dropped and flagged. `"${SCRIPT_DIR}/lib/util.sh"` → `/lib/util.sh`, expanded.
 */
function pathLiteralOf(node: Node): PathLiteral {
  let literal = '';
  let hadExpansion = false;
  const visit = (n: Node): void => {
    switch (n.type) {
      case 'word':
      case 'string_content':
        literal += n.text;
        return;
      case 'raw_string':
        literal += n.text.replace(/^'/, '').replace(/'$/, '');
        return;
      case 'expansion':
      case 'simple_expansion':
      case 'command_substitution':
      case 'arithmetic_expansion':
        hadExpansion = true;
        return;
      default:
        for (const child of n.namedChildren) if (child) visit(child);
    }
  };
  if (node.type === 'word') return { literal: node.text, hadExpansion: false };
  visit(node);
  return { literal, hadExpansion };
}

/** Strip leading `/`, `./` and `../` so a literal can be suffix-matched. */
function pathTail(literal: string): string {
  let tail = literal.replace(/^\/+/, '');
  while (tail.startsWith('./') || tail.startsWith('../')) {
    tail = tail.startsWith('./') ? tail.slice(2) : tail.slice(3);
  }
  return tail;
}

/**
 * The scanned module a path literal names.
 *
 * An unexpanded literal is resolved properly — against the referring file's
 * directory, then against the source root. Once an expansion has been dropped
 * only the tail is left, so it is matched by path suffix and accepted only when
 * exactly one scanned file matches; two candidates mean we do not know.
 */
function matchScript(ref: PathLiteral, fromFile: string, own: ShellIndexes): string | undefined {
  const tail = pathTail(ref.literal);
  if (!tail) return undefined;
  if (!ref.hadExpansion) {
    const relative = own.moduleOfPath.get(normalizePath(`${dirOf(fromFile)}/${ref.literal}`));
    if (relative) return relative;
    const fromRoot = own.moduleOfPath.get(normalizePath(ref.literal));
    if (fromRoot) return fromRoot;
  }
  const hits = new Set<string>();
  for (const [path, module] of own.moduleOfPath) {
    if (path === tail || path.endsWith(`/${tail}`)) hits.add(module);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** Modules whose functions `module` can see, sourced ones nearest-first. */
function visibleModules(module: string, own: ShellIndexes): string[] {
  const seen = new Set([module]);
  const order: string[] = [];
  const queue = [...(own.sourcedModules.get(module) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    order.push(next);
    queue.push(...(own.sourcedModules.get(next) ?? []));
  }
  return order;
}

/** The first argument of `bash foo.sh --flag` that is not an option. */
function firstScriptArgument(command: Node): Node | undefined {
  for (let i = 0; i < command.childCount; i += 1) {
    const child = command.child(i);
    if (!child || command.fieldNameForChild(i) !== 'argument') continue;
    if (child.type === 'word' && child.text.startsWith('-')) continue;
    return child;
  }
  return undefined;
}

function makeFunction(opts: {
  id: string;
  name: string;
  file: string;
  node: Node;
  signature: string;
}): FunctionNode {
  return {
    id: opts.id,
    name: opts.name,
    qualname: opts.name,
    file: opts.file,
    lineStart: lineStart(opts.node),
    lineEnd: lineEnd(opts.node),
    signature: truncate(opts.signature, 200),
    isAsync: false,
    isMethod: false,
    className: null,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    // Shell has no `self` and no attributes; the fields stay empty rather than
    // being filled with something invented.
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes: {},
  };
}

const CAPABILITIES: AdapterCapabilities = {
  tier: 'full',
  // Exactly what shell can express. `self_method`, `self_attr_method`,
  // `param_method`, `internal_constructor` and `boundary_constructor` name
  // constructs the language does not have — declaring them would be over-claiming.
  callTypes: ['internal_func', 'boundary', 'unresolved'],
  selfAttrs: false,
  statementSpans: false,
  // Empty because the LANGUAGE has no named types, not because this adapter
  // skipped them — the only entry in the list that is a permanent fact rather
  // than an unfinished one.
  typeKinds: [],
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
      sourced: [],
    };
  },

  scan(scan, root, file) {
    // The script body itself. Sourcing a file executes its top level, and for
    // the many scripts that define no function at all it is the whole program.
    const mainId = `${scan.moduleId}.${MAIN}`;
    const shebang = root.namedChildren.find((c) => c?.type === 'comment' && c.text.startsWith('#!'));
    scan.functions.push(
      makeFunction({
        id: mainId,
        name: MAIN,
        file,
        node: root,
        signature: shebang ? shebang.text.trim() : `${file} (top-level script body)`,
      }),
    );
    scan.fnContext.set(mainId, root);

    walk(root, (node) => {
      if (node.type === 'command') {
        const name = node.childForFieldName('name');
        if (name && SOURCE_COMMANDS.has(name.text)) {
          const argument = firstScriptArgument(node);
          if (argument) scan.sourced.push(pathLiteralOf(argument));
        }
        return undefined;
      }
      if (node.type !== 'function_definition') return undefined;
      const name = fieldText(node, 'name');
      if (!name) return undefined;
      const id = `${scan.moduleId}.${name}`;
      if (scan.fnContext.has(id)) return undefined;
      const firstLine = node.text.split('\n', 1)[0] ?? '';
      scan.freeFunctions.add(name);
      scan.functions.push(makeFunction({ id, name, file, node, signature: firstLine.trim() }));
      const body = node.childForFieldName('body');
      if (body) scan.fnContext.set(id, body);
      return undefined;
    });
  },

  buildIndexes(scans) {
    // Shell has no per-name import table: a command name is looked up in one
    // flat namespace, narrowed by what the script sourced. So these indexes are
    // shell's own rather than the spine's per-module tables.
    const nameToModule = new Map<string, string>();
    const moduleOfPath = new Map<string, string>();
    for (const scan of scans) {
      for (const name of scan.freeFunctions) {
        if (!nameToModule.has(name)) nameToModule.set(name, scan.moduleId);
      }
      for (const file of scan.files) moduleOfPath.set(normalizePath(file), scan.moduleId);
    }

    const indexes: ShellIndexes = { nameToModule, moduleOfPath, sourcedModules: new Map() };
    for (const scan of scans) {
      const modules: string[] = [];
      for (const ref of scan.sourced) {
        const module = matchScript(ref, scan.files[0] ?? '', indexes);
        if (module && module !== scan.moduleId) modules.push(module);
      }
      indexes.sourcedModules.set(scan.moduleId, modules);
    }
    return indexes;
  },

  extractCalls(scan, std, own) {
    const file = scan.files[0] ?? '';
    const visible = visibleModules(scan.moduleId, own);

    /** A function name, preferring this file, then what it sourced. */
    const resolveFunction = (name: string): Resolved | undefined => {
      if (scan.freeFunctions.has(name)) {
        return { calleeId: `${scan.moduleId}.${name}`, callType: 'internal_func' };
      }
      for (const module of visible) {
        if (std.moduleFunctions.get(module)?.has(name)) {
          return { calleeId: `${module}.${name}`, callType: 'internal_func' };
        }
      }
      const anywhere = own.nameToModule.get(name);
      return anywhere ? { calleeId: `${anywhere}.${name}`, callType: 'internal_func' } : undefined;
    };

    const resolveCommand = (node: Node, nameNode: Node): Resolved | undefined => {
      const text = nameNode.text;
      // `source x.sh` is an import, not a call: like every other language's
      // import it supplies visibility and gets no edge of its own.
      if (SOURCE_COMMANDS.has(text)) return undefined;

      const ref = pathLiteralOf(nameNode);
      const pathLike = ref.literal.includes('/') || /\.(sh|bash)$/.test(ref.literal);
      if (pathLike) {
        const module = matchScript(ref, file, own);
        if (module) return { calleeId: `${module}.${MAIN}`, callType: 'internal_func' };
      }

      // `bash scripts/build.sh` — the interpreter is plumbing; the script is
      // the dependency worth recording.
      if (INTERPRETERS.has(text)) {
        const argument = firstScriptArgument(node);
        const module = argument ? matchScript(pathLiteralOf(argument), file, own) : undefined;
        if (module) return { calleeId: `${module}.${MAIN}`, callType: 'internal_func' };
      }

      // `"$RUNNER" build` — external, but naming it `boundary:$RUNNER` would
      // invent a program that does not exist.
      if (!ref.literal) return { calleeId: `unresolved:${truncate(text, 80)}`, callType: 'unresolved' };

      // `/usr/bin/git` → `git`.
      const bare = ref.literal.split('/').pop() ?? ref.literal;
      if (!bare) return undefined;
      return resolveFunction(bare) ?? { calleeId: `boundary:${bare}`, callType: 'boundary' };
    };

    const edges: CallEdge[] = [];
    for (const fn of scan.functions) {
      const body = scan.fnContext.get(fn.id);
      if (!body) continue;
      walk(body, (node) => {
        // A definition's commands belong to it, not to the enclosing body —
        // which for `__main__` means every top-level function is skipped.
        if (node.type === 'function_definition') return false;
        if (node.type !== 'command') return undefined;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return undefined;
        const resolved = resolveCommand(node, nameNode);
        if (!resolved) return undefined;
        edges.push({
          callerId: fn.id,
          calleeId: resolved.calleeId,
          isAwait: false,
          callType: resolved.callType,
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
