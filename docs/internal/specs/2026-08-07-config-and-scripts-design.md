# 配置面与脚本体系设计（配置登记表）

日期：2026-08-07 · 状态：已批准，待实施

## 目标与背景

用户提了三件事：`package.json` 的 scripts 不够优雅也不够全面；`.env.example` 配置化太少，
应与史诗级大型项目对齐；`.env.example` 与命令行参数应当兼容，两者都能跑。

这三件事是**同一个根因**：没有任何一个地方声明"一项配置是什么"。每个开关都是在它被需要的
那一天就地接线的，于是 `.env.example` 因为手写而单薄，flag 与 env 因为各接各的而互不相通。

**现状盘点（已逐一核对代码，不是印象）**：

| 维度 | 事实 |
|---|---|
| 全仓读取的环境变量 | 12 个：`OPENAI_{API_KEY,MODEL,BASE_URL,MAX_TOKENS,TIMEOUT,EXTRA_BODY}`、`HANDBOOK_LLM_*` 别名、`HANDBOOK_{TITLE,LLM_MAX_RETRIES,LLM_RETRY_BACKOFF}`、`HOME`、`MOCK_DELAY_MS` |
| CLI flag | 11 个子命令约 45 个 |
| **flag 与 env 都能设**的项 | **恰好 1 个** —— `--title` ↔ `HANDBOOK_TITLE`（`render-refresh.ts:30`） |
| LLM 配置 | **只有 env**：`--model` / `--base-url` / `--max-tokens` / `--timeout` 这些 flag 根本不存在 |
| 两头都到不了的能力 | `GenerateOptions` 里 `readBatchSize`、`maxCharsPerFile`、`assignBatchSize`、`assignWorkers`、`organizeWorkers`、`narrateWorkers` 六个字段真实存在且被 `generate.ts` 使用，但既无 flag 也无 env |

scripts 侧：`tsc -b &&` 被复制 12 次；11 个 CLI 透传脚本里有 10 个是同一个字符串改一个词；
命名不成体系（`version-packages` / `release` / `changeset` 三种风格，`smoke:install` 游离在
`check:*` 家族之外）；缺 watch、缺 CI 入口、缺 `clean:all`、缺任何校验配置的手段。

## 设计

### 1. 一张登记表，四个消费者（`packages/core/src/config/`）

配置登记表是唯一事实来源。每项配置只声明一次：

```ts
{ key: 'readWorkers', flag: '--read-workers <n>', type: 'int', min: 1,
  default: 12, commands: ['generate'], doc: 'concurrent card batches' }

{ key: 'llmModel', flag: '--model <id>', type: 'string', default: 'gpt-4o-mini',
  envAliases: ['OPENAI_MODEL'], commands: ['generate', 'plan', 'resync', 'studio'] }

{ key: 'llmApiKey', type: 'string', secret: true, default: '',
  envAliases: ['OPENAI_API_KEY'], commands: ['generate', 'plan', 'resync', 'studio'] }
  // secret: true ⇒ 不生成 flag、不允许出现在配置文件里
```

读这张表的只有四个地方，别处一律不许再写配置常量：

1. `main.ts` —— 按 `commands` 为每个子命令**派生** commander 选项
2. 解析器 `resolve.ts` —— 按分层优先级求值
3. `.env.example` 生成器
4. `docs/configuration.md` 生成器

新增一项配置从此是一行改动，CLI、env、配置文件、`.env.example`、文档五处同时出现——
或者构建失败。这正是 `--lang` 帮助文本曾落后注册表五门语言、README 曾落后六门语言时
学到的东西：能派生的绝不手写，不能派生的用测试钉住。

`type` 取值：`string | int | bool | enum | path | json`。`enum` 必须带 `choices`，
`int` 必须带 `min`——由登记表自检测试保证，声明不全就构建失败。

### 2. 一条命名规则，三个界面

同一个变换覆盖三个界面，因此不需要记任何对照表：

