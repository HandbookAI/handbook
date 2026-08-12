# @handbooks/pipeline

[English](README.md) · **中文**

> 五个阶段，把一个源码目录变成一本结构化的手册。每个阶段**只读上游产物、只写自己的**——
> 所以任何一个阶段都能单独重跑，崩掉的运行也能从断点继续。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fpipeline-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/pipeline)

---

## 这是什么

`@handbooks/pipeline` 是 [Handbook](../../README.zh-CN.md) 工具链的生成引擎。它编排：

```
  阶段 1    静态调用图                      ← @handbooks/analyzer，不用 LLM
  阶段 2a   每个源文件一张卡片              ← LLM
  阶段 2b   阶段骨架 + 文件归属             ← LLM
  阶段 2c   阶段内分组与排序                ← LLM
  阶段 3    叙述 + 跨阶段状态寄存器          ← LLM
```

以及让上面这一切都可重启的产物 I/O。

---

## 安装

```bash
pnpm add @handbooks/pipeline
```

---

## 快速上手

```ts
import { generateHandbook, loadHandbookModel } from '@handbooks/pipeline';
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const stats = await generateHandbook({
  sourceRoot: '/path/to/repo',
  workDir: 'work/myrepo',
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  phase: 'all', // 或 '1' | '2' | '2a' | '2b' | '2c' | '3' | '2c,3'
  detail: 'deep',
  synthMode: 'doctor',
  narrateLang: 'zh',
  resume: true,
});

// 之后交给 renderer：
const model = loadHandbookModel('work/myrepo', 'MyRepo 手册');
```

命令行等价物：

```bash
handbook generate --source /path/to/repo --work work/myrepo --detail deep --synth-mode doctor
```

---

## 五个阶段，逐个说

### 阶段 1 —— 调用图 _（不用 LLM）_

委托给 `@handbooks/analyzer`，把所有语言合并成一张图，并为每个扫描到的文件
**盖上内容哈希**（resync 用它来检测那种「改了函数体但行号和签名都没动」的原地编辑）。
同时记录每种语言声明的保真度，供下游渲染器公开。

```ts
const stats = await runPhase1({ sourceRoot, workDir, lang: 'auto', logger });
// { language: 'multi', files, functions, edgesKept, edgesDropped }
```

### 阶段 2a —— 文件卡片 _（LLM）_

每个源文件一张卡片：**用途**、**角色**（封闭词汇表）、**生命周期**；
`--detail deep` 时再加一段 120–300 字的走读，以及逐函数的用途 / 数据流 / 关系，
并合并到调用图事实之上。

- **分批**：每个请求 `--read-batch-size` 个文件，同时在途 `--read-workers` 个批次。
  deep 模式默认一个批次一个文件。
- **三级降级。** 批次回复解析不了就用更小的批次重试；再失败就退化为「只有结构」的卡片。
  **绝不会因为散文生成失败，就让一个文件从手册里消失。**
- **崩溃安全、可续跑。** 卡片一完成就落盘；`--resume` 跳过已完成的文件。
- **可诊断。** 产出不了可用卡片的回复会被保留（有上限、以哈希命名）在
  `phase2/cards/_rejected/` 下，于是格式不符或模型拒答可以**事后读到**，而不是靠猜。

### 阶段 2b —— 骨架与归属 _（LLM）_

先搭出叙事主线，再把每个文件精确放到一个阶段上。

**`--synth-mode oneshot`**（默认）：从目录汇总和入口点合成骨架，然后分批归属文件。

**`--synth-mode doctor`**：一个 actor–critic 修复循环。每轮提出结构性改动
（拆分 / 合并 / 移动 / 改标题 / 改父级），三个 critic 评审
（工程师 / 架构师 / 读者），存活下来的改动**对照真实调用图校验**后再应用，
然后重新归属文件。直到没有文件未归属且没有改动能通过评审为止——或者到达 `--max-doctor-rounds`。

`validateChange` 是那道护栏：引用了不存在的阶段 id、或者会让文件变成孤儿的改动，
**在碰到骨架之前就被拒绝**。

### 阶段 2c —— 阶段内组织 _（LLM）_

按调用图拓扑给每个阶段的文件排序，并分成 2–8 个带标题、每组一句摘要的小组。

**任何失败都降级成确定性的平铺顺序——文件永远不会被丢掉。** 这个阶段整个是围绕这条不变量写的。

### 阶段 3 —— 叙述与寄存器 _（LLM）_

自底向上：先叶子阶段，再父阶段（父阶段拿到子阶段的摘要作为上下文），最后系统总览。
之后提取**状态寄存器**——跨阶段流动的那些状态——用一个「循环直到无新增」的补漏轮，
一直问到某一轮什么也没找到为止。

这里的一切都**按内容哈希缓存**在 `phase3/cache/` 下，所以改了一个阶段之后重跑阶段 3，
就只重新叙述那一个阶段。

---

## 两种策略

