/**
 * Language-agnostic intermediate representation (IR) of a codebase's call graph.
 *
 * Every language analyzer parses source files into the same three node/edge
 * kinds. The pipeline's phase 1 assembles them into a {@link CodeGraph} that is
 * persisted as `graph.json` inside the work directory; every later phase
 * consumes that file instead of re-parsing source.
 */
import { z } from 'zod';

/** How a call site was resolved by the analyzer. */
export const CALL_TYPES = [
  /** `this.method()` / `self.method()` on the caller's own class. */
  'self_method',
  /** `this.attr.method()` where the attribute's type is known. */
  'self_attr_method',
  /** `param.method()` where the parameter's type annotation is known. */
  'param_method',
  /** A call to another internal function (same or different module). */
  'internal_func',
  /** A constructor call of an internal class. */
  'internal_constructor',
  /** A call into an external (non-scanned) module. */
  'boundary',
  /** A constructor call into an external module. */
  'boundary_constructor',
  /** Could not be resolved; the edge is diverted to dropped-calls. */
  'unresolved',
] as const;

export type CallType = (typeof CALL_TYPES)[number];

/**
 * The constrained vocabulary of named types, mapped onto per language.
 *
 * Deliberately small and closed, exactly like `FILE_ROLES`: every language has
 * its own word for "a named thing that is not a function", and if the IR grew a
 * bucket per word the vocabulary would be the union of thirteen grammars and
 * mean nothing to a reader of any single one of them. Six buckets plus an escape
 * hatch, chosen because each names a distinct thing a reader looks up
 * differently:
 *
 * - `class`      — nominal, instantiable, owns methods and state.
 * - `interface`  — a contract with no implementation and no state.
 * - `struct`     — an aggregate of named typed fields, value-ish semantics.
 * - `record`     — an aggregate with generated accessors and VALUE equality.
 * - `enum`       — a closed set of named variants.
 * - `trait`      — a contract that CARRIES implementation (Rust/Scala/PHP).
 * - `alias`      — a second name for another type.
 * - `other`      — a named type this vocabulary cannot describe.
 *
 * `record` earns a bucket rather than being folded into `struct` because folding
 * it is precisely the forcing this vocabulary is meant to avoid: a Java or C#
 * `record` is a reference type, so calling it a struct is wrong in the one
 * language where `struct` is also a keyword meaning something else. Splitting it
 * costs one word and buys a mapping with no lie in it.
 *
 * `other` is the load-bearing member. A construct that does not fit — Java's
 * `@interface`, a C++ `union`, a Go defined type like `type Celsius float64` —
 * goes there rather than into the nearest-looking bucket, because a Java
 * annotation filed as `interface` is a wrong fact, and a wrong fact is worse
 * than a vague one. The native keyword is never lost either way:
 * {@link TypeNode.signature} carries the declaration as written, so `other` plus
 * `@interface Nullable` says more than a forced bucket ever could.
 *
 * Words deliberately NOT given their own bucket, because they are the same thing
 * a listed word already names: a Swift/Objective-C `protocol` is an `interface`;
 * a Kotlin `object` is a `class`; a TypeScript `type X = …` is an `alias`.
 */
export const TYPE_KINDS = [
  'class',
  'interface',
  'struct',
  'record',
  'enum',
  'trait',
  'alias',
  'other',
] as const;

export type TypeKind = (typeof TYPE_KINDS)[number];

/**
 * What one language adapter can actually deliver — its fidelity declaration.
 *
 * Two tiers of analysis coexist: hand-written `full` adapters, and a
 * config-driven `generic` engine that covers the long tail of languages with a
 * declarative spec. Both feed the same IR, so nothing downstream can tell them
 * apart by looking at nodes and edges — which is exactly the trap: a reader
 * (especially a code agent) would assume a generic-tier language's call facts
 * are as hard as Python's. Adapters therefore say what they can do, phase 1
 * records it per language in {@link CodeGraph}'s metadata, and the renderers and
 * Studio disclose it. Same honesty rule the handbook already applies to
 * "assigned vs described" coverage and machine-written descriptions.
 */
