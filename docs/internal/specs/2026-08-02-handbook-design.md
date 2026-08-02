# Handbook — 设计文档

日期：2026-08-02　状态：已定稿（自主模式下按此实施）

## 1. 目标

把任意代码库变成一本可导航的「系统手册」，并让这本手册反过来服务于代码变更：

1. **generate** — 静态分析 + LLM 多阶段管线，产出结构化手册（markdown + 自包含 HTML 站点）。
2. **skill** — 把手册打包成 agent 可挂载的 SKILL（SKILL.md + references/），附带格式校验与覆盖率。
3. **plan** — 手册驱动的只读规划 agent：给定自然语言变更请求，定位所有需要修改的位置并输出精确编辑计划。
4. **resync** — 代码变更后，把手册的派生层增量滚动到新代码（不重跑全量管线）。

非目标：不做 benchmark/评分系统；不做在线服务；不发布 npm（全部 `private: true`）。

## 2. 备选方案与决策

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 两条独立管线（大库/小库各一套） | 与参考行为一一对应，代码重复率高（两套 adapters/critic/api client） | ❌ 维护性差 |
| B. **统一管线 + 两种 granularity 策略**（file / member） | phase1、cards、actor-critic、渲染全部共享；策略只决定"叶子是文件还是函数"与骨架来源（自动合成 vs 用户撰写） | ✅ **采用** |
| C. 只实现 file 策略 | 功能缺失（小库的成员级精细叙述没了） | ❌ |

其他关键决策：

- **D1 纯 WASM 解析**：`web-tree-sitter@0.25.x` + `tree-sitter-wasms`（已原型验证），零 node-gyp，Python 也走 tree-sitter（不再依赖 CPython ast），六种语言一个实现路径。
- **D2 LLM 客户端自研 thin client**：fetch + 重试（线性退避+抖动、永久 4xx 速败）+ 并发信号量 + JSON 提取。接口注入式（`ChatClient` interface），测试用 `MockChatClient`，全管线可离线测试。
- **D3 中间产物全部 JSON/YAML + zod 校验 + 版本号**；work-dir 幂等可恢复（内容哈希缓存、resume 跳过已完成单元）。
- **D4 纯 ESM + tsc -b composite references**；不引入 bundler/turbo，依赖面最小。
- **D5 actor-critic 框架**放在 `@handbook/llm`（与业务无关的编排原语：actor→N critics→revise→收敛）。

## 3. Monorepo 分包

```
packages/
  core/       @handbook/core       IR/手册数据模型 + zod schema、错误类型、并发/重试/哈希/原子写/进度等工具。零依赖层。
  analyzer/   @handbook/analyzer   多语言静态调用图（adapter 注册表 + 6 语言 adapter + graph 组装 + nav-pack 定向包）
  llm/        @handbook/llm        OpenAI 兼容 ChatClient（env 解析/重试/JSON 模式/用量统计）+ actor-critic 编排 + Mock
  pipeline/   @handbook/pipeline   生成管线：phase1(图) → phase2(卡片/骨架/指派/编组) → phase3(叙述/寄存器)；file|member 两策略
  renderer/   @handbook/renderer   手册模型 → markdown 页面树 + agent 定位索引 + 自包含 HTML 站点（多页/单页）
  skill/      @handbook/skill      手册 → SKILL 包；手册格式校验器；覆盖率报告
  planner/    @handbook/planner    只读工具环 agent（list/read/grep/finish）+ 规划提示词 → 编辑计划(EDIT 块 + 变更声明 JSON)
  resync/     @handbook/resync     case 合同(edited/ + plan.md + diff) → 派生层增量更新（重析变更文件、卡片修补、索引重建）
  cli/        @handbook/cli        `handbook` 命令：analyze | generate | render | skill | plan | resync | validate
```

依赖方向（单向无环）：
`cli → {pipeline, renderer, skill, planner, resync}`；`pipeline → {analyzer, llm}`；
`planner/resync → llm`；所有包 → `core`；`core` 无内部依赖。

**分包原则**：每包一个明确职责、一个稳定公共 API（`src/index.ts` 显式导出）、可独立测试；
LLM 相关与纯确定性逻辑严格分层（renderer/skill/analyzer 完全无 LLM，可离线复用）。

## 4. 数据模型（core）

```ts
// 调用图 IR（phase1 产物）
FunctionNode { id, name, qualname, file, lineStart, lineEnd, signature, isAsync, isMethod,
               className?, decorators[], kind:"internal", synthetic, selfAttrsRead[], selfAttrsWritten[],
               paramTypes: Record<string,string> }
BoundaryNode { id:"boundary:<qual>", name, qualname, module, className, kind:"boundary" }
CallEdge     { callerId, calleeId, isAwait, callType, line, raw }   // callType 8 值枚举 + unresolved
CodeGraph    { metadata, nodes, edges, selfAttrs }                  // graph.json

// 手册模型（phase2/3 产物）
Skeleton     { metadata{version,archetype,draftedBy}, stages: Stage[] }
Stage        { id, title, description, parent, children[], crosscut }
FileCard     { file, purpose, role(枚举10值), lifecycle, description?, functions?: FunctionNote[] }
Assignment   { fileStage: Record<file,{stage,also[]}>, buckets, coverage }
Organization { stages: Record<sid,{title,groups[{title,summary,files[]}],orderedFiles[]}>, coverage }
RegisterEntry{ id:"reg-*", semantics, stages[] }
Handbook     { overview, index, registers, stagePages }             // 渲染输入
```

