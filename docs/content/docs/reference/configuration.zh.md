---
title: '配置参考'
description: 'Handbook 的每一项设置，连同它的命令行参数、环境变量、配置文件键、类型与默认值——由注册表生成。'
---

由 `pnpm run config:docs` 从设置注册表生成——请勿手工编辑；一旦本文件与 `SETTINGS` 发生漂移，packages/cli/src/docs-drift.test.ts 会让构建失败。

## 优先级

每一项设置都经由同一组层级解析，优先级从高到低依次为：**命令行参数** > **shell 环境变量** > **`.env`** > **`handbook.config.yaml`** > **默认值**。第一个给出取值的层级胜出，对该设置而言其下所有层级一概忽略。运行 `handbook config`——或用 `handbook config --command <name>` 只看某一个子命令——即可查看实际解析出的取值，以及它来自哪一层。

## 命名

注册表中的一个 camelCase `key` 会同时驱动三个界面：一个命令行参数、一个环境变量和一个配置文件键。给其中任意一个加上命令名前缀，就把这个界面限定到某一个子命令上，而且三者用的是同一套变换——`HANDBOOK_<KEY>` 变成 `HANDBOOK_<COMMAND>_<KEY>`，`key` 变成 `<command>Key`，无论写成扁平形式还是嵌套在 `<command>:` 下一层都一样。下文中标注 _(限定作用域)_ 的设置只接受带前缀的环境变量名，因为它的含义随命令而变（skill 包中的 `--out`、`--lang`）。

## 引导

有三项顶层设置指向上述各层，它们自身位于注册表之外，会在其他所有设置之前解析一次——这也正是为什么它们都不能由自己所加载的东西来设置：写在 `handbook.config.yaml` 里的 `--env` 键、写在 `.env` 里的 `--env-file` 行，或者写在同一个文件里的 `--config` 键，都将无人再去读取它们。

- `--env <name>`（或 `HANDBOOK_ENV`）选择一套按环境划分的级联——三者中唯一同时具备命令行参数与环境变量两种形式的一项，因为它指名的是一个环境，而不是指向某一个确切文件。
- `--env-file <path>` 只加载那一个文件，绕过下面的级联。
- `--config <path>` 指名一个确切的配置文件，绕过下面这套感知环境的发现流程（默认：从工作目录向上走、在仓库边界处停止所找到的最近的 `handbook.config.yaml` 系列文件）。

### `.env` 级联

在没有 `--env-file` 时，CLI 加载的是一组 `.env*` 文件构成的级联，而不是某一个固定文件，优先级从高到低。既有的 `applyEnvFile` 规则——绝不覆盖已经设置过的键——正是让这套级联无非就是"按这个顺序调用，第一个设置某个键的文件胜出"的原因：

| #   | 文件                | 归属 | 作用范围 | 是否提交？         |
| --- | ------------------- | ---- | -------- | ------------------ |
| 1   | shell 环境          | —    | —        | 始终胜出           |
| 2   | `.env.<name>.local` | 个人 | 仅该环境 | 否（已 gitignore） |
| 3   | `.env.<name>`       | 团队 | 仅该环境 | 是                 |
| 4   | `.env.local`        | 个人 | 所有环境 | 否（已 gitignore） |
| 5   | `.env`              | 团队 | 基线     | 是                 |

第 2、3 行仅在 `--env`/`HANDBOOK_ENV` 指名了某个环境时才适用。**两者都未设置时，只有第 4、5 行会被加载——与这套级联出现之前所加载的完全一致，因此一个没有 `.env.local` 的既有配置不会有任何变化。**

### 带环境名的配置文件发现

除 `--config` 之外，发现流程仍然是从工作目录向上走、在仓库边界处停止，但如今在每个访问到的目录中，它会先检查 `handbook.config.<name>.{yaml,yml,json}`（仅在指名了环境时），然后才是普通的 `handbook.config.yaml` 之类——因此带环境名的文件总是胜过同一目录下的普通文件，哪怕在更靠近工作目录的层级上存在一个普通文件。未指名环境时，发现流程一如既往。

