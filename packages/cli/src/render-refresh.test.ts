import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '@handbook/core';
import { MockChatClient, type MockRule } from '@handbook/llm';
import { generateHandbook, loadHandbookModel } from '@handbook/pipeline';
import { renderHtmlSite, renderMarkdownHandbook } from '@handbook/renderer';
import { refreshRenderedHandbook } from './render-refresh.js';

function pipelineMock(): MockChatClient {
  const rules: MockRule[] = [
    {
      match: 'Files to describe',
      respond: (prompt) => ({
        purposes: [...prompt.matchAll(/### FILE: (\S+)/g)].map((m) => ({
          file: m[1],
          purpose: `Purpose for ${m[1]}.`,
          role: 'domain_logic',
          lifecycle: 'main loop',
        })),
      }),
    },
    {
      match: 'dividing a large codebase into the STAGES',
      respond: {
        metadata: { archetype: 'demo' },
        stages: [{ id: 'stage-1', title: 'Core', description: 'All.', parent: null, crosscut: false }],
      },
    },
    {
      match: 'assigning whole SOURCE FILES',
      respond: (prompt) => ({
        assignments: [...prompt.matchAll(/^- (\S+)  \(/gm)].map((m) => ({
          file: m[1],
          stage: 'stage-1',
          also: [],
        })),
      }),
    },
    {
      match: 'organizing the files of ONE stage',
      respond: (prompt) => ({
        groups: [
          {
            title: 'Core',
            summary: '',
            files: [...prompt.matchAll(/^- (\S+?)(?:  \[|\n)/gm)].map((m) => m[1]),
          },
        ],
      }),
    },
    { match: 'STATE REGISTERS', respond: { registers: [] } },
    { match: 'COMPLETING a list of state registers', respond: { registers: [] } },
    { match: 'writing the OVERVIEW for one stage', respond: 'Overview.' },
    { match: 'top-level overview of a system handbook', respond: 'System overview.' },
  ];
  return new MockChatClient(rules);
}

describe('refreshRenderedHandbook', () => {
  let workDir: string;

  beforeAll(async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'hb-rr-src-'));
    workDir = mkdtempSync(join(tmpdir(), 'hb-rr-work-'));
    mkdirSync(join(sourceRoot, 'app'), { recursive: true });
    writeFileSync(join(sourceRoot, 'app', 'main.py'), 'def main():\n    return 1\n');
    await generateHandbook({ sourceRoot, workDir, client: pipelineMock(), phase: 'all' });
  });

  it('does nothing when the handbook was never rendered', () => {
    expect(refreshRenderedHandbook(workDir, 'T', silentLogger)).toEqual([]);
  });

  it('re-renders the markdown handbook when <work>/handbook exists', () => {
    const outDir = join(workDir, 'handbook');
    renderMarkdownHandbook(loadHandbookModel(workDir, 'T'), outDir);
    rmSync(join(outDir, 'overview.md'));
    const refreshed = refreshRenderedHandbook(workDir, 'T', silentLogger);
    expect(refreshed).toContain('markdown');
    expect(existsSync(join(outDir, 'overview.md'))).toBe(true);
    // formats that were never rendered are not invented
    expect(refreshed).not.toContain('html');
    expect(existsSync(join(outDir, 'html'))).toBe(false);
    expect(existsSync(join(outDir, 'handbook.html'))).toBe(false);
  });

  it('refreshes the html site only when it already exists', () => {
    const outDir = join(workDir, 'handbook');
    renderHtmlSite(loadHandbookModel(workDir, 'T'), join(outDir, 'html'));
    rmSync(join(outDir, 'html', 'overview.html'));
    const refreshed = refreshRenderedHandbook(workDir, 'T', silentLogger);
    expect(refreshed).toContain('html');
    expect(existsSync(join(outDir, 'html', 'overview.html'))).toBe(true);
  });
});
