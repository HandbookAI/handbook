# @handbook/studio

架在整条工具链之上的本地 Web 界面：登记仓库、带实时日志地跑生成、浏览渲染好的手册、
用手册驱动的规划器规划改动、把改动落盘、代码变了之后把手册前滚——
全部在 `127.0.0.1` 上进行，源码离开这台机器的唯一出口，是管线自己配置的那个 LLM 端点。

> 英文版：[README.md](README.md)

## 职责

- 用 `node:http` 提供一个单页仪表盘（`public/index.html`）和一套 JSON API —— **零 Web 框架依赖**。
- 维护仓库登记表（state 目录下的 `studio.json`）；每条记录把一个源码根和一个存放手册产物的 work 目录配对。
- 把管线操作作为**作业**（job）运行（generate / analyze / plan / resync / apply / rollback），
  日志经 SSE 实时推送；**每个仓库同时只允许一个作业在跑**（work 目录是单写者）。
- 把每次 resync 记成一次**演化**，落在 `<work>/evolutions/<时间戳>/` 下，并对外提供时间线。
- 刻意**不是**部署用服务器：只绑定 localhost，无鉴权，无 TLS——它是一个桌面工具。
- 通过 `@handbook/patcher` 应用编辑计划：dry-run 核对、全成或全不成地写入、逐编辑结果，
  以及一个「会拒绝覆盖补丁之后的新工作」的回滚（界面上提供显式的强制覆盖入口）。

## 接口

| 方法与路径 | 用途 |
|---|---|
| `GET /` | 仪表盘界面 |
| `GET/POST /api/repos`、`GET/DELETE /api/repos/:name` | 登记表 + 状态（章节数、策略、演化次数） |
| `POST /api/repos/:name/analyze` | 阶段 1 静态分析作业（免费，不用 LLM） |
| `POST /api/repos/:name/generate` | 完整管线 + 渲染作业——接受 CLI 的全部生成选项（见下表） |
| `POST /api/repos/:name/plan` | 规划器作业（`{request}` → 计划 + declarations） |
| `POST /api/repos/:name/resync` | 对**活的源码树**做前滚作业（`{description, noLlm, narrateLang}`）并重渲染 |
| `GET /api/repos/:name/overview` | 阶段 / 摘要 / 寄存器 / 覆盖率 JSON（含**已描述覆盖率**） |
| `GET /api/repos/:name/history` | 演化时间线 |
| `GET /api/repos/:name/graph?stage=&limit=` | 文件级影响图（节点带度数与阶段，边带权重） |
| `GET /api/repos/:name/source?path=` | 文件内容 + 函数锚点（行区间） |
| `POST /api/repos/:name/apply` | 补丁作业（`{plan, dryRun}`）→ 逐编辑结果、changedFiles、backupDir |
| `POST /api/repos/:name/rollback` | 回滚作业（`{backup?, force?}`）→ restored / removed / skipped |
| `GET /api/repos/:name/patches` | 备份时间戳，最新在前 |
| `GET /api/history` | 跨全部仓库的演化，最新在前 |
| `GET /api/repos/:name/handbook/*` | 渲染好的手册静态托管（防路径穿越） |
| `GET /api/jobs?repo=` | `{jobs: [...]}` —— 近期作业摘要（id/repo/kind/status/startedAt，不含原始日志），最新在前 |
| `GET /api/jobs/:id`、`GET /api/jobs/:id/stream` | 作业状态 / SSE 日志流 |
| `POST /api/jobs/:id/cancel` | 请求取消：运行中 → `202 {ok:true}`；已结束 → `409`；未知 → `404` |

### 生成选项

`POST /api/repos/:name/generate` 接受 CLI 的全部选项；默认值与 CLI 一致。

| 字段 | 含义 |
|---|---|
| `narrateLang`（`en`\|`zh`）、`detail`（`brief`\|`deep`）、`synthMode`（`oneshot`\|`doctor`）、`title` | 最常用的四项，对话框顶部直接给出 |
| `phase` | `all \| 1 \| 2 \| 2a \| 2b \| 2c \| 3` 或逗号列表（默认 `all`） |
| `strategy` | `file` \| `member`；不传 = 沿用 work 目录已记录的策略 |
| `skeleton` | 手写 `skeleton.yaml` 的路径——`member` 策略必填 |
| `lang` | 源码语言：`auto \| python \| typescript \| go \| rust \| shell` |
| `resume`、`refresh` | 布尔：跳过已完成卡片 / 忽略阶段 3 缓存 |
| `readWorkers`（默认 12）、`maxDoctorRounds`（默认 6，仅 doctor 模式） | 数值在服务端校验：传垃圾值当场 `400`，绝不让 NaN 混进作业 |

