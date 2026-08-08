# 配置登记表与脚本体系 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每一项配置只声明一次，由同一张登记表派生 CLI flag、环境变量、配置文件、`.env.example` 与文档，使三个界面互相兼容且不可能漂移。

**Architecture:** `packages/core/src/config/` 放一张声明式登记表 + 一个带来源追踪的解析器（flag > shell env > `.env` > `handbook.config.yaml` > 默认值）。`packages/cli/src/main.ts` 不再手写选项，改为按 `commands` 从登记表派生 commander 选项，并在 **action 时**求值。`.env.example` 与 `docs/configuration.md` 由 core 里的渲染函数生成，vitest 漂移测试逐字节比对仓库内文件。

**Tech Stack:** TypeScript 5（纯 ESM + NodeNext，相对导入必须带 `.js`）、commander、`yaml@^2.9.0`（工作区 catalog 已有）、zod、vitest、pnpm workspace、changesets、husky + lint-staged + commitlint。

**规格：** `docs/internal/specs/2026-08-07-config-and-scripts-design.md`（已批准）。本计划实现它的全部四个阶段。

## Global Constraints

每个 Task 的要求都隐含包含本节。值一律照抄规格，不要凭印象改。

- Node `>=20.11`；`packageManager` 固定 `pnpm@10.18.1`。
- **第三方版本只许住在 `pnpm-workspace.yaml` 的 catalog 里**，各包 manifest 一律写 `"catalog:"`。`yaml@^2.9.0` 已在 catalog 中（`pipeline` 在用），`core` 只需加 `"yaml": "catalog:"`。不引入任何其他新依赖。
- 纯 ESM + NodeNext：**所有相对导入必须带 `.js` 后缀**（`./coerce.js`，即使源文件是 `.ts`）。
- **测试前必须先 build**：跨包导入靠 `tsc -b` 的产物；`vitest.config.ts` 另有 alias 把 `@handbook/*` 指向 `packages/*/src/index.ts`。
- **覆盖率地板是按包的，且永远不许调低阈值**（`vitest.config.ts` 里有明文警告）。当前地板：`cli` 22/22/21/20，`core` 84/78/81/86，`llm` 93/89/96/96，`pipeline` 81/68/84/83，`studio` 81/69/87/83。掉了就补测试。
- `docs/internal/` 是 **prettier-ignored**（行首 `+` 是"加号"不是列表符），本计划与规格都在其中，不要试图格式化。
- 新增/改动的公共 API 必须在 `packages/core/src/index.ts` 这类 barrel 里导出；`scripts/check-workspace.mjs` 会校验包间依赖与 tsconfig project references 一致。
- 提交遵循 conventional commits（commitlint 在 husky 里把关）；每个 Task 至少一个提交。
- **绝不提及参考项目的名字、论文、链接或其示例项目名**（用户明确规则 D2）。
- `pnpm config`、`pnpm test`、`pnpm publish`、`pnpm pack`、`pnpm version` 等是 **pnpm 内置命令**，同名脚本会被遮蔽——所以本计划用 `config:show` 而不是 `config`。

## File Structure

**新建（core，纯逻辑，测试都放同目录同名 `.test.ts`）**

| 文件 | 唯一职责 |
|---|---|
| `packages/core/src/config/types.ts` | `Setting` / `SettingType` / `Source` / `ResolveResult` 类型；无逻辑 |
| `packages/core/src/config/defaults.ts` | `PIPELINE_DEFAULTS` —— 流水线调优默认值的唯一来源 |
| `packages/core/src/config/names.ts` | 命名变换：camelCase ↔ `HANDBOOK_SCREAMING_SNAKE`、配置文件键路径 |
| `packages/core/src/config/coerce.ts` | `ConfigError` + 按 `type` 把原始字符串强制转换并大声校验 |
| `packages/core/src/config/registry.ts` | 约 60 项配置的声明表 + `settingsFor(command)` |
| `packages/core/src/config/file.ts` | `handbook.config.yaml` 的发现、解析、扁平化、secret 拒绝 |
| `packages/core/src/config/resolve.ts` | 分层求值 + 来源追踪 + 解析后必填检查 |
| `packages/core/src/config/render-docs.ts` | `renderEnvExample()` / `renderConfigDocs()` 纯字符串渲染 |

**新建（cli 侧薄接线）**

| 文件 | 唯一职责 |
|---|---|
| `packages/cli/src/options.ts` | 由登记表派生 commander 选项；**不设 commander 默认值** |
| `packages/cli/src/resolve-config.ts` | 把 commander opts + env + 配置文件喂给 core 解析器，错误合并后抛出 |
| `packages/cli/src/config-command.ts` | `handbook config` 的渲染（表格 / `--json` / 打码） |

**新建（仓库根）**

- `scripts/gen-config-docs.mjs` —— 调用 core 的渲染函数写盘，`pnpm run config:docs`
- `handbook.config.example.yaml` —— 配置文件示例（生成）

**修改**

- `package.json` scripts 全量重写（Task 1）
- `scripts/clean.mjs` 加 `--node-modules`（Task 1）
- `.github/workflows/ci.yml`、`release.yml`、`README.md`、`README.zh-CN.md` 脚本改名同步（Task 1）
- `packages/cli/src/docs-drift.test.ts` 加脚本名漂移测试（Task 1）与配置文档漂移测试（Task 10）
- `packages/core/src/index.ts` 导出 config 模块
- `packages/core/package.json` 加 `"yaml": "catalog:"`
- `packages/pipeline/src/{cards,assign,organize,narrate,doctor,generate}.ts` 默认值改为引用 `PIPELINE_DEFAULTS`
- `packages/llm/src/client.ts` `resolveLlmEnv` 改为走登记表、非法值大声失败
- `packages/cli/src/main.ts` 选项改为派生（应当变短）
- `packages/cli/src/args.ts` + `args.test.ts` 删除（职责移入 `coerce.ts`）
- `packages/studio/src/server.ts` 默认 clientFactory 走同一解析器
- `.env.example`、`docs/configuration.md`（生成物）

**Task 依赖**：Task 1 完全独立（可以先做）。Task 2 → 3 → 4 → 5 → 6 → 7 顺序依赖。Task 8 → 9 → 10 依赖 6。Task 11 收尾。

---

### Task 1: 脚本体系重构（独立，可先做）

**Files:**
- Modify: `package.json:12-47`（scripts 整块）
- Modify: `scripts/clean.mjs:6-32`
- Modify: `.github/workflows/ci.yml:4-5,113`、`.github/workflows/release.yml:57-58`
- Modify: `README.md:215,244`、`README.zh-CN.md:193,216`
- Test: `packages/cli/src/docs-drift.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: 无
- Produces: 脚本名 `check:install`（原 `smoke:install`）、`release:version`（原 `version-packages`）、`release:publish`（原 `release`）、`cli`、`config:docs`、`config:show`、`ci`。后续 Task 10 会用 `pnpm run config:docs`。

**背景：** `tsc -b &&` 被复制 12 次；11 个 CLI 透传脚本有 10 个是同一字符串改一个词。已实测 `pnpm run` 嵌套两层仍能透传参数：`pnpm run gen --source y --resume` → `ARGV: ["generate","--source","y","--resume"]`。**直接重命名，不留别名**（用户 2026-08-07 决定）。

- [ ] **Step 1: 写失败测试 —— README 里提到的 pnpm 脚本必须真实存在**

追加到 `packages/cli/src/docs-drift.test.ts` 末尾（文件已有 `repoRoot` 与 `read` 两个辅助，直接复用）：

```ts
describe('documented pnpm scripts exist', () => {
  const scripts = Object.keys(
    (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
  );
  // `pnpm <x>` may legitimately be a pnpm builtin (`pnpm install`) or a local
  // binary (`pnpm commitlint`), neither of which is a script in this manifest.
  // Reading .bin keeps that allowlist self-maintaining instead of hand-listed.
  const binDir = join(repoRoot, 'node_modules', '.bin');
  const bins = existsSync(binDir) ? readdirSync(binDir) : [];
  const BUILTINS = new Set([
    'install', 'add', 'remove', 'update', 'why', 'store', 'dlx', 'exec', 'run', 'test',
    'list', 'ls', 'outdated', 'licenses', 'publish', 'pack', 'config', 'env', 'setup',
    'link', 'unlink', 'import', 'rebuild', 'prune', 'fetch', 'deploy', 'patch', 'audit',
    'bin', 'root', 'recursive', 'dedupe', 'up', 'init', 'create', 'doctor', 'start', 'version',
  ]);

  for (const doc of ['README.md', 'README.zh-CN.md']) {
    it(`${doc} names no nonexistent pnpm script`, () => {
      const named = [...read(doc).matchAll(/\bpnpm (?:run )?([a-z][a-z0-9:-]*)/g)].map(
        (m) => m[1] as string,
      );
      const missing = [...new Set(named)].filter(
        (name) => !scripts.includes(name) && !BUILTINS.has(name) && !bins.includes(name),
      );
      expect(missing, `${doc} references missing script(s): ${missing.join(', ')}`).toEqual([]);
    });
  }
});
```

同时把该文件顶部的 import 补齐（现有只 import 了 `readFileSync`）：

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
```

- [ ] **Step 2: 运行测试确认它是绿的（此刻还没改名，所以应当通过）**

Run: `pnpm run build && npx vitest run packages/cli/src/docs-drift.test.ts`
Expected: PASS —— 这一步是把"改名会打破文档"这件事先钉住；下一步改名后它会变红，那才是它的价值。

- [ ] **Step 3: 重写 `package.json` 的 scripts**

把 `package.json` 第 12–47 行整块 `"scripts": { … }` 替换为：

```json
  "scripts": {
    "build": "tsc -b",
    "build:watch": "tsc -b --watch",
    "clean": "tsc -b --clean && node scripts/clean.mjs",
    "clean:all": "pnpm run clean && node scripts/clean.mjs --node-modules",
    "typecheck": "tsc -b && tsc -p tsconfig.tests.json",
    "lint": "eslint . --max-warnings 0",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "pnpm run build && vitest run",
    "test:watch": "vitest",
    "test:coverage": "pnpm run build && vitest run --coverage",
    "check": "pnpm run typecheck && pnpm run check:workspace && pnpm run lint && pnpm run format:check && pnpm run test:coverage",
    "check:all": "pnpm run check && pnpm run check:packaging && pnpm run check:install",
    "check:workspace": "node scripts/check-workspace.mjs",
    "check:packaging": "pnpm run build && node scripts/check-packaging.mjs",
    "check:install": "pnpm run build && node scripts/smoke-install.mjs",
    "ci": "pnpm run check:all",
    "config:docs": "pnpm run build && node scripts/gen-config-docs.mjs",
    "changeset": "changeset",
    "release:version": "changeset version && pnpm install --lockfile-only",
    "release:publish": "pnpm run build && changeset publish",
    "release:status": "changeset status --verbose",
    "cli": "pnpm run build && node packages/cli/dist/main.js",
    "handbook": "pnpm run cli",
    "analyze": "pnpm run cli analyze",
    "generate": "pnpm run cli generate",
    "render": "pnpm run cli render",
    "skill": "pnpm run cli skill",
    "validate": "pnpm run cli validate",
    "plan": "pnpm run cli plan",
    "apply": "pnpm run cli apply",
    "rollback": "pnpm run cli rollback",
    "resync": "pnpm run cli resync",
    "studio": "pnpm run cli studio",
    "config:show": "pnpm run cli config",
    "demo": "bash examples/run-demo.sh",
    "demo:self": "bash examples/run-self.sh",
    "demo:self:real": "bash examples/run-self.sh --real",
    "mock-llm": "node examples/mock-llm-server.mjs 8099",
    "prepare": "husky"
  },
```

三点注意：`lint` 现在自带 `--max-warnings 0`（原先只在 `check` 里内联，家族内不一致）；`check` 完全由具名脚本组合，零重复命令字符串；`config:show` 不叫 `config` 是因为 `pnpm config` 是 pnpm 内置命令会遮蔽脚本。

- [ ] **Step 4: 给 `clean.mjs` 加 `--node-modules`**

在 `scripts/clean.mjs` 第 11 行 `const removed = [];` 之后插入：

```js
// `clean:all` also drops installed dependencies. Kept in this script rather
// than an `rm -rf` in package.json for the same reason the rest of it is here:
// cmd.exe has no rm.
const alsoNodeModules = process.argv.includes('--node-modules');
```

并在第 30 行 `drop(join(ROOT, 'coverage'));` 之后插入：

```js
// Last, so the packages/ walk above still has directories to read.
if (alsoNodeModules) {
  for (const dir of readdirSync(join(ROOT, 'packages'))) {
    const pkg = join(ROOT, 'packages', dir);
    if (statSync(pkg).isDirectory()) drop(join(pkg, 'node_modules'));
  }
  drop(join(ROOT, 'node_modules'));
}
```

- [ ] **Step 5: 同步所有调用方，然后运行 Step 1 的测试看它变红再变绿**

`.github/workflows/ci.yml` 第 113 行 `- run: pnpm smoke:install` → `- run: pnpm run check:install`；第 4–5 行注释里的 `pnpm smoke:install` → `pnpm run check:install`。
`.github/workflows/release.yml` 第 57–58 行：`version: pnpm version-packages` → `version: pnpm run release:version`，`publish: pnpm release` → `publish: pnpm run release:publish`。
`README.md:215` 与 `README.zh-CN.md:193` 的 `pnpm smoke:install` → `pnpm run check:install`（两行的行内注释保持原文）；`README.md:244`、`README.zh-CN.md:216` 正文里的 `pnpm smoke:install` 同样替换。

Run: `npx vitest run packages/cli/src/docs-drift.test.ts`
Expected: 若有任何一处漏改 → FAIL 且报出 `references missing script(s): smoke:install`；全部改完 → PASS。

- [ ] **Step 6: 实测重命名后的脚本与透传都真的能跑**

```bash
pnpm run clean && pnpm run build && pnpm run lint && pnpm run check:workspace
pnpm run handbook --help          # 透传：应打印 CLI 顶层帮助
pnpm run analyze --help           # 透传：应打印 analyze 的帮助
```
Expected: 四条 check 命令退出码 0；两条 `--help` 打印帮助而不是 pnpm 的用法。

- [ ] **Step 7: 提交**

```bash
git add package.json scripts/clean.mjs .github/workflows/ci.yml .github/workflows/release.yml README.md README.zh-CN.md packages/cli/src/docs-drift.test.ts
git commit -m "refactor(repo): make the script families compose instead of repeat

tsc -b was copy-pasted into 12 scripts and 10 of the 11 CLI passthroughs
were one string with a word changed. check is now a composition of named
scripts, every CLI passthrough delegates to one cli script, and the
families are consistent: smoke:install joins check:*, release/version-packages
become release:publish/release:version. Renamed outright, no aliases — a
new drift test fails the build if a README names a script that does not
exist, which is what the aliases would otherwise have hidden."
```

---

### Task 2: 配置类型、命名变换与登记表自检

**Files:**
- Create: `packages/core/src/config/types.ts`
- Create: `packages/core/src/config/names.ts`
- Create: `packages/core/src/config/names.test.ts`
- Create: `packages/core/src/config/registry.ts`（先只放全局项与 LLM 项，Task 5 补全）
- Create: `packages/core/src/config/registry.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Setting`、`SettingType`、`Source`、`envName(key)`、`scopedEnvName(command, key)`、`fileKeyCandidates(command, setting)`、`SETTINGS`（数组）、`settingsFor(command)`、`settingByKey(key)`

- [ ] **Step 1: 写类型（无逻辑，无测试）**

`packages/core/src/config/types.ts`：

```ts
/**
 * One declarative table describes every setting exactly once, and the CLI
 * options, the environment variables, the config file, `.env.example` and the
 * reference docs are all derived from it.
 *
 * The alternative is what this repo already had: each switch wired where it was
 * needed, which left exactly one of ~45 flags (`--title`) also settable from the
 * environment, no flags at all for the LLM endpoint, and six real pipeline
 * fields reachable from neither.
 */
export type SettingType = 'string' | 'int' | 'bool' | 'enum' | 'path' | 'json';

export interface Setting {
  /** camelCase identity. Derives the env name, the config-file key and the resolved property. */
  readonly key: string;
  readonly type: SettingType;
  /** Commander flag spec, e.g. `--read-workers <n>`. Absent = not settable on the command line. */
  readonly flag?: string;
  /** Subcommands this setting applies to. */
  readonly commands: readonly string[];
  /** One line, English. Goes verbatim into `--help`, `.env.example` and the docs. */
  readonly doc: string;
  /**
   * Value used when no layer supplies one. `undefined` means *pass through*:
   * the key is omitted from the resolved object entirely so a downstream
   * default (e.g. the pipeline's own) still applies.
   */
  readonly default?: string | number | boolean;
  /** Required for `int`. */
  readonly min?: number;
  /** Required for `enum`. */
  readonly choices?: readonly string[];
  /** Additional accepted env names, for vendor standards like `OPENAI_MODEL`. */
  readonly envAliases?: readonly string[];
  /** Semantics differ per command (`--out`, `--lang`): register only the scoped name. */
  readonly scopedOnly?: boolean;
  /** Never a flag, never allowed in the config file (it gets committed). */
  readonly secret?: boolean;
  /** Commander maps `--no-llm` to `{ llm: false }`; the flag string is the negated one. */
  readonly negated?: boolean;
  /** Must have a value after resolution; the error names all supply routes. */
  readonly required?: boolean;
  /** Placeholder shown in `.env.example` when there is no default to show. */
  readonly example?: string;
}

/** Where a resolved value came from. Surfaced by `handbook config`. */
export type Source =
  | { readonly kind: 'flag'; readonly name: string }
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'file'; readonly path: string; readonly keyPath: string }
  | { readonly kind: 'default' };

export interface ResolveResult {
  /** Only the keys that resolved. Pass-through settings are absent when unset. */
  readonly values: Record<string, unknown>;
  readonly sources: Record<string, Source>;
  /** Every problem found, not just the first — `config --check` prints them all. */
  readonly errors: readonly string[];
}
```

- [ ] **Step 2: 写 names 的失败测试**

`packages/core/src/config/names.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { envName, scopedEnvName, fileKeyCandidates } from './names.js';
import type { Setting } from './types.js';

const setting = (over: Partial<Setting> = {}): Setting => ({
  key: 'readWorkers',
  type: 'int',
  commands: ['generate'],
  doc: 'concurrent card batches',
  ...over,
});

describe('envName', () => {
  it('screaming-snakes a camelCase key under the HANDBOOK_ prefix', () => {
    expect(envName('readWorkers')).toBe('HANDBOOK_READ_WORKERS');
    expect(envName('detail')).toBe('HANDBOOK_DETAIL');
  });

  it('keeps consecutive capitals readable in the compound LLM keys', () => {
    // HANDBOOK_LLM_MODEL and HANDBOOK_LLM_BASE_URL already exist as aliases in
    // client.ts — the transformation must land on exactly those names.
    expect(envName('llmModel')).toBe('HANDBOOK_LLM_MODEL');
    expect(envName('llmBaseUrl')).toBe('HANDBOOK_LLM_BASE_URL');
    expect(envName('llmApiKey')).toBe('HANDBOOK_LLM_API_KEY');
    expect(envName('htmlSingle')).toBe('HANDBOOK_HTML_SINGLE');
  });
});

describe('scopedEnvName', () => {
  it('inserts the command between the prefix and the key', () => {
    expect(scopedEnvName('generate', 'readWorkers')).toBe('HANDBOOK_GENERATE_READ_WORKERS');
    expect(scopedEnvName('render', 'out')).toBe('HANDBOOK_RENDER_OUT');
  });
});

describe('fileKeyCandidates', () => {
  it('prefers the command-scoped flat key over the bare one', () => {
    expect(fileKeyCandidates('generate', setting())).toEqual(['generateReadWorkers', 'readWorkers']);
  });

  it('omits the bare key for scopedOnly settings', () => {
    // `--out` means three different things across render/skill/plan, so a bare
    // `out:` in the config file would be a footgun rather than a convenience.
    expect(fileKeyCandidates('render', setting({ key: 'out', scopedOnly: true }))).toEqual([
      'renderOut',
    ]);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run packages/core/src/config/names.test.ts`
Expected: FAIL —— `Failed to resolve import "./names.js"`

- [ ] **Step 4: 实现 names.ts**

```ts
/**
 * The one transformation shared by all three surfaces, so nothing has to be
 * remembered: `readWorkers` ⇄ `HANDBOOK_READ_WORKERS` ⇄ `readWorkers:` in the
 * config file, and adding a command prefix is the same operation on each.
 */
import type { Setting } from './types.js';

const PREFIX = 'HANDBOOK';

/** `readWorkers` → `READ_WORKERS` */
function screamingSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** `readWorkers` → `HANDBOOK_READ_WORKERS` */
export function envName(key: string): string {
  return `${PREFIX}_${screamingSnake(key)}`;
}

/** `generate`, `readWorkers` → `HANDBOOK_GENERATE_READ_WORKERS` */
export function scopedEnvName(command: string, key: string): string {
  return `${PREFIX}_${command.toUpperCase()}_${screamingSnake(key)}`;
}

/**
 * Config-file lookup keys, most specific first. The file is flattened by
 * camelCase join (`generate: { readWorkers: 4 }` → `generateReadWorkers`), which
 * is why command scoping needs no special case here.
 */
export function fileKeyCandidates(command: string, setting: Setting): string[] {
  const scoped = `${command}${setting.key[0]?.toUpperCase() ?? ''}${setting.key.slice(1)}`;
  return setting.scopedOnly ? [scoped] : [scoped, setting.key];
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run packages/core/src/config/names.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 6: 写登记表自检的失败测试**

`packages/core/src/config/registry.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SETTINGS, settingsFor, settingByKey } from './registry.js';
import { envName, scopedEnvName } from './names.js';

