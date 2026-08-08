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

## 2026-08-05：取消 / 纠错回路 / 全选项对话框（3 并行块 + 浏览器实测，484 测试绿）

三个并行块 + 串行集成。**本轮的价值一半来自浏览器点击实测**——它抓到一个单测和 HTTP 集成
测试都测不出来的真 bug。

### 1. 协作式取消（贯穿 llm → pipeline → resync → studio）

`ChatOptions`/`GenerateOptions`/`ResyncOptions` 都接受可选 `signal`。llm 层中断在途 HTTP
请求且**不重试 abort**；pipeline 在每个批次/worker/阶段边界 `throwIfAborted()`；resync 在
各编号步骤之间同样检查。被取消的运行在下一个检查点抛 `AbortError`，而不是写到一半被砍：
已落盘的卡片保留、work 目录锁释放、**不写 run manifest**。`CachedChatClient` 把 signal
从缓存键里剔除（signal 绝不能改变一个 prompt 的哈希）但透传给内层客户端。

Studio：`JobRunner` 每个作业一个 `AbortController`，`POST /api/jobs/:id/cancel`（运行中
202、已结束 409）；被请求的 abort 结算为 **`cancelled` 而非 `failed`**，抽屉用中性 ice
配色——**取消是一种结果，不是错误**。按钮点击后自禁用（再 POST 只会 409），结束后隐藏。

### 2. agent 纠错回路（skill + resync）

手册的主要消费者是 code agent，而此前 agent 发现「手册与源码不符」时无处上报。SKILL.md
（中英双语）新增 Corrections 协议：往 skill 根目录的 `corrections.jsonl` 追加一行 JSON——
**故意放在只读 `references/` 挂载之外**——然后继续以源码为准。
`corrections.ts` 提供容错 JSONL 读取（坏行带行号）、去重文件清单、`.applied` 归档（不覆盖）。
`resyncHandbook` 的 `correctionsPath` 让这些文件**扩大**刷新集合（说法被源码否证，就是重写
该文件描述的理由，哪怕字节未变）；不在分析集内的文件进 problems 而非静默丢弃；归档只在整轮
跑完后进行，所以被取消/失败的 resync 会把纠错留给下一次。validate 会警告「N 条未处理纠错」。

### 3. 生成对话框补齐全部 12 个选项

常用 4 项在前，其余（strategy/skeleton/源语言/phase/resume/refresh/workers/doctor 轮数）
收进折叠的「高级」区；服务端转发全部参数，数字垃圾值 400 拒绝。

### 4. 浏览器实测挖出的真 bug：mock 只认英文 prompt

用 puppeteer 真实点击 studio 时，中途 reload 后任务总是 `failed` 而非可取消。追下去发现：
studio 界面默认中文 → `narrateLang=zh` → pipeline 发出**中文**规则文本 → mock 只匹配英文
锚点 → 落到 planner 兜底 → pipeline 正确地拒绝了 `{tool, plan}` 形状的回复。
**这意味着 `NARRATE_LANG=zh bash examples/run-demo.sh`（examples/README 明确宣传的用法）
一直是坏的**，而 484 个单测和 21 个 HTTP 集成测试全都测不到它。

修复：mock 现在识别每个 prompt 的中英两种变体（`### FILE:` 这类结构锚点本就与语言无关）；
另加 `MOCK_DELAY_MS` 让回复故意变慢，以便手工/脚本演练取消。
**教训与 round1-3 同构**：这次是「mock 比 pipeline 的真实 prompt 更窄」——测试替身的覆盖面
比真实调用窄，测试再绿也会漏掉整条语言分支。

### 验证

`pnpm check` 484 测试绿；`bash examples/run-demo.sh` 与 `NARRATE_LANG=zh` 两条都通；
浏览器实测两套：完整 UI 23/23（生成对话框 12/12 选项、任务重连、三种产出切换、取消全流程），
专项取消 12/12（API 202/409、结算为 cancelled、互斥释放、按钮显隐与禁用、中性配色）。

仍开放：MCP docs server、最小质量评测集、studio 手册内容编辑。

## 2026-08-05/06：多语言支持 SP1 地基（脊梁 + 保真度 + 通用引擎 + JavaScript，809 测试绿）

