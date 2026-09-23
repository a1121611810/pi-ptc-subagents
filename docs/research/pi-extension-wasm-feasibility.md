# Pi 扩展能否用 Wasm 实现(或向 Wasm 演进)

> 调研日期:2026-09-23 · 适用 Pi 版本:0.87.x(主分支 `earendil-works/pi` @ `packages/coding-agent`)
> 一句话结论:**当前 Pi 扩展不能也不应该用 Wasm 实现**。Pi 的扩展机制是 in-process、jiti 加载的 TypeScript/JavaScript 模块;`ExtensionAPI` 表面是 JS-shaped(回调、TypeBox schema、动态注册、`AbortSignal`、TUI 组件),把这条表面搬到 Wasm/WIT 上要付出的代价远大于收益。Pi 自己回答"沙箱"问题的方式是把**工具**跑在 Gondolin micro-VM 里,而不是把扩展跑在 Wasm 里。

## 1. 结论先说

| 维度         | 现状                                                                                  | Wasm 化路径                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 加载方式     | jiti `import()` 一个 `.ts`/`.js` 模块,导出 `function(pi: ExtensionAPI)`               | 需要新增 `.wasm` 加载分支:实例化 + 解析 exported function + 经 host function 转发 API 调用                                |
| 运行位置     | 与 Pi 同进程;Node 与子模块完全可见                                                    | 必须在 Node 进程内的 wasm runtime(wasmtime / wasmer / jco / wazero);Linear memory 与 host 隔离                            |
| 编程语言     | TypeScript(可以选 `node:*` / npm 任意依赖,经 jiti 解析)                               | 任意能编译到 Wasm Component Model 的语言(Rust、Go、AssemblyScript、QuickJS 嵌入 JS 等),但调用 Pi API 必须经 host function |
| API 形态     | ~30 个事件 + ~25 个方法,JS 回调、TypeBox schema、async/await、`AbortSignal`、TUI 组件 | 必须以 WIT/Component Model 重新描述这套表面,host function 路由所有调用                                                    |
| 沙箱         | **无** —— 文档明说"扩展与 Pi 同权限",信任模型走 npm/git 源审查                        | Wasm 默认隔离;但 Pi 的扩展信任模型并不是为强隔离设计的(扩展能直接 `import` 任何 npm 包)                                   |
| 现有沙箱方案 | Gondolin(micro-VM)只沙箱**工具执行**,不沙箱扩展本身                                   | Wasm 化扩展等于把"沙箱"塞到扩展加载层,和现有 Gondolin 重叠                                                                |
| 是否值得     | —                                                                                     | **短期不值得**。零官方信号、零需求场景、生态 99% 在 TS/JS。要做只能作为 hackathon 实验,等上游表态                         |

**最终判断**:Pi 短期不会、也不需要支持 Wasm 扩展;如果要做,最小可行路径是在 loader 里增加一个 `wasm:` 路径并实现 ~10 个核心 host function,但 API 兼容性、UI 渲染、动态加载能力都会大幅缩水。

## 2. Pi 扩展机制现状(证据 + 摘录)

### 2.1 加载机制

Pi 的扩展加载器走的是 **`jiti`** —— 一个零配置的 TypeScript/ESM 加载器。源码 `packages/coding-agent/src/core/extensions/loader.ts`:

```ts
function isExtensionFile(name: string): boolean {
    return name.endsWith(".ts") || name.endsWith(".js");
}

async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
    ...
    const jiti = createJitiImpl(import.meta.url, {
        moduleCache: false,
        ...resolutionOptions,            // virtualModules / alias / tsconfigPaths
    });
    const module = await jiti.import(extensionPath, { default: true });
    const factory = module as ExtensionFactory;
    if (typeof factory !== "function") return undefined;
    ...
}
```

发现路径有三种:

