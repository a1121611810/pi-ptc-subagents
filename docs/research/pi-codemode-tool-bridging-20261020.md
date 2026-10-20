# pi 会不会把扩展注册的工具的 `execute()` 桥接给 codemode 沙箱：会，而且走的是和 MCP 工具完全同一条路

> 调研日期: 2026-10-20。回答 GitHub 票 #231（`wayfinder:research`，属于 #226）的问题清单：pi 会不会把**扩展注册的工具**的 `execute()` 桥接给 codemode 沙箱里的脚本；桥接在哪一层；入参与返回怎么序列化；这是不是只对 MCP 工具成立；`exposure` 的版本下限；以及 `pi.dispatch` 是怎么做到 codemode 可达的。
> 方法: 读**本项目真正依赖的那份编译产物**（`node_modules/@earendil-works/pi-coding-agent@1.3.0` 的 `dist/`，含 `.d.ts` 与 `.js`）与其自带的 `docs/`；跨版本问题用 `npm pack` 解包 0.86.0 / 0.99.0 到 `/tmp` 后读源码。**全程静态取证，未启动真实 pi 会话做端到端复现**（见 §8 未核实清单）。
> 一手来源: 全部为 `node_modules/@earendil-works/pi-coding-agent/`（1.3.0）与 `@earendil-works/pi-codemode@1.3.0` 的编译产物与官方 `docs/`；跨版本为 npm 上解包的 0.86.0 / 0.99.0 产物。本仓源码作为**被测对象与对照**引用（`src/`、`docs/agents/pi-compat-matrix.md`）。未引用上游 GitHub 仓库源码（本次不需要，编译产物已含完整实现与注释）。
> 复核命令: 见 §9（逐条给出可直接粘贴的命令）。
> 仓库快照: `pi-ptc-subagents` HEAD `64de4bd`；本笔记只新增本文件，未改动其它任何文件。

## 0. 结论速查表

| #   | 问题                                  | 结论                                                                                                                                                         | 出处                                                                                                                                        |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 扩展注册的工具，codemode 脚本能调到吗 | **能**。`exposure: "codemode"` 的工具进入 `ctx.tools`，脚本侧 `tools.<name>(args)` 经 `ctx.executeTool()` 打到扩展自己的 `execute()`                         | `dist/extensions/codemode/execute.js:401`、`:421`；`dist/core/agent-session.js:1148-1153`                                                   |
| 2   | 桥接在哪一层                          | 三跳：脚本 `tools.x()` → codemode 的 `sandboxTools.execute` → `ctx.executeTool` → `_executeNestedToolCall` → `runToolCall` → 扩展 `execute()`                | `dist/extensions/codemode/execute.js:405-434`、`:421`；`dist/core/agent-session.js:388-417`                                                 |
| 3   | 工具的 `execute()` 跑在哪             | **宿主进程的主线程**。QuickJS 只在同进程的 worker 线程里跑脚本，负责转发调用；`execute()` 是普通 Node 函数，有完整 Node 能力                                 | `@earendil-works/pi-codemode/dist/runtime/host.js:30`；`dist/core/agent-session.js:401-409`                                                 |
| 4   | 入参怎么序列化                        | **JSON**。脚本侧 `JSON.stringify(args)`，宿主侧 `JSON.parse`                                                                                                 | `pi-codemode/dist/runtime/prelude-source.js:199`；`runtime/vm.js:224`；`runtime/execution.js:318`                                           |
| 5   | 返回怎么序列化、`details` 能过去吗    | 脚本只拿到**一个值**：`structuredContent`（工具声明了 `outputSchema` 且返回了它时），否则 `content` 里的文本块拼成的字符串。**`details` 永不进入脚本**       | `dist/extensions/codemode/execute.js:39-44`、`:370-378`                                                                                     |
| 6   | 有大小上限吗                          | 桥本身**没有**参数/结果字节上限；上限是 VM 内存 256 MB、脚本输出 16 MiB / 10 万次调用、worker 并发 2。8 KiB/32 KiB 那个限制只管**记录**，不管调用            | `dist/extensions/codemode/execute.js:21`、`:23`；`pi-codemode/dist/runtime/prelude-source.js:42-43`；`dist/core/nested-tool-calls.js:16-21` |
| 7   | 只对 MCP 工具成立吗                   | **不只**。MCP 工具与扩展工具走**同一条**注册与桥接路径（MCP 也是 `pi.registerTool`）；差别只在 `execute()` 体内做什么、结果长什么样                          | `dist/extensions/mcp/index.js:315`、`:336`；`dist/extensions/mcp/tools.js:251`、`:257`                                                      |
| 8   | 0.86.0 上 `exposure` 被忽略           | 属实，且比"被忽略"更彻底：0.86.0 **没有 `exposure` 字段、没有 codemode 扩展、没有 `ctx.executeTool`、没有 `structuredContent`/`outputSchema`**               | 0.86.0 `dist/core/extensions/types.d.ts:345-378`（无 `exposure`）、`dist/extensions/`（无 `codemode/`）；全 dist 无 `executeTool`           |
| 9   | 构成新的能力下限吗                    | **不构成并列的新下限**。"程序内可达"本身要求 codemode 存在，而 codemode 与 `exposure` 一起在 **0.99.0** 出现；既有 capability floor 0.99.0 已经覆盖          | 本笔记 §5；本仓 `docs/agents/pi-compat-matrix.md:63`、`:66`                                                                                 |
| 10  | `pi.dispatch` 怎么做到 codemode 可达  | **前提不成立**：`pi.dispatch` 是 PTC 程序内的 binding，**不是 pi 注册的工具**，任何 surface 上都不在 codemode 脚本的工具表里                                 | `src/runtime/bindings.ts:58`；`src/tools/common.ts:201-204`；`src/tools/run-code.ts:58-60`                                                  |
| 11  | 那正确的做法是什么                    | `pi.registerTool({ ..., exposure: "codemode" })` —— 本仓已经在用这套（`subagents` surface 上 PTC pair 用的就是它）                                           | `src/index.ts:485-513`；`dist/extensions/codemode/tool.js:221`（`codemode` exposure 的工具会被列进 codemode 描述）                          |
| 12  | 对"程序面落点"意味着什么              | codemode 面本身就是**第三条程序面**。搜索可以落成 (A) codemode 工具、(B) PTC binding、或 (C) 两者共用一份实现 —— (C) 是唯一在两个 surface 都不面向模型的形状 | 本笔记 §7                                                                                                                                   |