| 登记表 key | env（扁平） | env（带命令前缀，优先） | 配置文件 |
|---|---|---|---|
| `readWorkers` | `HANDBOOK_READ_WORKERS` | `HANDBOOK_GENERATE_READ_WORKERS` | `readWorkers:` 或 `generate: { readWorkers: }` |
| `detail` | `HANDBOOK_DETAIL` | `HANDBOOK_RESYNC_DETAIL` | `detail:` 或 `resync: { detail: }` |
| `llmModel` | `HANDBOOK_LLM_MODEL` | —— | `llm: { model: }` 或 `llmModel:` |

配置文件按 **camelCase 拼接**扁平化嵌套映射，于是"命令分节"（`generate:`）和"配置分组"
（`llm:`）不需要各自的特例代码：`generate.detail` → `generateDetail`，与 env 的加前缀
是同一条规则。`HANDBOOK_LLM_MODEL` 今天已经作为别名存在，这条约定是代码已经走了一半的那条。

同一来源内，**带命令前缀的胜过扁平的**。注册规则说全，避免实施时二次判断：

- 带前缀的名字**永远**注册。
- 扁平名**默认也注册**——包括只属于单个命令的项（`HANDBOOK_READ_WORKERS` 只有 generate 认，
  但它不存在歧义，扁平写法更顺手）。
- **唯一例外**是跨命令语义不同的项：`--out` 在 render/skill/plan 里指三样东西、`--lang` 在
  generate 里是源码语言而在 skill 里是行文语言。这类项登记表标 `scopedOnly: true`，
  **只有** `HANDBOOK_RENDER_OUT` / `HANDBOOK_SKILL_LANG` 这样的名字，没有扁平名。

### 3. 分层与优先级

```
CLI flag  >  shell env  >  .env 文件  >  handbook.config.yaml  >  默认值
```

`.env` 本来就不覆盖 shell（`applyEnvFile` 的既有语义），配置文件插在 env 之下。

配置文件发现顺序：`--config <path>`（显式，文件不存在则**大声失败**）；否则从 cwd 起
向上查找最近的 `handbook.config.yaml` / `.yml` / `.json`，到 git 根或文件系统根为止。

`.env` 保持只看 cwd（`main.ts` 既有行为，不动它），配置文件却向上查找——这处不对称是刻意的：
`.env` 是"我这台机器此刻的环境"，改它的发现规则会改变既有行为；配置文件是"这个项目的设定"，
在仓库子目录里执行命令时应当仍然生效。
YAML 解析用工作区 catalog 里已有的 `yaml@^2.9.0`（`pipeline` 已在用，`core` 加一条
`"catalog:"` 依赖即可，不引入新第三方版本——第三方版本只许住在 `pnpm-workspace.yaml`）。

**`type: 'path'` 的解析基准取决于来源**：来自 flag / env 的相对路径按 cwd 解析；来自
配置文件的按**该配置文件所在目录**解析。配置文件应当可以随仓库移动而不失效，这也是
tsconfig / eslint 的做法。

### 4. 两处刻意的不对称

- **`--config` 与 `--env-file` 只在引导层**。它们不能被自己加载的东西设置，因此不进登记表的
  常规解析，而是在 `preAction` 里最先处理。
- **`llmApiKey` 只能来自 env / `.env`**。不给 `--api-key` flag（shell history、`ps` 输出），
  且一旦出现在 `handbook.config.yaml` 里就**报错退出**并指明改用 `.env`——配置文件是要提交
  进 git 的。这条由登记表的 `secret: true` 统一实施，不是一处手写判断。

### 5. 配置面清单（约 60 项）

全部从**已经存在的能力**推导，不发明新功能。

**新增的 8 个 LLM flag**（今天完全不存在），作用于 `generate` / `plan` / `resync` / `studio`：