describe('registry integrity', () => {
  // Each of these is a declaration mistake that would otherwise surface as a
  // confusing runtime failure or a silently unreachable setting.
  it('has no duplicate keys', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('gives every int a min and every enum its choices', () => {
    expect(SETTINGS.filter((s) => s.type === 'int' && s.min === undefined).map((s) => s.key)).toEqual(
      [],
    );
    expect(
      SETTINGS.filter((s) => s.type === 'enum' && !s.choices?.length).map((s) => s.key),
    ).toEqual([]);
  });

  it('keeps an enum default inside its own choices', () => {
    const bad = SETTINGS.filter(
      (s) => s.type === 'enum' && s.default !== undefined && !s.choices?.includes(String(s.default)),
    );
    expect(bad.map((s) => s.key)).toEqual([]);
  });

  it('never puts a secret on the command line', () => {
    // A flag would put the key in shell history and in `ps` output.
    expect(SETTINGS.filter((s) => s.secret && s.flag).map((s) => s.key)).toEqual([]);
  });

  it('declares at least one command per setting', () => {
    expect(SETTINGS.filter((s) => s.commands.length === 0).map((s) => s.key)).toEqual([]);
  });

  it('has no flag collision within any one command', () => {
    for (const command of [...new Set(SETTINGS.flatMap((s) => s.commands))]) {
      const flags = settingsFor(command)
        .map((s) => s.flag?.split(/[ ,]/)[0])
        .filter((f): f is string => Boolean(f));
      expect(flags.filter((f, i) => flags.indexOf(f) !== i), `command ${command}`).toEqual([]);
    }
  });

  it('has no env-name collision across the whole table', () => {
    const names = SETTINGS.flatMap((s) => [
      ...(s.scopedOnly ? [] : [envName(s.key)]),
      ...s.commands.map((c) => scopedEnvName(c, s.key)),
      ...(s.envAliases ?? []),
    ]);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it('exposes the vendor env aliases the toolchain already documented', () => {
    // These are load-bearing: existing .env files and both READMEs use them.
    expect(settingByKey('llmApiKey')?.envAliases).toContain('OPENAI_API_KEY');
    expect(settingByKey('llmModel')?.envAliases).toContain('OPENAI_MODEL');
    expect(settingByKey('llmBaseUrl')?.envAliases).toContain('OPENAI_BASE_URL');
  });
});

describe('settingsFor', () => {
  it('returns only the settings that declare the command', () => {
    expect(settingsFor('generate').every((s) => s.commands.includes('generate'))).toBe(true);
  });

  it('is empty for an unknown command rather than throwing', () => {
    expect(settingsFor('nope')).toEqual([]);
  });
});
```

- [ ] **Step 7: 运行确认失败**

Run: `npx vitest run packages/core/src/config/registry.test.ts`
Expected: FAIL —— 无法解析 `./registry.js`

- [ ] **Step 8: 实现 registry.ts 的骨架 + 全局项与 LLM 项**

```ts
/**
 * The configuration registry: every setting, declared once.
 *
 * Four consumers read this table and nothing else — commander option
 * construction (`cli/src/options.ts`), value resolution (`resolve.ts`),
 * `.env.example` and `docs/configuration.md` (`render-docs.ts`). Adding a
 * setting is therefore a one-line change that shows up on all four surfaces,
 * or fails the build.
 */
import type { Setting } from './types.js';

/** Commands that talk to an LLM endpoint, and so take the whole llm* group. */
const LLM_COMMANDS = ['generate', 'plan', 'resync', 'studio'] as const;

export const SETTINGS: readonly Setting[] = [
  // ── global ────────────────────────────────────────────────────────────────
  {
    key: 'logLevel',
    type: 'enum',
    choices: ['debug', 'info', 'error'],
    default: 'info',
    commands: ['analyze', 'generate', 'render', 'skill', 'validate', 'plan', 'apply', 'rollback', 'resync', 'studio', 'config'],
    doc: 'log verbosity; -v/--verbose and -q/--quiet are shorthand for debug/error',
  },

  // ── llm ───────────────────────────────────────────────────────────────────
  {
    key: 'llmApiKey',
    type: 'string',
    secret: true,
    default: '',
    envAliases: ['OPENAI_API_KEY'],
    commands: [...LLM_COMMANDS],
    example: 'sk-...',
    doc: 'API key for the LLM endpoint; use EMPTY for keyless local endpoints. Never a flag and never allowed in the config file',
  },
  {
    key: 'llmModel',
    type: 'string',
    flag: '--model <id>',
    default: 'gpt-4o-mini',
    envAliases: ['OPENAI_MODEL'],
    commands: [...LLM_COMMANDS],
    doc: 'model identifier',
  },
  {
    key: 'llmBaseUrl',
    type: 'string',
    flag: '--base-url <url>',
    default: 'https://api.openai.com/v1',
    envAliases: ['OPENAI_BASE_URL'],
    commands: [...LLM_COMMANDS],
    doc: 'any OpenAI-compatible endpoint (hosted, vLLM, LiteLLM, a proxy)',
  },
  {
    key: 'llmMaxTokens',
    type: 'int',
    min: 1,
    flag: '--max-tokens <n>',
    default: 16000,
    envAliases: ['OPENAI_MAX_TOKENS'],
    commands: [...LLM_COMMANDS],
    doc: 'max output tokens per request',
  },
  {
    key: 'llmTimeout',
    type: 'int',
    min: 1,
    flag: '--timeout <sec>',
    default: 300,
    envAliases: ['OPENAI_TIMEOUT'],
    commands: [...LLM_COMMANDS],
    doc: 'per-request deadline in seconds; a stalled call is retried rather than allowed to hold a phase hostage',
  },
  {
    key: 'llmMaxRetries',
    type: 'int',
    min: 0,
    flag: '--llm-retries <n>',
    default: 6,
    commands: [...LLM_COMMANDS],
    doc: 'retry attempts per request; 0 means a single attempt',
  },
  {
    key: 'llmRetryBackoff',
    type: 'int',
    min: 0,
    flag: '--llm-retry-backoff <sec>',
    default: 3,
    commands: [...LLM_COMMANDS],
    doc: 'base backoff between retries, in seconds',
  },
  {
    key: 'llmConcurrency',
    type: 'int',
    min: 1,
    flag: '--llm-concurrency <n>',
    default: 16,
    commands: [...LLM_COMMANDS],
    doc: 'global cap on concurrent requests through one client',
  },
  {
    key: 'llmExtraBody',
    type: 'json',
    flag: '--extra-body <json>',
    envAliases: ['OPENAI_EXTRA_BODY'],
    commands: [...LLM_COMMANDS],
    example: '{"thinking":{"type":"disabled"}}',
    doc: 'vendor fields merged into every request body; model/messages/token fields cannot be overridden',
  },
];

export function settingsFor(command: string): readonly Setting[] {
  return SETTINGS.filter((s) => s.commands.includes(command));
}

export function settingByKey(key: string): Setting | undefined {
  return SETTINGS.find((s) => s.key === key);
}
```

- [ ] **Step 9: 从 core 的 barrel 导出，运行测试**

在 `packages/core/src/index.ts` 末尾追加：

```ts
export * from './config/types.js';
export * from './config/names.js';
export * from './config/registry.js';
```

Run: `npx vitest run packages/core/src/config/`
Expected: PASS（names 4 个 + registry 10 个）

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/config packages/core/src/index.ts
git commit -m "feat(core): declare configuration in one table, with self-checking

The registry is the single source the CLI options, the env vars, the config
file and the generated docs will all derive from. Its own test enforces the
declaration rules that would otherwise fail confusingly at runtime: ints need
a min, enums need choices and a default inside them, secrets may never carry a
flag, and no two settings may claim the same env name or the same flag within
one command."
```

---

### Task 3: 值的强制转换与大声失败

**Files:**
- Create: `packages/core/src/config/coerce.ts`
- Create: `packages/core/src/config/coerce.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Setting`（Task 2）
- Produces: `ConfigError`、`coerceValue(setting, raw, where, pathBase?)`

**背景：** 目前两套行为并存 —— CLI 的 `toInt`/`parseEnum` 大声失败，而 `resolveLlmEnv` 对垃圾数值静默兜底（`client.ts:83` 有注释说明）。规格已决定**处处大声失败**，并在错误里点明来源。`toInt`/`parseEnum` 的语义（含 `1e9` 可接受、`3.9` 截断、`-0` 拒绝、非 ASCII 数字拒绝）在此保留，因为 `packages/cli/src/args.test.ts` 已经把这些边界钉住了，Task 6 删除该文件时这些断言要在这里活下来。

- [ ] **Step 1: 写失败测试**

`packages/core/src/config/coerce.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, coerceValue } from './coerce.js';
import type { Setting } from './types.js';

const s = (over: Partial<Setting>): Setting => ({
  key: 'x',
  type: 'string',
  commands: ['generate'],
  doc: 'd',
  ...over,
});

describe('coerceValue: int', () => {
  const n = s({ key: 'readWorkers', type: 'int', min: 1 });

  it('accepts integers, whitespace padding and exponent notation', () => {
    expect(coerceValue(n, '12', 'flag --read-workers')).toBe(12);
    expect(coerceValue(n, '  3  ', 'flag --read-workers')).toBe(3);
    expect(coerceValue(n, '1e9', 'flag --read-workers')).toBe(1_000_000_000);
  });

  it('truncates fractional values toward zero (documented contract)', () => {
    expect(coerceValue(n, '3.9', 'flag --read-workers')).toBe(3);
  });

  it('rejects garbage loudly and names the source', () => {
    // Regression: HANDBOOK_READ_WORKERS=twelve silently running at the default
    // is the hour-wasting failure this replaces.
    expect(() => coerceValue(n, 'twelve', 'env HANDBOOK_READ_WORKERS')).toThrow(
      /env HANDBOOK_READ_WORKERS: readWorkers must be an integer >= 1, got "twelve"/,
    );
    for (const bad of ['NaN', 'Infinity', '1_000', '٣', '', '   ', '-0', '0']) {
      expect(() => coerceValue(n, bad, 'env HANDBOOK_READ_WORKERS')).toThrow(ConfigError);
    }
  });

  it('honours min 0 for the retry count, where 0 is meaningful', () => {
    expect(coerceValue(s({ key: 'llmMaxRetries', type: 'int', min: 0 }), '0', 'x')).toBe(0);
  });
});

describe('coerceValue: bool', () => {
  const b = s({ key: 'resume', type: 'bool' });

  it('accepts the four truthy and four falsey spellings, case-insensitively', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) expect(coerceValue(b, raw, 'x')).toBe(true);
    for (const raw of ['0', 'false', 'No', 'off']) expect(coerceValue(b, raw, 'x')).toBe(false);
  });

  it('passes a real boolean through (commander gives booleans, not strings)', () => {
    expect(coerceValue(b, true, 'flag --resume')).toBe(true);
    expect(coerceValue(b, false, 'flag --no-llm')).toBe(false);
  });

  it('rejects anything else loudly', () => {
    expect(() => coerceValue(b, 'maybe', 'env HANDBOOK_RESUME')).toThrow(
      /env HANDBOOK_RESUME: resume must be one of 1\|true\|yes\|on or 0\|false\|no\|off/,
    );
  });
});

describe('coerceValue: enum', () => {
  const e = s({ key: 'narrateLang', type: 'enum', choices: ['en', 'zh'] });

  it('accepts a listed value', () => {
    expect(coerceValue(e, 'zh', 'x')).toBe('zh');
  });

  it('rejects a near-miss loudly instead of silently narrating in English', () => {
    // Regression: `--narrate-lang cn` (a typo for zh) must not quietly produce
    // English prose.
    expect(() => coerceValue(e, 'cn', 'flag --narrate-lang')).toThrow(
      'flag --narrate-lang: narrateLang must be one of en | zh, got "cn"',
    );
    expect(() => coerceValue(e, '', 'x')).toThrow(ConfigError);
  });
});

describe('coerceValue: json', () => {
  const j = s({ key: 'llmExtraBody', type: 'json' });

  it('parses a JSON object', () => {
    expect(coerceValue(j, '{"thinking":{"type":"disabled"}}', 'x')).toEqual({
      thinking: { type: 'disabled' },
    });
  });

  it('rejects malformed JSON and non-objects loudly', () => {
    // Changed behaviour: parseExtraBody used to swallow both silently, so a
    // trailing comma meant the vendor field was never sent and nothing said so.
    expect(() => coerceValue(j, '{bad}', 'env OPENAI_EXTRA_BODY')).toThrow(
      /env OPENAI_EXTRA_BODY: llmExtraBody must be valid JSON/,
    );
    expect(() => coerceValue(j, '[1,2]', 'x')).toThrow(/must be a JSON object/);
    expect(() => coerceValue(j, 'null', 'x')).toThrow(/must be a JSON object/);
  });
});

describe('coerceValue: path', () => {
  const p = s({ key: 'work', type: 'path' });

  it('resolves a relative path against the supplied base', () => {
    expect(coerceValue(p, './out', 'x', '/repo')).toBe('/repo/out');
  });

  it('leaves an absolute path alone', () => {
    expect(coerceValue(p, '/tmp/w', 'x', '/repo')).toBe('/tmp/w');
  });

  it('rejects an empty path loudly', () => {
    expect(() => coerceValue(p, '   ', 'env HANDBOOK_WORK', '/repo')).toThrow(
      /env HANDBOOK_WORK: work must not be empty/,
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/coerce.test.ts`
Expected: FAIL —— 无法解析 `./coerce.js`

- [ ] **Step 3: 实现 coerce.ts**

```ts
/**
 * Turn a raw value from any layer into the declared type, or fail loudly.
 *
 * Every message names its source (`env HANDBOOK_READ_WORKERS`, `flag
 * --read-workers`, `handbook.config.yaml (generate.readWorkers)`), because the
 * failure this replaces was a typo'd env var silently running at the default.
 */
import { isAbsolute, resolve } from 'node:path';
import { HandbookError } from '../errors.js';
import type { Setting } from './types.js';

export class ConfigError extends HandbookError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
    this.name = 'ConfigError';
  }
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSEY = new Set(['0', 'false', 'no', 'off']);

const fail = (where: string, detail: string): never => {
  throw new ConfigError(`${where}: ${detail}`);
};

/**
 * @param raw   string from env/file, or the value commander produced
 * @param where human-readable source, used verbatim in the error
 * @param pathBase directory a relative `path` value resolves against — cwd for
 *   flags and env, the config file's own directory for file values, so a
 *   committed config file stays portable
 */
export function coerceValue(
  setting: Setting,
  raw: unknown,
  where: string,
  pathBase: string = process.cwd(),
): unknown {
  const { key, type } = setting;

  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (TRUTHY.has(text)) return true;
    if (FALSEY.has(text)) return false;
    return fail(where, `${key} must be one of 1|true|yes|on or 0|false|no|off, got "${String(raw)}"`);
  }

  const text = typeof raw === 'string' ? raw : String(raw);

  switch (type) {
    case 'int': {
      const min = setting.min ?? 0;
      const parsed = Number(text);
      // Number('') is 0 and Number('  ') is 0, which would sail past a `>= 0`
      // check — the trim test below is what rejects them.
      if (text.trim() === '' || !Number.isFinite(parsed) || parsed < min || Object.is(parsed, -0)) {
        return fail(where, `${key} must be an integer >= ${min}, got "${text}"`);
      }
      return Math.trunc(parsed);
    }
    case 'enum': {
      const choices = setting.choices ?? [];
      if (!choices.includes(text)) {
        return fail(where, `${key} must be one of ${choices.join(' | ')}, got "${text}"`);
      }
      return text;
    }
    case 'json': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        return fail(
          where,
          `${key} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return fail(where, `${key} must be a JSON object, got ${text}`);
      }
      return parsed;
    }
    case 'path': {
      const trimmed = text.trim();
      if (trimmed === '') return fail(where, `${key} must not be empty`);
      return isAbsolute(trimmed) ? trimmed : resolve(pathBase, trimmed);
    }
    default: {
      if (text.trim() === '' && setting.default !== '') {
        // An explicitly blank string is "unset" everywhere else in this
        // toolchain (applyEnvFile skips empties); treating it as a value here
        // would render, for instance, a handbook titled with nothing.
        return fail(where, `${key} must not be empty`);
      }
      return text;
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/core/src/config/coerce.test.ts`
Expected: PASS（14 个测试）

- [ ] **Step 5: 导出并提交**

在 `packages/core/src/index.ts` 追加 `export * from './config/coerce.js';`

```bash
git add packages/core/src/config packages/core/src/index.ts
git commit -m "feat(core): coerce every config value through one validator that names its source

Two behaviours coexisted: the CLI's toInt/parseEnum failed loudly while
resolveLlmEnv silently fell back on garbage numerics. Loud everywhere now,
with the source in the message, so HANDBOOK_READ_WORKERS=twelve stops being
an hour spent wondering why the tuning did nothing. The boundary cases
args.test.ts pinned (1e9 accepted, 3.9 truncated, -0 and non-ASCII digits
rejected) are preserved here."
```

---

### Task 4: env 层求值与优先级

**Files:**
- Create: `packages/core/src/config/resolve.ts`
- Create: `packages/core/src/config/resolve.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `Setting`、`Source`、`ResolveResult`、`coerceValue`、`envName`、`scopedEnvName`、`fileKeyCandidates`
- Produces: `resolveConfig(input: ResolveInput): ResolveResult`、`ResolveInput`、`envCandidates(command, setting)`

- [ ] **Step 1: 写失败测试**

`packages/core/src/config/resolve.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { envCandidates, resolveConfig } from './resolve.js';
import { settingByKey } from './registry.js';

const need = (key: string) => {
  const s = settingByKey(key);
  if (!s) throw new Error(`registry is missing ${key}`);
  return s;
};

describe('envCandidates', () => {
  it('puts the command-scoped name ahead of the flat one, aliases last', () => {
    expect(envCandidates('generate', need('llmModel'))).toEqual([
      'HANDBOOK_GENERATE_LLM_MODEL',
      'HANDBOOK_LLM_MODEL',
      'OPENAI_MODEL',
    ]);
  });
});

describe('resolveConfig precedence', () => {
  const base = { command: 'generate', flags: {}, env: {}, cwd: '/repo' };

  it('falls back to the declared default and says so', () => {
    const r = resolveConfig(base);
    expect(r.values.llmModel).toBe('gpt-4o-mini');
    expect(r.sources.llmModel).toEqual({ kind: 'default' });
    expect(r.errors).toEqual([]);
  });

  it('lets a flat env var beat the default', () => {
    const r = resolveConfig({ ...base, env: { HANDBOOK_LLM_MODEL: 'from-env' } });
    expect(r.values.llmModel).toBe('from-env');
    expect(r.sources.llmModel).toEqual({ kind: 'env', name: 'HANDBOOK_LLM_MODEL' });
  });

  it('lets a scoped env var beat a flat one', () => {
    const r = resolveConfig({
      ...base,
      env: { HANDBOOK_LLM_MODEL: 'flat', HANDBOOK_GENERATE_LLM_MODEL: 'scoped' },
    });
    expect(r.values.llmModel).toBe('scoped');
  });

  it('accepts a vendor alias, but ranks it below the handbook names', () => {
    expect(resolveConfig({ ...base, env: { OPENAI_MODEL: 'vendor' } }).values.llmModel).toBe('vendor');
    const both = resolveConfig({
      ...base,
      env: { OPENAI_MODEL: 'vendor', HANDBOOK_LLM_MODEL: 'ours' },
    });
    expect(both.values.llmModel).toBe('ours');
  });

  it('lets a flag beat every env var', () => {
    const r = resolveConfig({
      ...base,
      flags: { llmModel: 'from-flag' },
      env: { HANDBOOK_GENERATE_LLM_MODEL: 'scoped', OPENAI_MODEL: 'vendor' },
    });
    expect(r.values.llmModel).toBe('from-flag');
    expect(r.sources.llmModel).toEqual({ kind: 'flag', name: '--model' });
  });

  it('lets shell env beat the config file, and the file beat the default', () => {
    const file = { path: '/repo/handbook.config.yaml', flat: { llmModel: 'from-file' } };
    expect(resolveConfig({ ...base, file }).values.llmModel).toBe('from-file');
    expect(resolveConfig({ ...base, file }).sources.llmModel).toEqual({
      kind: 'file',
      path: '/repo/handbook.config.yaml',
      keyPath: 'llmModel',
    });
    expect(resolveConfig({ ...base, file, env: { HANDBOOK_LLM_MODEL: 'env' } }).values.llmModel).toBe(
      'env',
    );
  });

  it('treats an empty env value as unset, not as a value', () => {
    // applyEnvFile already skips empties; the layers must agree.
    const r = resolveConfig({ ...base, env: { HANDBOOK_LLM_MODEL: '' } });
    expect(r.values.llmModel).toBe('gpt-4o-mini');
    expect(r.sources.llmModel).toEqual({ kind: 'default' });
  });
});

describe('resolveConfig behaviour', () => {
  const base = { command: 'generate', flags: {}, env: {}, cwd: '/repo' };

  it('omits a pass-through setting entirely when no layer supplies it', () => {
    // `default: undefined` means the pipeline's own default must still apply,
    // so the key must be ABSENT rather than present-and-undefined.
    const r = resolveConfig(base);
    expect('llmExtraBody' in r.values).toBe(false);
  });

  it('collects every error instead of throwing on the first', () => {
    const r = resolveConfig({
      ...base,
      env: { HANDBOOK_LLM_MAX_TOKENS: 'lots', HANDBOOK_GENERATE_DETAIL: 'shallow' },
    });
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join('\n')).toMatch(/HANDBOOK_LLM_MAX_TOKENS/);
    expect(r.errors.join('\n')).toMatch(/HANDBOOK_GENERATE_DETAIL/);
  });

  it('reports a required setting that no layer supplied, naming the routes', () => {
    const r = resolveConfig({ command: 'analyze', flags: {}, env: {}, cwd: '/repo' });
    expect(r.errors.join('\n')).toMatch(
      /source is required: pass --source, set HANDBOOK_(ANALYZE_)?SOURCE, or add it to handbook\.config\.yaml/,
    );
  });

  it('ignores settings that belong to other commands', () => {
    const r = resolveConfig({ ...base, env: { HANDBOOK_RENDER_OUT: '/x' } });
    expect('out' in r.values).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/resolve.test.ts`
Expected: FAIL —— 无法解析 `./resolve.js`

- [ ] **Step 3: 实现 resolve.ts**

```ts
/**
 * Layered resolution with provenance.
 *
 *   CLI flag  >  shell env  >  .env file  >  handbook.config.yaml  >  default
 *
 * `.env` needs no layer of its own: `applyEnvFile` has already merged it into
 * `process.env` without overriding what the shell set, so the env layer covers
 * both — which is also why an empty value must read as "unset" here.
 *
 * Errors are collected rather than thrown so `handbook config --check` can
 * report every problem in one pass.
 */
import { coerceValue } from './coerce.js';
import { ConfigError } from './coerce.js';
import { envName, fileKeyCandidates, scopedEnvName } from './names.js';
import { settingsFor } from './registry.js';
import type { ResolveResult, Setting, Source } from './types.js';

export interface ConfigFileData {
  readonly path: string;
  /** Already flattened by camelCase join — see `file.ts`. */
  readonly flat: Record<string, unknown>;
}

export interface ResolveInput {
  readonly command: string;
  /** commander's opts object: camelCase keys, absent when the flag was not passed. */
  readonly flags: Record<string, unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly file?: ConfigFileData;
  /** Base for relative `path` values from flags and env. */
  readonly cwd?: string;
}

/** Env names to try, most specific first. */
export function envCandidates(command: string, setting: Setting): string[] {
  return [
    scopedEnvName(command, setting.key),
    ...(setting.scopedOnly ? [] : [envName(setting.key)]),
    ...(setting.envAliases ?? []),
  ];
}

/** `--read-workers <n>` → `--read-workers`, for error messages and provenance. */
function flagName(setting: Setting): string {
  return setting.flag?.split(/[ ,]/)[0] ?? `(${setting.key})`;
}

function supplyRoutes(command: string, setting: Setting): string {
  const routes: string[] = [];
  if (setting.flag) routes.push(`pass ${flagName(setting)}`);
  routes.push(`set ${envCandidates(command, setting)[0] as string}`);
  if (!setting.secret) routes.push('add it to handbook.config.yaml');
  return routes.join(', or ');
}

export function resolveConfig(input: ResolveInput): ResolveResult {
  const { command, flags, env = {}, file, cwd = process.cwd() } = input;
  const values: Record<string, unknown> = {};
  const sources: Record<string, Source> = {};
  const errors: string[] = [];

  for (const setting of settingsFor(command)) {
    const attempt = (raw: unknown, where: string, source: Source, pathBase: string): boolean => {
      try {
        values[setting.key] = coerceValue(setting, raw, where, pathBase);
        sources[setting.key] = source;
        return true;
      } catch (error) {
        errors.push(error instanceof ConfigError ? error.message : String(error));
        return true; // a supplied-but-invalid value must not fall through to a default
      }
    };

    // 1. flag
    const fromFlag = flags[setting.key];
    if (fromFlag !== undefined) {
      attempt(fromFlag, `flag ${flagName(setting)}`, { kind: 'flag', name: flagName(setting) }, cwd);
      continue;
    }

    // 2. shell env (already includes .env)
    const hit = envCandidates(command, setting).find((name) => {
      const value = env[name];
      return value !== undefined && value !== '';
    });
    if (hit) {
      attempt(env[hit], `env ${hit}`, { kind: 'env', name: hit }, cwd);
      continue;
    }

    // 3. config file — relative paths resolve against the file, not the cwd
    if (file) {
      const keyPath = fileKeyCandidates(command, setting).find((k) => file.flat[k] !== undefined);
      if (keyPath !== undefined) {
        const base = file.path.replace(/[/\\][^/\\]*$/, '') || cwd;
        attempt(
          file.flat[keyPath],
          `${file.path} (${keyPath})`,
          { kind: 'file', path: file.path, keyPath },
          base,
        );
        continue;
      }
    }

    // 4. default. `undefined` means pass-through: leave the key out so a
    // downstream default still applies.
    if (setting.default !== undefined) {
      values[setting.key] = setting.default;
      sources[setting.key] = { kind: 'default' };
    } else if (setting.required) {
      errors.push(`${setting.key} is required: ${supplyRoutes(command, setting)}`);
    }
  }

  return { values, sources, errors };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/core/src/config/resolve.test.ts`
Expected: PASS。`required` 那条测试要等 Task 5 把 `source` 登记进表后才有意义——若此刻因 `analyze` 尚无任何设置而失败，**先跳过该条**（`it.skip`），并在 Task 5 Step 4 取消跳过。

- [ ] **Step 5: 导出并提交**

在 `packages/core/src/index.ts` 追加 `export * from './config/resolve.js';`

```bash
git add packages/core/src/config packages/core/src/index.ts
git commit -m "feat(core): resolve config in layers, and remember where each value came from

flag > shell env > .env > handbook.config.yaml > default, with the source
recorded per key so handbook config can show it. .env needs no layer of its
own because applyEnvFile has already merged it into process.env without
overriding the shell — which is why an empty env value reads as unset here.
Errors accumulate instead of throwing so --check reports all of them."
```

---

### Task 5: 补全登记表，并把流水线默认值收敛成唯一来源

**Files:**
- Create: `packages/core/src/config/defaults.ts`
- Modify: `packages/core/src/config/registry.ts`（补齐其余约 50 项）
- Modify: `packages/core/src/config/registry.test.ts`（补 3 条断言）
- Modify: `packages/pipeline/src/{cards,assign,organize,narrate,doctor,generate}.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `Setting`
- Produces: `PIPELINE_DEFAULTS`；登记表补全后 `settingsFor('generate')` 等返回完整集合

**背景（已核对代码）：** 六个调优字段的默认值现在住在下游的解构里 —— `cards.ts:309-311` `batchSize = 8, maxWorkers = 12, maxCharsPerFile = 0`、`assign.ts:151,187` `batchSize = 25, maxWorkers = 12`、`organize.ts:229` `workers = 8`、`narrate.ts:120` `workers = 8`、`doctor.ts:347` `maxRounds = 6`。若登记表再抄一遍数字就有两个事实来源。把它们提到 core 的 `PIPELINE_DEFAULTS`，两边都引用它。**`narrate.ts:299` 的 `maxRounds = 5` 是另一回事（narrate 自己的收敛轮数），不要动。**

`readBatchSize` 是唯一例外：`generate.ts:203` 的有效默认随 `--detail` 变（`deep ? 1 : 8`），所以它在登记表里是 pass-through（`default: undefined`），doc 里说明这件事。

- [ ] **Step 1: 写 PIPELINE_DEFAULTS 与它的失败测试**

`packages/core/src/config/defaults.ts`：

```ts
/**
 * Pipeline tuning defaults, in one place.
 *
 * These numbers used to live only in the downstream destructuring
 * (`const { batchSize = 25 } = options`), which meant the registry documenting
 * them would have been a second source of truth for the same value — and the
 * generated docs would drift from behaviour the moment either moved. Both the
 * registry and the pipeline now read these.
 */
export const PIPELINE_DEFAULTS = {
  /** Files per card batch. `generate` overrides to 1 when --detail deep. */
  readBatchSize: 8,
  readWorkers: 12,
  /** 0 = no truncation. */
  maxCharsPerFile: 0,
  assignBatchSize: 25,
  assignWorkers: 12,
  organizeWorkers: 8,
  narrateWorkers: 8,
  maxDoctorRounds: 6,
} as const;
```

追加到 `packages/core/src/config/registry.test.ts`：

```ts
import { PIPELINE_DEFAULTS } from './defaults.js';

describe('registry agrees with the pipeline defaults', () => {
  // If these drifted, the generated docs would promise a number the pipeline
  // does not use.
  it('declares the tuning defaults by reference, not by copy', () => {
    expect(settingByKey('readWorkers')?.default).toBe(PIPELINE_DEFAULTS.readWorkers);
    expect(settingByKey('assignBatchSize')?.default).toBe(PIPELINE_DEFAULTS.assignBatchSize);
    expect(settingByKey('assignWorkers')?.default).toBe(PIPELINE_DEFAULTS.assignWorkers);
    expect(settingByKey('organizeWorkers')?.default).toBe(PIPELINE_DEFAULTS.organizeWorkers);
    expect(settingByKey('narrateWorkers')?.default).toBe(PIPELINE_DEFAULTS.narrateWorkers);
    expect(settingByKey('maxDoctorRounds')?.default).toBe(PIPELINE_DEFAULTS.maxDoctorRounds);
    expect(settingByKey('maxCharsPerFile')?.default).toBe(PIPELINE_DEFAULTS.maxCharsPerFile);
  });

  it('leaves readBatchSize a pass-through, because its default depends on --detail', () => {
    expect(settingByKey('readBatchSize')?.default).toBeUndefined();
  });
});

describe('every command the CLI ships is represented', () => {
  it('covers all eleven subcommands plus config', () => {
    const commands = new Set(SETTINGS.flatMap((s) => s.commands));
    for (const c of ['analyze', 'generate', 'render', 'skill', 'validate', 'plan', 'apply', 'rollback', 'resync', 'studio', 'config']) {
      expect([...commands], `missing ${c}`).toContain(c);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/registry.test.ts`
Expected: FAIL —— `settingByKey('readWorkers')` 返回 undefined

- [ ] **Step 3: 补全登记表**

在 `registry.ts` 的 `SETTINGS` 数组里，LLM 组之后追加以下各组。`import { PIPELINE_DEFAULTS } from './defaults.js';` 加到文件顶部。

```ts
  // ── shared paths ──────────────────────────────────────────────────────────
  {
    key: 'source',
    type: 'path',
    flag: '--source <dir>',
    required: true,
    commands: ['analyze', 'generate', 'plan', 'apply'],
    example: './src',
    doc: 'source root to analyze (read-only for plan)',
  },
  {
    key: 'work',
    type: 'path',
    flag: '--work <dir>',
    required: true,
    commands: ['analyze', 'generate', 'render', 'resync'],
    example: './.handbook',
    doc: 'work directory holding pipeline artifacts',
  },
  {
    key: 'lang',
    type: 'enum',
    // `auto|<every registered language>` cannot be hard-coded here: the choices
    // come from the adapter registry at option-build time (see cli/options.ts),
    // which is why this entry declares `dynamicChoices` instead of `choices`.
    choices: ['auto'],
    dynamicChoices: 'languages',
    default: 'auto',
    flag: '--lang <lang>',
    commands: ['analyze', 'generate'],
    doc: 'source language; auto detects and merges every registered language',
  },
  {
    key: 'title',
    type: 'string',
    flag: '--title <title>',
    default: 'System Handbook',
    commands: ['render', 'resync'],
    doc: 'handbook title for rendered outputs',
  },

  // ── generate ──────────────────────────────────────────────────────────────
  { key: 'phase', type: 'string', flag: '--phase <spec>', default: 'all', commands: ['generate'],
    doc: 'all | 1 | 2 | 2a | 2b | 2c | 3, or a comma list' },
  { key: 'strategy', type: 'enum', choices: ['file', 'member'], flag: '--strategy <s>', commands: ['generate'],
    doc: 'file (default) or member; unset keeps the work dir\'s recorded strategy' },
  { key: 'skeleton', type: 'path', flag: '--skeleton <path>', commands: ['generate'],
    doc: 'user-authored skeleton.yaml, required for the member strategy' },
  { key: 'narrateLang', type: 'enum', choices: ['en', 'zh'], default: 'en', flag: '--narrate-lang <l>',
    commands: ['generate', 'resync'], doc: 'prose language' },
  { key: 'detail', type: 'enum', choices: ['brief', 'deep'], default: 'brief', flag: '--detail <d>',
    commands: ['generate'], doc: 'card depth' },
  { key: 'synthMode', type: 'enum', choices: ['oneshot', 'doctor'], default: 'oneshot', flag: '--synth-mode <m>',
    commands: ['generate'], doc: 'skeleton synthesis mode' },
  { key: 'maxDoctorRounds', type: 'int', min: 1, default: PIPELINE_DEFAULTS.maxDoctorRounds,
    flag: '--max-doctor-rounds <n>', commands: ['generate'], doc: 'doctor convergence rounds' },
  { key: 'readWorkers', type: 'int', min: 1, default: PIPELINE_DEFAULTS.readWorkers,
    flag: '--read-workers <n>', commands: ['generate'], doc: 'concurrent card batches' },
  { key: 'readBatchSize', type: 'int', min: 1, flag: '--read-batch-size <n>', commands: ['generate'],
    doc: 'files per card batch; unset means 1 for --detail deep and 8 for brief' },
  { key: 'maxCharsPerFile', type: 'int', min: 0, default: PIPELINE_DEFAULTS.maxCharsPerFile,
    flag: '--max-chars-per-file <n>', commands: ['generate'], doc: 'truncate each file at n chars; 0 means no limit' },
  { key: 'assignBatchSize', type: 'int', min: 1, default: PIPELINE_DEFAULTS.assignBatchSize,
    flag: '--assign-batch-size <n>', commands: ['generate'], doc: 'cards per assignment batch' },
  { key: 'assignWorkers', type: 'int', min: 1, default: PIPELINE_DEFAULTS.assignWorkers,
    flag: '--assign-workers <n>', commands: ['generate'], doc: 'concurrent assignment batches' },
  { key: 'organizeWorkers', type: 'int', min: 1, default: PIPELINE_DEFAULTS.organizeWorkers,
    flag: '--organize-workers <n>', commands: ['generate'], doc: 'concurrent stage-organize calls' },
  { key: 'narrateWorkers', type: 'int', min: 1, default: PIPELINE_DEFAULTS.narrateWorkers,
    flag: '--narrate-workers <n>', commands: ['generate'], doc: 'concurrent narration calls' },
  { key: 'resume', type: 'bool', flag: '--resume', default: false, commands: ['generate'],
    doc: 'skip files that already have a completed card' },
  { key: 'refresh', type: 'bool', flag: '--refresh', default: false, commands: ['generate'],
    doc: 'ignore phase-3 caches' },
  { key: 'llmCache', type: 'bool', flag: '--llm-cache', default: false, commands: ['generate'],
    doc: 'cache raw LLM replies under <work>/phase3/cache; disabled by --refresh' },

  // ── render ────────────────────────────────────────────────────────────────
  { key: 'out', type: 'path', flag: '--out <dir>', scopedOnly: true, commands: ['render', 'skill', 'plan'],
    doc: 'output location; render defaults to <work>/handbook, plan writes a file, skill writes a directory' },
  { key: 'html', type: 'bool', flag: '--html', default: false, commands: ['render'],
    doc: 'also render the multi-page HTML site under <out>/html' },
  { key: 'htmlSingle', type: 'bool', flag: '--html-single', default: false, commands: ['render'],
    doc: 'also render a single self-contained HTML page' },
  { key: 'agentSite', type: 'bool', flag: '--agent-site', default: false, commands: ['render'],
    doc: 'also render the agent locator index under <out>/agent' },
  { key: 'llmsTxt', type: 'bool', flag: '--llms-txt', default: false, commands: ['render'],
    doc: 'also write llms.txt and llms-full.txt next to the markdown' },
  { key: 'sourceBaseUrl', type: 'string', flag: '--source-base-url <url>', commands: ['render'],
    doc: 'link file cards to the source at <url>/<relative path>' },

  // ── skill ─────────────────────────────────────────────────────────────────
  { key: 'handbook', type: 'path', flag: '--handbook <dir>', scopedOnly: true, commands: ['skill', 'plan'],
    doc: 'rendered handbook directory; required for skill, optional context for plan' },
  { key: 'name', type: 'string', flag: '--name <slug>', required: true, commands: ['skill'],
    doc: 'skill slug (lowercase-hyphen)' },
  { key: 'project', type: 'string', flag: '--project <name>', commands: ['skill'],
    doc: 'human project name for prose' },
  { key: 'agentDir', type: 'path', flag: '--agent-dir <dir>', commands: ['skill'],
    doc: 'rendered agent locator site; ships under references/agent/' },
  { key: 'skillLang', type: 'enum', choices: ['en', 'zh'], default: 'en', flag: '--lang <l>',
    scopedOnly: true, commands: ['skill'],
    doc: 'SKILL.md body language; frontmatter stays English for routing' },

  // ── validate ──────────────────────────────────────────────────────────────
  { key: 'skill', type: 'path', flag: '--skill <dir>', required: true, commands: ['validate'],
    doc: 'skill directory to validate' },

  // ── plan ──────────────────────────────────────────────────────────────────
  { key: 'request', type: 'string', flag: '--request <text>', required: true, commands: ['plan'],
    doc: 'the natural-language change request' },
  { key: 'maxTurns', type: 'int', min: 1, default: 30, flag: '--max-turns <n>', commands: ['plan'],
    doc: 'agent turn budget' },

  // ── apply / rollback ──────────────────────────────────────────────────────
  { key: 'plan', type: 'path', flag: '--plan <file>', required: true, commands: ['apply'],
    doc: 'plan file produced by `handbook plan`' },
  { key: 'dryRun', type: 'bool', flag: '--dry-run', default: false, commands: ['apply'],
    doc: 'verify only, never write' },
  { key: 'backupRoot', type: 'path', flag: '--backup-root <dir>', commands: ['apply'],
    doc: 'where backups go; defaults to <source>/.handbook-patches' },
  { key: 'backup', type: 'path', flag: '--backup <dir>', required: true, commands: ['rollback'],
    doc: 'backup directory containing manifest.json' },
  { key: 'force', type: 'bool', flag: '--force', default: false, commands: ['rollback'],
    doc: 'restore even files that changed after the patch' },
  { key: 'rollbackSource', type: 'path', flag: '--source <dir>', scopedOnly: true, commands: ['rollback', 'validate', 'skill'],
    doc: 'the tree a backup belongs to (rollback), or the source root for hash freshness (validate/skill)' },

  // ── resync ────────────────────────────────────────────────────────────────
  { key: 'case', type: 'path', flag: '--case <dir>', required: true, commands: ['resync'],
    doc: 'case directory: edited/ + plan.md + change.diff' },
  { key: 'useLlm', type: 'bool', flag: '--no-llm', negated: true, default: true, commands: ['resync'],
    doc: 'set false for a structural refresh only, with prose marked stale' },
  { key: 'refreshRendered', type: 'bool', flag: '--no-render', negated: true, default: true, commands: ['resync'],
    doc: 'set false to skip refreshing already-rendered outputs under <work>/handbook' },
  { key: 'corrections', type: 'path', flag: '--corrections <file>', commands: ['resync'],
    doc: 'agent-reported corrections.jsonl; its files widen the refresh set' },
  { key: 'resyncDetail', type: 'enum', choices: ['brief', 'deep'], flag: '--detail <d>', scopedOnly: true,
    commands: ['resync'], doc: 'card depth for regenerated cards; unset matches the existing handbook' },

  // ── studio ────────────────────────────────────────────────────────────────
  { key: 'port', type: 'int', min: 1, default: 4860, flag: '--port <n>', commands: ['studio'],
    doc: 'port to listen on; binds 127.0.0.1 only' },
  { key: 'stateDir', type: 'path', flag: '--state-dir <dir>', commands: ['studio'],
    doc: 'where studio.json and managed work dirs live; defaults to $HOME/.handbook-studio' },

  // ── config ────────────────────────────────────────────────────────────────
  { key: 'forCommand', type: 'string', flag: '--command <name>', commands: ['config'],
    doc: 'show only the settings that apply to this subcommand' },
  { key: 'json', type: 'bool', flag: '--json', default: false, commands: ['config'],
    doc: 'machine-readable output' },
  { key: 'check', type: 'bool', flag: '--check', default: false, commands: ['config'],
    doc: 'validate only; exit non-zero if anything is invalid or missing' },
```

`lang` 用到了一个新字段 `dynamicChoices`，需要在 `types.ts` 的 `Setting` 里加上：

```ts
  /**
   * Choices that cannot be written down here because they come from a registry
   * at runtime — `languages` means "auto plus every registered adapter". The
   * `--lang` help text had already drifted five languages behind by being
   * hand-written once.
   */
  readonly dynamicChoices?: 'languages';
```

并在 `registry.test.ts` 的 "gives every int a min and every enum its choices" 断言里放行 `dynamicChoices` 的项（它的 `choices` 只是兜底的 `['auto']`）。

- [ ] **Step 4: 取消 Task 4 Step 4 里被跳过的 required 测试，运行 core 全部配置测试**

Run: `npx vitest run packages/core/src/config/`
Expected: PASS。`resolveConfig({command:'analyze'})` 现在应当报 `source is required: pass --source, set HANDBOOK_ANALYZE_SOURCE, or add it to handbook.config.yaml`。

- [ ] **Step 5: 把流水线的默认值改成引用同一常量**

逐处替换（`import { PIPELINE_DEFAULTS } from '@handbook/core';` 加到各文件已有的 core import 里）：

- `packages/pipeline/src/cards.ts:309-311` → `batchSize = PIPELINE_DEFAULTS.readBatchSize,` / `maxWorkers = PIPELINE_DEFAULTS.readWorkers,` / `maxCharsPerFile = PIPELINE_DEFAULTS.maxCharsPerFile,`
- `packages/pipeline/src/assign.ts:151` 与 `:187` → `const { batchSize = PIPELINE_DEFAULTS.assignBatchSize, maxWorkers = PIPELINE_DEFAULTS.assignWorkers, cards = {}, signal } = options;`
- `packages/pipeline/src/organize.ts:229` → `const { workers = PIPELINE_DEFAULTS.organizeWorkers, lang = 'en', signal } = options;`
- `packages/pipeline/src/narrate.ts:120` → `const { workers = PIPELINE_DEFAULTS.narrateWorkers, refresh = false, lang = 'en', signal } = options;`（**第 299 行的 `maxRounds = 5` 不动**）
- `packages/pipeline/src/doctor.ts:347` → `const { maxRounds = PIPELINE_DEFAULTS.maxDoctorRounds, lang = 'en', signal } = options;`
- `packages/pipeline/src/generate.ts:203` → `batchSize: options.readBatchSize ?? (options.detail === 'deep' ? 1 : PIPELINE_DEFAULTS.readBatchSize),`

- [ ] **Step 6: 运行全量测试，确认没有一个数字被改动**

Run: `pnpm run build && npx vitest run packages/pipeline packages/core`
Expected: PASS，且 **零** 快照/断言变化 —— 常量的值与原字面量逐一相等，这一步只是消除第二个事实来源。若有测试变红，是抄错了数字，回到 Step 5 对照本 Task 的"背景"逐行核对。

- [ ] **Step 7: 提交**

```bash
git add packages/core/src/config packages/core/src/index.ts packages/pipeline/src
git commit -m "feat(core): complete the registry, and give the pipeline defaults one home

Six real GenerateOptions fields (readBatchSize, maxCharsPerFile,
assignBatchSize, assignWorkers, organizeWorkers, narrateWorkers) were
reachable from neither a flag nor an env var. Declaring them meant deciding
where their defaults live: copying 25 and 8 and 12 into the registry would
have made the generated docs a second source of truth that drifts. Both the
registry and the destructuring now read PIPELINE_DEFAULTS. readBatchSize
stays a pass-through because its effective default depends on --detail."
```

---

### Task 6: CLI 选项改为派生，且在 action 时求值

**Files:**
- Create: `packages/cli/src/options.ts`
- Create: `packages/cli/src/options.test.ts`
- Create: `packages/cli/src/resolve-config.ts`
- Create: `packages/cli/src/resolve-config.test.ts`
- Modify: `packages/cli/src/main.ts`
- Delete: `packages/cli/src/args.ts`、`packages/cli/src/args.test.ts`

**Interfaces:**
- Consumes: `settingsFor`、`resolveConfig`、`ResolveResult`（Task 2/4/5）
- Produces: `addSettings(cmd: Command, command: string): Command`、`resolveOrThrow(command: string, flags: Record<string, unknown>): Record<string, unknown>`

**两条不可违反的约束：**
1. **不要给 commander 设默认值。** `render-refresh.ts:19` 写清了原因：模块加载时读取会在 `preAction` 应用 env 文件之前抓到 shell 的值，于是 env 文件里的设置被静默忽略。默认值只能来自 action 时的解析器。
2. **不要再用 `requiredOption`。** env 与配置文件现在也能提供 `--source`/`--work`，必填改由解析器在求值后判定（`resolveConfig` 已实现，错误里点明三条供给途径）。

- [ ] **Step 1: 写失败测试**

`packages/cli/src/options.test.ts`：

```ts
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { settingsFor } from '@handbook/core';
import { addSettings } from './options.js';

describe('addSettings', () => {
  it('adds one commander option per flag-bearing setting', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    const flags = cmd.options.map((o) => o.long);
    expect(flags).toContain('--read-workers');
    expect(flags).toContain('--model');       // did not exist before
    expect(flags).toContain('--assign-workers'); // reachable from nothing before
  });

  it('never adds a flag for a secret', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    expect(cmd.options.map((o) => o.long)).not.toContain('--api-key');
  });

  it('sets no commander default, so the resolver owns every default', () => {
    // Regression (render-refresh.ts:19): an eager default captures the shell
    // value at module load, before --env-file is applied, silently ignoring it.
    const cmd = addSettings(new Command('generate'), 'generate');
    for (const option of cmd.options) {
      expect(option.defaultValue, `${option.long} carries a commander default`).toBeUndefined();
    }
  });

  it('marks nothing required, because env and the config file can supply it', () => {
    const cmd = addSettings(new Command('analyze'), 'analyze');
    expect(cmd.options.filter((o) => o.required && o.mandatory).map((o) => o.long)).toEqual([]);
  });

  it('puts the setting doc into the help text', () => {
    const cmd = addSettings(new Command('generate'), 'generate');
    const workers = cmd.options.find((o) => o.long === '--read-workers');
    expect(workers?.description).toContain('concurrent card batches');
    expect(workers?.description).toContain('HANDBOOK_READ_WORKERS');
  });

  it('resolves --lang choices from the adapter registry, not a hand-written list', () => {
    // The hand-written help string had drifted five languages behind.
    const cmd = addSettings(new Command('analyze'), 'analyze');
    const lang = cmd.options.find((o) => o.long === '--lang');
    expect(lang?.description).toContain('auto');
    expect(lang?.description).toContain('python');
    expect(lang?.description).toContain('solidity');
  });

  it('covers every flag the registry declares for the command', () => {
    const cmd = addSettings(new Command('resync'), 'resync');
    const declared = settingsFor('resync')
      .filter((s) => s.flag)
      .map((s) => s.flag?.split(/[ ,]/)[0]);
    for (const flag of declared) expect(cmd.options.map((o) => o.long)).toContain(flag);
  });
});
```

`packages/cli/src/resolve-config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { resolveOrThrow } from './resolve-config.js';

describe('resolveOrThrow', () => {
  it('reads the environment at call time, not at module load', () => {
    // This is the whole point: --env-file is applied in a preAction hook, so a
    // value captured earlier than this call would silently lose to the shell.
    process.env.HANDBOOK_GENERATE_LLM_MODEL = 'set-after-import';
    try {
      expect(resolveOrThrow('generate', { source: '/s', work: '/w' }).llmModel).toBe(
        'set-after-import',
      );
    } finally {
      delete process.env.HANDBOOK_GENERATE_LLM_MODEL;
    }
  });

  it('throws one error listing every problem', () => {
    process.env.HANDBOOK_GENERATE_READ_WORKERS = 'twelve';
    try {
      expect(() => resolveOrThrow('generate', {})).toThrow(/READ_WORKERS[\s\S]*required/);
    } finally {
      delete process.env.HANDBOOK_GENERATE_READ_WORKERS;
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm run build && npx vitest run packages/cli/src/options.test.ts packages/cli/src/resolve-config.test.ts`
Expected: FAIL —— 两个模块都不存在

- [ ] **Step 3: 实现 options.ts 与 resolve-config.ts**

`packages/cli/src/options.ts`：

```ts
/**
 * Build commander options from the registry.
 *
 * Two things this deliberately does NOT do. It sets no commander default: an
 * eagerly-evaluated default captures the shell value at module load, before the
 * preAction hook applies --env-file, which silently ignores the file (the
 * lesson recorded at render-refresh.ts:19). And it marks nothing mandatory,
 * because --source and --work can now come from env or the config file; the
 * resolver enforces required-ness after all layers have been consulted.
 */
import type { Command } from 'commander';
import { availableLanguages, registerBuiltinAdapters } from '@handbook/analyzer';
import { envName, scopedEnvName, settingsFor, type Setting } from '@handbook/core';

function helpText(command: string, setting: Setting): string {
  const parts = [setting.doc];
  if (setting.type === 'enum') {
    const choices =
      setting.dynamicChoices === 'languages' ? languageChoices() : (setting.choices ?? []).join('|');
    parts.push(`(${choices})`);
  }
  parts.push(
    `[env: ${setting.scopedOnly ? scopedEnvName(command, setting.key) : envName(setting.key)}]`,
  );
  if (setting.default !== undefined) parts.push(`(default: ${String(setting.default)})`);
  return parts.join(' ');
}

/** `auto|<every registered language>` — derived, because the hand-written list drifted. */
function languageChoices(): string {
  registerBuiltinAdapters();
  return ['auto', ...availableLanguages()].join('|');
}

export function addSettings(cmd: Command, command: string): Command {
  for (const setting of settingsFor(command)) {
    if (!setting.flag) continue;
    cmd.option(setting.flag, helpText(command, setting));
  }
  return cmd;
}
```

`packages/cli/src/resolve-config.ts`：

```ts
/**
 * Resolve one subcommand's configuration at action time.
 *
 * Called from inside each action handler — never at module load — so that the
 * env file loaded by the preAction hook is already in `process.env` and the
 * config file discovered alongside it is in scope.
 */
import { resolveConfig, type ConfigFileData } from '@handbook/core';

let configFile: ConfigFileData | undefined;

/** Set once by the preAction hook, before any action runs. */
export function setConfigFile(file: ConfigFileData | undefined): void {
  configFile = file;
}

export function resolveOrThrow(
  command: string,
  flags: Record<string, unknown>,
): Record<string, unknown> {
  const result = resolveConfig({ command, flags, env: process.env, file: configFile });
  if (result.errors.length > 0) {
    throw new Error(`invalid configuration:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.values;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm run build && npx vitest run packages/cli/src/options.test.ts packages/cli/src/resolve-config.test.ts`
Expected: PASS（9 个测试）

- [ ] **Step 5: 改写 main.ts 的每个子命令**

模式（以 `analyze` 为例，其余十个同理）：把 `.requiredOption(...)`/`.option(...)` 整串换成 `addSettings(program.command('analyze'), 'analyze')`，action 里第一行改为解析。

```ts
addSettings(
  program.command('analyze').description('Phase 1 only: build the static call graph (no LLM needed)'),
  'analyze',
).action(async (opts: Record<string, unknown>) => {
  const cfg = resolveOrThrow('analyze', opts);
  const stats = await runPhase1({
    sourceRoot: cfg.source as string,
    workDir: cfg.work as string,
    lang: cfg.lang as string,
    logger: logger(cfg),
  });
  printJson(stats);
});
```

三点要一起改到位：

- `resolve(...)` 的调用全部删掉 —— `type: 'path'` 已经在解析器里做了绝对化。
- `parseEnum`/`toInt` 的调用全部删掉 —— 校验已在 `coerceValue` 里完成。删除 `packages/cli/src/args.ts` 与 `args.test.ts`。
- `logger()` 改为接受解析结果：`function logger(cfg?: Record<string, unknown>)`，等级取 `cfg?.logLevel`，并让顶层 `-v/--quiet` 映射到它（`program.opts().verbose` → `logLevel: 'debug'`，`quiet` → `'error'`；两者都给时 `--quiet` 胜，与今天 `opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info'` 的优先级一致）。
- `resync` 的 `--no-llm`：commander 产出 `{ llm: false }`，而登记表的 key 是 `useLlm`。在 action 里把 commander 的 opts 归一化后再喂给解析器：`resolveOrThrow('resync', { ...opts, useLlm: opts.llm, refreshRendered: opts.render })`，并把 `opts.llm`/`opts.render` 从对象里删掉，避免未知 key 混入。

- [ ] **Step 6: 逐个子命令实测 flag 与 env 双向可用**

```bash
pnpm run build
node packages/cli/dist/main.js analyze --help | grep -E "read-workers|env:"   # 帮助里应有 [env: ...]
node packages/cli/dist/main.js generate --help | grep -E "\-\-model|\-\-assign-workers"

# flag 路径
node packages/cli/dist/main.js analyze --source examples/demo-project --work /tmp/hb-flag
# env 路径（同一件事，零 flag）
HANDBOOK_ANALYZE_SOURCE=examples/demo-project HANDBOOK_ANALYZE_WORK=/tmp/hb-env \
  node packages/cli/dist/main.js analyze
# 非法值必须大声失败
HANDBOOK_GENERATE_READ_WORKERS=twelve node packages/cli/dist/main.js generate --source . --work /tmp/x
```
Expected: 前两条都写出 graph 并打印同样形状的 JSON 统计；第三条以非零退出并打印 `invalid configuration:` + `HANDBOOK_GENERATE_READ_WORKERS: readWorkers must be an integer >= 1, got "twelve"`。

- [ ] **Step 7: 跑全量门禁，特别盯覆盖率**

Run: `pnpm run check`
Expected: PASS。**注意**：删掉 `args.ts`（覆盖良好）会拉低 `packages/cli` 的分子，而 `main.ts` 变短会抬高分母占比，净效应未知。若 `cli` 的地板 22/22/21/20 变红，**补测试，不许改阈值**（`vitest.config.ts` 有明文警告）—— Task 9 的 `config` 命令测试正是补充覆盖的地方，可以把它提前到此处。

- [ ] **Step 8: 提交**

```bash
git add packages/cli/src package.json
git rm packages/cli/src/args.ts packages/cli/src/args.test.ts
git commit -m "feat(cli): derive every option from the registry, and resolve at action time

Options are no longer hand-written per command, which is how --lang's help
text drifted five languages behind and how ~45 flags ended up with exactly
one env equivalent. Two rules make the derivation safe: no commander default
(an eager one captures the shell before --env-file is applied) and nothing
mandatory (--source and --work can now come from env or the config file, so
required-ness is enforced after all layers are consulted). toInt/parseEnum
retire into coerceValue, whose tests inherited their boundary cases."
```

---

### Task 7: LLM 配置贯通 flag/env，并让非法值大声失败

**Files:**
- Modify: `packages/llm/src/client.ts:79-116`
- Modify: `packages/llm/src/client.test.ts`（既有的宽容行为断言）
- Modify: `packages/cli/src/main.ts`（`llmClient()`）
- Modify: `packages/studio/src/server.ts`（默认 clientFactory）
- Modify: `packages/llm/package.json`（如尚未依赖 `@handbook/core` 则补上，并同步 tsconfig references）

**Interfaces:**
- Consumes: `resolveConfig`、`settingsFor('generate')`
- Produces: `resolveLlmEnv(env?)` 保持同名同返回类型 `LlmEnvConfig`，但改为严格；`llmConfigFrom(cfg): Partial<LlmEnvConfig>`（cli 用）

- [ ] **Step 1: 写失败测试 —— 严格化与新 flag 贯通**

追加到 `packages/llm/src/client.test.ts`：

```ts
describe('resolveLlmEnv strictness', () => {
  it('still reads the vendor env names and the handbook aliases', () => {
    const cfg = resolveLlmEnv({ OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'https://x/v1/', OPENAI_API_KEY: 'k' });
    expect(cfg.model).toBe('m');
    expect(cfg.baseUrl).toBe('https://x/v1'); // trailing slashes still stripped
    expect(cfg.apiKey).toBe('k');
  });

  it('fails loudly on a garbage numeric instead of silently using the default', () => {
    // Behaviour change, deliberate: the old code documented falling back to
    // 16000 so a bad value could not poison a request, but that also meant a
    // typo'd tuning var did nothing and said nothing.
    expect(() => resolveLlmEnv({ OPENAI_MAX_TOKENS: 'lots' })).toThrow(
      /OPENAI_MAX_TOKENS: llmMaxTokens must be an integer >= 1/,
    );
    expect(() => resolveLlmEnv({ OPENAI_TIMEOUT: '-5' })).toThrow(/OPENAI_TIMEOUT/);
  });

  it('fails loudly on malformed extra body instead of dropping the vendor field', () => {
    expect(() => resolveLlmEnv({ OPENAI_EXTRA_BODY: '{"thinking":}' })).toThrow(
      /OPENAI_EXTRA_BODY: llmExtraBody must be valid JSON/,
    );
  });

  it('still refuses to let extra body override the fields the client owns', () => {
    const cfg = resolveLlmEnv({ OPENAI_EXTRA_BODY: '{"model":"evil","thinking":{"type":"disabled"}}' });
    expect(cfg.extraBody).toEqual({ thinking: { type: 'disabled' } });
  });

  it('keeps 0 retries meaningful (one attempt), not replaced by the default', () => {
    expect(resolveLlmEnv({ HANDBOOK_LLM_MAX_RETRIES: '0' }).maxRetries).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm run build && npx vitest run packages/llm`
Expected: FAIL —— 三条"大声失败"的断言不成立（当前实现静默兜底）

- [ ] **Step 3: 用登记表重写 resolveLlmEnv**

替换 `client.ts:79-116`（`resolveLlmEnv` 与 `parseExtraBody`）：

```ts
/**
 * Resolve client configuration through the shared config registry, so the LLM
 * settings obey exactly the same precedence, naming and validation as every
 * other setting — and are reachable from flags, which they never were.
 *
 * Strict by design: a garbage value now throws with the variable named. The
 * previous silent fallback kept a bad value from poisoning a request, but it
 * also meant `OPENAI_MAX_TOKENS=lots` ran at 16000 and said nothing.
 */
export function resolveLlmEnv(env: NodeJS.ProcessEnv = process.env): LlmEnvConfig {
  const { values, errors } = resolveConfig({ command: 'generate', flags: {}, env });
  if (errors.length > 0) throw new ConfigError(errors.join('; '));
  return llmConfigFromValues(values) as LlmEnvConfig;
}

/**
 * Map resolved registry values onto the client's own shape. Seconds become
 * milliseconds here, and `maxRetries` is clamped to at least one attempt: 0 is
 * a legitimate "no retries" request, not "never try".
 */
export function llmConfigFromValues(values: Record<string, unknown>): Partial<LlmEnvConfig> {
  const num = (key: string): number | undefined =>
    typeof values[key] === 'number' ? (values[key] as number) : undefined;
  const str = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;

  const maxRetries = num('llmMaxRetries');
  const backoffSec = num('llmRetryBackoff');
  const timeoutSec = num('llmTimeout');
  const extra = values.llmExtraBody;

  return {
    apiKey: str('llmApiKey') ?? '',
    model: str('llmModel') ?? 'gpt-4o-mini',
    baseUrl: (str('llmBaseUrl') ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    maxTokens: num('llmMaxTokens') ?? 16_000,
    maxRetries: Math.max(1, maxRetries ?? 6),
    retryBackoffMs: Math.round((backoffSec ?? 3) * 1000),
    timeoutMs: Math.round((timeoutSec ?? 300) * 1000),
    extraBody: stripReservedBodyFields(extra),
  };
}

/** Fields the client owns; extra-body must not fight them. */
function stripReservedBodyFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => !RESERVED_BODY_FIELDS.has(key)),
  );
}
```

`RESERVED_BODY_FIELDS`（`client.ts:68`）保持原样不动 —— 它是 vendor 语义，属于 llm 包，不该进 core。

- [ ] **Step 4: 让 cli 把 LLM flag 真正接上**

`main.ts` 的 `llmClient()` 改为吃解析结果：

```ts
function llmClient(cfg: Record<string, unknown>): ChatClient {
  return new OpenAiChatClient({
    config: llmConfigFromValues(cfg),
    concurrency: cfg.llmConcurrency as number | undefined,
    logger: logger(cfg),
  });
}
```
`generate`/`plan`/`resync` 三处 `llmClient()` 调用改为传入各自的 `cfg`。`studio` 的 `startStudio` 保持默认 clientFactory（内部走 `resolveLlmEnv()`，现已严格）。

- [ ] **Step 5: 运行确认通过，并实测 flag 真的生效**

Run: `pnpm run build && npx vitest run packages/llm packages/cli packages/studio`
Expected: PASS

```bash
# mock 端点在 8099；--base-url 是新 flag，从前只能用 env
node examples/mock-llm-server.mjs 8099 &
node packages/cli/dist/main.js generate --source examples/demo-project --work /tmp/hb-llmflag \
  --base-url http://127.0.0.1:8099/v1 --model mock --phase 1,2a -v
kill %1
```
Expected: 日志里出现 `http://127.0.0.1:8099/v1` 与 model `mock`，运行成功。

- [ ] **Step 6: 提交**

```bash
git add packages/llm packages/cli packages/studio
git commit -m "feat(llm): put the endpoint settings on the command line, and stop guessing

The LLM configuration was env-only: --model, --base-url, --max-tokens and
--timeout did not exist. resolveLlmEnv now goes through the shared registry,
so those are flags, obey the same precedence, and validate identically.

BREAKING: a malformed OPENAI_* value throws instead of falling back to the
default. The old leniency kept bad values out of requests but also made a
typo silent — OPENAI_MAX_TOKENS=lots ran at 16000 and said nothing."
```

---

### Task 8: `handbook.config.yaml` 层

**Files:**
- Create: `packages/core/src/config/file.ts`
- Create: `packages/core/src/config/file.test.ts`
- Modify: `packages/core/package.json`（加 `"yaml": "catalog:"`）
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/main.ts`（`--config` 与 preAction）

**Interfaces:**
- Consumes: `SETTINGS`、`ConfigError`
- Produces: `discoverConfigFile(cwd): string | undefined`、`loadConfigFile(path): ConfigFileData`、`flattenConfig(data): Record<string, unknown>`

**要点：** `yaml` 能解析 JSON（JSON 是 YAML 的子集），所以 `.yaml`/`.yml`/`.json` 一个解析器全包。

- [ ] **Step 1: 写失败测试**

`packages/core/src/config/file.test.ts`：

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverConfigFile, flattenConfig, loadConfigFile } from './file.js';
import { ConfigError } from './coerce.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'hb-config-'));

describe('flattenConfig', () => {
  it('joins nested maps by camelCase, so one rule covers grouping and command scoping', () => {
    expect(flattenConfig({ llm: { model: 'm', baseUrl: 'u' }, generate: { readWorkers: 4 } })).toEqual({
      llmModel: 'm',
      llmBaseUrl: 'u',
      generateReadWorkers: 4,
    });
  });

  it('keeps an already-flat key as it is', () => {
    expect(flattenConfig({ llmModel: 'm', detail: 'deep' })).toEqual({ llmModel: 'm', detail: 'deep' });
  });

  it('treats arrays and null as leaves, not as maps to walk into', () => {
    expect(flattenConfig({ a: [1, 2], b: null })).toEqual({ a: [1, 2], b: null });
  });
});

describe('loadConfigFile', () => {
  it('parses YAML', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'llm:\n  model: from-yaml\ndetail: deep\n');
    const file = loadConfigFile(join(dir, 'handbook.config.yaml'));
    expect(file.flat).toEqual({ llmModel: 'from-yaml', detail: 'deep' });
  });

  it('parses JSON with the same parser, since JSON is valid YAML', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.json'), '{"detail":"brief"}');
    expect(loadConfigFile(join(dir, 'handbook.config.json')).flat).toEqual({ detail: 'brief' });
  });

  it('refuses a secret in the config file, and says where to put it instead', () => {
    // This file gets committed. A key in it is a key in the repo.
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'llm:\n  apiKey: sk-leaked\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(ConfigError);
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(
      /llmApiKey must not appear in a config file .* use \.env/,
    );
  });

  it('rejects a top-level list or scalar with a clear message', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), '- a\n- b\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(/must contain a mapping/);
  });

  it('reports the file and the YAML error on malformed input', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'a:\n  - b\n c: broken\n');
    expect(() => loadConfigFile(join(dir, 'handbook.config.yaml'))).toThrow(/handbook\.config\.yaml/);
  });
});

describe('discoverConfigFile', () => {
  it('finds the file in the starting directory', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
  });

  it('walks up so a command run from a subdirectory still sees the project config', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    const deep = join(dir, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(discoverConfigFile(deep)).toBe(join(dir, 'handbook.config.yaml'));
  });

  it('stops at a git root rather than escaping into a parent project', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'handbook.config.yaml'), 'detail: deep\n');
    const inner = join(dir, 'inner');
    mkdirSync(join(inner, '.git'), { recursive: true });
    expect(discoverConfigFile(inner)).toBeUndefined();
  });

  it('returns undefined when there is nothing to find', () => {
    expect(discoverConfigFile(tmp())).toBeUndefined();
  });

  it('prefers .yaml over .yml over .json when several exist', () => {
    const dir = tmp();
    for (const ext of ['yaml', 'yml', 'json']) {
      writeFileSync(join(dir, `handbook.config.${ext}`), ext === 'json' ? '{}' : 'detail: deep\n');
    }
    expect(discoverConfigFile(dir)).toBe(join(dir, 'handbook.config.yaml'));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/file.test.ts`
Expected: FAIL —— 无法解析 `./file.js`

- [ ] **Step 3: 加依赖并实现 file.ts**

`packages/core/package.json` 的 `dependencies` 加 `"yaml": "catalog:"`（版本只许住在 catalog），然后 `pnpm install`。

```ts
/**
 * The project config layer: `handbook.config.yaml`.
 *
 * Discovery walks up from the cwd so a command run in a subdirectory still sees
 * the project's settings — unlike `.env`, which stays cwd-only because it means
 * "this machine right now" and changing its existing behaviour is not on the
 * table. Parsing uses `yaml` for all three extensions, since JSON is valid YAML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './coerce.js';
import { SETTINGS } from './registry.js';
import type { ConfigFileData } from './resolve.js';

const FILENAMES = ['handbook.config.yaml', 'handbook.config.yml', 'handbook.config.json'] as const;

/** Nearest config file at or above `from`, not crossing out of a git root. */
export function discoverConfigFile(from: string): string | undefined {
  let dir = from;
  for (;;) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    // A repo boundary is a project boundary: do not inherit a parent project's
    // configuration just because this one has none.
    if (existsSync(join(dir, '.git'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Flatten nested maps by camelCase join, so `llm: { model }` and
 * `generate: { detail }` need no special cases — grouping and command scoping
 * are the same operation, and the result matches the registry's key space.
 */
export function flattenConfig(data: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(data)) {
    const key = prefix ? `${prefix}${rawKey[0]?.toUpperCase() ?? ''}${rawKey.slice(1)}` : rawKey;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(out, flattenConfig(value as Record<string, unknown>, key));
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfigFile(path: string): ConfigFileData {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return { path, flat: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${path}: must contain a mapping of settings, not a list or a scalar`);
  }
  const flat = flattenConfig(parsed as Record<string, unknown>);
  for (const setting of SETTINGS) {
    if (!setting.secret) continue;
    const leaked = Object.keys(flat).find(
      (key) => key === setting.key || key.endsWith(setting.key[0]!.toUpperCase() + setting.key.slice(1)),
    );
    if (leaked) {
      throw new ConfigError(
        `${path}: ${setting.key} must not appear in a config file (it gets committed) — use .env or the shell environment instead`,
      );
    }
  }
  return { path, flat };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run packages/core/src/config/file.test.ts`
Expected: PASS（13 个测试）

- [ ] **Step 5: 在 CLI 里接上 `--config`**

`main.ts` 顶层加选项，并在既有的 `preAction` 钩子里（`main.ts:53-62`，env 文件加载之后）发现并加载配置文件：

```ts
program.option('--config <path>', 'project config file (default: nearest handbook.config.yaml)');

// …在 preAction 钩子内，applyEnvFile 之后：
const explicitConfig = program.opts<{ config?: string }>().config;
if (explicitConfig) {
  // An explicitly named file that is missing is a mistake, not a fallback.
  setConfigFile(loadConfigFile(resolve(explicitConfig)));
} else {
  const found = discoverConfigFile(process.cwd());
  if (found) {
    setConfigFile(loadConfigFile(found));
    logger().debug(`[config] loaded ${found}`);
  }
}
```

- [ ] **Step 6: 实测四层优先级都在**

```bash
cd /tmp && mkdir -p hb-layers && cd hb-layers
printf 'llm:\n  model: from-file\n' > handbook.config.yaml
node ~/Desktop/share/handbook/packages/cli/dist/main.js config --command generate | grep llmModel
HANDBOOK_LLM_MODEL=from-env node ~/Desktop/share/handbook/packages/cli/dist/main.js config --command generate | grep llmModel
HANDBOOK_LLM_MODEL=from-env node ~/Desktop/share/handbook/packages/cli/dist/main.js config --command generate --model from-flag | grep llmModel
```
Expected: 依次显示 `from-file … file`、`from-env … env`、`from-flag … flag`。（`config` 子命令在 Task 9 落地；若尚未实现，本步骤挪到 Task 9 Step 5 执行。）

- [ ] **Step 7: 提交**

```bash
git add packages/core packages/cli/src/main.ts pnpm-lock.yaml
git commit -m "feat(core): add the project config file layer under env

handbook.config.yaml sits below env and above defaults, so a project can
carry its settings while a shell still overrides them. Discovery walks up to
the git root — a command run in a subdirectory should still see the project's
config — while .env stays cwd-only, because it means 'this machine right now'
and its behaviour is not being changed. One parser covers all three
extensions since JSON is valid YAML. A secret in this file is refused
outright with a pointer to .env: the file gets committed."
```

---

### Task 9: `handbook config` 子命令

**Files:**
- Create: `packages/cli/src/config-command.ts`
- Create: `packages/cli/src/config-command.test.ts`
- Modify: `packages/cli/src/main.ts`

**Interfaces:**
- Consumes: `resolveConfig`、`settingsFor`、`SETTINGS`
- Produces: `renderConfigTable(result, command): string`、`renderConfigJson(result, command): string`、`maskSecret(value): string`

- [ ] **Step 1: 写失败测试**

`packages/cli/src/config-command.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '@handbook/core';
import { maskSecret, renderConfigJson, renderConfigTable } from './config-command.js';

const resolved = (env: NodeJS.ProcessEnv = {}, flags: Record<string, unknown> = {}) =>
  resolveConfig({ command: 'generate', flags, env, cwd: '/repo' });

describe('maskSecret', () => {
  it('shows enough to identify a key without printing it', () => {
    expect(maskSecret('sk-abcdefgh1234')).toBe('sk-…1234');
  });

  it('never leaks a short value by showing most of it', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('')).toBe('');
  });
});

describe('renderConfigTable', () => {
  it('shows the value and the source for each setting', () => {
    const text = renderConfigTable(resolved({ HANDBOOK_LLM_MODEL: 'm' }), 'generate');
    expect(text).toMatch(/llmModel\s+m\s+env HANDBOOK_LLM_MODEL/);
    expect(text).toMatch(/llmMaxTokens\s+16000\s+default/);
  });

  it('masks a secret even though it resolved from the environment', () => {
    const text = renderConfigTable(resolved({ OPENAI_API_KEY: 'sk-abcdefgh1234' }), 'generate');
    expect(text).toContain('sk-…1234');
    expect(text).not.toContain('sk-abcdefgh1234');
  });

  it('marks a pass-through setting as unset rather than inventing a value', () => {
    expect(renderConfigTable(resolved(), 'generate')).toMatch(/readBatchSize\s+—\s+unset/);
  });
});

describe('renderConfigJson', () => {
  it('emits values and sources as machine-readable JSON with secrets masked', () => {
    const parsed = JSON.parse(
      renderConfigJson(resolved({ OPENAI_API_KEY: 'sk-abcdefgh1234', HANDBOOK_DETAIL: 'deep' }), 'generate'),
    ) as { command: string; settings: Record<string, { value: unknown; source: string }> };
    expect(parsed.command).toBe('generate');
    expect(parsed.settings.detail).toEqual({ value: 'deep', source: 'env HANDBOOK_DETAIL' });
    expect(parsed.settings.llmApiKey?.value).toBe('sk-…1234');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm run build && npx vitest run packages/cli/src/config-command.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 config-command.ts**

```ts
/**
 * `handbook config` — print the resolved configuration and where each value
 * came from. This is what makes "flags and env are interchangeable" checkable
 * instead of merely claimed: run it twice, once with a flag and once with the
 * env var, and compare.
 */
import { settingByKey, type ResolveResult, type Source } from '@handbook/core';

/** Enough of a key to recognise it, never enough to use it. */
export function maskSecret(value: string): string {
  if (value === '') return '';
  return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : '***';
}

function describeSource(source: Source | undefined): string {
  if (!source) return 'unset';
  switch (source.kind) {
    case 'flag':
      return `flag ${source.name}`;
    case 'env':
      return `env ${source.name}`;
    case 'file':
      return `file ${source.path} (${source.keyPath})`;
    default:
      return 'default';
  }
}

function display(key: string, result: ResolveResult): string {
  if (!(key in result.values)) return '—';
  const value = result.values[key];
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return settingByKey(key)?.secret ? maskSecret(text) : text;
}

export function renderConfigTable(result: ResolveResult, command: string): string {
  const keys = Object.keys(result.sources).concat(
    // Pass-through settings that resolved to nothing still deserve a row: their
    // absence is information.
    (settingByKey(''), []),
  );
  const rows = allKeys(result, command).map((key) => [
    key,
    display(key, result),
    describeSource(result.sources[key]),
  ]);
  const width = (i: number): number => Math.max(...rows.map((r) => (r[i] as string).length));
  const [w0, w1] = [width(0), width(1)];
  const lines = rows.map(
    ([k, v, s]) => `${(k as string).padEnd(w0)}  ${(v as string).padEnd(w1)}  ${s as string}`,
  );
  return `${lines.join('\n')}\n`;
}

export function renderConfigJson(result: ResolveResult, command: string): string {
  const settings: Record<string, { value: unknown; source: string }> = {};
  for (const key of allKeys(result, command)) {
    settings[key] = {
      value: settingByKey(key)?.secret ? display(key, result) : result.values[key],
      source: describeSource(result.sources[key]),
    };
  }
  return `${JSON.stringify({ command, settings, errors: result.errors }, null, 2)}\n`;
}
```

同时在 core 导出一个小助手供上面的 `allKeys` 用（放 `registry.ts`）：

```ts
/** Every key that applies to a command, in declaration order — including the
 *  pass-through ones that resolved to nothing, whose absence is information. */
export function keysFor(command: string): string[] {
  return settingsFor(command).map((s) => s.key);
}
```
并把 `config-command.ts` 里的 `allKeys(result, command)` 实现为 `keysFor(command)`（从 `@handbook/core` 导入），删掉上面那段占位的 `keys` 计算。

- [ ] **Step 4: 在 main.ts 注册子命令**

```ts
addSettings(
  program.command('config').description('Print the resolved configuration and where each value came from'),
  'config',
).action((opts: Record<string, unknown>) => {
  const target = (opts.command as string | undefined) ?? 'generate';
  const result = resolveConfig({
    command: target,
    flags: opts,
    env: process.env,
    file: currentConfigFile(),
  });
  if (opts.check) {
    for (const error of result.errors) process.stderr.write(`config: ${error}\n`);
    process.stderr.write(result.errors.length ? 'config: FAILED\n' : 'config: OK\n');
    process.exitCode = result.errors.length ? 2 : 0;
    return;
  }
  process.stdout.write(opts.json ? renderConfigJson(result, target) : renderConfigTable(result, target));
});
```
`resolve-config.ts` 另外导出 `currentConfigFile()` 返回模块内的 `configFile`。

- [ ] **Step 5: 运行测试，并执行 Task 8 Step 6 的四层实测**

Run: `pnpm run build && npx vitest run packages/cli`
Expected: PASS，且 Task 8 Step 6 的三条命令分别显示 `file` / `env` / `flag` 来源。

```bash
# --check 必须在缺必填时非零退出
cd /tmp/hb-layers && node ~/Desktop/share/handbook/packages/cli/dist/main.js config --command generate --check; echo "exit=$?"
```
Expected: 打印 `source is required: …` 与 `config: FAILED`，`exit=2`。

- [ ] **Step 6: 提交**

```bash
git add packages/cli packages/core/src/config/registry.ts
git commit -m "feat(cli): add handbook config, which shows each value and where it came from

Interchangeable flags and env vars are a claim until something can show the
layering. Run it once with --model and once with HANDBOOK_LLM_MODEL and the
source column proves it. Secrets are masked to a recognisable stub, --json
feeds scripts, and --check exits 2 with every problem listed rather than the
first one."
```

---

### Task 10: 生成 `.env.example` 与 `docs/configuration.md`，并用漂移测试钉住

**Files:**
- Create: `packages/core/src/config/render-docs.ts`
- Create: `packages/core/src/config/render-docs.test.ts`
- Create: `scripts/gen-config-docs.mjs`
- Modify: `.env.example`（改为生成物）
- Create: `docs/configuration.md`、`handbook.config.example.yaml`（生成物）
- Modify: `packages/cli/src/docs-drift.test.ts`
- Modify: `README.md`、`README.zh-CN.md`（各加一处链接）

**Interfaces:**
- Consumes: `SETTINGS`、`envName`、`scopedEnvName`
- Produces: `renderEnvExample(): string`、`renderConfigDocs(): string`、`renderConfigExampleYaml(): string`

**结构要点：** 渲染函数放 core（可被 vitest 直接 import），`.mjs` 脚本只负责写盘。漂移测试 import 同一个函数与磁盘文件逐字节比对 —— 这样"生成器"和"检查器"不可能各说一套。

- [ ] **Step 1: 写失败测试**

`packages/core/src/config/render-docs.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from './render-docs.js';
import { SETTINGS } from './registry.js';
import { envName } from './names.js';

describe('renderEnvExample', () => {
  const text = renderEnvExample();

  it('documents every non-secret setting that has a flat env name', () => {
    const missing = SETTINGS.filter((s) => !s.scopedOnly && !text.includes(envName(s.key)));
    expect(missing.map((s) => s.key)).toEqual([]);
  });

  it('keeps the vendor alias for the api key, which existing .env files use', () => {
    expect(text).toContain('OPENAI_API_KEY');
  });

  it('leaves every line commented out except the api key, so copying it is safe', () => {
    // An uncommented default would override a shell value the user already set.
    const assignments = text.split('\n').filter((l) => /^[A-Z]/.test(l));
    expect(assignments).toEqual(['OPENAI_API_KEY=sk-...']);
  });

  it('says which values are secret and where they may live', () => {
    expect(text).toMatch(/never.*config file/i);
  });
});

describe('renderConfigDocs', () => {
  const text = renderConfigDocs();

  it('has a row for every setting, with its flag and env name', () => {
    for (const s of SETTINGS) {
      expect(text, `missing ${s.key}`).toContain(s.key);
      if (s.flag) expect(text).toContain(s.flag.split(/[ ,]/)[0] as string);
    }
  });

  it('states the precedence order once, unambiguously', () => {
    expect(text).toMatch(/flag.*shell env.*\.env.*handbook\.config\.yaml.*default/s);
  });
});

describe('renderConfigExampleYaml', () => {
  it('nests the llm group and a command section, and omits secrets', () => {
    const text = renderConfigExampleYaml();
    expect(text).toMatch(/^llm:/m);
    expect(text).toMatch(/^ {2}model:/m);
    expect(text).not.toContain('apiKey');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/render-docs.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 render-docs.ts**

要求（实现细节可自行安排，但必须满足上面全部断言）：

- `renderEnvExample()`：顶部说明 `.env` 的语义与优先级（照抄现有 `.env.example` 的前两行精神：复制为 `.env`、CLI 自动加载、shell 永远胜过文件），随后按 `commands` 分组，每项一行注释（`# <doc>`）+ 一行注释掉的 `KEY=<default 或 example>`。**唯一未注释的行是 `OPENAI_API_KEY=sk-...`**，因为那是唯一必填项。secret 项额外注明不得进配置文件。
- `renderConfigDocs()`：Markdown。开头一节写优先级链与命名规则（扁平名/带前缀名/配置文件键三列对照）；随后按命令分节，每节一张表：`key | flag | env | type | default | doc`。`scopedOnly` 的项只列带前缀名。
- `renderConfigExampleYaml()`：把非 secret 项按 camelCase 反向拆成嵌套 YAML（`llmModel` → `llm: { model }`），全部注释掉，附一行说明"每一项都可以写成扁平键，例如 `llmModel:`"。

- [ ] **Step 4: 写生成脚本，生成三个文件**

`scripts/gen-config-docs.mjs`：

```js
#!/usr/bin/env node
// Writes the three generated configuration surfaces. The rendering itself lives
// in @handbook/core so the drift test can call exactly the same functions —
// a generator and a checker that could disagree would defeat the point.
//
// Run: pnpm run config:docs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from '../packages/core/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['.env.example', renderEnvExample()],
  ['docs/configuration.md', renderConfigDocs()],
  ['handbook.config.example.yaml', renderConfigExampleYaml()],
];
for (const [rel, content] of files) {
  writeFileSync(join(ROOT, rel), content);
  console.log(`wrote ${rel}`);
}
```

Run: `pnpm run config:docs`
Expected: 打印三行 `wrote …`；`git diff .env.example` 显示它从 20 行的手写文件变成覆盖全部约 60 项的生成文件。

- [ ] **Step 5: 加漂移测试**

追加到 `packages/cli/src/docs-drift.test.ts`：

```ts
import { renderConfigDocs, renderConfigExampleYaml, renderEnvExample } from '@handbook/core';

describe('generated configuration surfaces are current', () => {
  // Hand-editing any of these is the drift this catches: the registry is the
  // source, `pnpm run config:docs` is the regeneration.
  for (const [rel, render] of [
    ['.env.example', renderEnvExample],
    ['docs/configuration.md', renderConfigDocs],
    ['handbook.config.example.yaml', renderConfigExampleYaml],
  ] as const) {
    it(`${rel} matches the registry byte for byte`, () => {
      expect(read(rel), `${rel} is stale — run: pnpm run config:docs`).toBe(render());
    });
  }
});
```

Run: `pnpm run build && npx vitest run packages/cli/src/docs-drift.test.ts`
Expected: PASS。随后手动改坏一行 `.env.example` 再跑一次，必须 FAIL 且提示 `run: pnpm run config:docs`；改回来。

- [ ] **Step 6: README 加链接**

`README.md` 在 `export OPENAI_API_KEY=…` 那段（第 39–44 行附近）之后加一行：

```markdown
Every setting is also a flag and a config-file key — see [docs/configuration.md](docs/configuration.md)
for the full reference, or run `handbook config` to see what is set and where it came from.
```

`README.zh-CN.md` 在对应位置（第 35–40 行附近）加：

```markdown
每一项配置都同时是命令行参数、环境变量和配置文件键 —— 完整清单见
[docs/configuration.md](docs/configuration.md)，或运行 `handbook config` 查看当前取值及其来源。
```

- [ ] **Step 7: 提交**

```bash
git add .env.example docs/configuration.md handbook.config.example.yaml scripts/gen-config-docs.mjs packages/core/src/config packages/cli/src/docs-drift.test.ts README.md README.zh-CN.md
git commit -m "docs: generate the configuration reference from the registry

.env.example listed 9 of ~60 settings because it was hand-written. It, the
config-file example and a new docs/configuration.md are now generated by the
same functions the drift test calls, so a hand-edit or a new registry entry
fails the build with the regeneration command in the message."
```

---

### Task 11: 收尾 —— changeset、PROGRESS、全量门禁

**Files:**
- Create: `.changeset/<pnpm-generated-name>.md`
- Modify: `docs/internal/PROGRESS.md`

- [ ] **Step 1: 写 changeset，明确标出破坏性变更**

Run: `pnpm run changeset`

选 `@handbook/llm` 为 **minor**（`resolveLlmEnv` 严格化，pre-1.0 用 minor 表达 breaking），`@handbook/core`、`@handbook/cli`、`@handbook/pipeline` 为 minor，其余 patch。摘要照抄这段：

```markdown
Configuration is now declared once in a registry and derived onto every surface:
each setting is a CLI flag, an environment variable and a `handbook.config.yaml`
key, resolved flag > shell env > .env > config file > default. `--model`,
`--base-url`, `--max-tokens`, `--timeout` and four more LLM flags now exist; so
do the six pipeline tuning knobs that were reachable from nothing. `handbook
config` prints every resolved value with its source.

BREAKING: an invalid `OPENAI_*` / `HANDBOOK_*` value now fails loudly instead of
falling back to the default. `OPENAI_MAX_TOKENS=lots` used to run at 16000
silently; it now names the variable and exits non-zero.
```

- [ ] **Step 2: 追加 PROGRESS 条目（最新在最后）**

在 `docs/internal/PROGRESS.md` 末尾追加：

```markdown
## 2026-08-07 配置登记表与脚本体系

规格 `docs/internal/specs/2026-08-07-config-and-scripts-design.md`，计划
`docs/internal/plans/2026-08-07-config-and-scripts.md`。

起因是三件看起来无关的抱怨——scripts 不优雅、`.env.example` 太单薄、flag 与 env 不通——
根因只有一个：没有任何地方声明"一项配置是什么"。盘点后的事实：约 45 个 flag 里**只有
`--title` 一个**同时能用环境变量设置；LLM 端点根本没有 flag；`GenerateOptions` 里六个真实
字段（readBatchSize / maxCharsPerFile / assignBatchSize / assignWorkers / organizeWorkers /
narrateWorkers）两头都到不了。

现在 `packages/core/src/config/` 一张登记表派生四个界面：commander 选项、解析、
`.env.example`、`docs/configuration.md`。优先级 flag > shell env > `.env` >
`handbook.config.yaml` > 默认值，每个值都记来源，`handbook config` 能打出来。

**后来者需要知道的几件事：**
- **不要给 commander 设默认值**，也不要用 `requiredOption`。默认值一律来自 action 时的解析器；
  提前求值会在 `preAction` 应用 env 文件之前抓到 shell 的值（`render-refresh.ts:19` 的旧教训）。
  必填改由解析后判定，因为 env 与配置文件现在也能提供 `--source`。
- **`PIPELINE_DEFAULTS` 是流水线调优默认值的唯一来源**，登记表与下游解构都引用它。别再把
  25、12、8 抄回 `assign.ts` / `organize.ts` 里，那会让生成的文档变成第二个事实来源。
- **`resolveLlmEnv` 不再宽容**（破坏性变更，已写进 changeset）。旧注释说静默兜底是为了不让
  垃圾值污染请求；代价是 `OPENAI_MAX_TOKENS=lots` 静默跑在 16000 上。
- **secret 永不进配置文件**，`loadConfigFile` 直接拒绝——那个文件是要提交的。
- `pnpm config` 是 pnpm 内置命令，所以脚本叫 `config:show`。
- 脚本改名不留别名：`smoke:install`→`check:install`、`release`→`release:publish`、
  `version-packages`→`release:version`，README 里的脚本名有漂移测试兜着。
```

- [ ] **Step 3: 跑完整门禁**

Run: `pnpm run check:all`
Expected: 全绿 —— typecheck、check-workspace、eslint 零警告、prettier、按包覆盖率地板、publint/attw、smoke-install 端到端。任何一项红了都要修代码或补测试，**不许调覆盖率阈值**。

- [ ] **Step 4: 端到端再验一次两条路径等价**

```bash
pnpm run demo                      # mock 端点全链路
rm -rf /tmp/hb-a /tmp/hb-b
node packages/cli/dist/main.js analyze --source examples/demo-project --work /tmp/hb-a
HANDBOOK_ANALYZE_SOURCE=examples/demo-project HANDBOOK_ANALYZE_WORK=/tmp/hb-b \
  node packages/cli/dist/main.js analyze
node -e "const a=require('fs').readFileSync('/tmp/hb-a/graph.json','utf8'),b=require('fs').readFileSync('/tmp/hb-b/graph.json','utf8');const s=t=>JSON.stringify(JSON.parse(t).nodes.length);if(s(a)!==s(b))throw new Error('flag and env paths disagree');console.log('flag path and env path agree:',s(a),'nodes')"
```
Expected: `pnpm run demo` 成功；最后一行打印两条路径节点数一致。这是"两者都能跑"的最终证据。

- [ ] **Step 5: 提交**

```bash
git add .changeset docs/internal/PROGRESS.md
git commit -m "chore(repo): record the config registry work and its breaking change"
```

---

### Task 12: Docker 支持（用户 2026-08-07 追加要求）

**Files:**
- Modify: `packages/core/src/config/registry.ts`（新增 `host` 一项）+ `registry.test.ts`
- Modify: `packages/studio/src/server.ts:39,1016-1023`（`StudioOptions.host` + `listen`）+ `server.test.ts`
- Modify: `packages/cli/src/main.ts`（studio action 传 `cfg.host`）
- Create: `Dockerfile`、`.dockerignore`、`docker-compose.yml`
- Modify: `package.json`（两个 docker 脚本）、`README.md`、`README.zh-CN.md`

**Interfaces:**
- Consumes: 登记表与解析器（Task 2–9）
- Produces: `host` 设置；`StudioOptions.host`；`pnpm run docker:build` / `docker:studio`

**为什么这不只是打包。** `startStudio` 把 `'127.0.0.1'` 写死在 `server.ts:1022`。容器里绑
loopback 意味着 `-p 4860:4860` **完全不通** —— 宿主机永远连不上。所以 Docker 支持的前提
是一个真正的绑定地址配置项，而它现在只是登记表里的一行。

**必须理解、绝不可放松的一点。** `server.ts:977-983` 的 `isLoopbackRequest` 是针对本地工具的
CSRF / DNS-rebinding 防线：它校验的是 **`Host` 请求头**，不是 socket 地址。因此绑 `0.0.0.0`
之后，宿主机浏览 `http://localhost:4860` 发出的 `Host: localhost:4860` **仍然通过**，防线完好。
用 LAN IP 或容器名访问会 **403**，这是**正确行为**，要写进文档，**不许**为了"方便"去放宽
`LOOPBACK_HOST_RE`。真要远程访问是另一个需要单独决策的功能（显式 allowlist），本任务**非目标**。

- [ ] **Step 1: 写失败测试 —— host 设置存在且默认 loopback**

追加到 `packages/core/src/config/registry.test.ts`：

```ts
  it('defaults studio to loopback, and keeps it configurable', () => {
    // Containers need 0.0.0.0; everyone else must stay on loopback by default.
    const host = settingByKey('host');
    expect(host?.default).toBe('127.0.0.1');
    expect(host?.commands).toEqual(['studio']);
    expect(host?.flag).toBe('--host <addr>');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/config/registry.test.ts`
Expected: FAIL —— `settingByKey('host')` 是 undefined

- [ ] **Step 3: 加登记表条目**

```ts
  { key: 'host', type: 'string', flag: '--host <addr>', default: '127.0.0.1', commands: ['studio'],
    doc: 'bind address; stays on loopback unless you set it (containers need 0.0.0.0). The CSRF guard still requires a loopback Host header' },
```

- [ ] **Step 4: 写 studio 侧的失败测试**

追加到 `packages/studio/src/server.test.ts`：

```ts
  it('binds the requested address, defaulting to loopback', async () => {
    const server = await startStudio({ stateDir: tmpStateDir(), port: 0, host: '0.0.0.0' });
    const address = server.address();
    expect(typeof address === 'object' && address?.address).toBe('0.0.0.0');
    server.close();
  });

  it('still refuses a non-loopback Host header when bound to 0.0.0.0', async () => {
    // The CSRF defence is about the Host HEADER, not the socket. Binding wide
    // for a container must not widen who may talk to it.
    const server = await startStudio({ stateDir: tmpStateDir(), port: 0, host: '0.0.0.0' });
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      headers: { host: 'evil.example.com' },
    });
    expect(res.status).toBe(403);
    server.close();
  });
```

（`tmpStateDir()` 用该文件已有的临时目录辅助函数；照抄它现有的写法，不要新造。若 `fetch` 无法
覆盖 `host` 头，改用 `node:http` 的 `request` 显式设置，并在报告里说明。）

- [ ] **Step 5: 让 studio 接受 host**

`server.ts` 的 `StudioOptions` 加：

```ts
  /** Bind address. Default 127.0.0.1 — a container passes 0.0.0.0. The Host-header
   *  guard in createStudioServer is unaffected and must stay as it is. */
  host?: string;
```

`startStudio` 改为 `server.listen(port, options.host ?? '127.0.0.1', …)`，并把该函数上方
"Start the server on 127.0.0.1" 的注释改成说明默认值与 Host 头防线的关系。
`main.ts` 的 studio action 传 `host: cfg.host as string`，启动提示行也用实际地址而不是写死的
`127.0.0.1`。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm run build && npx vitest run packages/studio packages/core packages/cli`
Expected: PASS

- [ ] **Step 7: `.dockerignore`**

```
node_modules
**/node_modules
**/dist
**/*.tsbuildinfo
coverage
work
runs
examples/work
.git
.superpowers
.claude
.env
```

- [ ] **Step 8: `Dockerfile`**

**Node 22，不是 24** —— `tree-sitter-swift` 在 V8 >= 13 上会**直接终止进程**（exit 133，这就是
`vitest.config.ts` 要用 `--liftoff-only` 的原因）。Node 22 是 V8 12.4，Node 24 是 13.6：用 22
就不必在生产镜像里带那个 flag，用 24 会让容器里的 Swift 分析静默崩掉。
依赖全是纯 JS + wasm（`web-tree-sitter`、`tree-sitter-wasms`），所以 alpine 可用、不需要编译工具链。

```dockerfile
# syntax=docker/dockerfile:1
# Node 22, deliberately not 24: tree-sitter-swift aborts the process on V8 >= 13
# (exit 133). Node 22 ships V8 12.4, so Swift analysis works without the
# --liftoff-only flag the test runner needs elsewhere.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig*.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# Drop dev dependencies from the tree we copy forward.
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
# A handbook run only ever needs to read /src and write /work.
RUN addgroup -S handbook && adduser -S -G handbook handbook \
 && mkdir -p /src /work && chown -R handbook:handbook /src /work
USER handbook
ENV HANDBOOK_SOURCE=/src HANDBOOK_WORK=/work
ENTRYPOINT ["node", "/app/packages/cli/dist/main.js"]
CMD ["--help"]
```

注意 `ENV HANDBOOK_SOURCE/HANDBOOK_WORK` 正是这次配置工作的红利：容器里不必在每条命令后面
重复 `--source /src --work /work`，而宿主机上的 flag 依然能覆盖它们。

- [ ] **Step 9: `docker-compose.yml`（studio）**

```yaml
services:
  studio:
    build: .
    command: ["studio"]
    ports: ["4860:4860"]
    environment:
      # A container must listen wide or the published port is unreachable. The
      # Host-header guard still applies, so browse http://localhost:4860 from the
      # host — a LAN IP or the container name is refused by design.
      HANDBOOK_STUDIO_HOST: 0.0.0.0
      HANDBOOK_STUDIO_STATE_DIR: /work/.handbook-studio
    volumes:
      - ./:/src:ro
      - handbook-work:/work
volumes:
  handbook-work:
```

- [ ] **Step 10: 脚本与文档**

`package.json` 加两行（放在 `demo` 之前，保持家族分组）：

```json
    "docker:build": "docker build -t handbook:local .",
    "docker:studio": "docker compose up --build studio",
```

两个 README 各加一小节：镜像怎么建、`docker run --rm -v "$PWD:/src:ro" -v handbook-work:/work handbook:local analyze`
怎么跑、studio 怎么起、以及**为什么只能用 `http://localhost:4860` 访问**（Host 头防线）。
`docker run --env-file .env` 与既有的 `.env` 加载是叠加关系，也写一句。

- [ ] **Step 11: 真的把镜像跑起来**

```bash
pnpm run docker:build
docker run --rm -v "$PWD/examples/demo-project:/src:ro" -v hb-work:/work handbook:local analyze
docker run --rm handbook:local --help | head -20
docker compose up -d --build studio && sleep 3
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:4860/api/state          # 期望 200
curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com' http://localhost:4860/api/state  # 期望 403
docker compose down -v
```
Expected: `analyze` 在容器里写出 graph 并打印统计；两条 curl 分别 200 与 403 —— 后者证明绑宽了
但防线没松。**Docker 不可用就如实报告并停下**，不要伪造这一步的输出。

- [ ] **Step 12: 提交**

```bash
git add Dockerfile .dockerignore docker-compose.yml package.json README.md README.zh-CN.md packages/core/src/config packages/studio/src packages/cli/src/main.ts
git commit -m "feat(repo): ship a container image, and make studio's bind address configurable

Studio hardcoded 127.0.0.1, so a published container port was unreachable —
Docker support needed a real bind-address setting, which the registry made a
one-line addition. The default stays loopback.

The Host-header CSRF guard is deliberately untouched: it inspects the header,
not the socket, so browsing localhost:4860 from the host still passes while a
LAN IP or container name is refused. Binding wide does not widen who may talk
to it. Node 22, not 24, because tree-sitter-swift aborts the process on V8 >= 13."
```

### Task 13: 多环境支持（用户 2026-08-08 追加要求）

**Files:**
- Modify: `packages/core/src/util/env-file.ts`（级联加载）+ `env-file.test.ts`
- Modify: `packages/core/src/config/file.ts`（按环境发现配置文件）+ `file.test.ts`
- Modify: `packages/cli/src/main.ts`（`--env` 引导选项 + preAction 级联）
- Modify: `packages/cli/src/config-command.ts`（显示激活环境与已加载文件）+ 测试
- Modify: `packages/core/src/config/render-docs.ts`（Bootstrap 一节写清级联）
- Modify: `Dockerfile`、`docker-compose.yml`、`README.md`、`README.zh-CN.md`

**前置条件（已在 fix wave 的 P2-18 处理）：** `.gitignore` 与 `.dockerignore` 必须先改成
`.env*` + `!.env.example`。**在那之前不许合入本任务** —— 否则 `.env.production` 一旦存在就会
被提交进 git、并烘进镜像层。这是本功能的安全前置，不是收尾工作。

**设计。** `--env <name>` / `HANDBOOK_ENV` 是**引导层**设置，与 `--config` / `--env-file`
同级：它不能被自己加载的东西设置，因此不进登记表的常规解析，在 `preAction` 里最先读取。

加载顺序（**优先级从高到低**；`applyEnvFile` 既有语义是"绝不覆盖已存在的值"，所以按此顺序
依次调用即可，先到先得）：

```
1. shell 环境          （永远最高）
2. .env.<name>.local   个人 · 该环境专属   （gitignored）
3. .env.<name>         团队 · 该环境专属   （提交）
4. .env.local          个人 · 全环境       （gitignored）
5. .env                团队 · 基线         （提交）
```

未指定 `--env` 时，只加载 4 与 5 —— **既有行为完全不变**，这是本任务的兼容性底线。

配置文件同理：`handbook.config.<name>.yaml` 先于 `handbook.config.yaml` 被发现（向上查找的
每一层目录里都先试带环境名的那个），`--config` 显式指定时不参与环境推导。

- [ ] **Step 1: 写失败测试 —— 级联顺序与"先到先得"**

`packages/core/src/util/env-file.test.ts` 追加：

```ts
describe('applyEnvFiles cascade', () => {
  it('lets a more specific file win, and never overrides the shell', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\nC=base\n');
    writeFileSync(join(dir, '.env.local'), 'B=local\nC=local\n');
    writeFileSync(join(dir, '.env.prod'), 'C=prod\nD=prod\n');
    const env: NodeJS.ProcessEnv = { A: 'shell' };
    const loaded = applyEnvFiles(dir, 'prod', env);
    expect(env.A).toBe('shell');   // shell always wins
    expect(env.B).toBe('local');   // .env.local beats .env
    expect(env.C).toBe('prod');    // .env.prod beats both
    expect(env.D).toBe('prod');
    expect(loaded).toEqual([join(dir, '.env.prod'), join(dir, '.env.local'), join(dir, '.env')]);
  });

  it('loads only .env.local and .env when no environment is named', () => {
    const dir = tmp();
    writeFileSync(join(dir, '.env'), 'A=base\n');
    writeFileSync(join(dir, '.env.prod'), 'A=prod\n');
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFiles(dir, undefined, env)).toEqual([join(dir, '.env')]);
    expect(env.A).toBe('base');   // an unnamed run must not pick up .env.prod
  });

  it('is silent about files that do not exist', () => {
    expect(applyEnvFiles(tmp(), 'nope', {})).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run packages/core/src/util/env-file.test.ts`
Expected: FAIL —— `applyEnvFiles` 不存在

- [ ] **Step 3: 实现 `applyEnvFiles`**

保留 `applyEnvFile`（单文件，`--env-file` 仍然用它）。新增 `applyEnvFiles(dir, name, env)`：
按上表顺序对存在的文件依次调用 `applyEnvFile`，返回**实际加载的文件路径数组**（顺序即优先级）。
"绝不覆盖"由 `applyEnvFile` 本身保证，因此级联只是"按优先级从高到低依次调用"。

- [ ] **Step 4: 配置文件按环境发现**

`discoverConfigFile(from, name?)`：向上走的每一层目录，先试
`handbook.config.<name>.{yaml,yml,json}`，再试无环境名的三个；找到即返回。git 根边界与
既有行为不变。补测试：子目录里执行、`--env prod` 时命中上层的 `handbook.config.prod.yaml`
而不是同层的 `handbook.config.yaml`。

- [ ] **Step 5: CLI 接线**

`main.ts` 顶层加 `--env <name>`（帮助文本要说明它是引导选项，且 `HANDBOOK_ENV` 等价）。
preAction 里：先取 `--env` 或 `process.env.HANDBOOK_ENV` → 调 `applyEnvFiles(process.cwd(), name)`
→ 再按环境发现配置文件。**顺序不可调换**（env 文件必须在配置文件之前进入 `process.env`）。
把"激活环境 + 已加载文件列表"存起来供 `handbook config` 使用。

- [ ] **Step 6: `handbook config` 必须显示环境**

四层已经难追，级联之后是八个可能的来源。`handbook config` 顶部输出：

```
environment: prod  (--env)
env files:   .env.prod, .env.local, .env       (highest precedence first)
config file: handbook.config.prod.yaml
```

`--json` 里同样带上这三项。**没有这个，级联就是不可审计的** —— 与 studio 那个 bug 是同一个
教训：检查工具看不到的东西，等于不存在。补测试钉住 JSON 里这三个字段。

- [ ] **Step 7: 生成文档**

`render-docs.ts` 的 Bootstrap 一节（fix wave 的 P1-12 新建）补上级联表与
"未指定 `--env` 时行为不变"这句。`.env.example` 头部同样说明。跑 `pnpm run config:docs`
重新生成三个文件并提交。

- [ ] **Step 8: Docker**

- 确认 `.dockerignore` 已是 `.env*`（P2-18），**镜像里不烘任何 `.env*`** —— 一个镜像服务所有环境。
- `Dockerfile` 不写死 `HANDBOOK_ENV`；由 compose / `docker run -e` 传入。
- `docker-compose.yml` 加 `HANDBOOK_ENV: ${HANDBOOK_ENV:-}`，并在注释里写明用
  `docker run --env-file .env.prod` 或 `-e HANDBOOK_ENV=prod` + 挂载。
- README 两份各加一个 `--env` 例子。

- [ ] **Step 9: 验证**

```bash
pnpm run build
printf 'HANDBOOK_LLM_MODEL=from-base\n' > /tmp/hbenv/.env
printf 'HANDBOOK_LLM_MODEL=from-prod\n' > /tmp/hbenv/.env.prod
cd /tmp/hbenv && handbook config --command generate | grep -E 'environment|env files|llmModel'
cd /tmp/hbenv && handbook config --command generate --env prod | grep -E 'environment|llmModel'
```
Expected: 不带 `--env` 时 `from-base`、环境行显示未指定；带 `--env prod` 时 `from-prod`，
且 env files 行按优先级列出两个文件。再跑 `pnpm run check:all`。

- [ ] **Step 10: 提交**

```bash
git add packages/core/src/util/env-file.ts packages/core/src/util/env-file.test.ts \
  packages/core/src/config/file.ts packages/core/src/config/file.test.ts \
  packages/core/src/config/render-docs.ts packages/cli/src/main.ts \
  packages/cli/src/config-command.ts packages/cli/src/config-command.test.ts \
  .env.example docs/configuration.md handbook.config.example.yaml \
  Dockerfile docker-compose.yml README.md README.zh-CN.md
git commit -m "feat(core): load env files and config as a per-environment cascade

--env <name> (or HANDBOOK_ENV) selects .env.<name>.local > .env.<name> >
.env.local > .env, and handbook.config.<name>.yaml ahead of the plain one.
Shell values still win over every file, and a run with no --env loads exactly
what it loaded before, so existing setups are untouched.

handbook config now prints the active environment and every file it loaded, in
precedence order. Eight possible sources is too many to audit by guessing, and
an inspection tool that cannot see a layer is the same failure as a layer that
does not work."
```

## Self-Review

**规格覆盖核对**（规格每节 → 承担它的 Task）：

| 规格节 | Task |
|---|---|
| 1 登记表与四个消费者 | 2（表 + 自检）、6（commander）、4（解析）、10（两个生成器） |
| 2 命名规则、扁平/带前缀注册规则 | 2（`names.ts` + 测试）、4（`envCandidates` 顺序） |
| 3 分层与优先级、`.env` 与配置文件的发现差异、`path` 解析基准 | 4（优先级矩阵）、8（发现与 YAML）、3（`pathBase`） |
| 4 两处不对称（引导层、secret） | 8（`--config` 在 preAction；secret 拒绝）、2（自检断言 secret 无 flag） |
| 5 配置面清单（8 个 LLM flag、6 个孤儿、可取反、logLevel、bool 取值、必填改判） | 5（登记表补全）、6（`--no-llm` 归一化、logLevel 接线）、7（LLM 贯通）、3（bool 解析）、4（必填） |
| 6 `handbook config` | 9 |
| 7 生成物与两个漂移测试 | 10（配置文档漂移）、1（脚本名漂移） |
| 8 scripts | 1 |
| 测试计划 | 各 Task 的 TDD 步骤；Task 11 Step 3/4 是总验收 |
| 风险与约束 | Global Constraints + Task 6 Step 7（覆盖率）+ Task 7（破坏性变更）+ Task 11 Step 1（changeset） |

**空白项扫描**：无 TBD/TODO；每个代码步骤都给了可粘贴的完整代码，唯一给"要求"而非成品的是 Task 10 Step 3 的三个渲染函数 —— 它们的输出格式由同一 Task Step 1 的断言完全约束（每项都在、只有 API key 未注释、优先级链出现、YAML 嵌套且无 secret），属于有验收标准的实现自由度，不是占位符。

**类型一致性**：`Setting` 在 Task 2 定义，Task 5 追加 `dynamicChoices` 时同步改 `types.ts` 与自检断言；`ConfigFileData` 定义在 `resolve.ts`、被 `file.ts` 用作返回类型；`ResolveResult`/`Source` 贯穿 4→9；`coerceValue(setting, raw, where, pathBase)` 四参签名在 3、4 一致；`resolveConfig({command,flags,env,file,cwd})` 在 4、6、7、9 调用形状一致；`llmConfigFromValues` 在 7 定义、被 `main.ts` 与 `resolveLlmEnv` 共用；`keysFor(command)` 在 9 Step 3 补进 `registry.ts` 并被 `config-command.ts` 导入（Step 3 已注明删掉占位实现）。

---

计划完成。执行方式二选一：

**1. Subagent 驱动（推荐）** —— 每个 Task 派一个全新 subagent，Task 之间我来审，迭代快、上下文干净。
**2. 本会话内联执行** —— 用 executing-plans，按批次执行 + 检查点。

Task 1 与 Task 2–11 互不依赖，可以先落 Task 1 拿到即时收益。