1. **`pi.extensions` 字段**(本仓库就在用,`package.json:89-93`):`"pi": { "extensions": ["./dist/index.js"] }` —— 加载器读取 `package.json` 中的 `pi.extensions` 数组
2. **约定目录自动发现**:`.pi/extensions/*.ts`、`~/.pi/agent/extensions/*.ts`、单文件、子目录 `index.ts`、`package.json#pi.extensions`
3. **CLI 临时加载**:`pi --extension ./hello.ts`、`pi -e npm:@example/pi-tools`

> 注意 `isExtensionFile` 只放行 `.ts` 和 `.js`,**`.wasm` 不会进入这条路径**。任何 Wasm 方案都要从 loader 改起。

### 2.2 入口契约

每个扩展是一个 ESM/TS 模块,**default export 一个工厂函数**:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
    pi.registerCommand("hello", { description, handler: async (args, ctx) => { ... } });
    pi.registerTool({ name, label, description, parameters, execute });
    pi.on("tool_call", async (event, ctx) => { ... });
}
```

工厂可以 `async`,Pi 会等到 Promise resolve 才推进启动。

### 2.3 运行位置与权限

文档原话:

> An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

**结论**:

- 同一 Node 进程、同一 OS 权限、无隔离
- 不支持非 JS 运行时(loader 只接受 `.ts`/`.js`)
- 不支持多进程加载、IPC、Worker hosting(扩展可以自己开 `worker_threads`,但那是扩展内部的事 —— 本仓库的 PTC mode 就在 `src/runtime/worker-pool.ts` 里这么做)

### 2.4 关键 API 表面

`ExtensionAPI`(摘自 `types.ts`):

| 类别                          | 方法 / 事件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事件订阅 `on(event, handler)` | `project_trust`、`resources_discover`、`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_shutdown`、`session_before_tree`、`session_tree`、`context`、`context_with_system`、`cache_warming_decision`、`before_provider_request`、`before_provider_headers`、`after_provider_response`、`before_agent_start`、`agent_start`、`agent_end`、`agent_before_settle`、`agent_settled`、`ui_prompt_start`、`ui_prompt_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`model_select`、`thinking_level_select`、`tool_call`、`tool_result`、`user_bash`、`input` |
| 工具                          | `registerTool({ name, label, description, parameters, execute, renderCall?, renderResult? })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 命令                          | `registerCommand(name, { description, handler })`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 快捷键                        | `registerShortcut(key, options)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CLI flag                      | `registerFlag(name, options)` / `getFlag(name)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 消息                          | `sendMessage`、`sendUserMessage`、`appendEntry`、`setSessionName`、`setLabel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 工具集                        | `getActiveTools`、`getAllTools`、`setActiveTools`、`exec`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 模型                          | `setModel`、`getThinkingLevel`、`setThinkingLevel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Provider                      | `registerProvider`、`unregisterProvider`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 渲染                          | `registerMessageRenderer`、`registerMarkdownTransformer`、`registerEntryRenderer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 跨扩展通信                    | `pi.events: EventBus`(emit/on)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`ExtensionContext` 提供 `ui`(通知/对话框/输入框/TUI 组件/主题/页脚/页头/标题/编辑器/`setStatus` 等)、`mode`(`"tui" | "rpc" | "json" | "print"`)、`sessionManager`、`modelRegistry`、`signal`、`compact`、`getSystemPrompt` 等。命令处理器则拿到 `ExtensionCommandContext`,多 `waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`。

### 2.5 工具注册的样子(对照)

```ts
pi.registerTool({
  name: "greet",
  label: "Greeting",
  description: "Generate a greeting",
  parameters: Type.Object({ name: Type.String() }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
  },
});
```

注意 `parameters` 是 TypeBox schema、`execute` 接受 `AbortSignal` 和流式 `onUpdate` 回调。这两点对 Wasm interop 都很麻烦。

### 2.6 运行时 IPC 与 host function 边界

`ExtensionAPI` 内部的实现走"action stub + bindCore 替换"。Loader 创建带 throwing stubs 的 `ExtensionRuntime`,等 runner 绑定后注入真正的实现:

