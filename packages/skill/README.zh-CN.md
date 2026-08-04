# @handbook/skill

把渲染好的手册目录打包成 agent SKILL —— 一个自包含、可分发的文件夹，含一份 `SKILL.md` 导航说明
和一棵 `references/` 目录树（总览、索引、寄存器、逐阶段页面、可选的 agent 定位页、可选的覆盖率清单）——
并对这类包做结构完整性与**新鲜度**校验（对照活的源码）。
它在工具链里排在 `@handbook/renderer` 之后，产出的东西正是 `@handbook/planner` 挂载为手册的那个包。

> 英文版：[README.md](README.md)

## 职责

- 从渲染好的手册构建 skill 布局：`SKILL.md` 加
  `references/{overview.md,index.md,registers.md,stages/<sid>.md}`。
- 生成 `SKILL.md` 的 frontmatter 与正文，教会 agent **何时**该用这个 skill、以及**怎么路由**
  （索引 → 阶段页 → 寄存器 → 真实源码）。
- 可选打包 agent 定位页：`agentDir` 指向渲染好的 agent 站点时，`how_to_use.md` 与
  `disambiguation.md` 会进入 `references/agent/`，路由规程中也会多出一步消歧指引。
- 可选本地化 `SKILL.md` 正文与合成的兜底散文（`lang: 'zh'`）；frontmatter 永远保持英文（见设计说明）。
- 可选产出 `references/coverage.json`：文件 → 阶段的映射，附每个文件的 SHA-256 内容哈希，用于漂移检测。
- 校验一个 skill 目录：结构、frontmatter 契约、索引与阶段页的链接一致性、覆盖率哈希的新鲜度。
- **不**嵌入源码——skill 是一份**位置索引**，永远把 agent 指回真实文件。
- **不**调用任何 LLM；构建与校验都是确定性的。

## 公开 API

**构建**（`build.ts`）
- `buildSkill(options: BuildSkillOptions): BuildSkillResult` —— 组装 skill 包（输出目录会被从零重建）。
  - `BuildSkillOptions` —— `{ handbookDir, outDir, name, project?, coverage?: { assignment, sourceRoot? }, agentDir?, lang? }`；
    `name` 是 slug（skill 名字最终是 `<slug>-handbook`），`project` 是散文里用的人类可读名称。
    - `agentDir?: string` —— 渲染好的 agent 定位站点。当其中同时存在 `how_to_use.md` 和
      `disambiguation.md` 时，两页会被复制到 `references/agent/`，并且 SKILL.md 的路由规程会多出一步
      （「词义不明时，查 `references/agent/disambiguation.md`」）。定位页只成对发布，
      因此 SKILL.md 永远不会指向不存在的文件。不传（或页面缺失）时，输出与不带该选项的构建**逐字节相同**。
    - `lang?: 'en' | 'zh'`（默认 `'en'`）—— SKILL.md 正文与合成的「无寄存器」兜底页的语言。
      YAML frontmatter 永远不会被翻译。
  - `BuildSkillResult` —— `{ outDir, nStagePages, references }`（打包了定位页时 `references` 会列出 `agent/*.md` 条目）。

**校验**（`validate.ts`）
- `validateSkill(options: ValidateSkillOptions): ValidationResult` —— 检查这个包。
  - `ValidateSkillOptions` —— `{ skillDir, sourceRoot? }`；传了 `sourceRoot` 就会重新计算源文件哈希
    并与 `coverage.json` 比对，找出过期条目与已删除文件。
  - `ValidationResult` —— `{ ok, errors, warnings }`。

校验项包括：`SKILL.md` 存在且 frontmatter **恰好**只有 `name` + `description`；
name 是小写连字符 slug；description 同时写明「Use when …」与「Do not use …」；
正文引用 `references/index.md` 并把 agent 引向真实源码（中英文措辞皆可）；
`overview.md` / `index.md` / `registers.md` 与 `stages/` 存在；
每个阶段页都被 `index.md` 链接到；若 `references/agent/` 存在，
其中的定位页必须非空（否则报错），成对缺一页只给警告——没有该目录的 skill 照常通过校验；
`coverage.json` 没有重复路径，且（在给了 `sourceRoot` 时）没有过期哈希或已删除文件。

## 用法

```ts
import { buildSkill, validateSkill } from '@handbook/skill';
import { WorkDir } from '@handbook/pipeline';

const work = new WorkDir('/path/to/work');
const result = buildSkill({
  handbookDir: '/path/to/out',          // 渲染好的 markdown 手册
  outDir: '/path/to/skills/myproject',
  name: 'myproject',
  project: 'MyProject',
  coverage: { assignment: work.loadAssignment(), sourceRoot: '/path/to/project' },
  agentDir: '/path/to/out/agent',       // 可选：随包发布 agent 定位页
  lang: 'zh',                           // 可选：中文正文，英文 frontmatter
});
console.log(result.nStagePages, result.references);

const check = validateSkill({ skillDir: result.outDir, sourceRoot: '/path/to/project' });
if (!check.ok) console.error(check.errors);
```

## 设计说明

- **覆盖率哈希是漂移信号，不是强制门禁**：`coverage.json` 在构建时记下每个源文件的 SHA-256，
  之后 `validateSkill`（或任何消费方）可以重算哈希，找出哪些手册页面落后于代码。
  生成的 `SKILL.md` 明确告诉 agent：过期哈希是**新鲜度警告**，该去读真实源码。
- **frontmatter 契约是硬校验**（键必须恰好是 `name`+`description`，措辞必须含「Use when」/「Do not use」），
  因为 agent 运行时是**按 description 做路由**的；一个含糊的描述会静默地毁掉 skill 选择。
- **即使 `lang: 'zh'`，frontmatter 也保持英文**，理由同上：skill 路由跑在 description 文本上，
  经过校验的「Use when …」/「Do not use …」措辞正是路由面的一部分——翻译它会在一本好好的中文手册上
  静默毁掉 skill 选择。本地化只作用于正文（路由规程散文）与合成的兜底页面。
- **阶段页发现支持两种布局**：有嵌套的 `stages/` 目录时以它为准；
  否则根目录下每个不属于已知顶层页面（`overview.md`、`index.md`、`register(s).md`……）的 `.md` 都算阶段页——
  因为阶段 id 是任意的。发现过程**不递归**，所以自带阶段页副本的子站点（`agent/`、`html/`）不会被重复收集。
- **agent 定位页放在 `references/agent/` 子目录**（而不是 `references/` 根下），
  这样根级阶段页发现和既有的索引 ↔ 阶段页检查完全不受影响；且只复制两张定位页——
  agent 站点自己的 `index.md` 和阶段页副本绝不会被二次打包。
- **刻意零代码嵌入**：校验要求 `SKILL.md` 正文把 agent 引向真实源码，
  这样代码库演进时这个 skill 依然是诚实的——它从不假装自己是代码的副本。

## 依赖

内部：
- `@handbook/core` —— 文件 I/O 辅助（`writeFileAtomic`、`writeJsonFile`、`listFilesRecursive`）、
  `sha256Hex`、`Assignment` 类型。

外部：无。
