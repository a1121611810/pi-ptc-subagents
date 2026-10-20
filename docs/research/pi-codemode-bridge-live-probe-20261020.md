# 真机实测：扩展用 `pi.registerTool({ exposure: "codemode" })` 注册的工具，codemode 沙箱脚本真的调得到它的 `execute()`

> 调研日期: 2026-10-20。回答什么问题: 静态取证笔记 `docs/research/pi-codemode-tool-bridging-20261020.md` 的 §0 第 1、4、5 行与 §3（入参/返回/通道）到底成不成立 —— 具体是五问：(1) `exposure: "codemode"` 的扩展工具，codemode 脚本能不能找到并调它的 `execute()`；(2) 脚本侧的 arguments 到达 `execute()` 时是什么形状；(3) 脚本侧拿到的是 `structuredContent`、文本字符串，还是别的，`details` 能不能过去；(4) 这个工具在不面向模型的工具列表里吗；(5) 它在 codemode 的目录（codemode 工具自己的描述）里被列出吗，还是只能靠 `tool_search` 找。这五问是 `docs/specs/0044-deepseek-search-module.md` 里「搜索只做程序内可达、同时出现在 pi 工具面与 PTC binding 面」这条形状决策的前提 —— 静态取证笔记 §8 未核实清单第 1 条明写「**没有观测到一次真实的"codemode 脚本调用扩展注册的 `exposure: "codemode"` 工具"**」。本笔记补上那次观测。
> 方法: **真机端到端**。写一个最小探针 pi 扩展（4 个 `pi.registerTool` 注册的假工具，其中 3 个 `exposure: "codemode"`、1 个 `exposure: "deferred"`），配一个**离线 canned provider**（`pi.registerProvider` + 自写 `streamSimple`）驱动会话：让「模型」发出真实的 `codemode` 工具调用，脚本在 QuickJS 沙箱里真的调探针工具。观测点有三处：探针 `execute()` 里记录**它实际收到的参数**、canned provider 里记录**模型面看到的工具列表与 codemode 工具的描述**、以及 codemode 工具结果里**脚本自己的输出**。全程无网络、无真实模型调用。
> 环境与版本: pi **1.3.0**（`/Users/lilianda/.bun/bin/pi`，`pi --version` → `1.3.0`；本仓 tree 里的 `@earendil-works/pi-coding-agent@1.3.0` 同版本，pi-codemode 1.3.0 / pi-agent-core 1.3.0）。Node v24.22.0，macOS darwin 27.0.0 arm64。**隔离 agent dir**：`PI_CODING_AGENT_DIR=/tmp/pi-codemode-probe/agent`（本机真实的 `~/.pi/agent` 里装着一份 `pi-ptc-subagents` 的实体拷贝，会干扰一切，全程未读写它）。`codemode` 与 `tool_search` 由 `--tools +codemode,+tool_search` 激活（pi 0.99.0 起 `codemode` 默认注册为 inactive）。**未用** `-ne` / `--no-extensions`（那会把内建扩展一起关掉，codemode 进不来）。探针、agent dir、解包产物全在 `/tmp`，仓库工作区未新增/修改任何其它文件。
> 一手来源: (1) 本次真机运行的观测文件 `/tmp/pi-codemode-probe/out/observations.jsonl`（每行一条记录，`kind` 字段区分 `all_tools` / `model_request` / `tool_execute`）；(2) 探针扩展源码全文见 §8；(3) 被核对的静态来源为 `node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/{execute.js,tool.js}`、`dist/core/agent-session.js`、`node_modules/@earendil-works/pi-ai/dist/utils/validation.js`、官方 `docs/codemode.md` / `docs/extensions.md` / `docs/settings.md`。
> 复核命令: 见 §9（逐条给出可直接粘贴的命令，含完整探针源码的落盘步骤）。
> 仓库快照: `pi-ptc-subagents` HEAD `fe5701a`（被核对的静态笔记 `docs/research/pi-codemode-tool-bridging-20261020.md` 与规格 `docs/specs/0044-deepseek-search-module.md` 已在 `50b4f2c` / `fe5701a` 落库）；本笔记只新增本文件，未改动其它任何文件，未 `git add` / 未提交。

## 0. 结论速查表：五个问题的逐条答案

| #   | 问题                                             | 观测到的行为                                                                                                                                                                                                                                                                       | 证据                                                                                                                                                               |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **能不能调到**                                   | **能。** `exposure: "codemode"` 的扩展工具进了 codemode 脚本的工具表，脚本 `await tools.probe_echo({...})` 之后，宿主侧扩展的 `execute()` 真的跑起来（一次会话里跑了 6 次）                                                                                                        | `observations.jsonl` 的 `tool_execute` 记录 6 条；`all_tools` 记录里 `probe_echo -> codemode`                                                                      |
| 2   | **参数怎么传**                                   | **一次 JSON 往返。** 到达 `execute()` 的是一个**普通 JS 对象**（`typeof === "object"`，不是字符串）；嵌套对象保持对象；**显式 `undefined` 的字段被 JSON 丢掉**（键直接不存在）；整个参数为 `undefined` 时到达的是 **`{}`** 而不是 `undefined`；参数不合 schema 时脚本侧 **reject** | `tool_execute` 记录的 `receivedType` / `receivedKeys` / `receivedJson`；`requiredMissingArgResult.__error`                                                         |
| 3a  | 声明了 `outputSchema` 并返回 `structuredContent` | **脚本拿到的是 `structuredContent` 本身**（对象），且**不是**文本 —— 同一个调用里的 `content` 文本标记**没有**出现在脚本看到的结果里                                                                                                                                               | `structuredResult` = `{"marker":"STRUCTURED_CONTENT_MARKER","echoed":"hello-codemode","count":42}`；`structuredResultHasContentKey` = false                        |
| 3b  | 没声明 `outputSchema`                            | **脚本拿到的是文本字符串**（`typeof === "string"`），即 `content` 里 text 块拼成的字符串                                                                                                                                                                                           | `plainResult` = `"PLAIN_TEXT_CONTENT_MARKER payload=plain-payload"`，`plainResultType` = `"string"`                                                                |
| 3c  | **`details` 确认到不了脚本**                     | **确认到不了。** 两条路径都查了：返回对象里没有 `details` 键，序列化后也搜不到 `details` 里的标记字符串                                                                                                                                                                            | `structuredResultHasDetailsKey` = false、`structuredResultContainsDetailsMarker` = false、`plainResultContainsDetailsMarker` = false                               |
| 4   | **模型面看不见**                                 | **默认看不见。** `pi.getAllTools()` 里三个 `codemode` 档探针工具都在；但模型面的工具列表里一个都没有。**例外：`tool_search` 会把它们找出来并激活，从此模型面看得见**                                                                                                               | `all_tools` 记录 vs `model_request` 1/2/3 的 `modelToolNames`；`model_request` 4 的 `modelToolNames` 多出四个 `probe_echo*`                                        |
| 5   | **在 codemode 的目录里被列出吗**                 | **被列出。** 三个 `codemode` 档工具都在 codemode 工具自己的描述里（带 TS 声明）；`deferred` 档的**不列**；`direct` 档的（read/bash）也不列。**所以不需要 `tool_search`**                                                                                                           | `model_request` 1 的 `codemodeDescription` 的 "Nested tools:" 段；`probe_echo_deferred` 不在其中，`probe_echo` / `probe_echo_plain` / `probe_echo_required` 在其中 |

