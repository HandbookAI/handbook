# Handbook

[English](README.md) | **中文**

把任意代码库变成一本可导航的**系统手册**——再让这本手册反过来帮助 code agent 找到一次变更
需要触碰的*每一个*位置，并在代码演进后让手册增量滚动、保持新鲜。

```
源码 ──▶ analyze ──▶ generate ──▶ render ──▶ skill ──▶ plan
(任意仓库)  调用图     LLM 管线     md + HTML   agent     变更定位
           (无 LLM)   卡片/阶段/叙述  + 定位索引   技能包        │
                          ▲                                  │
                          └────────────── resync ◀───────────┘
                                       (代码变更后)
```

## 你会得到什么

- **一本手册**：代码库的分阶段地图——系统总览、按执行顺序排列的阶段页（每个文件、每个函数的
  大白话走读）、跨阶段**状态寄存器**表、自包含 HTML 站点（多页或单文件）。
- **agent 定位索引**：确定性、按事实门控的路由层（职责 / 入口概念 / 状态 / 范本 / 共变提示 /
  核心文件），专为 code agent 设计，"空字段本身就是信息"。
- **SKILL 技能包**：手册重新打包成 agent 技能（`SKILL.md` + `references/`），附内容哈希
  覆盖率，可检测代码漂移。
- **规划器（planner）**：只读 agent——用手册路由、读真实源码、输出逐字精确的编辑计划 +
  机器可读的变更声明 JSON。
- **重同步（resync）**：真实代码变更落地后，手册派生层增量前滚——无需全量重跑。

## 环境要求

- Node.js ≥ 20.11、pnpm ≥ 9
- LLM 阶段需要任意 **OpenAI 兼容**端点：

```bash
export OPENAI_API_KEY=sk-...                        # 阶段 2/3 必需
export OPENAI_MODEL=gpt-4o-mini                     # 默认 gpt-4o-mini
export OPENAI_BASE_URL=https://api.openai.com/v1    # 也可以是 vLLM / 代理等任何兼容端点
```

无鉴权的本地端点用 `OPENAI_API_KEY=EMPTY`。阶段 1（静态分析）永远不需要 key。
`--lang auto` 一趟探测并合并所有语言。

**全保真**（手写适配器：类型驱动的调用解析、继承成员、逐属性状态追踪）：
Python、TypeScript（同时覆盖 JavaScript：`.js`/`.jsx`/`.mjs`/`.cjs`）、Go、Rust、Java、C#、
C/C++、Ruby、PHP、Swift、Dart、Solidity、Shell。
**通用档**（配置驱动：文件与函数清单精确，调用关系尽力而为）：
Kotlin、Scala、Zig、Objective-C、OCaml。
分析档位混用时手册会在概览里写明——见 [docs/architecture.md](docs/architecture.md)。

两点需要事先说明：Swift 的语法在 V8 ≥ 13 上会让进程崩溃，所以适配器在发现阶段就明确拒绝并
给出解法（`node --liftoff-only`），而不是让整轮分析猝死；含 `case` 语句的 shell 脚本会被跳过，
因为那个语法会抛异常——两者都会写进扫描日志，绝不静默丢弃。

不想每次 export？CLI 会自动加载运行目录下的 `./.env`（shell 变量优先；模板见
[.env.example](.env.example)），也可用 `--env-file <path>` 显式指定。

多环境？`--env prod`（或 `HANDBOOK_ENV=prod`）会让 `.env.prod` 优先于 `.env` 生效，配置文件
也优先选中 `handbook.config.prod.yaml` 而不是不带环境名的那个：

```bash
handbook generate --env prod --source ~/code/proj --work work/proj
```

每一项配置都同时是命令行参数、环境变量和配置文件键 —— 完整清单见
[docs/configuration.md](docs/configuration.md)，或运行 `handbook config` 查看当前取值及其来源
（包括当前激活的环境，以及它加载过的每一个文件）。

更喜欢点而不是敲？`handbook studio` 在 http://127.0.0.1:4860 打开本地 Web 界面——仓库注册、
带实时日志的生成、手册浏览、影响图、源码查看，以及完整的
plan → dry-run → 应用补丁 → 回滚 → 重同步闭环。

## 快速上手

