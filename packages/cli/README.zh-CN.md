# @handbook/cli

`handbook` 命令行——把其余每个包接成一条工具链的唯一入口：
把代码库分析成调用图、生成手册、渲染给人和 agent 看、打包成 skill、校验这个 skill、
用它规划改动、把改动真正落盘、代码变了之后再把手册前滚。
它自己**没有任何业务逻辑**：每个子命令都只是「命令行参数 → 某个包的 API」的薄适配器，
结果 JSON 打到 stdout，日志打到 stderr。

> 英文版：[README.md](README.md)

## 职责

- 定义十个子命令（`analyze`、`generate`、`render`、`skill`、`validate`、`plan`、`apply`、`rollback`、
  `resync`、`studio`），并把参数映射到底层包的 API。
- 每次调用构建共享基础设施：分级日志器（`-v`/`-q`），以及需要 LLM 的命令所用的、由环境变量配置的
  `OpenAiChatClient`。
- 在任何子命令动作之前**自动加载 `.env`**（默认当前目录下的 `./.env`，可用 `--env-file` 指定；
  **shell 里已有的环境变量优先**）。
- 把所有路径参数解析成绝对路径，并打印机器可读的 JSON 结果。
- 设置退出码（`validate` 失败退 2；任何错误退 1 并只打一行信息）。
- **不**实现任何管线、渲染、规划、前滚逻辑——那些都在别的 `@handbook/*` 包里。
- **不**导出编程 API——`src/index.ts` 故意是空的；要编程调用请直接依赖底层包。

## 公开 API

无。这个包的产物是 `handbook` 可执行文件（`bin: { "handbook": "./dist/main.js" }`）；
`src/index.ts` 什么都不导出。

全局参数：`-v, --verbose`（debug 日志）、`-q, --quiet`（只报错误）、`--env-file <path>`。

需要 LLM 的命令（`generate` 除阶段 1 之外、`plan`、未加 `--no-llm` 的 `resync`、以及 `studio` 里的作业）
读取这些环境变量：`OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_BASE_URL`、`OPENAI_MAX_TOKENS`、
`OPENAI_TIMEOUT`（秒，默认 300）、`OPENAI_EXTRA_BODY`（JSON，透传厂商专属字段），
均可用 `HANDBOOK_LLM_*` 作为回退。

## 用法

```sh
# 1. analyze —— 只做静态调用图，不花 LLM
handbook analyze --source ./project --work ./work --lang auto

# 2. generate —— 完整管线（阶段 1/2a/2b/2c/3）
export OPENAI_API_KEY=... OPENAI_MODEL=gpt-4o-mini      # 或写进 ./.env
handbook generate --source ./project --work ./work \
  --phase all --strategy file --detail deep --synth-mode doctor \
  --narrate-lang zh --resume --refresh
# member 策略 + 手写骨架：
handbook generate --source ./project --work ./work --strategy member --skeleton ./skeleton.yaml

# 3. render —— work 目录 → markdown（可选 HTML / agent 站点），不花 LLM
handbook render --work ./work --out ./out --title "我的项目手册" \
  --html --html-single --agent-site

# 4. skill —— 把渲染好的手册打包成 agent SKILL，不花 LLM
handbook skill --handbook ./out --out ./skills/myproject --name myproject \
  --project MyProject --work ./work --source ./project

# 5. validate —— 校验 SKILL 包结构与覆盖率新鲜度，不花 LLM
handbook validate --skill ./skills/myproject --source ./project

# 6. plan —— 手册驱动的改动定位（只读 agent）
handbook plan --source ./project --handbook ./skills/myproject/references \
  --request "给 export 命令加一个 --json 参数" --max-turns 30 --out plan.md

# 7. apply —— 把计划里的 EDIT 块真正写进源码树（先 dry-run）
handbook apply --source ./project --plan plan.md --dry-run
handbook apply --source ./project --plan plan.md

# 8. rollback —— 还原到补丁前的确切字节
handbook rollback --backup ./project/.handbook-patches/2026-08-03T…
handbook rollback --backup … --force       # 覆盖「补丁之后又被改过」的保护

# 9. resync —— 代码改了之后把手册前滚
#    （不传 --detail 则沿用手册原本的粒度；<work>/handbook 下已渲染的产物自动刷新，--no-render 跳过）
handbook resync --case ./case --work ./work
handbook resync --case ./case --work ./work --no-llm   # 只刷新结构

# 10. studio —— 本地 Web 界面（仅 127.0.0.1）
handbook studio --port 4860 --state-dir ~/.handbook-studio
```