运行 `handbook config` 即可看到当前生效的是哪个环境、以及它究竟按优先级顺序加载了哪些文件——在四层取值之上再叠一套级联，可能的来源已多到无法凭记忆追踪，而一个此命令无法展示的层级，与一个根本不起作用的层级并无区别。

以 `readWorkers` 为例（命令行参数 `--read-workers <n>`，默认 `12`）：

| 界面                      | 扁平形式                | 限定到 `generate`                |
| ------------------------- | ----------------------- | -------------------------------- |
| 环境变量                  | `HANDBOOK_READ_WORKERS` | `HANDBOOK_GENERATE_READ_WORKERS` |
| `handbook.config.yaml` 键 | `readWorkers`           | `generateReadWorkers`            |

配置文件的两种形式可以互换：扁平的 `readWorkers: ...` 与嵌套的 `generate: { readWorkers: ... }` 含义相同，因为文件在被读取之前，会由同一套 camelCase 拼接规则展平。

## `analyze`

| 键         | 命令行参数       | 环境变量             | 类型                                        | 默认值   | 说明                                                                                                                               |
| ---------- | ---------------- | -------------------- | ------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel` | —                | `HANDBOOK_LOG_LEVEL` | enum (debug\|info\|warn\|error\|silent)     | `info`   | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `source`   | `--source <dir>` | `HANDBOOK_SOURCE`    | path                                        | required | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `work`     | `--work <dir>`   | `HANDBOOK_WORK`      | path                                        | required | 存放流水线产物的工作目录；对 skill 可选，用于补充 coverage.json                                                                    |
| `lang`     | `--lang <lang>`  | `HANDBOOK_LANG`      | enum (`auto`, plus any registered language) | `auto`   | 源码语言；auto 会检测并合并所有已注册的语言                                                                                        |

## `generate`

| 键                | 命令行参数                  | 环境变量                                       | 类型                                        | 默认值                      | 说明                                                                                                                               |
| ----------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel`        | —                           | `HANDBOOK_LOG_LEVEL`                           | enum (debug\|info\|warn\|error\|silent)     | `info`                      | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `llmApiKey`       | —                           | `HANDBOOK_LLM_API_KEY`, `OPENAI_API_KEY`       | string                                      | `""` (empty)                | LLM 端点的 API key；无需密钥的本地端点请填 EMPTY。它永远不会是命令行参数，也绝不允许出现在配置文件中                               |
| `llmModel`        | `--model <id>`              | `HANDBOOK_LLM_MODEL`, `OPENAI_MODEL`           | string                                      | `gpt-4o-mini`               | 模型标识符                                                                                                                         |
| `llmBaseUrl`      | `--base-url <url>`          | `HANDBOOK_LLM_BASE_URL`, `OPENAI_BASE_URL`     | string                                      | `https://api.openai.com/v1` | 任意兼容 OpenAI 的端点（托管服务、vLLM、LiteLLM、代理）                                                                            |
| `llmMaxTokens`    | `--max-tokens <n>`          | `HANDBOOK_LLM_MAX_TOKENS`, `OPENAI_MAX_TOKENS` | int                                         | `16000`                     | 每次请求的最大输出 token 数                                                                                                        |
| `llmTimeout`      | `--timeout <sec>`           | `HANDBOOK_LLM_TIMEOUT`, `OPENAI_TIMEOUT`       | int                                         | `300`                       | 单次请求的超时时间（秒）；卡住的调用会被重试，而不是任由它劫持整个阶段                                                             |
| `llmMaxRetries`   | `--llm-retries <n>`         | `HANDBOOK_LLM_MAX_RETRIES`                     | int                                         | `6`                         | 每次请求的重试次数；0 表示只尝试一次                                                                                               |
| `llmRetryBackoff` | `--llm-retry-backoff <sec>` | `HANDBOOK_LLM_RETRY_BACKOFF`                   | int                                         | `3`                         | 重试之间的基础退避时间，单位为秒                                                                                                   |
| `llmConcurrency`  | `--llm-concurrency <n>`     | `HANDBOOK_LLM_CONCURRENCY`                     | int                                         | `16`                        | 单个客户端上并发请求数的全局上限                                                                                                   |
| `llmExtraBody`    | `--extra-body <json>`       | `HANDBOOK_LLM_EXTRA_BODY`, `OPENAI_EXTRA_BODY` | json                                        | —                           | 合并进每个请求体的厂商字段；model/messages/token 类字段无法被覆盖                                                                  |
| `source`          | `--source <dir>`            | `HANDBOOK_SOURCE`                              | path                                        | required                    | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `work`            | `--work <dir>`              | `HANDBOOK_WORK`                                | path                                        | required                    | 存放流水线产物的工作目录；对 skill 可选，用于补充 coverage.json                                                                    |
| `lang`            | `--lang <lang>`             | `HANDBOOK_LANG`                                | enum (`auto`, plus any registered language) | `auto`                      | 源码语言；auto 会检测并合并所有已注册的语言                                                                                        |
| `phase`           | `--phase <spec>`            | `HANDBOOK_PHASE`                               | string                                      | `all`                       | all \| 1 \| 2 \| 2a \| 2b \| 2c \| 3，或以逗号分隔的列表                                                                           |
| `strategy`        | `--strategy <s>`            | `HANDBOOK_STRATEGY`                            | enum (file\|member)                         | —                           | file（默认）或 member；不设置则沿用工作目录中已记录的策略                                                                          |
| `skeleton`        | `--skeleton <path>`         | `HANDBOOK_SKELETON`                            | path                                        | —                           | 用户自行编写的 skeleton.yaml，member 策略下必需                                                                                    |
| `narrateLang`     | `--narrate-lang <l>`        | `HANDBOOK_NARRATE_LANG`                        | enum (en\|zh)                               | `en`                        | 散文叙述语言                                                                                                                       |
| `detail`          | `--detail <d>`              | `HANDBOOK_DETAIL`                              | enum (brief\|deep)                          | `brief`                     | 文件卡片的深度                                                                                                                     |
| `synthMode`       | `--synth-mode <m>`          | `HANDBOOK_SYNTH_MODE`                          | enum (oneshot\|doctor)                      | `oneshot`                   | 骨架合成模式                                                                                                                       |
| `maxDoctorRounds` | `--max-doctor-rounds <n>`   | `HANDBOOK_MAX_DOCTOR_ROUNDS`                   | int                                         | `6`                         | doctor 收敛轮数                                                                                                                    |
| `readWorkers`     | `--read-workers <n>`        | `HANDBOOK_READ_WORKERS`                        | int                                         | `12`                        | 并发的卡片批次数                                                                                                                   |
| `readBatchSize`   | `--read-batch-size <n>`     | `HANDBOOK_READ_BATCH_SIZE`                     | int                                         | —                           | 每个卡片批次的文件数；不设置时，--detail deep 为 1、brief 为 8                                                                     |
| `maxCharsPerFile` | `--max-chars-per-file <n>`  | `HANDBOOK_MAX_CHARS_PER_FILE`                  | int                                         | `0`                         | 每个文件截断到 n 个字符；0 表示不限制                                                                                              |
| `assignBatchSize` | `--assign-batch-size <n>`   | `HANDBOOK_ASSIGN_BATCH_SIZE`                   | int                                         | `25`                        | 每个归属批次的卡片数                                                                                                               |
| `assignWorkers`   | `--assign-workers <n>`      | `HANDBOOK_ASSIGN_WORKERS`                      | int                                         | `12`                        | 并发的归属批次数                                                                                                                   |
| `organizeWorkers` | `--organize-workers <n>`    | `HANDBOOK_ORGANIZE_WORKERS`                    | int                                         | `8`                         | 并发的阶段组织调用数                                                                                                               |
| `narrateWorkers`  | `--narrate-workers <n>`     | `HANDBOOK_NARRATE_WORKERS`                     | int                                         | `8`                         | 并发的叙述调用数                                                                                                                   |
| `resume`          | `--resume`                  | `HANDBOOK_RESUME`                              | bool                                        | `false`                     | 跳过已经有完整卡片的文件                                                                                                           |
| `refresh`         | `--refresh`                 | `HANDBOOK_REFRESH`                             | bool                                        | `false`                     | 忽略 phase-3 的缓存                                                                                                                |
| `llmCache`        | `--llm-cache`               | `HANDBOOK_LLM_CACHE`                           | bool                                        | `false`                     | 将 LLM 的原始回复缓存到 <work>/phase3/cache；--refresh 会禁用它                                                                    |

