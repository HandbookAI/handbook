/**
 * The config-driven generic language engine (design §3).
 *
 * A hand-written adapter is 400–600 lines, which is the right price for a
 * language people actually read handbooks of. It is the wrong price for the long
 * tail: Kotlin, Scala, Lua, Zig, … would be thousands of lines of near-identical
 * code, and every one of them another place to forget a part.
 *
 * So the long tail is covered by ONE engine that takes a declarative
 * {@link GenericLanguageSpec} — mostly lists of tree-sitter node type names — and
 * builds a spine {@link LanguageSpec} from it. Adding a language is ~30 lines of
 * config plus a fixture, not a new file of logic.
 *
 * What it deliberately does NOT do: type inference. Without it there is no
 * honest way to emit `self_attr_method` (`self.field.m()`) or `param_method`
 * (`p.m()`), so this engine can never produce them — {@link GENERIC_CALL_TYPES}
 * is the ceiling and {@link createGenericAdapter} throws on a spec that claims
 * more. That is the whole point of the two-tier capability declaration: a reader
 * of a generic-tier handbook must not mistake its call facts for Python's.
 *
 * Resolution is best-effort by construction. A construct the spec cannot
 * describe contributes NOTHING (no functions, no imports) rather than a guess,
 * and a call whose callee expression cannot be read as `name` or `recv.name`
 * becomes an `unresolved` edge rather than silence — an unreadable call is still
 * evidence that a call happened.
 */
import type { Node } from 'web-tree-sitter';
import type { AdapterCapabilities, CallEdge, CallType } from '@handbooks/core';
import { truncate } from '@handbooks/core';
import type { LanguageAdapter } from './adapter.js';
import { lineEnd, lineStart, walk } from './tsx-util.js';
import {
  boundaryOf,
  createAdapter,
  resolveOwnMethod,
  resolveSameFileFree,
  resolveSiblingPackage,
  resolveViaImport,
  unresolvedOf,
  type BaseScan,
  type LanguageSpec,
  type Resolved,
  type StandardIndexes,
} from './spine.js';

/**
 * Everything a generic-tier adapter can ever emit. `self_attr_method` and
 * `param_method` need type inference and are therefore permanently out of reach;
 * `boundary_constructor` needs to know which names are types in a language whose
 * class syntax we only guessed at, so it is not attempted either.
 */
export const GENERIC_CALL_TYPES: readonly CallType[] = [
  'internal_func',
  'internal_constructor',
  'self_method',
  'boundary',
  'unresolved',
];

/**
 * One language, declared rather than implemented.
 *
 * Node type names differ wildly between grammars and cannot be guessed — every
 * list here was read off a real parse tree of a real snippet, not from memory.
 */
export interface GenericLanguageSpec {
  /** Registry key, e.g. `kotlin`. */
  name: string;
  /** `tree-sitter-wasms` grammar name (the wasm file must exist on disk). */
  grammar: string;
  /** File extensions (with dot) this language owns. */
  extensions: readonly string[];
  extraSkipDirs?: readonly string[];
  /** AST node types, per grammar. Empty list = "this grammar has no such thing". */
  nodes: {
    /** Function/method declarations. */
    function: readonly string[];
    /**
     * A function node counts only when it has a direct named child of one of
     * these types. OCaml needs it: `let f x = …` and `let y = f 1` are the same
     * `let_binding` node, and only the one with a `parameter` is a function.
     */
    functionRequires?: readonly string[];
    /** Class-like owners of methods (class, object, implementation, …). */
    class: readonly string[];
    /** Call expressions whose callee is one expression (`f()`, `a.b()`). */
    call: readonly string[];
    /** Calls written as `[receiver member …]` (Objective-C messages). */
    message?: readonly string[];
    /** Import/include/open declarations. */
    import: readonly string[];
  };
  /** Field name overrides; the name is otherwise found structurally. */
  fields?: { name?: string };
  /** Receiver texts that mean "this object" (`this`, `self`, …). */
  selfKeywords?: readonly string[];
  /** Words in a declaration's first line that mark it async (`suspend`, …). */
  asyncMarkers?: readonly string[];
  /** Defaults to "drop the extension, `/` → `.`". */
  moduleIdForFile?: (file: string) => string;
  /**
   * EXACTLY the callTypes this configuration can emit — not the tier's ceiling.
   * A language with no class nodes cannot emit `self_method`; one with no import
   * nodes cannot emit `boundary`. `register.test.ts` checks the claim in both
   * directions against a fixture, so an over-claim fails the build.
   */
  callTypes: readonly CallType[];
}

