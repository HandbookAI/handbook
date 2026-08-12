/**
 * Re-render whatever handbook outputs already exist under `<work>/handbook`
 * so they never silently lag a resync. Formats that were never rendered are
 * not invented. Returns the refreshed format names ([] when nothing exists).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterCapabilities, Logger } from '@handbooks/core';
import { WorkDir, loadHandbookModel } from '@handbooks/pipeline';
import {
  renderAgentSite,
  renderHtmlSite,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbooks/renderer';

/**
 * Per-language analysis fidelity from the work dir's graph, for the renderers'
 * disclosure. Missing or unreadable graph → undefined (say nothing), which is
 * also what every graph written before capabilities existed supports.
 */
export function graphFidelity(workDir: string): Record<string, AdapterCapabilities> | undefined {
  try {
    return new WorkDir(workDir).loadGraph().metadata.languages;
  } catch {
    return undefined;
  }
}

/**
 * Which adapter scanned each file, so a fidelity caveat can sit on the row it
 * governs rather than only in a global note. Same failure rule as above: an
 * unreadable graph says nothing instead of guessing.
 */
export function graphFileLanguages(workDir: string): Record<string, string> | undefined {
  try {
    return new WorkDir(workDir).loadGraph().metadata.fileLanguages;
  } catch {
    return undefined;
  }
}

export function refreshRenderedHandbook(workDir: string, title: string, logger: Logger): string[] {
  const outDir = join(workDir, 'handbook');
  if (!existsSync(outDir)) return [];
  const model = loadHandbookModel(workDir, title);
  const languages = graphFidelity(workDir);
  const fileLanguages = graphFileLanguages(workDir);
  renderMarkdownHandbook(model, outDir, { languages });
  const refreshed = ['markdown'];
  if (existsSync(join(outDir, 'html'))) {
    renderHtmlSite(model, join(outDir, 'html'), { languages });
    refreshed.push('html');
  }
  if (existsSync(join(outDir, 'handbook.html'))) {
    renderSinglePageHtml(model, join(outDir, 'handbook.html'), { languages });
    refreshed.push('html-single');
  }
  if (existsSync(join(outDir, 'agent'))) {
    renderAgentSite(model, join(outDir, 'agent'), { languages, fileLanguages });
    refreshed.push('agent');
  }
  logger.info(`[resync] refreshed rendered handbook: ${refreshed.join(', ')}`);
  return refreshed;
}