## `render`

| 键              | 命令行参数                | 环境变量                             | 类型                                    | 默认值            | 说明                                                                           |
| --------------- | ------------------------- | ------------------------------------ | --------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `logLevel`      | —                         | `HANDBOOK_LOG_LEVEL`                 | enum (debug\|info\|warn\|error\|silent) | `info`            | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写             |
| `work`          | `--work <dir>`            | `HANDBOOK_WORK`                      | path                                    | required          | 存放流水线产物的工作目录；对 skill 可选，用于补充 coverage.json                |
| `title`         | `--title <title>`         | `HANDBOOK_TITLE`                     | string                                  | `System Handbook` | 渲染输出所用的 handbook 标题                                                   |
| `out`           | `--out <dir>`             | `HANDBOOK_RENDER_OUT` _(限定作用域)_ | path                                    | —                 | 输出位置；render 默认为 <work>/handbook，plan 写出一个文件，skill 写出一个目录 |
| `html`          | `--html`                  | `HANDBOOK_HTML`                      | bool                                    | `false`           | 同时在 <out>/html 下渲染多页 HTML 站点                                         |
| `htmlSingle`    | `--html-single`           | `HANDBOOK_HTML_SINGLE`               | bool                                    | `false`           | 同时渲染一个自包含的单页 HTML                                                  |
| `agentSite`     | `--agent-site`            | `HANDBOOK_AGENT_SITE`                | bool                                    | `false`           | 同时在 <out>/agent 下渲染供 agent 使用的定位索引                               |
| `llmsTxt`       | `--llms-txt`              | `HANDBOOK_LLMS_TXT`                  | bool                                    | `false`           | 同时在 markdown 旁写出 llms.txt 与 llms-full.txt                               |
| `sourceBaseUrl` | `--source-base-url <url>` | `HANDBOOK_SOURCE_BASE_URL`           | string                                  | —                 | 将文件卡片链接到 <url>/<relative path> 处的源码                                |