## 1. 问题与一处必须先修正的前提

### 1.1 问题

宿主项目 `pi-ptc-subagents` 是 pi 的一个扩展（PTC = Programmable Tool Calling：模型写程序，程序里用 `tools["<name>"](args)` 调工具）。准备加一个内置网页搜索模块，基线已定：**搜索只做「程序内可达」，不做顶层 model-facing 工具**。

本仓有两条程序面：

1. **PTC binding** —— pi-ptc 自己的 Node worker 绑定表（`tools["x"]`），`pi.dispatch` 就是这么做的；
2. **codemode 面** —— pi 自带的 `codemode` 工具在 QuickJS 沙箱里跑脚本（无 Node、无文件系统、无网络、无定时器），脚本通过 `searchTools` / `describeTool` 发现并调用暴露在 codemode 目录里的工具。

若 codemode 面可达，本仓 `subagents` surface 上模型一跳就能调搜索；否则要绕两跳（codemode → `ptc_run_code` → PTC binding）。票 #231 的问题就是这个前提是否成立。

### 1.2 前提修正：`pi.dispatch` 不是 pi 的工具

调研中确认了一处必须纠正的前提。**`pi.dispatch` 是 PTC 程序内的 binding，不是一个用 `exposure: "codemode"` 注册的 pi 工具**，所以"照抄 `pi.dispatch` 怎么做 codemode 可达"这个问题本身不成立：

- 它的名字是绑定名常量：`DISPATCH_BINDING_NAME = "pi.dispatch"`（`src/runtime/bindings.ts:58`），调用约定是 `tools["pi.dispatch"](args)`（点号名要字符串索引，`tools.pi.dispatch` 不存在）——`src/tools/run-code.ts:58-60`。
- 本仓自己已经把这件事写成常量并挂在两处 PTC 描述上：**"A `codemode` script cannot call the parallel binding directly: `pi.dispatch` is never in that script's own tool table, on any surface. A script reaches it by calling `ptc_run_code` or `ptc_workflow` and using the binding inside the program."**（`src/tools/common.ts:201-204`，常量名 `PTC_BINDING_REACH_NOTE`）。
- 本仓 2026-10-16 的 dispatch 回路 e2e spike 也是这么测的：codemode 脚本查自己的工具表，找不到 `pi.dispatch`（`docs/research/dispatch-loop-e2e-spike-20261016.md`，本仓既有记录）。

所以第 5 问被改写成：**要让一个「包自有工具」在 codemode 面可达，正确做法是什么？** 答案是 §6。

## 2. 调用链逐跳拆解

下面每一跳给出所在文件与行号。`node_modules/@earendil-works/pi-coding-agent/` 简称 **pi**，`node_modules/.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/` 简称 **pi-codemode**。