用户要求把 java/C#/C/C++/ruby/php/swift/dart/javascript/solidity/shell/go/php/rust/PowerShell
全部做成**全保真**，未点名语言走通用引擎。设计与路线见
`docs/internal/specs/2026-08-05-multi-language-design.md`（SP1–SP6 六个子项目）。
关键事实：`tree-sitter-wasms@0.1.13` **已自带**这 10 门新语言的 wasm 语法，无需新依赖，
版本锁不动；PowerShell 无语法文件，本轮不做。

### 为什么先做地基（不是为了省代码行数）

审计的 A1 是结构性缺陷的症状：跨模块自由函数索引这个零件，python/rust 有、typescript/go 没有，
四个镜像实现漏装两个，且 TS 的测试把错误行为写成了断言。四个就漏一个；再加九个手写适配器，
这类 bug 翻三倍。`buildStandardIndexes` 一次建全四张标准索引表，**"忘装零件"在结构上不再可能**。

### 交付

1. **公共脊梁**（`spine.ts`）：驱动器 + `BaseScan` + `buildStandardIndexes` + 无状态解析助手。
   设计中途**推翻了自己一个方案**：原打算"公共层固定解析顺序、语言只提供取值器"，深入分析后
   放弃——C 没有方法、Ruby 无类型标注、Solidity 有 modifier，强行统一会做出漏抽象的紧身衣。
   改为工具箱：各语言在自己的 `extractCalls` 里按自己的次序调用助手。
2. **5 个适配器迁移，行为逐字节不变**。这条承重 claim 没只信断言：取一份**两个分析器都没碰过**的
   106 文件语料（旧 commit 的 worktree 快照），新旧各跑一遍——**459 函数、1491 边逐项相同，
   连 callType 与行号都一致**。（先前"自分析边数从 1363 涨到 3859"的疑点也查清了：分析器在分析
   自己被改过的源码，文件路径同、内容变了，自分析无法隔离这个变量。）
3. **JavaScript 白送**：TS 语法解析纯 JS 零错误，`.js/.mjs/.cjs → typescript`、`.jsx → tsx`。
   真实项目验证跨文件解析正确（`.jsx` 里 import `.js` 的自由函数 → `internal_func` 而非 boundary）。
4. **保真度声明**（诚实性）：适配器声明 `tier / callTypes / selfAttrs / statementSpans`，
   透传 `graph.metadata.languages` → 渲染层 → Studio 芯片。`register.test.ts` **双向**校验
   （产出 ⊆ 声明 **且** 声明 ⊆ 产出），杜绝少报与**过度声明**。
   我额外补了 agent 站点与 llms.txt 的披露——**手册的主要消费者是 code agent**，
   `how_to_use.md` 明确写"把这些语言的调用事实当**线索而非结论**"；llms.txt 的披露放在链接列表
   **之前**，因为 agent 可能只读文件头。demo 含 shell（诚实声明 generic 档），三种产出全自动触发。
5. **通用引擎**（`generic.ts`）：kotlin / scala / zig / objc / ocaml。`callTypes` 必填且
   `createGenericAdapter` 对越权声明直接抛错，`self_attr_method`/`param_method` 结构上不可达。

### 两个诚实的放弃（原因记录在案，避免重复踩）

- **elixir**：`defmodule`/`def`/`import`/普通调用是**同一种节点**，声明式配置无法区分定义与调用。
- **lua**：锁定版 `tree-sitter-lua` wasm 有缺陷——**丢哪些函数取决于同一 parser 之前解析过什么**
  （单独解析得 1 个函数，先解析兄弟文件后得 0 个）。独立探针复现，其他语法均无此问题。
  **不可复现的事实比没有事实更糟。**

### 实测发现（已写入 spec）

- **capability 声明是能力上界，不是覆盖密度承诺**：JS 复用 TS 适配器故声明 full+8 种——为真；
  但真实 JS 缺类型标注，类型驱动的几种触发更少。`const e = new Engine(); e.spin()` 不产边，
  因为适配器学字段/参数类型、**不做局部变量推断**（TS 源码同理，非 JS 退化）。
  故渲染层只对 generic 档说"尽力而为"，**不对 full 档承诺完备性**。
- **IR 层空缺**：`CallType` 没有"对已扫描类型的限定调用"（`Helpers.shout()`、`[Engine reset]`），
  只能降级 `unresolved`（退 `boundary` 会谎称目标在外部）。SP2 做 Java/C# 会大量遇到静态方法，
  届时正式评估是否加 `static_method`。
- **CLI 帮助文本漂移已结构性修掉**：`--lang` 曾硬编码 6 门、落后 5 门，现从注册表推导，不会再漂。

