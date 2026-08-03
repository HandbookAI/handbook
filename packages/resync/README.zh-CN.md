# @handbook/resync

代码真的改了之后，把手册的**派生层**往前滚一格，而不重跑整条管线。
给它一个「case 目录」（`edited/` 修改后的源码树、可选的带 declarations 的 `plan.md`、可选的 `change.diff`），
它重新分析修改后的树，把新旧调用图 diff 成 changed / added / deleted 三个文件集合，
然后只更新这些集合牵连到的东西：卡片、归档、组织、叙述、寄存器——并在 case 旁边写一份 `resync-report.json`。
它闭合了 `@handbook/planner` 打开的那个环：plan → apply → resync。

> 英文版：[README.md](README.md)

## 职责

- 加载并校验 case 契约（`loadCase`）：`edited/` 必需，`plan.md` 与 `change.diff` 可选，空 diff 直接短路为跳过。
- 计算「已存图」与「对修改后树重跑阶段 1 得到的新图」之间的结构增量（`diffGraphs`）。
- 为 changed / added 文件重生成卡片，为 added 文件重新归档，丢掉 deleted 文件，并把桶（buckets）对齐。
- 确定性地重建受影响阶段的组织条目，并通过内容哈希缓存重写叙述。
- 把计划里的 declarations 与 unified diff 的文件清单作为**扩范围**输入解析
  （`parsePlanDeclarations`、`filesFromDiff`）。
- **不**重跑骨架合成，也**不**跑医生——阶段结构保持不变，只有派生层往前滚。
- **不**做渲染——重新渲染更新后的 work 目录是调用方（CLI）的事。

## 公开 API

全部在 `resync.ts`：
- `resyncHandbook(options: ResyncOptions): Promise<ResyncReport>` ——
  整个流程；就地更新 work 目录并写出 `<case>/resync-report.json`。
  - `ResyncOptions` —— `{ caseDir, workDir, client?, noLlm?, lang?, detail?（'brief' | 'deep'）, logger? }`；
    除非 `noLlm` 为真，否则 `client` 必填。
  - `ResyncReport` —— `{ skipped, changedFiles, addedFiles, deletedFiles, affectedStages,
    cardsRegenerated, narrated }`。
- `loadCase(caseDir): ResyncCase | undefined` —— 读取 case 目录；返回 `undefined` 表示空 diff（无需同步）。
  - `ResyncCase` —— `{ editedRoot, planText?, declarations?, diffText? }`。
- `parsePlanDeclarations(planText)` —— 取最后一个可解析的、含
  `will_modify`/`will_add`/`will_remove` 的 ` ```json ` 块 → `{ willModify, willAdd, willRemove }`。
- `filesFromDiff(diffText): string[]` —— 从 unified diff 的 `+++/---` 头里取文件路径（跳过 `/dev/null`）。
- `diffGraphs(before, after): GraphDelta` —— 逐文件结构指纹 → `{ changed, added, deleted }`。

## 用法

```ts
import { resyncHandbook } from '@handbook/resync';
import { OpenAiChatClient } from '@handbook/llm';

// case 目录布局：<case>/edited/（改动后的树）、plan.md?、change.diff?
const report = await resyncHandbook({
  caseDir: '/path/to/case',
  workDir: '/path/to/work',   // 存放待前滚的手册产物
  client: new OpenAiChatClient(),
  detail: 'deep',
  lang: 'zh',
});

console.log(report.changedFiles, report.addedFiles, report.deletedFiles);
console.log(report.affectedStages, report.cardsRegenerated, report.narrated);
```

只想刷新结构、完全不花 LLM：传 `noLlm: true` 并省略 `client`——
事实层被刷新，旧散文保留并标注为过期。

## 设计说明

- **基于图指纹的增量**：每个文件的指纹是它在新图里那组排好序的 `qualname@lines:signature` 字符串，
  所以 changed / added / deleted 来自**真实结构**，而不是时间戳或文本 diff。
  图元数据里另外存了逐文件的内容哈希，所以「不增不删、只改函数体」的改动同样能被发现——
  以前这类改动是完全隐形的。
- **范围只能扩大，不能缩小**：计划里的 declarations 与 unified diff 只能往刷新集合里**加**文件
  （比如某文件函数指纹没变但函数体文本改了），**永远不能移除**——结构增量是地板，不是天花板。
- **`noLlm` 模式保留旧卡片散文**，但在 purpose 后面追加「(stale: code changed since narration)」标记，
  同时刷新结构性的函数清单，这样消费方能清楚看到**哪些散文落后于代码**。
- **受影响阶段的组织条目按调用图顺序确定性重建**（标注为「(resynced)」），
  而不是再跑一次 LLM 分组；随后叙述复用阶段 3 的内容哈希缓存，所以没动过的阶段一分钱不花。
- **归档是机械对齐的**（deleted 文件丢掉，added 文件先默认 `unassigned` 再由 LLM 重新归档），
  这样 `buckets` 与 `coverage` 保持一致，且完全不动那些稳定的文件。

## 依赖

内部：
- `@handbook/core` —— 产物类型、文件辅助、`isInternalNode`、错误类型。
- `@handbook/analyzer` —— 间接经由阶段 1 使用（对修改后的树重建新图）。
- `@handbook/pipeline` —— `WorkDir`、`runPhase1`、`generateCards`、`rebuildAssignment`/`reassignSubset`、
  `suggestOrder`/`fileCallAdjacency`、`narrate`、`extractRegisters`、`buildInventory`。
- `@handbook/llm` —— 可选 LLM 环节所用的 `ChatClient` 类型。

外部：无。
