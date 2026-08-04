# @handbook/renderer

工具链的呈现端。它接过一份完整的 `HandbookModel`（由 `@handbook/pipeline` 从已完成的 work 目录加载），
渲染成四种形态：给人读的 Markdown 手册、给编码 agent 优化的「定位站点」、自包含 HTML（多页或单页），
以及 `llms.txt` / `llms-full.txt` 这对 AI-agent 入口文件。
渲染**完全确定性**——不碰 LLM，不碰网络。

> 英文版：[README.md](README.md)

## 职责

- 渲染 Markdown 手册：每个有内容的阶段一页，外加 `overview.md`（骨架超过一个阶段时内嵌 mermaid 阶段地图）、`index.md`、`register.md`。
- 渲染 llms.txt 入口文件：`llms.txt`（标题、摘要引用块、指向 Markdown 各页的链接目录）
  与 `llms-full.txt`（整本手册压平成一份纯 Markdown 文档）。
- 渲染 agent 定位站点：固定 schema 的阶段块（`Duty`、`Entry concepts`、`State`、`Exemplar`、
  `Strong co-change`、`Core files`）、`how_to_use.md`，以及由标题词元碰撞索引生成的 `disambiguation.md`。
- 渲染自包含 HTML：带侧边目录与主题切换的多页站点，以及带编号可折叠区块的单页版本。
- 渲染各输出共用的文件级叶子内容（`renderFileCardMd`），包含来自调用图的事实行。
- 通过内部标签表支持两种叙述语言（`en`/`zh`）。
- **不**生成也**不**修改手册内容——叙述缺失时回退到阶段的描述或标题，**绝不**新造散文。
- **不**读 work 目录；它唯一的输入就是 `HandbookModel` 这个边界类型。

## 公开 API

**Markdown 手册**（`markdown.ts`）
- `renderMarkdownHandbook(model, outDir, options?): { nStagePages, files }` ——
  为每个有内容的阶段写 `<sid>.md`，外加 `overview.md`（含 mermaid 阶段地图）、`index.md`，
  以及（存在寄存器时）`register.md`；逐阶段的寄存器小节以幂等方式追加。
  `options: { sourceBaseUrl? }` 见下文。
- `stageSectionMarker(lang)` —— 上述幂等追加所用的标记标题。

**llms.txt 入口文件**（`llms-txt.ts`）
- `renderLlmsTxt(model, outDir): { files }` —— 向 `outDir` 写出 `llms.txt` 与 `llms-full.txt`
  （应与 Markdown 手册渲染进同一目录，`llms.txt` 里的链接才能解析）。
  `llms.txt` 遵循 llms.txt 约定：`# 标题`、由系统总览叙述推导的 `>` 摘要引用块、
  然后是 `## 手册` 链接列表（总览、各顶层阶段、寄存器页），每行附一句简短描述。
  `llms-full.txt` 按阅读顺序串起完整手册内容——总览散文、阶段地图、每个阶段的叙述与
  按组织排序的文件清单（含 purpose）、寄存器——纯 Markdown，不含链接。

**agent 定位站点**（`agent-site.ts`）
- `renderAgentSite(model, outDir): { nStagePages, nCollisions }` ——
  写出 `how_to_use.md`、`index.md`、`disambiguation.md`，以及每个有内容阶段的一张定位页。

**HTML**（`html.ts`）
- `renderHtmlSite(model, outDir, options?): { nPages }` —— 多页站点（`index.html` 跳转页、`overview.html`、
  `register.html`、`<sid>.html`），共用一套外壳（吸顶侧栏、面包屑、记忆主题切换、全部展开/收起）。
  `options: { sourceBaseUrl? }` 见下文。
- `renderSinglePageHtml(model, outPath): { bytes }` —— 单个自包含页面；每个阶段是一个编号且默认折叠的
  `<details>` 区块。