所有产物文件：`graph.json` / `cards/**.json` / `skeleton.yaml` / `assignment.json` /
`organization.yaml` / `registers.json` / 渲染输出 `handbook/`。每个 schema 带 `version` 字段。

## 5. 管线算法（提要；细节见 docs/internal/research/*）

- **Phase 1**（无 LLM）：adapter 按扩展名发现文件（跳过 vendor/node_modules 等）→ 每语言两遍扫描
  （声明收集 → 调用解析：self/attr/param/import 规则）→ 未解析边分流到 dropped-calls → 产出
  graph.json/functions.csv/graph.dot/dropped-calls.json + nav-pack（目录卷积、入口点、扇出、外部子系统）。
- **Phase 2 (file 策略)**：
  - *cards*：批量读文件（brief 一句话 / deep 全文 120–300 词 + 逐函数 purpose/data_flow/relations），
    三级降级（批→单文件→函数分块），主线程增量写卡，backfill 保证覆盖率诚实，`--resume`。
  - *skeleton*：目录卷积 + 入口点 → oneshot 合成 12–25 个按生命周期排序的 stage；
    `doctor` 模式：actor（≤3 个结构变更：add/remove/merge/split）× 3 并行 critics（engineer/architect/reader）
    收敛循环，卡死检测（连续 2 轮无进展），受保护 stage 防并行冲突。
  - *assign*：文件→stage 批量指派（菜单约束、unassigned 逃逸、also 0–2）。
  - *organize*：每 stage 内 Kahn 拓扑序 → LLM 编组 2–8 组，失败回退平铺组，文件永不丢失。
- **Phase 2 (member 策略)**：用户撰写 skeleton.yaml；成员（函数/方法）级分类 → critic 审核 →
  重指派审计 → 组内排序（editor critic + 置换校验，行序回退）。
- **Phase 3**：深度分批（最深先）自底向上 rollup（stage 100–200 词、system 200–350 词，内容哈希缓存，
  失败回退确定性文本）；寄存器 loop-until-dry 提取（gap 轮次，连续 2 轮无新增即停）；
  member 策略走 tier 叙述（actor→rubric 评分→reflect→revise，plateau 停止，保留最佳）。
- **渲染**：markdown（overview/index/register/stages/*）+ agent 定位索引（Duty/Entry concepts/State/
  Exemplar/强共变/Core files，空字段即信息）+ HTML 站点（多页含侧栏树/主题切换/details 折叠；单页自包含）。
- **skill**：手册 → SKILL.md（导航协议）+ references/（index/registers/stage 页），校验器（结构规则）+ 覆盖率。
- **planner**：只读 agent（工具：list_dir/read_file/grep/finish_plan），提示词要求"先用手册路由 → 读真实源码 →
  输出逐字精确 EDIT 块 + will_modify/will_add/will_remove 声明 JSON"。沙箱=源树只读视图。
- **resync**：case(edited/ + plan.md + 可选 diff)；diff/声明 → 变更文件集 → 重跑该子集 phase1 + 卡片再生
  （LLM，可 `--no-llm` 降级为图字段更新）→ stage 页局部重渲染 → index/registers 重建。

## 6. CLI

```
handbook analyze   --source <dir> --work <dir> [--lang auto|python|...]         # phase1，无 LLM
handbook generate  --source <dir> --work <dir> [--strategy file|member] [--skeleton <yaml>]
                   [--phase all|1|2|2a|2b|2c|3|逗号列表] [--detail brief|deep] [--narrate-lang en|zh]
                   [--synth-mode oneshot|doctor] [--resume] [--workers N] [--html]
handbook render    --work <dir> [--out <dir>] [--html|--html-single] [--agent]  # 无 LLM
handbook skill     --handbook <dir> --out <dir> [--name X]                      # 无 LLM
handbook validate  --handbook <dir>                                             # 无 LLM
handbook plan      --source <dir> --handbook <dir> --request "..." [--out plan.md]
handbook resync    --case <dir> --work <dir> [--no-llm]
```

env：`OPENAI_API_KEY|MODEL|BASE_URL|MAX_TOKENS`（兼容 `HANDBOOK_LLM_*` 覆盖）、`HANDBOOK_TITLE`。

## 7. 质量策略

- **测试**：vitest。core/analyzer/renderer/skill 纯确定性 → 单元+快照测试；pipeline/planner/resync 用
  MockChatClient 脚本化对话 → 集成测试；fixtures/ 内置迷你多语言仓库。
- **E2E**：examples/ 演示仓库跑 `analyze`（真实）+ `generate --mock`（确定性 mock 端点）→ render → skill → validate 全链路。
- **对抗评审**：≥3 轮独立评审（正确性 bug 猎手 / 架构与 API 一致性 / 文档-代码一致性），每轮验证后修复，直至干涸。
- **文档**：根 README（故事线+快速上手）、每包 README（职责/API/示例）、docs/architecture.md（分层图+数据流）、
  docs/formats.md（全部产物 schema）、docs/prompts.md（提示词目录）。
