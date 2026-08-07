# @handbook/pipeline

手册生成管线：从一张静态调用图，走到一本叙述完整的手册模型。它拥有 work 目录布局，并编排各个阶段——
1（经 `@handbook/analyzer` 提取调用图）、2a（逐文件卡片）、2b（阶段骨架 + 文件归档，可选启用 actor–critic「医生」）、
2c（阶段内组织）、3（自底向上叙述 + 状态寄存器）。它的产出是一个 work 目录，
`loadHandbookModel` 把它变成 `HandbookModel`，交给 `@handbook/renderer` 与 `@handbook/skill` 消费。

> 英文版：[README.md](README.md)

## 职责

- 拥有 work 目录布局，以及带类型、带 schema 校验的产物读写（`WorkDir`）。
- 运行阶段 1（确定性、无 LLM）与阶段 2a/2b/2c/3（LLM 驱动），支持阶段选择与前置条件检查
  （`generateHandbook`、`expandPhases`）。
- 逐文件生成卡片，**覆盖率在构造上就是完整的**，并附带从调用图导出的函数清单（`generateCards`、`buildInventory`）。
- 合成、修复并归档阶段骨架（`synthesizeSkeleton`、`synthesizeWithDoctor`、`assignFiles`），
  再把每个阶段内的文件组织成有序分组（`organizeStages`）。
- 产出叙述与跨阶段状态寄存器（`narrate`、`extractRegisters`），
  以及适合较小代码库的成员粒度策略（`classifyMembers`、`deriveFileArtifacts`）。
- **不**做任何渲染——呈现是 `@handbook/renderer` 的事，边界就是 `HandbookModel`。
- **不**直接跟 LLM 端点通信——每次调用都走注入进来的 `ChatClient`。

## 公开 API

**编排**（`generate.ts`）

- `generateHandbook(options: GenerateOptions): Promise<GenerateStats>` —— 运行选定阶段。
  `GenerateOptions` 覆盖 `sourceRoot`、`workDir`、`client?`、`phase?`、`strategy?`（`'file' | 'member'`）、
  `skeletonPath?`、`lang?`、`narrateLang?`、`detail?`、`synthMode?`（`'oneshot' | 'doctor'`）、
  并发与批量参数、`resume?`、`refresh?`。
- `expandPhases(spec)` / `Phase` —— 解析 `all | 1 | 2 | 2a | 2b | 2c | 3` 或逗号列表。
- `loadHandbookModel(workDir, title): HandbookModel` —— 加载一个已完成的 work 目录供渲染器使用。

**work 目录**（`workdir.ts`）

- `WorkDir` —— 路径读取器（`graphPath`、`cardsDir`、`skeletonPath`、`assignmentPath`、`organizationPath`、
  `narrationPath`、`registersPath`、`cacheDir`），每种产物的带校验 `load*`/`save*`，以及 `parseSkeletonYaml`。
- 诊断留存：`saveRejectedReply(file, text)` / `rejectedReplyCount()` / `clearRejectedReplies()` ——
  把「有回复但没产出可用内容」的原始回复留在 `phase2/cards/_rejected/`，每次运行前清空、数量有上限、
  文件名带哈希后缀（否则所有中文路径会撞成同一个名字）。

**阶段 1 与事实层**

- `runPhase1(options: Phase1Options): Promise<Phase1Stats>` —— 扫描（`lang: 'auto'` 合并所有已注册语言）、
  构建并落盘调用图。
- `buildInventory(graph): Record<string, FunctionNote[]>` —— 逐文件的确定性函数事实
  （calls / calledBy / extCalls，有上限）。

**卡片**（`cards.ts`）

- `generateCards(options: CardsOptions): Promise<CardsResult>` —— brief 或 deep 卡片；
  `CardDetail`（`'brief' | 'deep'`），以及批量、并发、截断、分块、`resume`、`onlyFiles` 等选项。
- `mergeFunctionNotes(graphFns, llmFns)` —— 把 LLM 的散文合并到**完整的**结构清单上
  （支持数组或按 qualname 做成的对象两种形状）。
- `extractCardEntries(json)` —— 从模型实际发来的各种形状里读出卡片条目，并拒绝「函数注解冒充文件卡片」。
- `isCardDone(card, detail)` —— resume 过滤器。

**骨架、归档、医生**

- `synthesizeSkeleton(client, nav, cards, lang?, onRejected?)`、`dirRollups(cards, examplesPerDir?)` / `DirRollup`、
  `buildSynthPrompt(nav, rollups, lang)`、`normalizeSkeleton(raw, draftedBy?)`、`stageShortDescriptions(skeleton)`。
- `assignFiles(client, graph, skeleton, options?)`、
  `reassignSubset(client, graph, skeleton, subset, previous, options?)`、
  `rebuildAssignment(fileStage, skeleton)` / `AssignOptions`。
