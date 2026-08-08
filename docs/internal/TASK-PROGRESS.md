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

### Step 2 — README 重写 ✅ (commit 998f6b8)

- [x] 4 张手写 SVG 图：`assets/pipeline|architecture|config-cascade|outputs.svg`
      （用 headless Chrome 逐张截图目视校对过，无溢出）
- [x] 根 README.md / README.zh-CN.md 全部按实现重写
- [x] 11 个包 README × 2 语言 = 22 份全部重写
- [x] 顺手删掉误产生的垃圾文件 `ritten`，并把 CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/.github 纳入 git

### Step 3 — docs/ fumadocs 站点 ✅ (commit 90b3fe5)

- [x] 删除旧的 `handbook-deck.html`(666KB) / `handbook-deck-script.md` / `index.html`
- [x] Next.js 16 + Fumadocs 16 站点，**34 页**，构建通过，本地起服务逐页验证
- [x] 生成物 `configuration.md` 迁到 `docs/content/docs/reference/configuration.md`
      （改了 render-docs.ts 加 frontmatter + gen 脚本 + drift 测试 + .prettierignore + 两个 README）
- [x] `architecture.md`/`formats.md`/`prompts.md` 转成 MDX 进内容树
- [x] SEO：OG / Twitter card / JSON-LD ×3 / 微信·百度·搜狗·360·Naver·Pinterest /
      Apple·Microsoft / oEmbed / RSS / llms.txt + 每页 markdown 孪生 / sitemap / robots / manifest
- [x] `docs/` 独立 pnpm workspace（自带 pnpm-workspace.yaml），root install 不会拉 React/Next
- [x] `pnpm check` 全绿（1334 测试 + 覆盖率）

### Step 4 — .claude / .codex / .cursor ✅ (commit 793a989)

- [x] `.gitignore` 改为白名单式反选，共享部分入库、`settings.local.json` 仍忽略
- [x] `.claude/settings.json`：permissions(allow/deny/ask) + env + 4 个 hooks
- [x] 4 个 hook 脚本，**逐个实测过**：
      - `protect-generated.sh`（PreToolUse，拦截 3 个生成物 / dist / diagrams / lockfile，exit 2）
      - `format-touched.sh`（PostToolUse，只格式化刚改的那个文件）
      - `session-brief.sh`（SessionStart，用 `tsc -b --dry` 判断 dist 是否过期——
        mtime 方案会误报，已验证并修掉）
      - `gate-reminder.sh`（Stop，只提醒不阻断）
- [x] 3 个 subagent：adapter-author / pipeline-debugger / config-surgeon
- [x] 4 个 skill：/gate /self-handbook /diagnose-run /offline-e2e
- [x] 3 个 path-scoped rules
- [x] `CLAUDE.md`（新建）+ `AGENTS.md`（新建，Codex/Cursor 共用）
- [x] `.codex/config.toml`（**用 tomllib 校验过**，修掉了顶层 key 掉进 table 的真 bug）
      + 2 个 hook + 3 个 prompt + README
- [x] `.cursor/rules/*.mdc` × 6（1 个 alwaysApply + 5 个 globs 分域）+ README

### Step 5 — 全命令全配置测试 ✅ (commit 7ec8fa8)

- [x] `pnpm check` 全绿（1337 测试）
- [x] 新增 `scripts/smoke-cli.sh` + `pnpm check:cli`：**75 条断言**，驱动真实二进制端到端
- [x] **发现并修复 1 个真 bug**：Node ≥ 20.6 自己有 `--env-file`，会预扫描整条命令行，
      导致 `handbook --env-file <不存在的路径>` 被 node 以 exit 9 杀死，
      而这恰好是该 flag 承诺要"响亮报错"的那一种情况。
      → 新增 `HANDBOOK_ENV_FILE`（环境变量拦不住），3 个回归测试，文档 5 处更新，changeset 已加
