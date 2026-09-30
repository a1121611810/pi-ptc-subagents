# PTC 上游对照审计（2026-09-30）

> 方法：全部结论取自**一手来源**，不采信本仓库自述。
>
> - DSH 权威源：`/tmp/dsh-research/deepseek-harness`（上游 clone，tag `dsh-v0.2.0-rc.2`，remote `github.com/deepseek-ai/deepseek-harness`）
> - DSH 已发布产物：`app.asar/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node`（`0.2.0-rc.2`）
> - pi 宿主契约：`node_modules/@earendil-works/pi-{ai,coding-agent,tui}`（随包发布的一手 docs + examples + `.d.ts`）+ 上游 `v0.99.0` release notes / docs
> - 被审对象只看 `src/` `tests/` `package.json`，**不采信本仓库 docs/README/CONTEXT/ADR**
> - 六个子代理并发分轴调研（DSH 核心 / 工具面 / 沙箱 / 呈现层 / pi 契约 / 上游 web）

---

## 0. 结论

### 🔴 第一结论：宿主已经原生实现了这个功能

**pi v0.99.0（发布于 2026-09-29T17:21:54Z）内置了 `codemode`——pi 自己的 PTC。**
本仓库 v1.1.1 发布于 2026-09-30。**两者相差一天。**

