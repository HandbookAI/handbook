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

### 对抗评审 R1（llm/pipeline 回复处理）——14 项全修

报告：`docs/internal/review/llm-shape-r1.md`（4 高 7 中 3 低，每条都有可运行的复现脚本）。

最重要的结论：**我的第一版修复各修了一半，组合起来比原缺陷更危险**——`repairJson` 在最常见的
散文引号形态上失败 → 平衡扫描抢到嵌套碎片 → 新加的形状容忍给碎片背书，于是「函数注解冒充文件卡片」
且覆盖率报 100%、零警告。修法：

- `repairJson` 重写为**有界回溯解析器**：歧义引号两种读法都试，只接受整体解析通过的；平局时用
  「散文里的引号成对出现」这一性质打分（留下奇数引号字符串的读法是把一对切开了）。
  评审的 10 个散文样例现在 10/10 精确恢复，字符串数组不再被切开。尾随逗号接受（无歧义），
  截断仍然返回 undefined（绝不补结构）。
- 有栅栏块时**不再退回扫描碎片**：修不好就报失败。
- 卡片：拒绝函数注解冒充卡片；`purpose` 单独不足以判定卡片；**回复点名的文件必须落在本批次内**
  （给别的文件写的卡片是答错，不是名字松）；去掉裸文件名兜底；显式命名的卡片不被松匹配覆盖；
  没产出 purpose 的条目算未描述（让二三级兜底继续跑）。
- 骨架不接受「单个对象」当脊梁（`id`/`title` 太通用，错误信封会变成一章手册）。
- 成员分派只在批次为 1 时继承身份；批次大部分丢失也要告警（不只是全丢）。
- 全失败中止需要**系统性证据**（≥3 文件且确实发过调用），并报告留存了什么。
- 客户端：预算放大改为**按调用**、上限 2×、并受「从 400 学到的天花板」约束（关于 token 参数的
  400 现在可重试而非永久）；截断只在「要结构且结构坏了」时拒绝，**散文截断保留**并告警。
- Studio：`--warn` 双主题配色（浅色 2.39:1 → 合规）；覆盖率文件损坏不再让 /overview 谎称没生成。

### 真实端点的性能真相（实测）

`glm-5.2` 为 900 字符的答案写 3–6.5 万字符 `reasoning_content`（completion_tokens 13281/16000），
单轮 2–3 分钟，有时预算被思考吃光返回空正文。对应新增两个旋钮：
`OPENAI_TIMEOUT`（秒，默认 300）与 `OPENAI_EXTRA_BODY`（JSON，透传厂商字段，
如 `{"thinking":{"type":"disabled"}}`；client 自己管的字段受保护）。
另外 Studio 之前没把作业日志器传给 LLM 客户端 —— 重试/超时全程隐形，已修并加测试断言。
寄存器还支持了「纯文本列表」回退（`- reg-x: 说明`），因为实测有一轮模型就是这么答的。

全仓 **295 测试绿**。

## 2026-08-03 收尾：同一根因的第 4/5/6 次现身 + 最终产出

真实端点又暴露了三个同类缺陷（都是「把失败当成结果」或「把正确答案当成失败」）：

4. **空结果被写进缓存**：网络中断那次把「0 条寄存器」写入 `phase3/cache/registers_*.json`，
   之后每次运行瞬间返回 0、一行日志不打，手册等于宣称「本代码库没有任何运行时状态」。
   → 空结果不入缓存；命中缓存要打日志；一条都没抽到要告警。
5. **字段名单复数之差丢掉 20 条**：模型返回 20 条完全正确的寄存器（`reg-` 前缀、阶段链接都对），
   但meaning 写成 `"semantic"`（单数）。读取器只认 `semantics`/`description` → 20 条静默蒸发。
   → 新增 core `pickString(entry, aliases)`；**每条「收到但用不上」的条目必须计数并说明原因**
   （沉默本身才是缺陷）。
