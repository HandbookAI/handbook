# @handbooks/planner

[English](README.md) · **中文**

> 一个只读的 agent：用手册定位、读真实源码、产出精确到能被机械执行的修改计划。
> **它连一个字节都写不了。**

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fplanner-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/planner)
[![read-only](https://img.shields.io/badge/文件系统-只读-2dd4bf?style=flat-square)](#工具带)

---

## 这是什么

给它一句自然语言的改动需求和一本手册。它跑一个 agent 循环——list、read、grep——
直到知道得够多，然后产出一份计划：

```
「上传失败重试三次」
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  用手册定位   → 该改哪些文件                  │
  │  读真实源码   → 具体改什么                    │
  │  核实锚点     → 逐字节精确的文本              │
  └─────────────────────────────────────────────┘
        │
        ▼
  plan.md  →  handbook apply
```

两种产物，两种截然不同的角色，提示词里说得很明确：

- **手册**是纯粹的**位置索引**。它能翻出普通文本搜索会漏掉的、散落而不显眼的位置——
  镜像实现、某个状态的每一次读写、跨子系统的接触点。
- **真实源码**才是「改什么」的事实依据。手册给**地址**，那个地址上的代码给**字节**。

---

## 安装

```bash
pnpm add @handbooks/planner
```

---

## 快速上手

```ts
import { runPlanner, handbookDirFromSkill } from '@handbooks/planner';
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const result = await runPlanner({
  client: new OpenAiChatClient({ config: resolveLlmEnv() }),
  sourceRoot: '/path/to/repo',
  handbookDir: handbookDirFromSkill('skills/myrepo'), // → skills/myrepo/references
  request: '上传失败时重试三次再放弃',
  maxTurns: 30,
});

result.plan; // markdown 计划
result.declarations; // { willModify, willAdd, willRemove }
result.turns; // 用了几轮
result.trace; // 每次工具调用一行
result.aborted; // 'fabrication' | 'turn-limit' | 'no-plan' —— 调用方**必须**当作失败
```

命令行：

```bash
handbook plan --source /path/to/repo --handbook skills/myrepo/references \
    --request "上传失败时重试三次再放弃" --out plan.md
```

---

## 计划格式

````markdown
### EDIT 1

- file: `src/upload.py`
- where: `Uploader.send (~88)` —— 把请求包进重试助手

```old
    response = self._client.put(url, data)
```

```new
    response = self._retry(lambda: self._client.put(url, data), attempts=3)
```

两处现在共用同一套重试策略。

```json
{ "will_modify": ["Uploader.send"], "will_add": ["Uploader._retry"], "will_remove": [] }
```
````

- `old` 必须**逐字节精确**且在文件中**恰好出现一次**。`old` 为空表示「创建这个文件」。
- 编辑块编号必须**自上而下递增**。
- 结尾的 `json` 块是机器可读的声明，由 `resync` 消费以精确其刷新范围。

`@handbooks/patcher` 执行这个格式。它刻意对歧义充满敌意——具体拒绝什么、为什么，
见那个包的 README。

---

## 工具带

```ts
class ReadOnlyTools {
  listDir(path): ToolResult;
  readFile(path, startLine?, endLine?): ToolResult;
  grep(pattern, path): ToolResult;
}
```

**没有写工具。** 不是被禁用了——是**根本没实现**。planner 的产出是一份计划；
要不要应用它，由别的东西决定。

其余全是沙箱规则：

- 每个路径都在沙箱根内解析；**逃逸（包括经由软链接）会被拒绝**。
- 手册以只读方式挂在 `__handbook__/`，与源码是**两个独立沙箱**。
- 读取上限 60,000 字符；grep 上限 100 个命中，并跳过大于 5 MB 的文件。
- **灾难性正则会被拒绝。** 一个无界量词作用在「自身也含无界量词」的分组上
  （`(a+)+`、`(.*)*`、`(\d+){2,}`）会把一行长文本变成几小时的挂起。
  `hasNestedUnboundedQuantifier` 会抓住它们并返回一个**优雅的工具错误**，而不是冻住整次运行。
  字符类和转义元字符会被跳过，所以 `[+*]` 和 `\+` 不会被误判。

---

## 这个循环为什么长成这样

planner 用的是**普通的单轮 `ChatClient`**——每一轮把整份对话记录作为一个提示词重发。
**不需要 function calling API**，所以它能跑在*任何* OpenAI 兼容端点上，
并且在测试里用 `MockChatClient` 就能轻松脚本化。

四条来之不易的行为，每一条都是因为「天真版本」在真实使用中挂过：

### 1. 编造的工具结果一律拒绝

一个自己写出 harness 专属 `## Tool result` 标题的回复，说明它
**编造了文件内容，并在此之上推理**。实测见过一个回复里有十三条编造的结果，
以及一份基于「文件里根本不存在的那一行」写出来的计划。

planner 拒收它——**连它结尾的那份计划也不要**，因为那份计划是从虚构推导出来的。
它会顶回去重问，连续三次这样之后放弃，并标记 `aborted: 'fabrication'`。

### 2. 提醒放在**最后**，不放在 system prompt 里

如果模型读到的最后一样东西是工具结果，那就是它接下来会开始模仿的形状——
生成几万字编造的对话，直到撞上 token 上限。**每轮在对话记录之后重复一遍指令**就修好了。

### 3. 放弃了的运行必须以非零退出

把一句道歉当作 `plan` 返回而不带 `aborted` 标记，等于**把一次放弃报告成成功**——
然后脚本会把那句道歉直接喂给 `apply`。所以：

| 情况                         | `aborted`       |
| ---------------------------- | --------------- |
| 一直编造工具结果             | `'fabrication'` |
| 用完轮次仍没有 EDIT 块       | `'turn-limit'`  |
| 调了 `finish` 但没有可用内容 | `'no-plan'`     |

CLI 会把这三种都变成非零退出码。

### 4. 只修一个悬空的代码围栏，其他一概拒绝

曾经有一份完整、正确的两处编辑计划被整份拒收，只因为结尾的声明块少了收尾的 ` ``` `。
执行器的严格**不能放宽**——被容忍的未闭合围栏正是当年一个被截断的锚点得以蒙混过关的原因——
所以这个小失误在**这里**修：在这里我们能看出它是分隔符而不是内容——
**只允许有一个围栏未闭合，且只能在文本末尾。** 其他任何情况都留给执行器去拒绝。

其他护栏：工具参数直接来自模型 JSON，所以一个非字符串的 `path` 是**优雅的工具错误**，
而不是把整次运行拒掉的 `TypeError`；以及，一个含 EDIT 块的散文回复**就是**计划，
即使它里面某段 fenced JSON 恰好能解析成一个 action。

---

## API

```ts
runPlanner(options: PlannerOptions): Promise<PlannerResult>
handbookDirFromSkill(skillDir: string): string
parseDeclarations(plan: string): Declarations | undefined
closeDanglingFence(plan: string): { plan: string; repaired: boolean }
buildPlannerSystemPrompt(vars: PlannerPromptVars): string
class ReadOnlyTools
hasNestedUnboundedQuantifier(src: string): boolean
DEFAULT_PROMPT_VARS, TOOL_PROTOCOL
```

提示词是参数化的（`projectIntro`、`pathExample`、`whereExample`、`qualnameNote`、
`declExample`），所以你可以**不 fork 提示词**就教会它你的代码库怎么写限定名。

---

## 测试

```bash
pnpm --filter @handbooks/planner test
```

每条失败路径都有脚本化测试：编造的结果、畸形 action、非字符串工具参数、
轮次耗尽、未闭合围栏、沙箱逃逸尝试、灾难性正则。

---

[Handbooks](../../README.zh-CN.md) 的一部分 · [提示词目录](../../docs/content/docs/reference/prompts.mdx) ·
产物由 [`@handbooks/patcher`](../patcher/README.zh-CN.md) 执行 · MIT
