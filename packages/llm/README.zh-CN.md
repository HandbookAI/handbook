# @handbook/llm

工具链与任何 LLM 之间**唯一的接缝**。它定义 `ChatClient` 接口；实现 `OpenAiChatClient`——对接任何
OpenAI 兼容的 `/chat/completions` 端点（托管 API、vLLM、代理），自带重试、限流与 JSON 抽取；
提供确定性的 `MockChatClient` 供离线测试；以及一套与业务无关的 actor–critic 评审循环，
管线里的「骨架医生」就建在它上面。

> 英文版：[README.md](README.md)

## 职责

- 定义 `ChatClient` —— 工具链里每一处 LLM 触点都只走这一个接口。
- 实现 `OpenAiChatClient`：环境变量驱动的配置、有界并发、带退避的重试、请求超时、用量统计。
- 对 HTTP 失败分类：永久性 4xx 快速失败；408/429/5xx 重试；**网关返回的 HTML 错误页也算可重试**（见设计说明）。
- 提供 `MockChatClient`，让整条管线可以离线按脚本跑通。
- 提供 actor–critic 编排（`actorCriticLoop` 及其提示词构造器与裁决解析器），支持角色扮演的评审团。
- **不**包含任何手册专属提示词——任务上下文、证据、schema 都由调用方提供。
- **不**做流式输出，也**不**管理多轮会话状态；`complete` 在设计上就是单轮的。

## 公开 API

**客户端**（`client.ts`）
- `ChatClient` —— `{ complete(prompt, options?): Promise<ChatResult>; readonly model: string }`。
- `ChatOptions` —— `{ temperature?, maxTokens? }`；`ChatResult` —— `{ text, json, elapsedSec }`。
- `OpenAiChatClient` —— `new OpenAiChatClient(options?)`；`complete(...)`、
  `usage(): Readonly<LlmUsageStats>`（`calls`、`failures`、`totalElapsedSec`）。
- `OpenAiChatClientOptions` —— `{ config?, concurrency?（默认 16）, logger?, timeoutMs?, fetchImpl? }`。
  **务必传 `logger`**：不传就是静默客户端，重试、超时、网关拦截全都看不见。
- `resolveLlmEnv(env?)` / `LlmEnvConfig` —— 从环境变量取配置：`OPENAI_API_KEY`、`OPENAI_MODEL`、
  `OPENAI_BASE_URL`、`OPENAI_MAX_TOKENS`、`OPENAI_TIMEOUT`（秒，默认 300）、`OPENAI_EXTRA_BODY`（JSON），
  均可用 `HANDBOOK_LLM_*` 作为回退；本地无鉴权端点用 `OPENAI_API_KEY=EMPTY`。
- `extractAssistantText(payload)` —— 从常见的 OpenAI 兼容响应形状里取出助手正文。
- `looksLikeGatewayPage(body)` —— 判断错误响应体是边缘网关的 HTML 页，而不是 API 的回答。

**Mock**（`mock.ts`）
- `MockChatClient` —— `new MockChatClient(rules: MockRule[], fallback?)`；每次调用都记进 `calls: RecordedCall[]`。
- `MockRule` —— `{ match: string | RegExp | (prompt) => boolean; respond: MockResponse }`；
  `MockResponse` 可以是字符串、对象（自动包成 JSON 栅栏块）或 `(prompt, callIndex) => …`。

**Actor–critic**（`critic.ts`）
- `actorCriticLoop(client, actorPrompt, options): Promise<ActorCriticResult>` ——
  一个 actor 提案交给并行评审团审查，修改轮数有上限。
- `ActorCriticOptions` —— `{ roles?, taskContext, schemaHint?, evidence?, maxReviseRounds?（默认 1）,
  criticConcurrency?, temperature?, logger? }`。
- `ActorCriticResult` —— `{ proposal, accepted, rounds, verdicts }`。
- `CriticRole`（`'engineer' | 'architect' | 'reader' | 'editor'`）、`ROLE_PROMPTS` ——
  每个角色对应一类失败模式的角色扮演框架。