### 取消作业

取消是**协作式**的：`POST /api/jobs/:id/cancel` 会触发该作业的
`AbortSignal` 并立刻回 `202`，但运行**要到下一个检查点才真正停下**
（管线阶段之间、渲染之前——随着底层包逐步识别这个信号，也会停在阶段中途）。
这样停下的作业以 **`cancelled`** 结束——**这是一种结果，不是一种错误**：
界面用中性的冰蓝色渲染它，`error` 字段保持为空，日志以
`[job] cancelled by user` 收尾。已取消的作业与成功/失败的作业一样释放
仓库互斥锁、不再阻塞删除仓库。日志抽屉在作业运行期间提供「取消」按钮。

## 视图

| 视图 | 用来干什么 |
|---|---|
| 首页 | 产品的形状：Request → Handbook → Plan → Patch → Sync 这个闭环，加最近的仓库与演化 |
| 使用说明 | 内置指南：五步闭环、每个按钮做什么、成本与数据边界 |
| 总览 | 状态、带摘要的章节索引、覆盖率、状态寄存器 |
| 浏览手册 | 内嵌渲染好的手册——顶部切换器提供每个真实存在的产物：章节站点、单页版 `handbook.html`、agent 定位索引（`agent/how_to_use.md`） |
| 影响图 | 文件级调用关系 SVG——节点大小按度数、颜色按阶段，可按阶段过滤，点击进源码 |
| 源码 | 真实文件带行号，函数索引可跳转并高亮；带「← 文件列表」与「刚看过」 |
| 演化 | 规划 → dry-run → 应用（逐编辑结果表）→ 回滚 → 前滚，附备份列表 |
| 历史 | 单仓库的演化时间线，以及侧栏里的跨仓库总览 |

中英切换与明暗主题都在顶栏，按浏览器持久化。

## 用法

```bash
handbook studio                      # http://127.0.0.1:4860
handbook studio --port 5000 --state-dir ~/.handbook-studio
```

或者编程调用：

```ts
import { startStudio } from '@handbook/studio';
import { MockChatClient } from '@handbook/llm';

const server = await startStudio({
  stateDir: '/tmp/studio',
  port: 4860,
  clientFactory: () => new MockChatClient([...]), // 可注入——测试完全离线
});
```

## 设计说明

- **LLM 客户端按作业创建**（`clientFactory`），默认是由环境变量配置的 `OpenAiChatClient` ——
  CLI 的 `.env` 自动加载同样生效，测试则注入 mock。
  工厂会拿到**该作业的日志器**：客户端不带日志器就是静默的，重试、超时、网关拦截全都看不见——
  一次「90 次调用全失败」的运行曾因此读起来像一次安静的成功。
- **resync 用仓库的活源码树**（`editedRoot`），而不是拷出来的 case 目录：
  Studio 的演化流程是「你就地改了代码，手册去追平」。case 目录仍然接收报告、暂存区与 `evolution.json`。
- **手册静态托管把路径解析在手册根之内并拒绝逃逸**——这套 API 从不托管任意文件系统路径。
- **作业日志有上限**（保留最后 2000 行）并以「先回放再跟随」的 SSE 语义推送，
  所以晚点才打开的抽屉依然能看到完整的近期日志。
- **生成中途刷新页面不会弄丢作业**：页面在启动与切换视图时轮询 `GET /api/jobs`，
  有作业在跑时顶栏出现「任务进行中」小标签，点击即把日志抽屉重新挂回该作业的
  SSE 流（回放补齐错过的行）。若此时作业恰好已结束，点击则改为刷新仓库状态。
- **总览同时显示归档覆盖率与已描述覆盖率**。归档覆盖率说「每个文件都进了某一章」——
  它靠调用图算，永远是满的；只有「已描述 N/M」才说明有多少文件真的拿到了叙述。
  只显示前者，会让一本空壳手册看起来像 100% 完成。

## 依赖

内部：`@handbook/{core,llm,pipeline,planner,patcher,renderer,resync,skill}` ——
Studio 是一层很薄的编排外壳，每一项能力都住在底层包里。
外部：仅 `zod`（校验 state 文件）。
