# 发布物一次构建出：引擎与 worker 各只有一份

Status: accepted (2026-11-02)。修订：发布形态那段的「根包只发一份自包含产物」。

## Context

发布包里出现两份一模一样的 `CELL_PREAMBLE`——一份在 `dist/worker.js`，一份在 `dist/ptc/worker.js`。查下来（2026-11-02）：

- **摇树（tree shaking）管不到它**：两份分属**两次独立构建**（`packages/entry` 与 `packages/ptc` 各有一份 rolldown config），不在同一个模块图里，摇树看不见对方。摇树本身是有效的（`dist/index.js` 里未被引用的 `createFsBindings` 已被摇掉）。
- **两份都是承重的**：worker 由 `buildWorkerUrl(import.meta.url)` 相对**消费方**的模块 URL 解析 ⇒ pi 扩展面要 `dist/worker.js`，独立引擎面要 `dist/ptc/worker.js`。删任一份，对应消费者立刻起不来 worker（实测：拿掉 `packages/entry/dist/worker.js` ⇒ entry 面探针红）。
- **更深一层，引擎本体也有两份**：`dist/index.js`（entry 的 bundle 把 `@pi-ptc/ptc` alias 到 src 打进来了）+ `dist/ptc/`（ptc 包自己的构建）。`prepack` 把两份 dist 拼起来 ⇒ 重复是**构建拓扑**造成的。
- Vite 从来没这问题：Vite 一个项目只有一次构建，多入口共享的模块自动抬进共享 chunk（code splitting）。

## Decision

**1. 一次构建出四个入口。** `packages/entry/rolldown.config.mjs` 的 input 增加 `ptc/index`（`../ptc/src/index.ts`）与 `ptc/cli`（`../ptc/src/cli.ts`），与 `index`、`worker` 同批出包 ⇒ 引擎本体与 worker 各只剩一份。alias 仍指向 `src`，不依赖兄弟包 dist，单独构建 entry 依然自洽。**entry 的构建先清 `dist`**（`rmSync` 开头，与 kimi-mcp 同一写法）——rolldown 从不清输出目录，共享块改名后旧块会留在目录里，而 `prepack` 整目录拷贝 ⇒ 陈旧块会被打进发布包。

**2. 具名共享块。** `output.codeSplitting.groups` 把 `packages/ptc/src/`（**排除入口模块**）归进 `ptc-engine`；`chunkFileNames: "[name].js"` ⇒ 块名稳定、不带内容 hash。

**3. `packages/ptc` 不再是发布来源。** 删掉它的 build 脚本与 `rolldown.config.mjs`（不再单独出 dist；留着那份配置会让人以为改它有用），`exports` 指向 `src`。运行时无人解析 `@pi-ptc/ptc`——entry 与 kimi-mcp 的 config 都 alias 到 src。

**4. `prepack` 只拷一次。** 去掉 `cp -R packages/ptc/dist dist/ptc`；`packages/entry/dist` 自带 `ptc/` 与共享块。

**5. 测试打发布产物。** standalone / pi 面的引擎用例改指 `packages/entry/dist/ptc/index.js` ⇒ 测试打的正是发布物（此前发布布局零覆盖）。

**6. 两条防回归探针**（`tests/pi/artifact-shape.test.mjs`）：产物形态（四个入口都在 / worker 唯一 / 引擎与 `CELL_PREAMBLE` 各只一份 / 两个入口共享同一块）+ **副作用隔离**（import entry 不得有任何输出）。

**7. 共享块必须留在输出根。** `buildWorkerUrl` 在共享块里，`new URL("./worker.js", 共享块 URL)` ⇒ 块挪进 `chunks/` 子目录就找不到 worker。**所以「找不到 worker」必须报得说人话**：`buildWorkerUrl` 的兜底只在源码直跑时用（构建产物里没有 `src/`，退回去只会报一个从没存在过的路径——实测过：`worker error: Cannot find module '.../packages/entry/src/worker-entry.ts'`），两个候选都不在就抛「PTC worker 缺失：期望 `<路径>`」。`WorkerPool.acquire` 随之改为**先起再记账**（spawn 抛错不白扣槽位——否则连调几次就从清楚报错退化成「acquire 超时」，比原来更糊）。

## Consequences

- 发布物：283,153 B → 268,491 B（−14.7KB，−5.2%）；`CELL_PREAMBLE` 一处；worker 一份。
- **错误形状变了**：缺 worker 从「程序 rejected、`error` 字段带消息」变成「工具调用抛错」。两者到模型面前都是一条错误消息，但前者是程序结果、后者是工具错误。
- **发布形态变了**：根包不再是「一份自包含产物」，而是一次构建的多入口 + 共享块（`dist/index.js` import 同目录的 `ptc-engine.js`）。只拷一个 `index.js` 的用法会坏——仓库内没有这种用法。
- 验证：四制探针全绿（151 + 6 + 25 + 10）+ 产物 import 门禁 + 发布布局冒烟（CLI 端到端 / import entry 无输出 / `runPtcProgram` fulfilled）+ 真 pi 冒烟（`pi -ne -e packages/entry/dist/index.js -p ...` 正常回复、退出码 0）。
- **副作用隔离那条是被实测逼出来的**：分组规则 `test` 写宽了会把 `packages/ptc/src/cli.ts`（顶层直接 `main()`）摇进共享块 ⇒ 「只要 import entry 就执行 CLI」。rolldown 文档原话：manual chunking 会改变副作用时机。探针必须留着。
- Kimi 面不受影响：`release/kimi/` 本来就是一次构建（server + worker + 共享 chunk），worker 只有一份。
- **更彻底的路没做**：把 `@pi-ptc/ptc` 变成真发布的 npm 依赖、entry 用 `output.paths` externalize 它 ⇒ 引擎与 worker 都在 node_modules 里，`dist/index.js` 保持单文件。收益同量级，但要发布 9 个子包 + 版本流水线，且会翻出老问题（npm 上 `@pi-ptc/routes` = 404）。记在这里作为将来路线。