```ts
export function createExtensionRuntime(): ExtensionRuntime {
    const notInitialized = () => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
    };
    const runtime: ExtensionRuntime = {
        sendMessage: notInitialized,
        sendUserMessage: notInitialized,
        appendEntry: notInitialized,
        ...
    };
    return runtime;
}
```

> 这就是 Wasm 化时 host function 必须呈现的表面:约 25 个 action + 30 个事件分发回调,**所有边界调用都需要序列化**(即使 in-process)。

### 2.7 现有 sandbox 方案:Gondolin(不是扩展 host)

Pi 官方配套的 Gondolin 是一个 micro-VM 沙箱,**只用于沙箱 `bash` / `read` / `write` / `edit` 工具执行**,不是一个扩展 host。

源码 `gondolin/host/examples/pi-gondolin.ts` 的写法(摘要):

```ts
export default function (pi: ExtensionAPI) {
    const localRead = createReadTool(localCwd);
    ...
    pi.registerTool({ ...localRead,
        async execute(id, params, signal, onUpdate, ctx) {
            const activeVm = await ensureVm(ctx);
            const tool = createReadTool(localCwd, {
                operations: createGondolinReadOps(activeVm, localCwd),
            });
            return tool.execute(id, params, signal, onUpdate);
        },
    });
}
```

**含义**:Pi 团队对"沙箱"的回应,是把工具实现委托给 VM(VM 跑 Linux 用户态进程),而不是把扩展本身沙箱化。这个选择是深思熟虑的:扩展的能力(包括读写 session、改系统 prompt、发消息)就是 Pi 的能力,沙箱一个等于沙箱整个。

## 3. Wasm 化路径分析

### 3.1 技术上的最小可实施方案

要做到"Pi 加载 `.wasm` 扩展",最少要做这些事:

| 步骤                                    | 改动                                                                                                                                                           | 工作量估计                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1. 在 `loader.ts` 增加 `.wasm` 后缀识别 | `isExtensionFile` 放行 `.wasm`;`loadExtensionModule` 增加 wasm 分支                                                                                            | 小(几十行)                    |
| 2. 选 Wasm runtime                      | Node 内置的 `WebAssembly.Module` / `Instance` 不够灵活,需要 wasmtime(wasm-tools)、wasmer 或 jco 之一;Wasmtime 是工业首选                                       | 中                            |
| 3. 写 WIT 接口                          | 把 25 个 action + 30 个事件映射到 Component Model 接口(WIT);尤其要把 TypeBox schema 转 WIT record/list                                                         | 大,且每次 Pi API 变更都要更新 |
| 4. 实现 host function 桥                | 把 host 的 `ExtensionAPI` 实现包成 wasm imports;每次 `pi.on()` 都注册一个 host callback 编号传给 guest                                                         | 中–大                         |
| 5. 序列化                               | 所有跨边界数据走 linear memory + string/byte 编码;callback ID 必须双方一致;TypeBox schema 校验留在 host                                                        | 大,容易出 bug                 |
| 6. UI 渲染                              | TUI 组件(`setWidget` / `setHeader` / `setFooter` / `setEditorComponent` / `custom`)需要 host 重新设计,Wasm guest 只能发出"画什么"的指令而不能直接操作 TUI tree | 极大,等同于重写 UI 层         |
| 7. Provider / OAuth                     | `registerProvider` 涉及 stream、auth、headers —— 几乎必须 host 提供                                                                                            | 中                            |
| 8. 加载现有 TS/JS 扩展                  | 不可避免的"过渡期":现有扩展都依赖 npm 包、`@earendil-works/pi-*`,Wasm guest 没有这些                                                                           | 决定性                        |

### 3.2 不可行或代价过大的部分

