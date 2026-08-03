# @handbook/core

整条工具链的地基：与语言无关的调用图 IR、手册领域模型（卡片、骨架、归档、组织、叙述、状态寄存器）、
一套小而完整的错误分类、分级日志器，以及零依赖的工具库（并发、重试、哈希、原子写、文本、JSON 抽取、进度）。
其余每个 `@handbook/*` 包都依赖它；而它只依赖 `zod`。

> 英文版：[README.md](README.md)

## 职责

- 定义调用图 IR（`FunctionNode`、`BoundaryNode`、`CallEdge`、`CodeGraph`、`DroppedCalls`）——所有语言分析器都以它为产出目标。
- 定义手册模型（`FileCard`、`Skeleton`、`Assignment`、`Organization`、`Narration`、`RegisterEntry`、`HandbookModel`）
  ——阶段 2–3 产出它，renderer / skill / planner / resync 消费它。
- 为每一种落盘产物提供 zod schema，**读取时校验失败就大声报错**，而不是把损坏数据往下游传。
- 提供共享错误类（`HandbookError`、`MissingArtifactError`、`ArtifactValidationError`、`PermanentError`）与 `Logger`。
- 提供到处都在用的工具：`pLimit`/`mapLimit`、`retry`、哈希、原子写、递归文件发现、`extractJsonBlock`、`Progress`。
- **不**解析源码、**不**调用任何 LLM、**不**碰网络——它只是纯数据模型加本地辅助函数。
- **不**知道 work 目录的布局，那属于 `@handbook/pipeline`。

## 公开 API

**调用图 IR**（`ir.ts`）
- `CALL_TYPES` / `CallType` —— 一个调用点是**怎么被解析出来的**（`self_method`、`internal_func`、`boundary`、`unresolved`……）。
- `functionNodeSchema` / `FunctionNode`、`boundaryNodeSchema` / `BoundaryNode`、`callEdgeSchema` / `CallEdge` —— IR 的三种成分。
- `ModuleAnalysis` —— `{ functions, edges }`，语言适配器的返回类型。
- `graphNodeSchema` / `GraphNode`、`selfAttrsIndexSchema` / `SelfAttrsIndex`、`codeGraphSchema` / `CodeGraph`、
  `droppedCallsSchema` / `DroppedCalls` —— 落盘的图产物（`version: 1`）。
- `isInternalNode(node)` —— 内部函数节点的类型守卫。

**手册模型**（`model.ts`）
- `NARRATE_LANGS` / `NarrateLang`（`'en' | 'zh'`）、`FILE_ROLES` / `FileRole`、`coerceRole(value)` —— 受约束的词表。
  模型答出词表以外的值一律归到 `other`，而不是让脏值进入产物。
- `functionNoteSchema` / `FunctionNote`、`fileCardSchema` / `FileCard`、`cardCoverageSchema` / `CardCoverage` —— 文件级叶子内容。
- `stageSchema` / `Stage`、`skeletonSchema` / `Skeleton`、`assignmentSchema` / `Assignment`、
  `organizedFileSchema` / `OrganizedFile`、`organizationSchema` / `Organization` —— 结构类产物。
- `registerEntrySchema` / `RegisterEntry`、`registersSchema` / `Registers`、`narrationSchema` / `Narration` —— 阶段 3 产物。
- `HandbookModel` —— 「生成」与「呈现」之间的边界类型。
- `StageTree` —— 阶段查询：`title` / `description` / `isCrosscut` / `children` / `depth` / `subtree`，以及 `byId`、`order`、`topLevel`。

**错误与日志**
- `HandbookError(code, message)`、`MissingArtifactError(what, hint?)`、`ArtifactValidationError(path, detail)`、`PermanentError(message)`。
- `Logger`、`LogLevel`、`createLogger(prefix?, level?)`（只写 stderr）、`silentLogger`。