**一句话结论：桥通，且通得比静态取证更强一点 —— 静态取证说"进 codemode 目录"的那条，实测成立；同时实测补出两条静态笔记没写的细节（`tool_search` 能把 `codemode` 档工具激活成模型可见；整个参数为 `undefined` 时到达 `execute()` 的是 `{}`）。**

## 1. 探针怎么搭的

### 1.1 形状

一个 pi 扩展，四件事：

1. **注册 4 个假工具**（全部用 `pi.registerTool`）：

   | 工具                  | exposure   | outputSchema | 返回                                                                  |
   | --------------------- | ---------- | ------------ | --------------------------------------------------------------------- |
   | `probe_echo`          | `codemode` | 有           | `content`（文本标记）+ `details`（标记）+ `structuredContent`（标记） |
   | `probe_echo_plain`    | `codemode` | **无**       | `content`（文本标记）+ `details`（标记）                              |
   | `probe_echo_deferred` | `deferred` | 无           | `content` + `details`（MCP 那条 `codemode → deferred` 改写的替身）    |
   | `probe_echo_required` | `codemode` | 无           | `content`（必填参数 `payload`，用来观测校验失败）                     |

2. **每个 `execute()` 把自己实际收到的参数记下来**（`typeof`、键集合、`JSON.stringify` 结果、显式 `undefined` 字段在不在）—— 这是问题 2 的一手证据。
3. **`session_start` 时记 `pi.getAllTools()`** —— 这是问题 4 的"注册面"。
4. **注册一个离线 canned provider**（`pi.registerProvider` + 自写 `streamSimple`），按序驱动 4 次模型请求：

   | 请求 | provider 发出什么                             | 目的                                                                |
   | ---- | --------------------------------------------- | ------------------------------------------------------------------- |
   | 1    | `codemode` 工具调用，脚本 = 宽观测脚本        | 一次问完 Q1/Q2/Q3/Q5                                                |
   | 2    | `codemode` 工具调用，脚本 = 只有一行直接调用  | 验证**不用任何 discovery 全局**也能调到（reach 退化成"源码里的词"） |
   | 3    | `tool_search` 工具调用，`query: "probe_echo"` | 观测 `tool_search` 能否找到并激活 `codemode` 档工具                 |
   | 4    | 纯文本 `probe complete`                       | 收尾；这一次请求的 `modelToolNames` 反映第 3 步之后模型面变了什么   |

### 1.2 为什么用 canned provider 而不是真模型

要观测的是**桥**，不是模型的决策。用真模型会带来两个变量：模型可能不调 `codemode`、可能不用直接调用形式、参数每次都不一样。canned provider 让"模型"这一侧完全确定，观测到的差异只能来自桥本身。

它同时顺手解决了两个观测点：`streamSimple` 的 `context.messages` 里带着**模型面真正的工具列表**（`getCurrentTools(context.messages)`）和**codemode 工具真正的描述文本**——问题 4 和问题 5 的证据都是从这里取的，不是从源码推的。

### 1.3 隔离与激活（踩过的坑，照抄）

| 坑                                                                     | 做法                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 本机 `~/.pi/agent` 里有一份 `pi-ptc-subagents` 实体拷贝，会干扰一切    | `PI_CODING_AGENT_DIR=/tmp/pi-codemode-probe/agent`，全程不碰真实 agent dir                               |
| `-ne` / `--no-extensions` 会把内建扩展一起关掉，codemode 进不来        | 不用；只加 `-e <探针路径>`                                                                               |
| pi 0.99.0 起 `codemode` 默认注册为 inactive                            | `--tools +codemode`（`+` 是"加到默认集合上"，不是替换）                                                  |
| 探针源码在 `/tmp`，裸导入 `@earendil-works/pi-ai` / `typebox` 解析不到 | `/tmp/pi-codemode-probe/probe/node_modules` 软链到本仓 `node_modules`；pi 的 jiti loader 另有 alias 兜底 |

## 2. 问题 1：能不能调到 —— 能

`observations.jsonl` 里 `tool_execute` 记录的顺序（一次会话，4 次模型请求）：

```
[tool_execute] probe_echo          received={"payload":"hello-codemode","count":42,"jsonLooking":"{\"a\":1}","nested":{"a":7,"b":"seven"}}
[tool_execute] probe_echo_plain    received={"payload":"plain-payload"}
[tool_execute] probe_echo          received={}
[tool_execute] probe_echo          received={}
[tool_execute] probe_echo_deferred received={"payload":"deferred-payload"}
[tool_execute] probe_echo          received={"payload":"direct-only"}
```