| 跳  | 发生什么                                                                                           | 在哪                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | 扩展注册工具：`pi.registerTool({ name, parameters, execute, exposure: "codemode" })`               | 扩展自己的代码；pi 侧 `dist/core/extensions/runner.js` 收集 `getAllRegisteredTools()`（`dist/core/agent-session.js:2847`）                                     |
| ②   | pi 把注册的工具包成 `AgentTool`，并塞进 session 的工具注册表 `_toolRegistry`                       | `dist/core/extensions/wrapper.js:13` → `dist/core/tools/tool-definition-wrapper.js:12`；`dist/core/agent-session.js:2884-2897`                                 |
| ③   | session 按 exposure 算「可被别的工具调用的那批」：`_getCallableTools()`                            | `dist/core/agent-session.js:1148-1153`（见下）                                                                                                                 |
| ④   | codemode 工具的 `execute()` 拿到 `ctx`，把 `ctx.tools` 变成沙箱里的工具表                          | `dist/extensions/codemode/execute.js:401`（`getCodemodeCallableTools(ctx.tools)`）、`:405-434`                                                                 |
| ⑤   | 脚本里 `tools.my_tool(args)` → VM 内 `bridge("call", id, name, argsJson)` → `postMessage` 到宿主   | `pi-codemode/dist/runtime/prelude-source.js:199`、`:206`；`runtime/vm.js:214-224`；`runtime/worker.js:16-18`；`runtime/host.js:71`                             |
| ⑥   | 宿主侧 `handleCall` 取出工具、**在宿主线程**执行 `tool.execute(args, {signal})`                    | `pi-codemode/dist/runtime/execution.js:304-336`（`:315` 取工具、`:319` 执行）                                                                                  |
| ⑦   | codemode 侧的 `sandboxTools[].execute` 调 `ctx.executeTool(name, args, {signal})`                  | `dist/extensions/codemode/execute.js:421`                                                                                                                      |
| ⑧   | `ctx.executeTool` → `ExtensionRunner` 的 `executeToolFn` → `AgentSession._executeNestedToolCall`   | `dist/core/extensions/runner.js:706-721`（`:719`）；`dist/core/agent-session.js:2816`、`:388-417`                                                              |
| ⑨   | 嵌套调用走 agent loop 的工具管线：参数校验 → `beforeToolCall` → 扩展 `execute()` → `afterToolCall` | `pi-agent-core/dist/agent-loop.js:481-526`（`prepareToolCall`）、`:559-597`（`runToolCall` / `executePreparedToolCall`）；`dist/core/agent-session.js:401-409` |
| ⑩   | 扩展的 `execute()` 返回 `{ content, details, structuredContent? }`                                 | 扩展自己的代码                                                                                                                                                 |
| ⑪   | 结果投影成脚本可见的**一个值**，回灌 VM                                                            | `dist/extensions/codemode/execute.js:370-378`（`toScriptValue`）、`:432`                                                                                       |

### 2.1 第 ③ 跳的可调用集合（决定谁能被脚本调到）

```js
// dist/core/agent-session.js:1148-1153
_getCallableTools(active = new Set(this.getActiveToolNames())) {
    return [...this._toolRegistry.values()].filter((tool) => {
        const exposure = this._getToolExposure(tool.name);
        return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
    });
}
```

配套的两个判定（`dist/core/agent-session.js`）：

- `_isDeclarable(name)`（`:2926-2929`）：`exposure === "direct" || exposure === "model-only"` —— **只有这两种会面向模型**。`codemode` 面的工具**不面向模型**。
- `_isActivatedOnRegistration(name)`（`:2931-2933`）：`_isDeclarable(name) && defaultActive !== false` —— `codemode` / `deferred` 工具注册时**不会**被激活，因此不会进模型声明。

⇒ `exposure: "codemode"` 的语义正好是「**可被程序调、但模型看不见**」。这正是"只做程序内可达、不做顶层 model-facing 工具"所需要的形状。

### 2.2 第 ⑥/⑦/⑩ 跳的执行位置：宿主进程主线程

- QuickJS 跑在**同进程的一个 worker 线程**里，每次执行一个新 worker + 一个新 wasm 实例：`new Worker(options.workerUrl ?? defaultWorkerUrl(), { workerData })`（`pi-codemode/dist/runtime/host.js:30`），worker 内 `startVm` 起 QuickJS（`runtime/worker.js:19-27`）。
- worker 只做两件事：转发 tool call、转发 output（`runtime/protocol.js:1-14` 只允许 `call`/`output`/`done`/`crash`/`started`/`idle` 两种方向）。
- **扩展的 `execute()` 不在 worker 里跑**。它由宿主主线程的 `ctx.executeTool` → `_executeNestedToolCall` → `runToolCall` → `prepared.tool.execute(...)`（`pi-agent-core/dist/agent-loop.js:574`）触发。

⇒ 扩展的 `execute()` 拥有完整 Node 能力（网络、文件、子进程），与"沙箱里没有 Node/网络"的约束不冲突 —— 那条约束约束的是**脚本**，不是被调用的工具。

### 2.3 嵌套调用的附带语义

- 走完整的 agent 工具管线：参数校验、`tool_call` / `tool_result` 扩展钩子、权限拦截都照常生效（`docs/extensions.md:149`；`dist/core/agent-session.js:401-409` 把 `beforeToolCall`/`afterToolCall` 接进 `runToolCall`）。
- 嵌套调用 id 是 `<父调用 id>/<n>`，不写进 transcript；其 usage 计入调用方工具结果的 usage（`dist/core/nested-tool-calls.js:98-166`；`docs/extensions.md:149`）。
- 嵌套调用记录有界：单次参数 8 KiB、累计 32 KiB、最多 256 条（`dist/core/nested-tool-calls.js:16-21`）——**这是记录（给 transcript / HTML 导出用）的上限，不是调用本身的上限**（超过只是不记参数，调用照常执行）。

## 3. 入参与返回的序列化

### 3.1 入参：JSON

| 方向           | 位置                                             | 事实                                                                                                 |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 脚本 → VM 内部 | `pi-codemode/dist/runtime/prelude-source.js:199` | `json = serialize(spread ? args : args[0])`，`serialize` 就是 `JSON.stringify`（`:137`、`:153-155`） |
| VM → 宿主      | `pi-codemode/dist/runtime/vm.js:214-224`         | `bridge("call", id, name, argsJson)` → `post({ type: "call", id, name, args: c.toString() })`        |
| 宿主 → 执行    | `pi-codemode/dist/runtime/execution.js:318`      | `const args = message.args === undefined ? undefined : JSON.parse(message.args);`                    |

