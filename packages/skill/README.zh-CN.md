# @handbooks/skill

[English](README.md) · **中文**

> 把渲染好的手册重新打包成 agent SKILL —— 每个文件带一个内容哈希，
> 于是「这一页已经落后于代码了」变成一件**能被检测**的事，而不是你吃了亏才发现的事。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fskill-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbooks/skill)
[![no LLM](https://img.shields.io/badge/LLM-从不-2dd4bf?style=flat-square)](#)

---

## 这是什么

两个函数，都是确定性的：

- **`buildSkill`** —— 渲染好的手册目录 → 一个自包含、可分享的 SKILL 包。
- **`validateSkill`** —— SKILL 包 → 一份关于结构、契约、链接一致性和新鲜度的通过/失败报告。

这个包**从不嵌入源码**。它交付的是**地图**，不是**领土**。

---

## 安装

```bash
pnpm add @handbooks/skill
```

---

## 快速上手

```ts
import { buildSkill, validateSkill } from '@handbooks/skill';

buildSkill({
  handbookDir: 'work/myrepo/handbook',
  outDir: 'skills/myrepo',
  name: 'myrepo', // slug → skill 名为 `myrepo-handbook`
  project: 'MyRepo', // 散文里用的人类可读名
  agentDir: 'work/myrepo/handbook/agent', // 可选：一并发布定位页
  coverage: { assignment, sourceRoot: '/path/to/repo' }, // 可选：漂移哈希
  lang: 'zh',
});

const result = validateSkill({ skillDir: 'skills/myrepo', sourceRoot: '/path/to/repo' });
result.ok;
result.errors;
result.warnings;
```

命令行：

```bash
handbook skill --handbook work/myrepo/handbook --out skills/myrepo \
    --name myrepo --project "MyRepo" \
    --work work/myrepo --source /path/to/repo \
    --agent-dir work/myrepo/handbook/agent --lang zh

handbook validate --skill skills/myrepo --source /path/to/repo
```

---

## 一个 SKILL 包长什么样

```
skills/myrepo/
  SKILL.md                    路由指南 —— agent 该怎么用这本手册
  corrections.jsonl           agent 写回的反馈（由 agent 创建，构建**从不**创建它）
  references/
    overview.md               系统的整体形状
    index.md                  阶段索引 —— 每个子系统 → 它的文件
    registers.md              跨阶段状态
    stages/<id>.md            每阶段一页
    agent/                    how_to_use.md + disambiguation.md   （可选）
    coverage.json             文件 → 阶段 + 每个文件一个内容哈希   （可选）
```

### `SKILL.md` —— 契约

frontmatter 是 agent 运行时用来做路由的东西：

```yaml
---
name: myrepo-handbook
description: Navigate the MyRepo codebase by behavior and source location. Use when
  planning, implementing, debugging, or reviewing MyRepo work that is unfamiliar, spans
  multiple files, or may affect cross-cutting state. Do not use for tasks unrelated to
  MyRepo or isolated edits where the exact file is already known and no cross-cutting
  impact is plausible.
---
```

**即使正文是中文，frontmatter 也保持英文。** 这是刻意的：运行时靠匹配 description 文本
来选择 skill，而经过校验的「Use when … / Do not use …」契约正是这个路由面的一部分。
翻译它会**悄无声息地弄坏 skill 选择**。传 `lang: 'zh'` 得到的是中文正文 + 英文 frontmatter。

正文是一份带编号的路由规程——读总览、经索引路由、只打开相关阶段页、
查寄存器里的横切状态、词义不明时去消歧，**然后去读每个被引用路径的真实源码**。
正文第一行就把话说死：

> 本手册是代码库的**位置索引**，不是代码描述。

### `coverage.json` —— 漂移信号

```json
{
  "schemaVersion": 1,
  "summary": { "eligibleFiles": 412, "stages": { "stage-1": 37, "stage-2": 54 } },
  "files": [{ "path": "src/upload.py", "stage": "stage-3", "sha256": "9f2c…" }]
}
```

打包时抓下的、每个文件一个哈希。`validateSkill` 会重新哈希活的源码，
报告每一个自那以后内容变了的文件——**这就是 agent 在拿一个过期断言去行动之前，
学会「这一页可能落后了」的方式。**

### `corrections.jsonl` —— 反馈通道

当手册的断言与真实源码矛盾时，消费它的 agent 会在 **skill 根目录**追加一行 JSON：

```json
{
  "file": "src/engine.py",
  "page": "references/stages/stage-2.md",
  "claim": "spin() is defined in src/main.py",
  "actual": "spin() is defined in src/engine.py"
}
```

只有 `file` 是必填。它放在根目录而不是 `references/` 下，因为 planner 把那棵树**只读挂载**。
之后 `handbook resync --corrections <file>` 会**只刷新其中点名的那些文件**。

**重新打包会保留它。** 构建会先清空 `outDir`，所以待处理的 corrections 会跨过这次清空被暂存起来——
**还没被 resync 消费的记录，不能被一次重新打包毁掉。**

---

## 构建强制的安全规则

- **它拒绝吃掉自己的输入。** 如果 `outDir` **就是**手册目录，或者手册在它里面，
  构建会中止——因为构建以清空 `outDir` 开始，那会删掉正要打包的东西，然后悄悄产出一个空 skill。
- **定位页要么成对发布，要么都不发。** 只有 `agent/how_to_use.md` 和
  `agent/disambiguation.md` 都存在时才复制，SKILL.md 的路由规程也只有在这时才多出消歧步骤。
  **`SKILL.md` 绝不能路由到一个不存在的文件。**
- **寄存器页永远存在。** 零寄存器的手册不会渲染寄存器页；skill 仍然会写一个说明「没有」的页面，
  因为**稳定的引用布局是契约的一部分**。
- **阶段页发现不看名字形状。** 阶段 id 是任意的（LLM 或用户写的），
  所以扁平布局下会取「不是已知顶层页」的每一个根级 `.md`——
  按名字形状过滤会悄悄丢页。它刻意**不递归**：`agent/` 和 `html/` 里有各自的副本。

---

## 校验都查什么

| 检查                                                      | 严重程度              |
| --------------------------------------------------------- | --------------------- |
| `SKILL.md` 存在且有 YAML frontmatter                      | error                 |
| `name` 是合法的小写连字符 slug                            | error                 |
| `description` 含「Use when … / Do not use …」契约         | error                 |
| `references/overview.md`、`index.md`、`registers.md` 齐备 | error                 |
| `references/stages/` 下至少有一页                         | error                 |
| `index.md` 链接到的每个阶段页都存在                       | error                 |
| 每个阶段页都能从索引到达                                  | warning               |
| `coverage.json` 能解析且符合 schema                       | error                 |
| 自打包以来哈希变了的源文件                                | warning（逐路径列出） |
| agent 定位页只有一半                                      | warning               |
| `corrections.jsonl` 每行都能解析                          | warning               |

`handbook validate` 把 warning 和 error 写到 stderr，并在**失败时退出码 `2`**，
所以可以直接放进 CI。

它在该宽容的地方也宽容：接受开头的 UTF-8 BOM 和 CRLF 换行，
因为在 Windows 上 checkout 出来的 `SKILL.md` 依然是合法的。

---

## API

```ts
buildSkill(options: BuildSkillOptions): BuildSkillResult
validateSkill(options: ValidateSkillOptions): ValidationResult

interface BuildSkillOptions {
  handbookDir: string;
  outDir: string;
  name: string;                 // slug；产出 `<slug>-handbook`
  project?: string;             // 散文里的人类可读名，默认取 `name`
  coverage?: { assignment: Assignment; sourceRoot?: string };
  agentDir?: string;
  lang?: 'en' | 'zh';           // 正文语言；frontmatter 保持英文
}

interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }
```

---

## 测试

```bash
pnpm --filter @handbooks/skill test
```

覆盖两种布局（扁平与嵌套 `stages/`）、缺页、outDir 吃掉输入的拒绝、
重新打包时 corrections 的保留、BOM/CRLF 容忍，以及哈希漂移检测。

---

[Handbooks](../../README.zh-CN.md) 的一部分 · MIT
