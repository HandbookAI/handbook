# 参与贡献

[English](CONTRIBUTING.md) | **中文**

这份文档是 [README](README.zh-CN.md) 面向贡献者的另一半：README 讲这套工具链做什么、有哪些
命令，这里讲一次改动要长成什么样才能被合入。

有两件事先说，因为后面所有规则都由它们决定：

- **所有测试都离线跑。** 任何测试都不得依赖 API key 或访问网络。LLM 相关行为用
  `MockChatClient`（规则脚本）或内置的 mock HTTP 端点来测。新增一个需要真实端点的测试，
  Review 时会要求改掉。
- **门禁是脚本，不是机器人。** `pnpm check` 与 CI 的第一个 job 完全一致。本地过了，CI 的
  `check` 就会过——CI 红了也在本地复现，而不是靠一次次推提交去试。

## 从哪里开始

| 你想做什么             | 去哪里                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ |
| 报告一个坏掉的地方     | [Bug report](../../issues/new?template=bug_report.yml)——按表单给出复现步骤           |
| 希望支持某种语言       | [Language support](../../issues/new?template=language_support.yml)                   |
| 提议一个功能或改动     | [Feature request](../../issues/new?template=feature_request.yml)——大 PR 之前先开这个 |
| 想问某处是怎么工作的   | Discussions，或 [docs/architecture.md](docs/architecture.md)——提问不是 bug           |
| 报告安全漏洞           | **不要**开 issue，见 [SECURITY.md](SECURITY.md)                                      |
| 修错别字、收紧一段文档 | 直接发 PR                                                                            |

小而显然正确的修复不需要任何铺垫。但凡改到产物 schema、prompt、CLI flag 或包边界，请先开
issue——这类决定记录在 [docs/formats.md](docs/formats.md)、[docs/prompts.md](docs/prompts.md)
和 [docs/architecture.md](docs/architecture.md) 里，讨论应该留在事后还能被读到的地方。

## 环境准备

```bash
node -v                 # 需要 >= 20.11（见 .nvmrc）
corepack enable         # 使用 package.json 里锁定的 pnpm 版本
pnpm install
pnpm build

bash examples/run-demo.sh   # 全离线，零 token 消耗——用来确认环境是对的
```

只要 `examples/work/demo/handbook/overview.md` 生成出来，环境就没问题。它走内置 mock LLM，
不需要 key，也不需要联网。

只有手工调试 LLM 相关的包才需要真实端点。把 [.env.example](.env.example) 复制成 `.env`
（已被 git 忽略）——不要把 key 写进任何被跟踪的文件，也不要贴进 issue。

## 日常循环

```bash
pnpm check        # 每次提交前——类型检查、工作区不变量、lint、格式、测试
pnpm check:all    # 动到打包或 manifest 的 PR 前——再加 publint/attw 与装包冒烟
```

`pnpm check` 的顺序是刻意排的，好让失败自己说明原因：类型检查（先源码后测试）→ 工作区
不变量 → eslint 零警告 → prettier → 带分包覆盖率下限的测试。`pnpm check:all` 额外加上两个
面向发布的门禁，它们要打十一个 tarball，属于 CI 与发版前，不属于每次本地循环。

`pre-commit` 钩子只对暂存文件跑格式化和 lint，`commit-msg` 跑 commitlint——因此一次提交不可能
引入几分钟后才由 CI 报出来的格式问题。不要用 `--no-verify` 绕过；如果钩子本身不对，那是个
值得修的 bug。

