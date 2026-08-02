# 架构草案（待调研结果补全功能细节）

## 项目名（暂定）

**Codewiki** — Turn any codebase into a navigable, always-current handbook.
包命名空间 `@codewiki/*`。CLI 命令 `codewiki`。

## Monorepo 布局（分包策略）

```
handbook/
├── package.json               # 根：workspace 脚本、devDeps（typescript/vitest/eslint/prettier）
├── pnpm-workspace.yaml
├── tsconfig.base.json         # 严格模式基线；各包 composite reference
├── packages/
│   ├── core/                  # @codewiki/core       —— IR 类型 + zod schema、结果类型、错误、通用工具（并发限流、重试、fs 原子写、hash）
│   ├── analyzer/              # @codewiki/analyzer   —— tree-sitter WASM 多语言静态分析 → 调用图 IR（零 LLM）
│   ├── llm/                   # @codewiki/llm        —— OpenAI 兼容 chat 客户端（重试/限流/JSON 模式/用量统计），可注入 mock
│   ├── pipeline/              # @codewiki/pipeline   —— 手册生成管线：phase1(graph) → phase2(结构合成) → phase3(叙述)；strategy: large|small
│   ├── renderer/              # @codewiki/renderer   —— 手册 → markdown 文件树 + 自包含 HTML 站点
│   ├── skill/                 # @codewiki/skill      —— 手册 → agent SKILL 打包 + 校验/覆盖率
│   ├── planner/               # @codewiki/planner    —— 手册驱动的变更定位 agent（read-only 工具环 + 计划输出）
│   ├── resync/                # @codewiki/resync     —— diff → 手册派生层增量更新
│   └── cli/                   # @codewiki/cli        —— 统一 CLI（codewiki generate|render|skill|plan|resync|validate）
├── docs/                      # 面向用户的文档（架构、指南、包文档索引）
└── examples/                  # 最小可运行示例（fixture 仓库 + 生成脚本）
```

## 依赖方向（单向、无环）

```
cli → pipeline, renderer, skill, planner, resync
pipeline → analyzer, llm, core
planner → llm, skill(读格式), core
resync → analyzer, llm, core
renderer → core
skill → core
analyzer → core
llm → core
core → (无内部依赖)
```

## 构建与工程规范

- 纯 ESM（"type": "module"），Node >= 20。
- `tsc -b` composite references 增量构建；无 bundler（库包直接发 dist/ + d.ts）。
- vitest 工作区测试；每包 `src/` 旁置 `*.test.ts`。
- eslint(typescript-eslint flat config) + prettier。
- 每包 README：职责 / 安装 / API / 示例；根 README：整体故事线。
- 所有中间产物 JSON 落 work-dir，zod 校验 + 版本字段，幂等可恢复。

## 待补（等调研）

- pipeline 各 phase 精确算法与 prompt 目录
- 手册文档格式规范（index/overview/registers/stages）
- skeleton.yaml 格式
- planner 工具环与提示词
- resync 的 case 合同与 reconcile 算法
