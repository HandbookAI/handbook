# @handbook/patcher

[English](README.md) · **中文**

> 把计划里的 EDIT 块逐字节地应用到真实源码树上。全成或全不成，
> 并且备份**能证明自己是对的那一份**。不用 LLM，不猜，不会写一半。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fpatcher-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbook/patcher)
[![no LLM](https://img.shields.io/badge/LLM-从不-2dd4bf?style=flat-square)](#)

---

## 这是什么

一个机械执行器。它拿 `@handbook/planner` 产出的 markdown 计划，
把每处精确的 `old` 文本替换成精确的 `new` 文本——**不重读、不解释、循环里没有模型**。

这正是它的意义。**计划是给人评审的提案；应用它必须无聊且可预测。**
这个包里所有有意思的部分，都是关于**拒绝做错事**。

---

## 安装

```bash
pnpm add @handbook/patcher
```

---

## 快速上手

```ts
import { applyPlan, rollback, listBackups } from '@handbook/patcher';
import { readFileSync } from 'node:fs';

// 1. 只校验，不写任何东西
const dry = applyPlan({
  sourceRoot: '/path/to/repo',
  plan: readFileSync('plan.md', 'utf8'),
  dryRun: true,
});

if (dry.ok) {
  // 2. 真的应用
  const result = applyPlan({ sourceRoot: '/path/to/repo', plan: readFileSync('plan.md', 'utf8') });
  console.log(result.changedFiles, result.backupDir);

  // 3. 后悔了
  rollback(result.backupDir!, { expectedSourceRoot: '/path/to/repo' });
}
```

命令行：

```bash
handbook apply --source /path/to/repo --plan plan.md --dry-run
handbook apply --source /path/to/repo --plan plan.md
handbook rollback --backup /path/to/repo/.handbook-patches/<时间戳>
```

两个命令都在失败时非零退出。

---

## 安全规则，按优先级

### 1. 先全部校验，再分两阶段写

计划先对照当前文件内容做解析——**任何一处失败都会中止整次应用**，此时还没写一个字节。
写入阶段把每个文件先落成临时文件，**只有全部落盘成功后**才统一改名。
如果改名中途失败，已经改名的文件会从刚刚的备份里还原。

**不存在「计划落了一半」的状态。**

### 2. `old` 必须逐字节精确且唯一匹配

| 找到的匹配数 | 结果                                    |
| ------------ | --------------------------------------- |
| 0            | `no-match` —— 计划写完之后代码已经变了  |
| 1            | 应用                                    |
| 2+           | `ambiguous` —— 这个锚点无法指向唯一位置 |

两种失败都拒绝。**都不会挑一个。** 「取第一个出现的位置」正是补丁打进错误函数的方式。

### 3. 每个被改的文件都带补丁前哈希被备份

```
<source>/.handbook-patches/
  .gitignore                 自动写入 —— 备份绝不进 git
  2026-08-08T14-05-11-204Z/
    manifest.json            源根、时间戳、逐文件的前/后哈希
    files/…                  原始字节
```

这个哈希，就是 `rollback` 能**证明**自己还原的正是这次补丁替换掉的字节、
而不是仅仅相信一个文件名的依据。

### 4. 任何路径都不能逃出 source root

解析会拒绝 `..`、绝对路径、Windows 盘符绝对路径——以及在文件本身还不存在时
**经由软链接父目录**的逃逸。最后这种是微妙的情况：realpath 取的是**最深的已存在祖先**，
所以一个尚不存在的叶子节点无法绕过检查。**软链接目标永远不会被替换。**

---

## 解析器拒绝什么，以及为什么

计划格式很简单；解析它却刻意对歧义充满敌意，因为结果要作用在真实源码上。

**围栏跟踪遵循 CommonMark**，反引号和波浪号都一样：以 N 个标记开启的块，
只有当某行的标记数 ≥ N **且**不带 info string 时才会被关闭。
所以处在围栏区域内的 `### EDIT n` 是**内容，绝不是标题**——
一份引用了示例编辑（比如一个编辑文档的例子）的计划，**不可能夹带一个幽灵编辑进来**。

| 被拒绝的                                                  | 消息会告诉你                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| 一个编辑的两个围栏块之间出现内容                          | 很可能是内层围栏提前关闭了 `old`/`new`——用更长的围栏开启它们             |
| 出现未标注的 ``` 块                                       | 同一原因；无论它在哪都拒绝，这样被截断的锚点无法伪装成「结尾附言」溜过去 |
| 不是恰好一个 `old` 和一个 `new`                           | 实际各找到了几个                                                         |
| `new` 出现在 `old` 之前                                   | 先写锚点，再写替换                                                       |
| `old` 与 `new` 完全相同                                   | 没什么可做的                                                             |
| 缺失或重复的 `- file:` 行                                 | 必须恰好一个                                                             |
| 编辑编号乱序或重复                                        | 必须自上而下递增                                                         |
| 路径含空白、反引号、控制字符、反斜杠、`~` 开头或 `/` 开头 | 违反了哪条规则                                                           |
| 形似而非的标题（`## EDIT 1`、`#### edit 2`）              | 它看起来像标题但不是 `### EDIT <n>`——**报告出来，而不是悄悄忽略**        |

最后一对 `old`/`new` **之后**的散文和声明 JSON 块是**预期产物**，会被忽略而不是拒绝。

---

## 结果状态

每处编辑都有一个状态，所以部分拒绝能准确告诉你是哪一处、为什么：

| 状态           | 含义                                     |
| -------------- | ---------------------------------------- |
| `applied`      | 已替换，并给出 `old` 命中的 1-based 行号 |
| `created`      | `old` 为空；文件已创建                   |
| `no-match`     | 文件里没有 `old`                         |
| `ambiguous`    | `old` 出现不止一次                       |
| `file-missing` | `old` 非空，但没有这个文件               |
| `not-a-file`   | 路径是目录或软链接                       |
| `unsafe-path`  | 路径逃出了 source root                   |
| `undecodable`  | 文件不是合法 UTF-8                       |
| `skipped`      | 更早的失败中止了本次运行                 |

```ts
interface ApplyResult {
  ok: boolean; // 只有每处编辑都落地（或 dry-run 下都能落地）才为 true
  dryRun: boolean;
  outcomes: EditOutcome[];
  changedFiles: string[]; // dry-run 下为空
  backupDir?: string; // dry-run 下为 undefined
  problems: string[];
}
```

---

## 回滚

```ts
rollback(backupDir, {
  force: false, // 连打补丁后又被改过的文件也还原
  expectedSourceRoot: '/path/to/repo', // 拒绝属于另一棵树的备份
});

listBackups('/path/to/repo/.handbook-patches'); // 最新在前，只列 manifest 有效的
```

默认情况下，**当前哈希与 manifest 中的补丁后哈希不一致的文件，回滚会拒绝还原**——
不一致意味着有人在那之后改过它，还原会**悄悄毁掉那份工作**。
`--force` 可以覆盖这个行为，而且必须显式写出来。

`expectedSourceRoot` 守的是另一个方向：把回滚指向一个来自另一棵树的备份是错误，不是功能。

---

## 其他值得知道的细节

- **文件权限位被保留。** 可执行脚本仍然可执行。
- **换行风格和结尾换行被保留。** patcher **不会归一化任何你没让它改的东西**。
- **目录锁**（`.handbook-patches/`）防止同一棵树上并发应用两次。
- **回滚留下的空目录会被清理**，但只清理这次回滚自己弄空的那些。

---

## API

```ts
applyPlan(options: ApplyOptions): ApplyResult
rollback(backupDir: string, options?: RollbackOptions): RollbackResult
listBackups(backupRoot: string): string[]
parsePlan(plan: string): ParsedPlan       // 导出出来：不应用也能 lint 一份计划
```

---

## 测试

```bash
pnpm --filter @handbook/patcher test
```

一千多行测试，其中大部分是关于**拒绝**：有歧义的锚点、软链接逃逸、嵌套围栏、
非 UTF-8 文件、改名中途失败与还原、对「之后被改过的文件」的回滚，
以及上表里的每一条解析拒绝。

---

[Handbook](../../README.zh-CN.md) 的一部分 ·
计划来自 [`@handbook/planner`](../planner/README.zh-CN.md) · MIT