1. **UI 组件**:`ctx.ui.custom<T>((tui, theme, keybindings, done) => Component & { dispose?() })` —— guest 必须用 host 的 `Component` 类型。Wasm Component Model 的 `resource` 类型能近似表达,但 TUI 的事件循环 + 组件生命周期 + 焦点管理都要双向同步,工程量极大。
2. **`renderCall` / `renderResult`** —— 工具自定义渲染,返回 `Component`,同样的问题。
3. **`onUpdate` 流式回调** —— 工具执行是 `Promise<AgentToolResult>`,`onUpdate` 可以多次触发更新结果。Wasm Component Model 的 `stream` 类型能表达,但跨边界的多 stream 同步(state + update 流)是常见的 bug 来源。
4. **TypeBox schema → WIT**:这是机械的(Type.Object → record、Type.Array → list、Type.Union → variant),但要保证版本一致,且 PI 的 schema 在 `Type.String` vs `Type.Union([Type.Literal(...)])` 之间有兼容性偏好。转换器需要持续维护。
5. **npm 依赖**:任何依赖 `@earendil-works/pi-*` 之外包的扩展(很常见,如 `chokidar`、`gray-matter`、`axios`)在 Wasm guest 里完全拿不到。要么所有 guest 用纯 stdlib 的语言(Rust/AssemblyScript),要么允许 guest 嵌一个 QuickJS WASM 模块再跑 JS 子集,要么放弃这条。
6. **运行时反射**:`pi.on()` 返回 `() => void` 用来取消订阅;Wasm 里要维护 callback handle 表,出错代价高。
7. **错误堆栈**:Wasm 里的错误是 `trap`,不携带 JS 风格 stack;`stack?: string` 这个 `ExtensionError` 字段很难填。

### 3.3 性能

- **冷启动**:第一次 `jiti.import()` 一个 100 行 TS 扩展约 50–200ms;`wasmtime` 实例化一个 `.wasm` 约 5–30ms(component model 更慢一点)。Wasm 略快。
- **每次调用**:host function 调用本身 ~微秒级,数据序列化按大小线性增长。`tool_call` / `tool_result` 事件经常传完整 `event` 对象(含 message transcript),单次约 KB 级,1–10μs 量级。**不是热路径瓶颈**。
- **TUI 重绘**:扩展 UI 走 `ctx.ui.setStatus` 这类方法,频次低,无影响。

性能不是 Wasm 化的反对理由;**API 形状与生态成熟度**才是。

### 3.4 现成路径

- **Extism**:目前最成熟的 Wasm 插件宿主,有 Node.js SDK (`@extism/node-sdk`)。思路是把 plugin 的 exported function 当 RPC、host 把能力注入 linear memory + import object。映射到 Pi 的 `ExtensionAPI` 需要重写整层 host function + WIT,**且 Extism 假设 plugin 是单入口、无持续回调**,而 Pi 的 `pi.on(event, handler)` 是持续回调 —— 模式不一致。
- **Wasm Component Model + wasmtime**:工业标准,支持 resource / stream。但对工具化的扩展 API 来说,工作量和直接写 host function 相当。
- **QuickJS-Wasm**:把 QuickJS 嵌进 wasm 字节码,可以在 Wasm guest 里跑真实 JS/TS,**不需要 WIT**。但 Guest 仍要 host function 才能拿到 `pi` 对象,且 QuickJS 自身的内存模型与 Node 不共享,需要桥接。**这条路其实是"Pi 加载任意 TS/JS 但不通过 jiti",但失去了 jiti 的 npm 依赖解析优势**。可行但不是一个好路径。

## 4. 横向参考

### 4.1 Claude Code

Claude Code 的"插件"概念是基于 **markdown + shell command + MCP server** 的打包层:

- `plugin.json` manifest + `skills/`(Markdown)+ `agents/`(Markdown 文件)+ `hooks/`(shell 命令)+ `MCP servers`(外部 JSON-RPC 进程)+ `LSP servers`。
- Hook 触发的是 **shell 命令**,传 JSON 到 stdin,从 stdout 读回 JSON 决策。不是 in-process 回调。
- 没有 Wasm,没有 in-process JS 沙箱。沙箱完全在 OS 层(macOS Seatbelt / sandbox-exec)。

