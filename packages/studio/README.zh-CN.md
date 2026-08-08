# @handbook/studio

[English](README.md) · **中文**

> 整条工具链，装进一个浏览器标签页。注册仓库、带实时日志生成、浏览手册、规划改动、
> dry-run、应用、回滚、resync。**设计上就只跑在 localhost。**

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fstudio-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbook/studio)
[![binds](https://img.shields.io/badge/绑定-127.0.0.1-2dd4bf?style=flat-square)](#安全模型)

---

## 这是什么

一个覆盖所有其他 `@handbook/*` 包的本地 Web UI。**和 CLI 走同样的代码路径、
同样的配置解析、同样的磁盘产物**——只是换了一种驱动方式。

```bash
handbook studio                    # → http://127.0.0.1:4860
handbook studio --port 5000        # 或者：pnpm studio --port 5000
```

**零构建步骤。** UI 是一个手写的 HTML 文件，CSS 内联、原生 JS——
没有打包器、没有框架、不往浏览器发 `node_modules`、不从 CDN 拉任何东西。
它秒开，而且**拔了网线也能用**。

---

## 你能在里面做什么

| 区域                 | 做什么                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **仓库**             | 用一个 URL 安全的名字注册「源码树 + work dir」。持久化在一个 `studio.json` 里，所以服务端重启后是无状态的。              |
| **生成**             | 用完整参数集发起一次运行（阶段、策略、detail、synth 模式、叙述语言、worker 数）。日志经 SSE 实时流出。**运行中可取消。** |
| **手册浏览器**       | 就地阅读渲染好的手册——总览、阶段索引、阶段页、寄存器表。                                                                 |
| **影响面图**         | 某个阶段拥有哪些文件、谁调用它、它又调用了什么。                                                                         |
| **源码查看器**       | 打开任意卡片背后的真实文件，**定位到手册引用的那一行**。                                                                 |
| **Plan**             | 输入改动需求，看只读 agent 干活，读产出的计划。                                                                          |
| **Apply / rollback** | 先 dry-run 再应用，列出每个备份，**一键回滚**。                                                                          |
| **Resync**           | 对着活的代码树把手册前滚——**不用手工组装 case 目录**。                                                                   |
| **历史**             | 每个仓库的演进：每次运行改了什么、什么时候。                                                                             |

---

## 安装

```bash
pnpm add @handbook/studio
```

或者直接用 CLI —— `handbook studio` 就是这个包。

---

## 嵌入使用

```ts
import { startStudio, createStudioServer } from '@handbook/studio';

await startStudio({
  stateDir: `${process.env.HOME}/.handbook-studio`,
  port: 4860,
  host: '127.0.0.1',
  clientFactory: (jobLogger) => new OpenAiChatClient({ config, logger: jobLogger }),
  configFile, // 已加载好的 handbook.config.yaml 层
  logger,
});
```

有两个参数值得解释，因为那里曾经藏过一个微妙的 bug：

- **`clientFactory` 收到的是**任务**的 logger**，不是顶层那个。
  一个静默的客户端会把重试和网关拦截，**从用户正在盯着的那份唯一日志里藏起来**。
- **`configFile` 会被透传下去**，这样一个 generate 任务的参数才能看到和其他所有命令
  相同的 `handbook.config.yaml` 层。没有它的时候，`--model`、`--base-url`
  以及配置文件里的 `llm:` 块**对 Studio 悄悄地什么都没做**，
  而 `--help` 和 `handbook config` 却都声称它们生效了。

`createStudioServer` 返回一个未启动的 `http.Server`，测试驱动的就是它。

---

## 任务（Jobs）

生成、规划、resync 都作为**后台任务**运行，日志经 Server-Sent Events 送出。

- **一个仓库同时只跑一个任务。** pipeline 的产物在同一个 work dir 上不允许并发写；
  第二次启动会被**明确拒绝**，而不是被允许交错。
- **可取消。** 每个任务有一个 `AbortController`，它的 signal 一路传到在途的 LLM 请求。
  **取消就是取消**，不是「别再给我看日志了」。
- **状态：** `running` → `succeeded` | `failed` | `cancelled`。完整日志会保留，
  所以结束之后你还能读到到底发生了什么。

---

## 安全模型

Studio 是一个**本地工具**。它没有为暴露到公网做加固，也不假装自己做了。

- **默认绑定 `127.0.0.1`。**
- **CSRF 防护检查 `Host` 请求头**，不是 socket。只有 loopback 主机名能通过。
- **`POST` 要求 `application/json`**，这挡住了经典的跨源 HTML 表单攻击。
- **仓库名会被校验**（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）之后才碰文件系统，
  路径经 realpath 归一，所以同一棵树的两种写法比较起来相等。
- **源码和手册文件的服务是沙箱化的**，限定在已注册的根目录内。

### 在容器里跑

容器必须绑 `0.0.0.0`，发布出去的端口才可达（`docker-compose.yml` 里的
`HANDBOOK_STUDIO_HOST=0.0.0.0`）。**这并不放宽「谁可以访问」。**
从宿主机浏览 `http://localhost:4860` 时发出的仍然是 `Host: localhost:4860`，能通过；
而写着 LAN IP 或容器主机名的请求会被 `403` 拒绝。

**只有 `http://localhost:4860` 能用——LAN IP 和容器名都不行。**
远程访问是一个**故意还没实现**的独立功能（需要显式白名单），不是这条防护的漏洞。

---

## HTTP API

UI 只是个客户端；这个 API 足够稳定，可以直接脚本化。

| 方法     | 路径                          | 用途                                                                   |
| -------- | ----------------------------- | ---------------------------------------------------------------------- |
| `GET`    | `/`                           | UI（同时应答 `HEAD`，让探活拿到真话）                                  |
| `GET`    | `/api/repos`                  | 已注册的仓库                                                           |
| `POST`   | `/api/repos`                  | 注册一个                                                               |
| `DELETE` | `/api/repos/:name`            | 取消注册                                                               |
| `GET`    | `/api/repos/:name`            | 单个仓库的状态                                                         |
| `POST`   | `/api/repos/:name`            | 启动任务：`analyze`、`generate`、`plan`、`resync`、`apply`、`rollback` |
| `GET`    | `/api/repos/:name/overview`   | 手册总览 + 阶段索引                                                    |
| `GET`    | `/api/repos/:name/graph`      | 影响面图数据                                                           |
| `GET`    | `/api/repos/:name/source`     | 一个源文件，沙箱内                                                     |
| `GET`    | `/api/repos/:name/handbook/*` | 渲染好的手册文件                                                       |
| `GET`    | `/api/repos/:name/patches`    | 可回滚的备份                                                           |
| `GET`    | `/api/repos/:name/history`    | 演进历史                                                               |
| `GET`    | `/api/languages`              | 已注册的分析器语言                                                     |
| `GET`    | `/api/jobs`                   | 所有任务                                                               |
| `GET`    | `/api/jobs/:id`               | 单个任务，或它的 SSE 日志流                                            |
| `POST`   | `/api/jobs/:id/cancel`        | 取消一个运行中的任务                                                   |

---

## 状态

```
~/.handbook-studio/
  studio.json        仓库注册表（读取时做 schema 校验）
  work/<name>/       为没有自带 work dir 的仓库自动创建的目录
```

`--state-dir` 可以换位置。其他一切——手册产物、演进历史——都住在各仓库自己的 work dir 里，
所以删掉状态目录**只会丢掉注册表，不会丢掉任何要紧的东西**。

---

## 测试

```bash
pnpm --filter @handbook/studio test
```

服务端是走真实 HTTP 端到端驱动的：路由、Host 头防护、content-type 防护、路径沙箱、
任务生命周期、取消与 SSE 流式输出。另外还有一个 UI 漂移测试，
让那个手写 HTML 与它调用的 API 保持同步。

---

[Handbook](../../README.zh-CN.md) 的一部分 · MIT
