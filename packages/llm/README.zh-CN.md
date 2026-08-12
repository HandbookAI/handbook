# @handbooks/llm

[English](README.md) · **中文**

> 一个小而诚实的客户端，接任意 OpenAI 兼容端点——外加磁盘缓存、离线 mock，
> 以及 pipeline 用来「让 LLM 跟自己吵到答案站得住」的 actor–critic 循环。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fllm-fbbf24?style=flat-square)](https://www.npmjs.com/package/@handbooks/llm)
[![deps](https://img.shields.io/badge/运行时依赖-无-2dd4bf?style=flat-square)](#)

---

## 这是什么

[Handbook](../../README.zh-CN.md) 工具链里所有碰 LLM 的地方，都只走一个很小的接口：

```ts
interface ChatClient {
  readonly model: string;
  complete(prompt: string, options?: ChatOptions): Promise<ChatResult>;
}
```

**整个契约就这些。** 有三种实现满足它：

| 实现               | 用途                                             |
| ------------------ | ------------------------------------------------ |
| `OpenAiChatClient` | 生产环境。任何认 `/v1/chat/completions` 的端点。 |
| `CachedChatClient` | 装饰器。磁盘缓存、内容寻址——重跑变免费。         |
| `MockChatClient`   | 测试与离线演示。脚本化规则，零网络。             |

正因为接口这么小，**整条 pipeline 都能离线测试**，而换端点只是改一个 URL。

**不依赖任何 SDK。** 它是一个薄薄的 `fetch` 客户端——这正是它能跑在
「只实现了 OpenAI API 八成」的端点上的原因。

---

## 安装

```bash
pnpm add @handbooks/llm
```

---

## 快速上手

```ts
import { OpenAiChatClient, resolveLlmEnv } from '@handbooks/llm';

const client = new OpenAiChatClient({ config: resolveLlmEnv(), concurrency: 16 });

const result = await client.complete('用一句话概括这个模块：…', {
  temperature: 0,
  maxTokens: 400,
});

result.text; // 原始回复
result.json; // 从中解析出来的 JSON（如果有）—— 见下文「JSON 提取」
```

### 配置

`resolveLlmEnv()` 读的是共享的 registry，所以它同时接受大家已经 export 的厂商变量名
和工具链自己的：

| 设置             | 环境变量（厂商别名在前）                        | 默认值                         |
| ---------------- | ----------------------------------------------- | ------------------------------ |
| API Key          | `OPENAI_API_KEY` · `HANDBOOK_LLM_API_KEY`       | — （本地无鉴权端点填 `EMPTY`） |
| 模型             | `OPENAI_MODEL` · `HANDBOOK_LLM_MODEL`           | `gpt-4o-mini`                  |
| Base URL         | `OPENAI_BASE_URL` · `HANDBOOK_LLM_BASE_URL`     | `https://api.openai.com/v1`    |
| 最大输出 token   | `OPENAI_MAX_TOKENS` · `HANDBOOK_LLM_MAX_TOKENS` | `16000`                        |
| 单请求超时（秒） | `OPENAI_TIMEOUT` · `HANDBOOK_LLM_TIMEOUT`       | `300`                          |
| 重试次数         | `HANDBOOK_LLM_MAX_RETRIES`                      | `6`                            |
| 退避基数（秒）   | `HANDBOOK_LLM_RETRY_BACKOFF`                    | `3`                            |
| 并发上限         | `HANDBOOK_LLM_CONCURRENCY`                      | `16`                           |
| 厂商扩展字段     | `OPENAI_EXTRA_BODY`（JSON）                     | —                              |

`llmConfigFromValues(values)` 做同样的事，但从一个已解析好的配置对象出发——
CLI 就是这样把 `--model` 和 `--base-url` 送进客户端的。

---

## 客户端替你处理了什么

- **指数退避 + 抖动的重试**，在端点返回 `Retry-After` 时尊重它。
  `PermanentError`（真的是请求本身有问题）**永不重试**。
- **全局并发上限**，作用于**一个客户端上的所有调用**，而不是单个调用点。
  阶段 2a 可以放心要 12 个 worker，不会变成 12 × N 个在途请求。
- **单请求超时。** 卡住的调用会被中止并重试，而不是永远扣着一个阶段不放。
- **协作式取消。** 传一个 `AbortSignal`；被取消的调用以 signal 的 reason 拒绝
  （一个 `AbortError`，绝不包装），中止在途 HTTP 请求，且**不重试**。
- **推理模型的怪癖。** 对拒绝 `temperature` 的模型自动省略该字段。
- **网关页面识别。** `looksLikeGatewayPage(body)` 能识破公司代理用 `200`
  返回一个 HTML 登录页的情况，于是你看到的是
  _「你的网关返回了 HTML 而不是 JSON」_，而不是一个莫名其妙的解析错误。
- **Token 计量。** `client.usage()` 返回 prompt/completion/total，
  pipeline 会把它写进 `run-manifest.json`，让你看得见一次运行花了多少。

### JSON 提取

模型会把 JSON 包在散文里、代码块里、解释里，或者结尾多个逗号。
`ChatResult.json` 是一次宽容提取的结果，上面这些都能处理——
并且在**确实找不到**的时候返回 `undefined`，而不是一个错误的对象。
失败时，`replyExcerpt` 和 `describeJsonShape`（来自 `@handbooks/core`）
会把回复变成可读的诊断，而不是一堵文字墙。

---

## 缓存

```ts
import { CachedChatClient } from '@handbooks/llm';

const cached = new CachedChatClient(client, '<work>/phase3/cache');
```

是个装饰器，所以没有任何阶段知道缓存存在。缓存键覆盖**模型、提示词和选项**，
所以换模型或改 temperature 绝不会喂给你陈旧的文本。
**空回复永远不入缓存**——一个被钉在稳定键上的空响应会毒害之后每一次运行。

命令行：`handbook generate --llm-cache`（`--refresh` 则忽略缓存）。

---

## 离线 mock

```ts
import { MockChatClient } from '@handbooks/llm';

const client = new MockChatClient(
  [
    { match: /概括这个文件/, respond: { purpose: '解析配置', role: 'config' } },
    { match: (p) => p.includes('skeleton'), respond: (prompt, i) => `stage-${i}` },
  ],
  /* fallback */ '{}',
);

client.calls; // 记录下的每次提示词、选项和响应
```

第一条匹配上的规则获胜。匹配器可以是子串、正则或谓词；响应可以是字符串、对象，
或提示词的函数。这已经足够把整条 pipeline 跑一遍——本仓库的测试正是这样在
**完全不碰网络**的情况下覆盖阶段 2a → 3 的。

还有一个 **mock HTTP 端点**（`examples/mock-llm-server.mjs`），用于端到端测试真实客户端：

```bash
pnpm mock-llm    # → http://127.0.0.1:8099/v1
```

---

## Actor–critic 编排

有意思的部分。一个 **actor** 提出结构化的改动；一个或多个 **critic**
（每个角色扮演针对一种不同的失败模式）拿着**事实证据**评审它；
然后 actor 有一轮修订机会来回应汇总后的意见。

```ts
import { actorCriticLoop, ROLE_PROMPTS } from '@handbooks/llm';

const result = await actorCriticLoop({
  client,
  actorPrompt,
  evidence, // critic 用来对照的事实依据
  critics: ['engineer', 'architect', 'reader'],
  schemaHint: '{ "stages": [...] }',
});
```

| Critic      | 审什么                                                     |
| ----------- | ---------------------------------------------------------- |
| `engineer`  | 提案是否符合代码实际行为？被引用的东西是否真实存在？       |
| `architect` | 结构问题——边界不清、阶段过胖、横切关注点放错地方           |
| `reader`    | 是否**更好读**？页面是否内聚、标题是否直观、新人能否跟着走 |
| `editor`    | 一节内部的排序读起来像故事，还是像目录清单？               |

每个返回一个 `Verdict`：`APPROVE` / `REVISE` / `REJECT`，外加关注点、建议修订和理由。

这个模块刻意**与领域无关**——actor 提示词、证据块和 schema 提示都由 pipeline 提供。
`handbook generate --synth-mode doctor` 底下跑的就是它。

---

## API

```ts
// 客户端
class OpenAiChatClient implements ChatClient
resolveLlmEnv(env?): LlmEnvConfig
llmConfigFromValues(values): Partial<LlmEnvConfig>
looksLikeGatewayPage(body: string): boolean
extractAssistantText(payload: unknown): string | undefined

// 缓存与 mock
class CachedChatClient implements ChatClient
class MockChatClient implements ChatClient

// actor–critic
actorCriticLoop(options): Promise<ActorCriticResult>
parseVerdict(json, text?): Verdict | undefined
buildCriticPrompt(args): string
buildRevisePrompt(args): string
ROLE_PROMPTS: Record<CriticRole, string>
```

---

## 测试

```bash
pnpm --filter @handbooks/llm test
```

客户端是对着一个本地 HTTP 服务器测的——重试、超时、限流、取消、网关页面、
畸形负载，全都有真实测试。**没有任何测试需要 API Key。**

---

[Handbook](../../README.zh-CN.md) 的一部分 · [提示词目录](../../docs/content/docs/reference/prompts.mdx) · MIT