### 状态

analyzer 90 → 257 测试；全仓 484 → **809**。`pnpm check` 全绿，demo(en/zh) 双通。
现支持 10 门：python/typescript(+JS)/go/rust/shell(full 档，shell 声明 generic 待 SP6 升级)
+ kotlin/scala/zig/objc/ocaml(generic 档)。
下一步 **SP2：Java + C#**（全保真，含静态方法这个 IR 决策）。

## 2026-08-07：SP2 — Java + C# 全保真适配器（898 测试绿，现支持 12 门语言）

两门并行实现，均 `tier: 'full'`、8 种 callType 全产出、`selfAttrs: true`，
`register.test.ts` 双向校验（产出 ⊆ 声明 **且** 声明 ⊆ 产出）。

- **Java**（898 行 / 37 测试）：完整祖先链 BFS（含 interface，非仅直接父类）、`super.m()`、
  继承字段的 `this.field.m()`、同包兄弟免 import、static 单成员与 on-demand import、
  嵌套类型、`this()/super()`、静态/实例初始化块（否则其调用会丢失）、注解→decorators。
- **C#**（~1030 行 / 34 测试）：完整祖先链（含接口，带环保护）、`base.M()` 正确跳过 override、
  **`partial` 类跨文件**（真实压测中发现并修复）、**`var x = new T()` 推断**、`using` 别名、
  `using static`、局部函数独立成节点、属性访问器 → `get_X`/`set_X`（**仅在有函数体时**，
  自动属性没有代码可描述）、`x?.M()`。

### 一个差点被我误"修"的东西

Java 的 `id = com.demo.app.App.App.run` 看着像类名重复。查证后**是符合既有约定的**：
`id = <路径推导 moduleId>.<qualname>`，Python 同形（`app.queue.TaskQueue.push` / `TaskQueue.push`），
只是 Java 文件按类名命名让重复显眼。改用 package 作 moduleId 会破坏
`<module>.<Type>.<member>` 的可分解性，而 `graph.ts:synthesizeConstructor` 依赖它。
**教训：动手前先查约定，别凭观感判断。**

### 脊梁局限：两个适配器**独立**撞上同一处

`StandardIndexes` 的 `typeToModule` 是**裸名全局表**，无法表达包/命名空间作用域
（真实项目里 `Config`/`Service` 在多个包重复，裸名匹配会静默选错）；`typeMethods` 按
`<module>.<Type>` 建键，表达不了 C# 的 `partial`；`directoryFunctions`/`moduleFunctions`
对无自由函数的语言结构性为空。Java 与 C# 各自建了私有索引绕开。
**C++ 有命名空间，SP3 会第三次撞上**——届时正式评估给脊梁加作用域版。
现在不动：两个样本不足以定形状，三个才够。

### 端到端验收

`pnpm check` 898 测试绿；真实 Java/C# 项目走完整管线：Java 3 函数 3 边
（`self_attr_method`/`self_method`/`boundary` 各就位），C# 3 函数 5 边
（`internal_constructor` + **`var` 推断出的 `param_method`** + `self_attr_method`
+ `self_method` + `boundary`）；Java 项目经 mock 端点产出完整中文手册。

**现支持 12 门**：python / typescript(+JavaScript) / go / rust / **java** / **csharp**（full）
+ kotlin / scala / zig / objc / ocaml / shell（generic）。
下一步 **SP3：C + C++**（含脊梁作用域索引的决策）。

## 2026-08-07：工程化与规范化整改（961 测试绿，覆盖率门禁落地）

起因是一句评价：工程化和规范化都很差。查下来结论不是「没有规范」，而是
**规范只存在于人的习惯里，一条都没有被机器强制**——于是它已经结出了两个真实缺陷。

### 两个硬伤（不是风格问题，是缺陷）

1. **`dist/` 里混进 192 个测试产物。** 测试放在 `src/**/*.test.ts`，而每个包
   `include: ["src"]` + `files: ["dist"]`，于是 `.test.js` / `.test.d.ts` 全部进了发布面。
2. **`packages/cli` 的 project references 已经和 `dependencies` 漂移。** 它依赖
   `@handbook/patcher` 和 `@handbook/studio`，但 tsconfig 两个都没引。根 tsconfig 引了全部
   11 个，所以根目录 `tsc -b` 一直把它盖住；单独 `tsc -b packages/cli` 会以错误顺序构建。