⇒ 扩展的 `execute()` 在**宿主侧**被调用了 6 次。脚本侧那次调用的原始输出（codemode 工具结果里脚本自己 `text()` 出来的）：

```json
"structuredResult": {"marker": "STRUCTURED_CONTENT_MARKER", "echoed": "hello-codemode", "count": 42}
```

**两种调用形态都成立**：

- 宽脚本用 `ALL_TOOLS` / `searchTools` / `describeTool` 发现工具再调（`reachesTools` 解析成 `"all"`）；
- 窄脚本一个 discovery 全局都没用，只写 `await tools.probe_echo({ payload: "direct-only" })`（`reachesTools` 退化成"源码里的词"，`probe_echo` 在其中）—— 结果：

```json
{ "type": "object", "value": { "marker": "STRUCTURED_CONTENT_MARKER", "echoed": "direct-only" } }
```

⇒ **不靠 discovery 全局也能直接调到。** 这补上了静态笔记 §8 没核的 `tool_search`/`reachesTools` 交互。

`deferred` 档的 `probe_echo_deferred` 同样从脚本里调到了（见上表第 5 行），脚本侧拿到：

```json
"deferredResult": "DEFERRED_TEXT_CONTENT_MARKER payload=deferred-payload"
```

## 3. 问题 2：参数怎么传 —— 一次 JSON 往返，`undefined` 丢键

探针 `execute()` 实际收到的东西（`observations.jsonl` 的 `tool_execute` 记录，`probe_echo` 第一次调用）：

| 观测字段           | 值                                                                                               | 读法                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `receivedType`     | `"object"`                                                                                       | 到的是**普通 JS 对象**，不是 JSON 字符串      |
| `receivedIsArray`  | `false`                                                                                          | 不是数组                                      |
| `receivedKeys`     | `["payload", "count", "jsonLooking", "nested"]`                                                  | 键集合完整                                    |
| `hasMaybeKey`      | `false`                                                                                          | **显式传 `maybe: undefined`，键直接不存在**   |
| `maybeValue`       | `undefined`                                                                                      | 值也是 undefined                              |
| `payloadType`      | `"string"`                                                                                       | 类型保真                                      |
| `countType`        | `"number"`                                                                                       | 数字没变成字符串                              |
| `jsonLookingValue` | `'{"a":1}'`                                                                                      | **不是** `'"{\"a\":1}"'` ⇒ 没有被二次字符串化 |
| `nestedKeys`       | `["a", "b"]`                                                                                     | 嵌套对象保持对象                              |
| `receivedJson`     | `{"payload":"hello-codemode","count":42,"jsonLooking":"{\"a\":1}","nested":{"a":7,"b":"seven"}}` | 整体一次 JSON 往返                            |

**"字符串化过几次"的判据**：脚本传了一个长得像 JSON 的字符串 `'{"a":1}'`。如果被 `JSON.stringify` 了两次，`execute()` 会收到 `'"{\"a\":1}"'`（带引号和转义）。实测收到的是干净的 `'{"a":1}'` ⇒ **恰好一次 stringify + 一次 parse**。

**`undefined` 能不能过**：**不能**。`JSON.stringify({maybe: undefined})` 会丢掉这个键，所以 `execute()` 里 `"maybe" in params` 是 `false`。静态取证笔记 §3.1 写的是"`undefined` 整体是特例，会被丢掉"——**实测确认，且比那句话更具体：不是变成 `undefined` 值，是键根本不存在**。

**整个参数为 `undefined` 的情况**：脚本写 `await tools.probe_echo()`（不传参），`execute()` 收到的是 `{}`（`receivedKeys` = `[]`，`receivedJson` = `"{}"`），**不是 `undefined`**。脚本写 `await tools.probe_echo({})` 同样是 `{}`。

> ⚠️ **未隔离**：这个 `{}` 是 codemode 桥那一层补的，还是 agent loop 的参数校验补的，本次**没有隔离**。静态上最像后者 —— `pi-ai` 的 `validateToolArguments` 先 `structuredClone(toolCall.arguments)` 再 `Value.Convert(tool.parameters, args)`（`node_modules/@earendil-works/pi-ai/dist/utils/validation.js:280-283`），TypeBox 的 `Convert` 对 object schema 会把 `undefined` 变成 `{}`。这条**只是静态推断，不是本次观测**。

**参数不合 schema 时**：脚本侧拿到的是**reject**，不是一个结果值：

```json
"requiredMissingArgResult": {
  "__error": "Error: Validation failed for tool \"probe_echo_required\":\n  - payload: must have required properties payload\n\nReceived arguments:\n{}",
  "__isError": true
}
```

⇒ 校验发生在桥的另一侧（agent loop），错误文本原样透到脚本。

## 4. 问题 3：结果怎么回

### 4.1 声明了 `outputSchema` 并返回 `structuredContent` ⇒ 脚本拿到 `structuredContent`

脚本侧观测（`structuredResult*` 一组）：

```json
"structuredResult": {"marker": "STRUCTURED_CONTENT_MARKER", "echoed": "hello-codemode", "count": 42},
"structuredResultType": "object",
"structuredResultIsArray": false,
"structuredResultHasDetailsKey": false,
"structuredResultHasContentKey": false,
"structuredResultHasStructuredContentKey": false,
"structuredResultJson": "{\"marker\":\"STRUCTURED_CONTENT_MARKER\",\"echoed\":\"hello-codemode\",\"count\":42}",
"structuredResultContainsDetailsMarker": false
```

三条要点：

1. **拿到的是 `structuredContent` 本身**（`marker` / `echoed` / `count` 三个字段，正是扩展放进去的那三个）。
2. **同一个调用里 `content` 的文本被"换掉"了**：扩展在 `content` 里放的是 `TEXT_CONTENT_MARKER payload=hello-codemode`，但脚本侧的 `structuredResultJson` 里**没有** `TEXT_CONTENT_MARKER`。⇒ 声明 `outputSchema` + 返回 `structuredContent` 是**切换通道**，不是"多给一份"。
3. **结果是"替换"而不是"包装"**：脚本拿到的对象里既没有 `structuredContent` 键，也没有 `content` 键 —— 拿到的是**内容本身**，不是结果信封。

