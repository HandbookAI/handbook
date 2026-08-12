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

### Bug #8（真 bug，用户报的，已修）：`127.0.0.1:3000` 上文档站四个功能全死

**用户现象**：搜索、切换语言、切换主题、左侧菜单收起——**全都点不动**。

**根因**：`next dev` 绑定了所有本地地址，但只把 `localhost` 当成自己的 origin，
其它一律拒发 `/_next/*` 开发资源：

    ⚠ Blocked cross-origin request to Next.js dev resource
      /_next/static/chunks/…_dialog_search-default_….js from "127.0.0.1".

于是 SSR 的 HTML 完美渲染、**每一个 JS chunk 都 403**。搜索/主题/语言/侧边栏收起
全是 client component，一个都没 hydrate，所以全都不响应。这也解释了为什么
"页面看起来完全正常，但什么都点不动"。

**修法**：`docs/next.config.mjs` 的 `allowedDevOrigins` 声明回环地址与内网段。
这不增加任何可达范围（这些地址本来就能连到 dev server），只是不再把同一个 origin
换个写法就拒掉。`next build`/`next start` 不受影响。

**顺带修掉的第二个真 bug**：`docs/proxy.ts` 的 matcher 只排除了 `_next/static`
和 `_next/image`，没排除 `_next` 本身，于是它接管了 `/_next/hmr`——i18n 中间件把
热更新 socket 重写成 `/en/_next/hmr`，每次加载都握手失败。现在整个 `_next` 全排除。

**验证**：真 Chrome 跑 `scripts/browser/docs-site.mjs`，dev 与生产构建都 15/15；
把 `allowedDevOrigins` 删掉再跑 → 立刻 5 条失败（403 chunks / 搜索打不开 /
主题不变 / 语言菜单空 / 侧边栏不收），退出码 1。**这个套件确实能抓住它。**

## 生成物 HTML 的 UI 重做（renderer）

`packages/renderer/src/html.ts` + 新增 `html-assets.ts`。零依赖、全内联、
`file://` 直接打开——所以不能真的用 fumadocs（它要 Node + 构建），而是把那套视觉
语言手写出来：

- 三栏：侧边栏（阶段树 + 层级编号 1 / 3.1）｜正文（限制行宽）｜右侧本页目录（滚动高亮）
- **⌘K 搜索**：阶段/文件/函数/状态寄存器全索引（ripgrep 3144 条）。多页站点写成
  兄弟文件 `search-index.js`（`<script src>` 是 `file://` 下唯一还能用的加载方式，
  fetch/import 都会被不透明 origin 挡掉）；单页版内联同一份索引
- 命中的文件/函数在折叠的 `<details>` 里 → `hbReveal()` 沿祖先逐层展开再滚过去
- 主题三态（跟随系统/浅/深）+ 无闪烁预涂 + 持久化
- 上一页/下一页、标题锚点、代码块复制、回到顶部、移动端抽屉、打印样式
- 修掉一个内容 bug：`lifecycle` 本该是 "startup" 这种短提示，模型经常回一整句，
  以前会被塞进一个和整行一样宽的 pill；现在超过 24 字符就降级成正文里的标注行
- 搜索结果用 `createElement`+`textContent` 构建，**绝不 innerHTML**——标签内容是
  模型写的散文和文件路径，用 innerHTML 等于把服务端刚escape掉的注入又放回来

**验证**：`scripts/browser/handbook-html.mjs` 真 Chrome 跑 `file://`，
demo fixture 与 ripgrep 各 **32/32**。

## GitHub CI 深度优化

补掉三个真实缺口（都是"坏了 CI 也不会红"的）：

1. **`docs/` 从来没被 CI 构建过**。它是独立 pnpm workspace + 独立 lockfile，
   root `pnpm install` 看不见它，`pnpm check` 一行都不编译。新增 `docs` job：
   frozen-lockfile 安装 → typecheck → build → `next start` → 真浏览器测四个功能。
2. **`pnpm check:cli` 根本没进 CI**（`check:all` 里有，CI 只跑 `check`）。新增 `cli` job。
3. **shellcheck 只覆盖 `examples/*.sh`**，`scripts/smoke-cli.sh` 和 6 个 agent hook
   全没 lint。改成 `git ls-files '*.sh'` 全量——手写清单第一次有人加脚本就过期了，
   而且是静默过期。为此把所有告警都真正修掉（不是加 disable）：
   - `format-touched.sh`：`case` 里有永远匹配不到的死分支（SC2221/2222）
   - `smoke-cli.sh`：`cd` 未防失败、`local` 掩盖返回值、`$HB` 靠分词——改成数组
     （4 处在 `env` 后面，shell 函数在那里用不了）、`A && B || C` 改成真 if/else
   - 改完 `pnpm check:cli` 仍是 **75/75**，并单独验证了新助手 `grep_ok` 四个分支都对

其他：`workflow_dispatch`、`persist-credentials: false`、Next 构建缓存、
dependabot 补 `/docs`（它的 lockfile 之前永远不会被更新）、
新增 `ci-ok` 汇总 job 供分支保护使用（matrix 一改，逐个 job 的保护规则就会静默失效）。

## 五语言仓库 × 静态/LLM 双路径验证（新 UI 渲染器）

java=gson / js=express / ts=zod / python=requests / go=cobra，每个仓库两条路径：

- **LLM 路径**：`work-real/<repo>`（真实端点生成的 phase 产物）用新渲染器重渲
- **静态路径**：`work-mock/<repo>`，用 `examples/mock-llm-server.mjs` 全离线重新
  generate + render（mock 的 overview 会诚实声明自己是占位散文，结构是真的）

结果（`scripts/browser/handbook-html.mjs`，真 Chrome，`file://`）：

| 仓库 | REAL | MOCK |
|---|---|---|
| gson (java) | 32/32 | 32/32 |
| express (js) | 32/32 | 32/32 |
| zod (ts) | 32/32 | 32/32 |
| requests (py) | 32/32 | 32/32 |
| cobra (go) | 32/32 | 32/32 |

内容级检查：5 个 REAL 手册卡片覆盖率全部 **100%**（264/141/407/37/19 个文件，
0 missing）；10 份输出 × 全部页面 **0 死链、0 空描述占位**。截图目检 gson 总览、
requests 阶段页、express mock 总览——排版、编号、芯片、目录高亮均正常。

## 大工单（2026-08-09，进行中）：Studio 全配置 + 全站翻译 + README 重做