- [x] 其余 3 个"失败"经查是我的测试写错（子串锚点 / 取了最旧的备份 / 零编辑计划本就该 exit 0），已修正断言

### Step 6 — 真实仓库实测 + 修 bug ✅ (commit 2d2a183)

拉了 **17 个真实 GitHub 仓库**到 `/Users/jack/Desktop/share/repos/`，覆盖全部 18 种语言：

| 仓库 | 语言 | 文件 | 函数 |
| --- | --- | ---: | ---: |
| requests / express / zod | py / js / ts | 37 / 141 / 407 | 691 / 141 / 1025 |
| cobra / ripgrep / gson | go / rust / java | 19 / 113 / 264 | 270 / 2937 / 2943 |
| Newtonsoft.Json / spdlog / guzzle | c# / c++ / php | 943 / 154 / 132 | 7255 / 1096 / 2737 |
| sinatra / okio / scopt | ruby / kotlin / scala | 150 / 359 / 29 | 802 / 3736 / 320 |
| AFNetworking / Alamofire / openzeppelin | objc / swift / solidity | 80 / 6 / 712 | 717 / 6 / 3382 |
| nvm / flutter-packages | shell / dart(多语言) | 6 / **4937** | 0 / **71039** |

**发现并修复 4 个真 bug（全部有回归测试，且验证过"去掉修复就会挂"）**：

1. **WASM 树泄漏 → 硬崩溃**（`spine.ts`）。flutter/packages 4937 文件跑到 90% 时挂：
   `RuntimeError: table index is out of bounds at ts_parser_new_wasm`。
   根因：解析树在共享 WASM 实例里占内存，GC 收不掉。
   **专门做了对照实验**：只放 parser 不放 tree → 仍崩；放 tree → 好。注释里写的是实测结论。
   树必须在 pass 2 之后才放（`extractCalls` 要走里面的 node），否则是"悄悄给错事实"。
   修复后该仓库跑通：4937 文件 / 71039 函数 / 321803 边 / 32 秒。
2. **JS 赋值式函数定义全部看不见**（`typescript.ts`）。`res.send = function(){}`、
   `exports.f = `、`module.exports.f = `、`X.prototype.f = `、对象字面量方法——
   Express 的整个公开 API 都是这么写的：lib/ 里 ~78 个函数只认出 11 个，
   response.js 的 22 个方法只认出 2 个。修复后 express：55→141 函数，8→76 边。
   **叫不出名字的坚决不猜**：`lookup[key] = fn`、`factory().f = fn` 仍然跳过。
3. **Shell 的诚实度问题**。nvm 6 个文件 122 个函数**全部**被跳过（bash 语法遇 `case` 抛异常）。
   原来文档只说"含 case 的脚本会被跳过"，实际等于"大多数真实脚本"。
   运行时警告现在点名原因，文档改为"Shell 覆盖按部分覆盖看待"。
4. **mock LLM 截断带空格的路径**（`examples/mock-llm-server.mjs`）。
   `\S+` 在第一个空格处停下 → AFNetworking 报 62/80 覆盖率，
   是 mock 在污蔑工具。改成按双空格分隔符捕获后 80/80。

**全流程（generate→render→skill→validate）在 17 个仓库上跑通**，卡片覆盖率 100%，
未归属文件 0，SKILL 校验全 OK。

### Step 7 — 5 轮对抗 ✅

每一轮都**先验证再下结论**——本轮有 3 次"疑似发现"最后证明是我的测量方法错了，全部作废而不是当成 bug 上报。

**R1 文档断言 vs 实现**
- ✅ 11 个子命令全部存在；61 个被文档化的 flag 全部真实存在；62 个真实 flag 全部有文档（双向核对）
- ✅ docs 站点 35 页，内部链接 0 断裂；引用的图全部存在
- ❌ **真 bug：22 个包 README 里 16 条断链**（我把 architecture/formats/prompts 迁进内容树后没跟着改）。
  根 README 有守卫测试，包 README 没有 → **已修 + 新增守卫测试**（并验证"故意打断就会挂"）

