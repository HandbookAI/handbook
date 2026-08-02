/**
 * In-memory HandbookModel fixture shared by the renderer tests.
 *
 * Shape: two top-level stages (one with a substage) plus one crosscut stage,
 * four files with cards (two function-bearing, one with >10 callees to
 * exercise the cap, one test twin), two registers (one direct-only, one that
 * a leaf stage inherits via a concept word), English narration.
 */
import type { FunctionNote, HandbookModel } from '@handbook/core';

function fn(partial: Partial<FunctionNote> & Pick<FunctionNote, 'id' | 'qualname' | 'name'>): FunctionNote {
  return {
    className: null,
    lineRange: [1, 10],
    signature: '',
    calls: [],
    calledBy: [],
    extCalls: [],
    nCalls: 0,
    nCalledBy: 0,
    nExtCalls: 0,
    purpose: '',
    dataFlow: '',
    relations: '',
    ...partial,
  };
}

export const LOADER = 'src/ingest/loader.ts';
export const PARSER = 'src/ingest/parser.ts';
export const ENGINE = 'src/query/engine.ts';
export const ENGINE_TEST = 'src/query/engine_test.ts';

export function makeFixtureModel(): HandbookModel {
  const manyCalls = Array.from({ length: 12 }, (_, i) => `ingest.reader${i + 1}`);
  return {
    title: 'Fixture Handbook',
    lang: 'en',
    skeleton: {
      metadata: { version: 1, archetype: 'ingestion/query system' },
      stages: [
        {
          id: 'stage-1',
          title: 'Ingestion Pipeline',
          description: 'Loads raw sources.',
          parent: null,
          children: ['stage-1.1'],
          crosscut: false,
        },
        {
          id: 'stage-1.1',
          title: 'Ingestion Parser',
          description: 'Parses sources.',
          parent: 'stage-1',
          children: [],
          crosscut: false,
        },
        {
          id: 'stage-2',
          title: 'Query Pipeline',
          description: 'Answers queries.',
          parent: null,
          children: [],
          crosscut: false,
        },
        {
          id: 'crosscut-1',
          title: 'Test Harness',
          description: 'Shared test infrastructure.',
          parent: null,
          children: [],
          crosscut: true,
        },
      ],
    },
    cards: {
      [LOADER]: {
        version: 1,
        file: LOADER,
        purpose: 'Loads raw source files into the ingestion pipeline.',
        role: 'orchestration',
        lifecycle: 'startup',
        description: 'Coordinates discovery and loading of raw sources, feeding the parser.',
        functions: [
          fn({
            id: 'ingest.loadAll',
            qualname: 'loader.loadAll',
            name: 'loadAll',
            lineRange: [10, 42],
            signature: 'export async function loadAll(root: string): Promise<Source[]>',
            calls: manyCalls,
            nCalls: manyCalls.length,
            calledBy: ['main.run'],
            nCalledBy: 1,
            extCalls: ['fs.readFile'],
            nExtCalls: 1,
            purpose: 'Walk the tree and load every source.',
            dataFlow: 'root path in, Source[] out.',
            relations: 'Fans out to per-format readers.',
          }),
          fn({
            id: 'ingest.openSource',
            qualname: 'loader.openSource',
            name: 'openSource',
            lineRange: [44, 60],
            signature: 'function openSource(path: string): Source',
            calledBy: ['loader.loadAll'],
            nCalledBy: 1,
            purpose: 'Open one source file.',
          }),
        ],
      },
      [PARSER]: {
        version: 1,
        file: PARSER,
        purpose: 'Parses raw sources into AST records.',
        role: 'domain_logic',
        lifecycle: 'none',
        functions: [
          fn({
            id: 'ingest.parseFile',
            qualname: 'parser.parseFile',
            name: 'parseFile',
            lineRange: [5, 30],
            signature: 'export function parseFile(source: Source): Ast',
            calledBy: ['loader.loadAll'],
            nCalledBy: 1,
            purpose: 'Parse one source into an AST.',
          }),
        ],
      },
      [ENGINE]: {
        version: 1,
        file: ENGINE,
        purpose: 'Executes queries over parsed records.',
        role: 'entrypoint',
        lifecycle: 'main loop',
        description: 'The query engine core: plans and executes queries.',
        functions: [
          fn({
            id: 'query.runQuery',
            qualname: 'engine.runQuery',
            name: 'runQuery',
            lineRange: [12, 80],
            signature: 'export function runQuery(plan: Plan): Rows',
            calls: ['parser.parseFile'],
            nCalls: 1,
            purpose: 'Execute one query plan.',
          }),
        ],
      },
      [ENGINE_TEST]: {
        version: 1,
        file: ENGINE_TEST,
        purpose: 'Tests for the query engine.',
        role: 'test',
        lifecycle: 'none',
      },
    },
    assignment: {
      version: 1,
      fileStage: {
        [LOADER]: { stage: 'stage-1', also: [] },
        [PARSER]: { stage: 'stage-1.1', also: [] },
        [ENGINE]: { stage: 'stage-2', also: [] },
        [ENGINE_TEST]: { stage: 'crosscut-1', also: [] },
      },
      buckets: {
        'stage-1': [LOADER],
        'stage-1.1': [PARSER],
        'stage-2': [ENGINE],
        'crosscut-1': [ENGINE_TEST],
      },
      coverage: { nFiles: 4, nAssigned: 4, unassigned: [] },
    },
    organization: {
      metadata: { version: 1, nStages: 4 },
      stages: {
        'stage-1': {
          title: 'Ingestion Pipeline',
          groups: [
            {
              title: 'Loading',
              summary: 'Source loading machinery.',
              files: [{ file: LOADER, purpose: 'Loads raw sources.', role: 'orchestration', nFunctions: 2 }],
            },
          ],
          orderedFiles: [LOADER],
        },
        'stage-1.1': {
          title: 'Ingestion Parser',
          groups: [
            {
              title: 'Parsing',
              summary: 'Parser frontend.',
              files: [{ file: PARSER, purpose: 'Parses sources.', role: 'domain_logic', nFunctions: 1 }],
            },
          ],
          orderedFiles: [PARSER],
        },
        'stage-2': {
          title: 'Query Pipeline',
          groups: [
            {
              title: 'Execution',
              summary: 'Query execution core.',
              files: [{ file: ENGINE, purpose: 'Executes queries.', role: 'entrypoint', nFunctions: 1 }],
            },
          ],
          orderedFiles: [ENGINE],
        },
        'crosscut-1': {
          title: 'Test Harness',
          groups: [
            {
              title: 'Tests',
              summary: 'Engine test suite.',
              files: [{ file: ENGINE_TEST, purpose: 'Engine tests.', role: 'test', nFunctions: 0 }],
            },
          ],
          orderedFiles: [ENGINE_TEST],
        },
      },
      coverage: { nFiles: 4, nOrganized: 4 },
    },
    narration: {
      version: 1,
      lang: 'en',
      systemOverview:
        'The system ingests sources, parses them, and answers queries.\n\nIt is organized as two pipelines plus a shared test harness.',
      stageSummaries: {
        'stage-1':
          'Loads and normalizes raw sources for downstream parsing.\n\nSecond paragraph with loader internals that must not leak into the duty line.',
        'stage-1.1': 'Parses raw sources into AST records for the query pipeline.',
        'stage-2': 'Plans and executes queries over parsed records.',
        'crosscut-1': 'Cross-cutting test infrastructure for the engine.',
      },
    },
    registers: [
      {
        id: 'reg-parser-cache',
        semantics: 'Parsed AST cache shared between load | query paths.',
        stages: ['stage-1'],
      },
      {
        id: 'reg-query-plan',
        semantics: 'Active query plan handle.',
        stages: ['stage-2'],
      },
    ],
  };
}
