# @handbook/cli

[English](README.md) · **中文**

> `handbook` 命令。十一个子命令、一套配置模型，
> 外加一个能告诉你**每个值到底从哪来**的 `config` 命令。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fcli-6366f1?style=flat-square)](https://www.npmjs.com/package/@handbook/cli)

---

## 安装

```bash
npm i -g @handbook/cli
handbook --help
```

或者，从 monorepo 的克隆里：

```bash
pnpm install && pnpm build
alias handbook="node $(pwd)/packages/cli/dist/main.js"
```

或者用 pnpm 快捷方式，它们会先构建、再把参数直接透传：

```bash
pnpm analyze --source ~/code/proj --work work/proj
pnpm handbook --help
```

---

## 十一个子命令

| 命令       | 做什么                                                  | 用 LLM？ |
| ---------- | ------------------------------------------------------- | :------: |
| `analyze`  | 只跑阶段 1 —— 构建静态调用图                            |    ❌    |
| `generate` | 完整管线（阶段 1、2a、2b、2c、3）                       |    ✅    |
| `render`   | work dir → markdown / HTML 站点 / agent 索引 / llms.txt |    ❌    |
| `skill`    | 渲染好的手册 → agent SKILL 包                           |    ❌    |
| `validate` | 检查 SKILL 包的结构与新鲜度                             |    ❌    |
| `plan`     | 手册驱动的变更定位 → 修改计划                           |    ✅    |
| `apply`    | 逐字节应用计划的 EDIT 块，带备份                        |    ❌    |
| `rollback` | 从补丁备份还原源码树                                    |    ❌    |
| `resync`   | 代码变更后把手册前滚                                    |    ✅    |
| `studio`   | 启动本地 Web UI                                         |    ✅    |
| `config`   | 打印解析后的配置及其来源                                |    ❌    |

每个子命令都支持 `--help`，而且这份帮助是**从配置 registry 生成的**——
所以每个参数都附带它的环境变量、它的命令域变量，以及默认值：

```
--read-workers <n>   concurrent card batches
                     [env: HANDBOOK_READ_WORKERS, or scoped: HANDBOOK_GENERATE_READ_WORKERS]
                     (default: 12)
```

---

## 全局参数

| 参数                | 作用                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-v, --verbose`     | debug 级日志（`--log-level debug` 的简写）                                                                                                                                                                                                                                            |
| `-q, --quiet`       | 只输出错误（**优先于 `-v`**）                                                                                                                                                                                                                                                         |
| `--env <name>`      | 选择环境 —— 在 `.env.local` 和 `.env` **之前**加载 `.env.<name>.local` 和 `.env.<name>`，并优先选用 `handbook.config.<name>.yaml`                                                                                                                                                     |
| `--env-file <path>` | 只加载这一个文件，绕过 `.env` 级联。**文件不存在是响亮的错误，不是回退**。**建议改用 `HANDBOOK_ENV_FILE`**：Node >= 20.6 自己也有 `--env-file`，且会预扫描整个命令行，所以路径不存在时会在本 CLI 启动**之前**就以 `node: <path>: not found`（退出码 9）死掉。两者同时给出时 flag 优先 |
| `--config <path>`   | 用这个配置文件，而不是去发现最近的 `handbook.config.yaml`                                                                                                                                                                                                                             |

---

## 配置，一张图说完

```
CLI 参数  >  shell 环境变量  >  .env 级联  >  handbook.config.yaml  >  registry 默认值
```

每个设置在 `@handbook/core` 的 registry 里只声明一次。你看到的参数、能用的环境变量、
被接受的 YAML 键、`.env.example`、`handbook.config.example.yaml` 和
`docs/configuration.md`，**全都是从那一张表生成的**。
它们不可能互相漂移，因为漂移测试会逐字节比对。

### 执行顺序，以及它为什么重要

```
1. 读 --env / HANDBOOK_ENV                      ← 下面每一步都依赖它
2. 把 .env 级联并入 process.env                  ← 好让第 3 步能看到 HANDBOOK_*
3. 发现并加载配置文件                            ← 在 env 之后：它的优先级更低
4. 解析**本次命令**的设置                        ← 参数 > env > 文件 > 默认值
```

配置文件**刻意**在 env 文件之后加载：它在优先级上低于环境变量，
所以来自 `.env` 的 `HANDBOOK_*` 必须**先**进入 `process.env` 才会被读到——
而后加载的文件**不能、也绝不该**覆盖环境变量给出的值。

两个值得知道的推论：

- **从不设置 commander 的默认值。** 一个被急切求值的默认值会在模块加载时
  捕获 shell 里的值——**那时 `--env-file` 还没被应用**——于是文件被悄悄忽略。
  默认值来自 registry，在 action 执行时取。
- **没有任何东西被 commander 标为「必填」。** `--source` 和 `--work` 可以来自 env
  或配置文件，所以必填性是在**所有层都问过之后**由解析器强制的。
  报错时会把每一种提供方式都列出来：

  ```
  invalid configuration:
    - source is required: pass --source, set HANDBOOK_GENERATE_SOURCE,
      or add it to handbook.config.yaml
  ```

---

## `handbook config` —— 调试利器

```bash
handbook config                        # 每个设置、它的值、它的来源
handbook config --command generate     # 只看某个子命令
handbook config --json                 # 机器可读
handbook config --check                # 只校验；有问题就退出码 2
```

它会打印当前环境、级联真正加载了的每个 `.env` 文件、解析到的配置文件，
然后每个设置一行，附带来源（`flag` / `env` / `file` / `default`）。
**没有这个，一个多达八种可能来源的级联是不可审计的。**

它刻意用的是**不抛错**的解析器：**这个命令的职责就是展示配置，包括配置坏掉的时候。**
缺失的 `--source` 会渲染成一行可见的 `— unset (required)`，
而不是把「你唯一能用来调试这个问题的工具」也一起搞挂。

密钥会被打码。`--check` 是该放进 CI 的那一个。

---

## 示例

```bash
# 免费的冒烟测试
handbook analyze --source ~/code/api --work work/api

# 先便宜跑一遍，再只把卡片做深
handbook generate --source ~/code/api --work work/api
handbook generate --source ~/code/api --work work/api --phase 2a --detail deep --resume

# 全套，中文，带 actor-critic 骨架循环
handbook generate --source ~/code/api --work work/api \
  --detail deep --synth-mode doctor --narrate-lang zh --llm-cache

# 渲染所有格式
handbook render --work work/api --title "API 手册" \
  --html --html-single --agent-site --llms-txt \
  --source-base-url https://github.com/me/api/blob/main

# 打包 + 校验
handbook skill --handbook work/api/handbook --out skills/api --name api \
  --work work/api --source ~/code/api --agent-dir work/api/handbook/agent
handbook validate --skill skills/api --source ~/code/api

# plan → dry-run → apply → rollback
handbook plan --source ~/code/api --handbook skills/api/references \
  --request "给 export 命令加一个 --json 参数" --out plan.md
handbook apply --source ~/code/api --plan plan.md --dry-run
handbook apply --source ~/code/api --plan plan.md
handbook rollback --backup ~/code/api/.handbook-patches/<时间戳>

# 让手册保持最新
handbook resync --case cases/export-json --work work/api

# 分环境配置
handbook generate --env prod --source ~/code/api --work work/api
handbook config --env prod --command generate
```

---

## 退出码

| 码  | 含义                                                                                              |
| --- | ------------------------------------------------------------------------------------------------- |
| `0` | 成功                                                                                              |
| `1` | 错误 —— 配置非法、产物缺失、运行失败（消息写到 stderr，前缀 `handbook: error:`）                  |
| `2` | 一次**检查**失败：`validate` 发现问题、`apply` 未完全落地、或 `config --check` 发现非法或缺失的值 |

这个区分在脚本里很重要：`2` 的意思是**「工具正常工作，而答案是否」**。

---

## 输出

每个命令把结果以 **JSON 写到 stdout**，日志写到 **stderr**。所以下面这些如你所愿地工作：

```bash
handbook analyze --source ~/code/api --work work/api | jq .functions
handbook config --json | jq '.settings[] | select(.source.kind == "env")'
```

---

## 备注

- `handbook studio` 会一直运行到 `Ctrl-C`。
- 省略 `--out` 时 `handbook plan` 写到 stdout，可以直接管道。
- `handbook apply` 总会打印备份目录 —— **在你需要它之前先复制下来**。
- `handbook skill --work <dir>` 只有在存在阶段 2 归属产物时才加 `coverage.json`；
  没有的 work dir 只是**不贡献任何东西**，而不是让构建失败。

---

[Handbook](../../README.zh-CN.md) 的一部分 ·
[配置参考](../../docs/content/docs/reference/configuration.md) · MIT