**R2 数字断言 vs 实测**
- ✅ "18 种语言" = 实测 18；"11 个包" = 实测 11
- ❌ **真问题：徽章写死 `tests-1334`，实际 1367**；`75 assertions`、OG 图里的 `1334 tests` 同类。
  写死的数字是"没人能维持为真"的断言 → 全部改成不会腐烂的表述（`tests-offline, no API key`）

**R3 agent 配置对抗**
- ✅ 空输入/非 JSON/null/超长路径/`../../../etc/passwd` 喂给 4 个 hook，退出码全在 {0,1,2}，无崩溃
- ✅ 6 个生成物全部拦截；5 个普通文件全部放行；相对路径与绝对路径行为一致
- ✅ settings.json / config.toml / 6 个 .mdc / 3 个 agent / 4 个 skill 的 frontmatter 全部合法
- 无缺陷

**R4 SEO 与站点实测**（起真实服务器抓 HTML）
- ✅ 25 个 head 断言中 23 个直接命中；`itemProp`/`hrefLang` 是 React 的驼峰输出，
  HTML5 属性名大小写不敏感，**核实后判定非缺陷**
- ✅ og:image / og:url / twitter:image / canonical 全为绝对 URL；JSON-LD 合法且含 3 个 @type
- ✅ sitemap 35 条全绝对、robots 含 GPTBot、rss 34 条格式正确、llms.txt / llms-full.txt(280KB)
  / oembed / manifest / 每页 markdown 孪生 全部 200
- ❌ **真问题：每页 OG 卡片用的是框架默认模板**，紫粉配色和站点品牌完全不搭，
  分享出去像两个产品 → **已重写为品牌配色**，颜色从 `lib/shared` 读取，不会再漂移

**R5 安全不变量对抗**
- ✅ Studio Host 头守卫：raw HTTP 实测 9 种 Host，含 `localhost.evil.com`、`localhost:4901.evil.com`
  两种伪装，全部正确（**注意：用 fetch 测是无效的，Node 会忽略自定义 Host 头——我第一次就踩了这个坑**）
- ✅ 非 JSON 的 POST → 415；三种路径穿越 → 404
- ✅ 带金丝雀值的 API Key：所有产物 + 所有渲染输出中出现 0 次
- ✅ 渲染输出中不含任何本机绝对路径
- ✅ 经软链接父目录创建 → 拒绝且未落盘；替换软链接目标 → 拒绝且目标未变
- ✅ 同一 work dir 并发 generate → 第二个被拒，错误信息含 pid/主机/时间/补救办法
- ✅ 运行中 SIGINT → 退出码 130、**不写 run manifest**、已完成产物保留、下次 `--resume` 能恢复
- ✅ 损坏的 graph.json → 响亮报错并指名文件
- 无缺陷（3 次疑似全部证伪：两次是 fixture 跑太快、一次是 fetch 忽略 Host 头）

### Step 6 补做 —— 真正去「读」生成物（此前只验了结构） ✅ (commit f826265)

被问到「全部完成了吗」时，诚实的答案是：Step 6 我只验证了**结构**覆盖率
（17 仓库 100% 卡片、0 未归属），**没有真的去读生成的两份文档**。补做后又找出 1 个真 bug：

5. **`organization.nFunctions` 恒为 0**（`organize.ts`）。它读的是 `card.functions`，
   而这个数组**只有 deep 卡片才有** → 默认 `--detail brief` 下每个文件都是 0。
   实测：17 个仓库全部 8489 个文件都是 0，而调用图知道光 gson 就有 3123 个函数。
   **后果不是数字难看**：agent 定位索引把「函数数最多的文件」选为该组范本，
   且只在存在时才输出该字段 → **Exemplar 字段在渲染过的每一页上都消失了（实测 0/156）**，
   每个核心文件后面都印着 `(0 fns)`。graph 一直就在 `organize.ts` 作用域里，只是问错了地方。
   修复后 gson：exemplar 0/7 → **7/7**，函数数最高 161。合成节点被排除（源码里不存在的隐式构造函数）。

