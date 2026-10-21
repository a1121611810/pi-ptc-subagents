# DeepSeek 搜索是程序内可达的能力，不是 model-facing 工具

---

status: **withdrawn 2026-10-20** by
[ADR-0049](./0049-the-search-lives-in-the-child.md). 「两个面 / 程序内可达」这个形状不再成立：搜索
改成**只活在被派出去的子代理里**，在子代理里由**子代理自己的模型**直接调用（`exposure: "direct"`），
父会话里**完全不存在**（不注册，也不解析凭据）。

本记录的前提大体还在——「检索源固定、不做可插拔」、「名字里带 `ds`」、「错误文案一份共享常量」、
「结果原样透传」这四条**全部继续成立**，见 ADR-0049。**不再成立**的是形状本身：codemode 面与 PTC
binding 面这两个载体，以及「模型看不见」这条承诺——`tool_search` 本来就能把 `codemode` 档工具翻到
直接面（见文末 §修订），那条窄面从来不是硬保证。

读下面的决策当作**历史**：它记录了 2026-10-20 定了什么、依据是什么，不描述现在的行为。

status (original): accepted (2026-10-20). Ticket #227 (map #226). 配套记录：[ADR-0048](./0048-deepseek-search-gate.md)（门禁契约）。
**Amended 2026-10-20（实测后）**：桥接已由真机观测确认；同时「不面向模型」由「永不」修正为「**默认**」——
`tool_search` 能把 `codemode` 档工具激活进模型声明。见文末 §修订。

## Context

pi 没有网页检索能力：内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`。DeepSeek 在 2026-10-17 开放了 Search / Fetch 两个**模型无关**的裸 JSON 接口（`POST https://api.deepseek.com/v1/tools/search`、`/v1/tools/fetch`），和聊天模型完全解耦，同一把 `api.deepseek.com` 的 Bearer key 就能调——所以「加搜索」在技术上不难。

难的是**加在哪**。

业界的主流答案是「顶层 model-facing 工具」：Claude Code 的 `WebSearch` / `WebFetch`、OpenAI Responses 的 `web_ds_search`、Zed 的 `search_web`、OpenCode 的 `websearch`、Cline 的 `web_ds_search` 插件，五家都是这样。OpenCode 官方文档还明确写了机制：「`codemode` defaults true；**`codemode: false` keeps the tool on the provider's native tool list**」，而 **MCP 工具默认进 CodeMode**（`packages/core/src/tool/mcp.ts:45`）——同一个 harness 里，「程序内可达」与「原生工具位」两种形态并存，不互斥。

本包走的是另一条主张。ADR-0010 记录的 narrowing mode 收窄的是**模型直接面**：bound built-ins 只从程序里够得到，模型的直接面因此更窄。把搜索做成顶层 model-facing 工具，等于在这条主张上开一个洞，而且开的是一个**带网络出口**的洞。

pi 的 `ToolExposure` 让这件事有了精确的选项（官方 `docs/extensions.md` §Tool exposure）：

| exposure         | 面向模型               | 可被程序调（`ctx.executeTool()`）                  |
| ---------------- | ---------------------- | -------------------------------------------------- |
| `direct`（默认） | 是（active 时）        | 是（active 时）                                    |
| `model-only`     | 是（active 时）        | **否**                                             |
| **`codemode`**   | **否**（除非显式激活） | **是**（注册即可）                                 |
| `deferred`       | 否                     | 是（但 codemode 不列出它，`tool_search` 才能发现） |
| `hidden`         | 否                     | 否                                                 |

`_isDeclarable` 只放行 `direct` / `model-only`（`dist/core/agent-session.js:2926-2929`），所以 `codemode` 档的语义恰好是「程序内可达、模型看不见」。

本仓其实有**三条**程序面，不是一条：

1. **codemode 面** —— pi 自带的 `codemode` 工具在 QuickJS 沙箱里跑脚本（无 Node、无文件系统、无网络、无定时器），脚本通过 `searchTools` / `describeTool` 发现并调用暴露在 codemode 目录里的工具。桥接已证：`dist/extensions/codemode/execute.js:421` → `await ctx.executeTool(tool.name, args, { signal })`；MCP 工具与扩展工具走**同一条**路（MCP 自己也用 `pi.registerTool`，`dist/extensions/mcp/index.js:336`）。
2. **PTC binding 面** —— pi-ptc 自己的 Node worker 绑定表，`tools["<name>"](args)`。`pi.dispatch` 就是这么做的。
3. **顶层 model-facing** —— `exposure: "direct"` 的 pi 工具。

## Decision

**搜索是程序内可达的能力，默认不面向模型。**

具体形状是**一份实现、两个面**：

- **codemode 面**：注册成 pi 工具 `web_ds_search`，`exposure: "codemode"` ⇒ `subagents` surface 上模型的 codemode 脚本一跳可达，模型直接面里没有它。
- **PTC binding 面**：进 pi-ptc 的 binding 表，名字 `web.ds.search` ⇒ `full` surface 上模型的 PTC 程序一跳可达；任何 surface 的 PTC 程序都可用。