6. **critic 裁决形状漂移 = 永久 REJECT**：裁决读不出来按设计算 REJECT（坏审稿人不能放行），
   但键名不同也会导致「永远 REJECT」，看起来和「严格的审稿人」一模一样。
   → 接受 `verdict`/`judgement`/`status`；接受纯决策词回复（剥 markdown 强调）；
   **散文不能投票**（"I would not approve this" 仍是 REJECT）；读不出来时打印形状+摘要。
   另：空轮（`[]`）是收敛信号，不再当警告——把「一切正常」报成警告会训练人忽略警告。

### 端点性能与配置结论（实测）

`glm-5.2` 默认为 900 字符答案写 3–6.5 万字符思考。加 `OPENAI_EXTRA_BODY={"thinking":{"type":"disabled"}}`
后同一提示词 1009→309 tokens、11.2s→7.0s。全流程 40+ 分钟 → **约 3 分钟**（章节组织 23 分钟 → 9 秒）。
质量对比（同一仓库，快照在 scratchpad/before/）：卡片 90/92 → 91/93；章节 20 → 20；
寄存器 23 → 21；系统总览 357 → 462 字；**寄存器带阶段链接 0 → 12**；配 `doctor` 模式后未归档 22 → 0。
结论：这个端点关思考更划算，未归档问题用 doctor 模式解决（现在只要 1 分钟，以前跑不起）。

### 最终产出（examples/work/self）

93 文件 / 412 函数 / 1351 条调用边；91 张卡片；20 章；21 条寄存器；0 未归档；
23 个 Markdown + 23 个 HTML 页 + 441 KB 单页 `handbook.html`。
剩 2 个文件（`analyzer/.../shell.test.ts`、`planner/src/planner.test.ts`）被服务商 WAF 按内容拦，
如实降级并在覆盖率点名，不做绕过。全仓 **302 测试绿**。

## 2026-08-04（晚）：全仓对抗式审计 + P0 修复（5 个里程碑，361 测试绿）

三路并行逐文件通读全部 11 包 + 9 份评审文档 + git 史，交叉验证后修复全部 P0 项。
完整审计报告（含 P1/P2/P3 待办：LLM 缓存/成本报表/run manifest、llms.txt/MCP、CI 等）
存于 ~/.claude/plans/handbook-linear-ripple.md。

### 修复清单（每项先写失败测试再修）

1. **analyzer（最重）**：TS/Go 跨模块自由函数调用被误判为 boundary——TS 只有类索引，
   Go 的 `pkg.F()` 一律外部；且 `typescript.test.ts` **显式断言了错误行为**（断言来自实现
   而非规格——round1-3 教训「解析层比模型窄」的测试版）。修复：TS 加 `moduleFunctions`
   索引 + 相对路径解析（命名/命名空间导入都解析）；Go 按 import 路径后缀匹配已扫描包
   （最长目录优先）。另修 navpack 空字符串模块键（`./x.js::f` → `''`）与 `node:fs` 塌缩，
   `discoverAll` 吞 adapter 崩溃改为告警。
2. **resync（4 个未被评审发现的缺陷）**：单文件哈希缺失被永久误报 added/changed（成员资格
   改看 scannedFiles，缺哈希逐文件回退结构指纹）；脏 stage 组织被整体替换为单一 "(resynced)"
   组、反复 resync 永久扁平化（改为最小机械编辑：剔除/刷新/追加，LLM 分组存活）；
   `detail` 硬编码 deep（新增 `detectCardDetail`，brief 手册不再静默升级）；CLI resync 不重
   渲染（新增 `refreshRenderedHandbook`，只刷新已存在的产物，`--no-render` 跳过）。
3. **patcher**：R4 宣称「全部关闭」实有 4 项开放，逐项补齐——F7 锁 owner 记 host、异机
   owner 视为存活、报错带 pid/host/startedAt+人工补救；F9 锁目录写 .gitignore、空目录释放
   时清理（仓里那个 `packages/.handbook-patches` 空目录就是此缺陷的活证据，已删）；
   F11 `new` 先于 `old` 拒绝；F12 未闭合围栏只报一次；F10 两份 README 补安全契约表缺行
   + throws-vs-returns 说明。**教训：finding 关闭必须附验证证据，声称关闭 ≠ 关闭。**