⇒ **入参是 JSON**。因此只有 JSON 可表示的东西能过桥：`undefined`、函数、`Date`、`Map`/`Set`、循环引用、BigInt 都不行（`undefined` 整体是特例，会被丢掉）。脚本侧的工具方法名会被规范化成合法 JS 标识符（`mcp__dev-radius__search` → `tools.mcp__dev_radius__search`，`docs/codemode.md:39`）。

参数随后由 agent loop 按工具自己的 TypeBox schema 校验（`pi-agent-core/dist/agent-loop.js:492` `validateToolArguments`），校验失败 → 脚本侧 reject。

### 3.2 返回：脚本只拿到一个值

宿主侧执行完，结果投影由 `toScriptValue` 决定（`dist/extensions/codemode/execute.js:370-378`）：

```js
function toScriptValue(tool, outcome) {
  const { result } = outcome;
  if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf(result);
  if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
  return text;
}
```

`textOf` 只取 `content` 里的 `type === "text"` 块，用 `\n` 连接（`dist/extensions/codemode/execute.js:39-44`）。

⇒ 回答票里"返回的 `{ content, details }` 怎么进 QuickJS（`details` 能过去吗，还是只有 `content`）"：

| 字段                | 进不进脚本                                   | 说明                                                                                   |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `content` 的文本块  | 进（当工具没声明 `outputSchema` 时）         | 拼成一个字符串                                                                         |
| `content` 的图片块  | **不进**                                     | `toScriptValue` 只取 text 块；图片要靠工具声明 `outputSchema` 才有结构化通道           |
| `structuredContent` | 进（工具声明了 `outputSchema` 且返回了它时） | 这时脚本拿到的是它本身，而不是文本                                                     |
| `details`           | **永不进**                                   | `toScriptValue` 完全没读它；`details` 是给渲染 / transcript 重建 / 状态恢复用的        |
| `isError`           | 变成 reject                                  | 抛 `Error`，message 是工具的错误文本；`structuredContent` 存在时错误仍 resolve（见下） |
| `usage`             | 不进脚本                                     | 记在嵌套调用记录上，汇进调用方的 usage（`dist/core/nested-tool-calls.js:152-155`）     |

补充两条容易踩的点：

- **声明 `outputSchema` 就切换了脚本看到的通道**：`docs/extensions.md:147` 明写"programmatic callers such as codemode scripts receive `structuredContent` instead of the text"。
- **MCP 的 `isError` 不 reject**：MCP 工具把整个 `CallToolResult` 放进 `structuredContent`（`dist/extensions/mcp/tools.js:202-217`），所以 `toScriptValue` 走的是"有 `structuredContent`"分支，脚本 resolve 到结果对象而不是抛错。

### 3.3 返回值回灌 VM 的方式

| 方向      | 位置                                             | 事实                                                                                                         |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 宿主 → VM | `pi-codemode/dist/runtime/execution.js:320`      | `reply = { type: "result", id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) }` |
| VM 解析   | `pi-codemode/dist/runtime/prelude-source.js:474` | `value = payload === undefined ? undefined : parse(payload)`（`parse` = `JSON.parse`）                       |

⇒ 返回值也是 JSON。宿主侧 `execution.js:203-209` 有一句刻意的设计：**先序列化再记录**，"so a value JSON cannot hold leaves the call waiting for another answer" —— 序列化成 `undefined` 的返回值不会让调用悬着。

### 3.4 大小上限

| 上限                     | 值                                           | 位置                                                        | 管什么                                        |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| 桥的参数 / 结果字节      | **无显式上限**                               | `pi-codemode/dist/runtime/execution.js:318-320`             | 只有 JSON 化和 postMessage                    |
| QuickJS VM 内存          | 256 MiB                                      | `dist/extensions/codemode/execute.js:21`、`:444`            | 脚本侧；溢出击 `InternalError: out of memory` |
| 脚本输出文本 + base64 图 | 16 MiB（16777216 字符）                      | `pi-codemode/dist/runtime/prelude-source.js:42`、`:343-345` | 脚本 `text()`/`image()`/`console` 的累计产出  |
| 脚本输出条数             | 100000                                       | `pi-codemode/dist/runtime/prelude-source.js:43`             | 同上                                          |
| worker 并发              | 2（跨所有 session）                          | `dist/extensions/codemode/execute.js:23`、`:447-450`        | 满了直接失败，让用户重试                      |
| 嵌套调用记录             | 8 KiB/次、32 KiB/累计、256 条                | `dist/core/nested-tool-calls.js:16-21`                      | **只管记录，不管调用**                        |
| 单次脚本超时             | `// @options: {"timeout_ms": ...}`，默认无限 | `docs/codemode.md:16`                                       | 整个脚本的硬截止                              |

⚠️ 工具结果本身在到达脚本之前**不被 pi 截断**（扩展工具的截断是扩展自己的责任；MCP 工具例外，见 §4）。真正会被压住的是"脚本最终吐给模型的那段文本"：`max_output_tokens` 默认 10000，超了保留首尾并把全文写进临时文件（`dist/extensions/codemode/execute.js:342-363`，`docs/codemode.md:15`）。