用户要求：① Studio 覆盖**全部**配置项 + 和 docs 一样的 8 语言；② docs 内容页全量翻译
（7 语种 × 34 页）+ 图（assets/*.svg）也要多语言；③ 消灭 docs 报错；④ README 重写出
冲击力，讲清「一份给人读、一份给 AI 用」的双产物故事（docs 站同样要讲清），5 轮对抗。

### 已完成
- docs JSON-LD 控制台报错根治：`lib/seo.tsx` 的 `<script>` 改为 body 里
  `<div hidden dangerouslySetInnerHTML>` 注入（innerHTML 的 script 天生惰性，
  React 不再告警，爬虫照读；`<` 转义 <）。layout.tsx 已挂 `<StructuredData />`。
- 全站 272 页 × 8 locale HTTP 全 200；dev 日志无错误。
- Studio 差距报告（gap report）完成：42 项配置不可达；render/skill/validate 无端点；
  generate 有 6 参数被验证后丢弃；llmCache 从不生效；`server.ts:608` resync 描述
  语言 bug（英文 UI 恒中文）；backupRoot 与 CLI 不一致（work/patches vs
  source/.handbook-patches）；jobs.ts logger 硬编码丢 debug。
- 翻译落盘：ru/pt A 批完整（14 文件）；zh/es 缺 2 页（trust-model、work-directory）；
  hi/de 缺 4 页（+analysis-fidelity、pipeline）；ja 缺 8 页。SVG：pipeline 7 语种全有；
  architecture 有 zh/de/hi；config-cascade、outputs 全缺。

### 翻译精确断点（2026-08-09 05:xx，wave 2 被 session limit 杀掉后的落盘状态）

- **A 批（index+入门+概念，14 文件/语种）：7 语种全部完成 ✅**
- **SVG 4 图 × 7 语种 = 28 张全部完成 ✅**（assets/*.{loc}.svg）
- **B 批 guides（12 mdx + meta.json/语种）已落盘：**
  - zh 有 6：agent-skill、configuration、generating、meta、planning-changes、rendering
    → 还缺：applying-changes、keeping-current、ci、docker、studio、cost-and-performance、troubleshooting
  - es 有 11 → 还缺：applying-changes、troubleshooting
  - pt 有 7：agent-skill、applying-changes、configuration、generating、meta、planning-changes、rendering
    → 还缺：keeping-current、ci、docker、studio、cost-and-performance、troubleshooting
  - de 有 5：agent-skill、configuration、generating、meta、rendering
    → 还缺：planning-changes、applying-changes、keeping-current、ci、docker、studio、cost-and-performance、troubleshooting
  - ru 有 1（generating）→ 还缺 11 + meta
  - ja 有 1（generating）→ 还缺 11 + meta
  - hi 有 0 → 全缺（12 + meta）
- **C 批 reference（8）+ contributing（3）+ 2 个 meta：7 语种全部未开始**

### 进度更新（同日晚些时候）
- Studio 服务端 + UI 全部完成并提交（6b49cd2）：registry 驱动表单、render/skill/validate、
  8 语言选择器、per-locale 词典文件 /i18n.<loc>.js（en/zh 已全，hi/es/pt/ru/ja/de 由
  agent 在写）。59 studio 测试绿，全仓 1391 绿。
- README ×2 重做为「两本手册」故事并提交（50ecab5）；docs 首页 8 语种 hero 同步（52206c2）。
- guides：hi/ru/ja 完成；zh 缺 7、es 缺 2、pt 缺 6、de 缺 8 —— wave 3 agent 在补。
- 28 个翻译页已改指 /diagrams/<name>.<loc>.svg；docs build 358/358 绿。
- CJK 搜索实测可用（zh 配置/骨架、ja ステージ、ru этап 都有正确命中）；
  回退横幅只在未翻译页出现（验证过正反两向）。

### 精确断点（wave 3 被 session limit 掐断后，已提交到 git 的状态）

**guides（12 mdx + meta.json，共 13/语种）：**
- hi / es / ru / ja / de：**13/13 完成 ✅**
- zh：12/13 —— 只缺 `applying-changes.zh.mdx`
- pt：8/13 —— 缺 `ci` `docker` `studio` `cost-and-performance` `troubleshooting`（各 .pt.mdx）

**Studio UI 词典 `packages/studio/public/i18n.<loc>.js`：**
- en / zh / es 已落盘（es 已验证 320 个叶子键与 en 完全一致 ✅）
- 缺：hi / pt / ru / ja / de（缺失时服务端返回 no-op，UI 自动回退英文，不会坏）
- 做法：读 i18n.en.js，同结构翻译 values，用
  `new Function('window', code)` 加载后递归比对叶子键集合必须与 en 相同

**C 批完全未开始**：`content/docs/reference/`（artifacts、cli、configuration.md、
environment、exit-codes、languages、packages、prompts）+ `contributing/`
（adding-a-language、development、releasing）+ 两个 meta.json，× 7 语种。
注意 cli.mdx 21KB、configuration.md 23KB，单语种建议拆 2 个 agent。

**注意**：`reference/configuration.md` 是 registry 生成物，翻译副本
`configuration.<loc>.md` 不受 drift 测试约束（测试只比对英文原件），可以安全翻译。

### 状态更新（2026-08-09 下午）—— A/B 批与 Studio 全部完成 ✅

- **guides 12 页 + meta：7 语种全部 13/13 完成 ✅**
- **Studio 8 语种词典全部完成 ✅**，每个都用「加载后递归比对叶子键」验证过
  与 en 完全一致（320 个键 × 8）。真浏览器逐语种切换验证 14/14 通过，
  八种语言确实是八种不同文案（不是回退英文）。
- **`pnpm check` 全绿**；docs build 358/358。
- 浏览器套件现有三个，全部进了 CI：`docs-site.mjs`、`handbook-html.mjs`、
  新增 `studio-ui.mjs`（CI 的 demo job 里起一个真 studio 再跑）。

### 对抗第 1 轮（针对 Studio 新端点）—— 已完成，2 个真 bug 已修

1. **render/skill/plan/analyze 不做前置校验**：generate/resync 有，这四个没有，
   于是 `{"html":"yes-please"}` 返回 202，几秒后才在抽屉里变成失败 job。
   已加 `preflight()` 统一走 resolveConfig，坏输入现在是 400。
2. **`lang` 无法被解析器校验**（`dynamicChoices`，合法集合要注册适配器后才存在）：
   未知语言一路走到分析器，返回空分析——读起来像「你的仓库没有代码」。
   preflight 里改成对活的适配器注册表校验。
3. **假警报**：CSRF 守卫看似失效——其实是探针用 `fetch` 设 `Host` 头，
   而 `fetch` 会静默丢弃它（本会话第二次踩这个坑）。改用 `node:http` 重测，
   所有路由（含两个新路由）非回环 Host 一律 403、回环 200。全部加了回归测试。

### C 批状态（reference 9 + contributing 4 = 13/语种）

- **zh / ja / es / pt / ru：13/13 完成 ✅**
- **de：1/13**（只有 reference 一个文件）—— 缺 reference 8 + contributing 4
- **hi：0/13** —— 全缺

共 216 个翻译页在库。补 de/hi 时用同样的 prompt 模板（见上文 C 批那段），
注意 `cli.mdx` 21KB、`configuration.md` 23KB 要单独处理、不能截断。

### 对抗轮次

- **第 1 轮（Studio 新端点）✅** —— 2 个真 bug 已修（前置校验、lang 动态枚举），
  1 个假警报（`fetch` 丢 Host 头）。回归测试已加，61 studio 测试绿。
- **第 2 轮（Studio 八语言 UI）✅** —— 真 Chrome 逐语种切换 14/14；
  八种语言确认是八种不同文案而非回退英文。套件已入库 `scripts/browser/studio-ui.mjs`
  并接入 CI。
- **第 3 轮（翻译完整性）✅** —— 新增 `docs/scripts/check-translations.mjs`：
  逐页比对代码块数量与**内容字节**、每种 JSX 组件计数、所有链接目标、frontmatter 键。
  215 页全过。**并用「故意破坏 4 种」验证过它不是空测试**——
  第一次验证时选了个没有 JSX 也没有链接的页面，两个变异是空操作，
  差点把假绿当成证据。
- 还发现并修掉一个英文源 bug：环境变量别名表写「Five settings」而表里有 6 行
  （注册表 ground truth 也是 6），5 个已翻译语种一并修正。

### 全部完成 ✅（2026-08-09）

**翻译**：7 语种 × 34 页 = **237 个翻译页全部完成**，全部通过结构校验。
4 张图 × 7 语种 = 28 张本地化 SVG。Studio 词典 8 语种 × 320 键全部一致。

**对抗第 4 轮（逐语种真浏览器渲染）** ✅ 21/21
- 8 语种 × 6 页 = 48 次真实加载，0 console error，侧边栏/图片/横幅全部正确。
- 真 bug：印地语 5 个页面标题仍是英文——是我 prompt 的锅（把「术语保留英文」
  的规则错误地套到了页面标题上；标题是导航，印地语读者扫侧边栏该看到印地语）。
  已修；Docker 作为产品名保留，与 zh/ru/ja 一致。
- **2 个探测器 bug**（会变成假信心）：横幅检测用文本匹配，把 pipeline 页对比表里的
  "aún no"/"ainda não"/"ещё не" 当成了回退横幅（3 个幽灵告警）——改成结构检测；
  ASCII 标题检测没有产品名白名单。

**对抗第 5 轮（配置端到端真的到达 pipeline 了吗）** ✅ 12/12
- 真起 studio + mock LLM，一次 generate 带上全部 6 个曾被丢弃的参数 + llmCache，
  再 render(llms.txt) → skill → validate 全链路。
- **llmCache 确认真的写了缓存**（demo 项目 21 条 / harness 10 条）——这是「job 变绿」
  永远证明不了的部分。
- **3 个失败全是探针写错**，都值得记下来：① 缓存查错了目录（studio 按证据
  **收养**了已有 work dir，这是有意行为）；② `repo.title` 在状态响应里是**渲染出的
  标题**、不是存储的条目（两个都该断言，分开断言）；③ `logLevel: debug` 没有 debug
  行——因为整个 workspace 只有 analyzer 一处 `.debug()` 调用点。通道现在是通的
  （jobs.ts 原来硬编码成 no-op），但 generate 目前无话可说，所以断言管道而不是
  断言不存在的输出。

**最终验收**：`pnpm check` 绿（64 文件 / 1394 测试）、prettier 全绿、
docs build 358/358、三个浏览器套件全绿（docs-site 15/15、handbook-html 32/32、
studio-ui 14/14）。

## 用户报的三件事（2026-08-09 晚）

### 1. critic 把 REVISE 当成不可解析 —— 真 bug，已修 ✅

用户日志里三个 critic 全部 `unparseable verdict (keys: decision, concerns,
suggested_revision, rationale) — treating as REJECT`，然后
`[doctor] round 1/2: applied=0 rejected=0 unassigned=33` → `stuck`。

**根因**：`parseVerdict` 里 `if (suggested !== null && typeof suggested !== 'object')
return undefined;` —— 模型经常把 `suggested_revision` 写成一句散文，于是**整条裁决被丢弃**。
而文档写着「读不出来的裁决算 REJECT」，所以合议庭永远不通过 → `runDoctorRound`
在 `!result.accepted` 时直接返回全零 → 和用户看到的 `applied=0 rejected=0` 完全吻合。
**doctor 模式只要模型用句子写建议就是废的。**

**修法**：裁决保留，不可用的 revision 丢掉，散文**折进 concerns**（不丢信息）。
数组同样处理——`typeof [] === 'object'` 以前会让它混过去，但 actor 根本没法应用。
另有一条既有断言正好要求旧行为，那条断言本身就是 bug，已改成相反并写明原因。

### 2. 点击校验技能报错 —— 真 bug，已修 ✅

Validate 按钮只按「有没有 handbook」置灰，但它消费的是 **SKILL 包**。
生成了手册但没打包就点，必然吃 409。现在 `repoStatus` 报 `outputs.skill`，
按钮按它置灰并带提示（8 语言都有）。

### 3. 叙述语言只有 en/zh —— 进行中 🚧

**已完成**：
- `packages/core/src/model.ts`：`NARRATE_LANGUAGES` 8 语言表（code/english/native）
  + `narrateLanguage()` + `languageDirective()`。`NARRATE_LANGS` 由它派生。
- 注册表的 `narrateLang`/`bodyLang`/`proseLang` 本来就引用 `NARRATE_LANGS`，
  **自动变成 8 选项**，无需改注册表。
- `packages/pipeline/src/prompt-lang.ts`（新）：`rulesFor(lang, en, zh)` /
  `closingLine(...)`。**设计取舍**：规则块是给模型的指令、读者永远看不到，
  所以不必逐语言翻译；en/zh 保留既有手写块，其余语言用英文块 + 明确的输出语言指令。
  加第 9 种语言 = 表里加一行，而不是再写 6 份 prompt。
- pipeline 的 6 处语言分支（cards / narrate ×4 / organize / skeleton）已全部改走它。

**待完成**：
- 6 个 `Record<NarrateLang, …>` 标签表要补 6 种语言（agent 在做）：
  renderer 的 html.ts / markdown.ts / file-card.ts / agent-site.ts / llms-txt.ts
  + skill/build.ts。**故意让它变成编译错误**——缺翻译必须是编译失败，
  而不是日语手册里冒出英文标签。
- 标签表补完后必须 `pnpm run config:docs` 重新生成三个生成物（现在因编译错误跑不了）。
- 然后 `pnpm check` + `pnpm check:cli`。

## 真实端点实测 + 防护审计（2026-08-09 晚）

真实端点：GLM-5.2（`.env` 里的 `open.bigmodel.cn`），2.3s 往返，可用。

### 实测抓到了 mock 抓不到的真 bug ⚠️

**语言守卫 layer 3 只救回 1/4**。原因是结构性的：重试把纠正**追加在原 prompt 之后**，
而原 prompt 里的一切（指令、英文代码样例、英文字段名）都在跟纠正竞争；而且"重新推导答案"
本身就是更难的任务，模型有更多机会再次漂移。
**改法**：让它**翻译自己刚产出的文本**，原 prompt 完全不重发。翻译是模型可靠擅长的任务，
且没有冲突。改后 4/4 → 全语种 7/7。
**教训**：mock 客户端只会返回被脚本设定的字符串，它证明了管道，永远证明不了 prompt 有效。

### 深度防护审计（逐包，agent 出的报告）

已修的 HIGH：
- **H4 安全**：Studio 允许请求体覆盖 `llmBaseUrl` → 把每条 prompt 和**服务器的 API key**
  发到任意主机。拒绝 key 进来、却允许 key 被指向别处，等于没拒绝。现已连同
  `OPENAI_BASE_URL` 一起在 body 层拒收。
- **H10**：`config --check --command <拼错>` 打印 `config: OK` 退出 0——未知命令让
  `settingsFor` 返回空列表，所有检查真空通过。CI 里唯一的配置守门员什么都没校验，还是绿的。
- **H11**：`handbook rollback` 永远 exit 0，哪怕一个文件都没恢复。
- **M22**：每个 int 只有下限没有上限，`--read-workers 1000000000` 能解析通过，
  并让并发限制器变成空操作。14 个设置加了上限。

端口（用户问）：`--port` 一直有，但被占用只给一句裸的 `listen EADDRINUSE`。
现在两种常见原因都指出路，EACCES 解释 <1024 的情况，**`--port 0` 自动取空闲端口**，
且 URL 从 socket 读回而不是回显请求（否则 `--port 0` 会打印 `http://127.0.0.1:0`）。

### 非 OpenAI 兼容端点（用户问）

`ChatClient` 一直是接缝，但只有一个实现，CLI/Studio 都写死。现在 provider 只提供三样：
URL+头、请求体、响应解析；**重试/超时/取消/永久错误分类/网关页识别/token 预算学习/用量计量
全部共享**——那才是 bug 所在，每个 provider 复制一份就是三个不同的重试 bug。

**用真实 HTTP 服务器测线格式**（不是 mock 对象）：Anthropic 的 `x-api-key`（非 bearer）、
强制版本头、content blocks、**只读 text block**（thinking 草稿绝不能进手册）；
Gemini 的 model 在路径里、key 在**头**里（query string 会被沿途每个代理记录）、
usageMetadata 计量；十种畸形响应必须失败而非返回 `''`；Gemini 安全拒答算失败不算答案；
非数字 usage 记为 0 而不是 NaN。最后两条证明 provider 会**自动继承**共享的
503 重试与 401 不重试。

### 审计报告 HIGH 项：全部已修

- H1/H2 ✅ 冲突裸名进 `ambiguousTypes`，三处消费点一律 `unresolvedOf(...)`（`spine.ts`）。
- H3/H7 ⏳ 后台 agent 在做（未分配文件在 8 语言渲染里披露；`unparsedFiles` → `scan-coverage.json`）。
- H5 ✅ 收不到 signal 的 job 不再接受 cancel。
- H8 ✅ 语言守卫已接进 pipeline，真实端点 7/7 恢复。
- H9 ✅ `skill --out` 拒绝"非空且无 SKILL.md"的目录。
- H12 ✅ **Studio 认证**（本轮完成，见下）。

#### H12 落地细节
`createStudioServer` 里 `options.authToken ?? mintToken()`——**默认安全**：忘了传就是 401，
不是敞开。`randomBytes(24).toString('base64url')`，不落盘（一次启动一个）。
服务端注入 `<meta name="hb-token">` 到 `index.html`；页面的 `api()` 助手给**每个**请求
（含 GET）加 `authorization: Bearer`。`EventSource` 设不了头，所以 SSE 那一条路
额外接受 `?token=`（同源，永不出机器）。`authToken: ''` 是显式敞开，给自带鉴权的嵌入方。

顺序很关键：**Host 头检查在认证之前**，所以 `evil.example.com` 仍是 403 而不是 401。

实测（不是 mock）：live server 上 `/api/repos` 无 token → 401、错 token → 401、
bearer → 200、`?token=` → 200；POST 写操作无 token → 401；页面本身 200 且带 token。
真浏览器：`studio-ui` 15/15，其中新增一条**驱动真实表单**走页面自己的 `api()`。
非空洞验证：把 UI 的 token 摘掉后该套件 12/15（3 条失败正是预期的 401），恢复后 15/15。
`cdp.mjs` 新增 `clickSel()`——按 CSS 选择器做真实指针点击（`clickLabel` 按文本，
定位不了本地化/图标/字典加载前为空的控件）。

### 审计报告 MEDIUM 项（本轮要全修 —— 用户："全部修复"）

按包分组，避免多个 agent 撞同一个文件：

| 组 | 项 | 主题 | 主要文件 |
|---|---|---|---|
| A | M12–M16 | 取消/中断没有贯通：planner、critic、analyzer 扫描、CLI SIGINT | `planner/`, `pipeline/`, `analyzer/`, `cli/main.ts` |
| B | M17–M21 | 输入无上限：超大文件/超长行/超深目录/巨大 LLM 回复/巨大 diff | `analyzer/`, `llm/`, `patcher/` |
| C | M23–M25 | 配置：`llmBaseUrl`/`llmExtraBody` 未标记为 secret；`handbook config` 在**配置文件本身**坏掉时直接死；未知配置键被静默忽略 | `core/src/config/` |
| D | M26–M29 | 分析器解析缺口（同 H1/H2 家族的剩余部分） | `analyzer/src/` |
| E | M30–M34 | 路径守卫：符号链接逃逸、`..`、绝对路径、写出沙箱 | 多处 |
| F | M35–M37 | Studio 健壮性 | `studio/src/` |
| — | M1 | 源文件读不出来时，编出来的散文被计为"已描述" | `pipeline/` |

**本轮派发（按文件切分，互不重叠）**

| agent | 范围 | 状态 |
|---|---|---|
| H3/H7 | analyzer + pipeline + renderer 的披露 | ✅ 完成，`pnpm check` 1576 测试全过 |
| C | `core/src/config/**` + cli 的 `config` 子命令 | 🔄 |
| F | `studio/**` | 🔄 |
| E | `patcher/**` + `skill/**` | 🔄 |
| docs | `docs/**`（8 语种补 `scan-coverage.json`） | 🔄 |
| G | `planner/**` + `pipeline/**` + `llm/src/critic.ts`（取消贯通） | 🔄 |
| 我 | `llm/src/client.ts`（已完成）+ `analyzer/**` + CLI SIGINT | 🔄 |

已完成（我做的）：**llm 响应体上限**。`response.json()`/`response.text()` 原来无上限缓冲——
baseUrl 写错指到文件服务器、或网关吐无尽错误页，进程会被内存打死。新增 `readBoundedBody()`：
先看 `content-length` 短路（不读一个字节），再边流边计数（chunked 不报长度也拦得住），
超限抛 `PermanentError`（不重试）并直接点名"检查 base URL"。按**字节**不按字符计
（一个 emoji 是 2 个 UTF-16 单元、4 字节；按字符会让非拉丁文本超 4 倍）。
顺带：200 但不是 JSON 现在报"这个 URL 不是 API 端点"，而不是"空补全"——
后者会让人去查 prompt，而真正的问题在 URL。新增 10 个测试（client.test.ts 共 54）。

已完成（我做的）：**发现阶段的三个缺口**（`core/util/fsx.ts` + `analyzer`）。
1. `listFilesRecursive` 里 `readdirSync` 失败原来是 `catch { return; }`——**静默吞掉**。
   一个 000 权限或 root 所有的子目录，其下所有文件直接从分析里消失，
   下游分不清"那里没文件"和"我们没被允许看"。这就是 H7 那类违规，只是发生在目录层。
   新增 `DiscoverOptions.onSkip(path, reason)`，一路接到 `discoverByExtension` →
   `SpineAdapter.discover(root, {logger})` → `discoverAll`（`LanguageAdapter.discover`
   的第二个参数是**可选的**，所以现有 adapter 不用改；Swift 的 override 已同步）。
2. `walk` 是无上限递归。符号链接不跟随所以不会有环，但**真实的深树**会爆 JS 栈，
   `RangeError` 直接掀掉整个 run。加 `MAX_WALK_DEPTH = 64`（真实源码树是个位数深度），
   超了就报告并停在那一层，不是崩溃。
3. `spine.ts` 读文件前先 `statSync`：超过 `MAX_SOURCE_BYTES = 8 MiB` 的不读。
   一个几百 MB 的压缩包/生成表读成 UTF-8 字符串大约是两倍内存，再喂给 tree-sitter，
   花掉的内存和分钟数换来一张没人看的卡片。记为 `unreadable`（这是实话——我们没读），
   **`detail` 里写明尺寸**，否则读的人会去查文件权限。

新增 `packages/core/src/util/fsx.test.ts`（7 个测试，真实临时目录，不 mock fs——
符号链接、不可读目录、递归深度全是操作系统的性质，mock 只能证明 mock 写对了）。
注意其中不可读目录那条同时断言了**两种结果**：以 root 跑时 000 权限无效，
文件就是能看见、也就没什么可报告的——只断言一半会在容器里空洞地通过。
spine.test.ts 新增 3 个（12.6 MiB 真实 fixture，余量足够）。
三个包合计 973 测试全过。

已完成（我做的）：**H1/H2 家族的剩余两张表**（就是 D 组 M26–M29）。
H1/H2 只修了 `typeToModule`。同样的"首个声明胜出"还留在另外两张表里：
- `scopedTypeToModule`——键是 (scope, 裸类型名)。**scope 在整个仓库里并不唯一**：
  C++ 的 `namespace detail` 是每个需要私有 helper 的文件都会重开的惯用法，
  所以两个 TU 里的 `detail::Impl` 是两个无关类型。
- `directoryFunctions`——键是 (目录, 函数名)。Go 造不出冲突（同包同名编译不过），
  但**Swift 共用这张表**，而 Swift 的 `private func` 是**文件作用域**的，
  同目录两个文件各有一个 `Helper` 是完全正常的 Swift。

三层修复（每层都有独立的失效证明）：
1. 构建期：冲突就**撤销键**并记进 `ambiguousScopedTypes` / `ambiguousDirectoryFunctions`。
   撤销后**后来者也不能重新拿到**——否则答案取决于扫描顺序，而那正是问题本身。
2. `lookupScoped` 新增可选的歧义集参数：**遇到歧义就终止作用域外查**，不是跳过。
   这是最微妙的一半：光撤销键的话，`detail::Impl` 查不到就继续往外层走，
   找到全局的 `Impl` 然后自信地连过去——把"分不清这两个"变成"确定是第三个"，
   比原来的 bug 更糟。已接进 cpp/php/ruby/swift 全部 6 个调用点（否则守卫在生产路径上是惰性的）。
3. C++ `resolveOnType` 原来把"判不出类型"一律当 `boundary`。但 boundary 是一个
   **断言**（这个调用离开了扫描集），而歧义类型明明就在集里、只是有两份。
   新增 `typeSpellingIsAmbiguous()` 区分二者：不在集里 → `boundary`（C++ 要求先声明后使用，
   这是事实）；在集里但有多份 → `unresolved`，进 `dropped-calls.json`。

顺带补了 `lookupBareType()`——H1/H2 的注释里 `{@link}` 引用了它，但**从未被写出来**。

真实 C++ mini-repo 测试（三个文件：alpha/beta 各声明一份 `detail::Impl`，
gamma 两者都不声明只引用）。注意第一版 fixture 是**错的**：alpha 自己声明了那个类型，
在 alpha 内部解析到本地那份是**正确**的——必须由第三个文件来提问。
非空洞验证：单独撤 1 → 1 条失败；单独撤 2 → 3 条失败；端到端那条要两者都撤才失败（防御叠加）。
analyzer 671 测试全过。

已完成（我做的）：**CLI 的 Ctrl-C**。原来 `packages/cli` 里**一个信号处理都没有**——
SIGINT 就是原地硬杀：在途的模型调用被中途抛弃（钱照付），work dir 可能留下
一个看起来完整的半截产物。`runGenerate`/`runPlanner`/`resyncHandbook` 都接受
`AbortSignal`，只是从来没人传过。

`installCancellation()`：第一次按 → abort + "cancelling; press again to stop waiting"，
让 run 自己收尾并记录做过什么；第二次按 → 直接走人。退出码 **130**（128+2，shell 惯例），
非零，满足不变量 5。顶层 catch 现在区分 `AbortError`：取消**不是崩溃**，
打印堆栈会让用户以为自己按 Ctrl-C 触发了 bug。

实测放在 `scripts/smoke-cli.sh`（跑的是构建产物，不是 mock）——
单元测试能断言 signal 传下去了，但**证明不了** CLI 装了处理器、run 会收尾而不是挂死、
以及 shell 看到的是 130 而不是堆栈加 exit 1。四条断言：130、有取消提示、
不报成 error、**取消的 run 不写 run-manifest**。

两个坑（都栽过）：
1. 第一版固定 `sleep 6` 后发信号——但 demo project 对着 mock LLM 两秒就跑完了，
   信号发给了一具尸体，测试**空洞通过**。改成轮询日志确认 run 真的在跑，
   并且如果 run 已经结束就**报失败**而不是当成通过。源也换成整个 `packages/`。
2. `cmd | head -3` 之后 `$?` 是 `head` 的退出码，不是 cmd 的——一度让我以为
   其他命令对坏配置返回 0。去掉管道后是 1，不变量 7 完好。

顺带修了 M24 带来的两条 smoke 回归（**不是我的改动**，是 config agent 的）：
`handbook config` 现在**故意**展示坏配置而不是死掉（CLAUDE.md 明确要求），
所以它退 0；`config --check` 才是下判决的那个（退 2）。旧期望写的是 1。
更新期望时**加了断言的牙齿**，不是单纯重新基线化：断言 `NOT LOADED` 出现、
断言原因被写出来、断言**其他每个命令仍然拒绝运行**（退 1）、断言 `--check` 退 2。
`smoke-cli.sh` 现在 **86/86**（原 75）。

## Agent 索引重写（用户："写的太垃圾了，你根本没有深度调研"）

调研报告在 `docs/internal/plans/agent-index-redesign.md`（1212 行，含 aider repo-map、
llms.txt、ctags/SCIP/LSIF、Cursor rules 的实证对比）。它推翻/加强了我的初步诊断，
并挖出几个我没看到的真 bug：
- `coreFiles()` 先按 role 排序再按函数数 → 0 函数的 `html-assets.ts` 被列在 25 函数的
  `html.ts` **之上**。
- `fileStem()` 只剥一层扩展名 → 70 个"入口概念"里 10 个是 `*.test` 残渣；另有 35/70 的
  裸名在仓库里对应多个文件。
- **`model.cards` 有 169 条但只有 167 个文件**——多出来的是已删除文件的残留卡片。
  任何以 `cards` 为键的产物都会输出**不存在的路径**，而这个产物的全部承诺就是"这个路径存在"。
  新代码一律以 `assignment.fileStage` 为权威文件集。
- **skill 打包根本不发 agent 索引**：`AGENT_LOCATOR_PAGES` 只有
  `how_to_use.md` + `disambiguation.md`，715 KB 产出与主交付通道脱节。

### 落地

新文件集（`packages/renderer/src/agent-facts.ts` + 重写的 `agent-site.ts`）：

| 文件 | 作用 |
|---|---|
| `index.md` **3.2 KB**（原 33 KB） | 唯一假定"总在上下文里"的文件：grep 配方 + 阶段表 + 寄存器 + 覆盖率 |
| `symbols.tsv` | **符号 → `路径:起行-止行`**，这个查询以前根本不存在 |
| `files.tsv` | 文件 → 阶段、role、符号数、**一行**散文 |
| `calls.tsv` | 已解析的调用边，两端都带位置 |
| `stages/<sid>.md` 0.8–7.4 KB | 第二跳（原 `analyzer_adapters.md` 是 **313 KB**） |

选 TSV 不选 markdown 表格是有实测依据的：本仓库 338 行签名里含 `|`（TS 联合类型），
表格会把它们**静默截断**。而且一行一个事实在被截断时仍然完整，`\\t` 能锚定整列。
列序按**价值**排：查到的东西在前，散文在最后一列——因为消费方会截断长行
（本仓库自己的 planner 就在 200 字符处截），截断必须先吃散文、绝不吃路径。

删掉：职责段落（占索引 42.4% 字节、和人读那份**逐字节相同**）、"相关"（只有组标题和计数、
**没有路径**，agent 根本无法据此行动）、"核心文件"（与"范本"86% 重叠且排序是错的）、
"入口概念"、每个函数的四段散文、`how_to_use.md`（并进 index.md 的 `## lookup`——
隔一跳的配方就是没人follow的配方）、`disambiguation.md`。

保留：**寄存器表**（密集、有 id 锚点、grep 复现不了）和**强共变**（纯结构信号、
回答"我还得动哪些文件"）。

散文的处置：不是全砍。一行 ≤120 字符留在 `files.tsv` **最后一列**并标 `[prose]`；
整段留在**人读那份**里，阶段页用 `../<sid>.md` 指过去而不是复制——
复制正是两份产物变成同一堆字节的原因。

新增 `HandbookModel.provenance?`（可选，旧 work dir 仍能加载），从 run manifest 的
`finishedAt` 读，不在 render 时盖 `Date.now()`——读的人想知道的是**事实何时被提取**，
不是何时被渲染。理由：行号成了主载荷，而行号是唯一会**静默出错**的事实
（陈旧路径仍存在、陈旧符号名仍能 grep，陈旧行号指向错误代码且毫无信号）。

类符号是**派生**的并明确标注：IR 里没有类型这种节点，所以 `class-derived` 行的跨度是
其**方法**的 min..max——是成员在哪，不是声明在哪。不标就是在 agent 最信任的那一列里
放一个编造的数字；完全不发则 `StageTree` 在一个类型占查询量一半的代码库里查不到。
`index.md` 同时明写"types/interfaces/constants 未被索引"——
agent grep 不到就断定该类型不存在，正是这套设计要避免的"错误指针"失败。

实测（真实数据，非 mock）：`renderHtmlSite` → `renderer/src/html.ts:599-696`；
`safeResolve` 在 patcher 和 studio **各自解析到自己的文件**（旧设计做不到的消歧）；
demo 里两个 `__init__` 按文件区分。skill 现在真的发出 7 个 agent 文件，
按 SKILL.md 给的配方逐字执行可以直接命中。

`pnpm check` **1747 测试全绿**，renderer 覆盖率下限（96 行 / 78 分支）**没有下调**——
补测试补上去的，其中 `calls.tsv` 的整个边生成逻辑原本一行都没测到。

### 用户复看时发现的三件事（都已修）

**1. 用户看到的还是旧文件。** `examples/work/self/handbook/agent/` 里 `how_to_use.md`
在 21:01 被写了回去——我为浏览器测试起的 `studio` 进程还活着，跑的是**重建之前**的代码。
旧渲染器只清 `.md` 不清 `.tsv`，于是目录里**混了两代文件**：一份指向已不存在协议的
`how_to_use.md`，旁边是它从没听说过的 `symbols.tsv`。agent 读到会follow错的那份。

修法：清理改成**清空整个目录**，不是按扩展名删。"只删本版本会写的文件"正是产生混代的原因。
回归测试预置了旧格式的 4 个文件加一个 `prose/` 子目录，断言渲染后**只剩 5 个条目**。
教训：改产物格式时，旧版本的清理逻辑不认识新文件，新版本的清理逻辑必须认识**所有**旧文件——
唯一可靠的做法是整个目录归渲染器所有、每次清空。

**2. 跨包调用查不到（monorepo 的真缺口）。** `checkLanguage` 在 `lang-guard.ts` 里被调 4 次，
但 `calls.tsv` 里没有调用方、`nCalledBy` 显示 **0**。原因：跨包导入（`@handbook/core`）
被分析器记成 boundary 边，而我只发已解析位置的边。
**在 monorepo 里这恰恰是最该回答的问题**（"谁在用这个导出函数"），0 会被读成**死代码**——
正是这套设计要避免的"错误指针"。

修法：boundary 边也进 `calls.tsv`，callee 位置写 `boundary:<specifier>`。
`boundary:` 前缀不可能被误当成路径，所以名字是事实、位置未知也不假装知道。
`nCalledBy` 同时把这类调用方计入（表头写明了包含它们）。实测 `checkLanguage` 现在是 1。
本仓库 3565 条边里 1063 条是 boundary，其中 284 条指向 `@handbook/core`、25 条指向
`@handbook/analyzer`——这些正是跨包边。

**3. studio 打的 skill 根本不含 agent 索引。** `server.ts` 用
`fileExists(join(agentDir, 'how_to_use.md'))` 决定要不要把 `agentDir` 传给 `buildSkill`。
那个文件已经不存在 → 探测永远为 false → **每次 studio 建 skill 都静默丢掉 agent 索引**，
而且不报错，因为"没有 agent 产物"本来就是合法配置。
这和调研发现的交付通道 bug 是同一个，只是在另一个调用点复发。

修法不是改字符串，而是让漂移**不可能发生**：渲染器导出 `AGENT_INDEX_FILE`，
studio 引用它。一个只有一行、失败模式是静默的探测，不该由两处各自硬编码文件名。
实测：`buildSkill` 现在发出 23 个 agent 引用，`references/agent/index.md` 与
`symbols.tsv` 都在。

顺带把 `RESERVED_STAGE_IDS` 里的 `how_to_use`/`disambiguation` 换成
`symbols`/`files`/`calls`——阶段 id 撞上产物文件名会覆盖它们。

### 文档状态

`docs/content/` 已经不含旧页面引用（0 处）。README 与包级 README 已更新：
`README.md` / `README.zh-CN.md` 的"给 AI 的那本"改成 `符号 → 路径:行号`；
`packages/renderer/README.md` 重写了 agent 产物那一节（含"人读那份解释、AI 那份定位"
的划分、TSV 的实测理由、以及 `class-derived` 和 `boundary:` 两处"本可以编造但没有"）；
`packages/skill/README.md` 记下了交付通道曾经断掉这件事。

### 文档收尾（已完成）

**更正上一条的判断**：我当时用 90 分钟的 mtime 窗口去查，得出"docs agent 没留下半成品"。
错了——它在挂掉之前**已经把英文和 7 个译文都写完了**，只是工作发生在更早。
教训：判断一个 agent 做到哪一步，要看**产物内容**，不要看 mtime 窗口。

真正的缺口在别处：`boundary:` 边和 `nCalledBy` 计入跨包调用方是**在文档写完之后**才加的，
所以文档还在说 calls.tsv"只含已解析的边"——现在是错的。已补：
- `reference/artifacts.mdx` ×8：文件清单行、`symbols.tsv` 表头（补两行 nCalledBy 说明）、
  `calls.tsv` 真实表头，以及新增一节**「边界边，以及为什么 monorepo 需要它们」**
  （带实测数字：3565 条边里 1063 条是边界边、284 条指向 `@handbook/core`、
  `checkLanguage` 曾显示零调用方）。
- `guides/agent-skill.mdx` ×8、`guides/rendering.mdx` ×8：过期的"resolved call edges"描述，
  以及第 5 步补上"包括在别的包里的调用方，它们以 `boundary:<specifier>` 行出现"。

改译文时用**结构定位**（符号表围栏到下一个 `###` 之间整段替换），不靠我记得的措辞——
第一次尝试按猜的原文匹配，6 个语种全部 MISS。另外 hi 那条一度没匹配上，
因为我在匹配串里写了日文句号 `。` 而原文是天城文句号 `।`。

### 踩到并修掉的 MDX 陷阱

日文那段以 `import を通じて…` 开头 → **MDX 把行首的 `import` 当成 ESM 语句**交给 acorn，
报 `Could not parse import/exports with acorn` + `Unexpected character '、'`。
报错只给行号，完全不提示原因是**句子的第一个词**，而且只在构建时出现——
译文可以通过全部结构检查却把站点搞挂。

已在 `docs/scripts/check-translations.mjs` 加守卫：非围栏行以 `import`/`export` 开头
且后面不接标识符/`{`/`*`/引号时报错，并提示改写。
非空洞验证：把原写法放回去 → 报
`artifacts.ja.mdx:361: a paragraph starting with "import" is parsed as an ESM statement`。

**另一个坑**：根 prettier 和 `docs/` 自己的 prettier 配置**不一致**。我先用 docs 的格式化，
`pnpm check` 的 `prettier --check .` 就红了 6 个文件。以**根配置**为准，改完后两边都过。

### 最终验收（本轮）

- `pnpm check` **1750 测试全绿**，覆盖率下限无一下调
- `docs` 构建 **358 页**
- `check-translations` **238 页**结构一致 + locale 覆盖检查
- `smoke-cli.sh` **86/86**（含 4 条真实 SIGINT 断言）
- `pnpm demo` 全流程通过，skill 真的发出 agent 索引

### H12 的两个后续（都是我自己引入的问题）

**1. 认证绕过**（studio agent 发现，已修）。我的守卫用**原始 `req.url`** 做
`startsWith('/api/')`，而路由用 `new URL().pathname`。于是 `/./api/repos`、
`//evil/api/repos`、`/%2e/api/repos`、`/\evil/api/repos` 全都能到达 `/api/repos`
而没有一个以 `/api/` 开头——**整个 API 无 token 应答**。已改成一次解析、一个 pathname、
一个判断。教训：任何"路径前缀判断"必须和路由用**同一个**解析结果，否则两者之间的缝隙就是洞。

**2. 手册预览被我打死了**（我发现并修）。渲染出的手册挂在
`/api/repos/<name>/handbook/...` 下，UI 用 `<iframe src=...>` 加载它——
而 **iframe 导航带不了 `Authorization` 头**。加上 agent F 把 `?token=` 收窄到只剩 SSE，
预览就是纯 401。注意：`?token=` 也**救不了**——手册页面内部还会相对加载
`search-index.js`、图片等子资源，那些同样带不了任何凭据。

正确机制是 **cookie**：浏览器对导航和子资源会自动带上。服务 shell 时
`Set-Cookie: hb_token=…; Path=/; SameSite=Strict; HttpOnly`。
`HttpOnly` 让脚本读不到（meta tag 是给页面自己的 `fetch` 用的），
`SameSite=Strict` 加上已有的 Host/Origin 检查构成 CSRF 防线。

**顺带修了一个真实的越权路径**（studio agent 报的跨界项）：手册 HTML 与 UI **同源**，
而手册是从**任意源仓库**构建的、散文由模型读那个仓库写出——所以它的 HTML 不是可信输入。
一段活下来的脚本可以 `fetch('/')` 把 token 从 meta tag 里读走。
新增 `HANDBOOK_CSP`，关键是 **`connect-src 'none'`**：脚本就算跑起来也**发不出任何东西**。
`script-src` 必须保留 `'unsafe-inline'`（内联是手册的立身之本——双击即开、无服务器无构建）
和 `'self'`（多页渲染把搜索索引单独放成 `search-index.js`）。

实测（真浏览器 CDP）：手册在 iframe 里正常渲染（2398 字内容、无 401），
而从手册页面内 `fetch('/')` → `TypeError: Failed to fetch`（被 CSP 拦死）。
studio 测试 **85 → 102**。

### 仍可继续（非阻塞）
- `logLevel: debug` 目前几乎无输出——若要它有用，需要在 pipeline 里补 `.debug()` 调用点。
- Studio UI 的 render/skill 对话框尚未做真浏览器点击测试（API 层已有 62 个测试覆盖）。
3. 翻译落地后：脚本统一把 *.{loc}.mdx 里 /diagrams/X.svg → X.{loc}.svg，
   README.zh-CN.md 的 assets/X.svg → X.zh.svg；git add 新 SVG（README 链接 drift 测试）
4. Studio server：/api/settings（registry 驱动）+ render/skill/validate 端点 +
   generate 六参数转发 + llmCache + 每任务 LLM 覆盖（llmApiKey 拒收，env-only）+
   analyze lang + plan maxTurns + apply backupRoot + resync
   proseLang/cardDetail/refreshRendered/corrections/title + 修 608 行语言 bug +
   jobs.ts debug 等级 + state.ts lastParams
5. Studio UI：registry 驱动的表单 + 8 语言 DICT（现 zh/en ~226 条，翻 6 语种 + 新增串）
6. README.md / README.zh-CN.md 重写（双产物故事、冲击力、色彩排版），5 轮对抗；
   docs 首页/“What is Handbook”同步讲清 human vs AI 两份产物
7. CJK 搜索验证（orama 默认分词器对 zh/ja 可能无效，必要时接 @orama/tokenizers）
8. 全量验证：docs build 358 页 + 全 locale 浏览器扫 + pnpm check + studio 测试

### 关键事实
- 翻译规则/术语表在各 agent prompt 里（fence/JSX 数量自检；meta.json 只译 title）。
- fumadocs 回退检测：`page.path.includes('.{lang}.')`——翻译文件一到位，横幅自动消失。
- session limit 会杀 agent：分波发（≤7 并行），完成一波再发下一波。

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

## 收尾五项（用户："都做完吧"）

| # | 项 | 状态 |
|---|---|---|
| 1 | 陈旧卡片不淘汰（真 bug） | ✅ 我做完 |
| 2 | 272 个文件未提交 + `check:all` 未跑 | ⏳ 等两个 agent 收工 |
| 3 | SSE 写入无背压 | ✅ agent 做完 |
| 3b | Studio render/skill/validate 对话框无真浏览器测试 | ✅ 同一个 agent 做完 |
| 4 | IR 没有类型节点（`symbols.tsv` 只有函数） | 🔄 agent |
| 5 | `logLevel: debug` 几乎无输出 | ✅ 我做完 |

### 第 1 项：卡片淘汰

`WorkDir.evictCardsOutside(keep)` + 在 cards pass 收尾处调用。
实测本仓库 work dir：**182 → 180 张卡片**，清掉 `cli/src/args.ts` 和它的测试
（被 config 重构删掉的文件）。

**设计上最容易搞错的一点**，写进注释了：键必须是 `files`（图里的全量文件集），
**不是** `todo`（`onlyFiles` 窄化后的 resync 子集）。用错会删掉整个手册并报告成功。
`files` 之所以权威：phase 1 是走源码树建图的，被删的文件不在图里。

我一度加了 `if (!options.onlyFiles)` 的门禁，后来**去掉了**——`files` 本来就是全量集，
门禁不但多余，还会让 resync pass 永不淘汰（删掉的文件卡片要等到下次全量跑才消失）。

非空洞验证的教训：门禁在时，把它改成 `if (true)` **17 条测试全过**——
说明我那条"子集不会误删"的测试根本没测到门禁。真正咬得住的做法是把
`files` 换成 `todo`（那才是会毁掉手册的写法），这时该条测试单独变红。
**一个测试要能区分正确实现和最危险的错误实现，而不是区分"有代码"和"没代码"。**

### 第 5 项：debug 日志

实测起点：`-v` 跑一次 analyze 只产出 **1 行** debug（`[env] loaded from .env`）。

补了两处，都是排查时最先要看的：
- **LLM 每次调用**：`POST <url> model=… prompt=…ch max_tokens=…` 和 `<status> in …ms`。
  URL 记，**key 永不记**（key 在 headers 里，而 headers 故意不进这行）。
  为什么是这两个数：慢和贵都由它们解释，而别处看不到——`usage()` 只报总量。
- **启动时的有效配置**：每个设置的值 + **来源**（`--source` / `HANDBOOK_X` /
  `路径:keyPath` / `default`）。这是"它到底用的是我以为的那个设置吗"的答案，
  而 `handbook config` 只能回答**另一次调用**的情况（不同 cwd、不同 env、或者文件已被改过）。

两个坑：
1. `logLevel` **没有对应的 flag**（只走 env/config），所以我最初传 `opts.logLevel` 永远是
   undefined——`HANDBOOK_LOG_LEVEL=debug` 到不了这行，而 `-v` 恰好能用。
   改成让 `resolveOrThrow` 用**它刚解析出来的值**建 logger。
   半能用比不能用更糟，因为它看起来是对的。
2. 摘要里 `logLevel` 一度显示 `info`，而那次运行明明在 debug 输出——
   因为 `-v` 是在解析**之后**覆盖的。这是整行里读者最会立刻怀疑的一个字段，
   一个字段不可信整行就不可信。改成显示实际生效的值，来源标 `-v/-q`。
   `-v`/`-q` 是顶层 flag、解析前已知，所以直接传进来；
   没有给 `Logger` 接口加 `.level`——那会弄坏测试里所有手写的假 logger。

实测：`-v` 和 `HANDBOOK_LOG_LEVEL=debug` 两条路都生效；
`OPENAI_API_KEY=sk-do-not-print-me-12345` 在输出里出现 **0 次**，摘要里是 `llmApiKey=***`。

### 第 3 项：SSE 背压

上一轮的结论是"真问题，但我造不出确定性的离线测试，而任务书要求先证明再修"。
测试是能造出来的：**服务器和测试在同一个进程里**，所以直接读服务器自己的
`res.writableLength` / `writableNeedDrain` 就行；客户端用 `node:net` 裸 socket 发请求，
**永不注册 `data` 监听**（socket 默认是 paused 的，内核接收窗口就一直关着）。

先量出来再改：4000 行日志（约 8 MB）灌给一个不读的 socket，
旧代码在本进程里囤了 **8,030,890 字节**，而且只要 job 还在说话就会一直涨。
`job.log` 上限 2000 行 × 2000 字符，所以**光是重放**就有 4 MB 一次性写出。

**策略选的是"有界队列 + 丢最旧 + 明确告知"**，另外两个都更糟：

- **暂停生产端**：不行。job 不能因为某个人的标签页在后台就跑得更慢。
- **断开订阅者**：看起来诚实，其实更坏——这个 UI 把流断开当成**运行结束**
  （`onerror` 会去 `/api/jobs/<id>` 把抽屉收尾），所以对一个还在跑的 job 挂电话，
  等于把"还在跑"报成"跑完了"。比留个洞更糟。

洞是**以 `dropped` 事件单独告知**的，不是往日志里插一行合成文本——
理由和"事实与文案永不混"一样：我们编的一行，对下游来说和 job 真说过的一行分不出来。
告知落在**洞发生的位置**（下一个存活帧之前），放到流末尾等于不说洞在哪。

两个承重细节：

1. **重放走索引，不入队。** `job.log` 本来就在内存里、本来就有界，
   随 socket 排空按下标走一遍不额外占内存，也**永不会被丢**。
   这才是"一个完全健康的订阅者"能拿到全部积压的原因——它的 4 MB 重放
   在**前 33 行**就踩到 `writableNeedDrain` 了。把重放入队的写法我实测过：
   2000 行只剩 **545 行**到达。
2. **progress 合并，不入队。** progress 是快照，旧的一份毫无价值；
   只留最新一份，运行期高频 tick 就不会把读者真正要看的日志行挤掉。

非空洞验证（4 处变异，逐个确认变红）：

| 变异 | 结果 |
|---|---|
| 恢复成原来的裸 `res.write` | `writes` 4000（上限 800）红；单独看内存断言是 8,030,890 > 2,000,000 红 |
| 队列不淘汰（无界） | "等不到 drop 披露"超时红 |
| 重放入队而非索引 | 健康订阅者只收到 545/2000 行，红 |
| `drain` 后不重新 pump | 两条测试红（流永远不恢复） |

UI 侧：`index.html` 加了 `dropped` 监听，八种语言各加 `job.linesDropped`。
`ui-drift.test.ts` 新增两条把两边钉在一起：服务器发出的**每个**具名 SSE 事件
（`progress` / `done` / `dropped`）页面都得有监听器，且八个词典都得有这个 key ——
`t()` 缺 key 时会回显 key 本身，那会在最需要一句话的时候印出 `job.linesDropped`。

### 第 3b 项：render / skill / validate 的浏览器测试

`scripts/browser/studio-dialogs.mjs`，31 条断言，全绿，已接进 CI 的 demo job
（跟在 `studio-ui` / `studio-progress` 后面）。完全离线：这三个命令本来就不碰模型，
它们要的输入就是 `pnpm demo` 刚产出的那份手册。

断言都盯**结果**，不是"没崩"：

- 取消勾选的框必须让对应产物**依然不存在**（`handbook.html`），
  勾上的框必须让产物**出现**（`llms.txt`）。只验证 `true` 的表单，
  和一个正确的表单长得一模一样——这条是唯一能区分它们的断言。
- 手打的标题必须出现在重渲染后的 `<title>` 里；手打的 slug 和项目名必须出现在
  `SKILL.md` 里；语言下拉必须变成请求里的 `bodyLang: zh`。
- `validate` 先在合法包上验（抽屉是 ice 不是红，文案和 API 判定一致），
  再删掉 `references/index.md` 让它失败——必须**变红并说出原因**
  （退出码 2 的语义："工具没坏，答案是不"）。
- 最后把 repo 从注册表里删掉（另一个标签页/重启的场景），再提交两个对话框：
  两个都得把 `unknown repo` 送进抽屉。对话框提交后**自己就关了**，
  所以这条不成立时用户面前什么迹象都没有。

两个夹具都**先复制再用**：work dir 因为这套测试会重渲染、打包、还故意破坏 skill；
source tree 因为 studio（正确地）拒绝两个 repo 共用一棵树，
直接注册真路径会让第二次运行撞车，看起来像 UI 坏了而不是测试没清干净。

非空洞验证（11 处变异，全部只改 `index.html`，逐个确认变红）：

| 变异 | 变红条数 |
|---|---|
| render 按钮 `data-act` 改名（不可达） | 8 |
| 四个 checkbox 被硬编码 | 3 |
| 标题字段被丢掉 | 3 |
| `render-submit` 的 catch 吞掉错误 | 1（就是那条"必须送进抽屉"） |
| `skill-submit` 的 catch 吞掉错误 | 1 |
| skill 的 name/project 被丢掉 | 1 |
| 失败的 validate 报成中性 `notice` | 1 |
| validate 的 `disabled` 门禁去掉 | 1 |
| add 对话框忽略 `fWork` | 16 |
| `sLang` 被硬编码成 en | 1 |
| `render-cancel` 变成空函数 | 1 |

第一次跑变异时发现一个测试自身的缺陷：等待就绪的探针用的是
`[data-act="render-open"]` 存在——而那正是下一条断言要测的控件，
一处坏掉会连带把"添加仓库"也报红。改成等 `#ovCov`（覆盖率卡片）。
**就绪探针不能等在它下一条断言要测的那个东西上。**

## 调研后的四项（用户："好"）

调研结论：5 项里 3 项要修 + 补完 debug。第 2 项的另两个小口子和第 5 项**测量后判定不修**。

### 判定不修的，以及依据

- **TS `namespace` 内类型**：zod 的 372 个 TS 文件里只有 **5 个** namespace。ES 模块已取代它。
- **Python 不从 `class Color(Enum)` 推 enum**：全部 17 个仓库里 **0 个**。
  而且 Python 的 `Enum` 是**继承**不是语法，靠基类名推断就是在猜——`class` 已经是正确答案。
- **本地 `examples/work/self` 旧**：`git ls-files examples/work` 返回 **0**，被 `.gitignore` 忽略，
  没进仓库。`pnpm demo` 是全离线可复现证明。不是代码问题。

### 第 1 项的关键数据（决定要修的依据）

17 个真实仓库里只有 **6 个**在覆盖范围内。okio（Kotlin）实测：
**18% 的类型声明完全查不到**（43 个名字），能查到的 201 个跨度还是错的（从第一个方法起算）。
无方法的类型（data class、DTO、protocol、enum、typealias）**完全隐形**。

成本已被前置工作摊平：已实现六种的增量是 go +69 / java +56 / rust +63 / ts +58 /
csharp +79 / python +35 行——**每种约 50 行 + 70 行测试**。

**但 12 种未覆盖要分两类**（这是核实代码而非相信报告得出的）：
- 手写 spec、值得加（6）：cpp、dart、php、ruby、solidity、swift
- `shell` 永远 `[]`：它真的没有类型声明
- **generic tier（5）：kotlin、objc、ocaml、scala、zig —— 不做**。
  它们走模式匹配引擎。在那里抽类型会产出**和精确解析长得一样的 IR 却低一档保真度**，
  正是不变量 3 要防的。讽刺的是 Kotlin 恰好是漏得最多的那个，
  但"声明为精确解析、实际是猜"比现在诚实回退更糟。

### 第 3 项：逐行保真度（我做完）

原以为要给 `FileCard` 加字段，实测发现**数据已在手边**：`phase1.ts` 的 `discoverAll`
返回的就是 `语言 → 文件列表`。只需反转成 `文件 → 语言` 存进 `graph.metadata.fileLanguages`
（可选、排序、旧产物仍可加载），再一路传到 `files.tsv` 的 `language/tier` 列。

实测 okio：**338 个 Kotlin 文件标 `kotlin/generic`，28 个 Java 文件标 `java/full`**——
同一张表里两种保真度**逐行**区分开。之前只能作为全局脚注，读 180 行表的人无法对应到任何一行。

一个设计决定：`fileLanguages` 缺失时**整列不出**，而不是每格填 `?`。
满格的 `?` 看起来像"渲染器算不出来"，而不是"这份产物从来没带过这个信息"。

### 第 4 项：debug 日志补完（我做完）

上一轮我说"debug 已修"是**说过头了**——实测 pipeline 和 renderer 都是 **0** 个调用点。
补齐后：**1 行 → 35 行**（5 文件的 demo 全流程）。

加的是排查长跑时真正要看的：**每阶段 start/done + 耗时**（"卡在哪一步"是第一个问题，
而原有的 info 行只报告阶段**发现了什么**，一个什么都没产出的阶段连一行都没有）、
cards 批次构成、organize/narrate 的并发度。

顺手修了一个自己造的错：organize 的 debug 标签写成 `[2b]`，但它实际在 2c 跑，
于是这行出现在 `[2b] done` **之后**——**带时间戳的自相矛盾比没有这行更糟**。
