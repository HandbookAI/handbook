# @handbook/analyzer

多语言静态调用图提取，**完全不碰 LLM**。语言适配器用 tree-sitter（WASM）把源文件解析成 `@handbook/core` 里的共享 IR；
图构建器把 IR 组装成落盘的 `graph.json`（外加 CSV / DOT / 丢弃调用三份产物）——这是管线阶段 1 的产出，
后面每个阶段都消费它。它同时导出「导航包」（NavPack）：一份确定性的定位摘要，喂给骨架合成与文件归档。

> 英文版：[README.md](README.md)

## 职责

- 定义 `LanguageAdapter` 契约与适配器注册表（`registerAdapter`、`getAdapter`、`adapterForFile`、`discoverAll`）。
- 内置五个适配器：Python、TypeScript（`.ts` / `.tsx`）、Go、Rust、Shell（`.sh` / `.bash`）。
- 从适配器输出构建带度数标注的 `CodeGraph`，并**合成**那些「被边引用但源码里从未定义」的节点（隐式构造函数、边界符号）。
- 把无法解析的边**分流**到分类过的 `dropped-calls.json`，而不是让它们污染图。
- 产出阶段 1 的四份产物（`graph.json`、`functions.csv`、`graph.dot`、`dropped-calls.json`）与 `NavPack` 定位摘要。
- **不**调用任何 LLM，**不**知道手册的阶段、卡片或 work 目录布局。
- **不**做完整类型推导——解析是基于索引的尽力而为；解析不出来的一律变成分类过的丢弃边，
  **绝不猜一条边出来**。

## 公开 API

**适配器契约与注册表**（`adapter.ts`）
- `LanguageAdapter` —— `{ name, extensions, discover(sourceRoot), analyze(files, sourceRoot), statementSpans?(filePath, qualname) }`。
- `COMMON_SKIP_DIRS` —— 所有适配器发现文件时都跳过的目录名。
- `discoverByExtension(sourceRoot, extensions, extraSkipDirs?, filter?)` —— 默认的发现辅助函数。
- `registerAdapter(name, factory)` / `getAdapter(name)` / `availableLanguages()` —— 懒实例化的注册表。
- `adapterForFile(relPath)` —— 按**最长扩展名**匹配归属的适配器。
- `discoverAll(sourceRoot)` —— 每种语言一份文件列表；每个文件最多被一个适配器认领。
- `registerBuiltinAdapters()` —— 启动时一次性注册全部五个内置适配器。

**适配器**：`PythonAdapter`、`TypeScriptAdapter`、`GoAdapter`、`RustAdapter`、`ShellAdapter`，
各自实现 `LanguageAdapter`；只有 `PythonAdapter` 实现了 `statementSpans`（供 resync 使用的合法切分边界）。

**图构建**（`graph.ts`）
- `buildGraph(analysis, options): BuildGraphResult` —— `BuildGraphOptions`（`sourceRoot`、`scannedFiles`、`language`、
  `defaultExt?`、`now?`），`BuildGraphResult`（`graph`、`dropped`、`stats`）。
- `writeGraphArtifacts(result, outDir)` —— 落盘全部四份产物。
- `functionsCsv(graph)` / `graphDot(graph)` —— CSV 函数清单与 Graphviz 渲染。
- `synthesizeBoundary(id)` —— 把 `boundary:<qualname>` 形式的 id 变成 `BoundaryNode`，尽力拆出模块与类名。
- `categorizeDropped(calleeId)` —— 给一条解析不出的被调方归类（`builtin`、`self_attr_unknown`、`local_var_method`……）。

**导航包**（`navpack.ts`）
- `buildNavPack(graph, options?): NavPack` —— 目录地图、入口点候选、扇出 Top-K、外部子系统；
  `NavPackOptions`（`fanOutTopK?`、`sampleFnsPerFile?`）、`NavFileDescriptor`。
- `allFileDescriptors(graph, nav)` —— 在 nav 文件之外补上「一个函数都没有」的已扫描文件，
  得到卡片 / 归档所用的 1:1 文件集合。
- `renderOrientation(nav, options?)` —— 给提示词用的、长度有界的纯文本定位块；`OrientationOptions`。

**tree-sitter 运行时**（`languages.ts`）
- `loadLanguage(grammar)` / `createParser(grammar)` —— 按 `tree-sitter-wasms` 里的名字懒加载并缓存 WASM 语法。

## 用法

```ts
import { registerBuiltinAdapters, getAdapter, buildGraph, writeGraphArtifacts, buildNavPack, renderOrientation } from '@handbook/analyzer';

registerBuiltinAdapters();
const adapter = getAdapter('typescript');
const sourceRoot = '/path/to/project';
const files = adapter.discover(sourceRoot);
const analysis = await adapter.analyze(files, sourceRoot);

const result = buildGraph(analysis, { sourceRoot, scannedFiles: files, language: 'typescript' });
writeGraphArtifacts(result, '/path/to/work/phase1');

const nav = buildNavPack(result.graph);
console.log(renderOrientation(nav));
console.log(result.stats); // { functions, edgesKept, edgesDropped, internalNodes, boundaryNodes }
```

## 设计说明

- **只用 WASM 版 tree-sitter**：语法来自 `tree-sitter-wasms` 包，通过 `web-tree-sitter` 加载，
  所以**永远不需要**本地编译或 node-gyp；运行时与每个语法都是懒初始化并缓存的。
- **加一门语言 = 实现 `LanguageAdapter` 并调 `registerAdapter`**。图构建、丢弃调用分类、导航包对所有语言都是同一套。
- 适配器输出**全部**边，包括解析不出的；`buildGraph` 再把 `unresolved` 边分流进 `dropped-calls.json` 并按类别计数——
  图保持诚实，同时证据不丢。
- 边的端点若在源码里从未定义，就**合成**一个节点（`synthetic: true`，行号 0）而不是丢掉这条边，
  这样度数统计与图遍历始终自洽。
- `discoverAll` 让第一个发现某文件的适配器认领它，并**吞掉单个适配器的失败**——
  一门语法坏了不能让整个多语言扫描崩掉。

## 依赖

内部：
- `@handbook/core` —— IR 类型与 schema、`listFilesRecursive`、`truncate`、原子 JSON 写入。

外部：
- `web-tree-sitter` —— 编译成 WASM 的 tree-sitter 运行时（解析器 + 语法加载）。
- `tree-sitter-wasms` —— python / typescript / tsx / go / rust / bash 的预编译语法 `.wasm`。