## 4. 扩展注册的工具 vs MCP 工具：同一条路，不同的 `execute()` 体内

这是票里第 3 问的关键。结论：**MCP 工具不是被特殊接管的另一条路，它就是用 `pi.registerTool` 注册的普通工具**，因此扩展工具与 MCP 工具在"能不能被 codemode 脚本调到"这件事上**没有任何差别**。

### 4.1 差异对照表

| 维度                                | 扩展注册的工具                                                                                                      | MCP 工具                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册方式                            | `pi.registerTool(definition)`                                                                                       | **同样**是 `pi.registerTool(definition)`（`dist/extensions/mcp/index.js:336`）                                                                                       |
| exposure 来源                       | 扩展自己写 `exposure: "codemode"`                                                                                   | `getMcpToolExposure(entry.config, tool.name)`（`dist/extensions/mcp/index.js:315`），server 级默认 `config.exposure ?? "codemode"`（`dist/core/mcp-servers.js:135`） |
| 最终落到 pi 的 exposure             | `codemode`                                                                                                          | **映射成 `deferred`**：`toToolExposure(exposure)` 把 `codemode` 改成 `deferred`，其余原样（`dist/extensions/mcp/tools.js:25-29`、`:251`）                            |
| 是否面向模型                        | 否（`_isDeclarable` 只放行 `direct`/`model-only`，`dist/core/agent-session.js:2926-2929`）                          | 同左（`deferred` 也不面向模型）                                                                                                                                      |
| 是否在 codemode 描述里被列出        | **是**（`codemode` exposure 的工具会被列出；`deferred` 的不列）——`dist/extensions/codemode/tool.js:221`、`:227-233` | 否（`deferred`），要靠 `searchTools()` / `describeTool()` / `ALL_TOOLS` 发现（`docs/codemode.md:50`）                                                                |
| `execute()` 体内做什么              | 扩展自己的任意 Node 代码                                                                                            | `client.callTool(tool.name, params, {...})` —— 一次 MCP 协议往返（`dist/extensions/mcp/tools.js:255-257`）                                                           |
| 执行进程                            | 宿主进程主线程                                                                                                      | 宿主进程主线程（`execute` 仍在这里），**但真正干活的 MCP server 是另一个进程**（stdio 子进程或 HTTP 服务）                                                           |
| 脚本看到什么                        | `content` 文本，或（声明了 `outputSchema` 时）`structuredContent`                                                   | 整个 `CallToolResult`（去掉 `_meta`）作为 `structuredContent`：`{ content, structuredContent, isError }`（`dist/extensions/mcp/tools.js:8-10`、`:202-217`）          |
| `isError` 语义                      | 扩展抛错 / 返回 `isError: true`（≥0.99.0 才有该通道）                                                               | server 返回的 `isError`，是结果的一部分，脚本仍 resolve                                                                                                              |
| 是否需要"server 还在连"这类就绪机制 | 不需要（注册即就绪）                                                                                                | 需要：MCP 扩展靠 `reachesTools` 等服务器连上（`dist/extensions/mcp/index.js:1044-1059`；`docs/extensions.md:183`）                                                   |
| 命名空间                            | 扩展可用 `namespace: { name, aliases, description, instructions }`（`docs/extensions.md:163`）                      | 自动带 `mcp__<server>` 命名空间（`dist/extensions/mcp/index.js:287-293`）                                                                                            |

### 4.2 这张表读出来的三个结论

1. **桥接对两者一样成立。** MCP 工具能进 codemode 脚本的工具表，靠的是 `pi.registerTool` + `exposure` 这条唯一通路；扩展工具走的是同一条通路的另一个分支。MCP 那条路**不能**被当作扩展工具可行的证据，但它也不构成反例 —— 因为它本来就在同一条路上。
2. **差别只影响"结果长什么样"，不影响"能不能调到"。** 想要脚本拿到结构化数据，扩展工具也得声明 `outputSchema` 并返回 `structuredContent`，否则脚本只拿到一坨文本。
3. **差别还影响"模型怎么发现它"。** `codemode` exposure 的工具会**列在 codemode 工具自己的描述里**（模型因此知道脚本里能调它），`deferred` 的不列（只能靠 `searchTools` 查）。对"只做程序内可达"的搜索工具来说，`codemode` exposure 恰好是更好的那个：模型看得到"脚本里能调什么"，但工具本身不进模型的工具声明。

## 5. 版本兼容：跨版本取证

### 5.1 三个版本的事实对照