## `skill`

| 键         | 命令行参数          | 环境变量                                  | 类型                                    | 默认值   | 说明                                                                                                                               |
| ---------- | ------------------- | ----------------------------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel` | —                   | `HANDBOOK_LOG_LEVEL`                      | enum (debug\|info\|warn\|error\|silent) | `info`   | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `source`   | `--source <dir>`    | `HANDBOOK_SOURCE`                         | path                                    | —        | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `work`     | `--work <dir>`      | `HANDBOOK_WORK`                           | path                                    | —        | 存放流水线产物的工作目录；对 skill 可选，用于补充 coverage.json                                                                    |
| `out`      | `--out <dir>`       | `HANDBOOK_SKILL_OUT` _(限定作用域)_       | path                                    | required | 输出位置；render 默认为 <work>/handbook，plan 写出一个文件，skill 写出一个目录                                                     |
| `handbook` | `--handbook <dir>`  | `HANDBOOK_SKILL_HANDBOOK` _(限定作用域)_  | path                                    | required | 已渲染的 handbook 目录；对 skill 必需，对 plan 是可选的上下文                                                                      |
| `name`     | `--name <slug>`     | `HANDBOOK_NAME`                           | string                                  | required | skill 的 slug（小写加连字符）                                                                                                      |
| `project`  | `--project <name>`  | `HANDBOOK_PROJECT`                        | string                                  | —        | 用于行文的人类可读项目名                                                                                                           |
| `agentDir` | `--agent-dir <dir>` | `HANDBOOK_AGENT_DIR`                      | path                                    | —        | 已渲染的 agent 定位站点；随包发布到 references/agent/ 下                                                                           |
| `bodyLang` | `--lang <l>`        | `HANDBOOK_SKILL_BODY_LANG` _(限定作用域)_ | enum (en\|zh)                           | `en`     | SKILL.md 正文语言；frontmatter 保持英文以便路由                                                                                    |

## `validate`

| 键         | 命令行参数       | 环境变量             | 类型                                    | 默认值   | 说明                                                                                                                               |
| ---------- | ---------------- | -------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel` | —                | `HANDBOOK_LOG_LEVEL` | enum (debug\|info\|warn\|error\|silent) | `info`   | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `source`   | `--source <dir>` | `HANDBOOK_SOURCE`    | path                                    | —        | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `skill`    | `--skill <dir>`  | `HANDBOOK_SKILL`     | path                                    | required | 待校验的 skill 目录                                                                                                                |

