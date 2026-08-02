/**
 * HTML renderers (no LLM, no network).
 *
 * `renderHtmlSite` writes a multi-page site (index/overview/register/<sid>.html)
 * with a shared shell: sticky sidebar TOC, breadcrumb, persisted theme toggle,
 * expand/collapse-all buttons. `renderSinglePageHtml` writes one self-contained
 * page with numbered sections and every stage as a collapsed `<details>`.
 * All CSS/JS is inlined and every link is relative, so both work over file://.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Markdown } from 'markdown-it';
import { ensureDir, firstSentence, truncate, writeFileAtomic } from '@handbook/core';
import type { FileCard, FunctionNote, HandbookModel, NarrateLang } from '@handbook/core';
import { callFactsLine } from './file-card.js';
import { HandbookView } from './shared.js';

interface HtmlLabels {
  systemOverview: string;
  stages: string;
  subStages: string;
  filesInStage: string;
  functions: string;
  registers: string;
  registersTouched: string;
  registerHeader: [string, string, string];
  overview: string;
  theme: string;
  expandAll: string;
  collapseAll: string;
  system: string;
  crosscut: string;
  files: (n: number) => string;
  lines: (a: number, b: number) => string;
  purpose: string;
  dataFlow: string;
  relations: string;
  noProse: string;
}

const LABELS: Record<NarrateLang, HtmlLabels> = {
  en: {
    systemOverview: '🗺️ System Overview',
    stages: 'Stages',
    subStages: 'Sub-stages',
    filesInStage: 'Files in this stage',
    functions: 'Functions',
    registers: '🔄 State Flow Overview',
    registersTouched: '📊 State Registers Touched',
    registerHeader: ['State register', 'Semantics', 'Stages touched'],
    overview: 'Overview',
    theme: '🌓 Theme',
    expandAll: 'Expand all',
    collapseAll: 'Collapse all',
    system: 'System',
    crosscut: 'cross-cutting',
    files: (n) => `${n} files`,
    lines: (a, b) => `lines ${a}–${b}`,
    purpose: 'Purpose',
    dataFlow: 'Data flow',
    relations: 'Call relations',
    noProse: '(This file has no description yet.)',
  },
  zh: {
    systemOverview: '🗺️ 系统总览',
    stages: '阶段',
    subStages: '子阶段',
    filesInStage: '本阶段的文件',
    functions: '函数',
    registers: '🔄 状态流动总览',
    registersTouched: '📊 本阶段涉及的状态',
    registerHeader: ['状态寄存器', '语义', '涉及阶段'],
    overview: '总览',
    theme: '🌓 主题',
    expandAll: '展开全部',
    collapseAll: '收起全部',
    system: '系统',
    crosscut: '横切',
    files: (n) => `${n} 个文件`,
    lines: (a, b) => `行 ${a}–${b}`,
    purpose: '作用',
    dataFlow: '数据流',
    relations: '调用关系',
    noProse: '（该文件暂无描述。）',
  },
};

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--accent:#0969da;--card:#f6f8fa;--code:#f6f8fa;--warn:#9a6700}
[data-theme="dark"]{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--accent:#4493f8;--card:#151b23;--code:#161b22;--warn:#d29922}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.layout{display:flex;align-items:flex-start}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;width:300px;flex:none;border-right:1px solid var(--border);padding:16px 12px;font-size:13px}
.sidebar ul{list-style:none;margin:0;padding-left:14px}
.sidebar>ul{padding-left:0}
.sidebar a{color:var(--fg);display:block;padding:2px 8px;border-radius:6px}
.sidebar a:hover{background:var(--card);text-decoration:none}
.sidebar a.cur{background:var(--card);color:var(--accent);font-weight:600}
.brand{font-weight:700;margin:0 0 10px;padding:0 8px}
.main{flex:1;min-width:0;max-width:980px;padding:0 32px 64px}
.topbar{display:flex;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);margin-bottom:24px;position:sticky;top:0;background:var(--bg);z-index:5}
.crumb{flex:1;color:var(--muted);font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar button{background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
.topbar button:hover{border-color:var(--accent)}
.meta{color:var(--muted);font-size:13px}
.badge{display:inline-block;border:1px solid var(--border);background:var(--card);color:var(--muted);border-radius:999px;padding:0 8px;font-size:11px;vertical-align:middle}
.badge.crosscut{color:var(--warn);border-color:var(--warn)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:0;margin:16px 0}
.card{border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--card)}
.card p{margin:6px 0 0;font-size:13px;color:var(--muted)}
details{border:1px solid var(--border);border-radius:8px;margin:10px 0;padding:0 14px;background:var(--card)}
details[open]{padding-bottom:10px}
summary{cursor:pointer;padding:9px 0;font-weight:600}
details.fn{background:var(--bg)}
details.stage>summary{font-size:17px}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
code{background:var(--code);border-radius:6px;padding:1px 5px}
pre{background:var(--code);border-radius:6px;padding:10px 12px;overflow-x:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--card)}
h1,h2,h3{line-height:1.3}
hr{border:none;border-top:1px solid var(--border)}
.fnfields p{margin:6px 0}
.callfacts{color:var(--muted);font-style:italic}
`;

const SCRIPT = `
(function(){try{if(localStorage.getItem('hb-theme')==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();
function hbTheme(){var r=document.documentElement;var dark=r.getAttribute('data-theme')==='dark';
if(dark){r.removeAttribute('data-theme');}else{r.setAttribute('data-theme','dark');}
try{localStorage.setItem('hb-theme',dark?'light':'dark');}catch(e){}}
function hbAll(open){document.querySelectorAll('.main details').forEach(function(d){d.open=open;});}
`;

function makeMd(): Markdown {
  return new MarkdownIt({ html: false, linkify: false });
}

/** Nested sidebar list over content stages; `href` maps a sid to its link target. */
function sidebarTree(view: HandbookView, current: string, href: (sid: string) => string): string {
  const item = (sid: string): string => {
    const cur = sid === current ? ' class="cur"' : '';
    const children = view.contentChildren(sid);
    const nested = children.length > 0 ? `<ul>${children.map(item).join('')}</ul>` : '';
    return `<li><a${cur} href="${href(sid)}">${esc(view.tree.title(sid))}</a>${nested}</li>`;
  };
  return `<ul>${view.contentRoots().map(item).join('')}</ul>`;
}

