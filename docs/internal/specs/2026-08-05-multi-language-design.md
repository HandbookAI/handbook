# 多语言支持设计（SP1 地基）

日期：2026-08-05 · 状态：已批准，实施中

## 目标与背景

当前支持 5 门语言(python / typescript / go / rust / shell)。目标是把用户点名的这批做成**全保真**
一等公民:Java、C#、C、C++、Ruby、PHP、Swift、Dart、JavaScript、Solidity(+ 已有的 Shell 升级、
Go、Rust);**未点名的语言**(kotlin / scala / lua / elixir / zig / objc / ocaml / …)由通用引擎兜底。
PowerShell 本次不做(`tree-sitter-wasms` 无该语法,单独记待办)。

**关键事实(已验证)**:`tree-sitter-wasms@0.1.13` 已自带全部 10 门新语言的 wasm 语法文件,
**无需引入任何新依赖**,`web-tree-sitter@~0.25.x` 的版本锁不动。

**规模现实**:按现有规格(每个适配器 438–604 行)手写 9 门新语言 ≈ 4500 行。因此全量工作拆成
6 个子项目,各自一轮 规格 → 计划 → 实现:

| # | 子项目 | 内容 |
|---|---|---|
| **SP1** | **地基(本文档)** | 公共脊梁 + 保真度声明 + 通用引擎 + JavaScript |
| SP2 | Java + C# | package/namespace、import/using、方法调用、继承、注解 |
| SP3 | C + C++ | 头文件与 `#include`;C 无类,C++ 加类/命名空间/模板 |
| SP4 | Ruby + PHP | 动态派发,`require`/`use`,无类型标注 |
| SP5 | Swift + Dart | 现代 OO + 类型推断、protocol/mixin |
| SP6 | Solidity + Shell 升级 | Solidity 状态变量天然对应"状态寄存器";Shell 从降级升到全保真 |

## 为什么先做地基

审计发现的 A1 是**结构性缺陷的症状**:跨模块自由函数索引这个零件,python 和 rust 有,
typescript 和 go 没有——四个镜像实现,两个漏装,且 TS 的测试还把错误行为写成了断言。
四个适配器就漏一个零件;再加九个手写适配器,这类 bug 会翻三倍。

地基的作用不是省代码行数,而是**让"忘记装某个零件"在结构上不可能发生**。

## 设计

### 1. 公共脊梁(`packages/analyzer/src/spine.ts`)

5 个适配器的 `analyze()` 是同一个骨架,只有三处变化。脊梁提供:

**1.1 驱动器** `createAdapter(spec): LanguageAdapter`

拥有:建 parser、逐文件读(读失败跳过)、解析(树为 null 跳过)、按需按 moduleId 合并、
`flatMap` 汇总 functions/edges。每门语言不再重复这 25 行。

```ts
interface LanguageSpec<S extends BaseScan> {
  name: string;
  extensions: readonly string[];
  /** 按文件选语法:TS 的 .tsx → 'tsx',其余 → 'typescript'。 */
  grammarFor(file: string): string;
  extraSkipDirs?: readonly string[];
  discoverFilter?: (rel: string) => boolean;
  moduleIdForFile(file: string): string;
  /** true = 同 moduleId 的多个文件合并进一个 scan(Rust 的 inline mod)。 */
  mergeByModule?: boolean;
  emptyScan(moduleId: string): S;
  scan(scan: S, root: Node, file: string): void;
  /** 语言私有索引;公共索引由 buildStandardIndexes 统一构建。 */
  buildIndexes?(scans: readonly S[], std: StandardIndexes): unknown;
  extractCalls(scan: S, std: StandardIndexes, own: unknown): CallEdge[];
  capabilities: AdapterCapabilities;
  statementSpans?: LanguageAdapter['statementSpans'];
}
```

**1.2 `BaseScan`** —— 统一命名那 6 个通用字段,语言私有字段进 `extra` 槽:

```ts
interface BaseScan {
  moduleId: string;
  files: string[];                              // 单文件语言长度恒为 1
  functions: FunctionNode[];
  fnContext: Map<string, unknown>;              // 语言自定上下文形状
  imports: Map<string, string>;                 // 本地名 → 路径(语义按语言)
  ownerMethods: Map<string, Set<string>>;       // 类/类型 → 方法名(原 classes/methods)
  fieldTypes: Map<string, string>;              // `Owner.field` → 裸类型名
  freeFunctions: Set<string>;                   // 顶层/自由函数名
}
```

**1.3 `buildStandardIndexes(scans)`** —— 每门 OO 语言都需要的四张表,**一次建全**:

