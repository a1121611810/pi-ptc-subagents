# Node 原生测试栈：node:test 是不是 vitest 在 Node 那一侧的角色，代价是什么形状

> wayfinder 研究票 #266 的交付物。日期：2026-10-22。
> 范围：只做**事实取证**，不做选型决定。map #258 / #261 / #264 与任何 ADR 的修改不在本票范围内。
> 体例：中文行文；官方原文以英文引用并附中文注解；每条结论内联来源 URL。
> **本文档区分两类陈述**：「官方说 X」（可回溯到一手来源）与「本仓定了 X」（本仓的既有决定）。

---

## ① 方法

所有取证在 2026-10-22 完成。主来源优先：Node 官方文档的 **markdown 源文件**（`raw.githubusercontent.com/nodejs/node/<branch>/doc/api/*.md`）优先于渲染后的 HTML，因为 HTML 版本体积过大且会被截断；npm registry 与包 tarball 优先于二手博客。

### 1.1 Node 官方一手来源

| URL                                                                         | 确立了什                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| <https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/test.md>       | `node:test` 的完整 API 与稳定性标注（4957 行）。运行器 `Stability: 2 - Stable`（v20.0.0 起）；覆盖率一节为 `Stability: 1 - Experimental`；隔离模型；mock / snapshot / reporter 全量清单 |
| <https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/assert.md>     | `node:assert` 的 API 表面与 strict/legacy 两种模式                                                                                                                                      |
| <https://raw.githubusercontent.com/nodejs/node/v24.x/doc/api/cli.md>        | 全部 `--test*` CLI 开关及其稳定性标注，含 `--test-coverage-lines/branches/functions=threshold`（v22.8.0）                                                                               |
| <https://raw.githubusercontent.com/nodejs/node/main/doc/api/test.md>        | 确认覆盖率在开发主线（v26）**仍是** `Stability: 1 - Experimental`、开关名仍是 `--experimental-test-coverage`                                                                            |
| <https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/test.md>       | 确认 v22.x LTS 的覆盖率同样是 `--experimental-test-coverage` + `Stability: 1 - Experimental`（与 v24 一致）                                                                             |
| <https://raw.githubusercontent.com/nodejs/node/v22.x/doc/api/typescript.md> | v22.x 的类型擦除为 `Stability: 1.2 - Release candidate`（对应本仓 `engines.node >= 22.19.0` 的下沿）                                                                                    |
| <https://nodejs.org/en/learn/test-runner/introduction/>                     | Node 官方对「用哪个 runner」的措辞（见 §⑤）                                                                                                                                             |
| <https://nodejs.org/en/learn/test-runner/collecting-code-coverage/>         | Node 官方覆盖率报告的实际输出形状（文本表格）                                                                                                                                           |

### 1.2 Vitest / Vite+ 一手来源

| URL                                                                                                          | 确立了什                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/expect/src/index.ts>                      | `@vitest/expect` 的**导出清单**——只有 `JestChaiExpect` / `JestExtend` / `JestAsymmetricMatchers` / `getState` / `setState` / `chai` 等积木，**没有 `expect` 函数** |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/expect/src/state.ts>                      | expect 状态的存取机制（`WeakMap<ExpectStatic, MatcherState>`）                                                                                                     |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/vitest/src/integrations/chai/index.ts>    | **`createExpect()` 在 `vitest` 包里，不在 `@vitest/expect` 包里**；`expect.soft` / `.poll` / `.unreachable` / `.assertions` / `.hasAssertions` 全部在此定义        |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/vitest/src/integrations/chai/poll.ts>     | `expect.poll` 依赖 `getWorkerState()`、`vi`、以及一个 `Test` 任务对象；无 runner 时直接 `throw new Error('expect.poll() must be called inside a test')`            |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/vitest/src/integrations/snapshot/chai.ts> | 快照匹配器（`toMatchSnapshot` 等）在 `vitest` 包内，依赖 `@vitest/snapshot` 的 `SnapshotClient` 与 `Test` 任务                                                     |
| <https://raw.githubusercontent.com/vitest-dev/vitest/main/packages/vitest/src/runtime/runners/test.ts>       | `expect.assertions()` / `expect.hasAssertions()` 的**执行点在 runner 的 `onAfterTryTask`**——没有 runner 就没有人检查                                               |
| <https://github.com/vitest-dev/vitest/issues/8721>                                                           | vitest 维护者对「支持 `node:test` API」的**明确拒绝**（见 §③）                                                                                                     |
| <https://vitest.dev/guide/why>                                                                               | vitest 官方定位原文（页面标注 last updated 2026-06-01）                                                                                                            |
| <https://vitest.dev/guide/comparisons>                                                                       | vitest 官方对比页——**对比了 Jest / Cypress / WebdriverIO / Web Test Runner / uvu / Mocha / Playwright，没有 Node 内建测试运行器这一项**                            |
| <https://registry.npmjs.org/@vitest%2Fexpect>                                                                | `@vitest/expect` 4.1.11 与 5.0.5 的依赖与 `exports` 清单                                                                                                           |
| <https://registry.npmjs.org/@vitest/expect/-/expect-5.0.5.tgz>                                               | 5.0.5 的 tarball（只读解包，用于核对 `dist/index.d.ts` 的导出面）                                                                                                  |

### 1.3 其它生态一手来源

| URL                                                                            | 确立了什                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| <https://raw.githubusercontent.com/bcoe/c8/main/README.md>                     | c8 = V8 coverage + Istanbul reporters；`--check-coverage --lines/--functions/--branches`；source map 重映射；`--all` |
| <https://raw.githubusercontent.com/mcollina/borp/main/README.md>               | borp = `node:test` 的 TypeScript 感知包装 + 内建 c8；`borp --coverage --check-coverage --lines 95`                   |
| <https://registry.npmjs.org/expect>                                            | `expect@30.5.2`（Jest 的）的依赖与 `exports`                                                                         |
| <https://raw.githubusercontent.com/jestjs/jest/main/packages/expect/README.md> | Jest `expect` 包的 README 全文（仅一句 + 指向 jestjs.io）                                                            |

### 1.4 本地一手读取与实测

- 本仓：`docs/adr/0009-vitest-adoption.md`、`vitest.config.ts`、`package.json`、`node_modules/vite-plus/README.md`。
- 本仓 git 历史：`git show --stat 373313e`（2026-09-22 的 node:test → Vitest 迁移），以及迁移前的 `tests/dispatcher.test.ts` 原文。
- **实测探针（本次 session 新建，不写入本仓）**：把 `@vitest/expect@5.0.5` 连同其依赖（chai 6.3.0 / `@vitest/spy@5.0.5` / `@vitest/utils@5.0.5` / tinyrainbow 3.2.0 / `@standard-schema/spec@1.1.0`）装进 `/tmp` 的一个隔离 `node_modules`，用 Node v24.22.1 实跑：
  - `probe.mjs`：导出面探测 + 纯断言可用性探测；
  - `probe2.mjs`：`node --test` + `@vitest/expect` 的端到端探测（含一个故意失败的断言）。
- **隔离开销实测**：102 个空测试文件，`node --test` vs `node --test --test-isolation=none`（Node v24.22.1，本机 `os.availableParallelism() = 10`）。
- **本仓补充测量**（issue 已给出的计数**不重测**；以下是新增的、供表格用的维度）：`tests/**/*.test.ts` = 102 个文件 / 51,913 行；`tests/**/*.ts` 全部 = 109 文件 / 53,908 行；hook 用量 `afterEach` 19 / `beforeEach` 4；`vi.fn` 22 / `vi.spyOn` 28；`vi.spyOn` 目标分布 `console` 14 / `globalThis` 4 / 对象方法 9 / `Date` 1；仓库内出现的 matcher 名分布见 §④ 脚注。

