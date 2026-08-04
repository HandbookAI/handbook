/**
 * Re-render whatever handbook outputs already exist under `<work>/handbook`
 * so they never silently lag a resync. Formats that were never rendered are
 * not invented. Returns the refreshed format names ([] when nothing exists).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@handbook/core';
import { loadHandbookModel } from '@handbook/pipeline';
import {
  renderAgentSite,
  renderHtmlSite,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbook/renderer';

export function refreshRenderedHandbook(workDir: string, title: string, logger: Logger): string[] {
  const outDir = join(workDir, 'handbook');
  if (!existsSync(outDir)) return [];
  const model = loadHandbookModel(workDir, title);
  renderMarkdownHandbook(model, outDir);
  const refreshed = ['markdown'];
  if (existsSync(join(outDir, 'html'))) {
    renderHtmlSite(model, join(outDir, 'html'));
    refreshed.push('html');
  }
  if (existsSync(join(outDir, 'handbook.html'))) {
    renderSinglePageHtml(model, join(outDir, 'handbook.html'));
    refreshed.push('html-single');
  }
  if (existsSync(join(outDir, 'agent'))) {
    renderAgentSite(model, join(outDir, 'agent'));
    refreshed.push('agent');
  }
  logger.info(`[resync] refreshed rendered handbook: ${refreshed.join(', ')}`);
  return refreshed;
}