**不**注册 `exposure: "direct"` 的顶层工具。

### 为什么是「两个面」而不是一个

- **只有 codemode 工具**：A 之下 `full` surface 的模型写 PTC 程序，程序里没有这个 binding ⇒ 拿不到。
- **只有 PTC binding**：B 之下 `subagents` surface 的模型写 codemode 脚本，QuickJS 沙箱里没有 PTC worker ⇒ 要绕两跳（codemode → `ptc_run_code` → binding）。
- **两个面共用一份实现**：唯一在两个 surface 都既不面向模型、又不缺能力的形状。

### 三条硬约束

1. **搜索工具不得在 `full` surface 以 model-facing 形态注册。** 0.86.0–0.87.x 上 `exposure` 字段不存在（`docs/agents/pi-compat-matrix.md:63`），注册的工具**一律面向模型** ⇒ 那样做会直接违反本决策。0.86.0 上「程序内可达」只有 PTC binding 那条路（它走 pi-ptc 自己的 worker，不依赖任何 pi 新 API）。
2. **工具必须声明 `outputSchema`。** codemode 脚本侧只拿得到 `structuredContent`（声明了 `outputSchema` 且返回了它时），否则是一坨文本字符串，**`details` 永不进脚本**（`dist/extensions/codemode/execute.js:370-378`）。不声明 ⇒ codemode 侧拿不到结构化 `results`。
3. **两处的错误文案是同一份共享常量**（one-home rule，先例 `BINDING_CONTRACT`）。两条通道的**结果**契约本来就不同（binding 侧是 `{content, details}`，codemode 侧是 `structuredContent`），实现要让同一份实现在两处各自成立；错误文案则必须一致。
4. **不注册 `exposure: "direct"` 是本决策能控制的部分；模型能不能把它翻到直接面，不是。** 见文末 §修订。

### 命名：名字里带 `ds`

- pi 工具名 `web_ds_search`（下划线）——pi 的工具名要进 `--tools` allowlist 匹配，不带点更安全。
- PTC binding 名 `web.ds.search`（点号命名空间）——本仓 binding 表里非 pi 内置的能力用点号命名空间，先例 `pi.dispatch`。
- 配置键 `webDsSearch`（`~/.pi/agent/ptc.json`）——见 ADR-0048。

**三个名字都带 `ds`，三个理由：**

1. **一眼看得出这是 DeepSeek 提供的搜索。** 这个能力要 DeepSeek 的 key、走 DeepSeek 的账单、用 DeepSeek 自研的搜索引擎。一个叫 `web_search` 的名字会让人以为它是通用网页搜索，而它其实**只**走 DeepSeek。模型在工具列表里看到它、人在配置文件里看到它，都不用再查文档才知道它绑在哪家服务商上。
2. **provider 是契约的一部分，不是实现细节。** 检索源固定为 DeepSeek、不做可插拔（map #226 基线 6）⇒「这是 DS 的搜索」是**永久**事实。写进名字是诚实的，也把通用名 `web_search` 空出来留给将来真正 provider-agnostic 的工具。
3. **⚠️ 与 DSH 自带工具的同名覆盖风险。** 本包的前提就是 DSH 对齐，而 **DSH 自己就带一个叫 `web_search` 的工具**（`dsh-tool-web`，`tool:web_search`）——ADR-0010 里「A binding for `web_search` or `todo` is therefore impossible to build」那个例子就是它。pi 的工具注册表是**按名字做 key 的 Map**（`toolRegistry.set(tool.name, tool)`，`dist/core/agent-session.js:2895`）⇒ **同名注册会互相覆盖**。装了 DSH 工具的 pi 会话里，若本包也注册 `web_search`，两者直接撞车。本仓的 `src/mode/ptc-mode.ts` 与 `tests/ptc-mode.test.ts` 一直拿 `web_search` 当「别的扩展的工具」的例子 ⇒ **这个名字在本仓语境里已经指 DSH 的工具**。

**两个名字、一个能力，是刻意的。**

## Alternatives considered

| 方案                                                                    | 为什么没选                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶层 model-facing 工具（业界默认）                                      | 与 ADR-0010 的窄面主张冲突；且是一个带网络出口的洞                                                                                                                                                  |
| 只做 codemode 工具                                                      | `full` surface 拿不到                                                                                                                                                                               |
| 只做 PTC binding                                                        | `subagents` surface 要绕两跳                                                                                                                                                                        |
| 走 provider 端 server tool（DeepSeek Responses API 的 `web_ds_search`） | **仅 deepseek-v4-pro**；结果由服务端自动进上下文，**拿不到 `results` 原始字段**、引用不可控、检索源不可换                                                                                           |
| 走 MCP 搜索服务器（Brave / Tavily / Exa）                               | 不「内置」，要用户自己配 `mcp.json`；且 MCP 的 `codemode` 档被 pi 改写成 `deferred`（`dist/extensions/mcp/tools.js:26`）⇒ 工具在 codemode 脚本里要靠 `tool_search` 才能发现，自注册工具可直接被列出 |
| 只做 fetch 不做 search                                                  | 搜不到就无从抓；Fetch 单独存在只解决「已知 URL」                                                                                                                                                    |

