# Codewiki 项目进度追踪（内部）

> 本文件用于跨会话恢复进度。每完成一个里程碑就更新。
> 约束：新项目不得提及/引用任何源参考项目的名称、链接、论文、示例项目名。

## 目标

在 /Users/jack/Desktop/share/handbook 用 Node.js + TypeScript + pnpm monorepo
实现一个「代码库手册」工具链，功能覆盖并强于参考实现：

1. **generate**：从任意代码库生成结构化手册（两种策略：大库 file-as-leaf 自底向上 / 小库 skeleton 驱动），markdown + HTML 站点。
2. **helper**：手册 → agent skill 打包；手册驱动的变更定位 planner；代码变更后手册增量 resync。
3. 多语言静态分析（Python/TS/Go/Rust/Shell 等，tree-sitter WASM，无原生编译）。
4. LLM 均走 OpenAI 兼容端点（env: OPENAI_API_KEY/OPENAI_MODEL/OPENAI_BASE_URL）。

## 技术选型（已确认可用）

- Node 24.14 / pnpm 10.18 / npm registry 可访问
- tree-sitter: `web-tree-sitter@0.26.x` + `tree-sitter-wasms@0.1.13`（纯 WASM，免 node-gyp）
- CLI: commander@15；校验: zod@4；YAML: yaml@2.9；MD→HTML: markdown-it@15
- 测试: vitest@4；构建: tsc -b（composite project references，纯 ESM "type":"module"）
- LLM 客户端：自研 thin fetch 客户端（重试/并发限流/JSON 模式），不依赖 openai SDK

## 状态（随做随更）