同时修正一处**夸大**：`co-change hints` 被列为 agent 索引的头牌字段之一，
但它只在「测试文件与源文件并排」时触发——17 个仓库总共只有 **3 对**
（Go 直接不扫 `_test.go`，Maven / pytest / `__tests__` 布局都是分离目录树）。
门控本身是对的，是文案把它卖成了常见字段。已改为如实描述。

本轮又有 2 次误报被证伪后作废：字段普查用错了标签字符串（`**Exemplars**` vs `**Exemplar**`），
以及在怪 `strongTwins` 之前先单独验证了它是对的。

## 真实端点质量评估 ✅ (commit a17e30a)

用户批准花 token 后，对 6 个仓库（py/java/js/ts/rust/go）跑了真实 GLM-5.2 生成。

**先修了一个环境问题**：`open.bigmodel.cn` 有多条 A 记录，本机 OS 解析器**总是**返回
死掉的那条（39.108.52.113），而直连 DNS 查到的 60.205.172.105 是通的。
所以 `fetch` 每次都打到死 IP，重试再多也没用。
**这不是代码 bug**——工具的表现完全正确：重试、降级为空卡片、然后**拒绝产出手册**并指明可能原因。
用一个本地 `--import` DNS shim 绕过（不进仓库，只在本机跑）。

**结果（5/6 完成，zod 仍在跑）**：

| 仓库 | 卡片覆盖 | 未归属 | 寄存器 | 调用 | 失败 | token |
| --- | --- | --- | --- | --- | --- | --- |
| requests (py) | 37/37 | 4 | 24 | 69 | **0** | 287k |
| gson (java) | 264/264 | 3 | 15 | 322 | **0** | 1178k |
| express (js) | 141/141 | 2 | 5 | 174 | **0** | 318k |
| ripgrep (rust) | 113/113 | 1 | 73 | 174 | **0** | 1052k |
| cobra (go) | 19/19 | 0 | 15 | 41 | **0** | 133k |

**780 次 LLM 调用，0 次失败，卡片覆盖率 100%。**

**质量核查（逐字对照源码）**：
- cobra `args.go`：11 个函数全部找到，**行号全部精确**，`ExactValidArgs` 被正确标注为
  deprecated（源码第 141 行确实有 `// Deprecated:`），工厂函数与直接函数被正确区分。
- gson `JsonReader.java`：47 个函数全部捕获，`JsonReader(Reader)` L314、`isLenient` L344
  逐行核对无误。
- 系统总览：cobra 被正确识别为「CLI 框架 + shell 补全引擎」并复述了正确的生命周期；
  gson 的「翻译引擎 / 智能配电盘 / 传送带」比喻准确且好读。
- **结论：结构性事实零错误**（因为它们来自解析器，不是模型），散文准确且可读。

**发现并修复第 6 个真 bug**：**寄存器只涉及 1 个阶段**。
寄存器按定义是「跨阶段状态」，`register.md` 就叫 cross-stage state，
它唯一的用途是回答「这次改动会波及哪些阶段」。实测：
ripgrep 73 个里 **34 个（47%）** 只有 1 个阶段，cobra 27%，requests 25%。
**根因是提示词自己在教错的**：它要求跨阶段状态，但它自己的示例写的是 `"stages": ["stage-5"]`，
补全轮还明说「每个选 1-5 个」。三处全改，并且**在代码里强制**（<2 个阶段直接丢弃并记日志）——
提示词是请求，代码才是保证。5 个既有测试用的是 1 阶段 fixture（它们其实在测 id 归一化 /
字段名容错 / 缓存复用），已改成 2 阶段，各自继续测它本来要测的东西。

## docs 站点多语言 ✅ (commit a17e30a)