```ts
interface StandardIndexes {
  typeToModule: Map<string, string>;                  // 裸类型名 → moduleId
  typeMethods: Map<string, Set<string>>;              // `moduleId.Type` → 方法名
  moduleFunctions: Map<string, Set<string>>;          // moduleId → 自由函数名  ← A1 缺的就是这张
  directoryFunctions: Map<string, Map<string, string>>; // 目录 → 函数名 → moduleId(同包兄弟)
  moduleIds: Set<string>;
}
```

**1.4 解析助手(工具箱,不是框架)**

*设计修正*:最初设想"公共层固定解析顺序,语言只提供取值器"。深入分析后放弃——C 没有方法、
Ruby 没有类型标注、Solidity 有 modifier,强行统一会做出漏抽象的紧身衣。改为提供无状态助手,
各语言在自己的 `extractCalls` 里按自己的次序调用:

- `resolveSameFileFree(name, scan)` → 同文件自由函数
- `resolveSiblingPackage(name, scan, std)` → 同目录/同包兄弟文件
- `resolveViaImport(localName, scan, std, opts)` → 导入符号(在扫描集内 = 内部,否则 boundary)
- `resolveOwnMethod(owner, method, scan, std)` → `self.m()` / `recv.M()`
- `resolveFieldType(owner, field, method, scan, std)` → 靠学到的字段类型解析 `self.field.m()`
- `boundaryOf(path, member)` / `unresolvedOf(hint)` → 统一的兜底 id 构造

**硬约束**:现有 5 门语言迁移后行为**逐字节不变**。59 个 analyzer 测试是安全网,
重构中不许改任何断言。这是本子项目的成败判据。

### 2. 保真度声明(诚实性要求)

一旦仓库里存在两档保真度,必须**让它可见**——否则读者(尤其 agent)会以为 C++ 手册的调用事实
和 Python 一样硬。沿用本项目既有的"覆盖率诚实"原则(Studio 区分"已归档"与"已描述")。

```ts
interface AdapterCapabilities {
  tier: 'full' | 'generic';
  /** 这个适配器**能**产出的 callType 白名单。 */
  callTypes: readonly CallType[];
  /** 能否追踪 self/this 属性读写(决定"状态寄存器"推断的强度)。 */
  selfAttrs: boolean;
  /** 能否给出语句跨度(决定 resync 的 snap 精度)。 */
  statementSpans: boolean;
}
```

透传路径:适配器声明 → `graph.metadata.languages[<name>]`(多语言图会混档,所以按语言记)
→ 渲染层与 Studio 展示。**通用档的手册必须在概览里写明"本语言的调用事实为通用档"**。

`generic` 档能产出:`internal_func` / `self_method` / `internal_constructor` / `boundary` /
`unresolved`。**产不出**:`self_attr_method` / `param_method`(需要类型推断)。

### 3. 通用引擎(`packages/analyzer/src/generic.ts`)

吃一份声明式 `GenericLanguageSpec`,覆盖未点名的语言。加一门语言 = 40–80 行配置 + 一个 fixture
测试仓库,而不是 500 行代码。

```ts
interface GenericLanguageSpec {
  name: string;
  grammar: string;
  extensions: readonly string[];
  extraSkipDirs?: readonly string[];
  /** AST 节点类型清单(不同语法命名不同)。 */
  nodes: {
    function: readonly string[];      // 'function_declaration' | 'method_declaration' | …
    class: readonly string[];
    call: readonly string[];
    import: readonly string[];
  };
  /** 取名字/函数体的 field 名,默认 'name' / 'body'。 */
  fields?: { name?: string; body?: string; arguments?: string };
  /** 视为"自身"的接收者关键字,用于 self_method 判定。 */
  selfKeywords?: readonly string[];
  /** 模块 id 推导,默认"去扩展名 + 路径分隔符换点"。 */
  moduleIdForFile?: (file: string) => string;
}
```

首批实际交付:**kotlin、scala、zig、objc、ocaml**。

放弃两门,原因记录在案(下次不必重新踩):

- **elixir** —— `defmodule` / `def` / `import` 与普通函数调用在语法树里**是同一种 `call` 节点**,
  任何"节点类型清单"都无法区分"定义"与"调用"。声明式配置在这门语言上不成立,它需要手写适配器。
- **lua** —— 锁定版本的 `tree-sitter-lua` wasm **本身有缺陷**:遇到普通顶层语句就报错,并且
  **丢掉哪些函数声明取决于同一个 parser 之前解析过什么**(`helper.lua` 单独解析得 1 个函数;
  先解析过兄弟文件后得 0 个)。用独立探针复现,其余语法在同一测试下均 `hasError=false` 且顺序无关。
  **不可复现的事实比没有事实更糟**,故本轮不收 lua,等语法重建后再议。

