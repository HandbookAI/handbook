# @handbooks/core

[English](README.md) · **中文**

> 共同语言。所有其他 `@handbooks/*` 包都说这门语言，并且**都不许自己再定义一套**。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fcore-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbooks/core)
[![no LLM](https://img.shields.io/badge/LLM-从不-2dd4bf?style=flat-square)](#)

---

## 这是什么

`@handbooks/core` 是 [Handbook](../../README.zh-CN.md) 工具链的地基层。它只包含四样东西，
**刻意不多一样**：

1. **数据模型** —— 调用图*是什么*、手册*是什么*，用 zod schema 表达。
2. **配置 registry** —— 整条工具链的每个设置，只声明一次。
3. **错误与日志** —— 共享的失败词汇表。
4. **零依赖工具** —— 原子写文件、并发限流、重试、哈希、`.env` 解析、目录锁、
   从 LLM 散文里抠 JSON。

运行时依赖只有两个：`zod`（校验）和 `yaml`（解析）。**它从不联网，也从不调用 LLM。**

### 为什么需要它

两个包各自定义「文件卡片长什么样」，一个月内必定对不上。把模型做成一个包，意味着
*写*产物的 pipeline 和*读*产物的 renderer 由编译器用同一份 schema 检查——
并且每次从磁盘读取时，还会被校验器再检查一遍。

---

## 安装

```bash
pnpm add @handbooks/core
```

---

## 数据模型

### 第一层 —— 调用图 IR（`ir.ts`）

与语言无关。每个分析器只产出这一套东西，所以下游没人知道、也不需要知道某个事实来自哪种语言。

```ts
import { codeGraphSchema, type CodeGraph, isInternalNode } from '@handbooks/core';

const graph: CodeGraph = codeGraphSchema.parse(JSON.parse(raw)); // 不匹配时带路径抛错

for (const node of Object.values(graph.nodes)) {
  if (isInternalNode(node)) {
    console.log(node.qualname, node.file, node.lineStart, node.lineEnd, node.nCallers);
  }
}
```

| 类型           | 内容                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FunctionNode` | 一个内部函数或方法：id、qualname、文件、行范围、签名、`isAsync`、`isMethod`、`className`、装饰器、`selfAttrsRead` / `selfAttrsWritten`、`paramTypes` |
| `BoundaryNode` | 你的代码调用的一个外部符号（`boundary:<qualname>`）                                                                                                  |
| `CallEdge`     | `callerId` → `calleeId`，外加 `isAwait`、`callType`、`line` 和原始调用文本                                                                           |
| `CodeGraph`    | 持久化的图：元数据（源根、扫描文件、逐文件哈希、逐语言能力）+ 节点 + 边 + 逐类的 self 属性索引                                                       |
| `DroppedCalls` | 未解析的调用，已分类 —— **保留下来，绝不猜测**                                                                                                       |

`CallType` 是一个封闭的八值词汇表：`self_method`、`self_attr_method`、`param_method`、
`internal_func`、`internal_constructor`、`boundary`、`boundary_constructor`、`unresolved`。

#### 保真度是**声明**出来的，不是假设出来的

```ts
interface AdapterCapabilities {
  tier: 'full' | 'generic';
  callTypes: readonly CallType[];
  selfAttrs: boolean; // 能否追踪 self/this 属性的读写？
  statementSpans: boolean; // 能否报告语句跨度（决定 resync 的对齐精度）？
}
```

两种分析层级共存，产出的 IR 一模一样——这正是陷阱：读者（尤其是 agent）会以为
通用层语言的调用事实和 Python 一样硬。所以每个适配器都**必须说明自己能交付什么**，
阶段 1 **逐语言**记录它，渲染器再把它公开出来。这和手册对「已归属 vs 已描述」覆盖率
所遵循的诚实原则是同一条。

### 第二层 —— 手册模型（`model.ts`）

阶段 2–3 产出、renderer / skill / planner / resync 消费的东西。

| 类型            | 持久化为                   | 是什么                                                             |
| --------------- | -------------------------- | ------------------------------------------------------------------ |
| `FileCard`      | `phase2/cards/<rel>.json`  | 用途、`FileRole`、生命周期；deep 卡片额外带描述和 `FunctionNote[]` |
| `Skeleton`      | `phase2/skeleton.yaml`     | 阶段主线 —— 有序的 `Stage`，带父子关系和 `crosscut` 标记           |
| `Assignment`    | `phase2/assignment.json`   | 文件 → 主阶段（+ 附加阶段），以及互斥的桶和覆盖率                  |
| `Organization`  | `phase2/organization.yaml` | 每阶段的带标题分组和平铺阅读顺序                                   |
| `Narration`     | `phase3/narration.json`    | 系统总览 + 每阶段一段摘要，语言由 `NarrateLang` 决定               |
| `Registers`     | `phase3/registers.json`    | 跨阶段状态，每条带语义和涉及的阶段                                 |
| `HandbookModel` | —                          | 生成与呈现之间的内存边界类型                                       |

`FileRole` 是受约束的词汇表 —— `entrypoint`、`orchestration`、`domain_logic`、
`io_transport`、`data_model`、`config`、`util`、`test`、`generated`、`other` ——
而 `coerceRole()` 把其他一切映射成 `other`，所以 LLM 再有创意也无法把它撑大。

`StageTree` 是共享的查找助手：`title()`、`children()`、`depth()`、`subtree()`。
它从 `parent` **重新推导** children，而不是相信可能已经过期的 `children` 列表；
`subtree()` 用迭代而非递归且能防环——**损坏的骨架不该把栈搞爆。**

---

## 配置 registry

一张表（`config/registry.ts`）把每个设置**恰好描述一次**。**四个**消费者只读它：

```
                       ┌─► CLI 参数        （packages/cli/src/options.ts）
  SETTINGS ────────────┼─► 值解析          （config/resolve.ts）
  （唯一一张表）        ├─► .env.example    （config/render-docs.ts）
                       └─► docs/configuration.md + handbook.config.example.yaml
```

加一个设置是一行改动，四个面同时出现——**否则构建失败**，因为漂移测试会逐字节比对生成物。

```ts
import { resolveConfig, envName, scopedEnvName, loadConfigFile } from '@handbooks/core';

envName('readWorkers'); // 'HANDBOOK_READ_WORKERS'
scopedEnvName('generate', 'readWorkers'); // 'HANDBOOK_GENERATE_READ_WORKERS'

const { values, sources, errors } = resolveConfig({
  command: 'generate',
  flags: { readWorkers: 4 },
  env: process.env,
  file: loadConfigFile('/repo/handbook.config.yaml'),
});

values.readWorkers; // 4
sources.readWorkers; // { kind: 'flag', name: '--read-workers' }
errors; // 全部问题，而不是第一个
```

**错误是被收集的，不是被抛出的**，所以 `handbook config --check` 能一次报完所有问题，
而不是跑一次报一个。

解析器强制的三条规则：

- **空值等于未设置。** `HANDBOOK_TITLE=` 不会产出一本标题为空的手册。
- **给了但非法的值绝不落回默认值。** 打错的数字是错误，不是悄悄的 12。
- **来自配置文件**的 `path` 类型值相对**配置文件自己所在目录**解析，
  来自 flag / env 的相对 cwd 解析——这样提交进仓库的配置文件才是可移植的。

密钥（`secret: true`）没有命令行参数，且一旦出现在配置文件里就会被**拒绝**，
并说明原因：配置文件是要提交的。

---

## `.env` 级联

```ts
import { applyEnvFiles } from '@handbooks/core';

applyEnvFiles(process.cwd(), 'prod');
// 依次尝试：.env.prod.local → .env.prod → .env.local → .env
// → 返回真正加载了的路径，优先级从高到低
```

整个级联就是「按这个顺序调用，先写入者胜」，因为 `applyEnvFile` **从不覆盖**已存在的键。
就这一条规则，让 shell 始终压过所有文件——别处不需要任何额外逻辑。

解析器刻意做得小、也刻意做得细：支持 `export ` 前缀、`#` 注释、单双引号、
未加引号值后的行内 ` #` 注释、CRLF **和**裸 CR 换行，
以及把字面量 `__proto__=` 行**当作数据保留**，而不是被 `Object.prototype` 悄悄吞掉。

---

## 工具

| 模块                | 导出                                                                                                                                | 说明                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `util/fsx`          | `writeFileAtomic`、`writeJsonFile`、`readJsonFile`、`readValidatedJson`、`ensureDir`、`listFilesRecursive`、`fileExists`、`toPosix` | 原子 = 先写临时文件再改名。崩溃绝不留下半个产物。 |
| `util/concurrency`  | `pLimit`、`mapLimit`                                                                                                                | 每个分批阶段的有界并发                            |
| `util/retry`        | `withRetry`                                                                                                                         | 指数退避 + 抖动                                   |
| `util/hash`         | `sha256Hex`                                                                                                                         | 缓存与漂移检测用的内容哈希                        |
| `util/lock`         | `withDirLock`                                                                                                                       | 可重入目录锁 —— 一个 work dir 同时只跑一次管线    |
| `util/json-extract` | `extractJsonBlock`、`describeJsonShape`                                                                                             | 从被散文或代码块包住的 LLM 回复里抠出 JSON        |
| `util/reply-shape`  | `replyExcerpt`                                                                                                                      | 解析失败时给出可读的诊断                          |
| `util/text`         | `truncate`、`firstSentence`                                                                                                         |                                                   |
| `util/progress`     | `progressLine`                                                                                                                      |                                                   |
| `logger`            | `createLogger`、`silentLogger`、`LOG_LEVELS`                                                                                        | `debug` / `info` / `warn` / `error` / `silent`    |
| `errors`            | `HandbookError`、`MissingArtifactError`、`ArtifactValidationError`、`PermanentError`                                                | 每个错误都带稳定的 code                           |

---

## 保证

- **不联网、不调 LLM、不起子进程。** 永远。
- **每个持久化产物都带 `version` 字段**，读取时做 schema 校验。
- **`MissingArtifactError` 说的是补救办法**，不只是问题本身：
  `phase1/graph.json — run phase 1 first`。
- **`PermanentError` 意味着「别重试」** —— LLM 客户端用它区分「请求本身有问题」和「网络抖了」。

---

## 测试

```bash
pnpm --filter @handbooks/core test
```

完全离线，除了临时目录不需要任何 fixture。覆盖率下限在仓库根的 `vitest.config.ts` 里强制。

---

[Handbook](../../README.zh-CN.md) 的一部分 · [架构](../../docs/content/docs/concepts/architecture.mdx) ·
[配置参考](../../docs/content/docs/reference/configuration.md) · MIT