### 4.2 没声明 `outputSchema` ⇒ 脚本拿到文本字符串

```json
"plainResult": "PLAIN_TEXT_CONTENT_MARKER payload=plain-payload",
"plainResultType": "string",
"plainResultJson": "\"PLAIN_TEXT_CONTENT_MARKER payload=plain-payload\"",
"plainResultContainsDetailsMarker": false
```

⇒ 字符串，`content` 里的 text 块拼成的结果。**没有**信封。

### 4.3 `details` 确认到不了脚本

两条独立证据：

- **结构上**：`"details" in result` = `false`（结构化路径与文本路径都测了）。
- **内容上**：`JSON.stringify(result).indexOf("DETAILS_MARKER")` = `-1`；扩展在 `details` 里放的 `DETAILS_MARKER` / `PLAIN_DETAILS_MARKER` 两个标记串，**在脚本拿到的任何东西里都搜不到**。

⇒ 静态取证笔记 §3.2 那句「**`details` 永不进**」**实测成立**。

## 5. 问题 4：模型面看不见（但 `tool_search` 能把它翻出来）

### 5.1 注册面 vs 模型面

`pi.getAllTools()`（`session_start` 时取的，`observations.jsonl` 的 `all_tools` 记录）：

```
read -> direct          bash -> direct          powershell -> direct
edit -> direct          write -> direct         grep -> direct
find -> direct          ls -> direct
probe_echo -> codemode          probe_echo_plain -> codemode
probe_echo_deferred -> deferred  probe_echo_required -> codemode
codemode -> model-only          tool_search -> model-only
```

模型面看到的工具列表（`observations.jsonl` 的 `model_request` 记录，取自 `getCurrentTools(context.messages)`）：

```
model_request 1: ['read', 'bash', 'edit', 'write', 'codemode', 'tool_search']
model_request 2: ['read', 'bash', 'edit', 'write', 'codemode', 'tool_search']
model_request 3: ['read', 'bash', 'edit', 'write', 'codemode', 'tool_search']
model_request 4: ['read', 'bash', 'edit', 'write', 'codemode', 'tool_search',
                   'probe_echo_required', 'probe_echo_deferred', 'probe_echo_plain', 'probe_echo']
```

⇒ **默认状态下，四个 `probe_echo*` 一个都不在模型面**（请求 1/2/3），但它们全都在 `pi.getAllTools()` 里（注册面）。**"只被 codemode 脚本看见"成立。**

### 5.2 但 `tool_search` 能把它们找出来**并激活**

第 3 次模型请求发出的是 `tool_search({ query: "probe_echo" })`，结果：

```
Loaded 4 tools. They are available from your next call:
- probe_echo_required: Echo probe with a required parameter.
- probe_echo_deferred: Echo probe with deferred exposure. Stands in for the MCP codemode-to-deferred rewrite.
- probe_echo_plain: Echo probe without an output schema. Returns a details marker and text only.
- probe_echo: Echo probe with an output schema. Returns a details marker, text, and structured content.
```

第 4 次模型请求的工具列表就多出了这四个（见上表 `model_request 4`）。

⇒ **一条静态笔记没写的细节**：`codemode` 档工具**默认**不面向模型，但 `tool_search` 能搜到它、并且**会把它激活成模型可见**。对"只做程序内可达"的搜索工具来说，这意味着"不面向模型"是**默认状态**，不是**不可翻出来**——如果模型主动调了 `tool_search`，这个工具就会进模型声明。

（`deferred` 档的 `probe_echo_deferred` 也被 `tool_search` 搜到了 —— 静态上 `tool_search` 的可搜集合是 `codemode` + `deferred`（`dist/extensions/tool-search/tool.js:136-138`），本次实测一致。）

## 6. 问题 5：在 codemode 的目录里被列出 —— 被列出，且 `deferred` 档不列

模型面看到的 **codemode 工具自己的描述**（`observations.jsonl` 的 `model_request` 记录的 `codemodeDescription` 字段，"Nested tools:" 段全文）：

````
Nested tools:

### `probe_echo`
Echo probe with an output schema. Returns a details marker, text, and structured content.