各命令的关键参数：

- `analyze`：`--source`、`--work`（必填）；`--lang auto|python|typescript|go|rust|shell`。
- `generate`：`--source`、`--work`（必填）；`--phase all|1|2|2a|2b|2c|3|<逗号列表>`、
  `--strategy file|member`、`--skeleton <path>`、`--detail brief|deep`、`--synth-mode oneshot|doctor`、
  `--max-doctor-rounds <n>`、`--narrate-lang en|zh`、`--read-workers <n>`、`--resume`、`--refresh`。
- `render`：`--work`（必填）；`--out`、`--title`、`--html`、`--html-single`、`--agent-site`。
- `skill`：`--handbook`、`--out`、`--name`（必填）；`--project`、`--work`（加上 coverage.json）、
  `--source`（加上内容哈希）。
- `validate`：`--skill`（必填）；`--source`（启用哈希新鲜度检查）。
- `plan`：`--source`、`--request`（必填）；`--handbook`、`--out`、`--max-turns <n>`。
- `apply`：`--source`、`--plan`（必填）；`--dry-run`、`--backup-root <dir>`。
- `rollback`：`--backup`（必填）；`--source`、`--force`。
- `resync`：`--case`、`--work`（必填）；`--no-llm`、`--detail brief|deep`、`--narrate-lang en|zh`。
- `studio`：`--port <n>`、`--state-dir <dir>`。

## 设计说明

- **stdout / stderr 严格分离**：结果是 stdout 上的 JSON，日志经 core 的日志器走 stderr，
  所以每个命令都能进管道（`handbook analyze ... | jq .functions`）。
- **LLM 客户端懒构建，且只给需要它的命令**——`analyze`、`render`、`skill`、`validate`
  完全不需要 API key，`generate --phase 1` 也整个跳过客户端构建。
- **`.env` 在 preAction 钩子里加载**，所以它对每个子命令都生效，
  而 shell 里已有的变量永远优先——临时覆盖一个参数不需要改文件。
- `resync` 的 `--no-llm` 走 commander 的取反参数约定（`opts.llm === false`），
  选择「只刷新结构、散文标记为过期」的路径。
- **错误统一漏进一个 `parseAsync().catch` 处理器**，只打一行 `handbook: error: …` 然后退 1——
  正常使用时不会看到堆栈。

## 依赖

内部：

- `@handbook/core` —— 日志器创建与日志级别类型、`.env` 解析。
- `@handbook/llm` —— 需要 LLM 的命令所用的 `OpenAiChatClient`。
- `@handbook/pipeline` —— `runPhase1`、`generateHandbook`、`loadHandbookModel`、`WorkDir`。
- `@handbook/renderer` —— `render` 背后的四个渲染函数。
- `@handbook/skill` —— `buildSkill` / `validateSkill`。
- `@handbook/planner` —— `plan` 背后的 `runPlanner`。
- `@handbook/patcher` —— `apply` / `rollback` 背后的 `applyPlan` / `rollback` / `listBackups`。
- `@handbook/resync` —— `resync` 背后的 `resyncHandbook`。
- `@handbook/studio` —— `studio` 背后的 `startStudio`。
- `@handbook/analyzer` —— 分析栈（经由 pipeline 使用）。

外部：

- `commander` —— 声明式的子命令、参数解析与帮助文本。
