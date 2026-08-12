# @handbooks/renderer

[English](README.md) · **中文**

> 把生成好的手册变成「人会打开的东西」和「agent 会用来定位的东西」。
> 四种输出格式，不用 LLM，不联网，没有构建步骤。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Frenderer-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbooks/renderer)
[![no LLM](https://img.shields.io/badge/LLM-从不-2dd4bf?style=flat-square)](#)

---

## 这是什么

[Handbook](../../README.zh-CN.md) 工具链的呈现层。它拿 `@handbooks/pipeline` 产出的
边界类型 `HandbookModel`，写出：

| 函数                     | 输出                                                               | 受众  |
| ------------------------ | ------------------------------------------------------------------ | ----- |
| `renderMarkdownHandbook` | `overview.md`、`index.md`、`register.md`，以及每阶段一页           | 人    |
| `renderHtmlSite`         | 共享外壳的多页站点                                                 | 人    |
| `renderSinglePageHtml`   | 一个自包含的 `.html` 文件                                          | 人    |
| `renderAgentSite`        | `how_to_use.md`、`index.md`、`disambiguation.md`，每阶段一页定位块 | agent |
| `renderLlmsTxt`          | `llms.txt` + `llms-full.txt`                                       | agent |

**生成很贵，只做一次；渲染是免费的，可以每次提交都做。**
这个切分正是它单独成包的全部理由。

---

## 安装

```bash
pnpm add @handbooks/renderer
```

---

## 快速上手

```ts
import { loadHandbookModel } from '@handbooks/pipeline';
import {
  renderMarkdownHandbook,
  renderHtmlSite,
  renderSinglePageHtml,
  renderAgentSite,
  renderLlmsTxt,
} from '@handbooks/renderer';

const model = loadHandbookModel('work/myrepo', 'MyRepo 手册');
const out = 'work/myrepo/handbook';

renderMarkdownHandbook(model, out, { sourceBaseUrl: 'https://github.com/me/repo/blob/main' });
renderHtmlSite(model, `${out}/html`);
renderSinglePageHtml(model, `${out}/handbook.html`);
renderAgentSite(model, `${out}/agent`);
renderLlmsTxt(model, out);
```

或者：

```bash
handbook render --work work/myrepo --title "MyRepo 手册" \
    --html --html-single --agent-site --llms-txt \
    --source-base-url https://github.com/me/repo/blob/main
```

---

## Markdown 手册

```
overview.md      系统散文 + mermaid 阶段地图 + 「另见」链接
index.md         全部阶段，按层级嵌套，每个一段，外加没有归入任何阶段的文件
<stage-id>.md    每个有内容的阶段一页
register.md      跨阶段状态表（仅当存在寄存器时）
```

阶段页承载该阶段的摘要、子阶段链接，然后是它的文件——按阶段 2c 决定的分组和顺序排列，
每个渲染成一张**文件卡片**：用途、角色、生命周期、调用事实，以及（deep 卡片的）逐函数注记。

两个比看起来更重要的细节：

- **过期页面会被清理。** 阶段 id 在不同次生成之间会变。每次渲染都会写一份产物清单，
  并在开始时先删掉上一次渲染的页面——**否则一个被改名的阶段会留下一个幽灵页面**，
  然后被 skill 打包器一并卷走。
- **每阶段的寄存器小节是幂等的。** 它挂在一个标记下追加，且只在标记不存在时追加，
  所以重复渲染绝不会堆出重复内容。
- **没有归入任何阶段的文件要被点名，而不是被悄悄丢掉。** 每个页面都由
  `assignment.buckets` 生成（不含这些文件），而抬头的总数用的是 `coverage.nFiles`
  （含这些文件）——所以 index、HTML 总览页、agent 索引和 `llms-full.txt` 都会把它们
  逐个列出来，凡是打印总数的地方都写成「已归入 / 总数」，而不是一个和页面内容互相
  矛盾的数字。

中英文都是一等公民：每个标签、标题、表头都按 `model.lang` 本地化。
**两种语言下结构完全一致**，所以读取输出的工具不需要知道它是哪种语言。

---

## HTML 站点

`renderHtmlSite` 写出 `index.html`、`overview.html`、`register.html` 和每阶段一页，
共享同一个外壳：

- 侧边栏常驻目录，当前页高亮
- 面包屑导航
- 会记住你选择的主题切换
- 函数详情的全部展开 / 全部收起

`renderSinglePageHtml` 把整本手册写成**一个文件**，带编号小节，每个阶段是一个折叠的 `<details>`。

**所有 CSS 和 JS 都内联，所有链接都是相对的。** 两者都能在 `file://` 下工作——
不需要服务器，不需要 CDN，不从任何地方拉字体。你可以把单页输出直接附在工单上，它就是能打开。

---

## Agent 定位索引

这是专门为代码 agent 设计的格式，而且刻意**不是散文**。每个阶段一个固定 schema 的定位块：

| 字段                 | 含义                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **duty**             | 这个阶段负责什么                                                                                                                                                                       |
| **entry concepts**   | 会路由到这里的词汇——从文件名词干推导，并过滤掉泛化词（`util`、`main`、`index`、`types` 等）                                                                                            |
| **state**            | 本阶段读写的寄存器                                                                                                                                                                     |
| **exemplars**        | 最能代表这个阶段的文件                                                                                                                                                                 |
| **strong co-change** | 与源文件**并排放置**的测试文件（`engine.go` + `engine_test.go`）。这是最稀疏的一项，而且是设计使然：大多数项目把测试放在单独的目录树里，所以它通常不出现——那是门控在正常工作，不是缺口 |
| **core files**       | 阶段内出入度最高的文件                                                                                                                                                                 |

### 数据门控不变量

**当且仅当某字段的结构信号存在时才输出它。** 没有占位符，没有「N/A」，没有含糊其辞。
字段为空的意思是*「调用图在这里没有信号」_——**这本身就是有用信息**——
而不是_「模型不知道」*，后者是 agent 会拿去继续推理的噪音。

`disambiguation.md` 处理相反的问题：当一个词确实指向多个阶段时，它把它们并排列出并给出区分点，
让 agent 可以**选择**而不是猜。`strongTwins` 和 `buildCollisionIndex` 就是检测这些碰撞的。

---

## llms.txt

遵循 [llms.txt](https://llmstxt.org/) 约定：

- **`llms.txt`** —— 一个 H1 标题、一句摘要引用块，然后一个 `## Handbook` 小节，
  逐条链接到 markdown 页面并附一句简述。
- **`llms-full.txt`** —— 整本手册按阅读顺序摊平成一份纯 markdown 文档：
  总览散文、mermaid 阶段地图、每阶段的叙述与文件清单，最后是寄存器。

两者都自包含，并遵循 `model.lang`。

---

## 选项

```ts
interface RenderOptions {
  /** 把每个文件卡片的路径变成指向源码的链接。可选。 */
  sourceBaseUrl?: string;
  /** 逐语言的分析能力；驱动保真度披露。可选。 */
  languages?: Record<string, AdapterCapabilities>;
}
```

两个都是可选，且缺省时都是空操作——不给 `sourceBaseUrl` 时输出里
**一个外部 URL 都没有**，这在你要为私有代码库交付手册时很关键。

当 `languages` 显示存在通用层语言时，总览会多出一行披露：

> **保真度说明** —— Kotlin、Scala 的调用关系来自通用（配置驱动）分析器：
> 尽力而为，可能不完整。这些语言的文件清单与结构仍是精确的。

它出现在总览散文正下方——**读者正是在那里形成对调用事实的信任**——
而当所有语言都是完整层时它**根本不出现**，所以常见情况下没有噪音。

---

## API

```ts
renderMarkdownHandbook(model, outDir, options?): { nStagePages: number; files: string[] }
renderHtmlSite(model, outDir, options?)
renderSinglePageHtml(model, outPath, options?)
renderAgentSite(model, outDir, options?)
renderLlmsTxt(model, outDir, options?)

// 构件，导出是因为它们单独也有用
class HandbookView                  // 已解析好的阶段树 + 卡片 + 组织结构
stageMapMermaid(tree): string
renderFileCardMd(file, card, lang, options): string
fileOneLiner(rel, card): string
callFactsLine(fn, lang): string
genericTierLanguages(languages): string[]
stageSectionMarker(lang): string
```

`HandbookView` 是所有渲染器共同坐落其上的解析层：哪些阶段有内容、哪些文件直属某阶段、
分组如何解析、哪些寄存器涉及某阶段。**写一个新输出格式意味着用它，而不是重新推导一遍。**

---

## 保证

- **确定性。** 同样的模型进去，逐字节相同的文件出来。可以放心提交和 diff。
- **离线。** 不联网、不用 LLM、无外部资源、不拉字体。
- **表格注入安全。** 寄存器语义和阶段标题是 LLM 的自由文本；`|` 会被转义、
  换行会被压平，所以一个游离字符不可能破坏表格或多开一列。
- **文件名路径安全。** 阶段 id 在 schema 层被限制为文件名安全字符，
  所以 LLM 输出里的 `/` 或 `..` 永远写不到输出目录之外。

---

## 测试

```bash
pnpm --filter @handbooks/renderer test
```

渲染是对着真实 fixture 模型断言的，**包括那些难看的**：空阶段、缺失散文、零寄存器、
混合保真度、CJK 标题、表格单元格里的竖线。

---

[Handbook](../../README.zh-CN.md) 的一部分 · [产物格式](../../docs/content/docs/reference/artifacts.mdx) · MIT