codemode tool declaration:
```ts
declare const tools: { probe_echo(args: { count?: number; jsonLooking?: string; maybe?: string; nested?: { a?: number; b?: string; }; payload?: string; }): Promise<{ count?: number; echoed?: string; marker: string; }>; };
````

### `probe_echo_plain`

Echo probe without an output schema. Returns a details marker and text only.

codemode tool declaration:

```ts
declare const tools: { probe_echo_plain(args: { payload?: string }): Promise<string> };
```

### `probe_echo_required`

Echo probe with a required parameter.

codemode tool declaration:

```ts
declare const tools: { probe_echo_required(args: { payload: string }): Promise<string> };
```

````

对照表（同一份描述里逐个名字查）：

| 工具                   | exposure    | 在 codemode 描述里？ |
| ---------------------- | ----------- | -------------------- |
| `probe_echo`           | `codemode`  | **是**                |
| `probe_echo_plain`     | `codemode`  | **是**                |
| `probe_echo_required`  | `codemode`  | **是**                |
| `probe_echo_deferred`  | `deferred`  | **否**                |
| `read` / `bash`        | `direct`    | 否（`direct` 档直接面向模型，不进 codemode 目录） |

⇒ **`codemode` 档被列进目录，所以模型不需要靠 `tool_search` 才知道脚本里能调什么**；而 `deferred` 档（也就是 MCP 的 `codemode → deferred` 改写之后的落点）**不列**，只能靠 `searchTools` / `describeTool` / `ALL_TOOLS` 发现。**这正是静态取证笔记 §4.1 那行对照的实测确认。**

顺带两个有用的观测：

- codemode 描述里给出的 **TS 声明已经编码了返回通道的差别**：有 `outputSchema` 的声明成 `Promise<{ count?: number; echoed?: string; marker: string; }>`（对象），没有的声明成 `Promise<string>`（字符串）。**模型读描述就知道脚本会拿到什么。**
- 脚本侧的 `searchTools("probe_echo")` 命中 4 个（含 `deferred` 档那个），`describeTool("probe_echo")` 返回同一份描述 + 同一份 TS 声明。⇒ 目录里列的和 `searchTools` 找得到的是同一批，不是两批。

## 7. 与静态取证是否一致

对照对象：`docs/research/pi-codemode-tool-bridging-20261020.md`（本仓既有笔记，未被本次改动）。

| 静态结论                                                                                        | 出处                              | 实测                    | 判定                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------- | ------------------------ |
| `exposure: "codemode"` 的工具进 `ctx.tools`，脚本 `tools.<name>(args)` 经 `ctx.executeTool` 打到扩展的 `execute()` | §0 第 1 行 / §2                   | `execute()` 真跑了 6 次  | **一致**                 |
| 入参是 **JSON**（脚本 `JSON.stringify` / 宿主 `JSON.parse`）                                       | §0 第 4 行 / §3.1                 | 一次往返；像 JSON 的字符串没被二次化 | **一致，且更具体**       |
| `undefined` 会被丢掉                                                                            | §3.1（"整体是特例，会被丢掉"）    | 键根本不存在            | **一致，且更具体**       |
| 声明 `outputSchema` 且返回 `structuredContent` ⇒ 脚本拿到 `structuredContent`                      | §0 第 5 行 / §3.2                 | 拿到 `structuredContent` 本身 | **一致**                 |
| 没声明 `outputSchema` ⇒ 脚本拿到 `content` 文本块拼成的字符串                                     | §3.2                              | 字符串                  | **一致**                 |
| **`details` 永不进脚本**                                                                        | §0 第 5 行 / §3.2                 | 结构与内容两条证据都没有 | **一致**                 |
| `codemode` 档**不面向模型**（`_isDeclarable` 只放行 `direct`/`model-only`）                        | §0 结论表 §2.1 / §4.1             | 模型面工具列表里没有     | **一致**                 |
| `codemode` 档会被**列进 codemode 工具的描述**，`deferred` 档不列                                   | §0 结论表第 11 行 / §4.1 / §6.2   | 三个 `codemode` 档都列，`deferred` 档不列 | **一致**             |
| MCP 的 `codemode` 档被改写成 `deferred`，所以不进目录                                              | §4.1                              | `deferred` 档确实不列   | **一致**                 |

**没有证伪任何一条静态结论。** 一条出入也没有。

### 7.1 实测新增（静态笔记没写的）

| #   | 新观测                                                                 | 为什么值得记                                                                                                       |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A   | **`tool_search` 能搜到 `codemode` 档工具，并且会把它**激活**成模型可见** | 「只做程序内可达」的工具是"默认不面向模型"，不是"永远不面向模型"。若规格里要把这条当硬保证，得考虑模型主动调 `tool_search` 的路径 |
| B   | 整个参数为 `undefined` 时，`execute()` 收到的是 `{}` 而不是 `undefined` | 工具若用 `params === undefined` 判断"没传参"，会判错                                                                     |
| C   | 声明 `outputSchema` 后，脚本拿到的是 `structuredContent` **内容本身**，不是 `{structuredContent: ...}` 信封 | 写脚本的人按信封写就错了                                                                                       |
| D   | 窄脚本（不用任何 discovery 全局）也能直接 `tools.probe_echo(...)` 调到 | `reachesTools` 退化成"源码里的词"这条路径也通，不只 discovery 路径通                                                   |
| E   | 参数不合 schema ⇒ 脚本侧 reject，错误文本带校验明细与 `Received arguments` | 脚本作者能从错误里看到实际送过去的参数                                                                            |
| F   | `searchTools` / `describeTool` 对 `codemode` 档与 `deferred` 档一视同仁 | 静态笔记 §8 第 3 条"tool_search 与 codemode exposure 扩展工具的交互未核"，本次核了 `tool_search`（BM25 那条）；`searchTools` 是 codemode 自己的全局，两回事 |

### 7.2 对 `docs/specs/0044-deepseek-search-module.md` 的影响

静态笔记 §7 表格里的方案 **A（`exposure: "codemode"` 的 pi 工具）** 与 **C（A + B 共用一份实现）** 现在有实测支撑：`subagents` surface 上模型一跳就能调搜索（模型 → codemode 脚本 → `tools["search"]`），且工具本身默认不面向模型。

两点必须一起写进规格，否则形状决策会在实现期翻车：

1. **`A` 形态的可用性前提是"codemode 已加载**且**已激活"**，而 `codemode` 在 pi 0.99.0 起默认注册为 inactive（`--tools +codemode` 或 settings 的 `defaultTools`）。本仓 `subagents` surface 的判定本来就要求这两者同时成立，所以与既有判定自洽。
2. **"不面向模型"是默认状态而非硬保证**（§7.1-A）：模型若调 `tool_search`，`codemode` 档工具会被激活进模型声明。如果规格里写了"搜索工具永不面向模型"，这条要么改成"默认不面向模型"，要么显式处理 `tool_search` 这条路。

## 8. 探针扩展源码（全文）

文件：`/tmp/pi-codemode-probe/probe/probe.ts`（**故意用 `.ts`**，pi 的 jiti loader 直接加载 TS 扩展）。

```ts
/**
 * PROBE — throwaway. Answers ONE question with a real pi run:
 * can a codemode script reach an extension-registered tool's `execute()` when that tool
 * declares `exposure: "codemode"`?
 *
 * Four tools:
 *   probe_echo          — exposure "codemode", declares outputSchema, returns content + details + structuredContent
 *   probe_echo_plain    — exposure "codemode", no outputSchema, returns content + details only
 *   probe_echo_deferred — exposure "deferred" (the MCP-contrast stand-in), no outputSchema
 *   probe_echo_required — exposure "codemode", a required parameter, for the invalid-argument case
 *
 * A canned provider drives the conversation: request 1 asks codemode to run the wide
 * observation script, request 2 asks codemode to run a minimal direct-call script
 * (no discovery globals), request 3 calls tool_search, request 4 ends the turn.
 *
 * Everything observed is appended to $PROBE_OUT as JSONL.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const OUT = process.env.PROBE_OUT ?? "/tmp/pi-codemode-probe/out/observations.jsonl";
const PROVIDER = "probe-bridge";
const MODEL = "probe-bridge-model";

function record(rec: unknown): void {
  appendFileSync(OUT, `${JSON.stringify(rec)}\n`, "utf8");
}

/** Script 1: uses every discovery global, so `reachesTools` resolves to "all". */
const WIDE_SCRIPT = `
const obs = {};

obs.allToolNames = ALL_TOOLS.map(function (t) { return t.name; });
obs.allToolsHasProbeEcho = obs.allToolNames.indexOf("probe_echo") >= 0;
obs.allToolsHasProbeEchoPlain = obs.allToolNames.indexOf("probe_echo_plain") >= 0;

obs.searchToolsProbeEcho = await searchTools("probe_echo", { limit: 5 });
obs.describeProbeEcho = await describeTool("probe_echo");
obs.describeDeferred = await describeTool("probe_echo_deferred");

let r1;
try {
  r1 = await tools.probe_echo({
    payload: "hello-codemode",
    count: 42,
    maybe: undefined,
    jsonLooking: '{"a":1}',
    nested: { a: 7, b: "seven" }
  });
} catch (e) {
  r1 = { __error: String(e) };
}
obs.structuredResult = r1;
obs.structuredResultType = typeof r1;
obs.structuredResultIsArray = Array.isArray(r1);
obs.structuredResultHasDetailsKey = (r1 !== null && typeof r1 === "object") ? ("details" in r1) : false;
obs.structuredResultHasContentKey = (r1 !== null && typeof r1 === "object") ? ("content" in r1) : false;
obs.structuredResultHasStructuredContentKey = (r1 !== null && typeof r1 === "object") ? ("structuredContent" in r1) : false;
obs.structuredResultJson = JSON.stringify(r1);
obs.structuredResultContainsDetailsMarker = obs.structuredResultJson.indexOf("DETAILS_MARKER") >= 0;

let r2;
try {
  r2 = await tools.probe_echo_plain({ payload: "plain-payload" });
} catch (e) {
  r2 = { __error: String(e) };
}
obs.plainResult = r2;
obs.plainResultType = typeof r2;
obs.plainResultJson = JSON.stringify(r2);
obs.plainResultContainsDetailsMarker = obs.plainResultJson.indexOf("PLAIN_DETAILS_MARKER") >= 0;

let r3;
try {
  r3 = await tools.probe_echo({});
} catch (e) {
  r3 = { __error: String(e) };
}
obs.emptyArgsResult = r3;
obs.emptyArgsType = typeof r3;

let r4;
try {
  r4 = await tools.probe_echo();
} catch (e) {
  r4 = { __error: String(e) };
}
obs.noArgsResult = r4;
obs.noArgsType = typeof r4;

// deferred-exposure tool: callable from a script even though it is not listed
obs.allToolsHasDeferred = obs.allToolNames.indexOf("probe_echo_deferred") >= 0;
let r5;
try {
  r5 = await tools.probe_echo_deferred({ payload: "deferred-payload" });
} catch (e) {
  r5 = { __error: String(e) };
}
obs.deferredResult = r5;
obs.deferredResultType = typeof r5;
obs.deferredResultJson = JSON.stringify(r5);

// a required-parameter tool, to see what the script sees when validation fails
let r6;
try {
  r6 = await tools.probe_echo_required({});
} catch (e) {
  r6 = { __error: String(e), __isError: true };
}
obs.requiredMissingArgResult = r6;
obs.requiredMissingArgType = typeof r6;

text(JSON.stringify(obs));
`;

