import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureModel } from './fixture.test-helper.js';
import { renderLlmsTxt } from './llms-txt.js';

const model = makeFixtureModel();
let dir: string;
let result: { files: string[] };

const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-renderer-llms-'));
  result = renderLlmsTxt(model, dir);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderLlmsTxt — llms.txt', () => {
  it('writes llms.txt and llms-full.txt and returns their absolute paths', () => {
    expect(existsSync(join(dir, 'llms.txt'))).toBe(true);
    expect(existsSync(join(dir, 'llms-full.txt'))).toBe(true);
    expect(result.files).toEqual([join(dir, 'llms.txt'), join(dir, 'llms-full.txt')]);
  });

  it('opens with the H1 title and a one-sentence summary blockquote', () => {
    const txt = read('llms.txt');
    expect(txt.startsWith('# Fixture Handbook\n')).toBe(true);
    expect(txt).toContain('\n> The system ingests sources, parses them, and answers queries.\n');
  });

  it('lists overview, top-level stages and the register page under ## Handbook', () => {
    const txt = read('llms.txt');
    expect(txt).toContain('## Handbook');
    expect(txt).toContain('- [Overview](overview.md): ');
    expect(txt).toContain('- [Ingestion Pipeline](stage-1.md): Loads raw sources.');
    expect(txt).toContain('- [Query Pipeline](stage-2.md): Answers queries.');
    expect(txt).toContain('- [Test Harness](crosscut-1.md): Shared test infrastructure.');
    expect(txt).toContain('- [State-flow registers](register.md): ');
  });

  it('links only top-level stages, not sub-stages', () => {
    expect(read('llms.txt')).not.toContain('stage-1.1.md');
  });

  it('keeps the handbook link valid when a title has an unbalanced bracket', () => {
    const dirty = structuredClone(model);
    dirty.skeleton.stages[0].title = 'Ingest] beta';
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-llms-brk-'));
    try {
      renderLlmsTxt(dirty, out);
      expect(readFileSync(join(out, 'llms.txt'), 'utf8')).toContain('[Ingest\\] beta](stage-1.md)');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('never references an external http(s) URL', () => {
    expect(read('llms.txt')).not.toMatch(/https?:\/\//);
    expect(read('llms-full.txt')).not.toMatch(/https?:\/\//);
  });
});

describe('renderLlmsTxt — llms-full.txt', () => {
  it('starts with the full system overview prose', () => {
    const full = read('llms-full.txt');
    expect(full.startsWith('# Fixture Handbook\n')).toBe(true);
    expect(full).toContain('## System Overview');
    expect(full).toContain('The system ingests sources, parses them, and answers queries.');
    expect(full).toContain('It is organized as two pipelines plus a shared test harness.');
  });

  it('embeds the mermaid stage map when the skeleton has more than one stage', () => {
    const full = read('llms-full.txt');
    expect(full).toContain('```mermaid');
    expect(full).toContain('flowchart TD');
    expect(full).toContain('stage-1 --> stage-1_1');
  });

  it('renders every content stage with its narration and organized file listing', () => {
    const full = read('llms-full.txt');
    expect(full).toContain('## Ingestion Pipeline (`stage-1`)');
    expect(full).toContain('## Ingestion Parser (`stage-1.1`)');
    expect(full).toContain('Loads and normalizes raw sources for downstream parsing.');
    expect(full).toContain('### Loading');
    expect(full).toContain(
      '- `src/ingest/loader.ts` — Loads raw source files into the ingestion pipeline. [orchestration]',
    );
  });

  it('marks cross-cutting stages', () => {
    expect(read('llms-full.txt')).toContain(
      '## Test Harness (`crosscut-1`) (cross-cutting infrastructure)',
    );
  });

  it('ends with the state registers', () => {
    const full = read('llms-full.txt');
    expect(full).toContain('## State Flow');
    expect(full).toContain(
      '- `reg-parser-cache` — Parsed AST cache shared between load | query paths. (stages: Ingestion Pipeline)',
    );
  });
});

describe('renderLlmsTxt — gating and languages', () => {
  it('omits the register entries when the model has none', () => {
    const bare = structuredClone(model);
    bare.registers = [];
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-llms-bare-'));
    try {
      renderLlmsTxt(bare, out);
      expect(readFileSync(join(out, 'llms.txt'), 'utf8')).not.toContain('register.md');
      expect(readFileSync(join(out, 'llms-full.txt'), 'utf8')).not.toContain('## State Flow');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('uses zh labels when model.lang is zh', () => {
    const zh = structuredClone(model);
    zh.lang = 'zh';
    const out = mkdtempSync(join(tmpdir(), 'hb-renderer-llms-zh-'));
    try {
      renderLlmsTxt(zh, out);
      const txt = readFileSync(join(out, 'llms.txt'), 'utf8');
      expect(txt).toContain('## 手册');
      expect(txt).toContain('- [总览](overview.md)：');
      expect(txt).toContain('- [状态流动登记表](register.md)：');
      const full = readFileSync(join(out, 'llms-full.txt'), 'utf8');
      expect(full).toContain('## 系统总览');
      expect(full).toContain('## 状态流动');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('renderLlmsTxt — fidelity disclosure', () => {
  const generic = {
    kotlin: { tier: 'generic' as const, callTypes: ['internal_func' as const], selfAttrs: false, statementSpans: false },
    python: { tier: 'full' as const, callTypes: ['internal_func' as const], selfAttrs: true, statementSpans: true },
  };

  it('says nothing about fidelity when the option is omitted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-llms-fid-a-'));
    renderLlmsTxt(model, dir);
    const txt = readFileSync(join(dir, 'llms.txt'), 'utf8');
    const full = readFileSync(join(dir, 'llms-full.txt'), 'utf8');
    expect(txt).not.toMatch(/fidelity|保真度/i);
    expect(full).not.toMatch(/fidelity|保真度/i);
  });

  it('says nothing when every contributing language is full tier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-llms-fid-b-'));
    renderLlmsTxt(model, dir, { languages: { python: generic.python } });
    expect(readFileSync(join(dir, 'llms.txt'), 'utf8')).not.toMatch(/fidelity/i);
  });

  it('names only the generic-tier languages, before the link list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-llms-fid-c-'));
    renderLlmsTxt(model, dir, { languages: generic });
    const txt = readFileSync(join(dir, 'llms.txt'), 'utf8');
    expect(txt).toMatch(/Analysis fidelity: call relations for kotlin are best-effort/);
    expect(txt).not.toContain('python are best-effort');
    // an agent may read only the head — the caveat must precede the links
    expect(txt.indexOf('Analysis fidelity')).toBeLessThan(txt.indexOf('## '));
    expect(readFileSync(join(dir, 'llms-full.txt'), 'utf8')).toMatch(/Analysis fidelity/);
  });
});
