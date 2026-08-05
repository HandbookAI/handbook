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
 * What a language analyzer returns for a set of source files. `edges` contains
 * ALL edges including unresolved ones; partitioning kept/dropped is the graph
 * builder's job (identical across languages).
 */
export interface ModuleAnalysis {
  functions: FunctionNode[];
  edges: CallEdge[];
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
  }),
  nodes: z.record(z.string(), graphNodeSchema),
  edges: z.array(callEdgeSchema),
  selfAttrs: selfAttrsIndexSchema,
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

/** Type guard: is this graph node an internal function? */
export function isInternalNode(node: GraphNode): node is Extract<GraphNode, { kind: 'internal' }> {
  return node.kind === 'internal';
}