**源码链接**（`SourceLinkOptions`）
- `renderMarkdownHandbook` 与 `renderHtmlSite` 接受可选的 `{ sourceBaseUrl }`。
  设置后，每张文件卡片的路径都变成指向 `<base>/<path>` 的超链接
  （base 末尾的 `/` 会剥掉，路径分段做 URL 编码、保留 `/` 分隔符），例如代码托管平台的 blob URL。
  不设置时，输出与该选项出现之前逐字节一致，且不含任何外部 URL。

**文件卡片**（`file-card.ts`）
- `renderFileCardMd(rel, card, lang, options?)` —— 单个文件的完整 Markdown 卡片：
  role / lifecycle 徽标、描述（缺失时回退到 purpose）、逐函数细节；
  `options: { sourceBaseUrl? }` 会把标题里的路径链接到源码文件。
- `fileOneLiner(rel, card)` —— 一行式条目 `- \`rel\` — purpose [role]`。
- `callFactsLine(fn, lang)` —— 单个 `FunctionNote` 的结构性调用图事实行。
- `REL_NAMES_CAP` —— 每个关系列表最多显示多少个名字，超出折叠为 `(+K more)`。

## 用法

```ts
import { renderMarkdownHandbook, renderAgentSite, renderHtmlSite, renderSinglePageHtml, renderLlmsTxt } from '@handbook/renderer';
import { loadHandbookModel } from '@handbook/pipeline';

const model = loadHandbookModel('/path/to/work', '我的项目手册');

const md = renderMarkdownHandbook(model, '/path/to/out');
const llms = renderLlmsTxt(model, '/path/to/out'); // 同一目录，llms.txt 的链接才能解析
const agent = renderAgentSite(model, '/path/to/out/agent');
const html = renderHtmlSite(model, '/path/to/out/html');
const single = renderSinglePageHtml(model, '/path/to/out/handbook.html');

// 按需开启源码链接（仅 Markdown 与多页 HTML）：
renderMarkdownHandbook(model, '/path/to/out', { sourceBaseUrl: 'https://forge.example/repo/blob/main' });

console.log(md.nStagePages, llms.files, agent.nCollisions, html.nPages, single.bytes);
```

## 设计说明

- **全程没有 LLM**：每个输出都是 `HandbookModel` 的纯函数，所以渲染是瞬时的、可复现的、可以随便重跑。
- **自包含 HTML**：CSS/JS 全部内联，链接全是相对路径，没有任何外部资源，
  所以两种 HTML 产物都能在 `file://` 下直接打开、原样分发。
  只有显式传入 `sourceBaseUrl` 时才会出现外部 URL。
- **mermaid 阶段地图只进 Markdown 产物**（`overview.md` 与 `llms-full.txt`）——
  HTML 产物**刻意不**内嵌它：渲染 mermaid 需要引入 JS 库，而 HTML 必须保持零依赖。
- **agent 定位字段以结构信号为门槛**：某个字段（同变孪生、寄存器命中、词义碰撞、范例）
  **有信号才输出**；`how_to_use.md` 明确告诉 agent：空字段本身就是信息，**不是**让你去编的地方。
- **内容门槛统一**：一个阶段有子阶段或直接归档的文件才会有页面与摘要（`HandbookView.hasContent`），
  所以骨架里的空节点不会产出空页面。
- **消歧索引由阶段标题的词元碰撞算出**（文档频率 2–6，纯祖先链排除），
  给 agent 一份确定性的「这个词会落到好几个阶段」的地图。
- **Markdown 的寄存器小节追加在标记标题之后**，所以对着已有输出目录重新渲染保持幂等。
- **重新渲染会先清理上一代写过的页面**（依据 `.render-manifest.json` 清单）。
  否则改了骨架之后，旧阶段的页面会作为孤儿留在目录里，看着像现役内容。

## 依赖

内部：
- `@handbook/core` —— `HandbookModel` 及相关类型、`StageTree`、原子写、文本辅助。

外部：
- `markdown-it` —— 把叙述/描述的 Markdown 渲染成 HTML，供两种 HTML 产物使用
  （Markdown 产物本身不需要任何依赖）。