---

## ② `node:test` 能力清单（Node 24 / 最新 LTS）

以下每一项的权威出处是 `node:test` 文档（v24.x 分支 markdown 源，HTML 版同内容：<https://nodejs.org/api/test.html>）。

### 2.1 运行器 API —— 稳定

运行器整体：`> Stability: 2 - Stable`（v20.0.0 起 stable，PR <https://github.com/nodejs/node/pull/46983>）。

| 能力              | node:test 对应物                                                                                                              | 稳定性                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `describe` / `it` | `describe()` 是 `suite()` 的别名，`it()` 是 `test()` 的别名                                                                   | Stable（随运行器）                                |
| `test` / `suite`  | `test(name[, options][, fn])`、`suite(name[, options][, fn])`，另有 `.skip` / `.todo` / `.only` 变体                          | Stable                                            |
| 钩子              | `before` / `after` / `beforeEach` / `afterEach`（顶层）＋ `t.before` / `t.beforeEach` / `t.after` / `t.afterEach`（作用域内） | Stable                                            |
| 子测试            | `t.test(name[, options][, fn])`，可嵌套                                                                                       | Stable                                            |
| 跳过 / 待办       | `t.skip(message)` / `t.todo(message)`，或 `{ skip }` / `{ todo }` 选项                                                        | Stable                                            |
| 每个文件独立进程  | 默认 `--test-isolation=process`                                                                                               | Stable                                            |
| 随机化顺序        | `--test-randomize` / `--test-random-seed`                                                                                     | **Stability 1.0 - Early development**（v24.16.0） |
| 全局 setup        | `--test-global-setup=module`                                                                                                  | **Stability 1.0 - Early development**（v24.0.0）  |
| 测试标签          | `--experimental-test-tag-filter`、`context.tags`                                                                              | **Stability 1.0**                                 |
| **watch 模式**    | `node --test --watch`                                                                                                         | **Stability 1 - Experimental**                    |

**`.each` 不存在**：`node:test` 文档全文中 `.each` 出现 **0** 次。`test.each(table)(...)` 这种参数化写法在 node:test 里**没有对应物**。

CLI 开关全表（`node --test`）：

| 开关                                              | 作用                                                                                        | 稳定性               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| `--test-only`                                     | 只跑顶层 `only` 测试                                                                        | Stable               |
| `--test-name-pattern` / `--test-skip-pattern`     | 按名字正则过滤 / 跳过                                                                       | Stable               |
| `--test-concurrency`                              | 并发文件数，默认 `os.availableParallelism() - 1`                                            | Stable               |
| `--test-force-exit`                               | 测试跑完即退出进程（即使事件循环仍活跃）                                                    | Stable               |
| `--test-reporter` / `--test-reporter-destination` | 内建 reporter：`spec`（默认）/ `tap` / `dot` / `junit` / `lcov`；也可传自定义 reporter 路径 | Stable               |
| `--test-isolation=process\|none`                  | 隔离模型                                                                                    | Stable               |
| `--test-timeout`                                  | 单测超时（默认 `Infinity`）                                                                 | Stable               |
| `--test-update-snapshots`                         | 重生成快照文件                                                                              | Stable（自 v23.4.0） |
| `--test-rerun-failures`                           | 只重跑上次失败的用例                                                                        | Stable（v24.7.0）    |
| `--test-shard=<i>/<n>`                            | 分片                                                                                        | Stable               |

### 2.2 断言：`node:assert`，**没有 `expect`**

`node:assert` 整体 `> Stability: 2 - Stable`。

- **Strict 与 legacy 两种模式**：strict 模式下非 strict 方法的行为等同于对应 strict 方法（"In strict assertion mode, non-strict methods behave like their corresponding strict methods."）。入口三选一：`import assert from 'node:assert/strict'`、`import { strict as assert } from 'node:assert'`、`require('node:assert').strict`。strict 模式的对象错误信息带 diff，legacy 模式只打印（且常被截断）的对象。
- API 表面：`assert` / `assert.ok` / `assert.equal` / `assert.notEqual` / `assert.strictEqual` / `assert.notStrictEqual` / `assert.deepEqual` / `assert.notDeepEqual` / `assert.deepStrictEqual` / `assert.notDeepStrictEqual` / `assert.partialDeepStrictEqual`（v23.4.0, v22.13.0）/ `assert.match` / `assert.doesNotMatch` / `assert.throws` / `assert.doesNotThrow` / `assert.rejects` / `assert.doesNotReject` / `assert.fail` / `assert.ifError`；另有 `class assert.AssertionError`、`class assert.Assert`、`class assert.CallTracker`、`assert.register(name, fn)`。
- **确认没有 `expect`**：`node:test` 文档全文中 `expect(` 出现 **0** 次；`node:assert` 文档中 `\bexpect\b` 出现 **0** 次。Node 官方在 `node:test` 里提供的断言入口只有两个：全局 `assert` 与测试上下文上的 `t.assert`。

### 2.3 Mocking

顶层 `mock` 对象（`import { mock } from 'node:test'`），以及每个测试上下文上的 `t.mock`（用 `t.mock` 的好处是"the test runner will automatically restore all mocked functionality once the test finishes"）。

| vitest                 | node:test                                                                                                              | 稳定性                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `vi.fn()`              | `mock.fn([original[, implementation]][, options])`                                                                     | Stable（v19.1.0）                                                                                                                      |
| `vi.spyOn(obj, 'm')`   | `mock.method(object, methodName[, implementation][, options])`（另有 `mock.getter` / `mock.setter` / `mock.property`） | Stable（v19.1.0）                                                                                                                      |
| `vi.mock('spec')`      | `mock.module(specifier[, options])`                                                                                    | **Stability 1.0 - Early development**（v22.3.0），且**必须**加 CLI 开关 `--experimental-test-module-mocks`（该开关本身 Stability 1.0） |
| `vi.restoreAllMocks()` | `mock.restoreAll()` / `mock.reset()`                                                                                   | Stable                                                                                                                                 |
| `vi.useFakeTimers()`   | `mock.timers.enable({ apis, now })`；`mock.timers.tick(ms)` / `.runAll()` / `.setTime(ms)` / `.reset()`                | MockTimers **Stable**（v23.1.0）                                                                                                       |

要点：

- `mock.timers.enable()` 的默认 `apis` 是 `['setInterval', 'setTimeout', 'setImmediate', 'Date']`，即**默认全假**，与 `vi.useFakeTimers()` 的默认行为一致；`{ apis: ['setTimeout'] }` 这类收窄写法与 vitest 的 `{ toFake: [...] }` 对位。
- `mock.method` 的 options 支持 `times`（调用 N 次后自动还原）、`getter` / `setter`；**不支持** vitest 的 `mockRejectedValueOnce` / `mockResolvedValueOnce` 这类 sugar——要写成 `mockImplementationOnce(async () => { throw new Error(...) })`。
- node 的 `mock.module` 文档明确写道："Any references to the original module prior to mocking are not impacted."，且同步 loader hook 才会生效、异步 loader hook "are currently ignored"。这是与 vitest `vi.mock` 语义上的实质差异。

### 2.4 快照：`t.assert.snapshot()` —— 稳定，但形状与 vitest 不同