修法：构建工程排除 `*.test.ts` / `*.test-helper.ts`，测试改由新增的 `tsconfig.tests.json`
以 `noEmit` 检查（**不能因为不发布就不检查**）。补齐 cli 的两个引用。

### 让它们回不来：`scripts/check-workspace.mjs`

七条结构不变量，全部来自这个仓库真实违反过的事：references ⟺ workspace deps 双向一致、
`workspace:` 协议、根 tsconfig 引全量、构建排除测试 + `dist/` 无测试产物、manifest 形状统一、
可发布包不得依赖 private 包、三方版本必须走 catalog。

**反向验证过**：植入 3 个缺陷（删一个 reference、写死一个版本、往 dist 塞一个 `.test.js`），
三个全被报出、exit 1；恢复后 exit 0。检查器不是空转的。

### 规范从「写了」变成「被强制」

- `format:check` 原本既不在 `check` 里也不在 CI 里——**它自己就是红的**，窄 glob
  `packages/*/src/**/*.ts` 下 71 个文件不合规。现在 prettier 覆盖全仓并进入门禁。
- eslint 原本只扫 `packages/*/src`。`eslint.config.js`、`vitest.config.ts`、
  `examples/mock-llm-server.mjs` 是无人区。现在 `eslint .` 覆盖 133 个文件。
- shell 脚本此前无人检查，CI 加了 shellcheck（当前 0 findings）。
- 三方版本收敛进 pnpm catalog：`zod` 原本手抄在 4 个包里。
- husky + lint-staged + commitlint。历史 60 个 commit 用新规则跑，**0 error**——
  说明 scope 白名单和既有习惯是对齐的，不是新加了一套没人遵守的规矩。

### CI：从 1 个 job 到 4 个

原来 `on: push` 不限分支 + `on: pull_request`，每个 PR commit 双跑；没有 concurrency
取消、没有 `permissions`、没有 `timeout-minutes`。现在拆成 check（node 20/24 矩阵）、
**e2e**、shellcheck、commitlint。

**e2e 是这次最大的补口**：仓库一直有 `run-demo.sh` + 内置 mock LLM 这套完整离线端到端，
但 CI 从来不跑它——一个 CLI 工具链的 CI 里没有一次真实调用。现在 analyze → generate →
render → skill → validate 全程跑完并断言产物非空。

### 覆盖率门禁，以及它顺手炸出的一个脆弱测试

实测 statements 83.27% / branches 71.44% / functions 86.33% / lines 85.91%，阈值压在
各自下方约 1 个点，形成棘轮。

插桩立刻让 `json-extract.test.ts` 的一条复杂度守卫红了：268ms > 200ms 预算。
**这不是插桩的错，是断言形式的错**——绝对墙钟预算编码的是写它那台机器的速度，在 V8 覆盖率
插桩下和在负载高的 CI runner 上都会无故变红。改成断言**增长率**：输入放大 4 倍，
线性是 ~4x、二次是 ~16x，实测 1.3–4.1x，阈值取 8x。插桩和机器速度对分子分母是同一个系数，
比值不受影响。连续 3 次插桩运行稳定通过。**意图一分没变，只是换了一种机器无关的表达。**

### 发布链路：从不存在到可用

11 个包原本全是 `private: true` + `version: 0.1.0`，没有 changeset、没有 CHANGELOG、
没有发布流水线——一个叫 `handbook` 的 CLI 没有任何人装得上。现在全部可发布
（`publishConfig.access: public`；`@handbook` scope 在 npm 上是空的，unscoped `handbook`
已被占），changesets 管版本和 changelog，Release 工作流在配 `NPM_TOKEN` 之前空转。

**`pnpm pack` 验证过**：`catalog:` → `^4.0.0`、`workspace:*` → `0.1.0`、`private` 字段消失、
tarball 内 0 个测试文件。

### 一个我造成又回滚的破坏

`prettier --write .` 把 `docs/internal/` 也格式化了，于是句中作续行的 `+ kotlin / scala…`
被 CommonMark 当成列表项、归一化成 `- ` 并插入空行，**把句子劈成两半**。已回滚，并把
`docs/internal/` 加进 `.prettierignore`：手写工程日志格式化收益为零、风险为真。
**教训：全仓格式化对代码是安全的（基于 AST），对散文不是（基于文本）。**

### 状态

`pnpm check` 全绿：961 测试 / 49 文件，工作区不变量 11 包通过，eslint 133 文件零警告，
prettier 全仓通过，覆盖率过阈值。离线 e2e 产物齐全。SP3（C/C++）的进行中改动未受影响。