function breadcrumb(view: HandbookView, sid: string | null, lang: NarrateLang): string {
  const L = LABELS[lang];
  const parts = [`<a href="overview.html">${esc(L.system)}</a>`];
  if (sid !== null) {
    const chain = [...view.ancestors(sid)].reverse();
    for (const ancestor of chain) parts.push(`<a href="${ancestor}.html">${esc(view.tree.title(ancestor))}</a>`);
    parts.push(esc(view.tree.title(sid)));
  }
  return parts.join(' / ');
}

function page(
  view: HandbookView,
  lang: NarrateLang,
  title: string,
  current: string,
  crumbSid: string | null,
  body: string,
): string {
  const L = LABELS[lang];
  const regLink =
    view.model.registers.length > 0
      ? `<li><a${current === 'register' ? ' class="cur"' : ''} href="register.html">${esc(L.registers)}</a></li>`
      : '';
  const sidebar = `
<nav class="sidebar">
<p class="brand">${esc(view.model.title)}</p>
<ul>
<li><a${current === 'overview' ? ' class="cur"' : ''} href="overview.html">${esc(L.overview)}</a></li>
${regLink}
</ul>
${sidebarTree(view, current, (sid) => `${sid}.html`)}
</nav>`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
<script>${SCRIPT}</script>
</head>
<body>
<div class="layout">
${sidebar}
<div class="main">
<div class="topbar">
<span class="crumb">${breadcrumb(view, crumbSid, lang)}</span>
<button onclick="hbTheme()">${esc(L.theme)}</button>
<button onclick="hbAll(true)">${esc(L.expandAll)}</button>
<button onclick="hbAll(false)">${esc(L.collapseAll)}</button>
</div>
${body}
</div>
</div>
</body>
</html>
`;
}

function stageCard(view: HandbookView, sid: string, lang: NarrateLang, href: string): string {
  const L = LABELS[lang];
  const badge = view.tree.isCrosscut(sid) ? ` <span class="badge crosscut">${esc(L.crosscut)}</span>` : '';
  const blurb = truncate(firstSentence(view.summary(sid)), 160);
  return `<div class="card"><a href="${href}"><strong>${esc(view.tree.title(sid))}</strong></a>${badge}<div class="meta"><code>${esc(sid)}</code> · ${esc(L.files(view.subtreeFileCount(sid)))}</div><p>${esc(blurb)}</p></div>`;
}

function functionDetails(fn: FunctionNote, lang: NarrateLang): string {
  const L = LABELS[lang];
  const fields: string[] = [];
  if (fn.signature.trim().length > 0) fields.push(`<pre><code>${esc(fn.signature.trim())}</code></pre>`);
  if (fn.purpose.trim().length > 0) fields.push(`<p><strong>${esc(L.purpose)}</strong>: ${esc(fn.purpose.trim())}</p>`);
  if (fn.dataFlow.trim().length > 0) fields.push(`<p><strong>${esc(L.dataFlow)}</strong>: ${esc(fn.dataFlow.trim())}</p>`);
  if (fn.relations.trim().length > 0) fields.push(`<p><strong>${esc(L.relations)}</strong>: ${esc(fn.relations.trim())}</p>`);
  const facts = callFactsLine(fn, lang);
  if (facts.length > 0) fields.push(`<p class="callfacts">${esc(facts.replace(/\*/g, ''))}</p>`);
  return `<details class="fn"><summary><code>${esc(fn.qualname)}</code> <span class="meta">${esc(L.lines(fn.lineRange[0], fn.lineRange[1]))}</span></summary><div class="fnfields">${fields.join('')}</div></details>`;
}

function fileDetails(md: Markdown, rel: string, card: FileCard, lang: NarrateLang): string {
  const L = LABELS[lang];
  const lifecycle = card.lifecycle.trim();
  const lifecycleBadge = lifecycle.length > 0 && lifecycle !== 'none' ? ` <span class="badge">${esc(lifecycle)}</span>` : '';
  const prose = (card.description ?? '').trim() || card.purpose.trim() || L.noProse;
  const functions = card.functions ?? [];
  const fnBlock =
    functions.length > 0
      ? `<h4>${esc(L.functions)}</h4>${functions.map((fn) => functionDetails(fn, lang)).join('')}`
      : '';
  return `<details><summary><code>${esc(rel)}</code> <span class="badge">${esc(card.role)}</span>${lifecycleBadge}</summary>${md.render(prose)}${fnBlock}</details>`;
}

/** The stage body shared by the multi-page stage page and the single-page section. */
function stageBody(
  view: HandbookView,
  md: Markdown,
  sid: string,
  lang: NarrateLang,
  childHref: (child: string) => string,
): string {
  const L = LABELS[lang];
  const parts: string[] = [md.render(view.summary(sid))];
  const children = view.contentChildren(sid);
  if (children.length > 0) {
    parts.push(`<h2>${esc(L.subStages)}</h2><div class="cards">${children.map((c) => stageCard(view, c, lang, childHref(c))).join('')}</div>`);
  }
  const direct = view.directFiles(sid);
  if (direct.length > 0) {
    parts.push(`<h2>${esc(L.filesInStage)}</h2>`);
    const { groups, leftovers } = view.groups(sid);
    for (const group of groups) {
      parts.push(`<h3>${esc(group.title)}</h3>`);
      if (group.summary.trim().length > 0) parts.push(md.render(group.summary.trim()));
      for (const file of group.files) parts.push(fileDetails(md, file, view.card(file), lang));
    }
    for (const file of leftovers) parts.push(fileDetails(md, file, view.card(file), lang));
  }
  const regs = view.directRegisters(sid);
  if (regs.length > 0) {
    const bullets = regs.map((r) => `<li><code>${esc(r.id)}</code> — ${esc(r.semantics)}</li>`);
    parts.push(`<h2>${esc(L.registersTouched)}</h2><ul>${bullets.join('')}</ul>`);
  }
  return parts.join('\n');
}

function registerTableHtml(view: HandbookView, lang: NarrateLang, stageHref: (sid: string) => string): string {
  const L = LABELS[lang];
  const [h1, h2, h3] = L.registerHeader;
  const rows = view.model.registers.map((reg) => {
    const stages = reg.stages
      .map((sid) => `<a href="${stageHref(sid)}">${esc(view.tree.title(sid))}</a>`)
      .join(', ');
    return `<tr><td><code>${esc(reg.id)}</code></td><td>${esc(reg.semantics)}</td><td>${stages}</td></tr>`;
  });
  return `<table><thead><tr><th>${esc(h1)}</th><th>${esc(h2)}</th><th>${esc(h3)}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

/** Render the multi-page HTML site into `outDir`. */
export function renderHtmlSite(model: HandbookModel, outDir: string): { nPages: number } {
  const view = new HandbookView(model);
  const lang = model.lang;
  const L = LABELS[lang];
  const md = makeMd();
  ensureDir(outDir);
  let nPages = 0;
  const write = (name: string, content: string): void => {
    writeFileAtomic(join(outDir, name), content);
    nPages += 1;
  };

  // index.html — meta-refresh redirect to overview.html.
  write(
    'index.html',
    `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=overview.html"><title>${esc(model.title)}</title></head>
<body><p><a href="overview.html">${esc(L.overview)}</a></p></body></html>
`,
  );

  // overview.html
  const overviewParts: string[] = [
    `<h1>${esc(L.systemOverview)}</h1>`,
    md.render(model.narration.systemOverview.trim()),
  ];
  if (model.registers.length > 0) {
    overviewParts.push(`<p><a href="register.html">${esc(L.registers)}</a></p>`);
  }
  overviewParts.push(
    `<h2>${esc(L.stages)}</h2><div class="cards">${view
      .contentRoots()
      .map((sid) => stageCard(view, sid, lang, `${sid}.html`))
      .join('')}</div>`,
  );
  write('overview.html', page(view, lang, model.title, 'overview', null, overviewParts.join('\n')));

  // register.html
  if (model.registers.length > 0) {
    const body = `<h1>${esc(L.registers)}</h1>${registerTableHtml(view, lang, (sid) => `${sid}.html`)}`;
    write('register.html', page(view, lang, `${model.title} — ${L.registers}`, 'register', null, body));
  }

  // <sid>.html per content-bearing stage.
  for (const sid of view.contentStages()) {
    const badge = view.tree.isCrosscut(sid) ? ` <span class="badge crosscut">${esc(L.crosscut)}</span>` : '';
    const body = [
      `<h1>${esc(view.tree.title(sid))}${badge}</h1>`,
      `<p class="meta"><code>${esc(sid)}</code> · ${esc(L.files(view.subtreeFileCount(sid)))}</p>`,
      stageBody(view, md, sid, lang, (child) => `${child}.html`),
    ].join('\n');
    write(`${sid}.html`, page(view, lang, `${view.tree.title(sid)} — ${model.title}`, sid, sid, body));
  }

  return { nPages };
}

/** Hierarchical section numbers (1, 1.1, 1.1.1 …) over content stages. */
function numberMap(view: HandbookView): Map<string, string> {
  const numbers = new Map<string, string>();
  const walk = (sids: readonly string[], prefix: string): void => {
    sids.forEach((sid, i) => {
      const num = prefix.length > 0 ? `${prefix}.${i + 1}` : `${i + 1}`;
      numbers.set(sid, num);
      walk(view.contentChildren(sid), num);
    });
  };
  walk(view.contentRoots(), '');
  return numbers;
}

/** Render the whole handbook as one self-contained HTML page at `outPath`. */
export function renderSinglePageHtml(model: HandbookModel, outPath: string): { bytes: number } {
  const view = new HandbookView(model);
  const lang = model.lang;
  const L = LABELS[lang];
  const md = makeMd();
  const numbers = numberMap(view);

  const tocItem = (sid: string): string => {
    const children = view.contentChildren(sid);
    const nested = children.length > 0 ? `<ul>${children.map(tocItem).join('')}</ul>` : '';
    return `<li><a href="#${sid}">${numbers.get(sid)} ${esc(view.tree.title(sid))}</a>${nested}</li>`;
  };
  const regToc =
    model.registers.length > 0 ? `<li><a href="#registers">${esc(L.registers)}</a></li>` : '';
  const sidebar = `<nav class="sidebar"><p class="brand">${esc(model.title)}</p><ul><li><a href="#top">${esc(L.overview)}</a></li>${regToc}</ul>${`<ul>${view.contentRoots().map(tocItem).join('')}</ul>`}</nav>`;

  const sections: string[] = [];
  const emit = (sid: string): void => {
    const badge = view.tree.isCrosscut(sid) ? ` <span class="badge crosscut">${esc(L.crosscut)}</span>` : '';
    const meta = `<code>${esc(sid)}</code> · ${esc(L.files(view.subtreeFileCount(sid)))}`;
    const body = stageBody(view, md, sid, lang, (child) => `#${child}`);
    sections.push(
      `<details class="stage" id="${sid}"><summary>${numbers.get(sid)} ${esc(view.tree.title(sid))}${badge} <span class="meta">${meta}</span></summary>${body}</details>`,
    );
    for (const child of view.contentChildren(sid)) emit(child);
  };
  for (const root of view.contentRoots()) emit(root);

  const registersSection =
    model.registers.length > 0
      ? `<h2 id="registers">${esc(L.registers)}</h2>${registerTableHtml(view, lang, (sid) => `#${sid}`)}`
      : '';

  const body = [
    `<h1 id="top">${esc(model.title)}</h1>`,
    `<h2>${esc(L.systemOverview)}</h2>`,
    md.render(model.narration.systemOverview.trim()),
    `<div class="cards">${view.contentRoots().map((sid) => stageCard(view, sid, lang, `#${sid}`)).join('')}</div>`,
    sections.join('\n'),
    registersSection,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(model.title)}</title>
<style>${CSS}</style>
<script>${SCRIPT}</script>
</head>
<body>
<div class="layout">
${sidebar}
<div class="main">
<div class="topbar">
<span class="crumb">${esc(L.system)}</span>
<button onclick="hbTheme()">${esc(L.theme)}</button>
<button onclick="hbAll(true)">${esc(L.expandAll)}</button>
<button onclick="hbAll(false)">${esc(L.collapseAll)}</button>
</div>
${body}
</div>
</div>
</body>
</html>
`;
  writeFileAtomic(outPath, html);
  return { bytes: statSync(outPath).size };
}