/** A node type that names something: `identifier`, `type_identifier`, `value_name`. */
const IDENTIFIER_LIKE = /(?:^|_)(?:identifier|name)$/;
/** A callee expression that is just a name. */
const BARE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** The last two segments of a member-access callee: `a.b`, `a:b`, `a::b`, `a->b`. */
const RECEIVER_MEMBER = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?\.|->|::|[.:])\s*([A-Za-z_$][A-Za-z0-9_$]*)$/;
/**
 * Member appended to a scanned type's id for a constructor edge. The generic
 * tier cannot know a language's constructor spelling, and graph.ts already
 * recognizes a trailing `new` as constructor-ish and synthesizes the node.
 */
const CONSTRUCTOR_MEMBER = 'new';
/** How deep to look for a declaration's name when there is no `name` field. */
const NAME_SEARCH_DEPTH = 3;

/** function id → where to walk for its calls, plus the owner it was found in. */
interface FnSite {
  node: Node;
  className: string | null;
}

interface GenericScan extends BaseScan {
  fnContext: Map<string, FnSite>;
}

/** One call site, read off the tree. `name === undefined` = unreadable callee. */
interface CallSite {
  receiver: string | undefined;
  name: string | undefined;
  /** The callee text as written, for the edge's `raw` and unresolved hints. */
  raw: string;
}

/** A {@link GenericLanguageSpec} with its lists turned into lookup sets. */
interface Compiled {
  functionNodes: Set<string>;
  functionRequires: Set<string> | undefined;
  classNodes: Set<string>;
  callNodes: Set<string>;
  messageNodes: Set<string>;
  importNodes: Set<string>;
  selfKeywords: Set<string>;
  asyncMarkers: readonly RegExp[];
  nameField: string;
  moduleIdForFile: (file: string) => string;
}

function compile(spec: GenericLanguageSpec): Compiled {
  // Longest extension first so `.mm` is not stripped as `.m`.
  const extensions = [...spec.extensions].sort((a, b) => b.length - a.length);
  return {
    functionNodes: new Set(spec.nodes.function),
    functionRequires: spec.nodes.functionRequires ? new Set(spec.nodes.functionRequires) : undefined,
    classNodes: new Set(spec.nodes.class),
    callNodes: new Set(spec.nodes.call),
    messageNodes: new Set(spec.nodes.message ?? []),
    importNodes: new Set(spec.nodes.import),
    selfKeywords: new Set(spec.selfKeywords ?? []),
    asyncMarkers: (spec.asyncMarkers ?? []).map((word) => new RegExp(`\\b${word}\\b`)),
    nameField: spec.fields?.name ?? 'name',
    moduleIdForFile:
      spec.moduleIdForFile ??
      ((file: string) => {
        for (const ext of extensions) {
          if (file.endsWith(ext)) return file.slice(0, -ext.length).split('/').join('.');
        }
        return file.split('/').join('.');
      }),
  };
}

/**
 * The declared name of `node`: its `name` field, else the shallowest
 * identifier-like descendant.
 *
 * The fallback is what makes one engine fit many grammars: Kotlin puts a
 * function's name in an unnamed `simple_identifier` child, Objective-C buries a
 * C function's name one level down in a `function_declarator`. Breadth-first and
 * depth-capped so it prefers the shallow name and can never wander into a body.
 */
function nameOf(node: Node, nameField: string): string {
  const field = node.childForFieldName(nameField)?.text.trim();
  if (field) return field;
  let level: Node[] = [node];
  for (let depth = 0; depth < NAME_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: Node[] = [];
    for (const parent of level) {
      for (const child of parent.namedChildren) {
        if (!child) continue;
        if (IDENTIFIER_LIKE.test(child.type)) return child.text.trim();
        next.push(child);
      }
    }
    level = next;
  }
  return '';
}

function isFunctionNode(c: Compiled, node: Node): boolean {
  if (!c.functionNodes.has(node.type)) return false;
  const required = c.functionRequires;
  if (!required) return true;
  return node.namedChildren.some((child) => child !== null && required.has(child.type));
}

/** The class this node is declared inside, if any. */
function enclosingClassName(c: Compiled, node: Node): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (c.classNodes.has(parent.type)) return nameOf(parent, c.nameField) || null;
  }
  return null;
}