实测节点类型(全部读自真实语法树,无一处猜测):

| 语言 | 扩展名 | 声明的 callTypes | fixture 产出 |
|---|---|---|---|
| kotlin | `.kt .kts` | internal_func, internal_constructor, self_method, boundary, unresolved | 7 函数 / 10 边 |
| scala | `.scala .sc` | 同上 5 种 | 6 函数 / 8 边 |
| zig | `.zig` | internal_func, unresolved | 4 函数 / 5 边 |
| objc | `.m` | internal_func, self_method, boundary, unresolved | 5 函数 / 7 边 |
| ocaml | `.ml` | internal_func, boundary, unresolved | 3 函数 / 4 边 |

### 暴露的一个 IR 层空缺(留给后续子项目)

`CallType` 里**没有"对已扫描类型的限定调用"这一种**——`Helpers.shout()`、`[Engine reset]` 这类
"目标就在扫描集内、但通过类型名限定调用"的边,只能降级为 `unresolved`(退成 `boundary` 会
谎称目标在外部,更糟)。补一个 `static_method` 之类需要动 IR schema,超出 SP1 范围;
SP2 做 Java/C# 时会**大量**遇到静态方法调用,届时正式评估。

### 4. JavaScript(白送)

已验证:**TypeScript 语法解析纯 JS 零错误**,7 个关键节点类型全覆盖
(`class_declaration` / `method_definition` / `function_declaration` / `import_statement` /
`arrow_function` / `call_expression` / `new_expression`)。

所以不写新适配器,只在现有 TS 适配器上加扩展名与语法映射:
`.js` / `.mjs` / `.cjs` → `typescript` 语法;`.jsx` → `tsx` 语法。
排除规则沿用(`.d.ts` 已排除,新增 `.min.js` 排除)。

## capability 声明的语义边界(实测发现)

`AdapterCapabilities.callTypes` 声明的是**这个适配器有能力产出哪些调用类型**,不是"覆盖密度的承诺"。
实测例证:JavaScript 复用 TS 适配器,因此声明 `tier: 'full'` + 全部 8 种调用类型——这是真的;
但真实 JS 代码缺少类型标注,所以类型驱动的那几种(`self_attr_method` / `param_method`)实际触发得
比 TS 少。同样地 `const e = new Engine(); e.spin()` 不产出边,因为 TS 适配器学字段与参数类型、
**不做局部变量推断**(TS 源码里行为一致,不是 JS 引入的退化)。

结论:声明是**能力上界**,读者对"密度"的期待要由覆盖率数字回答,而不是由 tier 回答。渲染层的
披露文案因此只说"generic 档的调用关系尽力而为",不对 full 档承诺完备性。

## 测试策略

- **回归**:59 个现有 analyzer 测试是迁移的安全网,断言一律不动。全绿 = 行为未变。
- **脊梁单测**:`buildStandardIndexes` 的四张表(含 A1 那张)、各助手的命中/未命中/歧义分支。
- **通用引擎**:每门配置语言一个临时目录 fixture 仓库(照现有 adapter 测试的写法),
  断言 文件发现 / 函数抽取 / 同文件调用 / 声明的 capability 与实际产出一致。
- **capability 一致性测试**:对每个适配器,跑一遍 fixture 后断言"实际产出的 callType 集合
  ⊆ 声明的 callTypes"——**防止声明与实现漂移**(本项目吃过多次形状漂移的亏)。
- **JavaScript**:.js/.mjs/.cjs/.jsx 各一个 fixture,断言与等价 TS 源产出同构。

## 验收

1. `pnpm check` 全绿,且 analyzer 的 59 个既有测试断言零修改。
2. `bash examples/run-demo.sh` 与 `NARRATE_LANG=zh` 两条都通。
3. 对 `packages/` 自分析一次(`pnpm demo:self`),图规模与迁移前一致(93 文件 / 416 函数量级)。
4. 新增:一个 JS fixture 仓库与一个 kotlin fixture 仓库能各自产出非空的 functions + edges。
5. `graph.metadata.languages` 带上每门语言的 capability,渲染层可见。

## 非目标(本子项目不做)

- 不做 Java/C#/C/C++/Ruby/PHP/Swift/Dart/Solidity 的全保真适配器 —— 那是 SP2–SP6。
- 不做 PowerShell(无语法文件)。
- 不做类型推断引擎升级 —— 各语言的类型学习仍在各自适配器内。
- 不改 `web-tree-sitter` 版本锁(0.26 与现有 wasm 语法 ABI 不兼容)。