按全球开发者人口排序的 **8 种语言**：English / 简体中文 / हिन्दी / Español /
Português / Русский / 日本語 / Deutsch。**358 个页面构建通过。**

- 英文保留原来的 `/docs` 裸路径（不破坏任何既有链接与搜索结果），`/en/docs` 307 跳回 `/docs`
- 每个 locale 独立 canonical、`og:locale`、完整 hreflang + x-default，
  **且只由一个生产者输出**——重复的 hreflang 是互相冲突的信号，不是无害的重复
- 未翻译的页面**回退英文原文并用读者的语言说明这一点**；判断依据是解析到的**文件**
  （`page.locale` 永远等于请求的 locale，无法用来判断）
- 站点自身 chrome（搜索、目录、主题、语言菜单、导航）8 种语言全部翻译

**仍待做**：35 个内容页 × 7 个语言的正文翻译（基础设施已就绪，页面会诚实地显示"尚未翻译"）。

## 真浏览器测试 docs 站点

用 CDP（Chrome DevTools Protocol over WebSocket）直连真实 Chrome，不是 jsdom。

### Bug #7（真 bug，已修）：英文页每一页都 hydration mismatch，且 SSR 内容是错的

**现象**：真 Chrome 打开生产构建，`/docs/*` 每一页都抛 `Minified React error #418`
（hydration mismatch）。`/`、`/zh`、`/zh/docs`、`/ja|hi|es|pt|ru|de/docs` 全部干净。
`next dev` 下完全复现不了——只有生产预渲染才有。

**定位过程**（字符级 diff 没用，被 DOCTYPE 和 next-themes 加的 `class="dark"` 淹没）：
改成抽**文本节点**做 diff，立刻看出 SSR 的侧边栏比 DOM 少一截——
SSR `data-state="open"` = **0** 个、侧边栏只有 6 个链接；中文页 3 个 / 12+ 个。

**根因**：`hideLocale: 'default-locale'` 让 fumadocs 的 middleware 把 `/docs/x`
**rewrite** 成 `/en/docs/x`。rewrite 对浏览器不可见，但对渲染器可见：预渲染时路由
真的是 `/en/docs/x`，所以 `usePathname()` 返回 `/en/docs/x`；浏览器里返回 `/docs/x`。
而 fumadocs 内部**所有**消费者（`contexts/tree.tsx` 的 `searchPath`、侧边栏
`isLinkItemActive`、页脚 prev/next）都拿这个 pathname 去比 page-tree 里的
**公开 url**（`/docs/x`）。于是服务端一个都匹配不上：
**英文页预渲染出来就是没有高亮项、所有目录折叠、没有上/下一页** —— 这不只是警告，
是实打实的内容错误；浏览器接手后重算才对，React 就报 #418。

**修法**：`docs/components/provider.tsx` —— 在 fumadocs 唯一提供的接缝
（`FrameworkProvider`）上把 pathname 规范化成公开路径，两侧读到同一个值。
对带前缀的 locale 是 no-op，`hideLocale` 一旦不是 `default-locale` 整体 no-op。
不能用嵌套 `FrameworkProvider` 复用外层的 `Link`（framework 导出的 `Link` 读的是
最近一层 context，会自己套自己无限递归），所以给 `next/link`、`next/image` 写了
两个薄适配器（fumadocs 的 `href`/`src` 可选，Next 的必填）。

**验证**：英文页 SSR 现在和中文页逐项一致（3 个 open / 12+ 链接）；
21 个页面（8 语言 + 404）真 Chrome 加载，**0 console error、0 失败请求**。

## 最终验收

- `pnpm check` 全绿（typecheck / workspace 不变量 / eslint 0 告警 / prettier / 覆盖率下限）
- `pnpm check:cli` **75/75**
- `pnpm demo` 全流程通过
- docs 站点构建通过（113 条路由）
- 17 个真实仓库 analyze + 全流程通过

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
