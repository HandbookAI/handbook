/**
 * Re-render whatever handbook outputs already exist under `<work>/handbook`
 * so they never silently lag a resync. Formats that were never rendered are
 * not invented. Returns the refreshed format names ([] when nothing exists).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterCapabilities, Logger } from '@handbook/core';
import { WorkDir, loadHandbookModel } from '@handbook/pipeline';
import {
  renderAgentSite,
  renderHtmlSite,
  renderMarkdownHandbook,
  renderSinglePageHtml,
} from '@handbook/renderer';

/**
 * Resolve the handbook title at action time. The `--title` option default
 * cannot read `process.env.HANDBOOK_TITLE` eagerly: that captures the *shell*
 * value at module load, before `--env-file` is applied in the preAction hook,
 * so an env-file HANDBOOK_TITLE would be silently ignored (main.ts documents
 * that HANDBOOK_* may live in the env-file instead of the shell). An explicit
 * `--title` always wins; otherwise fall back to the now-loaded env var.
 *
 * A blank value (empty OR whitespace-only) from either source is treated as
 * "not provided" and falls through — a whitespace-only HANDBOOK_TITLE would
 * otherwise render a handbook titled with nothing but spaces. Non-blank titles
 * are returned verbatim (any intentional surrounding spaces are preserved).
 */
export function resolveTitle(optTitle: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof optTitle === 'string' && optTitle.trim() !== '') return optTitle;
  const fromEnv = env.HANDBOOK_TITLE;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return 'System Handbook';
}

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

export function refreshRenderedHandbook(workDir: string, title: string, logger: Logger): string[] {
  const outDir = join(workDir, 'handbook');
  if (!existsSync(outDir)) return [];
  const model = loadHandbookModel(workDir, title);
  const languages = graphFidelity(workDir);
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
    renderAgentSite(model, join(outDir, 'agent'), { languages });
    refreshed.push('agent');
  }
  logger.info(`[resync] refreshed rendered handbook: ${refreshed.join(', ')}`);
  return refreshed;
}