- 稳定性：**v22.3.0 加入，v23.4.0 起不再是 experimental**（PR <https://github.com/nodejs/node/pull/55897>）。
- API：`t.assert.snapshot(value[, options])` 与 `t.assert.fileSnapshot(value, path[, options])`；另有模块级 `snapshot.setDefaultSnapshotSerializers(serializers)` 与 `snapshot.setResolveSnapshotPath(fn)`。
- 文件位置：默认与测试文件同名 + `.snapshot` 后缀（"the snapshot file has the same name as the test file with a `.snapshot` file extension"），可用 `snapshot.setResolveSnapshotPath()` 改。
- 文件格式：一个 **ESM 模块**，每条快照是一个具名导出：
  ```js
  exports[`suite of snapshot tests > snapshot test 1`] = `
  {
    "value1": 1,
    "value2": 2
  }
  `;
  ```
  即 key = 「完整测试名 > 计数器」，value = 序列化后的文本。
- 生成方式：用 `--test-update-snapshots` 跑一次生成；首次运行（无快照文件）会失败。
- 限制：默认序列化是 `JSON.stringify(value, null, 2)`——"JSON.stringify() does have limitations regarding circular structures and supported data types. If a more robust serialization mechanism is required, this function should be used."（指 `setDefaultSnapshotSerializers`）。
- 与 vitest 的差别：vitest 的 `toMatchSnapshot()` 是 **matcher**（`expect(x).toMatchSnapshot()`），node 的是 **上下文方法**（`t.assert.snapshot(x)`），且 node 没有 inline snapshot。

### 2.5 覆盖率：`--experimental-test-coverage`（**实验性**）vs `c8`

**这是本节最重要的一条纠正**：Node 24 的覆盖率**不是**稳定特性，开关名也不是 `--test-coverage`。

| 事实                                                                                                                                                                                                                                  | 出处                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `## Collecting code coverage` 段落标题下写的是 `> Stability: 1 - Experimental`                                                                                                                                                        | v24.x `doc/api/test.md` §Collecting code coverage；v22.x 同；**main 分支同** |
| 开关名是 `--experimental-test-coverage`（v19.7.0 加入），**没有** `--test-coverage` 这个开关                                                                                                                                          | v24.x `doc/api/cli.md`                                                       |
| 阈值开关是 `--test-coverage-lines=threshold` / `--test-coverage-branches=threshold` / `--test-coverage-functions=threshold`（均 v22.8.0），三者标注 `> Stability: 1 - Experimental`；未达阈值则 "the process will exit with code `1`" | v24.x `doc/api/cli.md`                                                       |
| include/exclude 是 glob，可多次指定；两者同时给出时必须**同时**满足                                                                                                                                                                   | v24.x `doc/api/cli.md`                                                       |
| 输出形状：`tap` 与 `spec` reporter 打印一段**文本表格**（`file                                                                                                                                                                        | line %                                                                       | branch % | funcs % | uncovered lines`）；另有 `lcov` reporter 生成 lcov 文件 | v24.x `doc/api/test.md` §Coverage reporters；Node Learn 页 <https://nodejs.org/en/learn/test-runner/collecting-code-coverage/> 展示了同一张表 |
| 行级忽略：`/* node:coverage disable */` / `/* node:coverage ignore next 3 */`                                                                                                                                                         | v24.x `doc/api/test.md`                                                      |

**与 `c8` 的对比**（c8 的事实来自其 README，<https://raw.githubusercontent.com/bcoe/c8/main/README.md>）：

| 维度                 | Node 内建 `--experimental-test-coverage`              | `c8`                                                  | 本仓现状 `@vitest/coverage-v8`            |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| 引擎                 | V8（Node 内建）                                       | V8（`NODE_V8_COVERAGE`）                              | V8                                        |
| 报告器               | 文本表 + `lcov`                                       | **Istanbul reporters**（lcov / html / text / json …） | Istanbul 系（`@vitest/coverage-v8` 同源） |
| 阈值                 | `--test-coverage-lines/branches/functions=`（实验性） | `c8 check-coverage --lines --functions --branches`    | `coverage.thresholds`（config 内声明）    |
| source map           | 未在文档中承诺                                        | 明确支持（含 `--exclude-after-remap`）                | 支持                                      |
| 未被 import 的源文件 | 默认不计入（需 `--test-coverage-include`）            | `--all` 可强制计入                                    | `coverage.include` + `--all` 语义         |
| 稳定性               | **Experimental**                                      | 稳定（社区事实标准）                                  | 稳定                                      |

**结论（形状层）**：如果目标是「产出形状最接近当前 `@vitest/coverage-v8` + `coverage.thresholds` 的东西」，最接近的是 **`c8`**（同为 V8 引擎 + Istanbul reporter + 独立的阈值检查），**不是** Node 内建的 `--experimental-test-coverage`——后者的报告面是文本表 + lcov，阈值开关是实验性的 CLI flag 而非 config。

### 2.6 隔离模型

官方原文（v24.x `doc/api/test.md` §Test runner execution model）：

> "When process-level test isolation is enabled, each matching test file is executed in a separate child process. The maximum number of child processes running at any time is controlled by the `--test-concurrency` flag."

> "When process-level test isolation is disabled, each matching test file is imported into the test runner process. Once all test files have been loaded, the top level tests are executed with a concurrency of one."

- 默认 `--test-isolation=process`；`--test-isolation=none` 是单进程模式（此时并发被强制为 1）。
- 并发默认 `os.availableParallelism() - 1`；本机 `availableParallelism() = 10` ⇒ 默认 9 个并发子进程。
- 子进程会继承父进程的 Node 选项与配置文件，但 `--test` / `--watch` / `--test-reporter` / `--experimental-test-coverage` 等由父进程统一管理。

**对 102 个文件的实测后果**（Node v24.22.1，102 个空测试文件，只测固定开销）：

| 模式                                | wall clock | 报告 duration | user CPU |
| ----------------------------------- | ---------- | ------------- | -------- |
| `node --test`（默认 process 隔离）  | **0.73 s** | 690.9 ms      | 3.97 s   |
| `node --test --test-isolation=none` | **0.05 s** | 23.0 ms       | 0.05 s   |

即：**每文件一进程对 102 个文件带来约 670 ms 固定 wall-clock 开销与约 4 s CPU 开销**。这是纯启动成本；本仓真实用例做的工作远多于空测试，所以相对占比会小得多——但它是**线性于文件数**的固定项，而 `tests/` 还会继续长。

**与 vitest 的对比**：vitest 5.0.5 的默认 `pool` 是 `"forks"`、`isolate` 默认 `true`（`node_modules/vitest/dist/chunks/index.1TqnEahn.js:8802` 的 `resolved.pool ??= "forks"`，与 `dist/chunks/defaults.B1FCaFfh.js:52` 的 `isolate: true`）。**即 vitest 的默认隔离模型与 `node --test` 默认是同一种（每文件一子进程）**，这条不构成迁移的额外成本。

### 2.7 TypeScript 执行

- `node --test` 默认匹配 `**/*.test.{cts,mts,ts}` 等模式（"Unless `--no-strip-types` is supplied, the following additional patterns are also matched"）。
- Node 24 默认开启类型擦除；Node 22.x 侧 `doc/api/typescript.md` 标注 `> Stability: 1.2 - Release candidate`。本仓 `engines.node >= 22.19.0` 的下沿落在 RC 级别的特性上。
- 本仓测试用 `from "../src/runtime/bindings.ts"` 这种**带 `.ts` 扩展名**的相对导入，Node 的类型擦除支持这种写法（`--experimental-strip-types` 的已知约束之一即是需要显式扩展名）。
- `borp` 正是把这条做成产品："Borp uses Node.js native type stripping to run TypeScript files directly without compilation. No build step required!"（<https://raw.githubusercontent.com/mcollina/borp/main/README.md>）

### 2.8 Node 官方对「库作者该怎么测」的指引

**找到的全部官方措辞**（<https://nodejs.org/en/learn/test-runner/introduction/>）：

