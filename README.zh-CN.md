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
支持语言：Python、TypeScript、Go、Rust、Shell——`--lang auto` 自动探测并合并。

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
handbook resync   --case cases/upload-retry --work work/myrepo       # 7. 变更落地后前滚手册
```

`generate` 关键参数：`--strategy file|member`（file=自动骨架、文件为叶子；member=你手写
`skeleton.yaml`、逐函数分类）、`--detail brief|deep`、`--synth-mode oneshot|doctor`
（doctor=actor-critic 修复循环）、`--narrate-lang en|zh`、`--phase`、`--resume`。

## 生成管线如何工作

| 阶段 | 内容 | LLM |
|---|---|---|
| 1 | 各语言 adapter（tree-sitter WASM）把每个文件解析成带类型的调用图：函数/方法、已解析的调用边（self / 属性 / 参数 / import 四类规则）、外部边界调用；无法解析的调用被隔离进 `dropped-calls.json`，绝不混入图中。 | 无 |
| 2a | 每个文件一张**卡片**：purpose / role / lifecycle；deep 模式再加 120–300 词走读 + 逐函数 purpose / data_flow / relations（prose 由 LLM 写，事实来自调用图）。批量、三级降级、崩溃安全、可续跑。 | 有 |
| 2b | 从目录卷积 + 入口点合成阶段**骨架**（按执行生命周期排序的叙事主线），再把每个文件指派到唯一主阶段。`--synth-mode doctor` 启动 actor-critic 修复循环（工程师/架构师/读者三个评审），直到无未指派文件且再无结构变更通过评审。 | 有 |
| 2c | 每个阶段内按调用图拓扑排序，再编成 2–8 个带标题的小组；任何失败都退化为确定性平铺顺序——文件永不丢失。 | 有 |
| 3 | 自底向上叙述：先子后父生成阶段概述、系统总览，并用 loop-until-dry 间隙轮提取跨阶段**状态寄存器**。全部内容哈希缓存。 | 有 |

所有产物都是 work 目录下经 schema 校验的 JSON/YAML；任何阶段都能独立重跑，崩溃后原地续跑。

## Monorepo 布局

| 包 | 职责 |
|---|---|
| [`@handbook/core`](packages/core/README.md) | 数据模型（调用图 IR + 手册模型）、zod schema、零依赖工具库 |
| [`@handbook/analyzer`](packages/analyzer/README.md) | 多语言静态调用图（tree-sitter WASM），无 LLM |
| [`@handbook/llm`](packages/llm/README.md) | OpenAI 兼容客户端 + actor-critic 编排 + 离线 mock |
| [`@handbook/pipeline`](packages/pipeline/README.md) | 生成管线（阶段 1–3，file/member 双策略） |
| [`@handbook/renderer`](packages/renderer/README.md) | markdown 页面、agent 定位索引、自包含 HTML 站点，无 LLM |
| [`@handbook/skill`](packages/skill/README.md) | SKILL 打包 + 校验 + 覆盖率漂移检测，无 LLM |
| [`@handbook/planner`](packages/planner/README.md) | 手册驱动的只读规划 agent |
| [`@handbook/resync`](packages/resync/README.md) | 代码变更后的手册增量前滚 |
| [`@handbook/cli`](packages/cli/README.md) | `handbook` 命令行 |

依赖方向严格单向（`cli → pipeline/renderer/skill/planner/resync → analyzer/llm → core`）；
触碰 LLM 的代码与确定性代码按包边界分层，analyzer / renderer / skill 完全不依赖 LLM，可独立复用。

## 文档

- [docs/architecture.md](docs/architecture.md) — 分层、数据流、设计决策
- [docs/formats.md](docs/formats.md) — 全部产物 schema（graph、cards、skeleton……）
- [docs/prompts.md](docs/prompts.md) — 完整提示词目录
- [examples/](examples/) — 离线端到端演示（内置 mock LLM 服务器）
- 各包 README 见 [packages/](packages/)

## 开发

```bash
pnpm build          # tsc -b（composite 引用，增量构建）
pnpm test           # 构建 + vitest（150+ 测试，全部离线）
pnpm lint           # eslint
pnpm format         # prettier
```

测试哲学：一切离线。LLM 相关流程用 `MockChatClient`（规则脚本）与内置 mock HTTP 端点测试；
确定性包直接测试。任何测试都不需要 API key。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