一手依据（[v0.99.0 release notes](https://github.com/earendil-works/pi/releases/tag/v0.99.0)）：

> Added codemode, tool search, and MCP support as built-in extensions. The `codemode` tool runs model-written **JavaScript in a QuickJS sandbox** that calls pi's tools; enable it with `defaultTools` or `--tools` and configure it with `codemode.mode` and `codemode.inlineBudget`.

[pi `docs/cli.md` v0.99.0](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/cli.md)：

> Codemode scripts run in a **QuickJS sandbox** that can only reach the other tools, through `tools.<name>(args)`; `ALL_TOOLS` lists them. Output comes from `text(value)`, `image(dataUrlOrImageContent)`, `console.*`, and a top-level `return value`…

> `codemode.mode` decides how the other tools are presented. With `on` (default) declared tools keep being declared… With `only` they are hidden from the model and listed in the `codemode` description instead.

> The `codemode` description lists the callable tools with their **TypeScript declarations**, grouped by namespace… share a budget of **3000 estimated tokens**… Scripts find the rest with `await searchTools(query, { limit, namespace })`, which ranks tools with **BM25**, and `await describeTool(name)`.

> `store(key, value)` and `load(key)` keep JSON values across `codemode` calls… each branch sees only the values written on its path.

同一 release 还带来：`exposure: direct | model-only | codemode | deferred | hidden`、`ctx.executeTool()` 嵌套调用（事件带 `parentToolCallId`，结果记 bounded `nestedCalls`）、`prepareLoadout()`、`structuredContent`/`outputSchema`/`isError`、bash/powershell 在 codemode 下 **1 MiB** 结构化结果 + `truncated` + `full_output_path`，以及 `pi config` 里可整体关闭内置扩展（`-builtin:codemode`）。

### 功能对照：本项目做的每一件事，上游都已经有了

| 本项目                                                                              | pi v0.99.0 内置                                                                                      | 状态                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/ptc on/off` 收窄模型可见工具面                                                    | `codemode.mode: on \| only`                                                                          | **被覆盖**                          |
| 工具描述里两行手写示例（`run-code.ts:47-48`）                                       | 自动生成的 TS 声明，3000 token 预算 + BM25 `searchTools`/`describeTool`                              | **被超过**                          |
| 固定 7 名绑定白名单（`bindings.ts:41-49,64`）                                       | `exposure: codemode` + `ALL_TOOLS` + `tool_search`                                                   | **被覆盖**                          |
| `sub-call-tracker.ts` + 子调用树                                                    | `ctx.executeTool()` + `parentToolCallId` + bounded `nestedCalls`（compaction 与 HTML export 已消费） | **被覆盖**                          |
| ADR-0015 截断契约 50 KB / 2000 行                                                   | codemode 下 1 MiB + `truncated` + `full_output_path`                                                 | **被超过**                          |
| 沙箱票组 #72–#81（8 票 / 20 commit 孤儿分支）                                       | **QuickJS 沙箱，模型 JS 完全碰不到宿主**                                                             | **被完全解决**                      |
| `bash` 以无沙箱形式交给模型 JS                                                      | 模型 JS 在 QuickJS 里，**无法**执行 `bash`                                                           | **风险被上游消除**                  |
| **后台派发**：`pi.dispatch({background:true})` + 6 态 TaskRecord + 3 个常开管理工具 | 无对等物（codemode 每次调用独立，只有 per-branch `store`）                                           | **✅ 本项目唯一未被覆盖的原创价值** |

### 第二结论：DSH 侧的三条基线也全部停在过去

| 基线     | 本项目                                                       | 上游真值                                                                      |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| DSH 版本 | `dsh-v0.1.6-alpha.2`（`src/runtime/limits.ts:4` 自述）       | `dsh-v0.2.0-rc.2`                                                             |
| pi SDK   | `pi-ai@0.86.1` / `pi-coding-agent@0.86.1`（**无 codemode**） | pi `v0.99.0`（含 codemode）                                                   |
| 宿主沙箱 | 无                                                           | pi `docs/security.md:31-41`：故意没有，但自带 `sandbox/`/`gondolin/` 官方示例 |

**时间线**：

```
2026-06-15  DSH PTC 基础决策（源自 Cloudflare Code Mode）
2026-09-03  DSH v0.1.2-rc.1：该特性此前名为 "Code Mode"，此后改名 PTC
2026-09-11  DSH《Sandboxed Node execution for PTC》—— 明文 supersede worker 执行模型
2026-09-23  DSH v0.1.7-rc.1：破坏性变更——包/服务改名进 ptc-runtime 族（无 legacy alias）、
            workflow executor → workflow-ptc、**Node PTC 迁到独立进程**
            ← 本项目钉的就是它前一个版本 v0.1.6-alpha.2
2026-09-21  ← 本仓库 Initial commit
2026-09-29  pi v0.99.0 发布，内置 codemode（pi 自己的 PTC）
2026-09-30  ← 本仓库 v1.1.1 发布
```

**本项目钉的 `v0.1.6-alpha.2`，正好是 DSH 把 Node PTC 迁到独立进程的那个破坏性版本（`v0.1.7-rc.1`）的前一个。** 也就是说，本项目复刻的是 DSH 明确宣布要废弃的那一代架构，而且钉在了废弃前夜。

---

## 1. PTC 原本是什么（DSH 权威定义）

DSH 的 PTC 源头不是自创，是 **Cloudflare Code Mode**（`2026-06-15-ptc.md` 开篇即引）。

> 核心观察：LLM 更擅长写代码，而不是逐个发 tool call——因为它们读过几百万行真实代码，而 tool-calling trace 是人造格式。模型改为**对着生成的 API 写 TypeScript 程序**，程序在沙箱运行时里执行，**模型自己裁剪什么回来**（只 `print`/`return` 需要的），而不是每个中间结果都回灌上下文。

机制要点（全部一手引用）：

| 事实                                                                                                                                                                                                                                                                              | 依据                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 程序是 **async 函数体**，不是文件/模块。宿主包一层 `async function __dsh_program__() {` + code + `}`，走 `stripTypeScriptTypes`                                                                                                                                                   | `dsh-ptc-runtime-node/lib/index.js:755-756, 930, 933`           |
| 子进程用 `new AsyncFunction(...,`'use strict';\n`+code)(...)` 重新物化                                                                                                                                                                                                            | `lib/process.js:1027-1030`                                      |
| 每次调用**一个新进程**，`isolation="process"`，one-shot 无状态                                                                                                                                                                                                                    | `index.js:782-783`；`README.md:128-129`                         |
| 工具集是**调用方 Agent 的可见注册表视图**，不是固定集；排除 `run_code` 自身；null 原型；每个绑定 `deepFreeze`                                                                                                                                                                     | `dsh-tools/lib/types/ptc.js:571-590`                            |
| 参数与返回值都必须是 **lossless JSON**，`undefined` 返回即失败                                                                                                                                                                                                                    | `process.js:958-962, 1117-1118`                                 |
| wire 是**扁平前序 token 流**（与数据深度无关），拒绝稀疏数组/`undefined` 属性/非有限数/`-0`/symbol 键/重复键                                                                                                                                                                      | `index.js:588-623, 675-751`                                     |
| **模型看到的只有一段扁平文本**：`logs.join('\n') + renderValue(result)`，空则 `"(run_code completed with no output)"`                                                                                                                                                             | `dsh-tools/lib/types/ptc.js:281-289`                            |
| **PTC 不能递归 PTC**——结构上不可能：`run_code` 不在自己的绑定集里；全路径**没有深度计数器**。**但 PTC 程序可以派生子代理**：`subagent` 是普通注册工具，因此在绑定集里，`await tools.subagent({...})` 可用；桥接时设 `parent: exec.token` 使 `collapses(...,nested=true)` 为 false | `ptc.js:577-578`；`dsh-tools/lib/index.js:3099-3101, 1296-1310` |
| 失败种类 8 个：`exception \| timeout \| abort \| worker-exit \| invalid-output \| output-limit \| protocol \| sandbox-unavailable`                                                                                                                                                | `index.js:1019-1172`                                            |
| 程序结果永远 **resolve**，只有调用方误用才 reject；失败一定以 `CodeRunFailedError` 抵达模型                                                                                                                                                                                       | `ptc.js:604-609, 122-127`                                       |
| 图片只走**延迟上下文消息**（`source:{kind:'ptc-mode'}`），传输层本身是纯 JSON                                                                                                                                                                                                     | `ptc.js:524-529`                                                |
| 预设值：`timeoutMs 120000` / `maxTimeoutMs 600000` / `maxOutputBytes 67108864` / `maxOldGen 512` / `maxMessageBytes 134217728` / `maxPendingCalls 128` / `graceMs 3000` / `maxParallelSubCalls 10`                                                                                | `index.js:771-781`；`dsh-tools/lib/types/index.js:222`          |

**并发契约（对本项目影响最大的一条）**：分类 **fail-closed**——只有 `isConcurrencySafe` 精确返回 `true` 才算 `parallel`，未知/隐藏/未声明/抛异常一律 `exclusive`；`exclusive` 调用会**排空整个池独占运行**。`dsh-tools/lib/types/index.js:685-696, 363-366`

---

## 2. 最重要的发现：pi 自己就发布了答案，本项目没看

pi 的 `docs/extensions.md` 里有一节 **"Remote & Sandbox"**，列出三个官方示例，全部真实存在于 `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`：

| 示例        | 大小    | 做什么                                                                                                                                                                                                       |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox/`  | 9.0 KB  | **用 `@anthropic-ai/sandbox-runtime` 做 OS 级沙箱**：macOS `sandbox-exec`、Linux `bubblewrap`；网络按域名 allow/deny；文件 `denyRead`/`allowWrite`/`denyWrite`；经 `createBashTool` 的 `BashOperations` 注入 |
| `gondolin/` | 16.6 KB | **`@earendil-works/gondolin@0.12.0` 微 VM（QEMU）**，把**全部七个内建工具**（`createBashTool/createEditTool/createFindTool/createGrepTool/…`）路由进 VM，`/workspace` 写穿透                                 |
| `subagent/` | 35.7 KB | 官方子代理扩展（每子代理独立 `pi` 进程），含 `agents/`、`prompts/` 工作流预设                                                                                                                                |

```ts
// examples/extensions/sandbox/index.ts:5-8
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
```

**这直接击穿了本仓库 8 张 sandbox 票（#72–#81）和那条 20 commit 的孤儿分支的价值判断**：

- 本项目孤儿分支手搓了 `src/runtime/sandbox-runner.ts`（486 行）的 `buildSeatbeltProfile`（macOS sandbox-exec）、`detectSandboxFacts`（Linux bwrap）、win32 fail-closed——**正是 pi 示例里 `@anthropic-ai/sandbox-runtime` 已经封装好的部分**。
- 本项目票 #78「把进程隔离扩展到其余 7 个内建 binding」——**pi 的 `gondolin/` 示例已经逐个覆盖了那 7 个工厂**。
- 本项目票 #75 想加的"网络按域名放行/拒绝"——pi 示例的配置里直接有 `allowedDomains`/`deniedDomains`；本项目的 ADR 方案只有 Node 25+ 的 `--allow-net` 二值开关。
- 本项目的 `bash` 沙箱方案是 `~/.pi/agent/ptc.json`；pi 示例用的是 `~/.pi/agent/extensions/sandbox.json` + `<cwd>/.pi/sandbox.json`，**同一个 seam 形状**。

> 公平地说：项目自己的 ADR-0024（只存在于孤儿分支）确实提到了 "Gondolin micro-VM，pi 的官方路径"。但**那条分支不在 main 上**，所以这条认知事实上没有进入任何在跑的决策。

---

## 2.5 规模与机制差距（第二轮并发调研补齐）

| 维度            | DSH                                                                                                                                                                                     | 本项目                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 工具总数        | **45**（含 9 个实验性 agent-team 工具）                                                                                                                                                 | **5**（`ptc_run_code`/`ptc_workflow`/`ptc_task_*`）   |
| 呈现面          | **两个独立渲染器**：Trajectory 虚拟化账本 + Chat 嵌套展开树，**无共享渲染器**                                                                                                           | 一个 TUI 行渲染器                                     |
| "…+N more" 折叠 | **不存在**。子调用全量渲染；计数器只出现在 turn/assistant 折叠摘要里                                                                                                                    | `…+N more phases` / `…+N more tasks` 等（本项目自创） |
| 结果体积治理    | **三层、单位各不相同**：pruner（字符，8192/4096/1024，**仅在 compaction 触发**）/ output-retention（字节，UTF-8 安全）/ spill-policy（token，`maxInlineTokens` **无默认**，省略即禁用） | 单层（本项目 ADR-0015 截断契约）                      |
| 工具级上限      | 逐工具表：read 2000 行 / 2000 字符每行 / 50 KiB；bash 尾部 64000 + spill 64 MiB；glob 100；grep 250；web_fetch 200000；ralph 256 轮                                                     | 无逐工具表                                            |
| 工具超时        | `dsh-tool-call-timeout-policy` **只对声明了 `timeoutMs` 的工具有效**，且**不杀工具**，只替换结果为 `TOOL_TIMEOUT`；bash/pwsh 刻意退出该策略                                             | 单一 run 级 deadline                                  |
| 子代理上限      | `maxDepth` 默认 **1**、`maxActiveSubagents` 默认 **8**                                                                                                                                  | `maxDispatchDepth: 3`、`dispatchConcurrency: 8`       |

> **本报告的一次自我更正**：初稿曾写"DSH 不给普通 PTC 程序派生子代理的能力"。**这是错的**，已按 `dsh-tools/lib/index.js:3099-3101` 与 `:1296-1310` 更正——`subagent` 确实在绑定集里且可并发启动 10 个。保留这条更正是为了标明：本项目 `pi.dispatch` 放进绑定集**不是**相对 DSH 的越权，差别在别处（见 B1：本项目做的是**跨进程、长生命周期、持久化**的后台派发，DSH 的是一次性 + continuable 两种形态且 `maxDepth=1`）。

## 2.6 pi 宿主契约（第三轮并发调研）

**审计方法学警告**（这条本身就会让人审计错）：pi 的公开契约**不是** `dist/index.d.ts`——那是个 36 行的 re-export barrel，真正的形状全在 `dist/core/extensions/types.d.ts`（1360 行）。**从 barrel 出发审计只能看到名字，看不到类型。** 本报告的 pi 侧结论均取自后者与 `docs/`。

| 事实                                                                                                                                                                                                                                                                | 依据                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 生命周期事件 **37 个**（不是更少）；权威触发顺序图在 docs                                                                                                                                                                                                           | `types.d.ts:912-948`；`docs/extensions.md:277-349`    |
| 8 个内建工具都支持注入 `*Operations`（远程/VM 接缝）                                                                                                                                                                                                                | `types.d.ts` 各 `*Operations`                         |
| `withFileMutationQueue()`：变更类自定义工具**必须**用，因为工具调用默认并行                                                                                                                                                                                         | `docs/extensions.md:1964-1991`                        |
| Compaction **按 span 裁剪**，不是逐工具结果；**全包不存在工具结果落文件**                                                                                                                                                                                           | `reserveTokens 16384` / `keepRecentTokens 20000`      |
| 审批 100% 在用户态：`tool_call` 钩子返回 `{block, reason, terminate}`；**`terminate` 只有当批次内每个 result 都设置时才生效**；参考实现 `permission-gate.ts:13-33`，`!ctx.hasUI` 时 fail-closed                                                                     | `types.d.ts:820-829`                                  |
| `@earendil-works/pi-agent-core` 里的 `AgentHarness`（具名通道：accept/drive、steer/followUp、`Result<T,E>`、30+ 事件、11 钩子、`DriveOutcome`）**从扩展里今天就能用**（虚拟模块），但**没被 barrel re-export、不在 `ExtensionAPI` 上、`extensions.md` 里 0 次提及** | `agent-harness.d.ts:617-715`；`virtual-modules.js:20` |
| 8 处 doc ↔ `.d.ts` 互相矛盾（含：示例代码返回 `isError` 而类型里没这字段；`executionMode`/`constrainedSampling` 有声明无文档）                                                                                                                                      | 报告 §10 D1–D8                                        |

### 两处需要修正/新增的判断

**① 修正我自己上一版 R1 的措辞。** 我曾写"pi 没有 approval seam"。**过强。** pi 没有 DSH 那种一等公民的 `ctx.approval` 服务，但它**有** `tool_call` 钩子 + 一份可抄的参考实现（`permission-gate.ts`），语义是 fail-closed 的。**所以"给 PTC 的危险 binding 加人工确认"在 pi 上是可做的**，不需要等宿主。代价是要自己实现 UI 与 `!ctx.hasUI` 分支。

**② 一个我在核查中差点误报、核查后确认不是 bug 的点。** pi 的 `subagent` 示例用 `0o600` 临时文件传 system prompt，本项目也这么做（`dispatch.ts:913-917` 的 `mkdtemp(os.tmpdir(), "pi-dispatch-")` + 0o600），但**没有用 `withFileMutationQueue`**。初看像漏了——**核查后确认不需要**：该队列防的是"对同一个用户可见文件做 read-modify-write 被并发覆盖"，而临时 prompt 文件是每次调用新建的私有文件，不存在共享目标。

**③ 但由此暴露一个真问题（属于本项目独有贡献的固有代价）**：`withFileMutationQueue` 的保护是**进程内**的。本项目的后台派发子进程会在**另一个进程**里对用户真实文件跑 `edit`/`write`。于是——**父 PTC 程序的 `edit` 绑定与后台 dispatch 子进程并发改同一个文件时，pi 提供的这层保护失效，且没有任何机制能跨进程协调。** 这是"后台派发"这个原创能力自带的边界，DSH 侧不存在（它 `maxDepth=1` 且不跨进程持久化），pi `codemode` 侧也不存在（QuickJS 内一次性）。**建议在 `pi.dispatch` 的文档与工具描述里明写这条限制，而不是让它默默存在。**

## 3. DSH 有 / 本项目缺

| #   | DSH 有                                                                                                                                                                                             | 依据                                                                                                                                 | 本项目状态                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **OS 沙箱**，与 Bash **共用同一 policy provider**，fail-closed，缺后端 ⇒ `sandbox-unavailable`                                                                                                     | `dsh-sandbox/lib/index.js:276-281`；`ptc-runtime-node/lib/index.js:950-953`                                                          | 无。ADR-0007 写死"no OS sandbox"                                                                                                 |
| A2  | **三档文件策略** `read-only \| workspace-write \| danger-full-access`（部署默认 `read-only`），随结果回报 `sandbox{mode,denied,enforcement}`                                                       | `dsh-sandbox-policy/lib/index.js:26-30,102`；`ptc.js:263-280`                                                                        | 无。孤儿 ADR 改成了 `processIsolation`+`jsHardening` 两轴，与 DSH 不同构                                                         |
| A3  | **人工审批 / 提权**：两个旋钮（sandbox 模式 × `ask\|never`）打成 preset；结果词表恰好四值，**`allowed-once` 是唯一授权，全局不存在"总是允许"**；**只有一件事需要人：沙箱提权重试**，走严格递增阶梯 | `dsh-user-approval/lib/types/index.js:17,15`；`dsh-permission-presets/lib/index.js:138-159`；`dsh-sandbox/lib/index.js:30-33,99-123` | 无。**整个 sandbox 票组都没考虑审批**                                                                                            |
| A3b | **子代理恒定钉在 `approval:'never'`**，子进程永远不能重新向人发问                                                                                                                                  | `dsh-subagent/lib/types/child-agent.js:185-192`                                                                                      | 无对应概念                                                                                                                       |
| A4  | **生成的 TypeScript SDK 段**注入系统提示：`ToolArgsMap`/`ToolOutputMap`/`ToolCallError` 全量声明                                                                                                   | `ts-types.js:270-290`                                                                                                                | 无。只有工具描述里两行手写示例（`run-code.ts:47-48`）                                                                            |
| A5  | **绑定集 = Agent 可见注册表**（其他扩展的工具可作为 binding）                                                                                                                                      | `ptc.js:571-580`                                                                                                                     | 固定 7 名白名单（`bindings.ts:41-49, 64`）                                                                                       |
| A6  | **并发分类 fail-closed**，exclusive 排空独占                                                                                                                                                       | `index.js:685-696, 363-366`                                                                                                          | 无分类。模型被告知"independent calls may overlap under `Promise.all`"（`run-code.ts:50`）——**把 `bash` 和 `write` 也说成可并发** |
| A7  | **`tool/ptc-dispatch-start`/`tool/ptc-dispatch`** 可观测事件，含 `rootCallId/parentCallId/subCallId`                                                                                               | `ptc.js:496-502, 470-482, 431`                                                                                                       | 无                                                                                                                               |
| A8  | **原型污染加固**：模块加载时捕获 Node intrinsics 全程使用；绑定 ns 为 `Object.create(null)`；`__proto__` 变普通自有键                                                                              | `ptc-runtime-node/lib/index.js:42-52, 492-512`；`process.js:952-955`                                                                 | **无**（grep intrinsics/`Object.create(null)` 命中 0）                                                                           |
| A9  | **Python 后端**（`ctx.ptcRuntime.language` 分派）                                                                                                                                                  | `py-types.js`；`2026-07-31-ptc-runtime-python-fd3-protocol.md`                                                                       | 仅 TypeScript                                                                                                                    |
| A10 | `timeoutMs: null` = 无 deadline（workflow 用；`run_code` 只收正数）                                                                                                                                | `index.js:837`；`workflow-ptc/lib/index.js:425`                                                                                      | 未实现                                                                                                                           |
| A11 | `maxConcurrentAgents`(0→min(16,cpu-2)) / `maxTotalAgents`(1000) / `syncTimeoutMs`(5000)                                                                                                            | `workflow-ptc/lib/index.js:585-591, 619`                                                                                             | 自述"deliberately absent"（`limits.ts:9-11`）——**workflow 无任何 agent 上限**                                                    |
| A12 | `console.inspect` 有界 `{depth:4, maxArrayLength:100, maxStringLength:1e4}`                                                                                                                        | `process.js:825-829`                                                                                                                 | 只有 `depth:4`，**无 maxArrayLength/maxStringLength**（`worker-main.ts:388`）                                                    |

### 3.1 DSH 沙箱的关键细节（常被误读，必须一并记录）

- **同一份策略，代码走两套机制**：shell 命令由真正的 OS 内核原语约束（macOS Seatbelt `sandbox-exec`、Linux bubblewrap→Landlock、Windows `WRITE_RESTRICTED` token + 低完整性 + DACL）；而 agent 自己的 `fs` 工具改文件**只**由进程内 JS 路径检查兜着——源码自己写明：

  > _"This is containment, not a security boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job"_ —— `dsh-fs-sandbox/lib/index.js:80-85`

  即：**恶意子进程被关住，恶意插件关不住**。任何用单一机制覆盖两者的移植，都误读了 DSH。

- **DSH 完全没有网络策略**：任何平台任何档位都没有。bwrap 参数无 `--unshare-net`，Seatbelt 开 `(allow default)`。全部 sandbox 包 grep "network" 只有一处，且是限制说明。（**注意：pi 的 `sandbox/` 示例反而更强**——它有 `allowedDomains`/`deniedDomains`。）
- **DSH 对 bash 轴没有任何内存/CPU 强制**：grep ulimit/rlimit/setrlimit/cpus = 0 命中。只有定时器和缓冲上限，且源码明确称其为协作式、非安全边界（`dsh-timeout/lib/index.js:3-5`；`dsh-tool-call-timeout-policy/lib/index.js:3-6`）。PTC 轴另有 V8 堆上限（`--max-old-space-size=512`）。
- **fail-closed 4 处**：无后端（错误文案字面写着 _"refusing to run the command unconfined"_，`dsh-sandbox-local/lib/index.js:492,499,511`）、运行中 runner 崩溃、无 answerer、answerer 抛异常。
- **最大的 fail-open**：进程树终止收敛失败时**只 warn 一次，进程照常跑**（`dsh-subprocess-local/lib/index.js:1396-1403`）——在 macOS 上这是**所有普通进程**走的路径。
- **防"根本没挂后端"的那道闸**是 `dsh-permission-presets` 拒绝加载到没有 `sandboxMode` 的执行器上（`dsh-permission-presets/lib/index.js:177`）。**pi 没有对应的 preset 插件**。

## 4. 本项目有 / DSH 没有（真正的增量，需保留）

| #   | 本项目                                                                               | 依据                                                           | 评价                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **后台派发**：`pi.dispatch({background:true})` + 6 态 TaskRecord + 三件常开管理工具  | `src/runtime/dispatch.ts`(1435 行)、`task-registry.ts`(884 行) | DSH 的 `workflow` 工具有 `runInBackground`+`jobId`（`dsh-tool-workflow/lib/index.js:337-377`），但没有这套订阅/游标/持久化。**这是本项目最扎实的原创贡献** |
| B2  | **owner-scoped reaping**（`ownerPid`/`ownerBootMs`），修掉"子进程互删任务"的真实事故 | `src/runtime/task-registry.ts:456-467`                         | DSH 无对应概念。**真机驱动的好设计**                                                                                                                       |
| B3  | 渲染上限体系（`render.ts` 8 项 + `task-panel-render.ts` 5 项）                       | `src/tools/render.ts:78-85, 305-307`                           | DSH 模型面是**一段扁平文本**（`ptc.js:281-289`），本项目自建了多块树。**这是一次未对照上游基准的架构分叉**，收益（可读性）未量化，代价（上下文成本）未测量 |
| B4  | `ptcBindings` 全局暴露本次实际绑定名                                                 | `worker-main.ts:836`                                           | DSH 用静态生成的 .d.ts，无需运行时兜底。**是对 A4 缺失的合理补偿**                                                                                         |
| B5  | lossless-JSON 返回值校验                                                             | `worker-main.ts:312-344, 483`                                  | ✅ 与 DSH 一致                                                                                                                                             |
| B6  | 程序化 `ToolCallError`                                                               | `worker-main.ts:149-153`                                       | ✅ 与 DSH 一致                                                                                                                                             |

## 5. 风险排序

### 🔴 R1 — 已发布版本把无沙箱 shell 交给了模型

`main`（= npm `latest` 1.1.1）上 `DEFAULT_BINDING_NAMES = BUILTIN_BINDING_NAMES`（`bindings.ts:64`），含 `bash`；而工具描述**主动指导模型去用**它：

```ts
// src/tools/run-code.ts:47
`await tools.read({ path: "src/index.ts" })` or `await tools.bash({ command: "npm test" })`.
```

pi 宿主对这件事的官方表态（`node_modules/@earendil-works/pi-coding-agent/docs/security.md:31-41`）：

> **No Built-in Sandbox.** …Extensions are TypeScript modules that run with the same permissions. …**This is intentional.** …A partial in-process sandbox would be easy to misunderstand as a security boundary… **Real isolation needs to come from the operating system or a virtualization/container boundary.**

即：宿主把"无沙箱"当作**已知且故意的**边界，并把加固责任推给 OS/容器。DSH 的做法是让 PTC 与 Bash **共用** OS sandbox provider。**本项目既没有共享，也没有 OS 层，还额外用提示词把模型往那个方向推。**

**而这条风险在 pi v0.99.0 之后已经有一个现成解**：`codemode` 把模型 JS 关进 QuickJS，模型 JS 根本触达不到宿主 bash，也就无所谓"bash 有没有沙箱"。本项目在 `--tools` 里加 `bash` 绑定、并用提示词教模型用它，等于**主动放弃了宿主刚提供的隔离**。

### 🟠 R2 — 8 张 sandbox 票在解一个 pi 明确不打算解的问题

pi 没有 sandbox seam、没有 permission/approval seam。孤儿分支那 20 个 commit 手搓了 `sandbox-exec`/bwrap/Node `--permission` 三套机制，**而 pi 的 examples 目录里就有一份基于 Anthropic 维护包的可运行实现**。按现状投入 #75–#81，等于**重造轮子且造得更弱**（无域名级网络策略）。

### 🟠 R3 — 并发语义与上游相反

DSH fail-closed 分类，mutating/exclusive 调用排空独占。本项目无条件告诉模型"independent calls may overlap under `Promise.all`"。模型若照做并发 `bash`/`write`，本项目**不会拦**。

### 🟡 R4 — 模型面输出未对照上游

上游明确设计目标是"**只回灌模型自己 print/return 的东西**"。本项目给模型的是自建多块树 + 13 项字符/行数上限。方向未必错（可读性），但**从未与上游做过对照测量**，而这正是 PTC 立项理由本身（省上下文）。

### 🟡 R5 — 孤儿分支风险（上一轮已报）

20 个 commit 只挂在 `backup/undo-20260929-120935-main`。若 `git gc` 或误删 tag，本项目**永久丢失**那套手搓沙箱。好消息是按 R2 它本来就不该合并。

### 🟢 R6 — 版本漂移

DSH `v0.1.6-alpha.2` vs `v0.2.0-rc.2`；pi `0.86.1` vs DSH 用的 `0.87.1`。`limits.ts:4` 的自述需要更正。

---

## 6. 建议

### 立刻（本周）

1. **升级 pi 到 ≥ 0.99.0，先跑通 `codemode`。** 当前 `peerDependencies` 是 `>=0.86.0`，不会自动升。装上 `defaultTools: ["+codemode"]` 后，用**同一批真实任务**对比三档：
   - A：本项目 `ptc_run_code`（现状）
   - B：pi `codemode.mode=only`（原生）
   - C：本项目挂在 codemode 之上（只保留后台派发）
     量：模型成功率、上下文 token、墙钟。
2. **保住可恢复性**：`git branch sandbox-recovery backup/undo-20260929-120935-main`，但**明确标注"不合并"**——按 R2/R1，pi 的 `sandbox/` 与 `gondolin/` 已覆盖其价值且更强。
3. **更正 `src/runtime/limits.ts:4`** 的版本自述（`dsh-v0.1.6-alpha.2` → `dsh-v0.2.0-rc.2`），并把 DSH 基线说明补上"2026-09-11 已 supersede worker 模型，本项目实现的是被弃用的那一版"。

### 战略（需要你拍板，这是分叉点）

**问题**：本项目与 pi 内置 codemode 正面重叠。还继续做第 N 个 PTC 实现，还是转型？

| 路线          | 内容                                                                                                                                    | 代价                   | 适合                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- |
| **S1 收敛**   | 弃 `ptc_run_code`/`ptc_workflow`，只保留**后台派发**（唯一未被覆盖的能力），并考虑把它接到 pi 新的 `ctx.executeTool()`/`nestedCalls` 上 | 砍掉大部分代码         | 想要长期维护           |
| **S2 差异化** | 保留 `ptc_run_code`，但明确打差异化牌：Node 全 API（codemode 只有 QuickJS 子集）、暖 worker 复用、`pi.dispatch` 派生子代理              | 需长期独自承担宿主升级 | 想做"DSH 式全能力 PTC" |
| **S3 并行**   | A/B/C 三档并存，开关切换，用数据决定                                                                                                    | 短期最贵               | 还没想清楚             |

**我的判断：S1 或 S3。** 理由是 S2 的差异化在宿主侧正在被逐步侵蚀——`exposure`、`ctx.executeTool()`、`prepareLoadout()`、`structuredContent` 这些 API 一出现，本项目手搓的对应机制就开始变成维护负担而非资产。

### 无论走哪条都要做的（技术债，与战略无关）

4. **默认面收窄**：默认绑定去掉 `bash`/`write`/`edit`，只留只读；`bash` 走显式 opt-in。成本极低（复用现有 `/ptc` 机制），**不依赖任何沙箱基础设施**，且直接消除 R1。
5. **对齐并发语义**：引入 fail-closed 分类，至少把 `bash`/`write`/`edit`/`pi.dispatch` 标为 exclusive，修正 `run-code.ts:50` 那句"independent calls may overlap under `Promise.all`"——当前措辞在鼓励模型并发执行变更类调用。
6. **补原型污染加固**：DSH 在模块加载时捕获 Node intrinsics 全程使用，绑定命名空间用 `Object.create(null)`，`__proto__` 变普通自有键（`ptc-runtime-node/lib/index.js:42-52,492-512`；`process.js:952-955`）。本项目 grep 命中 0，而它跑的是**暖 worker 复用**（跨多次运行共享 realm），污染残留风险高于 DSH 的一次性进程。
7. **给 `console.inspect` 补上界**：DSH 是 `{depth:4, maxArrayLength:100, maxStringLength:1e4}`（`process.js:825-829`），本项目只有 `depth:4`（`worker-main.ts:388`）。
8. **测一次模型面输出**：上游明确目标是"只回灌模型自己 print/return 的东西"（`ptc.js:281-289` 就是一段扁平文本），本项目给的是自建多块树 + 13 项上限。这是 PTC 的立项理由本身（省上下文），却从未与上游做过对照测量。

### 明确**不要**做

- ❌ 不要继续推进 #75–#81 的现有方案（自造 `sandbox-exec`/bwrap/`--permission` 三件套 + 两轴模型）。改用 pi 的 `sandbox/`（`@anthropic-ai/sandbox-runtime`，含域名级网络策略）或 `gondolin/`（微 VM）示例。
- ❌ 不要把 DSH 的 `processIsolation`/`jsHardening` 两轴模型当作 DSH 语义——那是本项目自造的，与 DSH 的 `read-only|workspace-write|danger-full-access` 不同构。
- ❌ 不要声称"与 DSH 对齐"而不写版本。上游 README 自己写着 _"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."_

---

## 附：调研方法与可复现性

六个子代理并发分轴，全程禁止读取被审仓库的 docs：

| 代理             | 轴                                                    | 产物                                                                                   |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| dsh-ptc-core     | DSH PTC 运行时/协议/结果/失败语义                     | `/tmp/dsh-research/01-dsh-ptc-core.md`（538 行，118 处 `path:line`）                   |
| dsh-tool-surface | DSH 工具面 + 子代理                                   | `/tmp/dsh-research/02-dsh-tool-surface.md`                                             |
| dsh-sandbox      | DSH 沙箱/审批 fail-open vs fail-closed（24 行判定表） | `/tmp/dsh-research/03-dsh-sandbox-approval.md`（750 行）                               |
| dsh-presentation | DSH 呈现层/图片/结果卡                                | `/tmp/dsh-research/04-dsh-presentation.md`                                             |
| pi-host-contract | pi 宿主契约与易漏能力                                 | `/tmp/dsh-research/05-pi-host-contract.md`                                             |
| upstream-web     | 官方 web 一手资料                                     | `/tmp/dsh-research/06-upstream-web.md`（+ v0.99.0 release notes / `docs/cli.md` 复核） |

DSH 源提取副本：`/tmp/dsh-src`（667 文件 / 6.8 MB，源自 `app.asar/dsh/node_modules/@deepseek-ai/*`）。

**方法学声明**：本报告所有"本项目缺 X"的结论，都由 `grep` 在 `src/` 上做过零命中验证，不是从文档推断的。唯一一处差点误判的地方：`run-code.ts:48` 声称"默认会话有 read/bash/edit/write"——一度想报为"陈旧清单"，核对 `pi-coding-agent/docs/quickstart.md:84`（"Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options"）后确认**该说法正确**，不作缺陷。