4. **work-dir 锁**：CLI 与 studio 并发 generate/resync 同一 work 目录会交错写。core 新增
   `withDirLock`（进程内可重入、host-aware、死本机 pid 可回收），generate/phase1/resync
   三入口取锁。
5. **文档漂移**：README step 8 引用不存在的 case 目录（现内联组装说明）；314→361 测试数；
   resync README/architecture.md 的指纹 diff 描述已被内容哈希取代；prompts.md 补第 17 条
   （studio resync 标签）；删除仍带旧命名的 ARCHITECTURE-DRAFT.md。

### 审计确认的仍开放项（按优先级，见计划文件）

P1：ChatClient 统一 prompt-hash 缓存（2a/2b/2c 目前零缓存）+ usage 累计成本报表
（`usage()` 现在无消费者）+ run manifest（model/prompt 版本不入产物）+ CI（无 .github/）
+ resync/doctor/navpack 补测试。P2：llms.txt 输出、搜索、graph.dot→mermaid、源码链接、
配置文件、studio 任务取消/重连、SKILL 打包 agent 站点 + i18n。P3：MCP docs server、
agent 纠错回路、最小质量评测集。

## 2026-08-04（深夜）：P1/P2 并行冲刺（5 个并行 subagent + 串行集成，451 测试绿）

按包边界切 5 个互不重叠的工作块并行实现，CLI 接线与集成串行收尾。全部 TDD。

1. **llm/pipeline**：`CachedChatClient` prompt-hash 缓存装饰器（只缓存非空成功；坏文件当
   miss；hits/misses 计数）；`LlmUsageStats` 累计 prompt/completion tokens（被拒重试的回复
   也如实计费）；`generateHandbook` 写 `<work>/run-manifest.json`（model/phases/时间/usage/
   stats，失败不覆盖）。CLI：`generate --llm-cache`，结果里带 usage。
2. **CI + 测试补强**：`.github/workflows/ci.yml`（Node 20/24 跑 pnpm check）；graph/doctor/
   organize 三个零测试模块 +39 测试。**顺手修一个新缺陷**：`validateChange` 接受自合并
   merge_stages，apply no-op 却计为 progress、干扰卡壳检测（doctor.ts merge 分支新增守卫）。
3. **renderer**：`renderLlmsTxt`（llms.txt + llms-full.txt，AI agent 直接可消费）；
   `SourceLinkOptions.sourceBaseUrl` 文件卡片链接源码（默认输出字节不变，零外链保证仍然
   对默认成立）；overview.md mermaid 阶段树（crosscut 虚线）。CLI：`render --llms-txt
   --source-base-url`。
4. **skill**：`agentDir` 把 how_to_use/disambiguation 打进 `references/agent/`（成对才打包，
   SKILL.md 路由协议加消歧步骤）；`lang:'zh'` 本地化正文、frontmatter 保持英文（路由靠
   description）。CLI：`skill --agent-dir --lang`。demo 脚本全链路吃到新旗标，validate OK。
5. **studio**：`GET /api/jobs`；`state.job` 接活——刷新页面后头部脉冲芯片可重连运行中任务
   （SSE 回放补齐日志）；repoStatus 报 outputs 存在性，Handbook 视图新增 章节站点/单页版/
   Agent 索引 切换条；清掉 5 个死 DICT 键。**任务取消仍未做**（需要 abort 信号贯穿
   pipeline/llm，留待下轮）。

集成阶段：pnpm check 全绿（361 → **451** 测试），离线 demo 端到端验证（llms.txt 格式、
mermaid、references/agent/ 打包、validate OK）。仍开放：studio 任务取消、MCP docs server、
agent 纠错回路、最小评测集、生成对话框暴露全部选项。