```bash
pnpm install
pnpm build

# 先跑离线全链路演示（内置 mock LLM，无需任何 key）：
bash examples/run-demo.sh

# 在你自己的仓库上：
alias handbook="node $(pwd)/packages/cli/dist/main.js"

handbook analyze  --source /path/to/repo --work work/myrepo          # 1. 纯静态调用图（无 LLM）
handbook generate --source /path/to/repo --work work/myrepo \
    --detail deep --synth-mode doctor --narrate-lang zh              # 2. 全量生成（中文叙述）
handbook render   --work work/myrepo --title "MyRepo 手册" \
    --html --html-single --agent-site                                # 3. 渲染 md + HTML + 定位索引
handbook skill    --handbook work/myrepo/handbook --out skills/myrepo \
    --name myrepo --work work/myrepo --source /path/to/repo          # 4. 打包 SKILL（含覆盖率哈希）
handbook validate --skill skills/myrepo --source /path/to/repo       # 5. 校验结构 + 新鲜度
handbook plan     --source /path/to/repo --handbook skills/myrepo/references \
    --request "上传失败自动重试三次" --out plan.md                    # 6. 手册驱动的变更定位
handbook apply    --source /path/to/repo --plan plan.md --dry-run    # 7. 先校验计划（不写盘）
handbook apply    --source /path/to/repo --plan plan.md              #    真正应用（自动备份）
handbook rollback --backup <上一步打印的备份目录>                      #    需要时一键回滚
# 8. 变更落地后前滚手册。resync 的 case 目录需要你自己组装——
#    改动后的树 + 计划说了什么（后两项可选）：
#      cases/upload-retry/
#        edited/       变更后的仓库副本         （必需）
#        plan.md       第 6 步产出的计划        （可选——收窄判定）
#        change.diff   本次变更的 unified diff  （可选——扩大范围）
mkdir -p cases/upload-retry
cp -R /path/to/repo cases/upload-retry/edited
cp plan.md cases/upload-retry/
handbook resync   --case cases/upload-retry --work work/myrepo
#    work/myrepo/handbook 下已渲染的产物会自动刷新（--no-render 跳过）；
#    卡片深浅自动沿用手册原本的粒度。
```

`generate` 关键参数：`--strategy file|member`（file=自动骨架、文件为叶子；member=你手写
`skeleton.yaml`、逐函数分类）、`--detail brief|deep`、`--synth-mode oneshot|doctor`
（doctor=actor-critic 修复循环）、`--narrate-lang en|zh`、`--phase`、`--resume`。

## 生成管线如何工作

| 阶段 | 内容                                                                                                                                                                                                                        | LLM |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 1    | 各语言 adapter（tree-sitter WASM）把每个文件解析成带类型的调用图：函数/方法、已解析的调用边（self / 属性 / 参数 / import 四类规则）、外部边界调用；无法解析的调用被隔离进 `dropped-calls.json`，绝不混入图中。              | 无  |
| 2a   | 每个文件一张**卡片**：purpose / role / lifecycle；deep 模式再加 120–300 词走读 + 逐函数 purpose / data_flow / relations（prose 由 LLM 写，事实来自调用图）。批量、三级降级、崩溃安全、可续跑。                              | 有  |
| 2b   | 从目录卷积 + 入口点合成阶段**骨架**（按执行生命周期排序的叙事主线），再把每个文件指派到唯一主阶段。`--synth-mode doctor` 启动 actor-critic 修复循环（工程师/架构师/读者三个评审），直到无未指派文件且再无结构变更通过评审。 | 有  |
| 2c   | 每个阶段内按调用图拓扑排序，再编成 2–8 个带标题的小组；任何失败都退化为确定性平铺顺序——文件永不丢失。                                                                                                                       | 有  |
| 3    | 自底向上叙述：先子后父生成阶段概述、系统总览，并用 loop-until-dry 间隙轮提取跨阶段**状态寄存器**。全部内容哈希缓存。                                                                                                        | 有  |

所有产物都是 work 目录下经 schema 校验的 JSON/YAML；任何阶段都能独立重跑，崩溃后原地续跑。

## Monorepo 布局