## Consequences

- **搜索在模型直接面里不存在**，在两个 surface 上都一跳可达。dispatch 出来的 child 是完整 pi 进程，扩展在它里面照常加载 ⇒ 程序面能力随之到位，**不需要任何 child 注入机制**。
- **binding contract（ADR-0024）要扩一个名字**：搜索要被点名（它有条例外行为：结果形状不是通用的 `{content, details}`），并进双向覆盖检查。
- **narrowing mode（ADR-0010）不受影响**：搜索本来就不面向模型，不需要豁免，ADR-0010 不用改。
- **0.86.0–0.87.x 上搜索只有 PTC binding 一条路**（`exposure` 不存在 ⇒ 不能注册成 codemode 面的工具）。这不构成新的能力下限——既有的 capability floor 0.99.0 已经覆盖了 codemode 与 `exposure`（`docs/agents/pi-compat-matrix.md:63`、`:66`）。
- **一条未闭合的实测缺口**：「codemode 脚本真的调到扩展注册的 `exposure:"codemode"` 工具」这件事，全部结论来自静态取证（1.3.0 / 0.99.0 / 0.86.0 编译产物 + 官方 docs），**没有观测到一次真实调用**。落地前应补一次真实 pi 的端到端复现。取证：`docs/research/pi-codemode-tool-bridging-20261020.md`。

## 修订（2026-10-20，实测后）

静态取证之后补了一次**真机观测**：一个最小探针 pi 扩展注册 4 个假工具（3 个 `exposure: "codemode"`、1 个 `deferred`），配离线 canned provider 驱动真实 `codemode` 工具调用，在真机 pi 1.3.0 上跑通 4 次。取证笔记：`docs/research/pi-codemode-bridge-live-probe-20261020.md`。

**一、桥接成立。** 静态结论**一条也没有被证伪**：扩展工具进了 codemode 脚本的工具表、`execute()` 在宿主侧真跑了 6 次；入参是一次 JSON 往返（普通 JS 对象，显式 `undefined` 的键直接不存在）；声明 `outputSchema` 且返回 `structuredContent` 时脚本拿到 `structuredContent` **本身**、否则拿到文本字符串；**`details` 确认到不了脚本**；`codemode` 档会被列进 codemode 工具自己的描述（`deferred` 档不列）。

⇒ **决策不变**：C 方案（两个面共用一份实现）现在有实测支撑。

**二、但「不面向模型」是默认状态，不是硬保证。** 实测观测到一条静态笔记没写的路径：

> `tool_search` 能搜到 `codemode` 档工具，**并且会把它激活成模型可见**。

原始观测：模型请求 1/2/3 的工具列表里没有探针工具；第 3 次请求发出 `tool_search({ query: "probe_echo" })` 之后，第 4 次请求的工具列表里**多出四个**探针工具。

⇒ 因此本记录开头那句「永远不面向模型」**修正为「默认不面向模型」**。这一条**防不住**：`tool_search` 的可搜集合就是 `codemode` + `deferred` 的注册工具（`dist/extensions/tool-search/tool.js:136-138`），而 pi 没有「可被 codemode 调、但不被 `tool_search` 搜到」这一档 exposure（`direct` 面向模型、`model-only` 不可被程序调、`codemode` 可被程序调但会被搜到、`deferred` 同理但不被列出、`hidden` 完全不可达）。

**⇒ 实现期必须接受并记录的事实**：**不注册成 `direct`** 是本决策能控制的部分；**模型主动调 `tool_search` 把搜索翻到直接面**，是 pi 的机制，不是我们注册错了。规格里对应改法：「模型直接面里**默认**没有搜索」，并加一条实现约束——描述里要写明这个工具是程序内可达的（因为它一旦被 `tool_search` 激活，模型就会在直接面看到它）。

**三、附带的可用性前提**：`exposure: "codemode"` 那一面要求 **codemode 已加载且已激活**（pi 0.99.0 起 `codemode` 默认注册为 inactive）。本仓 `subagents` surface 的判定本来就要求这两者同时成立 ⇒ 与既有判定自洽，实现期不需要额外的门。

## See also

- ADR-0010 —— PTC 默认模式：收窄 loadout，snapshot bindings
- ADR-0024 —— binding contract：工具描述声明 binding call 解析成什么
- ADR-0040 —— `bash` 是 opt-in binding
- ADR-0048 —— 搜索的门禁：开关与凭据判定
- `docs/specs/0044-deepseek-search-module.md` —— 本决策的规格
- `docs/research/pi-codemode-bridge-live-probe-20261020.md` —— 真机实测（桥接成立，且 `tool_search` 那条路径）
- `docs/research/pi-codemode-tool-bridging-20261020.md` —— 静态取证（本记录 §修订 的对照面）