## `plan`

| 键                | 命令行参数                  | 环境变量                                       | 类型                                    | 默认值                      | 说明                                                                                                                               |
| ----------------- | --------------------------- | ---------------------------------------------- | --------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel`        | —                           | `HANDBOOK_LOG_LEVEL`                           | enum (debug\|info\|warn\|error\|silent) | `info`                      | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `llmApiKey`       | —                           | `HANDBOOK_LLM_API_KEY`, `OPENAI_API_KEY`       | string                                  | `""` (empty)                | LLM 端点的 API key；无需密钥的本地端点请填 EMPTY。它永远不会是命令行参数，也绝不允许出现在配置文件中                               |
| `llmModel`        | `--model <id>`              | `HANDBOOK_LLM_MODEL`, `OPENAI_MODEL`           | string                                  | `gpt-4o-mini`               | 模型标识符                                                                                                                         |
| `llmBaseUrl`      | `--base-url <url>`          | `HANDBOOK_LLM_BASE_URL`, `OPENAI_BASE_URL`     | string                                  | `https://api.openai.com/v1` | 任意兼容 OpenAI 的端点（托管服务、vLLM、LiteLLM、代理）                                                                            |
| `llmMaxTokens`    | `--max-tokens <n>`          | `HANDBOOK_LLM_MAX_TOKENS`, `OPENAI_MAX_TOKENS` | int                                     | `16000`                     | 每次请求的最大输出 token 数                                                                                                        |
| `llmTimeout`      | `--timeout <sec>`           | `HANDBOOK_LLM_TIMEOUT`, `OPENAI_TIMEOUT`       | int                                     | `300`                       | 单次请求的超时时间（秒）；卡住的调用会被重试，而不是任由它劫持整个阶段                                                             |
| `llmMaxRetries`   | `--llm-retries <n>`         | `HANDBOOK_LLM_MAX_RETRIES`                     | int                                     | `6`                         | 每次请求的重试次数；0 表示只尝试一次                                                                                               |
| `llmRetryBackoff` | `--llm-retry-backoff <sec>` | `HANDBOOK_LLM_RETRY_BACKOFF`                   | int                                     | `3`                         | 重试之间的基础退避时间，单位为秒                                                                                                   |
| `llmConcurrency`  | `--llm-concurrency <n>`     | `HANDBOOK_LLM_CONCURRENCY`                     | int                                     | `16`                        | 单个客户端上并发请求数的全局上限                                                                                                   |
| `llmExtraBody`    | `--extra-body <json>`       | `HANDBOOK_LLM_EXTRA_BODY`, `OPENAI_EXTRA_BODY` | json                                    | —                           | 合并进每个请求体的厂商字段；model/messages/token 类字段无法被覆盖                                                                  |
| `source`          | `--source <dir>`            | `HANDBOOK_SOURCE`                              | path                                    | required                    | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `out`             | `--out <dir>`               | `HANDBOOK_PLAN_OUT` _(限定作用域)_             | path                                    | —                           | 输出位置；render 默认为 <work>/handbook，plan 写出一个文件，skill 写出一个目录                                                     |
| `handbook`        | `--handbook <dir>`          | `HANDBOOK_PLAN_HANDBOOK` _(限定作用域)_        | path                                    | —                           | 已渲染的 handbook 目录；对 skill 必需，对 plan 是可选的上下文                                                                      |
| `request`         | `--request <text>`          | `HANDBOOK_REQUEST`                             | string                                  | required                    | 用自然语言表述的变更请求                                                                                                           |
| `maxTurns`        | `--max-turns <n>`           | `HANDBOOK_MAX_TURNS`                           | int                                     | `30`                        | agent 的轮次预算                                                                                                                   |