| 包                                                        | 职责                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| [`@handbook/core`](packages/core/README.zh-CN.md)         | 数据模型（调用图 IR + 手册模型）、zod schema、零依赖工具库 |
| [`@handbook/analyzer`](packages/analyzer/README.zh-CN.md) | 多语言静态调用图（tree-sitter WASM），无 LLM               |
| [`@handbook/llm`](packages/llm/README.zh-CN.md)           | OpenAI 兼容客户端 + actor-critic 编排 + 离线 mock          |
| [`@handbook/pipeline`](packages/pipeline/README.zh-CN.md) | 生成管线（阶段 1–3，file/member 双策略）                   |
| [`@handbook/renderer`](packages/renderer/README.zh-CN.md) | markdown 页面、agent 定位索引、自包含 HTML 站点，无 LLM    |
| [`@handbook/skill`](packages/skill/README.zh-CN.md)       | SKILL 打包 + 校验 + 覆盖率漂移检测，无 LLM                 |
| [`@handbook/planner`](packages/planner/README.zh-CN.md)   | 手册驱动的只读规划 agent                                   |
| [`@handbook/patcher`](packages/patcher/README.zh-CN.md)   | 逐字节应用计划里的 EDIT 块——全成或全不成、自动备份、可回滚 |
| [`@handbook/resync`](packages/resync/README.zh-CN.md)     | 代码变更后的手册增量前滚                                   |
| [`@handbook/studio`](packages/studio/README.zh-CN.md)     | 本地 Web 界面：仓库 · 生成 · 浏览 · 演化（仅 127.0.0.1）   |
| [`@handbook/cli`](packages/cli/README.zh-CN.md)           | `handbook` 命令行                                          |

依赖方向严格单向（`cli → pipeline/renderer/skill/planner/resync → analyzer/llm → core`）；
触碰 LLM 的代码与确定性代码按包边界分层，analyzer / renderer / skill 完全不依赖 LLM，可独立复用。

## 文档

- [docs/architecture.md](docs/architecture.md) — 分层、数据流、设计决策
- [docs/formats.md](docs/formats.md) — 全部产物 schema（graph、cards、skeleton……）
- [docs/prompts.md](docs/prompts.md) — 完整提示词目录
- [examples/](examples/) — 离线端到端演示（内置 mock LLM 服务器）
- 各包中文 README 见 [packages/](packages/)（每个包都有 `README.zh-CN.md`，英文版为 `README.md`）

## 命令速查（不必全局安装 CLI）

每条脚本都会先跑一次增量构建（`tsc -b`，最新时约 0.4 秒），所以**永远不会跑到过期的 dist**。
参数直接往后加，不需要写 `--`：

```bash
pnpm studio                          # 本机 Web 界面 → http://127.0.0.1:4860
pnpm studio --port 5000              # 参数直接透传

pnpm analyze  --source ~/code/proj --work work/proj      # 静态调用图，免费
pnpm generate --source ~/code/proj --work work/proj --narrate-lang zh
pnpm render   --work work/proj --html --agent-site
pnpm skill    --handbook work/proj/handbook --out skills/proj --name proj
pnpm validate --skill skills/proj --source ~/code/proj

pnpm plan     --source ~/code/proj --request "给 export 加 --json 参数" --out plan.md
pnpm apply    --source ~/code/proj --plan plan.md --dry-run
pnpm apply    --source ~/code/proj --plan plan.md
pnpm rollback --backup ~/code/proj/.handbook-patches/<时间戳>
pnpm resync   --case case1 --work work/proj

pnpm handbook <任意子命令>            # 通用入口，等价于 handbook 命令本体
pnpm handbook --help                 # 看全部子命令
```

离线演示与 mock 端点：

```bash
pnpm demo             # examples/run-demo.sh —— 全离线、零 token、端到端
pnpm demo:self        # 用本仓库自己当输入（mock）
pnpm demo:self:real   # 同上，但接 .env 里的真实端点
pnpm mock-llm         # 单独起内置 mock LLM 服务（端口 8099）
```

> 需要 LLM 的命令（`generate` 除阶段 1、`plan`、未加 `--no-llm` 的 `resync`、Studio 里的作业）
> 会自动加载**当前目录**的 `./.env`，shell 里已有的变量优先——所以请在仓库根目录执行。

## Docker

不需要本机装 Node/pnpm——镜像用 Node 22（特意不用 24，见 Dockerfile 里的注释）加上构建好的各包：

```bash
pnpm run docker:build     # docker build -t handbook:local .

# 跑任意子命令。镜像里已经写好 HANDBOOK_SOURCE=/src、HANDBOOK_WORK=/work，
# 挂载卷就行，不必再传 --source/--work：
docker run --rm -v "$PWD:/src:ro" -v handbook-work:/work handbook:local analyze
docker run --rm -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate --narrate-lang zh

# --env-file 与工具链自带的 .env 加载是叠加关系（两者都生效；--env-file 里的
# OPENAI_* 变量跟 shell 里 export 的效果一样能被读到）：
docker run --rm --env-file .env -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate

# 同一个镜像服务所有环境（.env* 从不烘进镜像层——见 .dockerignore）。运行时
# 用 docker 自己的 --env-file 指向对应环境的文件来选择环境，或用 HANDBOOK_ENV
# 加一个挂载进去的配置文件：
docker run --rm --env-file .env.prod -e HANDBOOK_ENV=prod \
  -v "$PWD:/src:ro" -v handbook-work:/work handbook:local generate
```

