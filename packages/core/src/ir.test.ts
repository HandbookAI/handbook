import { describe, expect, it } from 'vitest';
import { adapterCapabilitiesSchema, codeGraphSchema, type CodeGraph } from './ir.js';

const FULL = {
  tier: 'full',
  callTypes: ['self_method', 'internal_func', 'boundary', 'unresolved'],
  selfAttrs: true,
  statementSpans: true,
};

const GENERIC = {
  tier: 'generic',
  callTypes: ['internal_func', 'self_method', 'internal_constructor', 'boundary', 'unresolved'],
  selfAttrs: false,
  statementSpans: false,
};

/** A minimal graph as `buildGraph` writes it, with no `languages` field. */
function graphWithoutLanguages(): Record<string, unknown> {
  return {
    version: 1,
    metadata: {
      generatedAt: '2026-08-05T00:00:00.000Z',
      language: 'python',
      sourceRoot: '/repo',
      scannedFiles: ['app/main.py'],
      nInternalFunctions: 1,
      nBoundaryNodes: 0,
      nEdges: 0,
      policy: 'p',
    },
    nodes: {},
    edges: [],
    selfAttrs: {},
  };
}

describe('adapterCapabilitiesSchema', () => {
  it('accepts both fidelity tiers', () => {
    expect(adapterCapabilitiesSchema.parse(FULL).tier).toBe('full');
    expect(adapterCapabilitiesSchema.parse(GENERIC).tier).toBe('generic');
  });

  it('rejects an unknown tier and an unknown callType', () => {
    expect(adapterCapabilitiesSchema.safeParse({ ...FULL, tier: 'partial' }).success).toBe(false);
    expect(adapterCapabilitiesSchema.safeParse({ ...FULL, callTypes: ['telepathy'] }).success).toBe(false);
  });

  it('requires every capability flag — an omitted flag must not read as false', () => {
    const { selfAttrs: _selfAttrs, ...missingSelfAttrs } = FULL;
    expect(adapterCapabilitiesSchema.safeParse(missingSelfAttrs).success).toBe(false);
    const { statementSpans: _spans, ...missingSpans } = FULL;
    expect(adapterCapabilitiesSchema.safeParse(missingSpans).success).toBe(false);
  });
});

describe('codeGraphSchema.metadata.languages', () => {
  it('still validates a graph written before fidelity tiers existed', () => {
    // There is no migration mechanism: every graph.json already on disk lacks
    // this field, so it must stay optional and the version must stay 1.
    const parsed = codeGraphSchema.parse(graphWithoutLanguages());
    expect(parsed.version).toBe(1);
    expect(parsed.metadata.languages).toBeUndefined();
  });

  it('carries one capability record per contributing language', () => {
    const raw = graphWithoutLanguages();
    (raw.metadata as Record<string, unknown>).languages = { python: FULL, kotlin: GENERIC };
    const parsed: CodeGraph = codeGraphSchema.parse(raw);
    expect(parsed.metadata.languages?.python?.tier).toBe('full');
    expect(parsed.metadata.languages?.kotlin?.tier).toBe('generic');
    expect(parsed.metadata.languages?.kotlin?.callTypes).toContain('internal_func');
  });

  it('rejects a malformed capability record instead of silently keeping it', () => {
    const raw = graphWithoutLanguages();
    (raw.metadata as Record<string, unknown>).languages = { kotlin: { tier: 'generic' } };
    expect(codeGraphSchema.safeParse(raw).success).toBe(false);
  });
});