完整命令表在 README 的[开发](README.zh-CN.md#开发)一节，紧随其后就是"由工具强制、而非仅写在
文档里的约定"（版本只在 `pnpm-workspace.yaml` 的 catalog 里、`dist/` 就是发布面、测试把
`@handbook/*` 解析到源码）。这几条各自都有一道会拦住你的检查，值得先读一遍。

## 提交信息

Conventional Commits，本地由 `commit-msg` 钩子强制，PR 上由 `commitlint` job 强制：

```
feat(analyzer): resolve inherited members through the type table
fix(patcher): refuse a write whose realpath escapes the source root
docs(repo): document the release flow
```

- **type**：[conventional-commits](https://www.conventionalcommits.org/) 那一套——`feat`、
  `fix`、`docs`、`refactor`、`test`、`perf`、`build`、`ci`、`chore`、`revert`。
- **scope** 必填，取自固定清单——十一个包（`analyzer`、`cli`、`core`、`llm`、`patcher`、
  `pipeline`、`planner`、`renderer`、`resync`、`skill`、`studio`）加仓库级区域（`ci`、`deps`、
  `docs`、`examples`、`internal`、`repo`、`spec`、`deck`）。确实横跨多个包时可以用逗号列表：
  `feat(core,pipeline): …`。清单在 [commitlint.config.js](commitlint.config.js) 里，新增 scope
  是对那个文件的一次明确改动，而不是绕过它的理由。
- **subject**：小写、祈使句、句末不加句号。正文每行 110 字符内换行。

subject 要写清改了什么，能带上为什么更好——history 是 changelog 的原料，被读的次数远多于被
写的次数。

## Changeset

发布由 [changesets](https://github.com/changesets/changesets) 驱动。如果你的改动影响了
**已发布包**的行为、API 或打包结果，就加一个，并与代码一起提交：

```bash
pnpm changeset     # 选中受影响的包和升级方式，然后描述这次改动
```

changeset 是写给升级的人看的，不是写给 reviewer 看的：对他们变了什么，他们需要做什么。
`major` 的正文里要给出迁移方式。

不发布任何东西的改动不需要 changeset——测试、CI、`docs/internal/`、仓库工具链，或不在任何包
发布文件里的文档。拿不准就加：多一次 patch 升版本，比一次静默的行为变更便宜得多。

## 测试

- 测试与代码同目录：`packages/<pkg>/src/**/*.test.ts`。共享 fixture 和 mock 规则脚本放
  `*.test-helper.ts`，它被构建和覆盖率统计双重排除。
- 先写失败的测试，再让它通过。每个 bug 修复都要带上"本该拦住它"的那个测试；写不出来就在 PR
  里说明为什么。
- 覆盖率下限是**分包**的，压在各包实测值下方一点，因此形成棘轮。让覆盖率下降的改动会被门禁
  拦住；让它上升的改动，应当同时在 [vitest.config.ts](vitest.config.ts) 里抬高下限。不要靠
  放宽这个差值把红的跑成绿的。
- 有两处 grammar 的怪癖是有承重作用的，也都记在会被它咬到的地方：Swift 的 grammar 在
  V8 ≥ 13 上会直接 abort 进程（于是 vitest 配置里有 `execArgv: ['--liftoff-only']`，适配器则在
  discovery 阶段就明确拒绝），以及含 `case` 语句的 shell 脚本会被跳过。两者都会记入扫描日志，
  而不是被静默丢弃——请保持这一点。

### 浏览器测试

有两处产物是"给人点的 HTML"，任何字符串断言都判断不了它到底能不能用：文档站，以及渲染器
写出的那份 handbook。两者都由 [`scripts/browser/`](scripts/browser) 覆盖——直接用 DevTools
Protocol 驱动真实 Chrome，不需要 Playwright、不需要 Puppeteer、不需要额外安装。

```bash
# 文档站（先启动：cd docs && pnpm dev）
node scripts/browser/docs-site.mjs http://127.0.0.1:3000

# 渲染出来的 handbook，直接从文件系统打开
pnpm demo
node scripts/browser/handbook-html.mjs \
  examples/work/demo/handbook/html examples/work/demo/handbook/handbook.html
```

Chrome 装在非常规位置时设置 `CHROME_PATH`。这两个套件每次推送都会在 CI 里跑。

它们的存在源于一个它们现在能抓住的 bug：`next dev` 拒绝把自己的 JavaScript 发给
`127.0.0.1`，于是每个页面服务端渲染都完美、所有基于 fetch 的检查都通过，在浏览器里却
完全是死的——搜索、主题、语言菜单、侧边栏收起全都不响应。如果你给这两处加了行为，
请同时补上"它消失时会报警"的那条断言。

## 新增一种语言

分两档，选对档位就是大部分工作。

**通用档**——精确的文件与函数清单，尽力而为的调用关系。在
[packages/analyzer/src/generic.ts](packages/analyzer/src/generic.ts) 的 `GENERIC_LANGUAGES`
里追加一条 spec：注册名、`tree-sitter-wasms` 的 grammar 名、文件扩展名、节点类型。不需要新的
适配器文件。对一门还没人建模过的语言，这是正确的第一步，也是一个小而好审的 PR。

**全保真档**——类型驱动的调用解析、继承成员、按属性粒度的状态追踪。这意味着：

1. `packages/analyzer/src/adapters/<lang>.ts`，实现
   [adapter.ts](packages/analyzer/src/adapter.ts) 里的 `LanguageAdapter` 契约。
2. 在 [register.ts](packages/analyzer/src/register.ts) 里注册；如果它应当进入公开 API，再从
   `index.ts` 导出。
3. 同目录的 `<lang>.test.ts`，外加 [examples/demo-project/](examples/demo-project/) 下一小份
   地道的 fixture——那些文件刻意按被解析语言的惯用写法来写，也正因如此被 prettier 排除。
4. 把 `analyzer` 的覆盖率下限抬到相应水平。
5. 更新 [README.md](README.md) 与 [README.zh-CN.md](README.zh-CN.md) 里的语言清单，并加一个
   changeset。

grammar 必须已存在于 `tree-sitter-wasms`——本项目从不需要原生编译，为了拿到 grammar 而引入
构建步骤的 PR 会被拒。

## Pull Request

[PR 模板](.github/PULL_REQUEST_TEMPLATE.md)是清单，这里是清单背后的理由。

- **一个 PR 一件事。** 一次修复外加一次无关重命名，那是两个 PR。Reviewer 读的是 diff，
  一个 diff 做两件事，两件事各只能拿到一半注意力。
- **不要顺手重排格式。** prettier 已经覆盖全仓，所以你的 PR 里出现格式 diff，说明别的东西
  变了。[.prettierignore](.prettierignore) 里那些刻意的排除项，请让它们继续被排除。
- **说为什么，而不只是说什么。** 什么已经在 diff 里了。PR 正文要让半年后读到它的人能重建
  当初的判断——这和本仓库注释对自己的要求是同一条标准。
- **写清你怎么验证的。** `pnpm check` 通过只是底线。如果改动影响生成、渲染或 planner，说明
  你跑了哪个 demo、看了什么。
- **CI 必须是绿的。** 六个互相独立的 job：`check`（Linux 上 Node 20 与 24，外加 macOS、
  Windows 的 24）、`packaging`、`smoke`、`demo`、`shellcheck`、`commitlint`。Windows 那两条不是
  凑数：patcher 的符号链接逃逸防护、core 基于 mkdir 的目录锁、analyzer 归一化的每一条路径，
  在那里的行为都不一样。
- **预期会收到 Review 意见，包括对文字的意见。** 在这个仓库里，注释和文档是产品的一部分。

维护者可能会直接往你的分支推一个小 fixup，而不是为一个细节多走一轮。如果你不希望这样，
在 PR 里说一声。

## 授权

提交贡献即表示你同意你的贡献以 [MIT License](LICENSE) 授权，与本项目相同。没有 CLA，也不
需要 DCO 签名——commit 本身就是记录。

不要粘贴你没有权利重新授权的代码；复现 bug 时也不要把私有源码贴进 issue。analyzer 完全在
本地运行，因此一份最小的合成 fixture 几乎总能说明解析问题。

## 行为准则

参与本项目受[行为准则](CODE_OF_CONDUCT.md)约束，对 issue、PR、discussion 和提交信息一视同仁。