- [x] 环境与依赖可行性验证（web-tree-sitter 必须锁 ~0.25.10，0.26 与 tree-sitter-wasms ABI 不兼容）
- [x] 三份功能规格已固化：docs/internal/research/spec-{generate-large,generate-small,helper-and-skill}.md（实现每个包前先精读对应章节）
- [x] 设计文档：docs/internal/specs/2026-08-02-handbook-design.md（分包/依赖方向/算法提要/CLI 全在这里）
- [x] monorepo 骨架（pnpm + tsc -b composite + vitest 根配置 + eslint/prettier；根目录 /Users/jack/Desktop/share/handbook，已 git init，main 分支）
- [x] @handbook/core 完成（ir.ts/model.ts/errors/logger/util/*，17 测试绿）
- [x] @handbook/llm 完成（client.ts OpenAI 兼容 + mock.ts + critic.ts actor-critic，14 测试绿）
- [x] @handbook/analyzer 完成：5 语言 adapter（python/typescript/go/rust/shell）+ graph + navpack，47 测试绿
- [x] @handbook/pipeline 完成：phase1/2a(cards 三级降级)/2b(oneshot+doctor+user-skeleton)/2c/3(rollup缓存+registers loop-until-dry) + member 策略 + mock 全流程测试
- [x] @handbook/renderer 完成：markdown + agent locator site + HTML 多页/单页，47 测试绿
- [x] @handbook/skill（build + validate 含 coverage 哈希漂移检测）
- [x] @handbook/planner（只读工具环 ReAct agent + 规划提示词 + declarations 解析）
- [x] @handbook/resync（case 合同 / graph diff / 卡片子集再生 / assignment·organization·narration 滚动 / noLlm 降级）
- [x] @handbook/cli（analyze/generate/render/skill/validate/plan/resync 七命令，--help 已验证）
- [x] 全仓 149 测试绿（18 文件）；全部已 commit
- [x] examples/ 完成且 E2E 跑通（analyze→generate(mock)→render(md+html×2+agent)→skill→validate OK）
- [x] 真实仓库验证：`handbook analyze --source packages` → 76 文件/316 函数/903 边
- [x] 文档：根 README en/zh、LICENSE(MIT)、docs/architecture|formats|prompts、examples/README
- [x] 9 包 README 完成
- [x] 对抗评审 round1 完成：21 项发现（5 高/11 中/5 低），全部修复并加回归测试（156 测试绿），E2E 重跑通过，commit 63d1511。发现清单在 docs/internal/review/round1-*.md
- [x] round2 完成：21/21 round1 修复确认 OK 无回归；新发现 9 项（2 中/6 低/1 信息）+ 3 处文档漂移，全部修复（含 strategy 持久化、保留 id 防覆盖、resync 卡片清理、FENCE_RE info-string），160 测试绿，commit 9325007
- [x] round3 完成：12/12 round2 修复确认 OK；新发现仅 3 项低危（CLI 惰性 client、重命名孤儿、member resync），全部修复，commit df1331d
- [x] 最终验收通过：干净全量构建 0 错误、161/161 测试、eslint 0 告警、E2E demo validate OK、自分析 76 文件/322 函数

## ✅ 项目完成（2026-08-02）

三轮对抗评审共 33 项发现（5 高/11 中/16 低+信息+文档），全部修复并有回归测试兜底。
恢复本项目上下文只需：本文件 + git log + docs/internal/specs/2026-08-02-handbook-design.md。

## 关键决策记录

- D1: 统一管线 + 两种 granularity 策略（file/member）；file 策略全量实现，member 策略实现精简版（骨架驱动分类+叙述）。
- D2: 命名最终定为 **@handbook/*** 、CLI `handbook`、项目名 Handbook；严禁出现源参考项目的任何名称/链接/论文。
- D3: 中间产物 JSON/YAML + zod 校验 + version 字段；work-dir 幂等可恢复。
- D4: 纯 ESM + NodeNext；相对 import 必须带 .js 后缀；tsc -b 构建后 vitest 直跑（vitest 用 workspace 源码转译，跨包 import 走 dist，故先 build 再 test）。
- D5: LLM 一律走 ChatClient 接口注入；测试/E2E 用 MockChatClient（rules: match→respond）。

## 工作节奏约定（防 session 断裂）

1. 每完成一个包：更新本文件状态 → git commit。
2. 委派 subagent 时把«精确接口 + 参照文件 + 测试要求»写全，产物直接落 packages/。
3. 恢复会话时：读本文件 + git log + 设计文档即可续作，无需重读源项目。


## 2026-08-03 增量记录

- deck 团队分享页（docs/handbook-deck.html，13 页暗金 keynote 风）+ 白话讲稿（docs/handbook-deck-script.md），经 5 轮对抗
- renderer 孤儿页 bug 修复（.render-manifest.json 清单法；html/agent 目录直接清扫）
- **@handbook/studio**（第 10 个包）：本地 Web UI（127.0.0.1）——仓库注册/生成（SSE 日志）/内嵌手册浏览/plan/resync 演化历史；CLI `handbook studio`
- studio 对抗评审 15 项全修：CSRF 防护、**内容哈希级变更探测**（phase1 graph.metadata.fileHashes，resync 用哈希 diff）、declarations 参与 resync 范围、UTF-8 分块解码、workDir 冲突守卫、部分阶段渲染守卫、失败清理、任务逐出等
- 全仓 182 测试绿；studio 实例可用：`handbook studio` → http://127.0.0.1:4860

## 2026-08-03 第二阶段：Studio 产品化 + 真实补丁执行器

- **@handbook/patcher**（第 11 个包）：把 plan 的 EDIT 块真正落盘。全成或全不成、逐字节唯一匹配、
  两阶段原子写（rename 中途失败自动还原）、备份 + sha256 前后哈希、可回滚且拒绝覆盖补丁后的新工作、
  跨进程树锁（原子 wx 独占文件，key 为源码树而非备份目录）、CommonMark 双围栏解析 + 结构完整性拒绝、
  UTF-8/CRLF/文件模式/大小上限/符号链接全覆盖。CLI: `handbook apply [--dry-run]` / `handbook rollback [--force] [--source]`
- **四轮对抗评审共 71 项发现全部修复**（R1 28 / R2 17 / R3 14 / R4 12），其中 11 项高危。
  最惊险：文档型计划的示例 EDIT 被当真执行（两次被捅开）、解析器拒绝本项目自己文档化的 planner 输出
  （plan→apply 端到端断链，测试却全绿——测试助手从不生成 declarations 块）、并发 apply 静默丢边（8/8 → 0/6）。
  评审报告：docs/internal/review/patcher-r{1,2,3,4}.md
- **Studio UI 产品化**（单文件 1900+ 行、零外部请求）：Home 落地页（工作流步骤条）、Instructions、
  跨仓库演化历史、影响图 SVG（自算布局、按阶段着色、点击进源码）、源码查看器（行号 + 函数索引）、
  补丁流（dry-run/应用/逐条结果表/回滚/备份列表/跳过项显式覆盖）、中英 i18n、明暗主题
- studio 后端 6 个新接口；全仓 **235 测试绿**，11 包
- 端到端 HTTP 实测：apply → 手改文件 → 守卫回滚拒绝 → force 回滚字节还原，全部符合预期

## 2026-08-03 第三阶段：真实端点的「静默空手册」根因修复

用户在 Studio 点「重新生成」自己的仓库（90 个文件），日志显示成功，实际 **90 个文件卡片全空**
（`nDescribed: 0`）。定位过程与结论（这是本项目至今最有价值的一次真实反馈）：

- **不是端点故障**：同一端点单独探测能正常返回；16 路并发 16/16 成功；骨架/章节组织阶段
  在同一次运行里产出了真实中文内容 —— 说明失败只发生在「卡片」这一条解析路径上。
- 三个叠加缺陷（都在「模型回复 → 卡片」的路上）：
  1. `packages/llm/src/client.ts`：空 `content` 被当成成功返回（只判 `undefined`，`''` 通过），
     不重试、不报错。推理型端点把预算花在 `reasoning_content` 上时就会这样。
  2. `packages/core/src/util/json-extract.ts`：中文散文里写未转义英文引号（`拿来"考一遍"。`）
     使整段 JSON 非法；随后平衡扫描抢到一个恰好合法的**嵌套碎片**（`functions` 映射、`[]`），
     把碎片当成答案。→ 新增 `repairJson`（只修引号/裸换行，绝不猜结构），
     并把「修复后的栅栏块」排在「扫描碎片」之前。
  3. `packages/pipeline/src/cards.ts`：只认 `{"purposes":[{file,…}]}` 一种形状。每批只有 1 个
     文件时模型自然回单个卡片对象（无外壳、无 `file`），全被丢弃。→ 接受裸数组、
     `files`/`cards`/`results`、单卡片对象（批内唯一文件时归属之）、松散路径、
     `functions` 按 qualname 做成对象。
- **可观测性补齐**：批次「有回复但无可用条目」时打印 JSON 实际形状 + 回复前 200 字，
  原始回复存 `<work>/phase2/cards/_rejected/<file>.txt`；**全部文件失败则直接让作业失败**
  （部分降级是诚实的部分覆盖，全量降级是配置坏了在假装成功）。
- 真实端点验证：同一 6 文件目标 **0/6 → 6/6**，零警告；卡片含中文 purpose/description 与
  逐函数 purpose/dataFlow/relations（带行号）。全仓 **245 测试绿**。
- 教训（与 patcher R3 同源）：只要产品的解析层比模型的真实输出更窄，测试再绿也会交付空壳。
  fixture 必须来自真实回复，而不是我们期望的形状。

### 同一根因的其余变体（同日续修）

- **截断也是失败**：`finish_reason: 'length'` 的回复以前被当成成功——JSON 解析不出、散文断在半句，
  于是又变成「静默缺输出」。现在抛可重试错误，重试放大预算。
- **网关页也是可重试的**：2/90 个文件死在 HTTP 405，但响应体是阿里云边缘的 HTML 错误页
  ——API 根本没看到请求。405 在永久错误集合里，所以直接放弃。现在「HTML 响应体」一律判为可重试
  （JSON 形式的 API 拒绝仍是永久错误）。
- **那 2 个文件的真相**：服务商 WAF 按**内容**拦截（`analyzer/.../shell.test.ts` 含 shell 命令、
  `planner/src/planner.test.ts` 含补丁文本）。实测：两文件全文/半文都 405，等长纯文本 200。
  这是服务商策略，不是缺陷；正确行为＝重试后诚实降级为空卡片并在覆盖率里点名（已实现）。
  **不做任何绕过 WAF 的处理。**
- **Studio 概览补上「已描述覆盖率」**：原来只显示归档覆盖率（每个文件都进了章节 → 看着 100%），
  这正是空手册能装成成功的原因。现在同时显示 `described N/M` 与空卡片数，未满则高亮。
- **骨架合成失败会自我解释**：以前只说 "returned no usable stages"，5 分钟的运行就此结束。
  现在带上回复形状与摘要，原始回复落 `_rejected/`，并且阶段列表也走容忍读取器。