**工具**
- `pLimit(concurrency): LimitFn`、`mapLimit(items, concurrency, fn)` —— 有界并发，保持顺序。
- `retry(fn, options?)` / `RetryOptions` —— 线性退避加抖动；遇到 `PermanentError` 立刻放弃。
- `sha1Hex(text)`、`sha256Hex(data)`、`shortHash(text)` —— 摘要（12 位短哈希用于缓存键）。
- `toPosix`、`ensureDir`、`writeFileAtomic(path, content)`、`writeJsonFile`、`readJsonFile`、
  `readValidatedJson(path, schema)`、`fileExists`、`listFilesRecursive(root, options?)` / `DiscoverOptions`。
- `truncate`、`firstSentence`、`slugify`、`capList`、`leafName` —— 文本辅助。
- `extractJsonBlock(text)` —— 从 LLM 输出里取出第一个可解析的 JSON 值（先试栅栏块，再做括号配平扫描，最后走 `repairJson`）。
- `repairJson(candidate)` —— 修复「几乎合法」的 JSON：散文里未转义的引号、字符串里的裸换行。
  见下面的设计说明。
- `extractEntryList(json, keys, options?)`、`pickString(entry, keys)`、`describeJsonShape(json)`、`replyExcerpt(text)`
  —— 读取列表形答复、按别名取字段、把「实际收到的形状」写成一行日志。
- `Progress`（`tick(weight?, note?)`、`finish(unit?)`）、`fmtDuration(seconds)` —— 批量流程的 ETA 日志。
- `parseEnvFile` / `applyEnvFile` —— 零依赖的 `.env` 解析与加载（shell 环境变量优先）。

## 用法

```ts
import {
  codeGraphSchema,
  readValidatedJson,
  writeJsonFile,
  isInternalNode,
  mapLimit,
  retry,
  createLogger,
  type CodeGraph,
} from '@handbook/core';

const log = createLogger('[demo]', 'info');
const graph: CodeGraph = readValidatedJson('work/phase1/graph.json', codeGraphSchema);

const internal = Object.values(graph.nodes).filter(isInternalNode);
const summaries = await mapLimit(internal.slice(0, 20), 4, async (node) =>
  retry(async () => `${node.qualname} (${node.file}:${node.lineStart})`),
);
writeJsonFile('out/summary.json', summaries);
log.info(`summarized ${summaries.length} functions`);
```

## 设计说明

- **每种产物都是带 `version` 字面量字段的 zod schema**；`readValidatedJson` 把「静默的数据损坏」变成读取处的
  `ArtifactValidationError`——问题在发生地暴露，而不是在三个阶段之后以离奇形态出现。
- `writeFileAtomic` 先写同目录临时文件再 rename 覆盖，所以写入过程崩溃**不会**留下半个产物给下一阶段读。
- `retry` 在设计上就把 `PermanentError` 当作不可重试；LLM 客户端把 4xx 状态映射成它，让没希望的调用快速失败。
- `StageTree` 从 `parent` 指针**重新推导** children，而不是相信落盘的 `children` 列表——手工改过的骨架也不会算错。
- 日志只写 stderr，把 stdout 留给机器可读的命令输出。
- `repairJson` 只容忍**引号与裸换行**这两类错误，且用**有界回溯**处理歧义：
  `"supports "list", "map"…"` 这种散文两种读法都合法，所以两种都试，只接受能整体解析通过的；
  平局时用「散文里的引号成对出现」这一性质打分（留下奇数引号字符串的读法说明把一对切开了）。
  它**从不补结构**——括号不会被自动闭合，所以截断的输入返回 `undefined` 而不是一个看起来合理的残缺对象。
- `extractEntryList` / `pickString` 存在的理由同上：模型经常把答案放在 `files` 而不是 `purposes` 下、
  把 `semantics` 写成 `semantic`。**读得太窄会把正确答案当成失败**，而这类失败最难发现，因为它一声不响。

## 依赖

内部：无——它是依赖图的根。

外部：
- `zod` —— 运行时校验每一种落盘产物，并从单一事实源推导 TypeScript 类型。