| 能力点                               | 0.86.0（declared floor）                              | 0.99.0 | 1.3.0（tree pin） | 怎么核到的                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------- | ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolDefinition.exposure` 字段       | **无**                                                | 有     | 有                | 0.86.0 `dist/core/extensions/types.d.ts:345-378`（整个接口里没有 `exposure`）；0.99.0 同文件 `:388` `export type ToolExposure = ...`、`:461` `exposure?: ToolExposure` |
| agent-session 认 exposure            | **无**                                                | 有     | 有                | 0.99.0 `dist/core/agent-session.js:1086-1090`（`_getCallableTools`）；1.3.0 `:1141-1153`                                                                               |
| codemode 扩展存在                    | **无**（`dist/extensions/` 只有 `index` 与 `llama/`） | 有     | 有                | 0.86.0 `ls dist/extensions/`；0.99.0 `dist/extensions/{codemode,mcp,tool-search}`                                                                                      |
| codemode 脚本能调别的工具            | **不能**（连 `ctx.executeTool` 都不存在）             | 能     | 能                | 0.99.0 `dist/extensions/codemode/execute.js:215` `ctx.executeTool(...)`；0.86.0 全 dist 搜 `executeTool` **零命中**                                                    |
| `outputSchema` / `structuredContent` | **无**                                                | 有     | 有                | 0.86.0 全 dist 搜 `outputSchema`/`structuredContent` **零命中**                                                                                                        |
| `prepareLoadout`                     | **无**                                                | 无     | 有（1.2.0+）      | 0.86.0 零命中；1.3.0 `dist/core/agent-session.js:1160-1199`                                                                                                            |
| `reachesTools`                       | 无                                                    | 无     | 有（1.2.0+）      | 1.3.0 `dist/extensions/codemode/tool.js:266`                                                                                                                           |

### 5.2 0.86.0 上"只做程序内"做不到 —— 而且不只是"`exposure` 被忽略"

票 #231 第 3 问的前提是"0.86.0 上 `exposure` 被忽略 ⇒ 工具一律面向模型"。**实测比这更彻底**：0.86.0 上

1. `ToolDefinition` 根本没有 `exposure` 字段（`dist/core/extensions/types.d.ts:345-378`）⇒ 写 `exposure: "codemode"` 只是被忽略的工具，工具照常面向模型；
2. **没有 codemode 扩展**（`dist/extensions/` 只有 `index` 与 `llama/`）⇒ 根本没有"程序面"这一说；
3. **没有 `ctx.executeTool`**（全 dist 零命中）⇒ 工具之间互相调用这个机制也不存在。

⇒ 在 0.86.0 上，"程序内可达"这件事**没有任何实现路径**。

### 5.3 这算不算一个新的能力下限？

**不构成与既有 capability floor 0.99.0 并列的新下限。** 理由：

- "程序内可达"要求 codemode 面存在，而 codemode 与 `exposure` **一起在 0.99.0 出现**（0.86.0 双双没有，0.99.0 双双有）。本仓既有的 capability matrix 已经记着这两行：`ToolDefinition.exposure` 在 0.86.0–0.87.1 是 ✗、0.99.0+ 是 ✓；`codemode ships (extensions/codemode)` 同（`docs/agents/pi-compat-matrix.md:63`、`:66`）。
- 换句话说：**"只做程序内可达"这条基线本身就隐含了 ≥0.99.0**，不存在"在 0.86.0 上退而求其次"的位置。
- 本仓的 surface 决策函数也正是这么分的：真机没有 codemode 目录的版本，决策落到 `full`（PTC 自己的面，PTC pair 注册为 `direct`）；有 codemode 的版本才落到 `subagents`（`docs/agents/pi-compat-matrix.md:231-240`；决策实现 `src/mode/ptc-mode.ts`）。

**但有一个必须写进票里的操作后果**：peer range 仍声明 `>=0.86.0`（`package.json` 的 `peerDependencies`），而 0.86.0–0.87.x 上真机落到 `full` surface —— 那里的 PTC pair 是 `direct`（面向模型）。所以：

- 若搜索工具**只**注册在 `subagents` surface ⇒ 它在 0.86.0 上根本不存在，符合"不做顶层 model-facing 工具"；
- 若搜索工具**也**注册在 `full` surface ⇒ 在 0.86.0 上它会面向模型，**违反已定基线**。这条必须作为票的约束写死，不能靠"老 pi 上没人用"糊过去。

## 6. 让包自有工具在 codemode 面可达：正确做法

不是照抄 `pi.dispatch`（它不是 pi 工具，§1.2），而是照抄**本仓已经在用的那套**。

### 6.1 本仓现成的样板

`src/index.ts:485-513`（`subagents` surface 上注册 PTC pair）：

```ts
const programmingToolExposure = detected.surfaceMode === "full" ? "direct" : "codemode";
pi.registerTool(
  createPtcRunCodeTool({
    getBindingSourceNames,
    getOptInBindings,
    getPool: () => turnPools.get("run_code"),
    depth: ptcDepth,
    exposure: programmingToolExposure,   // ← 这一行就是全部秘密
    ...
  }),
);
```

`src/index.ts:472-486` 的注释记着这是按 pi 0.99.0~1.1.0 实测的结论。

### 6.2 照抄需要的前置条件

| #   | 前置条件                                                                                                                 | 出处 / 备注                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 工具用 `pi.registerTool({...})` 注册，且**带** `exposure: "codemode"`                                                    | `dist/extensions/codemode/execute.js:401` 的 `ctx.tools` 过滤；`docs/extensions.md:155-161`                                                  |
| 2   | 工具要有 TypeBox `parameters` schema（校验在 agent loop 里做）                                                           | `pi-agent-core/dist/agent-loop.js:492`                                                                                                       |
| 3   | pi **版本 ≥0.99.0**（`exposure` 与 codemode 同时出现）                                                                   | §5                                                                                                                                           |
| 4   | pi 的 `codemode` 扩展**已加载**且 `codemode` 工具**已激活**                                                              | pi 自己把 `codemode` 注册为 `defaultActive: false`（`dist/extensions/codemode/index.js:28`），要靠 `--tools` / `defaultTools` / MCP 扩展激活 |
| 5   | 工具**不得**自己 `exposure: "model-only"`（那是"面向模型但不可被调"）                                                    | `dist/core/agent-session.js:2926-2929`                                                                                                       |
| 6   | 想要脚本拿到结构化数据：声明 `outputSchema` 并返回匹配的 `structuredContent`                                             | `dist/extensions/codemode/execute.js:372-373`；`docs/extensions.md:147`                                                                      |
| 7   | 想要模型在脚本里发现它：用 `codemode` exposure（会被列进 codemode 描述），而不是 `deferred`（不列，靠 `searchTools` 查） | `dist/extensions/codemode/tool.js:221`、`:227-233`；`docs/codemode.md:50`                                                                    |

### 6.3 `codemode` exposure 的两个副作用

- **它会出现在 codemode 工具自己的描述里**（受 `codemode.inlineBudget` 的 3000 估算 token 预算约束，超预算的会被剔除并标 "(tools not listed)"）—— `dist/extensions/codemode/tool.js:98-117`（`selectCatalog`）、`:66`、`:232`；`docs/codemode.md:50`。模型因此知道"脚本里能调什么"，但工具本身不在模型的工具声明里。
- **`codemode.mode` 只影响"列不列"，不影响"能不能调"**：`on`（默认）时 `direct` 工具的描述被改成"从脚本怎么调"，`only` 时 `direct` 工具从模型面隐藏但仍可调（`dist/extensions/codemode/tool.js:209-241`；`docs/codemode.md:52`）。

## 7. 对「程序面落点」票的影响

票 #231 的落点问题，在拿到这份取证后，选项从两个变成三个。**codemode 面本身就是一条程序面**——它不是"PTC 程序的替代品"，而是和 PTC binding 并列的、模型脚本可以直接伸手够到的第二个程序面。

| 方案                                   | 模型到搜索的跳数（`subagents` surface）                                  | 模型到搜索的跳数（`full` surface）                     | 面向模型？ | 落在哪         |
| -------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ---------- | -------------- |
| **A. pi 工具，`exposure: "codemode"`** | **1 跳**：模型 → `codemode` 脚本 → `tools["search"]`                     | 不可达（`full` surface 上没有 codemode）               | 否         | pi 工具表      |
| **B. PTC binding**                     | 2 跳：模型 → `codemode` 脚本 → `ptc_run_code` → 程序内 `tools["search"]` | 1 跳：模型 → `ptc_run_code` → 程序内 `tools["search"]` | 否         | PTC 绑定表     |
| **C. A + B 共用一份实现**              | 1 跳（同 A）                                                             | 1 跳（同 B）                                           | 否         | 两处，共享实现 |

对"只做程序内可达、不做顶层 model-facing 工具"这条已定基线：

- **A、B 都满足**"不面向模型"（A 靠 `_isDeclarable` 不放行 `codemode`；B 靠 binding 从来不在 pi 的工具表里）。
- **A 只在 `subagents` surface 成立**，且只在 pi ≥0.99.0 且 `codemode` 已激活时成立 ⇒ **A 单独用会让 `full` surface 上的模型彻底没有搜索**。
- **B 单独用**在 `subagents` surface 上多一跳，代价是"模型要先写一段脚本再写一段程序"。
- **C 是唯一在两个 surface 都不面向模型、且都不缺能力的形状**；它也符合本仓既有的设计取向（同一份实现多处挂载，实例独立）。落到 C 时，`src/tools/common.ts:201-204` 那个 `PTC_BINDING_REACH_NOTE` 的说法仍然成立（`pi.dispatch` 不在脚本工具表里，但**包自有的搜索工具在**），所以那句文案需要跟着调整，否则会误导模型。

**给票的建议**：把"程序面落点"的选择明确成"A / B / C"三选一，并默认推荐 **C**；同时把 §5.2 的操作后果写进票的硬约束——**搜索工具不得在 `full` surface 以 model-facing 形态注册**（否则 0.86.0–0.87.x 上违反基线），以及 **A 形态的可用性以"codemode 已加载且已激活"为前提**（本仓的 `subagents` surface 判定本来就要求这两者同时成立）。

## 8. 未核实清单

以下都是**本次没有核到底**的部分，不做推断：

1. **没有跑真实 pi 会话做端到端复现。** 全部结论来自 1.3.0 / 0.99.0 / 0.86.0 编译产物与官方 `docs/` 的静态阅读。静态证据链完整（脚本侧 API → 宿主 → `execute()` 三跳都能指到具体行），但**没有观测到一次真实的"codemode 脚本调用扩展注册的 `exposure: "codemode"` 工具"**。仓库里有一条同形状的负向实测（`docs/research/dispatch-loop-e2e-spike-20261016.md`：脚本工具表里没有 `pi.dispatch`），它测的是 PTC binding，不是 pi 注册工具。
2. **`exposure` 首次出现的精确版本没有逐版本核。** 只独立核了 0.86.0（无）与 0.99.0（有）两点；0.87.0 / 0.87.1 的 ✗ 来自本仓既有矩阵（`docs/agents/pi-compat-matrix.md:59-77`），本次未独立复核。
3. **`tool_search` 与 `codemode` exposure 扩展工具的交互未核。** 官方文档只说 `deferred` 工具可被 `tool_search` 找到（`docs/cli.md:156`、`docs/mcp.md:226`）；`codemode` exposure 的扩展工具是否也会被 `tool_search` 命中，没有查证。
4. **pi 是否自带会读 `reachesTools` 的权限扩展，未核。** 全 dist 搜 `reachesTools` 的消费方只有四处：`agent-session.js:1091`（上报用）、`mcp/index.js:1044-1059`（等 server 就绪）、`codemode/tool.js:266`（声明用）、`tool-search/tool.js:170`。没有找到权限扩展消费它，但这不等于 pi 没有权限扩展。
5. **桥的字节上限没有压测。** 没找到显式上限（§3.4），但"多大的工具结果能稳稳过桥"没有实测。
6. **`codemode.mode`（`on`/`only`）与 `codemode.inlineBudget` 的运行时行为**是从源码读的，没有实际切换设置观测。
7. **上游 GitHub 仓库源码没有查。** 编译产物里已含实现与注释，本次不需要；但"上游是否有未发布/已发布但未进 dist 的分支"没有核对。

## 9. 快照与复核命令

### 9.1 快照

| 项                       | 值                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| 仓库 HEAD                | `64de4bd`（`git log --oneline -1`）                                                                    |
| tree 里的 pi             | `@earendil-works/pi-coding-agent@1.3.0`（`node_modules/@earendil-works/pi-coding-agent/package.json`） |
| tree 里的 pi-codemode    | `@earendil-works/pi-codemode@1.3.0`（pi 的 `dependencies` 里锁死同版本）                               |
| tree 里的 pi-agent-core  | `@earendil-works/pi-agent-core@1.3.0`                                                                  |
| 本仓 declared peer range | `>=0.86.0`（`package.json`）                                                                           |
| 跨版本取证产物           | `/tmp/pi-ver/v0860/package`、`/tmp/pi-ver/v0990/package`                                               |

### 9.2 复核命令（逐条可粘贴）

```bash
# §0.1 / §2 —— 扩展工具进 codemode 脚本工具表
cd node_modules/@earendil-works/pi-coding-agent
grep -n "_getCallableTools(active" -A 6 dist/core/agent-session.js          # :1148-1153
grep -n "_isDeclarable(name)" -A 4 dist/core/agent-session.js              # :2926-2929
grep -n "getCodemodeCallableTools(ctx.tools)" dist/extensions/codemode/execute.js   # :401
grep -n "ctx.executeTool(tool.name, args" dist/extensions/codemode/execute.js       # :421