- `CriticDecision`（`'APPROVE' | 'REVISE' | 'REJECT'`）、`Verdict`、`parseVerdict(json, text?)` ——
  裁决解析，含「空洞 REVISE」归一化。
- `buildCriticPrompt(args)` / `buildRevisePrompt(args)` —— 评审与修改的提示词构造器。

## 用法

```ts
import { OpenAiChatClient, MockChatClient, actorCriticLoop, type ChatClient } from '@handbook/llm';
import { createLogger } from '@handbook/core';

const client: ChatClient = process.env.OPENAI_API_KEY
  ? new OpenAiChatClient({ concurrency: 8, logger: createLogger('[llm]') })
  : new MockChatClient([{ match: 'summarize', respond: { summary: 'stub' } }]);

const result = await client.complete('Summarize this module as JSON: {"summary": "..."}', {
  temperature: 0,
});
console.log(result.json);

const review = await actorCriticLoop(client, 'Propose a title for the module. Return JSON.', {
  roles: ['engineer', 'reader'],
  taskContext: 'Module titling for a codebase handbook.',
  evidence: 'The module parses CLI flags.',
});
console.log(review.accepted, review.proposal);
```

## 设计说明

- **一个接缝，两种实现**：下游代码全部面向 `ChatClient` 编写，所以生产上任何 OpenAI 兼容端点都能用，
  而测试里 `MockChatClient` 能零网络地把整条管线按脚本跑完。
- **永久性 4xx 快速失败**：400/401/403/404/405/410/422 抛 `PermanentError`，`retry` 绝不重试；
  408/429/5xx 走线性退避加抖动重试。
- **HTML 响应体 = 网关拦截，一律可重试**：某些服务商的边缘网关会用 HTML 错误页回你 405，
  这意味着请求**根本没到 API**——它的裁决说明不了请求本身有问题。这类失败只报一行原因，
  不把 300 字符的标记语言倒进日志。
- **空正文是失败，不是空答案**：`content` 为空（或全是空白）会抛可重试错误。曾经它被当作成功返回，
  于是「模型什么都没说」被记成一次成功调用——一整轮 90 个文件的卡片因此全空，而作业报告成功。
- **截断只在「要结构且结构坏了」时拒绝**：`finish_reason: 'length'` 时，若回复里能抽出可用 JSON 就接受；
  若明显想给结构却已残缺则报错重试；若是**散文**则保留已返回的部分并告警——
  少了半句话的段落仍然胜过一段套话兜底。
- **预算放大是按调用的**，上限 2×，并受「从 400 学到的天花板」约束（提到 token 参数的 400 视为可重试，
  同时记住这个端点能接受的上限）。曾经它是客户端级状态，一次截断就会污染 16 个并发工作线程的预算。
- **推理型模型的参数切换**：匹配 `gpt-5|gpt-4.1|o[1-9]` 的模型用 `max_completion_tokens` 且不传 `temperature`，
  其余用经典的 `max_tokens`/`temperature`——调用方不需要关心。
  厂商专属参数（例如某些模型的「关闭思考」开关）走 `OPENAI_EXTRA_BODY`，客户端自己管的字段受保护、不可被覆盖。
- 每个 `ChatResult` 都带一个预先抽好的 `json` 字段（经 `extractJsonBlock`），
  调用方不必各自重新实现栅栏与括号扫描。
- **评审循环在构造上就保守**：某个 critic 的调用或解析失败一律算 REJECT（坏审稿人不能放行）；
  提前通过需要全体 APPROVE；没有具体意见的 REVISE 归一化成 APPROVE，因为它给 actor 的是空指令。
  裁决解析容忍 `verdict`/`judgement`/`status` 等键名和纯决策词回复，但**散文不能投票**——
  「I would not approve this」依旧算读不出来，也就是 REJECT。

## 依赖

内部：
- `@handbook/core` —— `PermanentError`、`retry`、`pLimit`、`mapLimit`、`extractJsonBlock`、`Logger`
  以及形状容忍工具（`describeJsonShape`、`replyExcerpt`）。

外部：无 —— HTTP 走全局 `fetch`（测试可注入）。