Studio 通过 `docker compose` 启动（见 `docker-compose.yml`）：

```bash
pnpm run docker:studio    # docker compose up --build studio
```

**只有 `http://localhost:4860` 能访问——LAN IP 或容器名都不行。** Studio 的
CSRF 防线校验的是 `Host` 请求头，不是 socket，所以容器必须绑 `0.0.0.0` 才能让
发布出去的端口连得通（compose 文件里的 `HANDBOOK_STUDIO_HOST=0.0.0.0`），但这
并不会放宽谁能连上它：从宿主机浏览 `http://localhost:4860` 发出的仍是
`Host: localhost:4860`，照样通过；而用 LAN IP 或 `studio` 容器名访问会被
**故意** 拒绝，返回 `403`。远程访问是另一个需要单独设计的功能（显式
allowlist），目前故意不做。

## 开发

```bash
pnpm build            # tsc -b（composite 引用，增量构建）
pnpm test             # 构建 + vitest（全部离线）
pnpm check            # 日常门禁，提交前跑这个（见下）
pnpm check:all        # check + 打包检查 + 装包冒烟；CI 跑的就是它
pnpm typecheck        # 先 tsc -b，再用 tsconfig.tests.json 检查测试
pnpm lint             # eslint，覆盖整个仓库
pnpm format           # prettier，覆盖整个仓库
pnpm test:coverage    # 带分包覆盖率下限的 vitest
pnpm check:workspace  # monorepo 结构不变量
pnpm check:packaging  # 逐包跑 publint + are-the-types-wrong
pnpm run check:install # 打包、用原生 npm 安装、驱动 CLI 跑全链路
```

`pnpm check` 顺序为：类型检查（先源码后测试）→ 工作区不变量 → eslint 零警告 → prettier →
带分包覆盖率下限的测试。它刻意做得快。`pnpm check:all` 再加上两个面向发布的门禁——它们要
打十一个 tarball 两遍，属于 CI 和发版前，而不是每次本地循环。pre-commit 钩子只对暂存文件跑
格式化和 lint，commit-msg 钩子强制 Conventional Commits。

测试哲学：一切离线。LLM 相关流程用 `MockChatClient`（规则脚本）与内置 mock HTTP 端点测试；
确定性包直接测试。任何测试都不需要 API key。

由工具强制、而非仅写在文档里的约定：

- **版本只有一处。** 所有三方依赖的版本声明在 `pnpm-workspace.yaml` 的 catalog 里，
  各包一律依赖 `"catalog:"`，不重复写版本区间。manifest 里出现字面版本会让
  `pnpm check:workspace` 失败。
- **`dist/` 就是发布面。** 构建工程排除 `*.test.ts` 与 `*.test-helper.ts`，改由
  `tsconfig.tests.json` 以 `noEmit` 做类型检查；source map 不进 tarball，因为它们指向
  永远不会被发布的源文件。`dist/` 下出现测试产物同样会让上面那条检查失败。
- **覆盖率下限是分包的。** 一个全仓数字掩盖的正是要紧的东西：整体 86% 时
  `@handbook/cli` 只有 23%。每个包有各自的下限，压在实测值下方一点，形成棘轮。
- **测试把 `@handbook/*` 解析到源码，而不是 `dist`。** 否则跨包被消费的代码在覆盖率里
  无处归因——`core/src/util/hash.ts` 明明每轮都被 pipeline 调用，却读作 0%。真正的
  `dist` 由 `tsc -b` 和 `pnpm run check:install` 验证，后者用原生 npm 装上打好的 tarball 再跑 CLI。

## 发布

发布由 [changesets](https://github.com/changesets/changesets) 驱动：

```bash
pnpm changeset        # 描述本次改动并选择版本升级方式
```

把生成的文件与代码一起提交。合入 `main` 后，Release 工作流会开一个 "Version Packages" PR：
应用待处理的 changeset、升版本、生成各包的 `CHANGELOG.md`。合并该 PR 即发布到 npm——
在配置 `NPM_TOKEN` secret 之前这一步是空转的，因此无论是否真的对外发布，版本号和
changelog 都保持正确。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