export interface AdapterCapabilities {
  tier: 'full' | 'generic';
  /** The callTypes this adapter can actually produce. */
  callTypes: readonly CallType[];
  /** Can it track self/this attribute reads+writes (drives register inference strength)? */
  selfAttrs: boolean;
  /** Can it report statement spans (drives resync snap precision)? */
  statementSpans: boolean;
  /**
   * The {@link TypeKind}s this adapter emits as PARSED {@link TypeNode}s.
   *
   * A list rather than a boolean, and for the same reason `callTypes` is a list:
   * the honest answer is per kind. Go has no `class` and never will; the
   * TypeScript adapter finds classes, interfaces, enums and aliases; an adapter
   * could easily find classes and miss every interface. `types: true` would let
   * that adapter claim the whole territory, and an agent that greps an interface
   * name, gets nothing, and concludes the interface does not exist is the exact
   * wrong-pointer failure the agent artifact exists to prevent — one level down
   * from the generic-tier trap this interface already guards.
   *
   * An EMPTY array is a positive declaration: "this adapter extracts no types at
   * all." Optional, like {@link CodeGraph}'s `languages` and `unparsedFiles` and
   * for the identical reason: there is no artifact-migration mechanism here, so
   * a `graph.json` written before type extraction existed must keep validating,
   * and a hand-rolled or out-of-tree adapter must keep typechecking. **Absent
   * means "this analysis predates the declaration", NOT "no types"** — the
   * renderers report it as unknown rather than as zero. Every in-tree adapter
   * declares it explicitly; `register.test.ts` fails the build if one does not.
   */
  typeKinds?: readonly TypeKind[];
}

/**
 * Validator for {@link AdapterCapabilities}. Typed as a schema OF the interface
 * so the two cannot drift apart unnoticed: adapters are written against the
 * interface, while what lands in `graph.json` is checked by the schema.
 */
export const adapterCapabilitiesSchema: z.ZodType<AdapterCapabilities> = z.object({
  tier: z.enum(['full', 'generic']),
  callTypes: z.array(z.enum(CALL_TYPES)),
  selfAttrs: z.boolean(),
  statementSpans: z.boolean(),
  typeKinds: z.array(z.enum(TYPE_KINDS)).optional(),
});

/**
 * One internal function or method, or a synthesized node (e.g. an implicit
 * constructor that is referenced by an edge but never written as an explicit
 * definition — for those, `synthetic` is true and line numbers are 0).
 */
export const functionNodeSchema = z.object({
  /** Globally unique: `<moduleId><sep><qualname>`, e.g. `app.server.Engine.run`. */
  id: z.string().min(1),
  /** Leaf name, e.g. `run`. */
  name: z.string().min(1),
  /** Name relative to the module, e.g. `Engine.run`. */
  qualname: z.string().min(1),
  /** Path relative to the source root (POSIX separators). */
  file: z.string().min(1),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  signature: z.string(),
  isAsync: z.boolean(),
  isMethod: z.boolean(),
  className: z.string().nullable(),
  decorators: z.array(z.string()),
  kind: z.literal('internal'),
  /** True for nodes not extracted from an explicit definition in source. */
  synthetic: z.boolean(),
  /** Instance attributes this function reads (e.g. `self.x` loads). */
  selfAttrsRead: z.array(z.string()),
  /** Instance attributes this function writes. */
  selfAttrsWritten: z.array(z.string()),
  /** Parameter name → resolved type name (bare or module-qualified). */
  paramTypes: z.record(z.string(), z.string()),
});

export type FunctionNode = z.infer<typeof functionNodeSchema>;

/** One external ("boundary") symbol that an internal function calls. */
export const boundaryNodeSchema = z.object({
  /** `boundary:<qualname>`. */
  id: z.string().min(1),
  /** Leaf segment, e.g. `spawn`. */
  name: z.string(),
  /** Full dotted path, e.g. `tokio.task.spawn`. */
  qualname: z.string(),
  /** Package/module path without a trailing class name. */
  module: z.string(),
  /** Owning class when the callee is a method, else empty string. */
  className: z.string(),
  kind: z.literal('boundary'),
});

export type BoundaryNode = z.infer<typeof boundaryNodeSchema>;

