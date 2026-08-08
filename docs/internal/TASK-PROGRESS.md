# 大任务进度追踪（跨 session 恢复用）

> 起始时间：2026-08-08。本文件是"断点续跑"的唯一入口：新 session 只需读本文件 + `git log`。
> 每完成一个子步骤立即勾选并写下"下一步该做什么"。

## 用户交付的 8 步任务

1. 深入分析项目（3 遍）——包/命令/配置/工程化
2. 重写 README（根 + 11 个包），要有图、示例、大白话、结构完整
3. 重写 `docs/` 为 fumadocs 站点，30+ 平台 SEO，图要好看
4. 重写 `.claude/`，新增 `.codex/`、`.cursor/`
5. 完整测试所有命令、所有配置
6. 拉取 java/python/js/ts/rust/go/c#/c++/php 真实 GitHub 项目到 `../`（share/）跑通，修 bug
7. 完成后做 5 轮深度对抗
8. 逐步执行，全程不问，自己保存进度

## 基线（2026-08-08 13:35）

- Node v24.14.0 / pnpm 10.18.1
- `pnpm build` OK；`vitest run` = **64 files / 1334 tests 全绿**
- git HEAD: 4115d42

## 硬约束（改文档前必读，否则测试会挂）

`packages/cli/src/docs-drift.test.ts` 强制：

1. `README.md` / `README.zh-CN.md` 必须提到每一个已注册语言的显示名
   （Python/TypeScript/Go/Rust/Shell/Java/C#/C/C++/Kotlin/Scala/Zig/Objective-C/OCaml/Ruby/PHP/Swift/Dart/Solidity）
2. 两个 README 里出现的 `pnpm <script>` 必须真实存在于 root package.json（或是 pnpm 内置/`node_modules/.bin` 里的可执行）
3. 两个 README 里的**相对链接**必须是 **git 已跟踪** 的路径 → 新增文档必须 `git add`
4. `packages/analyzer/README.md` 不得写死 adapter 数量（"five adapters" 之类）
5. `.env.example`、`docs/configuration.md`、`handbook.config.example.yaml` 是 **registry 生成物**，
   与 `renderEnvExample()/renderConfigDocs()/renderConfigExampleYaml()` 逐字节比对
   → 想改路径必须同时改 `scripts/gen-config-docs.mjs` + `render-docs.ts` + 本测试 + `.prettierignore`

其他：

- `scripts/check-workspace.mjs`：第三方版本只能写 `catalog:`；tsconfig references 必须镜像 workspace 依赖
- `.gitignore` 里 `.claude/` 被忽略 → 要开源 `.claude` 必须加 `!` 反选规则
- `vitest.config.ts` 有 **每包 coverage 下限**，改代码不能让覆盖率掉下去

## 执行状态

### Step 1 — 深入分析 ✅

- [x] 第 1 遍：结构/包边界/依赖方向/CLI 入口/配置 registry
- [x] 第 2 遍：pipeline 5 阶段、analyzer 适配器分层、renderer 四种输出、patcher 计划格式、planner ReAct 环、resync case 契约、studio 路由
- [x] 第 3 遍：工程化（tsc -b composite、vitest alias→src、coverage 下限、check-workspace 7 条不变量、changesets、husky、Docker）
- [x] 发现待修：仓库根有个误产生的垃圾文件 `ritten`（`server.ts` 片段，疑似 shell 重定向事故）

### Step 2 — README 重写 ⏳

- [ ] 造图（SVG 手写 + Chrome headless 截 PNG 做社交卡）
- [ ] 根 README.md / README.zh-CN.md
- [ ] 11 个包 README（en + zh）

### Step 3 — docs/ fumadocs 站点 ⏳
### Step 4 — .claude / .codex / .cursor ⏳
### Step 5 — 全命令全配置测试 ⏳
### Step 6 — 9 语言真实仓库实测 + 修 bug ⏳
### Step 7 — 5 轮对抗 ⏳

## 关键实现事实速查（写文档时直接引用，不要凭记忆）

### CLI 12 个子命令

`analyze` `generate` `render` `skill` `validate` `plan` `apply` `rollback` `resync` `studio` `config`
（共 11 个 + 全局 flags：`-v/--verbose` `-q/--quiet` `--env <name>` `--env-file <path>` `--config <path>`）

### 配置解析优先级（packages/core/src/config/resolve.ts）

`CLI flag` > `shell env`（含已合并的 .env）> `handbook.config.yaml` > registry default

- env 名：`HANDBOOK_<KEY>`，命令域：`HANDBOOK_<COMMAND>_<KEY>`，另有 `OPENAI_*` 别名
- 配置文件按 camelCase 展平：`generate: {readWorkers: 4}` → `generateReadWorkers`
- 文件里的相对 path 相对**配置文件所在目录**解析；flag/env 的相对 path 相对 cwd
- `secret: true`（`llmApiKey`）禁止出现在配置文件里，会直接报错

### .env 级联（core/src/util/env-file.ts `applyEnvFiles`）

有 `--env <name>`：`.env.<name>.local` → `.env.<name>` → `.env.local` → `.env`
无：`.env.local` → `.env`。**先写入者胜**，shell 永远赢过文件。

### 生成管线 5 阶段（pipeline/src/generate.ts）

- `1` 静态调用图（无 LLM）
- `2a` 每文件卡片（brief/deep）
- `2b` 骨架合成 + 文件归属（`oneshot` / `doctor` actor-critic）
- `2c` 阶段内分组排序
- `3` 自底向上叙述 + 状态寄存器
- `--phase` 支持 `all|1|2|2a|2b|2c|3` 及逗号列表；`2` = 2a+2b+2c
- 两种策略：`file`（自动骨架，文件为叶）/ `member`（用户写 skeleton.yaml，函数级分类）
- 策略写进 `<work>/phase2/strategy.json`，跨策略再跑会报错

### 工作目录布局

```
<work>/phase1/graph.json | functions.csv | graph.dot | dropped-calls.json
<work>/phase2/cards/<rel>.json | _coverage.json | _rejected/
<work>/phase2/skeleton.yaml | assignment.json | organization.yaml | strategy.json
<work>/phase3/narration.json | registers.json | cache/
<work>/run-manifest.json
```

### 语言分层

- full 层（手写适配器）：python, typescript(含 js/jsx/mjs/cjs), go, rust, shell, java, csharp, cpp(含 C), ruby, php, swift, dart, solidity
- generic 层（配置驱动 `GENERIC_LANGUAGES`）：kotlin, scala, zig, objc, ocaml
- 已知坑：swift 语法在 V8≥13 会 abort（适配器在 discovery 阶段拒绝并提示 `--liftoff-only`）；shell 含 `case` 的脚本被跳过