/** Script 2: no discovery global at all — reach falls back to the words of the source. */
const DIRECT_SCRIPT = `
const r = await tools.probe_echo({ payload: "direct-only" });
text(JSON.stringify({ type: typeof r, value: r }));
`;

export default function probeBridge(pi: ExtensionAPI): void {
  // --- Q3a: tool WITH outputSchema -------------------------------------------
  pi.registerTool({
    name: "probe_echo",
    label: "probe_echo",
    description: "Echo probe with an output schema. Returns a details marker, text, and structured content.",
    parameters: Type.Object({
      payload: Type.Optional(Type.String()),
      count: Type.Optional(Type.Number()),
      maybe: Type.Optional(Type.String()),
      jsonLooking: Type.Optional(Type.String()),
      nested: Type.Optional(
        Type.Object({ a: Type.Optional(Type.Number()), b: Type.Optional(Type.String()) }),
      ),
    }),
    outputSchema: Type.Object({
      marker: Type.String(),
      echoed: Type.Optional(Type.String()),
      count: Type.Optional(Type.Number()),
    }),
    exposure: "codemode",
    async execute(_toolCallId, params) {
      record({
        kind: "tool_execute",
        tool: "probe_echo",
        receivedType: typeof params,
        receivedIsArray: Array.isArray(params),
        receivedKeys:
          params !== null && typeof params === "object" ? Object.keys(params) : null,
        hasMaybeKey:
          params !== null && typeof params === "object" ? "maybe" in params : null,
        maybeValue: params?.maybe,
        payloadType: typeof params?.payload,
        countType: typeof params?.count,
        jsonLookingType: typeof params?.jsonLooking,
        jsonLookingValue: params?.jsonLooking,
        nestedIsObject:
          params?.nested !== null && typeof params?.nested === "object"
            ? Array.isArray(params.nested)
            : null,
        nestedKeys:
          params?.nested !== null && typeof params?.nested === "object"
            ? Object.keys(params.nested)
            : null,
        receivedJson: JSON.stringify(params),
      });
      return {
        content: [
          { type: "text", text: `TEXT_CONTENT_MARKER payload=${params?.payload}` },
        ],
        details: { marker: "DETAILS_MARKER", payload: params?.payload },
        structuredContent: {
          marker: "STRUCTURED_CONTENT_MARKER",
          echoed: params?.payload,
          count: params?.count,
        },
      };
    },
  });

  // --- Q3b: tool WITHOUT outputSchema ----------------------------------------
  pi.registerTool({
    name: "probe_echo_plain",
    label: "probe_echo_plain",
    description: "Echo probe without an output schema. Returns a details marker and text only.",
    parameters: Type.Object({ payload: Type.Optional(Type.String()) }),
    exposure: "codemode",
    async execute(_toolCallId, params) {
      record({
        kind: "tool_execute",
        tool: "probe_echo_plain",
        receivedType: typeof params,
        receivedKeys:
          params !== null && typeof params === "object" ? Object.keys(params) : null,
        receivedJson: JSON.stringify(params),
      });
      return {
        content: [
          { type: "text", text: `PLAIN_TEXT_CONTENT_MARKER payload=${params?.payload}` },
        ],
        details: { marker: "PLAIN_DETAILS_MARKER", payload: params?.payload },
      };
    },
  });

  // --- Q5 contrast: a `deferred` exposure tool -------------------------------
  pi.registerTool({
    name: "probe_echo_deferred",
    label: "probe_echo_deferred",
    description: "Echo probe with deferred exposure. Stands in for the MCP codemode-to-deferred rewrite.",
    parameters: Type.Object({ payload: Type.Optional(Type.String()) }),
    exposure: "deferred",
    async execute(_toolCallId, params) {
      record({
        kind: "tool_execute",
        tool: "probe_echo_deferred",
        receivedType: typeof params,
        receivedKeys:
          params !== null && typeof params === "object" ? Object.keys(params) : null,
        receivedJson: JSON.stringify(params),
      });
      return {
        content: [
          { type: "text", text: `DEFERRED_TEXT_CONTENT_MARKER payload=${params?.payload}` },
        ],
        details: { marker: "DEFERRED_DETAILS_MARKER" },
      };
    },
  });

  // --- a required-parameter tool, for the invalid-argument case ---------------
  pi.registerTool({
    name: "probe_echo_required",
    label: "probe_echo_required",
    description: "Echo probe with a required parameter.",
    parameters: Type.Object({ payload: Type.String() }),
    exposure: "codemode",
    async execute(_toolCallId, params) {
      record({
        kind: "tool_execute",
        tool: "probe_echo_required",
        receivedType: typeof params,
        receivedJson: JSON.stringify(params),
      });
      return { content: [{ type: "text", text: "REQUIRED_OK" }], details: null };
    },
  });

  // --- Q4: what is registered at all ------------------------------------------
  pi.on("session_start", () => {
    record({
      kind: "all_tools",
      tools: pi.getAllTools().map((t) => ({ name: t.name, exposure: t.exposure })),
    });
  });

  // --- canned provider --------------------------------------------------------
  let request = 0;

  pi.registerProvider(PROVIDER, {
    name: "codemode bridge probe (offline)",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "not-a-real-key",
    api: "anthropic-messages",
    models: [
      {
        id: MODEL,
        name: "probe model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 100,
      },
    ],
    streamSimple: (_model, context) => {
      request += 1;
      const index = request;

      const modelTools = getCurrentTools(context.messages);
      record({
        kind: "model_request",
        request: index,
        modelToolNames: modelTools.map((t) => t.name),
        codemodeDescription:
          modelTools.find((t) => t.name === "codemode")?.description ?? null,
        messages: JSON.parse(JSON.stringify(context.messages)),
      });

      const usage = {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const base = {
        role: "assistant" as const,
        api: "anthropic-messages" as const,
        provider: PROVIDER,
        model: MODEL,
        usage,
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();

      const emitToolCall = (name: string, args: Record<string, unknown>, id: string) => {
        const toolCall = { type: "toolCall" as const, id, name, arguments: args };
        const message = { ...base, content: [toolCall], stopReason: "toolUse" as const };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      };

      if (index === 1) {
        emitToolCall("codemode", { code: WIDE_SCRIPT }, "call-codemode-wide");
        return stream;
      }
      if (index === 2) {
        emitToolCall("codemode", { code: DIRECT_SCRIPT }, "call-codemode-direct");
        return stream;
      }
      if (index === 3) {
        emitToolCall("tool_search", { query: "probe_echo" }, "call-tool-search");
        return stream;
      }

      const message = {
        ...base,
        content: [{ type: "text" as const, text: "probe complete" }],
        stopReason: "stop" as const,
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "probe complete",
        partial: message,
      });
      stream.push({ type: "text_end", contentIndex: 0, content: "probe complete", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
}
````

## 9. 快照与复核命令

### 9.1 快照

| 项                          | 值                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------- |
| 仓库 HEAD                   | `fe5701a`                                                                               |
| pi（被跑的）                | `1.3.0`（`/Users/lilianda/.bun/bin/pi`）                                                |
| 本仓 tree 里的 pi           | `@earendil-works/pi-coding-agent@1.3.0`（同版本，探针只借它的 `node_modules` 解析依赖） |
| pi-codemode / pi-agent-core | `1.3.0` / `1.3.0`                                                                       |
| Node                        | v24.22.0                                                                                |
| 隔离 agent dir              | `/tmp/pi-codemode-probe/agent`（`PI_CODING_AGENT_DIR`）                                 |
| 观测文件                    | `/tmp/pi-codemode-probe/out/observations.jsonl`                                         |
| 探针源码                    | `/tmp/pi-codemode-probe/probe/probe.ts`（全文见 §8）                                    |

### 9.2 复核命令（逐条可粘贴）

```bash
# ---- 准备（一次性）------------------------------------------------------
rm -rf /tmp/pi-codemode-probe
mkdir -p /tmp/pi-codemode-probe/{agent,out,work,probe}
# 探针在 /tmp，裸导入 @earendil-works/pi-ai / typebox 要能解析
ln -s /Users/lilianda/develop/pi-ptc-subagents/node_modules \
      /tmp/pi-codemode-probe/probe/node_modules
# 把 §8 的源码整段写到 /tmp/pi-codemode-probe/probe/probe.ts

# ---- 跑 ----------------------------------------------------------------
cd /tmp/pi-codemode-probe/work
rm -f /tmp/pi-codemode-probe/out/observations.jsonl
PI_CODING_AGENT_DIR=/tmp/pi-codemode-probe/agent \
PROBE_OUT=/tmp/pi-codemode-probe/out/observations.jsonl \
pi --no-session --offline \
  -e /tmp/pi-codemode-probe/probe/probe.ts \
  --provider probe-bridge --model probe-bridge-model \
  --tools +codemode,+tool_search \
  -p "run the codemode bridge probe"
# 期望输出：probe complete   （退出码 0；整个 run 约 2 秒）

# ---- Q1/Q2：扩展 execute() 实际收到了什么 --------------------------------
python3 - <<'PY'
import json
recs = [json.loads(l) for l in open('/tmp/pi-codemode-probe/out/observations.jsonl')]
for r in recs:
    if r['kind'] == 'tool_execute':
        print(r['tool'], '->', r.get('receivedJson'), '| keys', r.get('receivedKeys'))
PY

# ---- Q3：脚本侧拿到什么（codemode 工具结果里脚本自己 text() 出来的） ------
python3 - <<'PY'
import json
recs = [json.loads(l) for l in open('/tmp/pi-codemode-probe/out/observations.jsonl')]
req = [r for r in recs if r['kind'] == 'model_request' and r['request'] == 2][0]
for m in req['messages']:
    if m.get('role') != 'toolResult':
        continue
    body = m['content'] if isinstance(m['content'], str) else \
        '\n'.join(p.get('text', '') for p in m['content'] if p.get('type') == 'text')
    print(json.dumps(json.loads(body.split('\n\n', 1)[1]), indent=2))
PY

# ---- Q4：注册面 vs 模型面 ------------------------------------------------
python3 - <<'PY'
import json
recs = [json.loads(l) for l in open('/tmp/pi-codemode-probe/out/observations.jsonl')]
for r in recs:
    if r['kind'] == 'all_tools':
        print('registered:', [(t['name'], t['exposure']) for t in r['tools']])
    if r['kind'] == 'model_request':
        print(f"model_request {r['request']}:", r['modelToolNames'])
PY

# ---- Q5：codemode 目录里列了谁 --------------------------------------------
python3 - <<'PY'
import json
recs = [json.loads(l) for l in open('/tmp/pi-codemode-probe/out/observations.jsonl')]
d = [r for r in recs if r['kind'] == 'model_request' and r['request'] == 1][0]['codemodeDescription']
print(d[d.find('Nested tools:'):])
for n in ('probe_echo', 'probe_echo_plain', 'probe_echo_required',
          'probe_echo_deferred', 'read', 'bash'):
    print(f'  listed: {n:22s} -> {n in d}')
PY
```

### 9.3 静态侧复核（本次对照用，非实测）

```bash
cd /Users/lilianda/develop/pi-ptc-subagents/node_modules/@earendil-works/pi-coding-agent
grep -n "_getCallableTools(active" -A 6 dist/core/agent-session.js        # 可调用集合按 exposure 决定
grep -n "_isDeclarable(name)" -A 4 dist/core/agent-session.js            # 只有 direct/model-only 面向模型
grep -n "getCodemodeCallableTools(ctx.tools)" dist/extensions/codemode/execute.js
grep -n "ctx.executeTool(tool.name, args" dist/extensions/codemode/execute.js
grep -n "function toScriptValue" -A 9 dist/extensions/codemode/execute.js # structuredContent / text 的选择
grep -n "isSearchable(exposure)" -A 2 dist/extensions/tool-search/tool.js # tool_search 搜 codemode + deferred
grep -n "options.deferred?.has" -B 2 -A 2 dist/extensions/codemode/tool.js # deferred 档不进目录
```

## 10. 未核实清单

以下都是**本次没有核到底**的部分，不做推断：

1. **没有用真模型跑。** 会话由 canned provider 驱动，"模型"侧的行为是脚本写死的。**被观测的是桥，不是模型的选择。** 模型会不会真的写 `tools.probe_echo(...)`（而不是绕路）、会不会用 `searchTools` 而不是直接调，本次没有观测。
2. **没有验 `codemode.mode`（`on` / `only`）与 `codemode.inlineBudget` 的运行时行为。** 本次是默认 `on`；`only` 模式下 `direct` 档工具会从模型面隐藏、全部 callable 工具进目录，**未实测**。目录预算（默认 3000 估算 token）本次没触发（4 个短工具），**超预算时被剔除的行为未实测**。
3. **没有压测桥的字节上限。** 静态笔记 §3.4 说"桥本身没有参数/结果字节上限"，本次没测多大的载荷能稳稳过桥。
4. **`{}`（整个参数为 `undefined` 时）到底在哪一层补的，没隔离。** §3 里给了静态推断（`pi-ai` 的 `Value.Convert`），但那是**推断，不是观测**。
5. **只测了 pi 1.3.0。** 0.99.0（`exposure` 与 codemode 同时出现的那个版本）没有跑。静态取证笔记 §5 的跨版本结论本次没有独立复核。
6. **没有测 MCP 工具。** `deferred` 档用扩展工具替身代表（MCP 的 `codemode` 档在 pi 侧被改写成 `deferred`），**没有真的接一个 MCP server**。
7. **没有测并发。** 脚本里是顺序 `await`，没测多个 `tools.*` 并发调用同一个工具时的行为。
8. **`tool_search` 激活后的完整后果没测。** 只观测到"下一次模型请求的工具列表多出了这四个"，没有继续跑一轮看被激活后它们是否还留在 codemode 目录里、是否影响 `codemode` 描述的重建。
9. **没有测 `isError` / 抛错路径的 `structuredContent` 情形。** 静态笔记 §3.2 提到"MCP 工具把整个 `CallToolResult` 放进 `structuredContent`，所以 `isError` 时脚本 resolve 而不是 reject" —— 那是 MCP 特有的，本次没验。