### 4.2 OpenAI Codex CLI

Codex CLI 的"plugins"在 2026-03 推出,概念几乎照搬 Claude Code:**skills + MCP servers + slash commands** 的打包单元。CLI 通过 `codex /plugins` 安装。底层仍是 `config.toml` + MCP 进程,不是 in-process JS,不是 Wasm。

### 4.3 VS Code

VS Code 的扩展全部跑在 Node 进程(每扩展一个进程或一个 VM Context)。**没有用 Wasm**。Wasm 在 VS Code 里只作为 **language server / tool 子进程的二进制格式** 出现,而不是扩展宿主。

### 4.4 Wasm 插件框架(非 Agent 平台)

- **Extism**:**目前最成熟的 Wasm 插件宿主**。已用于 FrankenPHP、wasmCloud、Hippo(Helm HIP-0026)等。强调"一次编写、跨语言、跨宿主"。Node.js SDK 可用,但适配 Pi 的回调式 API 需要额外抽象。
- **Wasm Component Model**:WebAssembly 3.0(2025-09-17)的核心新特性,提供 typed interface、resource handle、stream。但 2026 早期才在 Wasmtime 26+ / Wasmer 5+ / jco 1.x 完整支持。
- **Wassette** / **hyper-mcp**:MCP servers 用 Wasm 跑 tool 的项目,反向操作(把 Wasm 当工具后端)。证明方向可行但和"Pi 扩展是 Wasm"是两回事。

## 5. 风险与缺口

### 5.1 信息空白(需要补查)