| flag | key | env（含既有别名） |
|---|---|---|
| `--model <id>` | `llmModel` | `HANDBOOK_LLM_MODEL` / `OPENAI_MODEL` |
| `--base-url <url>` | `llmBaseUrl` | `HANDBOOK_LLM_BASE_URL` / `OPENAI_BASE_URL` |
| `--max-tokens <n>` | `llmMaxTokens` | `HANDBOOK_LLM_MAX_TOKENS` / `OPENAI_MAX_TOKENS` |
| `--timeout <sec>` | `llmTimeout` | `HANDBOOK_LLM_TIMEOUT` / `OPENAI_TIMEOUT` |
| `--llm-retries <n>` | `llmMaxRetries` | `HANDBOOK_LLM_MAX_RETRIES` |
| `--llm-retry-backoff <sec>` | `llmRetryBackoff` | `HANDBOOK_LLM_RETRY_BACKOFF` |
| `--llm-concurrency <n>` | `llmConcurrency` | `HANDBOOK_LLM_CONCURRENCY`（客户端既有默认 16） |
| `--extra-body <json>` | `llmExtraBody` | `HANDBOOK_LLM_EXTRA_BODY` / `OPENAI_EXTRA_BODY` |

**六个孤儿调优项**补齐 flag + env：`--read-batch-size`、`--max-chars-per-file`、
`--assign-batch-size`、`--assign-workers`、`--organize-workers`、`--narrate-workers`。

**既有每一个 flag 都获得 env 与配置文件键**，包括可取反的开关。`--no-llm` / `--no-render`
的 key 取 `useLlm` / `refreshRendered`（不取 `llm`，否则扁平名 `HANDBOOK_LLM` 会与 `llm*`
分组撞概念），env 写 `HANDBOOK_RESYNC_USE_LLM=false`，配置文件写 `resync: { useLlm: false }`。

既有的 `--llm-cache` 归入同一分组：key `llmCache`、env `HANDBOOK_LLM_CACHE`、
配置文件 `llm: { cache: true }`；`--refresh` 关掉它的既有语义不变。

**日志等级**：新增 `logLevel` 枚举（`debug|info|error`，默认 `info`），env `HANDBOOK_LOG_LEVEL`；
`-v/--verbose` 与 `-q/--quiet` 保留为它的语法糖。

**`bool` 的 env 取值**：`1|true|yes|on` 与 `0|false|no|off`（不分大小写），其余大声失败。

**"必填"改由解析后判定**。`--source` / `--work` 今天是 `requiredOption`；一旦 env 与配置文件
也能提供，commander 的 required 就必须撤掉，改由解析器在求值完成后检查缺失，并在报错里
同时给出三种供给方式。这带来一个行为改进：`.env` 里设了 `HANDBOOK_SOURCE`，`handbook analyze`
就能直接跑。

### 6. 新增 `handbook config` 子命令

打印每一项的**最终值及其来源**，这是"两者都能跑"从口头承诺变成可验证事实的地方：

```
$ handbook config --command generate
work          /repo/.handbook   flag --work
detail        deep              env HANDBOOK_DETAIL
llmModel      gpt-4o            file handbook.config.yaml (llm.model)
llmApiKey     sk-…4f2a          env OPENAI_API_KEY  (masked)
readWorkers   12                default
```

`--json` 供脚本消费；`--check` 只校验、非零退出；secret 一律打码，无 `--show-secrets`。

### 7. 生成物与漂移测试

`.env.example` 与 `docs/configuration.md`（英文，两个 README 都链到它，中文 README 另加
一段中文引导）由 `scripts/gen-config-docs.mjs` 生成；vitest 漂移测试重新生成并与仓库内文件
逐字节比对，不一致就构建失败——与 `docs-drift.test.ts` 同一套路数。

同时新增一个测试：README 里出现的每个 `pnpm <script>` 都必须真实存在。第 8 节的重命名正是
会引入这种失效的改动，所以顺手把这一类钉住。

### 8. package.json scripts

原则：**命令字符串零重复**，`check` 由具名脚本组合而成；11 个 CLI 透传全部委托给单一
`cli` 脚本。已实测 `pnpm run` 嵌套两层仍能透传参数
（`pnpm run gen --source y --resume` → `ARGV: ["generate","--source","y","--resume"]`）。

```
build  build:watch  clean  clean:all
typecheck  lint  lint:fix  format  format:check
test  test:watch  test:coverage
check  check:all  check:workspace  check:packaging  check:install
ci
release:version  release:publish  release:status
config:docs
cli  +  11 个薄委托   demo  demo:self  demo:self:real  mock-llm  prepare
```