- `synthesizeWithDoctor(client, graph, cards, options?)` / `SynthLoopOptions` ——
  起草 → 归档 → 医生轮次，直到收敛。
- `runDoctorRound(client, skeleton, assignment, cards, logger?)` / `DoctorRoundResult`、
  `computeStageStats` / `StageStats`、`renderStats`、`validateChange`、`applyChange`、`DoctorChange`。

**组织与叙述**

- `organizeStages(client, graph, skeleton, assignment, cards, options?)` / `OrganizeOptions`；
  `fileCallAdjacency(graph)`、`suggestOrder(files, adjacency)`（Kahn 拓扑序，调用方在前）。
- `narrate(client, inputs, options?)` / `NarrateOptions` —— 先深后浅生成阶段概述，最后写系统总览。
- `extractRegisters(client, skeleton, narration, cards, options?)` / `RegistersOptions` ——
  loop-until-dry 的寄存器提取。
- `parseRegisterLines(text)` —— 当模型改用 `- reg-x: 说明` 这种纯文本列表作答时的严格解析回退。

**成员策略**（`member.ts`）

- `classifyMembers(client, graph, skeleton, options?)` / `ClassifyMembersOptions`、
  `memberAssignmentSchema` / `MemberAssignment`。
- `deriveFileArtifacts(graph, skeleton, memberAssignment, cards)` ——
  按成员多数投票推导文件级归档与组织。
- `saveMemberAssignment(work, memberAssignment)`。

## 用法

```ts
import { generateHandbook, loadHandbookModel } from '@handbook/pipeline';
import { OpenAiChatClient } from '@handbook/llm';
import { createLogger } from '@handbook/core';

const stats = await generateHandbook({
  sourceRoot: '/path/to/project',
  workDir: '/path/to/work',
  client: new OpenAiChatClient(),
  phase: 'all',
  detail: 'deep',
  synthMode: 'doctor',
  narrateLang: 'zh',
  logger: createLogger(),
});
console.log(stats); // { phasesRun, phase1, nCards, nStages, nUnassignedFiles, nRegisters }

const model = loadHandbookModel('/path/to/work', '我的项目手册');
```

## 设计说明

- **work 目录幂等**：每个阶段只读上游产物、只写自己的产物，读取时全部经 schema 校验——
  任何阶段都能单独重跑，崩溃的运行可以续跑（`resume` 跳过已完成的卡片），数据损坏会大声报错。
- **卡片三级降级**：整批 → 单文件重试 → 逐函数分块（deep 模式）。仍然失败的文件得到一张**诚实的空卡片**，
  并记进 `_coverage.json`，所以覆盖率在构造上是完整的、缺口是可审计的。
  另一面同样重要：**部分降级是诚实的部分覆盖，全量降级是配置坏了在假装成功**——
  当文件数足够、且确实发过调用而一个都没描述成功时，运行直接失败，而不是渲染一本空壳手册。
- **医生就是一个 actor–critic 循环**：actor 每轮最多提 3 处结构改动，
  engineer / architect / reader 三个 critic 对照真实统计数据审查，
  通过校验的改动被机械地应用，受影响文件重新归档；连续两轮没有进展会触发卡死检测。
- **事实与散文分层**：调用关系与行号**永远**来自调用图（`buildInventory`），
  LLM 只负责补散文，再按 qualname 合并上去——所以结构数据不可能被编造。
- **阶段 3 叙述带内容哈希缓存**（键由提示词导出，落在 `phase3/cache/` 下），失败时降级为确定性兜底散文，
  所以重新叙述只为「输入变了的阶段」付费，而构建不会被卡住。
  **兜底散文与空结果都不写入缓存**——把失败记住，等于让下一次运行瞬间返回同一个失败且一声不响。
- **解析层不能比模型的真实输出更窄**：卡片、归档、成员、组织、寄存器五处都走
  `@handbook/core` 的容忍读取器，并且「收到但用不上的条目」一律计数并说明原因。
  这条规则来自实测：模型返回过 20 条完全正确的寄存器，只因把字段写成 `semantic`（单数）而全部静默蒸发。

## 依赖

内部：

- `@handbook/core` —— 模型类型与 schema、work 目录 I/O 原语、并发、进度、哈希、回复形状容忍工具。
- `@handbook/analyzer` —— 阶段 1 的适配器与图构建，以及 `NavPack` 定位输入。
- `@handbook/llm` —— `ChatClient` 接缝，以及医生所用的 actor–critic 循环。

外部：

- `yaml` —— 人可手改的 `skeleton.yaml` / `organization.yaml` 序列化。
- `zod` —— 包内自有的 `memberAssignmentSchema`（其余 schema 都来自 core）。