## `apply`

| 键           | 命令行参数            | 环境变量               | 类型                                    | 默认值   | 说明                                                                                                                               |
| ------------ | --------------------- | ---------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel`   | —                     | `HANDBOOK_LOG_LEVEL`   | enum (debug\|info\|warn\|error\|silent) | `info`   | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `source`     | `--source <dir>`      | `HANDBOOK_SOURCE`      | path                                    | required | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `plan`       | `--plan <file>`       | `HANDBOOK_PLAN`        | path                                    | required | 由 `handbook plan` 生成的方案文件                                                                                                  |
| `dryRun`     | `--dry-run`           | `HANDBOOK_DRY_RUN`     | bool                                    | `false`  | 只做校验，绝不写入                                                                                                                 |
| `backupRoot` | `--backup-root <dir>` | `HANDBOOK_BACKUP_ROOT` | path                                    | —        | 备份的存放位置；默认为 <source>/.handbook-patches                                                                                  |

## `rollback`

| 键         | 命令行参数       | 环境变量             | 类型                                    | 默认值   | 说明                                                                                                                               |
| ---------- | ---------------- | -------------------- | --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `logLevel` | —                | `HANDBOOK_LOG_LEVEL` | enum (debug\|info\|warn\|error\|silent) | `info`   | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                                 |
| `source`   | `--source <dir>` | `HANDBOOK_SOURCE`    | path                                    | —        | 源码根目录；analyze/generate/plan/apply 必需，其余场景可选（validate/skill 用于哈希新鲜度判断，rollback 用于确定备份所属的文件树） |
| `backup`   | `--backup <dir>` | `HANDBOOK_BACKUP`    | path                                    | required | 包含 manifest.json 的备份目录                                                                                                      |
| `force`    | `--force`        | `HANDBOOK_FORCE`     | bool                                    | `false`  | 即便文件在打补丁之后被改动过也照样恢复                                                                                             |

## `resync`

| 键                | 命令行参数                  | 环境变量                                       | 类型                                    | 默认值                      | 说明                                                                                                 |
| ----------------- | --------------------------- | ---------------------------------------------- | --------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `logLevel`        | —                           | `HANDBOOK_LOG_LEVEL`                           | enum (debug\|info\|warn\|error\|silent) | `info`                      | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                   |
| `llmApiKey`       | —                           | `HANDBOOK_LLM_API_KEY`, `OPENAI_API_KEY`       | string                                  | `""` (empty)                | LLM 端点的 API key；无需密钥的本地端点请填 EMPTY。它永远不会是命令行参数，也绝不允许出现在配置文件中 |
| `llmModel`        | `--model <id>`              | `HANDBOOK_LLM_MODEL`, `OPENAI_MODEL`           | string                                  | `gpt-4o-mini`               | 模型标识符                                                                                           |
| `llmBaseUrl`      | `--base-url <url>`          | `HANDBOOK_LLM_BASE_URL`, `OPENAI_BASE_URL`     | string                                  | `https://api.openai.com/v1` | 任意兼容 OpenAI 的端点（托管服务、vLLM、LiteLLM、代理）                                              |
| `llmMaxTokens`    | `--max-tokens <n>`          | `HANDBOOK_LLM_MAX_TOKENS`, `OPENAI_MAX_TOKENS` | int                                     | `16000`                     | 每次请求的最大输出 token 数                                                                          |
| `llmTimeout`      | `--timeout <sec>`           | `HANDBOOK_LLM_TIMEOUT`, `OPENAI_TIMEOUT`       | int                                     | `300`                       | 单次请求的超时时间（秒）；卡住的调用会被重试，而不是任由它劫持整个阶段                               |
| `llmMaxRetries`   | `--llm-retries <n>`         | `HANDBOOK_LLM_MAX_RETRIES`                     | int                                     | `6`                         | 每次请求的重试次数；0 表示只尝试一次                                                                 |
| `llmRetryBackoff` | `--llm-retry-backoff <sec>` | `HANDBOOK_LLM_RETRY_BACKOFF`                   | int                                     | `3`                         | 重试之间的基础退避时间，单位为秒                                                                     |
| `llmConcurrency`  | `--llm-concurrency <n>`     | `HANDBOOK_LLM_CONCURRENCY`                     | int                                     | `16`                        | 单个客户端上并发请求数的全局上限                                                                     |
| `llmExtraBody`    | `--extra-body <json>`       | `HANDBOOK_LLM_EXTRA_BODY`, `OPENAI_EXTRA_BODY` | json                                    | —                           | 合并进每个请求体的厂商字段；model/messages/token 类字段无法被覆盖                                    |
| `work`            | `--work <dir>`              | `HANDBOOK_WORK`                                | path                                    | required                    | 存放流水线产物的工作目录；对 skill 可选，用于补充 coverage.json                                      |
| `title`           | `--title <title>`           | `HANDBOOK_TITLE`                               | string                                  | `System Handbook`           | 渲染输出所用的 handbook 标题                                                                         |
| `case`            | `--case <dir>`              | `HANDBOOK_CASE`                                | path                                    | required                    | case 目录：edited/ + plan.md + change.diff                                                           |
| `useLlm`          | `--no-llm`                  | `HANDBOOK_USE_LLM`                             | bool                                    | `true`                      | 设为 false 则只做结构性刷新，并把散文标记为陈旧                                                      |
| `refreshRendered` | `--no-render`               | `HANDBOOK_REFRESH_RENDERED`                    | bool                                    | `true`                      | 设为 false 可跳过刷新 <work>/handbook 下已渲染的产物                                                 |
| `corrections`     | `--corrections <file>`      | `HANDBOOK_CORRECTIONS`                         | path                                    | —                           | agent 上报的 corrections.jsonl；其中涉及的文件会扩大刷新范围                                         |
| `cardDetail`      | `--detail <d>`              | `HANDBOOK_RESYNC_CARD_DETAIL` _(限定作用域)_   | enum (brief\|deep)                      | —                           | 重新生成卡片时的深度；不设置则与既有 handbook 保持一致                                               |
| `proseLang`       | `--narrate-lang <l>`        | `HANDBOOK_RESYNC_PROSE_LANG` _(限定作用域)_    | enum (en\|zh)                           | —                           | 重新生成卡片时的散文语言；不设置则与既有 handbook 保持一致                                           |

