# DeepSeek 搜索是程序内可达的能力，不是 model-facing 工具

status: accepted (2026-10-20). Ticket #227 (map #226). 配套记录：[ADR-0048](./0048-deepseek-search-gate.md)（门禁契约）。

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

**搜索是程序内可达的能力，永远不面向模型。**

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

## See also

- ADR-0010 —— PTC 默认模式：收窄 loadout，snapshot bindings
- ADR-0024 —— binding contract：工具描述声明 binding call 解析成什么
- ADR-0040 —— `bash` 是 opt-in binding
- ADR-0048 —— 搜索的门禁：开关与凭据判定
- `docs/specs/0044-deepseek-search-module.md` —— 本决策的规格
