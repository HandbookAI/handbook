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
- [ ] 对抗评审 round2 进行中（agent：round1 修复复核 + doctor/member/cli/mock/文档一致性新扫描 → docs/internal/review/round2.md）
- [ ] round3 复核至干涸
- [ ] 最终验收：全量 build+test+demo 重跑

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
