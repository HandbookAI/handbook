/**
 * @handbooks/renderer — presentation arm of the pipeline.
 *
 * Renders a completed HandbookModel to a markdown handbook, an agent locator
 * site, self-contained HTML (multi-page or single-page), and the llms.txt
 * AI-agent entry files. No LLM involved.
 */
export { fileOneLiner, renderFileCardMd, callFactsLine, REL_NAMES_CAP } from './file-card.js';
export { renderMarkdownHandbook, stageSectionMarker } from './markdown.js';
export { AGENT_INDEX_FILE, renderAgentSite } from './agent-site.js';
export { renderHtmlSite, renderSinglePageHtml } from './html.js';
export { renderLlmsTxt } from './llms-txt.js';
export type { FidelityOptions, RenderOptions, SourceLinkOptions } from './shared.js';