|          | `file`（默认） | `member`                                         |
| -------- | -------------- | ------------------------------------------------ |
| 骨架     | 由 LLM 合成    | **你自己写** `skeleton.yaml`                     |
| 叶子单元 | 一个源文件     | 一个函数或方法                                   |
| 阶段 2b  | 把文件归到阶段 | 分类每个成员，然后*推导*出文件级产物             |
| 阶段 2c  | LLM 分组       | 已经做完了——确定性的，所以 2c **完全不需要 LLM** |
| 适合     | 你还不熟的仓库 | 你已经清楚结构的仓库                             |

选定的策略记录在 `phase2/strategy.json`。用不同的 `--strategy` 且不带 `--phase 2b`
去做局部重跑会被**拒绝**——因为 file 策略的默认值悄悄盖掉 member 推导出来的组织结构，
正是那种很难被发现的损坏。

---

## 工作目录

```
<work>/
  phase1/graph.json           调用图 —— 下游一切都读它
  phase1/functions.csv        全部函数，平铺
  phase1/graph.dot            Graphviz
  phase1/dropped-calls.json   未解析的调用，已分类
  phase1/scan-coverage.json   读不了或没能完整解析的文件
  phase2/cards/<rel>.json     每个源文件一张卡片
  phase2/cards/_coverage.json 多少文件拿到了散文，哪些没有
  phase2/cards/_rejected/     产出不了可用卡片的回复（有上限）
  phase2/skeleton.yaml        阶段主线
  phase2/assignment.json      文件 → 阶段
  phase2/organization.yaml    阶段内分组 + 阅读顺序
  phase2/strategy.json        上面这些是哪种策略产出的
  phase3/narration.json       阶段与系统散文
  phase3/registers.json       跨阶段状态寄存器
  phase3/cache/               内容哈希缓存
  run-manifest.json           上一次成功运行的模型、阶段、耗时与 token 用量
```

`WorkDir` 是这一切的类型化访问器。**每次读取都做 schema 校验，每次失败都指名文件**：

```ts
import { WorkDir } from '@handbooks/pipeline';

const work = new WorkDir('work/myrepo');
work.loadGraph(); // MissingArtifactError('phase1/graph.json', 'run phase 1 first')
work.loadCards(); // 解析不了的文件被跳过，不致命
work.loadSkeleton();
work.loadAssignment();
work.loadOrganization();
work.loadNarration();
```

写入是**原子的**（先临时文件再改名），所以写到一半崩溃绝不会给下一次运行留下半个产物。

---

## 并发、取消与加锁

- **一个 work dir 同时只跑一次。** `generateHandbook` 拿一把可重入的目录锁；
  否则 CLI 和 Studio 同时对同一批产物跑就会交错写入。
- **协作式取消。** 传 `AbortSignal`：阶段之间、每个批次检查点都会检查它，
  并一路传进每个 LLM 调用，让在途请求也中止。被取消的运行会保留已保存的部分产物，
  并且**不写** run manifest。
- **每一段并发都可调**：`--read-workers`、`--assign-workers`、`--organize-workers`、
  `--narrate-workers`，全部受一个全局 `--llm-concurrency` 上限约束。

---

## API

```ts
// 编排
generateHandbook(options): Promise<GenerateStats>
loadHandbookModel(workDir, title): HandbookModel
expandPhases(spec): Set<Phase>              // 'all' | '2' | '2c,3' → 阶段集合
runManifestPath(workDir): string

// 单独的各阶段
runPhase1(options): Promise<Phase1Stats>
generateCards(options): Promise<CardsResult>
synthesizeSkeleton(client, nav, cards, lang, onRejected?, signal?): Promise<Skeleton>
synthesizeWithDoctor(client, graph, cards, options): Promise<{ skeleton; assignment }>
assignFiles(client, graph, skeleton, options): Promise<Assignment>
reassignSubset(...) / rebuildAssignment(...)
organizeStages(client, graph, skeleton, assignment, cards, options): Promise<Organization>
narrate(client, artifacts, options): Promise<Narration>
extractRegisters(client, skeleton, narration, cards, options): Promise<RegisterEntry[]>

// member 策略
classifyMembers(client, graph, skeleton, options): Promise<MemberAssignment>
deriveFileArtifacts(graph, skeleton, members, cards)

// 辅助
class WorkDir
buildInventory(graph): Record<string, FunctionNote[]>
computeStageStats(skeleton, assignment): StageStats
normalizeSkeleton(raw, draftedBy?): Skeleton
```

---

## 测试

```bash
pnpm --filter @handbooks/pipeline test
```

每个阶段都用 `MockChatClient` 的脚本化回复做端到端测试——**包括失败路径**：
解析不了的回复、不完整的批次、各级降级、运行中途取消与续跑。**没有任何测试需要 API Key。**

---

[Handbook](../../README.zh-CN.md) 的一部分 · [产物格式](../../docs/content/docs/reference/artifacts.mdx) ·
[提示词目录](../../docs/content/docs/reference/prompts.mdx) · MIT
