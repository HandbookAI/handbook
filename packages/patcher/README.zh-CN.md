# @handbook/patcher

把一份计划（`@handbook/planner` 产出的那种）里的 EDIT 块应用到源码树上——
**逐字节精确、全成或全不成**，带备份，并支持还原到**完全一致的原始字节**。
这一步把「手册驱动的计划」变成真实的代码改动，且全程不猜。

> 英文版：[README.md](README.md)

## 职责

- 把计划里的 `### EDIT n` 块解析成带类型的编辑列表；格式不成立时**报告问题**而不是即兴发挥（`parsePlan`）。
- 在**写任何东西之前**，先拿每个编辑去核对文件当前内容；任何一个编辑不通过，整份计划都拒绝（`applyPlan`）。
- 为每个被触碰的文件加备份并写清单，让一次改动可以还原到**改前的确切字节**（`rollback`、`listBackups`）。
- **不**重排格式、**不**重新缩进、**不**「顺手修一下」——计划里的 `new` 文本逐字落盘。
- **不**做模糊匹配：锚点已经不存在、或者出现了两次，都是**拒绝**，不是猜。

## 安全契约

| 情况 | 结果 |
|---|---|
| `old` 恰好匹配一次 | 在该偏移处应用（报告行号） |
| `old` 找不到 | `no-match` —— 计划做出之后代码变过了 |
| `old` 匹配 2 次以上 | `ambiguous` —— 锚点需要更多上下文 |
| `old` 为空且文件不存在 | `created` |
| `old` 为空但文件有内容 | `no-match`（绝不静默覆盖；判定依据是文件**磁盘上的状态**，所以同一份计划里更早的编辑无法「解锁」它） |
| 路径逃出源码根——直接逃出，或创建时经由软链接的父目录 | `unsafe-path` |
| 目标是软链接 / 目录 / 非合法 UTF-8 | `unsafe-path` / `not-a-file` / `undecodable` |
| 任一编辑核对失败 | **一个字节都不写**；已通过的那些报 `skipped` |
| 写入过程中发生 `fs` 错误 | 已 rename 的文件用刚才的备份还原，然后把错误重新抛出 |
| 目标文件超过 8 MiB，或字节无法 UTF-8 往返 | `undecodable` —— 绝不打补丁 |
| 目标的父目录不可写 | `permission` —— 在核对阶段就拦下，落盘前不会发生任何事 |
| 计划围栏格式坏了（无标签块、未闭合围栏、`new` 在 `old` 之前、编号重复/降序） | 解析按 EDIT 逐条拒绝并报 problem；这份计划的任何编辑都不会执行 |
| 另一个 `apply` 持有这棵树的锁 | 本次运行**抛错**（`another patch run is writing to this tree (pid … on … , started …)`）；记录的 owner 是本机已死 pid 则回收锁，异机或不可读的 owner 一律视为存活——确认对方进程已消失后可手动删除 `.handbook-patches/apply.lock` |

同一个文件的多个编辑按计划顺序在**累积内容**上叠加，
所以一份计划可以多次触碰同一文件，只要每个锚点在**轮到它时**是唯一的。

**抛错 vs 返回值：** 凡能表达为逐编辑 outcome 的情况，`applyPlan` 都返回 `ApplyResult`；
环境级失败才**抛错**——锁被占用、锁/备份目录无法准备、写入阶段的 `fs` 错误（还原后重抛）。
自动化调用方应 catch 并原样上报这些错误，而不是去解析它们。

## 公开 API

| 导出 | 用途 |
|---|---|
| `parsePlan(plan): ParsedPlan` | `{ edits: EditBlock[], problems: string[] }` |
| `applyPlan(options): ApplyResult` | 核对 +（除非 `dryRun`）写入；返回逐编辑 `outcomes`、`changedFiles`、`backupDir` |
| `rollback(backupDir, options?)` | 还原备份文件、删除补丁新建的文件；**补丁之后**被改过的文件报进 `skipped`，除非传 `{force:true}` |
| `listBackups(backupRoot)` | 备份时间戳，最新在前 |

`ApplyOptions`：`{ sourceRoot, plan, dryRun?, backupRoot?, logger? }` ——
备份默认落在 `<sourceRoot>/.handbook-patches/<时间戳>/`
（放在仓库内，这样并列的多个 checkout 不会共用同一个备份根；记得加进 .gitignore）。

## 用法

```ts
import { applyPlan, rollback } from '@handbook/patcher';
import { readFileSync } from 'node:fs';

const plan = readFileSync('plan.md', 'utf8');

// 1. 先核对——这一步完全不动源码树。
const check = applyPlan({ sourceRoot: '/repo', plan, dryRun: true });
if (!check.ok) {
  for (const o of check.outcomes) console.log(o.status, o.file, o.detail ?? '');
  process.exit(2);
}

// 2. 真正应用；如果测试不同意，就撤回。
const applied = applyPlan({ sourceRoot: '/repo', plan });
if (testsFail()) {
  const undone = rollback(applied.backupDir!);
  // `skipped` 列出补丁之后有人改过的文件——它们没有被覆盖。
  console.log(undone.restored, undone.removed, undone.skipped);
}
```

命令行：

```bash
handbook apply --source /repo --plan plan.md --dry-run   # 只核对
handbook apply --source /repo --plan plan.md             # 写入并备份
handbook rollback --backup /repo/.handbook-patches/2026-08-03T…   # 加 --force 可覆盖补丁后的改动
```

## 设计说明

- **先核对再写，且写入分两段。** 解析阶段在内存里构建每个文件的完整新内容；
  写入阶段先把每个文件暂存为同目录临时文件，**全部暂存成功**之后才统一 rename——
  rename 中途失败会把已落地的部分还原回去。
- **备份是撤销层，不是版本控制**：它保存补丁前的字节，加上 `sha256Before`/`sha256After`。
  回滚会先核对当前字节仍然等于补丁写入的内容，所以它会**拒绝**（而不是销毁）补丁之后的新工作；
  `force` 可以覆盖这个保护。
- **换行风格与文件权限位都保留。** LF 的计划应用到 CRLF 文件时按该文件自己的主导换行处理，
  可执行位在每次写入后恢复。
- **唯一性就是正确性的锚。** 提示词要求规划器带上至少 3 行上下文，正是为了让这个检查可以很严；
  而这里检查得严，才让一个「盲执行器」是安全的。
- **栅栏块解析对歧义极其敌视。** `### EDIT n` 只在栅栏区域**之外**才算标题，
  所以一份引用了示例编辑的计划不会凭空多出一个幻影编辑；
  内容里含有「与开栅栏等长的反引号串」的块会被**拒绝**（请用更长的 ```` 开栅栏，而不是指望它侥幸通过）；
  `- file:` / `- where:` 只在第一个栅栏之前读取，所以栅栏里的内容无法劫持目标文件。

## 依赖

内部：`@handbook/core`（原子写、哈希、日志器）。无外部依赖。