/**
 * One named type declared in the scanned source — a class, interface, struct,
 * enum, trait or alias, parsed from its declaration.
 *
 * ## Why this is not a member of {@link graphNodeSchema}
 *
 * `codeGraphSchema.nodes` is the CALL GRAPH'S VERTEX SET: every member of it is
 * a possible endpoint of a {@link CallEdge}, and `edges` reference members of it
 * by id. A type is not a call endpoint — `new Engine()` produces an edge to
 * `…Engine.constructor`, which is a {@link FunctionNode}, not to the type.
 *
 * That distinction is not academic; it was the deciding factor. Thirteen places
 * read `graph.nodes` today, and every one of them asks "is this a function?" the
 * same way — `isInternalNode(node)`:
 *
 *   `analyzer/graph.ts` (buildNodeTable, functionsCsv, graphDot),
 *   `analyzer/navpack.ts`, `pipeline/inventory.ts`, `pipeline/member.ts` (×2),
 *   `pipeline/organize.ts` (×2), `resync/resync.ts` (×2), `studio/server.ts` (×2).
 *
 * Adding a third `kind` to that union would make every one of them correct only
 * by remembering to ask, and the cost of forgetting is a type rendered as a
 * callable. Two of them are already wrong by construction under that change:
 * `graphDot`'s `if (kind === 'internal') … else` files everything non-internal
 * into the "boundary" cluster, so a type would be drawn as a third-party symbol;
 * and `metadata.nInternalFunctions` counts `kind === 'internal'`, so a type in
 * the union either inflates the function count or needs a silent third counter.
 *
 * A separate collection inverts the default: every existing consumer stays
 * correct with no edit at all, and a consumer that wants types has to name them.
 * That is the difference between a change that is safe and a change that is
 * merely not yet broken.
 *
 * There is also a hard collision: `nodes` is keyed by a globally unique id, and
 * in TypeScript `interface Foo {}` and `function Foo() {}` legally coexist in one
 * module (declaration merging). Sharing the record would let one silently
 * overwrite the other. The `type:` id prefix below keeps the two namespaces
 * apart even for a consumer that indexes both.
 */
export const typeNodeSchema = z.object({
  /** `type:<moduleId><sep><qualname>` — prefixed so it can never collide with a function id. */
  id: z.string().min(1),
  /** Leaf name, e.g. `HandbookModel`. */
  name: z.string().min(1),
  /** Name relative to the module, e.g. `Outer.Inner` for a nested declaration. */
  qualname: z.string().min(1),
  /** Path relative to the source root (POSIX separators). */
  file: z.string().min(1),
  /**
   * 1-based line span of the DECLARATION, both bounds parsed from the
   * declaration node.
   *
   * `positive()`, not `nonnegative()`, and this is the point of the whole node:
   * the interim it replaces synthesised a class's span from `min..max` of its
   * methods — where the members are, not where the declaration is. There is no
   * synthetic {@link TypeNode} and no sentinel span. An adapter that can read a
   * type's NAME but not its position must not emit one, because a range nobody
   * parsed is the one kind of wrong an agent cannot detect: a stale path still
   * fails to open and a stale name still greps nothing, while a fabricated line
   * range opens the wrong code silently.
   */
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  kind: z.enum(TYPE_KINDS),
  /**
   * The declaration header as WRITTEN, whitespace-normalized and truncated —
   * `export interface HandbookModel`, `record Point(int x, int y)`,
   * `type StageId = string`.
   *
   * This is what keeps the closed {@link TYPE_KINDS} vocabulary honest: the kind
   * is for grouping, the signature is the fact. A reader who sees `other` learns
   * the native keyword from this field rather than being told a Java annotation
   * is an interface.
   */
  signature: z.string(),
  /**
   * The enclosing type's QUALNAME for a nested declaration, null at module level
   * — so `qualname` is always `container + sep + name` and stays unique for a
   * type nested more than one level deep.
   */
  container: z.string().nullable(),
});

export type TypeNode = z.infer<typeof typeNodeSchema>;

/** A resolved (or unresolved) call from one function to another node. */
export const callEdgeSchema = z.object({
  callerId: z.string().min(1),
  /** Internal id, `boundary:<qual>`, or `unresolved:<hint>`. */
  calleeId: z.string().min(1),
  isAwait: z.boolean(),
  callType: z.enum(CALL_TYPES),
  line: z.number().int().nonnegative(),
  /** Source text of the call-expression head, truncated to ~80 chars. */
  raw: z.string(),
});

