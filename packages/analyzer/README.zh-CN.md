# @handbook/analyzer

[English](README.md) · **中文**

> 指向一个目录，拿回一张带类型的调用图。不用 LLM，不联网，不需要本地编译——解析器是 WebAssembly。

[![npm](https://img.shields.io/badge/npm-%40handbook%2Fanalyzer-14b8a6?style=flat-square)](https://www.npmjs.com/package/@handbook/analyzer)
[![no LLM](https://img.shields.io/badge/LLM-从不-2dd4bf?style=flat-square)](#)
[![languages](https://img.shields.io/badge/languages-18-a78bfa?style=flat-square)](#支持的语言)

---

## 这是什么

`@handbook/analyzer` 是 [Handbook](../../README.zh-CN.md) 工具链的静态分析引擎——
而且它**单独拿出来用也很有价值**。给它一个源码根目录，不管代码是什么语言写的，
它都返回同一套与语言无关的 IR：

- 每个**函数和方法**，带文件、行范围、签名、装饰器、参数类型，
  以及它读写的实例属性；
- 每条**调用边**，通过 `self`/`this`、属性类型、参数类型标注、import 和继承解析出来；
- 每个**边界调用** —— 你的代码离开自己、进入第三方库的地方；
- 每个**未解析的调用**，被分类并隔离到单独的产物里，**而不是猜一个**。

因为它是确定性的，同样的输入永远产出同样的图。你可以 diff 两张图、把一张提交进仓库，
或者在测试里对它断言。

---

## 安装

```bash
pnpm add @handbook/analyzer
```

没有安装后编译步骤。语法以 `.wasm` 文件形式随包发布。

---

## 快速上手

```ts
import {
  registerBuiltinAdapters,
  discoverAll,
  getAdapter,
  buildGraph,
  writeGraphArtifacts,
} from '@handbook/analyzer';

registerBuiltinAdapters();

const root = '/path/to/repo';
const byLanguage = discoverAll(root); // { typescript: [...], python: [...] }

const analyses = [];
for (const [lang, files] of Object.entries(byLanguage)) {
  analyses.push(await getAdapter(lang).analyze(files, root));
}

const result = buildGraph(
  { functions: analyses.flatMap((a) => a.functions), edges: analyses.flatMap((a) => a.edges) },
  { sourceRoot: root, scannedFiles: Object.values(byLanguage).flat(), language: 'multi', defaultExt: '' },
);

console.log(result.stats); // { functions, edgesKept, edgesDropped }
writeGraphArtifacts(result, './out');
```

或者，用命令行——同一件事，一行：

```bash
handbook analyze --source /path/to/repo --work work/myrepo
```

### 会落到磁盘上的东西

| 文件                 | 内容                                                        |
| -------------------- | ----------------------------------------------------------- |
| `graph.json`         | 图本体：元数据、带出入度的节点、边、逐类的 self 属性索引    |
| `functions.csv`      | 全部函数，平铺 —— 给 `grep`、给表格、或者快速看一眼是否合理 |
| `graph.dot`          | Graphviz。`dot -Tsvg graph.dot -o graph.svg`                |
| `dropped-calls.json` | 按类别归档的未解析调用，带原始调用文本和行号                |

---

## 支持的语言

**完整层** —— 手写适配器。类型驱动的调用解析、继承成员、逐属性状态追踪、语句跨度：

| 语言                          | 扩展名                                                   |
| ----------------------------- | -------------------------------------------------------- |
| Python                        | `.py`                                                    |
| TypeScript*（含 JavaScript）* | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs`                  |
| Go                            | `.go`                                                    |
| Rust                          | `.rs`                                                    |
| Java                          | `.java`                                                  |
| C#                            | `.cs`                                                    |
| C/C++                         | `.c` `.h` `.cpp` `.cc` `.cxx` `.c++` `.hpp` `.hh` `.hxx` |
| Ruby                          | `.rb` `.rake` `.gemspec`                                 |
| PHP                           | `.php` `.phtml`                                          |
| Swift                         | `.swift`                                                 |
| Dart                          | `.dart`                                                  |
| Solidity                      | `.sol`                                                   |
| Shell                         | `.sh` `.bash`                                            |

**通用层** —— 一个配置驱动的引擎，每种语言一份声明式规格。文件与函数清单精确，
调用关系尽力而为：

Kotlin（`.kt` `.kts`）· Scala（`.scala` `.sc`）· Zig（`.zig`）· Objective-C（`.m`）·
OCaml（`.ml`）

### 保真度是声明出来的，而且会传到下游

每个适配器都必须公布自己实际能交付什么：

```ts
readonly capabilities: AdapterCapabilities = {
  tier: 'full',
  callTypes: ['self_method', 'self_attr_method', 'param_method', 'internal_func', /* … */],
  selfAttrs: true,
  statementSpans: true,
};
```

阶段 1 把它**逐语言**记进图的元数据，渲染器再把它写进手册总览。
两层产出的 IR 看起来一模一样，所以没有这个声明，读者就会把通用层的调用边
当成 Python 级别的事实。**把话说出来，就是全部的意义。**

### 两个如实说明的注意点

- **Swift**：随包的语法在 V8 ≥ 13 上会让进程 abort（Node 24 上实测 5/5 必挂，
  Node 21 正常，而且十九种语法里只有它这样）。所以适配器在这种运行时上会
  **在发现阶段直接拒绝**，并给出解决办法 `node --liftoff-only`，
  而不是把你整次运行一起带走。
- **Shell**：含 `case` 语句的脚本会被跳过，因为那个语法会抛异常——它的外部扫描器
  import 了 `env.isalpha`，而当前锁定的 `web-tree-sitter` 动态链接器没有提供它。
  `case` 极其常见，所以实际上大多数非平凡脚本都会被跳过：在 `nvm` 上实测，
  6 个文件、122 个函数全部落空。**适配器是完整层的，但 Shell 的覆盖不是**，
  除非上游修好那个语法。扫描日志会点明原因，而不是让你自己去猜。

两者都会通过 logger 在扫描时报告。**任何东西都不会被悄悄丢掉。**

---

## API

### 适配器与注册表

```ts
registerBuiltinAdapters(): void            // 幂等；启动时调一次
registerAdapter(name, factory): void       // 注册你自己的
getAdapter(name): LanguageAdapter          // 抛错时会列出全部已注册语言
availableLanguages(): string[]
adapterForFile(relPath): LanguageAdapter | undefined   // 最长扩展名优先
discoverAll(root, logger?): Record<string, string[]>   // 先认领的适配器留住这个文件
discoverByExtension(root, exts, extraSkipDirs?, filter?): string[]
```

`COMMON_SKIP_DIRS` 是所有适配器共同遵守的跳过列表：`.git`、`node_modules`、`vendor`、
`target`、`build`、`dist`、`out`、`__pycache__`、`.venv`、`.idea`、`.vscode`、
`.handbook-patches` 等等。

### 适配器契约

```ts
interface LanguageAdapter {
  readonly name: string;
  readonly extensions: readonly string[];
  readonly capabilities: AdapterCapabilities; // 必填 —— 见上
  discover(sourceRoot: string): string[];
  analyze(files, sourceRoot, options?): Promise<ModuleAnalysis>;
  statementSpans?(filePath, qualname): Promise<Array<[number, number]> | undefined>;
}
```

**整个接口就这么多。** 实现它，`registerAdapter` 一下，下游每个阶段原封不动就能工作。

### 构图

```ts
buildGraph(analysis, options): BuildGraphResult
  // 划分保留/丢弃的边、标注出入度、
  // 为「被引用但没有显式定义」的构造函数合成节点
writeGraphArtifacts(result, outDir): void
functionsCsv(graph): string
graphDot(graph): string
categorizeDropped(calleeId): string
dedupeFunctionsById(functions): FunctionNode[]   // 后定义者胜
```

### 导航包（NavPack）

```ts
buildNavPack(graph, options?): NavPack
renderOrientation(nav, options?): string
allFileDescriptors(graph, nav): NavFileDescriptor[]
```

一张图的紧凑、适合喂给 LLM 的摘要——入口点、目录汇总、枢纽函数——
pipeline 用它来合成骨架，从而**不必把整张图塞进提示词**。

---

## 加一门语言

**通用层**（通常够用）：在 `src/generic.ts` 的 `GENERIC_LANGUAGES` 里加一条
`GenericLanguageSpec`——语法名、扩展名、表示「函数」「类」「调用」的节点类型，
以及限定名怎么拼。**不需要新依赖**：上面列出的语言的语法已经随 `tree-sitter-wasms` 一起发布。

**完整层**：在 `src/adapters/` 下实现 `LanguageAdapter`，声明诚实的 `capabilities`，
然后在 `src/register.ts` 里注册。

无论哪种，都要把显示名加进文档漂移测试——**已注册的语言如果没出现在 README 里，构建就会失败**。
之前那份列表正是这么落后了六种语言的。

---

## 设计说明

- **两遍分析。** 第一遍收集定义并建立类型索引；第二遍带着这些索引走调用点。
  这正是 `self.attr.method()` 和 `param.method()` 能被解析出来的原因。
- **「未解析」是一个类别，不是一次猜测。** 定位不到的调用带着原始文本和行号进
  `dropped-calls.json`。猜一个，就会给所有下游消费者塞进一批
  **看起来和真边一样可信**的假边。
- **一个坏掉的适配器不能搞垮发现流程。** `discoverAll` 会捕获单个适配器的失败、
  记日志，然后继续跑其余的。
- **`web-tree-sitter` 锁死在 `~0.25.10`。** 0.26 改了 WASM ABI，加载不了随包的语法。
  这个锁是刻意的，**不要放宽**。

---

## 测试

```bash
pnpm --filter @handbook/analyzer test
```

每个测试都解析真实的源码 fixture——**没有 mock 出来的语法树**，因为 mock 的树
证明不了任何关于语法的事。

---

[Handbook](../../README.zh-CN.md) 的一部分 · [架构](../../docs/architecture.md) ·
[产物格式](../../docs/formats.md) · MIT