- **Pi 官方是否有 Wasm 路线图**:CHANGELOG(`[0.87.1] - 2026-09-22` 到 `[0.10.0] - 2025-11-25`)全量 grep `wasm|WebAssembly|webassembly|\.wasm` **0 命中**。没有任何官方信号。
- **Discussion / Issue**:截至 2026-09-17,有 [Discussion #3373](https://github.com/earendil-works/pi/discussions/3373),但主题是 UX 层,没提 Wasm。
- **Pi.Packages / Extensions 注册表**:`pi.dev/packages` 也没有 Wasm 扩展(均为 `*.ts` / `*.js` 源码包)。
- **TypeBox schema 转换为 WIT 的成本**:本调研未跑通端到端转换器;只在概念层判断。实际写一遍 WIT 才会暴露边界问题(如 `StringEnum` vs `Type.Union([Type.Literal(...)])` 的兼容映射)。
- **Wasmtime / wasmer 在 Bun/SEA/Node bundle 下的兼容性**:Pi 当前支持 Bun binary、Node SEA、bundled Node 三种打包形态。Wasmtime native binary 在 SEA 内能否加载、能否跨平台,没确认。

### 5.2 如果要做,值不值得?

| 评估项     | 评分 | 理由                                                             |
| ---------- | ---- | ---------------------------------------------------------------- |
| 需求       | 极低 | 99% 现有扩展是 TS/JS;没有"必须 Wasm"的 use case                  |
| 投入       | 高   | 写 WIT + host function + 序列化桥 + UI 妥协                      |
| 收益       | 低   | 隔离性 Pi 已用 Gondolin 提供;性能不是瓶颈;多语言扩展并非用户请求 |
| 兼容性破坏 | 高   | 现有 TS/JS 扩展体系要双轨支持很长一段时间                        |
| 维护负担   | 高   | Pi 每次 API 变更都要同步更新 WIT                                 |

**结论**:**不值得作为上游特性**。可作为实验性个人项目在 loader 里加 `.wasm` 分支,但不应进入 `packages/coding-agent`。

### 5.3 给本仓库(`pi-ptc-subagents`)的具体启示

本仓库现在是 Pi 的纯 TS 扩展,使用 `pi.extensions` 自描述、`@earendil-works/pi-coding-agent` 作为类型来源、所有 hook 走 `pi.on()` + `ctx`。这些**完全不需要改成 Wasm** —— 它正是 Pi 扩展模型"正确"的形态。

如果未来想给 PTC 增加"用户运行能跑在沙箱里"的属性,正确做法是**走 Gondolin 模式**:把 `ptc_run_code` / `ptc_workflow` 的内部 worker 用 Gondolin VM 包一层,而不是改 PTC 本身。这是 Pi 工具沙箱的官方路径。

## 6. 来源列表

> 抓取日期:2026-09-23

| 来源                                                                                                                                                                      | 用途                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| [`earendil-works/pi` GitHub](https://github.com/earendil-works/pi)                                                                                                        | 主仓库位置                                     |
| [`packages/coding-agent/docs/extensions.md`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md)                           | 扩展 API 文档(权威)                            |
| [`packages/coding-agent/docs/packages.md`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md)                               | Pi packages 文档,确认 `.ts`/`.js` only         |
| [`packages/coding-agent/src/core/extensions/loader.ts`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/loader.ts)     | loader 源码,确认 `jiti` + `.ts`/`.js` 唯一路径 |
| [`packages/coding-agent/src/core/extensions/types.ts`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/extensions/types.ts)       | 完整 `ExtensionAPI` 类型定义                   |
| [`packages/coding-agent/examples/extensions/README.md`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/README.md)     | 官方扩展例子索引                               |
| [`packages/coding-agent/CHANGELOG.md`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md)                                       | 变更日志,确认无 Wasm 相关条目                  |
| [`@earendil-works/pi-coding-agent` npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)                                                                    | 官方包页                                       |
| [`pi.dev`](https://pi.dev/)                                                                                                                                               | 官方文档站与 packages gallery                  |
| [`gondolin/host/examples/pi-gondolin.ts`](https://raw.githubusercontent.com/earendil-works/gondolin/main/host/examples/pi-gondolin.ts)                                    | Gondolin 工具沙箱范本                          |
| [`@earendil-works/gondolin` npm](https://www.npmjs.com/package/@earendil-works/gondolin)                                                                                  | Gondolin 包说明                                |
| [`Claude Code Plugins reference`](https://code.claude.com/docs/en/plugins-reference)                                                                                      | Claude Code 插件架构(对比)                     |
| [`Claude Code Hooks reference`](https://code.claude.com/docs/en/hooks)                                                                                                    | Claude Code hook 形态(对比)                    |
| [`The New Stack: OpenAI's Codex gets plugins`](https://thenewstack.io/openais-codex-gets-plugins/)                                                                        | Codex CLI 插件架构(对比)                       |
| [`Appwrite codex-plugin`](https://github.com/appwrite/codex-plugin)                                                                                                       | Codex 插件示例(对比)                           |
| [`Extism docs`](https://extism.org/docs/concepts/plug-in-system/)                                                                                                         | Wasm 插件宿主框架(参考)                        |
| [`Helm HIP-0026`](https://helm.sh/community/hips/hip-0026)                                                                                                                | Extism 选型评估(参考)                          |
| [`Wasm Component Model 2026 deep-dive`](https://www.youngju.dev/blog/culture/2026-05-25-webassembly-wasi-spin-wasmtime-wasmer-wasmedge-component-model-2026-deep-dive.en) | Component Model 现状(参考)                     |
| [`VS Code marketplace: Pi Coding Agent provider`](https://marketplace.visualstudio.com/items?itemName=tintinweb.vscode-pi-model-chat-provider)                            | VS Code 扩展 vs Pi 的关系(对比)                |
| [`earendil-works/pi Discussion #3373`](https://github.com/earendil-works/pi/discussions/3373)                                                                             | 社区插件讨论(空白验证)                         |
| 本仓库 [`docs/research/pi-capability-audit.md`](https://github.com/a1121611810/pi-ptc-subagents/blob/main/docs/research/pi-capability-audit.md)                           | 现有扩展审计(内部参考)                         |
