# @handbooks/resync

[English](README.md) · **中文**

> 代码变了。让手册跟上——diff 调用图，**只重新生成真正变了的那部分**，其余原样不动。
> 不做全量重建。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fresync-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/resync)

---

## 这是什么

文档会烂，是因为维护它的成本和写它一样高。`resync` 让更新的成本
**与改动大小成正比**：改了三个文件，就只为三个文件付费。

```
   旧图 ──┐
          ├──▶ diff ──▶ 变更 / 新增 / 删除 的文件
   新图 ──┘                    │
                               ▼
         ┌─────────────────────────────────────────────┐
         │ 1. 为变更 + 新增的文件重新生成卡片            │
         │ 2. 归属新增、剔除删除、修正桶                 │
         │ 3. 为受影响阶段重建组织结构                   │
         │ 4. 重新叙述受影响阶段 + 系统总览              │
         │ 5. 刷新寄存器                                 │
         └─────────────────────────────────────────────┘
```

其余交给内容哈希缓存：输入没变的阶段**根本不会被重新叙述**。

---

## 安装

```bash
pnpm add @handbooks/resync
```

---

## case 契约

一个 **case** 是你自己组装的目录。它回答两个问题：_代码现在长什么样_，
以及*这次改动本来打算做什么*。

```
<case>/
  edited/        改动后的源码树              必需
  plan.md        这次改动是什么              可选 —— 让范围更**精确**
  change.diff    相对上一版的 unified diff   可选 —— 让范围更**完整**
```

```bash
mkdir -p cases/upload-retry
cp -R /path/to/repo cases/upload-retry/edited
cp plan.md cases/upload-retry/
handbook resync --case cases/upload-retry --work work/myrepo
```

**声明和 diff 只能让刷新集合变大，永远不能让它变小。** 调用图 diff 是下限：
一个文件的字节变了就一定会被刷新，无论计划有没有提到它。
**一份低估了自己波及面的计划，不可能导致某一页过期。**

**空的** `change.diff` 表示「没什么要做的」，本次运行会被干净地跳过，
而不是被当成「所有东西都变了」。

---

## 快速上手

```ts
import { resyncHandbook } from '@handbooks/resync';
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const report = await resyncHandbook({
  caseDir: 'cases/upload-retry',
  workDir: 'work/myrepo',
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  correctionsPath: 'skills/myrepo/corrections.jsonl', // 可选
});

report.changedFiles; // string[]
report.addedFiles;
report.deletedFiles;
report.affectedStages;
report.cardsRegenerated; // number
report.narrated; // boolean
report.corrections; // { applied, files, problems, archivedTo }
```

---

## diff 是怎么做的

`diffGraphs(before, after)` 比较两张阶段 1 的图，给每个文件分类：

| 信号             | 能检测到                                                           |
| ---------------- | ------------------------------------------------------------------ |
| **内容哈希**     | 行号和签名都没动的原地函数体编辑——**纯结构 diff 完全看不见的那种** |
| **函数集合**     | 新增、删除或改名的函数                                             |
| **签名与行范围** | 被重塑的函数                                                       |
| **调用边**       | 新增或消失的关系，包括进出未被改动文件的                           |
| **文件集合**     | 新增与删除的文件                                                   |

逐文件哈希正是阶段 1 为此盖上的。如果某张图早于这个特性，diff 会退化到只看结构——
**能力下降，但绝不会给出错误答案**。

---

## Corrections：反馈闭环

消费手册 SKILL 的 agent 被要求把矛盾之处追加到 `corrections.jsonl`：

```json
{
  "file": "src/engine.py",
  "page": "references/stages/stage-2.md",
  "claim": "spin() is defined in src/main.py",
  "actual": "spin() is defined in src/engine.py"
}
```

`--corrections <file>` 会把它们折进来：**被点名的文件即使字节从没变过，也会加入刷新集合**——
因为一个被源码打脸的断言，本身就是重新描述那个文件的理由。
消费掉的文件随后会带时间戳归档，于是同一条更正不会被应用两次，记录也不会丢。

畸形的行会记进 `report.corrections.problems`，**从不致命**——
一个 agent 写坏的一行，不该挡住整次刷新。

---

## 没有 LLM 也能用

```bash
handbook resync --case cases/x --work work/myrepo --no-llm
```

结构性事实会被刷新——调用图、函数清单、归属、排序——并且每张受影响卡片的用途后面会追加
` (stale: code changed since narration)`。

**这是诚实的降级方式。** 另一种做法——把散文原封不动地留着且不加标记——
是一本**在悄悄撒谎**的手册。

---

## 两种策略都支持

对于 `member` 策略的 work dir，resync 会为受影响文件重新分类成员，
并像阶段 2b 那样确定性地重新推导文件级产物。它读 `phase2/strategy.json`，
**不用你告诉它就会做对**。

---

## 安全与生命周期

- **和 `generateHandbook` 用同一把目录锁**，所以 resync 绝不会与并发的 generate
  在同一批产物上交错。
- **阶段 1 的暂存区一定会被清理** —— `<case>/.resync-phase1` 绝不会活过这次调用，
  无论成功还是失败。
- **协作式取消。** 传 `AbortSignal`；步骤之间会检查它，并一路传进每次 LLM 调用。
- **被删除文件的卡片会被移除**，所以删掉的文件不会赖在手册里。
- **`editedRoot`** 允许调用方指向一棵活的树而不是 `<case>/edited`——
  Studio 就是这样**不复制仓库**就地跑 resync 的。

---

## API

```ts
resyncHandbook(options: ResyncOptions): Promise<ResyncReport>

loadCase(caseDir): ResyncCase | undefined
diffGraphs(before, after): GraphDelta
filesFromDiff(diffText): string[]
parsePlanDeclarations(planText): { willModify; willAdd; willRemove } | undefined
detectCardDetail(cards): 'brief' | 'deep'      // 与现有手册的深度保持一致

loadCorrections(path): LoadCorrectionsResult
correctionFiles(corrections): string[]
archiveCorrections(path, stamp): string | undefined
```

`detectCardDetail` 正是 `--detail` 可以不填的原因：不填意味着*「跟现在这本手册保持一致」*，
所以一次 resync **绝不会悄悄把 deep 手册降级成 brief**。`--narrate-lang` 同理。

---

## 测试

```bash
pnpm --filter @handbooks/resync test
```

用 `MockChatClient` 做端到端覆盖：原地函数体编辑、改名、新增与删除文件、空 diff、
`--no-llm` 路径、corrections 扩大刷新集合、畸形更正行、member 策略 work dir，
以及运行中途取消。

---

[Handbook](../../README.zh-CN.md) 的一部分 · MIT