## 2026-08-07：SP4–SP6 — Ruby / PHP / Swift / Dart / Solidity + Shell 升级（18 门语言，1200 测试绿）

五个 agent 并行实现，注册与 fixture 由主线统一落（五个 agent 同时改 `register.ts` 必然打架）。
现在 **18 门语言、13 门全保真**：python / typescript(+JS) / go / rust / java / csharp / cpp /
**ruby / php / swift / dart / solidity / shell**（full）+ kotlin / scala / zig / objc / ocaml（generic）。

### 两个已发布语法的运行时缺陷 —— 都靠"真实输入探针"而非 fixture 发现，都做了结构性修复

1. **tree-sitter-bash 遇到 `case` 会抛异常，并且污染 parser。**
   外部扫描器 import 了 `env.isalpha`，web-tree-sitter 解析不了。亲自复现确认：
   普通脚本 ok → 含 `case` 抛错 → **同一 parser 再解析普通脚本仍然抛错** → 换新 parser 才恢复。
   这意味着**任何仓库里只要有一个 `case`，整轮分析就崩**（不是跳过一个文件）。
   修在脊梁而非单个适配器：驱动器 catch + **丢弃被污染的 parser** + 把跳过的文件写进日志；
   shell 适配器里那个"预先双重解析"的本地补丁随之删除。**所有语言都受益。**
2. **tree-sitter-swift 在 V8 ≥ 13 上让进程致命崩溃**（`Fatal process out of memory: Zone`，
   退出码 133），一旦 wasm 被分层编译就死。亲测 Node 24 必崩、Node 21 正常、19 个语法里独此一家。
   `--liftoff-only` 可绕过，但那是启动参数，库无法替调用方决定。
   处理：**适配器在 discover 阶段明确拒绝并给出解法**，`discoverAll` 记录警告后继续——
   混合语言仓库里其他语言照常分析。测试则用 `execArgv: ['--liftoff-only']` 真跑（43 个 Swift 测试
   从"跳过 42 个"变成全部真实执行）。**进程被杀什么也不告诉用户，一条点名的跳过才有用。**

### 适配器契约加宽

`analyze()` 新增可选 logger，驱动器得以说出"哪些文件读不了"。
**静默变短的手册比承认缺口的手册更糟。**

### 各语言的关键点（以及它们自己探针抓到的 bug）

- **Ruby**：不带括号的 `foo` 解析成 `identifier` 而非 `call`（靠近似局部变量绑定表区分）；
  mixin/MRO；探针抓到自身两处错——`class << self` 里的 `attr_reader` 记成了实例方法、
  `class << self; include M` 当成 include 而非 extend。`attr_accessor` 每属性只出**一个**节点
  （否则 Rails model 的函数数翻三倍而读者无收益）。
- **PHP**：探针抓到 **`use` 导入按文件记而非按 namespace 块**——同文件两个 namespace 各
  `use` 不同的 `Tool` 会都解析到第一个。这与 C++ 那个 bug 是同一形状的变体。
  `parent::__construct()` 在父类未被扫描时给出 `boundary:<完整基类>.<成员>`（`parent` 精确
  指向唯一一个类，是事实不是猜测）。
- **Swift**：`extension` 跨文件给类型加成员（Swift 的定义性特征）；探针确认 `#if` **不会**
  破坏解析；三处语法缺陷（`#"raw"#`、宏展开、typed throws）都只**局部**降级，不像 `extern "C"`。
- **Dart**：探针抓到 `Foo<T>(...)`（恰好一个类型参数）被**静默**误解析成比较运算
  `Foo < T > (record)`，而 `hasError` 仍是 false——干净 fixture 永远看不到，但会让 Flutter
  组件树的大部分构造边消失。做了恢复。先验语法顺序无关性（lua 的教训）后才动手。
- **Solidity**：状态变量读写追踪是重点（≈ 手册的"状态寄存器"概念）；modifier 调用计为
  `self_method`（编译器内联其函数体，省略等于隐藏了外部函数最要紧的事实）。
- **Shell 升级为 full**，但只声明 3 种 callType 并**论证**了为什么：其余五种命名的是 shell
  没有的构造，`register.test.ts` 的"声明 ⊆ 产出"方向本来就禁止注水。
  `tier` 描述事实有多硬，不是能凑出几个常量。

### 验收