export type CallEdge = z.infer<typeof callEdgeSchema>;

/**
 * Why a scanned file did not yield complete facts.
 *
 * The three cases are kept apart because they cost different things. A file that
 * could not be read or parsed contributes NO functions, so listing it as scanned
 * would make the cards pass describe "a file with 0 functions" and
 * `_coverage.json` count it as fully described — the handbook then asserts, as a
 * parser fact, something the parser never saw. A file that parsed WITH syntax
 * errors did contribute functions, and they are real; what is missing is
 * whatever sat inside the error node, which is invisible from the outside.
 */
export const UNPARSED_REASONS = [
  /** The file could not be read (permissions, a dangling symlink, a race). */
  'unreadable',
  /** The grammar threw, or returned no tree at all. Zero facts. */
  'unparsable',
  /** Parsed, but `rootNode.hasError` — the facts from it are incomplete. */
  'partial',
] as const;

export type UnparsedReason = (typeof UNPARSED_REASONS)[number];

/** One file the analyzer could not fully turn into facts, and why. */
export const unparsedFileSchema = z.object({
  /** Path relative to the source root (POSIX separators). */
  file: z.string().min(1),
  reason: z.enum(UNPARSED_REASONS),
  /** The concrete cause — an errno message, a grammar error, a node count. */
  detail: z.string(),
});

export type UnparsedFile = z.infer<typeof unparsedFileSchema>;

/**
 * What a language analyzer returns for a set of source files. `edges` contains
 * ALL edges including unresolved ones; partitioning kept/dropped is the graph
 * builder's job (identical across languages).
 *
 * `unparsedFiles` is the same refusal-is-information rule invariant 2 applies to
 * call edges, applied one level up: a file the analyzer could not read or could
 * not fully parse is REPORTED, never quietly missing. Optional because
 * `LanguageAdapter` is a public door — a hand-rolled or out-of-tree adapter that
 * predates the field must still typecheck — but every adapter built on the spine
 * fills it.
 */
export interface ModuleAnalysis {
  functions: FunctionNode[];
  edges: CallEdge[];
  unparsedFiles?: UnparsedFile[];
  /**
   * Named types declared in the scanned files — see {@link TypeNode}.
   *
   * Optional, and an absent array is NOT the same statement as an empty one: an
   * adapter that does not extract types at all leaves it undefined, and says so
   * in {@link AdapterCapabilities.typeKinds}, which is where a reader looks. An
   * adapter that DOES extract types and found none in this file set returns `[]`.
   * The capability declaration is what disambiguates the two downstream; this
   * field alone deliberately cannot.
   */
  types?: TypeNode[];
}

/** Degree-annotated node as persisted in `graph.json`. */
export const graphNodeSchema = z.discriminatedUnion('kind', [
  functionNodeSchema.extend({ nCallees: z.number().int(), nCallers: z.number().int() }),
  boundaryNodeSchema.extend({ nCallees: z.number().int(), nCallers: z.number().int() }),
]);

export type GraphNode = z.infer<typeof graphNodeSchema>;

/** Per-class instance-attribute usage index. */
export const selfAttrsIndexSchema = z.record(
  z.string(),
  z.record(z.string(), z.object({ readIn: z.array(z.string()), writtenIn: z.array(z.string()) })),
);

export type SelfAttrsIndex = z.infer<typeof selfAttrsIndexSchema>;

