# @handbook/planner

手册驱动的**只读**规划 agent。给它一句自然语言的修改需求，它会通过挂载的手册
（或 skill 的 `references/` 目录）路由到相关位置，用沙箱化的工具带读**真实源码**，
最后产出一份精确、自包含的编辑计划——逐字的 old/new 编辑块，加一段机器可读的 declarations JSON，
后者供 `@handbook/resync` 用来界定更新范围。它只做计划，**从不动手改**。

> 英文版：[README.md](README.md)

## 职责

- 跑 agent 循环（`runPlanner`）：用手册路由 → 读真实源码 → 在轮次预算内产出计划。
- 提供只读工具带（`ReadOnlyTools`）：`list_dir`、`read_file`（按行区间、带行号）、`grep`，
  全部限制在沙箱根目录内。
- 拥有规划提示词（`buildPlannerSystemPrompt`、`TOOL_PROTOCOL`），
  包括机械执行器所依赖的那套**精确的 EDIT 块格式**。
- 解析末尾的 declarations JSON（`parseDeclarations`）为 `{ willModify, willAdd, willRemove }`。
- **不**写入、**不**编辑、**不**执行任何东西——它唯一的产出是文本；试图越出沙箱的路径一律拒绝。
- **不**要求 function-calling 接口——任何纯文本的 `ChatClient` 端点都能用。

## 公开 API

**规划器**（`planner.ts`）

- `runPlanner(options: PlannerOptions): Promise<PlannerResult>` —— agent 循环。
  - `PlannerOptions` —— `{ client, sourceRoot, handbookDir?, request, promptVars?, maxTurns?（默认 30）, logger? }`。
  - `PlannerResult` —— `{ plan, declarations?, turns, trace }`（`trace` 每次工具调用一行）。
- `Declarations` —— `{ willModify: string[], willAdd: string[], willRemove: string[] }`。
- `parseDeclarations(plan): Declarations | undefined` ——
  取最后一个含 `will_modify`/`will_add`/`will_remove` 键的 ` ```json ` 块。
- `handbookDirFromSkill(skillDir)` —— 把一个 skill 的 `references/` 目录挂载为规划器的手册。

**工具**（`tools.ts`）

- `ReadOnlyTools` —— `new ReadOnlyTools(root)`；`listDir(relPath?)`、
  `readFile(relPath, startLine?, endLine?)`、`grep(pattern, dirOrFile?)`，
  各自返回 `ToolResult`（`{ ok, content }`）。读取有上限（6 万字符、100 条 grep 命中、5 MB 文件），
  并跳过 `.git` 与构建目录。

**提示词**（`prompt.ts`）

- `buildPlannerSystemPrompt(vars: PlannerPromptVars)` —— 规划规则：
  用手册路由、读真实源码、产出逐字精确的 EDIT 块与 declarations。
- `PlannerPromptVars` / `DEFAULT_PROMPT_VARS` —— 项目相关的替换项
  （`projectIntro`、`pathExample`、`whereExample`、`qualnameNote`、`declExample`）。
- `TOOL_PROTOCOL` —— 追加到系统提示词后面的 JSON 动作协议
  （`list_dir` / `read_file` / `grep` / `finish`）。

## 用法

```ts
import { runPlanner, handbookDirFromSkill } from '@handbook/planner';
import { OpenAiChatClient } from '@handbook/llm';

const result = await runPlanner({
  client: new OpenAiChatClient(),
  sourceRoot: '/path/to/project',
  handbookDir: handbookDirFromSkill('/path/to/skills/myproject'),
  request: '重命名重试退避的环境变量，并更新所有读取点。',
  maxTurns: 30,
});

console.log(result.plan); // 摘要 + EDIT 块 + declarations JSON
console.log(result.declarations); // { willModify, willAdd, willRemove }
console.log(result.trace); // 例如 ['read_file(__handbook__/index.md)', 'grep(BACKOFF)']
```

## 设计说明

- **单轮转录协议**：每一轮把整份转录当作一个提示词重新发过去，模型只回**恰好一个** JSON 动作块。
  所以规划器能对接**任何** OpenAI 兼容端点（不需要 function-calling 接口），
  并且用 `MockChatClient` 就能完整按脚本复现。
- **只读沙箱**：每个路径都在工具根目录内解析，越界尝试直接抛错；
  手册挂在虚拟前缀 `__handbook__/` 下、拥有独立沙箱，
  所以 agent 不可能把手册页面和源文件搞混。
- **手册与源码的角色在提示词里就分清了**：手册是**位置索引**，决定「哪些位置在范围内」
  （能捞出普通搜索漏掉的分散点与镜像点）；真实源码是「改什么」的**唯一**事实来源——
  每个编辑的 old 文本必须从某次 `read_file` 的结果里逐字复制。
- **边界处优雅降级**：含 `### EDIT` 的散文回复也接受为计划；最后一轮强制 `finish`；
  过大的工具结果会被截断，并提示「把范围缩小」。

## 依赖

内部：

- `@handbook/core` —— `listFilesRecursive`、`toPosix`、`truncate`、`Logger`。
- `@handbook/llm` —— agent 循环驱动的 `ChatClient` 接缝。

外部：无。