- `lint` 自带 `--max-warnings 0`（`check` 过去把它内联，家族内不一致）
- `check` = `typecheck && check:workspace && lint && format:check && test:coverage`
- `smoke:install` → `check:install`；`release` → `release:publish`；`version-packages` → `release:version`
- `clean:all` 需要给 `clean.mjs` 加一个 `--node-modules` 开关，保持它跨平台的初衷，不用 `rm -rf`
- 不做 `test:ui`：要为一个此处没人用的流程引入 `@vitest/ui` 新依赖

**重命名的调用方必须同步改**：`.github/workflows/ci.yml`（`pnpm smoke:install`）、
`release.yml`（`pnpm release`、`pnpm version-packages`）、以及两个 README 共 4 处引用。

## 实施分期

一份计划，四个阶段，每阶段结束都应是 `pnpm check` 绿的可提交状态。第 4 阶段与前三阶段
互不依赖，可以先做以尽早拿到收益。

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| 1 | `core` 登记表 + 解析器（flag / env 两层）+ 自检与优先级测试 | 解析器单测全绿，尚未接入 CLI |
| 2 | `main.ts` 改为派生选项；补齐 8 个 LLM flag 与 6 个孤儿调优项；LLM 非法值改为大声失败 | 每个子命令 flag 与 env 双向可用；e2e 与 smoke-install 仍绿 |
| 3 | `handbook.config.yaml` 层 + `handbook config` 子命令 + 生成 `.env.example` 与 `docs/configuration.md` + 漂移测试 | 三个界面一致，漂移测试能挡住手改 |
| 4 | scripts 重构 + `clean.mjs --node-modules` + CI 与 README 的重命名同步 | `pnpm ci` 走通，脚本名漂移测试绿 |

## 测试计划

- **登记表自检**：key / env 名 / 同一命令内 flag 名唯一；`enum` 必有 `choices`、`int` 必有 `min`；
  `secret` 项必无 flag。声明不全即失败。
- **解析器**：优先级矩阵（flag > shell env > `.env` > 文件 > 默认）；前缀名胜扁平名；别名；
  `bool/int/enum/json` 的非法值报错**指明来源**；`path` 的解析基准随来源不同；配置文件里
  出现 secret 被拒；解析后必填检查。
- **CLI**：每个子命令派生出的 commander 选项与登记表一致；**动作时求值**——模块加载后才写入
  的 env 仍生效（把 `render-refresh.ts:19` 记录的那个教训钉成测试）；`config --json` 的来源标注。
- **LLM**：非法数值由静默兜底改为大声失败，更新 `client.ts` 既有的相应测试。
- **漂移**：`.env.example` 与 `docs/configuration.md` 重新生成后逐字节一致；README 提到的
  pnpm 脚本都存在。
- **端到端**：`examples/run-demo.sh` 仍通过；`smoke-install.mjs` 仍能驱动 CLI 走完全程。

## 风险与约束

- **求值时机**：必须在 action 时求值，不能在模块加载时。`render-refresh.ts:19` 写清了原因——
  提前读会在 `preAction` 应用 env 文件之前抓到 shell 的值，导致 env 文件里的设置被静默忽略。
- **覆盖率地板**：`@handbook/cli` 23.8%、`core` 86.5%，且地板是**按包**的。登记表与解析器是
  纯逻辑，放 `core` 并配真测试；cli 侧只留薄接线（`main.ts` 应当变短，因为选项改为派生）。
  以 `pnpm check` 绿为准，**不许调阈值**。
- **`resolveLlmEnv` 的宽容行为是刻意的**（`client.ts:83` 有注释），改成大声失败是**破坏性变更**，
  需要在 changeset 里写明。
- **studio** 的作业配置也必须走同一个解析器，否则 studio 里跑的 generate 不认 `.env` 与配置文件。
- `--no-llm` 在 commander 里映射为 `opts.llm === false`，与登记表的取反声明需要对齐验证。

## 非目标

密钥管理系统集成；远程 / 分布式配置；按目录或按文件的 override；配置文档的中英双语
（约 60 项写两遍描述并保持同步的代价不划算，中文 README 给引导段即可）；`test:ui`。