/** The persisted call graph — `<work>/phase1/graph.json`. */
export const codeGraphSchema = z.object({
  version: z.literal(1),
  metadata: z.object({
    generatedAt: z.string(),
    /** Analyzer language, or `multi` for merged multi-language graphs. */
    language: z.string(),
    /** Absolute path of the analyzed source root. */
    sourceRoot: z.string(),
    /** Every file that was scanned (relative POSIX paths). */
    scannedFiles: z.array(z.string()),
    /**
     * Content hash (sha256) per scanned file. Optional for artifacts written
     * by older versions; resync uses it to detect in-place body edits that
     * leave line numbers and signatures untouched.
     */
    fileHashes: z.record(z.string(), z.string()).optional(),
    nInternalFunctions: z.number().int(),
    nBoundaryNodes: z.number().int(),
    nEdges: z.number().int(),
    /**
     * Parsed type declarations — the length of `types` below.
     *
     * Optional and absent (rather than `0`) when no adapter in the run extracts
     * types, so "nobody looked" and "there are none" stay different artifacts,
     * exactly as with `unparsedFiles`. Deliberately NOT folded into
     * `nInternalFunctions`: that number is quoted as the function count in every
     * summary the toolchain prints.
     */
    nTypes: z.number().int().optional(),
    policy: z.string(),
    /**
     * Language name → what the adapter that analyzed it can actually deliver.
     * Per language because a multi-language graph mixes fidelity tiers, and a
     * single `language: 'multi'` label would hide that.
     *
     * Optional on purpose: there is no artifact-migration mechanism here, so
     * every `graph.json` written before fidelity declarations existed must keep
     * validating (bumping `version` would invalidate every existing work dir).
     * Absent = the analysis predates the declaration, NOT "no capabilities".
     */
    languages: z.record(z.string(), adapterCapabilitiesSchema).optional(),
    /**
     * Files whose facts are missing or incomplete — see {@link UnparsedFile}.
     * An EMPTY array is a positive statement ("every scanned file parsed
     * cleanly"); the field being absent means the analysis predates the record,
     * exactly as with `languages`. Files with reason `unreadable` or
     * `unparsable` are additionally kept out of `scannedFiles`, so nothing
     * downstream can mistake them for analyzed files.
     */
    unparsedFiles: z.array(unparsedFileSchema).optional(),
  }),
  nodes: z.record(z.string(), graphNodeSchema),
  edges: z.array(callEdgeSchema),
  selfAttrs: selfAttrsIndexSchema,
  /**
   * Parsed type declarations, sorted by `(file, lineStart, name)` — see
   * {@link TypeNode} for why they are a sibling of `nodes` rather than a third
   * node kind inside it.
   *
   * An ARRAY, not a record keyed by id, because nothing resolves a type by id:
   * every consumer either groups by file (the cards pass, the agent index) or
   * scans the lot. A record would invite exactly the id-keyed lookup that makes
   * a collision matter.
   *
   * Optional, so every `graph.json` written before types existed still validates
   * — zod strips unknown keys, so a field absent from this schema would be
   * silently discarded on load, which is the opposite of what is wanted.
   */
  types: z.array(typeNodeSchema).optional(),
});

export type CodeGraph = z.infer<typeof codeGraphSchema>;

/** Categorized unresolved edges — `<work>/phase1/dropped-calls.json`. */
export const droppedCallsSchema = z.object({
  version: z.literal(1),
  metadata: z.object({
    generatedAt: z.string(),
    totalDropped: z.number().int(),
    byCategory: z.record(z.string(), z.number().int()),
  }),
  edgesByCategory: z.record(
    z.string(),
    z.array(
      z.object({
        caller: z.string(),
        calleeRaw: z.string(),
        isAwait: z.boolean(),
        line: z.number().int(),
        raw: z.string(),
      }),
    ),
  ),
});

export type DroppedCalls = z.infer<typeof droppedCallsSchema>;

/**
 * What the scan could NOT read — `<work>/phase1/scan-coverage.json`.
 *
 * The sibling of `dropped-calls.json`, one level up: that file accounts for
 * every call the analyzer refused to guess, this one accounts for every FILE it
 * refused to claim it analyzed. Written on every run, empty entries and all, so
 * "nothing failed" and "nobody looked" are never the same artifact.
 */
export const scanCoverageSchema = z.object({
  version: z.literal(1),
  metadata: z.object({
    generatedAt: z.string(),
    /** Files that reached the graph — i.e. `graph.metadata.scannedFiles`. */
    nScanned: z.number().int(),
    nUnparsed: z.number().int(),
    byReason: z.record(z.string(), z.number().int()),
  }),
  files: z.array(unparsedFileSchema),
});

export type ScanCoverage = z.infer<typeof scanCoverageSchema>;

/** Type guard: is this graph node an internal function? */
export function isInternalNode(node: GraphNode): node is Extract<GraphNode, { kind: 'internal' }> {
  return node.kind === 'internal';
}