> "There are many test runners available for Node.js, but we will focus on the built-in test runner that comes with Node.js. It's cool because you don't need to install any additional dependencies to use it."

> "To run tests with Node.js, we recommend reading the test runner documentation."

**诚实的读法**：这是 Node Learn 教程对**自己内建运行器**的介绍，"we recommend reading the test runner documentation" 指的是「读 Node 的测试运行器文档」，处在「介绍内建运行器」的教程语境里。**Node 官方没有**任何一句规范性表述说「npm 库作者应该用 node:test」，**也没有**任何一句说「应该用 vitest」。两边都没有背书——这一条属于 §⑥ 未能取证。

---

## ③ 决定性验证：`expect` 能不能脱离 vitest runner 单独用？

### 3.1 结论先行

**`@vitest/expect` 不导出 `expect` 函数。** 它只导出积木。官方 README 给的用法就是「用 chai 装插件」：

> ```js
> import { JestAsymmetricMatchers, JestChaiExpect, JestExtend } from "@vitest/expect";
> import * as chai from "chai";
> chai.use(JestExtend); // allows using expect.extend instead of chai.use to extend plugins
> chai.use(JestChaiExpect); // adds all jest matchers to expect
> chai.use(JestAsymmetricMatchers); // adds asymmetric matchers like stringContaining, objectContaining
> ```

**实测**（Node v24.22.1 + `@vitest/expect@5.0.5` + chai 6.3.0，隔离 `node_modules`）：

```
=== 1. exported names from @vitest/expect ===
ASYMMETRIC_MATCHERS_OBJECT, Any, Anything, ArrayContaining, AsymmetricMatcher, ChaiStyleAssertions, GLOBAL_EXPECT, JEST_MATCHERS_OBJECT, JestAsymmetricMatchers, JestChaiExpect, JestExtend, MATCHERS_OBJECT, ObjectContaining, SchemaMatching, StringContaining, StringMatching, addCustomEqualityTesters, arrayBufferEquality, chai, createAssertionMessage, customMatchers, equals, fnNameFor, generateToBeMessage, getCustomEqualityTesters, getObjectKeys, getObjectSubset, getState, hasAsymmetric, hasProperty, isA, isAsymmetric, isError, isImmutableUnorderedKeyed, isImmutableUnorderedSet, isStandardSchema, iterableEquality, pluralize, recordAsyncExpect, setState, sparseArrayEquality, subsetEquality, typeEquality, wrapAssertion
has an `expect` export? false
```

装上三个插件之后 `chai.expect` 确实拿到了 jest 风格匹配器，实测全部通过：

```
expect(1).toBe(1)                              OK
expect({a:1}).toEqual({a:1})                   OK
expect([1,2]).toContain(2)                     OK
expect('abc').toMatch(/b/)                     OK
expect(()=>{throw new Error('x')}).toThrow()   OK
expect(1).toEqual(expect.any(Number))          OK
expect({a:1,b:2}).toEqual(expect.objectContaining({a:1}))  OK
await expect(Promise.resolve(1)).resolves.toBe(1)          OK
await expect(Promise.reject(e)).rejects.toThrow('x')       OK
expect(spy).toHaveBeenCalled() / toHaveBeenCalledTimes / toHaveBeenCalledWith / toHaveReturnedWith   OK
失败时：threw: AssertionError / "expected 1 to be 2 // Object.is equality"
```

**端到端**：同一套装配放进 `node --test`，故意失败的断言确实让 node:test 判红、进程退出码 1：

```
✖ failing expect under node:test (0.731417ms)
  Error [AssertionError]: expected 1 to be 2 // Object.is equality
ℹ tests 2  ℹ pass 1  ℹ fail 1
=== EXIT: 1 ===
```

### 3.2 逐特性裁决

**判据**：`expect.soft` / `.poll` / `.unreachable` / `.assertions` / `.hasAssertions` 这些方法**全部由 `createExpect()` 定义**，而 `createExpect()` 位于 **vitest 包内**（`packages/vitest/src/integrations/chai/index.ts`），**不在 `@vitest/expect` 包内**。`@vitest/expect` 只提供 `getState` / `setState` / `chai` / 三个插件这些积木。

| 特性                                                                                                                                                                                                                                                                                                             | 裁决                                                | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toBe` / `toEqual` / `toStrictEqual` / `toContain` / `toMatch` / `toMatchObject` / `toHaveLength` / `toBeTruthy` / `toBeFalsy` / `toBeUndefined` / `toBeDefined` / `toBeNull` / `toBeNaN` / `toBeInstanceOf` / `toHaveProperty` / `toBeGreaterThan(OrEqual)` / `toBeLessThan(OrEqual)` / `toBeCloseTo` / `not.*` | **可用**，但**必须手工装配**（`chai.use` 三个插件） | 实测全部通过（§3.1）                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `expect.any` / `objectContaining` / `arrayContaining` / `stringContaining` / `stringMatching`                                                                                                                                                                                                                    | **可用**（同上）                                    | 实测通过                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `resolves` / `rejects`                                                                                                                                                                                                                                                                                           | **可用**                                            | 实测通过                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `toHaveBeenCalled` / `toHaveBeenCalledTimes` / `toHaveBeenCalledWith` / `toHaveBeenLastCalledWith` / `toHaveReturnedWith`                                                                                                                                                                                        | **可用**，但需另装 `@vitest/spy`                    | 实测通过；`@vitest/expect` 的依赖里就有 `@vitest/spy`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expect.extend`                                                                                                                                                                                                                                                                                                  | **可用**                                            | 实测 `typeof === 'function'`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `expect.getState` / `expect.setState`                                                                                                                                                                                                                                                                            | **不可用**（`chai.expect` 上没有）                  | 实测 `undefined`；`@vitest/expect` 导出的 `getState/setState` 需要你自己造一个 `ExpectStatic` 才能用                                                                                                                                                                                                                                                                                                                                                           |
| `expect.soft`                                                                                                                                                                                                                                                                                                    | **不可用**（且无法简单补）                          | 定义在 vitest 包的 `createExpect()`；其语义是「软失败收集」——失败要被 runner 收集到测试末尾统一抛，runner 不在就没有收集者。chai 6 确实有 `withContext`（实测 `typeof === 'function'`），所以「标记软失败」这一步能手工做，但「收集与汇总」这一步得自己实现                                                                                                                                                                                                    |
| `expect.unreachable`                                                                                                                                                                                                                                                                                             | **不可用**（但一行可补）                            | 定义在 `createExpect()`；其实现只有 `chai.assert.fail(...)`，脱离 runner 也能等价实现                                                                                                                                                                                                                                                                                                                                                                          |
| `expect.poll`                                                                                                                                                                                                                                                                                                    | **不可用**，且**无法脱离 vitest 补齐**              | `createExpectPoll()` 依赖 `getWorkerState()`（读 vitest 的 worker 配置）、`vi.isFakeTimers()` / `vi.advanceTimersByTime()`（vitest 的 fake timer）、以及一个 `Test` 任务对象；没有 runner 时它直接 `throw new Error('expect.poll() must be called inside a test')`                                                                                                                                                                                             |
| `expect.assertions(n)`                                                                                                                                                                                                                                                                                           | **不可用**，且**手工补会变成静默失效**              | 它只是往 expect 状态里写 `expectedAssertionsNumber`；真正执行检查的是 vitest runner 的 `onAfterTryTask`（`packages/vitest/src/runtime/runners/test.ts`）：`if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber) throw expectedAssertionsNumberErrorGen!()`。没有 runner ⇒ 写进去的状态没人读 ⇒ 断言数量检查**静默不生效**                                                                                                     |
| `expect.hasAssertions()`                                                                                                                                                                                                                                                                                         | 同上                                                | 同上（`isExpectingAssertions` 同样由 `onAfterTryTask` 检查）                                                                                                                                                                                                                                                                                                                                                                                                   |
| `toMatchSnapshot()` / `toMatchInlineSnapshot()`                                                                                                                                                                                                                                                                  | **不在 `@vitest/expect` 里**                        | `packages/expect/src/` 下 **12 个源文件对 "snapshot"（忽略大小写）的命中数全为 0**（唯一 1 次命中是 `utils.ts:110` 的一句**代码注释**："// avoid WebKit's proper tail call to preserve stacktrace offset for inline snapshot"，不是实现）。快照匹配器在 `packages/vitest/src/integrations/snapshot/chai.ts`，依赖 `@vitest/snapshot` 的 `SnapshotClient` 与 `Test` 任务。实测：`expect({}).toMatchSnapshot` 抛 `Error: Invalid Chai property: toMatchSnapshot` |

