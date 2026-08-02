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

## 状态

- [x] 环境与依赖可行性验证
- [ ] 三个调研 agent 产出功能规格（scratchpad/spec-*.md）→ 完成后把要点合入 docs/internal/SOURCE-SPEC-DIGEST.md
- [ ] 设计文档 docs/superpowers/specs/2026-08-02-codewiki-design.md
- [ ] 骨架 → core → analyzer → llm → pipeline → renderer → helper → cli
- [ ] 测试 + 构建验证
- [ ] 完整文档
- [ ] 多轮对抗评审
- [ ] 端到端验证

## 关键决策记录

- D1: 统一大/小两条管线为一个 pipeline 包 + 两种 strategy（消除源实现的大量复制粘贴），CLI 上以 `--strategy large|small`（或 profile）暴露。
- D2: 包命名空间 `@codewiki/*`，项目名 Codewiki（待定，实施时可再定，但不得与参考项目相关）。
- D3: 中间产物全部 JSON + zod schema 校验，work-dir 可恢复（幂等、跳过已完成步骤）。