## `studio`

| 键                | 命令行参数                  | 环境变量                                       | 类型                                    | 默认值                      | 说明                                                                                                      |
| ----------------- | --------------------------- | ---------------------------------------------- | --------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `logLevel`        | —                           | `HANDBOOK_LOG_LEVEL`                           | enum (debug\|info\|warn\|error\|silent) | `info`                      | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                        |
| `llmApiKey`       | —                           | `HANDBOOK_LLM_API_KEY`, `OPENAI_API_KEY`       | string                                  | `""` (empty)                | LLM 端点的 API key；无需密钥的本地端点请填 EMPTY。它永远不会是命令行参数，也绝不允许出现在配置文件中      |
| `llmModel`        | `--model <id>`              | `HANDBOOK_LLM_MODEL`, `OPENAI_MODEL`           | string                                  | `gpt-4o-mini`               | 模型标识符                                                                                                |
| `llmBaseUrl`      | `--base-url <url>`          | `HANDBOOK_LLM_BASE_URL`, `OPENAI_BASE_URL`     | string                                  | `https://api.openai.com/v1` | 任意兼容 OpenAI 的端点（托管服务、vLLM、LiteLLM、代理）                                                   |
| `llmMaxTokens`    | `--max-tokens <n>`          | `HANDBOOK_LLM_MAX_TOKENS`, `OPENAI_MAX_TOKENS` | int                                     | `16000`                     | 每次请求的最大输出 token 数                                                                               |
| `llmTimeout`      | `--timeout <sec>`           | `HANDBOOK_LLM_TIMEOUT`, `OPENAI_TIMEOUT`       | int                                     | `300`                       | 单次请求的超时时间（秒）；卡住的调用会被重试，而不是任由它劫持整个阶段                                    |
| `llmMaxRetries`   | `--llm-retries <n>`         | `HANDBOOK_LLM_MAX_RETRIES`                     | int                                     | `6`                         | 每次请求的重试次数；0 表示只尝试一次                                                                      |
| `llmRetryBackoff` | `--llm-retry-backoff <sec>` | `HANDBOOK_LLM_RETRY_BACKOFF`                   | int                                     | `3`                         | 重试之间的基础退避时间，单位为秒                                                                          |
| `llmConcurrency`  | `--llm-concurrency <n>`     | `HANDBOOK_LLM_CONCURRENCY`                     | int                                     | `16`                        | 单个客户端上并发请求数的全局上限                                                                          |
| `llmExtraBody`    | `--extra-body <json>`       | `HANDBOOK_LLM_EXTRA_BODY`, `OPENAI_EXTRA_BODY` | json                                    | —                           | 合并进每个请求体的厂商字段；model/messages/token 类字段无法被覆盖                                         |
| `port`            | `--port <n>`                | `HANDBOOK_PORT`                                | int                                     | `4860`                      | 监听的端口                                                                                                |
| `host`            | `--host <addr>`             | `HANDBOOK_HOST`                                | string                                  | `127.0.0.1`                 | 绑定地址；除非显式设置，否则一直留在回环地址上（容器中需要 0.0.0.0）。CSRF 防护仍然要求 Host 头是回环地址 |
| `stateDir`        | `--state-dir <dir>`         | `HANDBOOK_STATE_DIR`                           | path                                    | —                           | studio.json 与受管工作目录的存放位置；默认为 $HOME/.handbook-studio                                       |

## `config`

| 键           | 命令行参数         | 环境变量               | 类型                                    | 默认值  | 说明                                                                                                                         |
| ------------ | ------------------ | ---------------------- | --------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `logLevel`   | —                  | `HANDBOOK_LOG_LEVEL`   | enum (debug\|info\|warn\|error\|silent) | `info`  | 日志详细程度；-v/--verbose 与 -q/--quiet 分别是 debug/error 的简写                                                           |
| `forCommand` | `--command <name>` | `HANDBOOK_FOR_COMMAND` | string                                  | —       | 只显示适用于该子命令的设置；这里可以查看它的环境变量／文件／默认值各层，但看不到该命令自身的命令行参数（那些要传给命令本身） |
| `json`       | `--json`           | `HANDBOOK_JSON`        | bool                                    | `false` | 机器可读的输出                                                                                                               |
| `check`      | `--check`          | `HANDBOOK_CHECK`       | bool                                    | `false` | 只做校验；一旦有任何无效或缺失项即以非零码退出                                                                               |