**「静默失效」这一条值得单独强调**：`expect.assertions` / `expect.hasAssertions` 与普通断言不同——普通断言失败会抛异常、node:test 会判红；这两个是**断言计数的契约**，一旦脱离 runner 就不再有人核对，测试会「看起来通过」。

### 3.3 这是不是一条**有文档的**路径？

**不是。** 逐条检索结果：

1. `@vitest/expect` 的 README 只讲 chai 插件用法，**没有**提到 `node:test`（该 README 仅 699 字节 / 5.0.5 版同）。
2. vitest 官方文档站（`vitest.dev`）**没有**任何页面把 `@vitest/expect` 与 `node:test` 组合起来。`vitest.dev/guide/comparisons` 对比了 Jest / Cypress / WebdriverIO / Web Test Runner / uvu / Mocha / Playwright——**没有 Node 内建测试运行器这一项**。
3. vitest 仓库代码里 `node:test` 只出现在模块 mock 的 `node:` 内建模块处理与自己的 node-runner 测试中，**没有**任何「用 `@vitest/expect` 跑 node:test」的代码路径。
4. **最直接的一条**：vitest issue [#8721 "Support test API from \"node:test\""](https://github.com/vitest-dev/vitest/issues/8721)（已关闭），维护者 sheremet-va 的回复：

   > "I don't see any benefit for Vitest to have this as a feature. Vitest test runner is not compatible with node and we would have to re-implement it ourselves to support Vitest features which is an enormous maintenance burden for zero gain. When node updates its API, we would also have to update it. We want people to use our API when running tests because we believe it is a good API."

   议题以 "Do nothing." 关闭。

   注意该议题问的是**反方向**（让 vitest 跑 node:test 的 API），不是「用 `@vitest/expect` 跑 node:test」；但它确立了维护者对「Node 的 API 与 Vitest 的 API 是两套、互不兼容」的官方立场。

**所以「node:test + `@vitest/expect`」若要成立，需要手工装配的东西是**：

1. 一个自建的 `expect` 模块（本仓新增一个 `tests/helpers/expect.ts` 之类）：`chai.use(JestExtend); chai.use(JestChaiExpect); chai.use(JestAsymmetricMatchers); export const expect = chai.expect`。
   - 副作用注意：`chai.use` 是**进程级**的，对该进程内所有 chai 使用者生效；node:test 的每文件独立进程模型让这件事局限在单文件内。
   - 类型：`chai.expect` 的类型不是 vitest 的 `ExpectStatic`，`expect.soft` 等在类型层面就不存在，`expect.extend` 的自定义 matcher 类型也不会自动带上——`tsc --noEmit` 会是真实成本。
2. `expect.soft` / `.unreachable` / `.assertions` / `.hasAssertions` 的等价物（本仓计数全为 0 ⇒ **可以不补**；但一旦将来要用，就得自建「软失败收集」机制）。
3. `toMatchSnapshot`（本仓实际调用点 **0** ⇒ 可以不补；node 侧若要快照，用 `t.assert.snapshot()`，但那是**上下文方法**不是 matcher，形状不同）。
4. `expect.poll`（本仓实际调用点 **0** ⇒ 可以不补；且**补不出来**）。
5. 显式 import 改造：`from "vitest"` → `from "node:test"` + `from "<自建 expect 模块>"`（本仓 ADR-0009 定的「显式 import、不开 globals」风格意味着**每个测试文件都要改 import 行**）。
6. `vi.*` 的等价物：`vi.fn` → `mock.fn`；`vi.spyOn` → `mock.method`（`.mockRejectedValueOnce` → `.mock.mockImplementationOnce(async () => { throw ... })`）；`vi.useFakeTimers` → `mock.timers.enable`（默认全假，对位 `vi.useFakeTimers()` 的无参写法；`{ toFake: ["setTimeout","clearTimeout"] }` → `{ apis: ["setTimeout"] }`）；`vi.mock` → `mock.module`（**且必须加 `--experimental-test-module-mocks`**，否则整个特性不可用）。
7. `test.each`（6 处）→ node:test **无 `.each`**，须手写循环。
8. `describe` / `it` / `test`（2089 处）→ **只改 import**，node:test 三个名字都导出且语义一致。

### 3.4 另两个 `expect` 候选

| 候选                           | 事实                                                                                                                                                                                                                                                                                                                                    | 与 node:test 的关系                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **chai 自带的 `expect`**       | chai 的 `expect` 是**另一套 API**（BDD 风格 `expect(x).to.equal(y)`），不是 jest 风格                                                                                                                                                                                                                                                   | 与本仓 5063 处 jest 风格断言**不同形**，迁移量与 (a) 方案同量级                                                                                                                                                             |
| **`expect@30.5.2`（Jest 的）** | npm description: "This package exports the `expect` function used in Jest."——**它确实直接导出 `expect` 函数**（这是与 `@vitest/expect` 的关键差别）。依赖：`jest-mock` / `jest-util` / `@jest/get-type` / `jest-message-util` / `@jest/expect-utils` / `jest-matcher-utils`。README 全文只有一句 + 指向 <https://jestjs.io/docs/expect> | **没有找到任何**官方记录的「`expect@30` + `node:test`」用法。其依赖是 jest 内部件（`jest-mock` 等），与 `@vitest/expect` 的依赖面（chai + @vitest/spy + @vitest/utils + tinyrainbow + @standard-schema/spec）是两套不同生态 |

---

## ④ 迁移代价表

### 4.1 逐 API 类

计数沿用 issue #266 已实测的数字（**不重测**）；「node 原生等价物」一列的每个能力都对应 §② 里的一手出处。

| API 类                                       | 计数                                                    | Node 原生等价物                                                                     | 形状变化                                                                                                                                                                                                                                                     | 备注                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expect(...)` 断言                           | **5063**                                                | `node:assert`（strict 模式）**或** 手工装配的 `@vitest/expect`                      | (a) **每处都要改写**：`expect(x).toBe(y)` → `assert.strictEqual(y, x)`（注意**参数顺序相反**，node 是 `(actual, expected)`），`expect(x).toEqual(y)` → `assert.deepStrictEqual(x, y)`；(b) **文本不变**，只改 import                                         | (a) 是全量重写；(b) 是 0 行断言改动。`not.toBe` → `assert.notStrictEqual`；`toBeUndefined` → `assert.strictEqual(x, undefined)`；`toBeTruthy` → `assert.ok(x)`；`toThrow` → `assert.throws(fn)`；`rejects.toThrow` → `assert.rejects(promise)` |
| `vi.fn`                                      | 22                                                      | `mock.fn()`                                                                         | 近似：`vi.fn(impl)` → `mock.fn(impl)`；调用记录从 `fn.mock.calls` → `fn.mock.calls`（形状一致）                                                                                                                                                              | §2.3                                                                                                                                                                                                                                           |
| `vi.spyOn`                                   | 28                                                      | `mock.method(obj, 'm')`                                                             | **有差异**：vitest 的 `.mockRejectedValueOnce` / `.mockResolvedValueOnce` 在 node 侧不存在，要改成 `.mock.mockImplementationOnce(async () => { throw ... })`；node 的 `mock.method` 返回 Proxy，spy 句柄挂在 `obj.m.mock` 上而非返回值上                     | 目标分布：`console` 14 / `globalThis` 4 / 对象方法 9 / `Date` 1                                                                                                                                                                                |
| `vi.useFakeTimers`                           | 28                                                      | `mock.timers.enable({ apis })`                                                      | 近似：默认 `apis` 全假（对位无参 `vi.useFakeTimers()`）；`{ toFake: ["setTimeout","clearTimeout"] }` → `{ apis: ["setTimeout"] }`（node 会隐式带上 clear）。配套的 `vi.advanceTimersByTime` → `mock.timers.tick`；`vi.useRealTimers` → `mock.timers.reset()` | MockTimers 自 v23.1.0 stable                                                                                                                                                                                                                   |
| `vi.mock`                                    | 5                                                       | `mock.module(specifier)`                                                            | **有实质差异**：必须加 CLI 开关 `--experimental-test-module-mocks`（Stability 1.0）；node 侧「mocking 之前拿到的原模块引用不受影响」；同步/异步 loader hook 语义不同                                                                                         | 5 处全部是 `vi.mock("node:child_process"/"node:fs"/相对路径, async (importOriginal) => ...)` 形状 ⇒ 需重写为 `mock.module(...)` 的 `exports`/`namedExports` 形状                                                                               |
| `describe` / `it` / `test`                   | **2089**                                                | `describe` / `it` / `test`（node:test 三个都导出，`describe`≡`suite`、`it`≡`test`） | **只改 import**，语义一致                                                                                                                                                                                                                                    | 最大的调用面，但零逻辑改写                                                                                                                                                                                                                     |
| 钩子 `beforeEach` / `afterEach`              | 4 / 19                                                  | `beforeEach` / `afterEach`                                                          | 形状一致；node 侧 hook 签名多一个 `t` 参数                                                                                                                                                                                                                   |                                                                                                                                                                                                                                                |
| `test.each` / `describe.each`                | 6                                                       | **无等价物**                                                                        | **须手写循环**：`for (const c of CASES) test(name(c), () => …)`                                                                                                                                                                                              | node:test 文档中 `.each` 出现 0 次                                                                                                                                                                                                             |
| `expect.poll` / 快照                         | 1（**实为注释，见下**）                                 | `t.assert.snapshot()`（上下文方法，非 matcher）                                     | 若真要用，形状完全不同（`expect(x).toMatchSnapshot()` → `t.assert.snapshot(x)`）                                                                                                                                                                             | **本次 session 更正**：issue 记的「1」是 `tests/unit/task-storage.test.ts:7` 的一段**注释**（"we do not use `toMatchSnapshot`"）。实际调用点 **0**（`toMatchSnapshot(` / `toMatchInlineSnapshot(` / `expect.poll(` 的 grep 命中数 = 0）        |
| `expect.soft`                                | 0                                                       | 无（可手补但需自建软失败收集）                                                      | **无迁移成本**                                                                                                                                                                                                                                               |                                                                                                                                                                                                                                                |
| `expect.unreachable`                         | 0                                                       | 无（一行可补：`chai.assert.fail`）                                                  | **无迁移成本**                                                                                                                                                                                                                                               |                                                                                                                                                                                                                                                |
| `expect.assertions` / `expect.hasAssertions` | 0                                                       | `t.plan(count)`（不同语义：node 的 plan 数的是断言+子测试）                         | **无迁移成本**；但若将来用，须注意 node 的 `t.plan` 要求「assertions must be tracked, `t.assert` must be used instead of `assert` directly」                                                                                                                 |                                                                                                                                                                                                                                                |
| `test.skip` / `test.todo` / `test.only`      | 0                                                       | `t.skip()` / `t.todo()` / `only` 选项                                               | **无迁移成本**                                                                                                                                                                                                                                               | 本次 session grep 复核：命中数 0                                                                                                                                                                                                               |
| `expect.extend` 自定义 matcher               | 0（本次 session 未见调用）                              | `chai.use` 插件                                                                     | 无                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                                                |
| `resolves` / `rejects`                       | 用到 `rejects.toThrow`（`tests/web-ds-search.test.ts`） | `assert.rejects(promise, matcher)`                                                  | (a) 需改写；(b) `@vitest/expect` 装配后**原样可用**                                                                                                                                                                                                          | `resolves` 本仓未用                                                                                                                                                                                                                            |

### 4.2 配置面与 CI/脚本面

| 面                                                                                 | 现状                       | node 原生侧对应物                                                                                                                                                                                                                         | 形状变化                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `vitest.config.ts` 的 `test.include: ["tests/**/*.test.ts"]`                       | —                          | `node --test "tests/**/*.test.ts"`（glob 参数）或 `borp 'test/**/*.test.ts'`                                                                                                                                                              | 简单：glob → 命令行参数                                                                    |
| `test.environment: "node"`                                                         | —                          | **无对应物，也不需要**（node:test 本来就跑在 node 里）                                                                                                                                                                                    | 删掉一行                                                                                   |
| `test.coverage.provider: "v8"`                                                     | —                          | `c8`（同为 V8 引擎）或 Node 内建 `--experimental-test-coverage`                                                                                                                                                                           | c8 是外挂进程；内建是实验性                                                                |
| `test.coverage.include: ["src/**/*.ts"]` / `exclude: [...]`                        | —                          | c8 的 `--include` / `--exclude`（glob）；内建的 `--test-coverage-include` / `--test-coverage-exclude`                                                                                                                                     | 都是 glob，但 c8 的默认 exclude 语义与 vitest 不同                                         |
| `test.coverage.thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 }` | 全 0（即「只报告不拦截」） | c8：`c8 check-coverage --lines N --functions N --branches N`（**statements 没有独立阈值**，c8 的 `--check-coverage` 只覆盖 lines/functions/branches）；内建：`--test-coverage-lines/branches/functions=`（实验性，**也没有 statements**） | **两侧都没有 vitest 那个四元组 thresholds**；当前值全 0 ⇒ 实际不拦截，迁移时可直接删掉这行 |
| `package.json#scripts.test` = `pnpm exec vp test --run --coverage`                 | —                          | `node --test --experimental-test-coverage` / `borp --coverage` / `c8 node --test`                                                                                                                                                         | 变短                                                                                       |
| `test:watch` = `pnpm exec vp test`                                                 | —                          | `node --test --watch`                                                                                                                                                                                                                     | **node 的 watch 模式是 Experimental**；vitest 的 watch 是稳定的默认行为                    |
| `test:ui` = `pnpm exec vp test --ui`                                               | —                          | **无对应物**                                                                                                                                                                                                                              | node:test 没有 UI 模式                                                                     |
| `prepublishOnly` 的 `npm run test`                                                 | —                          | 同上                                                                                                                                                                                                                                      | 不变（仍是一条命令）                                                                       |
| CI（`.github/workflows/`）跑 `pnpm test`                                           | —                          | 若换 runner，需改命令；若用 borp，还需确认 Node 版本（borp 要求 `Node.js >= 22.6.0`，推荐 `22.19.0+ or 24.x+`）                                                                                                                           |                                                                                            |
| `verify:dist`（`scripts/verify-dist-render.mjs`）                                  | 与 runner 无关             | —                                                                                                                                                                                                                                         | 不受影响                                                                                   |

### 4.3 头条：三种形状各自要重写多少

**先给一个本仓自己的、可回溯的先例**（这是本节最有价值的锚点）：

> 本仓 **已经做过一次** 这次讨论的反方向迁移。commit `373313e`（2026-09-22，PR #28）标题即 "test: migrate 9 test files from node:test to Vitest API"。迁移前 `tests/dispatcher.test.ts` 的头是：
>
> ```ts
> import assert from "node:assert/strict";
> import { test } from "node:test";
> ```
>
> 迁移后是 `import { describe, it, expect } from 'vitest'`，断言从 `assert.deepEqual(outcome, {…})` 改成 `expect(outcome).toEqual({…})`，`assert.equal(x, undefined)` 改成 `expect(x).toBeUndefined()`。
> **该 commit 的 diffstat：9 个测试文件 + `package.json` + `pnpm-lock.yaml`，共 939 insertions / 712 deletions = 1651 行 diff。**

也就是说：当年 9 文件 / 1,732 LOC 的 `node:assert` → `expect` 迁移，**改了 1651 行**，约为原 LOC 的 0.95 倍——**几乎每一行断言都被重写**。

今天 `tests/**/*.test.ts` 是 102 文件 / 51,913 LOC。按同样的每 LOC 比例外推 ⇒ **约 4.9 万行 diff**；按每文件比例外推（102/9）⇒ **约 1.9 万行 diff**。真实值落在这两者之间（文件变大了，但每文件的辅助代码比例也更高）。**这是外推，不是实测**——要拿到实测值必须真的迁移一次。

| 形状                                                     | 断言层改动                                                                                                             | 其余改动                                                                                                                                                                                                                          | 头条                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) `node:test` + `node:assert` + `c8`（koa 形状）**   | **5063 处全部改写**（还要**翻转参数顺序**：`assert.strictEqual(actual, expected)` vs `expect(actual).toBe(expected)`） | 2089 处 `describe/it/test` 只改 import；`vi.fn`/`spyOn` 50 处改写；`useFakeTimers` 28 处改写；`vi.mock` 5 处改写并**新增一个实验性 CLI 开关**；`test.each` 6 处手写循环；`rejects.toThrow` 改写                                   | **全量重写**。按本仓自己的先例外推：**约 2 万～5 万行 diff**，触及 102 个文件的每一个断言行。外加：丢掉 `test:ui`、丢掉稳定 watch、覆盖率阈值从 config 移到 CLI（且两侧都少一个 statements 维度）                                                                                                                                                                                                                                                                                                                                |
| **(b) `borp` + `@vitest/expect` + `c8`（保留断言形状）** | **0 行**（前提是手工装配出一个 `expect`）                                                                              | 102 个文件的 import 行要改（`from "vitest"` → `from "node:test"` + 自建 expect 模块）；50 处 `vi.*` 改写；28 处 fake timers 改写；5 处 `vi.mock` 改写 + 加实验性开关；6 处 `.each` 手写循环；`vitest.config.ts` 删掉换成 CLI 参数 | **断言层省下 5063 处改写**，代价是：① 引入一条**官方无文档**的组合路径（§③.3）；② 要自建一个 `expect` 包装模块并自己承担它的类型；③ 丢掉 `test:ui`；④ 丢掉稳定 watch；⑤ **`@vitest/expect@5.0.5` 与 vitest 5.0.5 不是同一个运行时对象**——vitest 5.0.5 的 `package.json` 里 `@vitest/expect` 只出现在 **`devDependencies`**（构建期），运行时依赖与 peerDependencies 里都没有它（vitest 5 把 expect 的实现**打包进自己的 dist**）。要单独用它就得新增 `@vitest/expect` + `chai` 两个 devDep，并接受「两处 expect 可能随版本漂移」 |
| **(c) 留在 vitest**                                      | 0                                                                                                                      | 0                                                                                                                                                                                                                                 | **0**。代价是维持现状：ADR-0009 选 vitest 的理由（「两个 runner 的维护成本 > 一次迁移成本」）在今天的规模下**依然成立**，而且是**第二次**站在同一岔路口上、而且是**往回走**                                                                                                                                                                                                                                                                                                                                                      |

**头条一句话**：**(c) 成本为 0；(b) 成本集中在「非断言层」+ 一条无官方背书的组合路径；(a) 成本集中在全部 5063 处断言，按本仓自己的先例外推是 2 万～5 万行 diff。**

> 补充：形状 (b) 还有一个**未被 (a)(c) 提到的隐性优势**——它可以让 5063 处断言**一字不改**地存活，这在「未来要再迁回 vitest」时是双向保险。但它要求本仓**新增一条无人维护的装配层**（自建 `expect` 模块），而这条装配层的正确性没有任何官方文档背书。

---

## ⑤ 两条对齐轴（只列事实，不做决定）

### 5.1 轴一：运行时对齐（Node-native）

**本仓既有决定**：ADR-0009 的 reopen trigger 写着 "A new sibling test framework (e.g. for a non-Node target) is added — supersede this ADR; the same **'single runner per language target'** principle applies."（<https://github.com/a1121611810/pi-ptc-subagents/blob/feat/routing-engineering/docs/adr/0009-vitest-adoption.md>）。本仓的 language target 确实只有一个：Node。

**官方来源说了什么**：

| 来源        | 陈述                                                                                                                                                                                                                                                                                                                    | 性质                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Node 官方   | 运行器 `Stability: 2 - Stable`（v20.0.0 起）；零安装成本（"you don't need to install any additional dependencies to use it"）                                                                                                                                                                                           | 支持「运行时对齐」的一面                                        |
| Node 官方   | **覆盖率仍是 `Stability: 1 - Experimental`**（v22.x / v24.x / main 三个分支一致）；watch 模式 Experimental；`mock.module` Early development 且需额外 CLI 开关                                                                                                                                                           | **反对**「运行时对齐 = 一切都是稳的」                           |
| Node 官方   | 无任何一句「npm 库作者应该用 node:test」；也无任何一句「应该用 vitest」                                                                                                                                                                                                                                                 | **无背书**                                                      |
| vitest 官方 | "Vitest aims to position itself as the Test Runner of choice for Vite projects, and as a **solid alternative even for projects not using Vite**."（<https://vitest.dev/guide/why>）                                                                                                                                     | vitest 自己**不**主张只配 Vite 项目用                           |
| vitest 官方 | "Even if your library is not using Vite (for example, if it is built with esbuild or Rollup), Vitest is an interesting option as it gives you a faster run for your unit tests and a jump in DX thanks to the default watch mode using Vite instant Hot Module Reload (HMR)."（<https://vitest.dev/guide/comparisons>） | **vitest 官方明确讨论了「不用 Vite 的库」这一情形**，并给出推荐 |
| vitest 官方 | `vitest.dev/guide/comparisons` 的对比清单里**没有 Node 内建测试运行器**                                                                                                                                                                                                                                                 | 事实陈述                                                        |

### 5.2 轴二：构建链对齐（vite-plus 一条链）

**本仓既有决定**：构建是 `vp pack`，runner 是 `vp test`，两个配置分开（ADR-0009: "The build (`vp pack`) and the test runner (`vp test`) share the Vite engine, but their configs do not"）。

**官方来源说了什么**：

| 来源                       | 陈述                                                                                                                                                                                                                   | 出处                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| vite-plus（第一方 README） | "**`vp test`:** Run tests through **bundled Vitest**"                                                                                                                                                                  | `node_modules/vite-plus/README.md` |
| vite-plus                  | "**`vp pack`:** Build libraries for npm publishing or standalone app binaries"                                                                                                                                         | 同上                               |
| vite-plus                  | "It combines Vite, **Vitest**, Oxlint, Oxfmt, Rolldown, tsdown, and Vite Task into **one zero-config toolchain**"；"**All of this is configured from your project root** and works across Vite's framework ecosystem." | 同上                               |
| vitest 官方                | "It is a test runner that **uses the same configuration as your app** (through `vite.config.js`), **sharing a common transformation pipeline during dev, build, and test time**."                                      | <https://vitest.dev/guide/why>     |

**破坏这条链的代价（事实层）**：

1. **多一套 TS 执行机制**：vite-plus 的 TS transform → 换成 Node 的类型擦除。本仓 `engines.node >= 22.19.0` 的下沿对应的是 `Stability: 1.2 - Release candidate` 的类型擦除特性；且本仓用 `from "…/bindings.ts"` 的带扩展名导入写法，与 Node 擦除的约束对位（若用 borp，borp 明确说 "No build step required!"，但那也是 Node 的擦除，不是 vite-plus 的 transform）。
2. **多一套覆盖率配置**：`vitest.config.ts` 的 `coverage` 块要换成 c8 / 内建开关（CLI flag 或 `package.json#c8` 段）。
3. **丢掉 `test:ui`**（node:test 没有 UI 模式）与**稳定的 watch**（node 的 watch 是 Experimental）。
4. **丢掉 `vp test` 的统一入口**：本仓所有测试相关脚本都走 `vp`（ADR-0009 明确写 "Both go through `vp`, so contributors use the same runner binary and the same devDep-pinned Vitest as CI"）。
5. **覆盖率阈值表达能力下降**：vitest 的 `thresholds` 是四元组（lines/branches/functions/statements），c8 的 `check-coverage` 与 Node 内建的三元组都**没有 statements 维度**（当前阈值全为 0，暂不触发）。
6. **CI 的 Node 版本下限**要重新对齐（Node 22.19 vs 24；`--experimental-test-module-mocks` 这类实验性开关还要额外进 CI 命令行）。

### 5.3 两条轴上**都没有官方背书**的部分

明确点出（这是本节的目的）：

1. **「测试 runner 应当与运行时对齐」——无任何官方来源这么说。** Node 官方没有要求库作者用 node:test；vitest 官方反而明确说自己 "a solid alternative even for projects not using Vite"。这条原则目前是**本仓 ADR-0009 自己的工程判断**。
2. **「测试 runner 应当与构建工具链对齐」——同样无官方背书。** vitest 官方给出的是「共享 transformation pipeline 带来的 DX 优势」的**论证**，不是「不这样做就不对」的规范；vite-plus 把 Vitest 打包进 `vp test` 是**产品打包决策**，不是对使用者的强制要求。Node 官方同样没有「你用了别的构建工具就别用 node:test」这类表述。
3. **「Node 内建的覆盖率是稳定特性」——事实层不成立**（v22.x / v24.x / main 三个分支都是 `Stability: 1 - Experimental`）。issue #266 正文里写的「coverage is built in as `--test-coverage`」这一条**不准确**：开关名是 `--experimental-test-coverage`，且是实验性。
4. **「Vitest 是浏览器端工具」——事实层不成立**（issue 已引 vitest.dev/guide/why；默认 `environment: node`，Browser Mode 是可选特性；vitest 官方对比页列的是 Jest/Cypress/Playwright 等浏览器系工具，而**它自己没把 node:test 列为对手**）。

---

## ⑥ 未能取证

以下都是本次 session **没有找到一手来源**的项，不做推断：

1. **没有任何官方文档记录「`@vitest/expect` + `node:test`」的用法。** 检索范围：`@vitest/expect` 的 npm README（5.0.5 与 4.1.11）、`packages/expect/src/*` 源码、vitest 仓库全仓代码搜索、vitest 仓库 issue 搜索、vitest.dev 文档站、vitest issue #8721 及其讨论。**最接近的一条是 #8721 的关闭结论 "Do nothing."**，而它问的是反方向。
2. **Node 官方没有「npm 库作者该怎么测」的规范性指引。** 检索范围：nodejs.org API 文档（`test.html` / `assert.html` / `cli.md` / `typescript.md`）、nodejs.org Learn 的 Test Runner 章节（introduction / collecting-code-coverage）、TypeScript 章节（publishing-a-package）。能找到的只有教程语境下的 "we recommend reading the test runner documentation"。**没有**任何「你应该用 node:test」或「你应该用 vitest」的断言。
3. **没有任何官方来源说「测试 runner 必须与构建工具链对齐」。** vite-plus README 与 vitest 文档给出的是打包事实与 DX 论证。
4. **`c8` 的 README 没有与 Node 内建 `--experimental-test-coverage` 的对比或基准数据。** 本文档 §2.5 的对比表是**本 session 基于两份一手文档做的字段对照**，不是某一方发布的对比结论。
5. **没有实测本仓真实测试套件在 node:test 下的墙钟时间。** 要拿到这个数必须先做一次真实迁移（超出本票范围）。§2.6 的 670 ms 是**空测试文件的固定开销**，不能当成本仓套件的实际开销。
6. **`expect@30.5.2`（Jest 的）没有任何官方记录的 node:test 独立用法。** 其 README 只有一句；未找到 jest 官方文档或 issue 记录这种组合。
7. **未验证 `@vitest/expect@5.0.5` 与 vitest 5.0.5 内置 expect 的行为完全一致。** 实测覆盖了本仓实际使用的 matcher 家族（§3.1、§3.2），但未做逐 matcher 的差分。
8. **未实测 `mock.module` 在本仓 `vi.mock` 的具体形状下的行为**（需要 `--experimental-test-module-mocks`，且 node 侧 mock 的是「模块导出」而非「模块本身」）。本票只取证了 API 存在性与稳定性标注。
9. **未取证「Node 内建覆盖率在 Node 26 / 27 会不会转正」。** 只确认了截至 2026-10-22，`main` 分支仍是 `Stability: 1 - Experimental`。
10. **`borp` 的 README 没有提到 `expect`（0 次）**（与 issue 记录的实测一致），因此**没有任何文档记录过「borp + `@vitest/expect`」这个组合**。

---

## 附：本仓相关的两处既有事实（供 map 引用，非本票结论）

- **本仓已经站在同一个岔路口上第二次了。** ADR-0009（2026-09-22，accepted）的决策依据是「两个 runner 的维护成本 > 一次迁移成本」+「`vp` 自带 vitest」。它选 vitest 的**理由不是 vitest 的能力**，这一点 issue #266 已经指出，本次取证**未推翻也未加强**它：今天的规模（102 文件 / 1757 用例 / 5063 断言）比当年（9 文件 / 1732 LOC）大两个数量级，而「两个 runner 的成本」这个变量没有变化。
- **ADR-0009 自己记录了一条与本次取证相关的判断**：它把「保留 node:test 的 API 表面、跑在 Vitest 的 `--node-test` 下」列为 **Rejected**，理由是 "Vitest 4 dropped first-class `node:test` interop"。本次取证**独立地**确认了这一点并给出了更强的证据：vitest 维护者在 #8721 里明确说 "Vitest test runner is not compatible with node" 且关闭为 "Do nothing."。
  顺带一处**需要更正的旧表述**：ADR-0009 把 node:test 的缺口列为 "no native coverage UX, no UI mode, no snapshot, no `expect.soft`"——其中 **"no snapshot" 在 2026-09 就已经不准确**（node:test 的快照自 v22.3.0 引入、v23.4.0 起已 stable）；"no `expect.soft`" 至今成立（node:test 文档中 `soft` 出现 0 次）。