/**
 * Record one import as `local name → path`.
 *
 * A quoted/bracketed path is a FILE (`#import "Engine.h"` → `Engine`), a bare
 * one is a dotted symbol path (`import demo.engine.Engine` → `Engine`). Which of
 * the two it is comes from the node type, not from guessing at the text — a
 * dotted path's last segment is a symbol, and stripping it as a file extension
 * would silently corrupt every import.
 */
function recordImport(scan: GenericScan, node: Node): void {
  const pathNode = node.namedChildren.find((child) => child !== null);
  if (!pathNode) return;
  const bare = pathNode.text
    .trim()
    .replace(/^[<"'`]+/, '')
    .replace(/[>"'`]+$/, '');
  if (!bare) return;
  const quoted = /string|literal/.test(pathNode.type);
  const path = quoted
    ? bare
        .replace(/\.[A-Za-z0-9_]+$/, '')
        .split('/')
        .join('.')
    : bare.replace(/\s+/g, '');
  const local = path.slice(path.lastIndexOf('.') + 1);
  // `*` (wildcard) and `_` (import for side effects) name no local symbol.
  if (!local || local === '*' || local === '_') return;
  scan.imports.set(local, path);
}

function recordClass(c: Compiled, scan: GenericScan, node: Node): void {
  const name = nameOf(node, c.nameField);
  if (!name) return;
  if (!scan.ownerMethods.has(name)) scan.ownerMethods.set(name, new Set());
}

function recordFunction(c: Compiled, scan: GenericScan, node: Node, file: string): void {
  const name = nameOf(node, c.nameField);
  if (!name) return;
  const className = enclosingClassName(c, node);
  const qualname = className ? `${className}.${name}` : name;
  const id = `${scan.moduleId}.${qualname}`;
  // Node ids must be globally unique. On a repeat (a redefinition, or two
  // same-named methods of owners this grammar does not name) the FIRST wins:
  // recording it twice would also emit every edge of the shared body twice.
  if (scan.fnContext.has(id)) return;

  if (className) {
    let methods = scan.ownerMethods.get(className);
    if (!methods) {
      methods = new Set();
      scan.ownerMethods.set(className, methods);
    }
    methods.add(name);
  } else {
    scan.freeFunctions.add(name);
  }

  const firstLine = (node.text.split('\n', 1)[0] ?? '').trim();
  scan.functions.push({
    id,
    name,
    qualname,
    file,
    lineStart: lineStart(node),
    lineEnd: lineEnd(node),
    signature: truncate(firstLine, 200),
    isAsync: c.asyncMarkers.some((marker) => marker.test(firstLine)),
    isMethod: className !== null,
    className,
    decorators: [],
    kind: 'internal',
    synthetic: false,
    // Attribute tracking needs to know which name is the receiver and which
    // accesses are writes — per-language knowledge this engine does not have.
    selfAttrsRead: [],
    selfAttrsWritten: [],
    paramTypes: {},
  });
  scan.fnContext.set(id, { node, className });
}

/** Read a call node into a receiver/name pair, or `undefined` if it is not a call. */
function readCall(c: Compiled, node: Node): CallSite | undefined {
  if (c.messageNodes.has(node.type)) {
    const parts = node.namedChildren.filter((child): child is Node => child !== null);
    const receiver = parts[0]?.text.trim() ?? '';
    const member = parts[1]?.text.trim() ?? '';
    // A computed receiver (`[[Engine alloc] init]`) is opaque; treating `init`
    // as a bare call would invent an edge to any same-named free function.
    if (!BARE_NAME.test(receiver) || !BARE_NAME.test(member)) {
      return { receiver: undefined, name: undefined, raw: node.text };
    }
    // Normalized to `recv.member`, the shape every other language writes and the
    // one the dropped-call classifier reads (`self.x` → an unknown attribute).
    return { receiver, name: member, raw: `${receiver}.${member}` };
  }
  if (!c.callNodes.has(node.type)) return undefined;
  // Grammars either name the callee `function` (the convention) or put it first;
  // both were checked against every configured grammar's real tree.
  const callee = node.childForFieldName('function') ?? node.namedChildren.find((child) => child !== null);
  if (!callee) return undefined;
  const raw = callee.text.trim();
  if (BARE_NAME.test(raw)) return { receiver: undefined, name: raw, raw };
  const member = RECEIVER_MEMBER.exec(raw);
  if (member?.[1] && member[2]) return { receiver: member[1], name: member[2], raw };
  return { receiver: undefined, name: undefined, raw };
}

/** A bare call naming a scanned type: `App(…)` / `new App(…)` constructs it. */
function constructorOf(name: string, std: StandardIndexes): Resolved | undefined {
  const module = std.typeToModule.get(name);
  if (!module) return undefined;
  return {
    calleeId: `${module}.${name}.${CONSTRUCTOR_MEMBER}`,
    callType: 'internal_constructor',
  };
}

/** Does this import path point back INTO the scanned set? */
function landsInScan(path: string, std: StandardIndexes): boolean {
  if (std.moduleIds.has(path)) return true;
  return std.typeToModule.has(path.slice(path.lastIndexOf('.') + 1));
}

function resolveTarget(
  c: Compiled,
  call: CallSite,
  scan: GenericScan,
  std: StandardIndexes,
  className: string | null,
): Resolved {
  const { receiver, name, raw } = call;
  if (!name) return unresolvedOf(raw);
  const importOptions = {
    moduleOf: (source: string) => (std.moduleIds.has(source) ? source : undefined),
    constructorName: CONSTRUCTOR_MEMBER,
  };

  if (receiver === undefined) {
    return (
      resolveSameFileFree(name, scan) ??
      resolveSiblingPackage(name, scan, std) ??
      resolveViaImport(name, scan, std, importOptions) ??
      // A bare call inside a class body with the class's own method name is an
      // implicit `this.` call — the same fact as `this.m()`, written shorter.
      (className ? resolveOwnMethod(className, name, scan, std) : undefined) ??
      constructorOf(name, std) ??
      unresolvedOf(raw)
    );
  }

  if (c.selfKeywords.has(receiver) && className) {
    const own = resolveOwnMethod(className, name, scan, std);
    if (own) return own;
  }
  const imported = scan.imports.get(receiver);
  // An imported receiver that leaves the scanned set is a real boundary fact.
  // One that points back INTO it is a qualified call on a scanned type, and the
  // generic tier has no callType for that — calling it `boundary` would claim
  // the target is external, so it stays unresolved.
  if (imported !== undefined && !landsInScan(imported, std)) return boundaryOf(imported, name);
  return unresolvedOf(raw);
}

function capabilitiesOf(spec: GenericLanguageSpec): AdapterCapabilities {
  const overclaimed = spec.callTypes.filter((type) => !GENERIC_CALL_TYPES.includes(type));
  if (overclaimed.length > 0) {
    throw new Error(
      `generic language "${spec.name}" claims callTypes the engine cannot emit: ` +
        `${overclaimed.join(', ')} — those need type inference, which no declarative spec provides`,
    );
  }
  return {
    tier: 'generic',
    callTypes: spec.callTypes,
    selfAttrs: false,
    statementSpans: false,
    // No type extraction, for every generic-tier language, and stated rather than
    // left implicit.
    //
    // The engine DOES know each language's class-like node types — `spec.nodes.class`
    // is how it finds method owners — so emitting a `class` row per hit would be
    // easy. It would also be wrong in the way this whole tier is guarded against:
    // that list is one bucket holding Kotlin's `class` and `object`, Scala's
    // `class`, `object` and `trait`, and Objective-C's `class_implementation`, so
    // mapping it onto {@link TypeKind} would report a Scala trait as a class and an
    // `@implementation` as a declaration. It also finds no interfaces, no enums and
    // no aliases at all, in languages full of them — so a non-empty declaration
    // here would tell an agent that a miss means absence.
    //
    // The honest move is the same one the tier already makes about call edges:
    // claim nothing, say so out loud, and let the labelled `class-derived` row
    // carry what can be inferred.
    typeKinds: [],
  };
}

/** Build a spine adapter from a declarative language spec. */
export function createGenericAdapter(spec: GenericLanguageSpec): LanguageAdapter {
  const c = compile(spec);
  const languageSpec: LanguageSpec<GenericScan> = {
    name: spec.name,
    extensions: spec.extensions,
    grammarFor: () => spec.grammar,
    extraSkipDirs: spec.extraSkipDirs,
    moduleIdForFile: c.moduleIdForFile,
    // Two extensions can collapse to one moduleId (`app.kt` + `app.kts`). Merging
    // them into one scan keeps function ids unique, which the graph requires;
    // separate scans would emit a duplicate node and double its call edges.
    mergeByModule: true,
    capabilities: capabilitiesOf(spec),

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
        if (c.importNodes.has(node.type)) {
          recordImport(scan, node);
          return false;
        }
        // Classes are visited before their methods (pre-order), so an owner is
        // always known by the time a method asks for it.
        if (c.classNodes.has(node.type)) recordClass(c, scan, node);
        else if (isFunctionNode(c, node)) recordFunction(c, scan, node, file);
        return undefined;
      });
    },

    extractCalls(scan, std) {
      const edges: CallEdge[] = [];
      for (const fn of scan.functions) {
        const site = scan.fnContext.get(fn.id);
        if (!site) continue;
        walk(site.node, (node) => {
          // A nested declaration owns its own calls.
          if (node !== site.node && (isFunctionNode(c, node) || c.classNodes.has(node.type))) {
            return false;
          }
          const call = readCall(c, node);
          if (!call) return undefined;
          const resolved = resolveTarget(c, call, scan, std, site.className);
          edges.push({
            callerId: fn.id,
            calleeId: resolved.calleeId,
            isAwait: false,
            callType: resolved.callType,
            line: lineStart(node),
            raw: truncate(call.raw, 80),
          });
          return undefined;
        });
      }
      return edges;
    },
  };
  return createAdapter(languageSpec);
}

/**
 * The languages covered by the generic engine, verified against a real parse
 * tree each (see `generic.test.ts`).
 *
 * Deliberately absent:
 * - **Elixir**: `defmodule`, `def`, `import` and an ordinary function call are
 *   all the same `call` node, so no list of node types can tell a definition
 *   from a call.
 * - **Lua**: the shipped grammar errors on ordinary top-level statements and
 *   drops the function declarations around them, and what it drops depends on
 *   what the same parser parsed before — unreproducible facts are worse than no
 *   facts. (Verified against the pinned grammar; revisit when it is rebuilt.)
 * - **PowerShell**: `tree-sitter-wasms` ships no grammar for it.
 */
export const GENERIC_LANGUAGES: readonly GenericLanguageSpec[] = [
  {
    name: 'kotlin',
    grammar: 'kotlin',
    extensions: ['.kt', '.kts'],
    nodes: {
      function: ['function_declaration'],
      class: ['class_declaration', 'object_declaration'],
      call: ['call_expression'],
      import: ['import_header'],
    },
    selfKeywords: ['this'],
    asyncMarkers: ['suspend'],
    callTypes: ['internal_func', 'internal_constructor', 'self_method', 'boundary', 'unresolved'],
  },
  {
    name: 'scala',
    grammar: 'scala',
    extensions: ['.scala', '.sc'],
    nodes: {
      function: ['function_definition'],
      class: ['class_definition', 'object_definition', 'trait_definition'],
      call: ['call_expression'],
      import: ['import_declaration'],
    },
    selfKeywords: ['this'],
    callTypes: ['internal_func', 'internal_constructor', 'self_method', 'boundary', 'unresolved'],
  },
  {
    name: 'zig',
    grammar: 'zig',
    extensions: ['.zig'],
    nodes: {
      function: ['function_declaration'],
      // A struct type is named by the `const` that binds it, not by the
      // `struct_declaration` node, so this engine cannot name the owner.
      class: [],
      call: ['call_expression'],
      // `@import("x")` is a builtin call bound to a const, not a declaration.
      import: [],
    },
    selfKeywords: ['self'],
    callTypes: ['internal_func', 'unresolved'],
  },
  {
    name: 'objc',
    grammar: 'objc',
    // `.h` is deliberately not claimed: C and C++ share it and get full-fidelity
    // adapters later; stealing it now would hide their headers from them.
    extensions: ['.m'],
    nodes: {
      function: ['method_definition', 'function_definition'],
      // `@interface` only declares; `@implementation` is where methods live.
      class: ['class_implementation'],
      call: ['call_expression'],
      message: ['message_expression'],
      import: ['preproc_include'],
    },
    selfKeywords: ['self'],
    callTypes: ['internal_func', 'self_method', 'boundary', 'unresolved'],
  },
  {
    name: 'ocaml',
    grammar: 'ocaml',
    // `.mli` holds signatures only — no bodies, so no functions and no calls.
    extensions: ['.ml'],
    nodes: {
      function: ['let_binding'],
      functionRequires: ['parameter'],
      // OCaml modules are namespaces, not method owners.
      class: [],
      call: ['application_expression'],
      import: ['open_module'],
    },
    callTypes: ['internal_func', 'boundary', 'unresolved'],
  },
];