`tsc -b` + `tsc -p tsconfig.tests.json` + `eslint packages/ --max-warnings 0` + prettier 全通过；
**1200 测试绿**（54 文件）；文档漂移测试按设计逼我把新语言写进两份 README（先红后绿）；
真实项目端到端：Ruby（`@e.spin` → self_attr_method、`Engine.new` → internal_constructor）、
Solidity（跨文件 import + 状态变量类型驱动的调用）均正确。

**注**：`pnpm check` 当前会红在 `scripts/smoke-install.mjs` 的一个未用变量——那是并发会话
尚未提交的在写文件，不在本次提交范围内。

## 2026-08-07/08 配置登记表、脚本体系与容器镜像

规格 `docs/internal/specs/2026-08-07-config-and-scripts-design.md`，计划
`docs/internal/plans/2026-08-07-config-and-scripts.md`（12 个 Task，逐个独立 review）。

起因是三件看起来无关的抱怨——scripts 不优雅、`.env.example` 太单薄、flag 与 env 不通——
根因只有一个：没有任何地方声明"一项配置是什么"。盘点后的事实：约 45 个 flag 里**只有
`--title` 一个**同时能用环境变量设置；LLM 端点根本没有 flag；`GenerateOptions` 里六个真实
字段两头都到不了。

现在 `packages/core/src/config/` 一张登记表派生四个界面：commander 选项、解析、
`.env.example`、`docs/configuration.md`。优先级 flag > shell env > `.env` >
`handbook.config.yaml` > 默认值，每个值都记来源，`handbook config` 能打出来。
`.env.example` 从 19 行手写变成 174 行生成，漂移测试逐字节钉住。

**后来者需要知道的几件事：**
- **不要给 commander 设默认值**，也不要用 `requiredOption`。默认值一律来自 action 时的解析器；
  提前求值会在 `preAction` 应用 env 文件之前抓到 shell 的值（`render-refresh.ts` 里那条旧教训，
  该函数已被登记表取代）。必填改由解析后判定（`required` / `requiredFor`）。
- **commander 会给取反 flag 一个隐式 `true`**：注册 `--no-llm` 后，即使用户没传，`opts.llm`
  也是 `true`，于是 flag 层会永久遮蔽 env / 配置文件 / 默认值。`.default(undefined)`
  **不管用**（实测仍是 `{llm:true}`）；真正的解法是同时注册一个隐藏的正向选项。别"简化"掉它。
- **默认值一度住在三个地方**：流水线的解构默认值、`llmConfigFromValues` 里的九个字面量、
  studio `server.ts` 里的 `6`/`12`。现在只有 `PIPELINE_DEFAULTS` 与登记表。三次都是
  **未覆盖的分支**先露出马脚——那不是测试缺口，是重复的征兆。
- **`resolveLlmEnv` 不再宽容**（破坏性变更，已写进 changeset）。它按 `studio` 命令解析而不是
  `generate`：两者的 llm* 组相同，但 generate 还要求 source/work，这个函数无从提供。
- **resync 的 `--narrate-lang` 与 `--detail` 必须没有默认值**（`proseLang` / `cardDetail`）。
  给 `narrateLang` 一个 `'en'` 默认值会让中文手册 resync 之后静默改用英文行文——resync 靠
  `undefined` 回落到手册里记录的语言。已有测试钉住。
- **secret 永不进配置文件**，`loadConfigFile` 直接拒绝——那个文件是要提交的。
- **studio 的 `--host` 可配（默认 loopback），但 `isLoopbackRequest` 校验的是 `Host` 请求头**，
  不是 socket。所以容器里绑 `0.0.0.0` 之后，宿主机访问 `localhost:4860` 照样通过，用 LAN IP
  或容器名会 403——**这是正确行为，不许为了"方便"放宽那两个正则**。
- **镜像用 Node 22 不用 24**：`tree-sitter-swift` 在 V8 >= 13 上会终止进程（exit 133）。
- `pnpm config` 是 pnpm 内置命令，所以脚本叫 `config:show`。
- 脚本改名不留别名：`smoke:install`→`check:install`、`release`→`release:publish`、
  `version-packages`→`release:version`，README 里的脚本名有漂移测试兜着。
- 生成物（`.env.example`、`docs/configuration.md`、`handbook.config.example.yaml`）在
  `.prettierignore` 里——格式化器改写它们会让逐字节比对永远无法满足。改登记表后跑
  `pnpm run config:docs`，不要手改。