# §2.2 —— execute() 跑在宿主主线程
grep -n "new Worker(options.workerUrl" ../../.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/dist/runtime/host.js  # :30
grep -n "prepared.tool.execute(" ../../.pnpm/@earendil-works+pi-agent-core@1.3.0_*/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js

# §3 —— 序列化
grep -n "serialize(spread ? args : args\[0\])" ../../.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js  # :199
grep -n "JSON.parse(message.args)\|JSON.stringify(value)" ../../.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/dist/runtime/execution.js  # :318/:320
grep -n "function toScriptValue" -A 9 dist/extensions/codemode/execute.js     # :370-378

# §4 —— MCP 与扩展工具同一条路
grep -n "pi.registerTool(definition)" dist/extensions/mcp/index.js           # :336
grep -n "exposure: toToolExposure(options.exposure)" dist/extensions/mcp/tools.js  # :251
grep -n "client.callTool(tool.name" dist/extensions/mcp/tools.js             # :257

# §5 —— 跨版本
cd /tmp/pi-ver
npm pack @earendil-works/pi-coding-agent@0.86.0 && mkdir -p v0860 && tar xzf earendil-works-pi-coding-agent-0.86.0.tgz -C v0860
ls v0860/package/dist/extensions/                       # 没有 codemode
grep -rn "exposure\|executeTool\|structuredContent" v0860/package/dist --include=*.d.ts --include=*.js | grep -v bundle   # 零命中
npm pack @earendil-works/pi-coding-agent@0.99.0 && mkdir -p v0990 && tar xzf earendil-works-pi-coding-agent-0.99.0.tgz -C v0990
grep -n "ToolExposure" v0990/package/dist/core/extensions/types.d.ts         # :388

# §1.2 / §6 —— 本仓侧
cd /Users/lilianda/develop/pi-ptc-subagents
grep -n "DISPATCH_BINDING_NAME" src/runtime/bindings.ts                      # :58
grep -n "PTC_BINDING_REACH_NOTE" -A 4 src/tools/common.ts                   # :201-204
grep -n "programmingToolExposure" src/index.ts                               # :485 起
```

### 9.3 官方文档出处

- `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:153-183` —— "Tool exposure" 一节，官方对 `direct` / `model-only` / `codemode` / `deferred` / `hidden` 的定义，以及"Callable means callable from other tools through `ctx.executeTool()` (`ctx.tools`), as the `codemode` tool's scripts do"。
- `node_modules/@earendil-works/pi-coding-agent/docs/codemode.md` —— 脚本全局、调用约定、输出与限额。
- `node_modules/@earendil-works/pi-coding-agent/docs/mcp.md:189-226` —— MCP 的 exposure 语义。
