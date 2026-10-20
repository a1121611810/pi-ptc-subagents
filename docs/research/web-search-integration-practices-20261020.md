# Agent harness 集成网页搜索与抓取的一手做法：形态、工具位置、凭据与开关

> 调研日期: 2026-10-20。回答「主流 agent harness / 编码 agent 框架把网页搜索与抓取接进来的**形态**有哪几种、搜索工具在工具面里放哪一层、搜索 key 缺失时成熟 harness 的**具体行为**是什么、有没有『总开关 + 缺 key 降级告警』这种组合」，为 `pi-ptc-subagents` 给 PTC 加内置搜索模块的形态拍板提供业界已跑通的先例。
> 方法: 一手文档抓取 + 开源 harness 源码精读（读源码的判据是「工具是否注册 / 缺 key 怎么办」这类行为只有源码里有）。文档侧走各站官方站点（`code.claude.com`、`developers.openai.com`、`api-docs.deepseek.com`、`opencode.ai`）；源码侧走 GitHub 官方仓库（`openai/codex`、`sst/opencode`、`cline/cline`、`block/goose`、`zed-industries/zed`、`brave/brave-search-mcp-server`、`tavily-ai/tavily-mcp`、`lastmile-ai/mcp-agent`）。**未实测调用任何搜索 API**（无第三方 key）。
> 一手来源说明: 每条机制性断言后给 URL；源码级断言给「仓库路径 + 符号名（行号能确证的给行号）」。`platform.claude.com`（Anthropic API 文档站）**从本机被地域拦截**（返回 "App unavailable in region" 页面），因此 Anthropic API 侧的 web search 工具契约**未能核到**，见 §9；Claude Code 侧改用 `code.claude.com` 官方文档核到。
> 复核命令: 见 §10。
> 仓库快照: `pi-ptc-subagents` HEAD `64de4bd`；本笔记只新增本文件，未改动仓库其它任何文件。

## 0. 结论速查表

| #   | 问题                                     | 结论                                                                                                                                                                                                                                                                                                                                                                                                                              | 出处                                                                                                                                       |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 形态有几种                               | **三类**：①provider 端 server tool（Anthropic WebSearch / OpenAI `web_search` / DeepSeek server 端工具）②harness 本地实现（OpenCode 多 provider 插件、Zed、Claude Code WebFetch）③第三方 MCP 搜索服务器（Brave / Tavily / Exa）                                                                                                                                                                                                   | §1                                                                                                                                         |
| 2   | provider 端 server tool 的结果怎么回模型 | **服务端自动进上下文**，客户端拿不到原始结构；引用以服务端生成的 citation 形式表达（OpenAI 为 `url_citation` annotations）                                                                                                                                                                                                                                                                                                        | [OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search.md) §2.3.2                                                         |
| 3   | 本地实现的结果怎么回模型                 | **两种**：原始结构化结果（OpenCode 输出 `{provider, results}`）或**纯文本/模型总结**（Claude Code WebFetch 用一次独立模型调用把正文总结后再给模型）                                                                                                                                                                                                                                                                               | [Claude Code](https://code.claude.com/docs/en/tools.md#webfetch-tool-behavior)、OpenCode 源码 `packages/core/src/tool/plugin/websearch.ts` |
| 4   | 搜索工具放哪一层                         | **顶层模型直接可调**是主流：Claude Code `WebSearch`/`WebFetch`、OpenAI `web_search`、Zed `search_web`、OpenCode `websearch`、Cline 插件 `web_search` 都是原生工具位；**程序内可达**是 OpenCode 的 CodeMode 与 Codex 的 standalone 扩展                                                                                                                                                                                            | §5                                                                                                                                         |
| 5   | MCP 工具默认在哪一层                     | **OpenCode 的 MCP 工具默认进 CodeMode**（只在生成的程序里可达，不进模型原生工具面）；`websearch` 显式 `codemode: false` 留在原生工具面——**同一个 harness 里两种都有**                                                                                                                                                                                                                                                             | [OpenCode AGENTS.md](https://github.com/sst/opencode/blob/dev/packages/core/src/tool/AGENTS.md)、`packages/core/src/tool/mcp.ts:45`        |
| 6   | 搜索 key 是复用模型 key 还是独立 key     | **两种都有**：provider 端 server tool 复用模型服务商 key（Anthropic/OpenAI/DeepSeek）；本地实现与 MCP 服务器用**独立第三方 key**（Brave / Tavily / Exa / Serper）                                                                                                                                                                                                                                                                 | §6.1                                                                                                                                       |
| 7   | **缺 key 时成熟 harness 怎么做**         | **查到 7 种并存的实测行为**：①启动即失败、零工具（Brave MCP）②启动 warn + 工具照常注册 + 逐工具降级（Tavily MCP）③根本不需要 key（Goose 的 DuckDuckGo 默认、OpenCode 托管路径）④工具已注册、调用时报错（Zed「Web search is not available.」、OpenCode 401）⑤工具压根不进请求（Codex `Disabled`/无 provider 能力）⑥策略型扣留 + 专用诊断入口（Claude Code `/status`、`claude doctor`）⑦UI 层明说「此设置暂无效果」（Cline 设置页） | §6.2                                                                                                                                       |
| 8   | 有没有「总开关 + 缺 key 降级」           | **有**。OpenCode 最完整：`websearch: false` → 工具从模型工具面**移除**；打开但没选 provider → 运行时弹表单问用户；provider 调用 401 → 「Web search authentication failed (HTTP 401)」回给模型。Tavily MCP 是「启动 warn + keyless 降级」的最短实现                                                                                                                                                                                | §7                                                                                                                                         |
| 9   | 引用/来源怎么表示                        | provider 端有服务端 citation 对象（OpenAI `url_citation` 带 url/title/start_index/end_index）；**本地实现没有 citation id**，只能靠 `url` 字段自己拼（与 DeepSeek Search API 同构，见同日笔记）                                                                                                                                                                                                                                   | [OpenAI](https://developers.openai.com/api/docs/guides/tools-web-search.md)、§3.2.2                                                        |
| 10  | 最接近本项目形态的先例                   | **OpenCode**：同样是「多 provider 插件 + 原生工具位 + 失败时把可读错误回给模型 + 配置可整体关掉」，且它同时有 CodeMode 可作为「程序内可达」的对照组                                                                                                                                                                                                                                                                               | §3.2                                                                                                                                       |

## 1. 形态分类与总对比表

### 1.1 三种形态的定义

- **形态 A｜provider 端 server tool**：harness 不碰搜索，只在模型请求里带上一个「服务端工具」声明；**搜索由模型服务商在服务端执行**，结果由服务端直接拼进上下文，客户端通常拿不到原始检索结构。
  - 代表：Claude Code `WebSearch`（Anthropic 后端）、OpenAI Responses API `web_search`、DeepSeek 的 server 端工具调用路径。
- **形态 B｜harness 本地实现**：harness 自己（或其插件生态）实现搜索/抓取，**在客户端侧执行**；要么打第三方搜索 API，要么起浏览器，要么起子进程跑 CLI。
  - 代表：OpenCode 的 exa/tavily/parallel/firecrawl/tinyfish 插件、Zed `search_web`、Claude Code `WebFetch`、Goose 的 DuckDuckGo skill、Cline 的 Exa 插件。
- **形态 C｜第三方 MCP 搜索服务器**：搜索逻辑住在**独立进程**里，以 MCP 协议暴露工具；harness 只做 MCP 客户端。
  - 代表：Brave Search MCP、Tavily MCP、Exa MCP、SearXNG MCP。

### 1.2 总对比表

| 形态 / 具体实现                                  | 谁执行搜索                                     | 工具位置                                   | 结果形态                                             | 引用/来源表示                                    | 凭据来源                                                                        | 缺 key 行为（实测证据）                                                                             |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A. Anthropic `WebSearch`（Claude Code）          | 模型服务商（Anthropic）                        | 顶层模型原生工具位（权限=Yes）             | 只回标题 + URL，**不抓正文**                         | 无 citation 对象（未核到，见 §9）                | 复用 Anthropic 账号 / API key                                                   | 能力不存在于当前 provider 时**工具不进请求**；配额耗尽回提示语（§6.2 ⑤、§7.4）                      |
| A. OpenAI `web_search`（Responses API）          | 模型服务商（OpenAI）                           | 顶层（`tools: [{type:"web_search"}]`）     | 服务端自动进上下文                                   | `url_citation` annotations（url/title/索引区间） | 复用 OpenAI API key                                                             | 工具由请求显式声明，不存在「注册/不注册」问题                                                       |
| A. DeepSeek server 端工具（Claude Code / Codex） | 模型服务商（DeepSeek）                         | 顶层（Codex 走 hosted tool）               | 服务端执行 + **额外一次模型调用**做总结              | 未核到（需自行拼 `url`）                         | 复用 DeepSeek API key                                                           | Codex 侧：模型不支持或 `web_search="disabled"` → 工具不生成（§6.2 ⑤）                               |
| B. Claude Code `WebFetch`                        | harness 本地（抓取）+ **独立模型调用**（总结） | 顶层模型原生工具位（权限=Yes）             | **纯文本总结**，非原始正文（官方称 lossy by design） | 无（模型自行在正文里提 URL）                     | 复用 Anthropic 账号（总结那步要模型）                                           | `CLAUDE_CODE_DISABLE_WEB_FETCH=1` 关掉；企业策略可扣留工具并在 `/status` 报出（§6.2 ⑥）             |
| B. OpenCode `websearch`                          | harness 本地（多 provider 插件）               | 顶层（`codemode: false` → 留在原生工具面） | 结构化 `{provider, results}` + Markdown 渲染内容     | 结果项自带 `url` / `title`，无 citation id       | 独立 key（`EXA_API_KEY` / `TAVILY_API_KEY`…），默认路径**不需要 key**           | 401 → 「Web search authentication failed (HTTP 401)」；无 provider → 运行时弹表单（§6.2 ④）         |
| B. Zed `search_web`                              | Zed Cloud（经 Zed 账号代理）                   | 顶层（`AgentTool`，仅 Zed Cloud provider） | 结构化 `WebSearchResponse`                           | 结果自带 URL                                     | Zed 账号（不额外收第三方 key）                                                  | 无 active provider → 调用时返回 `Error{ "Web search is not available." }`（§6.2 ④）                 |
| B. Goose `web-search` skill                      | harness 本地（起子进程跑 CLI）                 | **prompt / skill 层**，模型用 shell 跑     | 纯文本                                               | 脚本自己打印 URL                                 | 默认 DuckDuckGo **不需要 key**；Tavily/SearXNG 可选                             | 无需 key；key 存在时自动切到更好的 provider（§3.4）                                                 |
| B. Cline（provider 内建 / Exa 插件两条路）       | provider 端 或 harness 本地                    | 顶层（provider 内建 / 插件工具）           | provider 内建=服务端进上下文；插件=结构化结果        | provider 内建有服务端引用；插件靠 `url`          | provider 内建=provider key；插件=`EXA_API_KEY`                                  | 无 provider 支持内建搜索 → 设置页 amber 警告「此设置暂无效果」并给「去连接 provider」入口（§6.2 ⑦） |
| C. Brave Search MCP                              | 第三方 MCP 服务器                              | MCP 工具（由 harness 决定放哪层）          | 工具结果原样回模型                                   | 结果自带 URL                                     | 独立 `BRAVE_API_KEY`（或 `_FILE`）                                              | **启动即失败**：stderr 报错 + `process.exit(1)` → 客户端拿不到任何工具（§6.2 ①）                    |
| C. Tavily MCP                                    | 第三方 MCP 服务器                              | MCP 工具                                   | 工具结果原样回模型                                   | 结果自带 URL                                     | 独立 `TAVILY_API_KEY`                                                           | **启动 warn + keyless 降级**：search/extract 可用，其余工具回「需要 key」说明（§6.2 ②）             |
| C. mcp-agent 消费 Brave / Fetch MCP              | 第三方 MCP 服务器                              | MCP 工具                                   | 工具结果原样回模型                                   | 结果自带 URL                                     | key 放在 **MCP 服务器进程的环境变量**里（`mcp_agent.secrets.yaml`），不进模型侧 | key 缺失 = MCP 服务器自身启动失败（同 Brave）                                                       |

## 2. 形态 A｜provider 端 server tool

### 2.1 Anthropic：Claude Code 的 `WebSearch`

- 「WebSearch runs a query against Anthropic's [web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) backend and returns result titles and URLs. **It doesn't fetch the result pages.** To read a page Claude finds in search results, it follows up with WebFetch.」——<https://code.claude.com/docs/en/tools.md#websearch-tool-behavior>
- 「The tool may issue **up to eight backend searches per call**, refining the search internally before returning results. Claude can scope results with `allowed_domains` to include only certain hosts, or `blocked_domains` to exclude them. **The two lists can't be combined in a single call.**」——同上。
- 「**The search backend is not configurable.** To search with a different provider, add an MCP server that exposes a search tool.」——同上。
  → 这是本仓最该抄的一句：**server tool 形态下，harness 明说「换检索源就上 MCP」**。
- 工具位与权限：工具表里 `WebSearch` 标「Permission required: Yes」；`WebFetch` 同样为 Yes——<https://code.claude.com/docs/en/tools.md>。
- 配额是 harness 自己的、会退化的：「An interactive terminal session has a limit of **200 WebSearch calls**. Searches from the main conversation and from subagents, such as a parallel research fan-out, **count against the same limit**.」——<https://code.claude.com/docs/en/tools.md#session-search-limit>；额度以 `CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`（默认交互式 100/小时，**非交互式默认 0 = 不补充**）——<https://code.claude.com/docs/en/env-vars.md>。
- 平台可用性：「WebSearch is available on the Claude API, Claude Platform on AWS, and Microsoft Foundry. … Amazon Bedrock **doesn't expose** the server-side web search tool.」——<https://code.claude.com/docs/en/tools.md>。
  → **能力缺失时是「这个 provider 上没有这个工具」，不是「工具存在但报 401」。**

### 2.2 OpenAI：Responses API 的 `web_search`

- 「use the web search tool in the Responses API」；新集成用 `{ "type": "web_search" }`，旧的 `web_search_preview` 保留但不支持 `filters` / `external_web_access` / `return_token_budget`——<https://developers.openai.com/api/docs/guides/tools-web-search.md>。
- 「Like any other tool, **the model can choose to search the web or not** based on the content of the input prompt.」——同上。
- 三种形态由模型决定：non-reasoning web search（模型直接透传搜索工具的响应）、agentic search with reasoning models（模型在思维链里管理多次搜索）、deep research（数百来源、分钟级、建议 background mode）——同上。
- 引用表示（**本笔记里唯一核到 citation 结构的一手来源**）：

  > 「By default, the model's response will include inline citations for URLs found in the web search results. In addition to this, the `url_citation` annotation object will contain the URL, title and location of the cited source.」
  >
  > ```json
  > {
  >   "type": "web_search_call",
  >   "id": "ws_…",
  >   "status": "completed",
  >   "action": { "type": "search", "query": "latest news about AI" }
  > }
  > ```
  >
  > 输出消息上：`"annotations": [{ "type": "url_citation", "start_index": 2606, "end_index": 2758, "url": "https://…", "title": "Title…" }]`

  ——<https://developers.openai.com/api/docs/guides/tools-web-search.md>（章节「Citations」）。

- 另有 Chat Completions 侧的存量路径 `gpt-5-search-api`，官方标注「Use this only when you need to preserve a Chat Completions integration」——同上。

### 2.3 DeepSeek 的 server 端工具调用路径

- **Claude Code 路径**：「DeepSeek API 原生支持 Claude Code 中的 Web Search 功能。在使用 Claude Code 的过程中，如果模型判断您的问题需要通过搜索功能才能满足，模型会调用 Web Search 工具，并通过 DeepSeek 提供的 API 进行搜索。因为调用 Web Search 工具会**产生额外的大模型 API 请求来对获取到的搜索内容进行总结**，因此会产生额外的模型 Token 费用。**搜索请求本身还会按 Search API 计费规则计费。**」——<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code>
  → 关键机制：**服务端搜索 + 服务端再发一次模型请求做总结**。这条对 pi 尤其重要——如果走这条路，搜一次的成本是「搜索费 + 一次额外模型调用」。
- **Codex 路径**：「Codex 内置的联网搜索仅在使用 deepseek-v4-pro 时可用。一键脚本会写入 `web_search = "disabled"`；如需使用联网搜索，请在运行脚本后将该字段改为 `"live"`」；「**搜索由 DeepSeek 在服务端执行，请求按 Search 接口的计费规则计费。**」——<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex>
  → 这是全篇最贴题的「**总开关 + 默认关闭**」实例：开关在 `~/.codex/config.toml` 的 `web_search` 字段，脚本默认写 `disabled`，手动改成 `live` 才生效，且**改完要重启 Codex**（同页：「保存后重启 Codex」）。
- DeepSeek 自己的 Responses API 侧另有内置 `web_search`（**仅 deepseek-v4-pro**，flash 下忽略）——与本仓同日笔记 `docs/research/deepseek-search-api-20261020.md` §1.2 一致（<https://api-docs.deepseek.com/zh-cn/guides/responses_api>）。

## 3. 形态 B｜harness 本地实现

### 3.1 Claude Code `WebFetch`：本地抓取 + 独立模型调用总结

- 「WebFetch takes a URL and a prompt describing what to extract. It fetches the page and **converts the response to Markdown** when the server returns HTML. For most fetches, it then **runs the prompt against the content in a separate model call**, and Claude receives the result of that call rather than the raw page. The conversion step is not configurable.」——<https://code.claude.com/docs/en/tools.md#webfetch-tool-behavior>
- 「This makes WebFetch **lossy by design**. The extraction prompt determines what reaches Claude, so a result that says a page doesn't mention something may only mean the prompt didn't ask about it.」——同上。
- 其他可核事实：拒绝 `localhost` 与无点主机名；HTTP 自动升级 HTTPS；单次最多读 100,000 字符（v2.1.290+ 会告诉模型还剩多少没读）；默认缓存 15 分钟（`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`）；5 分钟下载截止（`CLAUDE_CODE_WEBFETCH_DEADLINE_MS`，`0` 取消）；跨主机重定向时**不跟随**，只回原 URL 与目标 URL 两次调用——同上。
- 开关与扣留：
  - 「On Claude Code v2.1.285 or later, set `CLAUDE_CODE_DISABLE_WEB_FETCH` to `1` to turn WebFetch off. **The WebSearch tool stays available.**」——<https://code.claude.com/docs/en/tools.md#webfetch-availability>、<https://code.claude.com/docs/en/env-vars.md>。
  - 「If you sign in with a Team or Enterprise claude.ai account … WebFetch also depends on your organization's policy, which Claude Code **requests from `api.anthropic.com` when a session starts**. … If WebFetch is missing from a session, run `/status` in the session. If its `Organization policy` line reports that the policy didn't load and names web fetch among the features that wait for it, **Claude Code is withholding WebFetch until it can confirm that your organization allows it**. … `claude doctor` makes its own request and prints the same line.」——<https://code.claude.com/docs/en/tools.md#webfetch-availability>。
    → 这是**「权限/策略型缺能力」**的第三种表现：既不是启动失败也不是调用报错，而是**工具悄悄不出现 + 一个专门的诊断入口（`/status`、`claude doctor`）**。

### 3.2 OpenCode `websearch`：多 provider 插件 + 顶层原生工具位

OpenCode 是本仓形态最接近的先例：**同样是「多 provider 插件 + 失败时把可读错误回给模型 + 配置可整体关掉」**，而且它同时拥有 CodeMode，可直接当「程序内可达」的对照组。

- 工具注册：`name = "websearch"`，`options: { codemode: false }`——`sst/opencode` `packages/core/src/tool/plugin/websearch.ts`（`export const name`、`editor.add({ name, options: { codemode: false }, … })`）。
- **官方文档对可用性与 key 的表述**：

  > 「This tool is only available when using the OpenCode or OpenCode Go provider, or when either the `OPENCODE_ENABLE_EXA` or `OPENCODE_ENABLE_PARALLEL` environment variable is set to any truthy value (e.g., `true` or `1`).」
  > 「**No API key is required** — the tool connects directly to the backend's hosted MCP service without authentication.」

  ——<https://opencode.ai/docs/tools.md>（`### websearch`）。

- provider 插件（源码）：
  - Exa：端点是**托管 MCP** `https://mcp.exa.ai/mcp`，有 key 时把它拼成 URL 查询参数 `exaApiKey`；无 key 时**只是不拼这个参数**，请求照发。凭据解析入口是 `ctx.integration.connection.active("exa")` → `resolve(connection)`，无连接时 `credential` 为 `undefined`。凭据录入方式声明了两种：`{ type: "key" }` 与 `{ type: "env", names: ["EXA_API_KEY"] }`。——`sst/opencode` `packages/core/src/plugin/websearch/exa.ts`。
  - Tavily：有 key 时发 `Authorization: Bearer <key>`，**无 key 时改发 `X-Tavily-Access-Mode: keyless`**——`sst/opencode` `packages/core/src/plugin/websearch/tavily.ts`。
  - 另有 firecrawl / parallel / tinyfish 三个 provider 插件，登记在 `packages/core/src/plugin/websearch/index.ts` 的 `WebSearchPlugins` 数组里。
- 错误与空结果的处理（**给模型看的文本**）：
  - `httpErrors = new Map([[429, "Web search rate limited (HTTP 429)"], [401, "Web search authentication failed (HTTP 401)"]])`；其它状态码回 `Web search request failed (HTTP ${status})`；再兜底 `Unable to search the web for ${input.query}`——`packages/core/src/tool/plugin/websearch.ts`。
  - 无结果回固定串 `NO_RESULTS = "No search results found. Please try a different query."`——同上。
  - 结构化输出 `{ provider, results }`，同时渲染成 Markdown 交给模型（`## [title](url)` + Published + content）——同上。
- **总开关**：`websearch` 配置项在 schema 里是 `false` 或一个 provider 选择对象：

  > `"websearch" => { "anyOf": [ { "type": "boolean", "enum": [false] }, { "$ref": "#/$defs/ConfigWebSearch.InfoEncoded" } ], "description": "Web search provider selection" }`

  ——<https://opencode.ai/config.json>。
  关掉时工具**从模型的工具面里被删除**（不是留着一个会报错的工具）：

  > `const hook = (event: SessionHooks["context"]) => Effect.gen(function* () { const disabled = yield* websearch.default().pipe(Effect.as(false), Effect.catchTag("WebSearch.Disabled", () => Effect.succeed(true))); if (disabled) delete event.tools[name] })`
  > `yield* ctx.session.hook("context", hook); yield* ctx.session.hook("compaction", hook); yield* ctx.session.hook("generate", hook)`

  ——`packages/core/src/tool/plugin/websearch.ts`。

- 关闭语义的配置侧实现：`if (selection === false) websearch.default.set(false); if (selection) websearch.default.set(selection.provider)`——`packages/core/src/config/plugin/websearch.ts`。
- 错误类型是**分型**的：`WebSearch.ProviderRequired` / `ProviderNotFound` / `Disabled` / `Request`——`packages/core/src/websearch.ts`。
- 「没有 provider」不是报错退出，而是**运行时弹表单问用户**（`forms.ask`，选项 "Allow search via …" / "Choose another provider" / "Disable web search"）——`packages/core/src/tool/plugin/websearch.ts`。

### 3.3 Zed `search_web`：只在 Zed Cloud provider 下可用，缺 provider 时调用期报错

- 工具名 `search_web`，`kind() = acp::ToolKind::Fetch`；**「We currently only support Zed Cloud as a provider.」** `fn supports_provider(provider) -> bool { provider == &ZED_CLOUD_PROVIDER_ID }`——`zed-industries/zed` `crates/agent/src/tools/web_search_tool.rs`。
- 缺 provider 的行为（**工具已注册，调用期返回结构化错误**）：

  > `let Some(provider) = WebSearchRegistry::read_global(cx).active_provider() else { return Err(WebSearchToolOutput::Error { error: "Web search is not available.".to_string() }); };`

  ——同上（`WebSearchTool::run`）。

- 错误结构：`enum WebSearchToolOutput { Success(WebSearchResponse), Error { error: String } }`；成功时把 `WebSearchResponse` 序列化成 JSON 交回模型——同上。
- provider 注册与「谁是 active」：`WebSearchRegistry { providers, active_provider }`，`register_provider` 在没有 active 时把首个注册者设为 active，`unregister_provider` 会把 active 清空——`crates/web_search/src/web_search.rs`（`WebSearchRegistry`）。
- provider 的注册条件绑定模型：`register_zed_web_search_provider` 里 `default_model().is_some_and(|default| default.is_provided_by_zed())` 为真才注册 Cloud provider，否则 `unregister_provider(...)`——`crates/web_search_providers/src/web_search_providers.rs`。
  → 即：**换模型（不走向 Zed 提供的）会静默把搜索能力撤掉**，而模型面看到的仍是同一个工具。

### 3.4 Goose：把搜索做成 skill，用 CLI 跑，默认零 key

Goose 仓库里**没有** Rust 的 web search 工具；搜索是**内置 skill**：

- skill 文件 `crates/goose/src/skills/builtins/web_search.md`：
  > 「Search the web and extract page content using **DuckDuckGo (no API key required)**, Tavily, or SearXNG.」
  > 「**No API key required for the default DuckDuckGo path**」
  > 默认路径：`uvx ddgs text -q "your query here" -m 5`；Tavily 需 `TAVILY_API_KEY`；SearXNG 需 `SEARXNG_URL`。
  > 「**Pick the first available: Tavily if `TAVILY_API_KEY` is set, SearXNG if `SEARXNG_URL` is set, otherwise DuckDuckGo.**」
- 依赖前提写在同一份 skill 里：「`uv` must be installed」——`block/goose` 同上文件。
  → 这是**「按凭据存在与否自动降级到免费源」**的最干净样本：不是「有 key 用 A，没 key 报错」，而是「有 key 用更好的，没 key 用能用的」。

### 3.5 Cline：provider 内建搜索 + Exa 插件两条路并存

- **provider 内建**：桌面设置页的引导组件按 provider 能力过滤：

  > `.filter((provider) => provider.enabled && provider.modelTools?.includes("web_search")).map((provider) => provider.name)`

  ——`cline/cline` `apps/examples/desktop-app/webview/components/views/settings/web-search-provider-guidance.tsx`。
  没有任何 provider 支持时的文案（**amber 警告 + 引导动作**）：

  > 「None of your connected providers support built-in web search, so this setting has no effect yet.」+「Connect a provider」按钮 / 「Connect a provider in Settings」。

  ——同上。

- **插件形态**：`sdk/examples/plugins/web-search.ts` 注释写明「Registers a `web_search` tool backed by Exa.」以及

  > 「Provider key: `EXA_API_KEY` — Enables Exa search. A separate model provider key is still required for CLI inference.」

  输出类型 `WebSearchOutput { provider: "exa"; query; results: WebSearchResult[]; requestId? }`，结果项含 `title/url/snippet/publishedAt/author/score`——同上。
  → Cline 把「**搜索源凭据**」与「**模型凭据**」明确写成两件事。

- 注意别看错：Cline 的 `sdk/packages/core/src/extensions/tools/executors/search.ts` 是**代码库**搜索（ripgrep），不是网页搜索。

### 3.6 Aider：没有内置网页搜索

- 仓库树里没有任何 `websearch` / `web_search` / `web-search` 命名的文件（`gh api repos/Aider-AI/aider/git/trees/HEAD?recursive=1` 全量过滤）；代码搜索 `duckduckgo OR serper OR tavily OR brave` 在该仓库**零命中**；`aider/website/docs/` 下也没有 MCP 或 web-search 文档页。
  → 结论：**Aider 不提供内置网页搜索**（本次未核到任何替代路径的官方说明）。

## 4. 形态 C｜MCP 搜索服务器生态

### 4.1 Brave Search MCP：缺 key ⇒ 启动即失败、零工具

- key 来源：`BRAVE_API_KEY`，或 `BRAVE_API_KEY_FILE`（指向一个含 key 的文件，**优先于环境变量**，为 Docker secret 场景准备）；也可用 `--brave-api-key` / `--brave-api-key-file`——<https://github.com/brave/brave-search-mcp-server>（README「Environment Variables」）。
- 缺 key 的行为（源码级）：

  > `if (!braveApiKey) { console.error('Error: A Brave API key is required via --brave-api-key, BRAVE_API_KEY, --brave-api-key-file, or BRAVE_API_KEY_FILE. You can get one at https://brave.com/search/api/.'); return false; }`

  ——`brave/brave-search-mcp-server` `src/config.ts`（`getOptions()`）。
  上游调用点：

  > `const options = getOptions(); if (!options) { console.error('Invalid configuration'); process.exit(1); }`

  ——`src/index.ts`（`main()`）。
  → **fail closed**：进程退出 ⇒ 客户端侧表现为「这个 MCP server 起不来」，**一个工具都不会注册**。

- 工具级开关（与 key 无关的独立维度）：`BRAVE_MCP_ENABLED_TOOLS` / `BRAVE_MCP_DISABLED_TOOLS`（白/黑名单，互斥，非法名会报错并列出合法名）；传输开关 `BRAVE_MCP_TRANSPORT`（`stdio` 默认 / `http`）；http 默认只绑 `127.0.0.1:8080` 且**无鉴权**——同上 README。
- 工具族：`web` / `news` / `images` / `videos` / `place_search` / `local` / `llm_context` / `summarizer`（见 `src/tools/` 目录）——`src/tools/index.ts` 引入的 `tools` 数组。

### 4.2 Tavily MCP：缺 key ⇒ 启动 warn + keyless 降级（最贴近「开关打开但缺 key」）

- 源码级：

  > `const API_KEY = process.env.TAVILY_API_KEY; const IS_KEYLESS = !API_KEY;`
  > 请求头二选一：`IS_KEYLESS ? { 'X-Tavily-Access-Mode': 'keyless', 'X-Client-Source': 'tavily-mcp-keyless' } : { 'Authorization': `Bearer ${API_KEY}`, 'X-Client-Source': 'MCP' }`
  > 启动告警：`console.error('[tavily-mcp] no TAVILY_API_KEY set; running in keyless mode. Search and extract are available; other tools will return a message explaining that an API key is required.')`

  ——`tavily-ai/tavily-mcp` `src/index.ts`（`IS_KEYLESS` 在第 16–17 行；axios 头与告警在第 87–101 行）。

- keyless 时请求体里**不带** `api_key` 字段（`...(IS_KEYLESS ? {} : { api_key: API_KEY })`）；服务端返回的 keyless 错误信封会被格式化成文本回给模型（`isKeylessEnvelope` / `formatKeylessEnvelope`）——同上。
  → **工具照常注册、启动有明确告警、能力按工具分级降级**——这是本节两个关键问题里最标准的答案样本。

### 4.3 Exa MCP：托管 HTTP 端点 + 自托管两种

- OpenCode 的 Exa 插件直接打 `https://mcp.exa.ai/mcp`（托管 MCP，key 走查询参数）——`sst/opencode` `packages/core/src/plugin/websearch/exa.ts`（`export const endpoint = "https://mcp.exa.ai/mcp"`）。
- 官方仓库另有自托管形态与 OAuth 端点（`api/mcp.ts`、`api/mcp-oauth.ts`、`env.example`）——<https://github.com/exa-labs/exa-mcp-server>。

### 4.4 mcp-agent：一个 harness 怎么消费搜索 MCP

- 示例 `examples/usecases/mcp_researcher/mcp_agent.config.yaml` 里并列挂了四个 MCP server：
  > ```yaml
  > mcp:
  >   servers:
  >     brave:
  >       command: "npx"
  >       args: ["-y", "@modelcontextprotocol/server-brave-search"]
  >     fetch:
  >       command: "uvx"
  >       args: ["mcp-server-fetch"]
  >     interpreter: { command: "docker", … }
  >     filesystem:
  >       {
  >         command: "npx",
  >         args: ["-y", "@modelcontextprotocol/server-filesystem", "./agent_folder/"],
  >       }
  > ```
- 凭据放在**独立**的 secrets 文件里，通过 MCP server 的 `env` 注入：

  > ```yaml
  > mcp:
  >   servers:
  >     brave:
  >       env:
  >         BRAVE_API_KEY: <brave_api_key>
  > ```

  ——`lastmile-ai/mcp-agent` `examples/usecases/mcp_researcher/mcp_agent.secrets.yaml.example`（注释亦写明「Secrets … are stored in an mcp_agent.secrets.yaml file which can be gitignored」）。
  → **搜索 key 属于 MCP 服务器进程，不属于模型**；harness 只负责把工具列表接进来。

## 5. 工具位置：顶层模型可调 vs 程序内可达

### 5.1 顶层模型直接可调（主流）

| 实现             | 工具位证据                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code      | 工具表直接列 `WebFetch` / `WebSearch`，权限规则按工具名匹配（`WebSearch` 无参匹配、`WebFetch(domain:example.com)` 域匹配）——<https://code.claude.com/docs/en/tools.md> |
| OpenAI Responses | `tools: [{ type: "web_search" }]` 放在请求顶层，模型自行决定是否调用——<https://developers.openai.com/api/docs/guides/tools-web-search.md>                              |
| Zed              | `impl AgentTool for WebSearchTool`，`NAME = "search_web"`——`crates/agent/src/tools/web_search_tool.rs`                                                                 |
| OpenCode         | `editor.add({ name: "websearch", options: { codemode: false }, … })`——`packages/core/src/tool/plugin/websearch.ts`                                                     |
| Cline 插件       | `createTool` 注册 `web_search`——`sdk/examples/plugins/web-search.ts`                                                                                                   |

### 5.2 只在编排器 / 程序内可达

- **OpenCode 的 CodeMode**（与本仓 PTC 最像的机制）在官方仓库文档里写得很清楚：

  > 「A tool may provide a namespace, which flattens direct model names to `<namespace>_<tool>`, and **defaults into CodeMode** (`codemode` defaults true; **`codemode: false` keeps the tool on the provider's native tool list**).」

  ——<https://github.com/sst/opencode/blob/dev/packages/core/src/tool/AGENTS.md>（「Registration」小节）。

- 而 **MCP 工具默认进 CodeMode**：

  > `options: { namespace: namespace(tool.server), codemode: tool.codemode !== false },`

  ——`sst/opencode` `packages/core/src/tool/mcp.ts:45`。
  → 结论：**在 OpenCode 里，MCP 搜索服务器提供的工具默认「只在生成的程序里可达」，模型原生工具面看不到**；而内置的 `websearch` 显式留在原生工具面。

- **Goose 的 skill 层**：搜索能力以 skill（markdown 指令）交付，模型用 shell 跑 `uvx ddgs`——`crates/goose/src/skills/builtins/web_search.md`。既不是原生工具，也不是 MCP。

### 5.3 两种都存在的 harness

- **OpenCode**：内置 `websearch` 走原生工具面（`codemode: false`），MCP 工具默认走 CodeMode——同一 harness 内两种都在（§5.1 / §5.2）。
- **Codex**：同时存在 hosted server tool 与 standalone 扩展工具：
  - hosted：`ToolSpec::WebSearch { external_web_access, indexed_web_access, filters, user_location, search_context_size, search_content_types }`——`openai/codex` `codex-rs/core/src/tools/hosted_spec.rs`（`create_web_search_tool`）。
  - standalone：扩展 crate 暴露**带命名空间的函数工具** `web.run`（`ToolName::namespaced(WEB_NAMESPACE, RUN_TOOL_NAME)`，`ToolExposure::Direct`），底层走 `codex_api::SearchClient`——`codex-rs/ext/web-search/src/tool.rs`（`WebSearchTool`）。
  - **优先级**：`let standalone_web_search_available = standalone_web_search_enabled(turn_context, model_info) && registered_extension_tool_names.contains(&ToolName::namespaced("web", "run"));` 然后 `let web_search_mode = (!standalone_web_search_available && turn_context.provider.capabilities().web_search).then_some(turn_context.config.web_search_mode.value());`——`codex-rs/core/src/tools/spec_plan.rs`（约 697–713 行）。
    → 即：**standalone 扩展存在时，hosted server tool 不再生成**，两者不叠加。

## 6. 凭据：key 来源与缺失行为（关键问题一）

### 6.1 key 来源分两类

- **复用模型服务商 key**（provider 端 server tool）：Anthropic `WebSearch`（走 Anthropic 账号/API key）、OpenAI `web_search`（走 OpenAI API key）、DeepSeek server 端工具（走 DeepSeek API key，且 DeepSeek 页明确说明「搜索请求本身还会按 Search API 计费规则计费」，即**同一个 key、另一条计费线**）——出处见 §2.1 / §2.2 / §2.3。
- **独立第三方 key**（本地实现与 MCP 服务器）：Brave（`BRAVE_API_KEY` / `BRAVE_API_KEY_FILE`）、Tavily（`TAVILY_API_KEY`）、Exa（`EXA_API_KEY`）、Serper、SearXNG（自托管 `SEARXNG_URL`）——出处见 §3.2 / §4.1 / §4.2 / §4.4。
- **不需要 key**：Goose 的 DuckDuckGo 默认路径（`uvx ddgs`）、OpenCode 托管 MCP 路径（官方文档明说 "No API key is required"）、SearXNG 自托管——出处见 §3.4 / §3.2。

### 6.2 缺 key / 缺能力时的**具体**行为（7 种，全部有一手证据）

| #   | 行为                                      | 具体表现                                                                                                                                                                                                                                                                   | 证据                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | **启动即失败，零工具**                    | stderr 打 `Error: A Brave API key is required via --brave-api-key, BRAVE_API_KEY, --brave-api-key-file, or BRAVE_API_KEY_FILE. …` → `getOptions()` 返回 false → `console.error('Invalid configuration'); process.exit(1)`                                                  | `brave/brave-search-mcp-server` `src/config.ts`（`getOptions`）+ `src/index.ts`（`main`）                                                                                                                                                                                                                |
| ②   | **启动 warn + 工具照常注册 + 逐工具降级** | stderr 打 `[tavily-mcp] no TAVILY_API_KEY set; running in keyless mode. Search and extract are available; other tools will return a message explaining that an API key is required.`；search/extract 走 `X-Tavily-Access-Mode: keyless` 仍可用，其余工具回「需要 key」说明 | `tavily-ai/tavily-mcp` `src/index.ts`（`IS_KEYLESS`，第 16–17、87–101 行）                                                                                                                                                                                                                               |
| ③   | **根本不需要 key**                        | 默认路径 `uvx ddgs text -q …` 免 key；有 `TAVILY_API_KEY` / `SEARXNG_URL` 时自动换成更强的源                                                                                                                                                                               | `block/goose` `crates/goose/src/skills/builtins/web_search.md`                                                                                                                                                                                                                                           |
| ④   | **工具已注册，调用期报错**                | Zed：返回 `Error { error: "Web search is not available." }`；OpenCode：HTTP 401 → `Web search authentication failed (HTTP 401)`，429 → `Web search rate limited (HTTP 429)`，其它 → `Web search request failed (HTTP {status})`                                            | `zed-industries/zed` `crates/agent/src/tools/web_search_tool.rs`；`sst/opencode` `packages/core/src/tool/plugin/websearch.ts`                                                                                                                                                                            |
| ⑤   | **工具压根不进请求/不注册**               | Codex：`WebSearchMode::Disabled \| None => return None`（工具不生成）；且 `ProviderCapabilities.web_search` 是 provider 给的**上限**（默认 true，可被关成 false）；DeepSeek 侧 Codex 一键脚本默认写 `web_search = "disabled"`                                              | `openai/codex` `codex-rs/core/src/tools/hosted_spec.rs`（`create_web_search_tool`）、`codex-rs/model-provider/src/capabilities.rs`（`ProviderCapabilities`）、`codex-rs/core/src/config/mod.rs`（`resolve_web_search_mode`）；<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex> |
| ⑥   | **策略型扣留 + 专用诊断入口**             | Claude Code：企业策略未加载时不提供 `WebFetch`，只在 `/status` 的 `Organization policy` 行报出（会话内）或 `claude doctor`（会话外）                                                                                                                                       | <https://code.claude.com/docs/en/tools.md#webfetch-availability>                                                                                                                                                                                                                                         |
| ⑦   | **UI 层明确告知「此设置无效果」**         | Cline 桌面设置页 amber 文案：「None of your connected providers support built-in web search, so this setting has no effect yet.」+「Connect a provider」入口                                                                                                               | `cline/cline` `apps/examples/desktop-app/webview/components/views/settings/web-search-provider-guidance.tsx`                                                                                                                                                                                             |

**归纳**【推断，基于上表 7 行证据】：成熟 harness 没有统一口径，但**没有任何一个选择了「静默」**——要么启动就失败并说明缺什么、要么启动时明确告警、要么调用时把可读错误交给模型、要么把工具从工具面撤掉并提供诊断入口。真正被避免的是「工具在、key 不在、调用了才炸出一句看不懂的错」。

## 7. 开关形态：总开关 + 缺 key 降级（关键问题二）

### 7.1 OpenCode：最完整的「总开关 + 降级」组合

| 维度              | 实现                                                                                                                                                    | 位置                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 总开关在哪        | 配置文件顶层 `websearch` 字段，schema 为 `false` 或 provider 选择对象                                                                                   | <https://opencode.ai/config.json>                            |
| 关闭时发生什么    | **工具从模型工具面被删掉**（`delete event.tools["websearch"]`），且挂在 `context` / `compaction` / `generate` 三个 session hook 上                      | `packages/core/src/tool/plugin/websearch.ts`（session hook） |
| 打开但没 provider | 不报错，**运行时弹表单**让用户选：允许某个 provider / 另选一个 / 禁用搜索                                                                               | 同上（`forms.ask`，`WebSearch.ProviderRequiredError`）       |
| 缺 key 时         | 默认托管路径**根本不需要 key**；有 key 走带 key 的模式（Exa 走查询参数、Tavily 走 `Bearer`），没 key 走 keyless 模式（`X-Tavily-Access-Mode: keyless`） | `packages/core/src/plugin/websearch/exa.ts`、`tavily.ts`     |
| key 无效时        | 错误被翻译成给模型看的可读串：`Web search authentication failed (HTTP 401)` / `Web search rate limited (HTTP 429)`                                      | `packages/core/src/tool/plugin/websearch.ts`                 |
| 另有环境变量开关  | 官方文档：仅在 OpenCode / OpenCode Go provider 下，或 `OPENCODE_ENABLE_EXA=1` / `OPENCODE_ENABLE_PARALLEL=1` 时该工具可用                               | <https://opencode.ai/docs/tools.md>                          |

### 7.2 Codex：模式枚举 + 能力上限，默认关闭

- 配置值：`web_search` 在 `config.toml` 里取 `disabled` / `cached` / `live`（另有 `indexed`）。映射代码：

  > `if let Some(mode) = config_toml.web_search { return Some(mode); } if features.enabled(Feature::WebSearchCached) { return Some(WebSearchMode::Cached); } if features.enabled(Feature::WebSearchRequest) { return Some(WebSearchMode::Live); } … None`

  ——`openai/codex` `codex-rs/core/src/config/mod.rs`（`resolve_web_search_mode`）。

- 「`None` prevents emitting a hosted search tool.」——`codex-rs/core/src/tools/spec_plan.rs`（约 697–703 行注释与逻辑）。
- provider 能力是上限：`ProviderCapabilities { image_generation, web_search, external_web_access, remote_compaction }`，注释明写「These capabilities are a **provider-owned upper bound**. Model and turn settings can further restrict the functionality exposed to the model.」——`codex-rs/model-provider/src/capabilities.rs`。
- 第三方视角的等价实现：DeepSeek 的 Codex 集成页让一键脚本写 `web_search = "disabled"`，用户手改成 `"live"` 并重启才生效——<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex>。

### 7.3 Claude Code：按工具分别开关 + 配额降级

- `CLAUDE_CODE_DISABLE_WEB_FETCH=1` 关掉 WebFetch，**WebSearch 仍可用**（v2.1.285+）——<https://code.claude.com/docs/en/env-vars.md>、<https://code.claude.com/docs/en/tools.md#webfetch-availability>。
- `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`：「Cap on WebSearch calls (default: 200). When Claude reaches the cap, further WebSearch calls **return a notice telling it to continue with the information it already gathered and say so in its answer**. Accepts a positive whole number with no upper bound. Anything else is ignored and the default applies, so **the cap can be raised but not turned off**.」——<https://code.claude.com/docs/en/env-vars.md>。
- `CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR`：「The default is `100` in an interactive terminal session. In a non-interactive session the default is `0`, which **turns refill off**.」——同上。
  → 这是**「降级不是报错，而是把提示回灌给模型让它用自己的已有信息作答」**的样本。

### 7.4 MCP 服务器侧：工具级开关与传输开关

- Brave：`BRAVE_MCP_ENABLED_TOOLS` / `BRAVE_MCP_DISABLED_TOOLS`（互斥的白/黑名单）、`BRAVE_MCP_TRANSPORT`（stdio/http）、`BRAVE_MCP_STATELESS`、`BRAVE_MCP_ALLOWED_ORIGINS` / `BRAVE_MCP_ALLOWED_HOSTS`（HTTP 侧的 DNS rebinding 防护）——<https://github.com/brave/brave-search-mcp-server>（README「Environment Variables」）。

### 7.5 「有没有 harness 做了『总开关 + 开关打开但缺 key 时降级告警』？」

**有，且有两种典型实现**：

1. **warn-on-startup + keyless 降级**（最短实现）：Tavily MCP —— 启动 stderr 明确说「no TAVILY_API_KEY set; running in keyless mode」，同时把可用工具与不可用工具分开，缺 key 的工具在调用时回一句「需要 API key」——`tavily-ai/tavily-mcp` `src/index.ts`。
2. **tool-level disable + 用户可感知的降级链**（最完整实现）：OpenCode —— 总开关把工具从工具面移除；打开但没 provider 时弹表单问用户；provider 401 时把 `Web search authentication failed (HTTP 401)` 作为工具结果回给模型；且默认路径本就零 key——`sst/opencode` `packages/core/src/tool/plugin/websearch.ts` + <https://opencode.ai/docs/tools.md>。

**没有找到**的组合【推断，基于本次覆盖的这些实现】：**没有任何一个 harness 做到了「总开关打开 + 缺 key 时既保留工具又只在启动时告警一次」**——要么 keyless 直接跑（OpenCode/Goose），要么 warn 后逐工具分级（Tavily），要么直接不注册（Codex/Brave）。OpenCode 的 warn 是**按调用时**而非启动时。

## 8. 给本项目可迁移的结论

> 标 **【文档明说】** 的条目，其依据是上表引用的官方文档/源码原文；标 **【推断】** 的是我基于这些事实对 `pi-ptc-subagents` 的判断，官方未如此表述。

1. **【文档明说】做成顶层模型可调的工具，是绝大多数 harness 的默认选择；「程序内可达」是增量形态而非替代。**
   Claude Code、OpenAI Responses、Zed、OpenCode、Cline 的搜索工具都进模型原生工具面；只有 OpenCode 的 **MCP 工具**默认进 CodeMode、Codex 的 **standalone 扩展**与 hosted tool 二选一。出处：§5.1 / §5.2 / §5.3。

2. **【文档明说】如果要做「程序内可达」，OpenCode 证明了「同一个 harness 两种工具位并存」是可运行的形态：内置工具显式 `codemode: false` 留在原生工具面，MCP 工具默认 `codemode: true` 只在生成代码里可达。**
   出处：`sst/opencode` `packages/core/src/tool/AGENTS.md`（「Registration」）、`packages/core/src/tool/mcp.ts:45`、`packages/core/src/tool/plugin/websearch.ts`。
   → 对 pi-ptc 的直接含义：**PTC 里的 search binding 与顶层 search tool 并不互斥**；OpenCode 的做法是让「同一个能力」按需暴露两份入口，而不是二选一。

3. **【文档明说】provider 端 server tool 的结果自动进上下文、拿不到原始检索结构；本地实现可以拿到结构化结果。**
   OpenAI 的 `web_search` 由服务端执行并直接产出带 `url_citation` 的回答（<https://developers.openai.com/api/docs/guides/tools-web-search.md>）；而 OpenCode 的 `websearch` 输出 `{provider, results}`、DeepSeek Search API 输出 `results[]`（本日另一份笔记 §3.1）。DeepSeek 的 Claude Code 集成页还额外点明：server 端搜索会**再发一次模型请求做总结**，因此成本是「搜索费 + 一次模型调用」。
   → 对 pi-ptc 的直接含义：**若走 DeepSeek 的裸 JSON Search/Fetch 接口，引用装配成本落在 pi 这一侧**（响应无 citation id，只有 `url`+`title`+`summary`），这是 OpenAI/Anthropic server tool 省掉、而本地实现必须自己做的部分。

4. **【文档明说】缺 key 的成熟做法有五种，pi 应当在以下三者中明确选一种并写进契约：启动即失败（Brave）、启动 warn + 分级降级（Tavily）、零 key 默认源（Goose/OpenCode）。**
   出处：§6.2 的 ①②③。
   → **【推断】** pi-ptc-subagents 是「库/扩展」而非终端应用，用户未必会看到 stderr；因此**「零 key 默认源」或「调用时把可读错误回给模型」比「启动即失败」更契合本项目**——这与 pi 现有的失败可见性纪律（失败路径必须有 warn 或显式错误状态）一致。

5. **【文档明说】最值得抄的是「错误文本面向模型写」这条规范。**
   OpenCode 的 `Web search authentication failed (HTTP 401)` / `Web search rate limited (HTTP 429)` / `No search results found. Please try a different query.`；Claude Code 配额耗尽时「return a notice telling it to continue with the information it already gathered and say so in its answer」；Tavily keyless 时「other tools will return a message explaining that an API key is required」。出处：§6.2 ②④、§7.3。
   → **【推断】** pi 的 search binding 错误若直接抛 `401 Unauthorized`，模型无法据此调整行为；应把「缺 key / 配额耗尽 / 无结果」映射成模型能据以改变策略的句子。

6. **【文档明说】「总开关关掉 ⇒ 工具从工具面消失，而不是留着一个会报错的工具」在 OpenCode 与 Codex 上都有先例；「打开但条件不足 ⇒ 运行时向用户要一个选择（而不是静默失败）」在 OpenCode 上有先例。**
   出处：§7.1（`delete event.tools[name]` + `forms.ask`）、§7.2（`create_web_search_tool` 返回 `None`）、§7.3（`CLAUDE_CODE_DISABLE_WEB_FETCH`）。
   → **【推断】** 若 pi 的搜索模块做成 PTC binding（只在程序内可达），那么「总开关」的语义天然是「binding 不出现在 `tools` 表里」；若同时暴露顶层 tool，两者应共享同一个开关与同一套错误文案，避免出现「顶层能用、程序内不能用」或反之。

7. **【文档明说】Anthropic 明说「server tool 的检索后端不可配置，要换检索源就上 MCP」；Codex 则在 standalone 扩展存在时不再生成 hosted 搜索工具。**
   出处：<https://code.claude.com/docs/en/tools.md#websearch-tool-behavior>、`codex-rs/core/src/tools/spec_plan.rs`。
   → **【推断】** 行业把「换检索源」这件事统一收敛到 MCP/插件层；因此 pi 的内置搜索模块最好把「检索源」做成可插拔的一层（DeepSeek Search 是默认实现），而不是把 DeepSeek 的 URL 与字段焊死在 binding 契约里。

## 9. 未核实清单

1. **Anthropic API 侧 web search 工具的完整契约**（`web_search_20250305` 的 `max_uses`、`allowed_domains`/`blocked_domains` 是否同名、返回体结构、引用对象形态）：`platform.claude.com` 从本机**被地域拦截**（`https://platform.claude.com/docs/llms-full.txt` 返回 "App unavailable in region" 页面，HTTP 200 但内容是拦截页），`docs.anthropic.com` 已并入同一站点，同样不可达。**因此「Anthropic server tool 的 citation 结构」未能核到**；本笔记中 Claude Code 侧的结论均出自 `code.claude.com`，不含 Anthropic API 的字段级契约。
2. **Anthropic 的 `WebSearch` 在 Claude Pro/Max 订阅登录下是否可用**：Claude Code 文档只写了按 provider/平台区分（Bedrock 无、Foundry 有），未写订阅档位差异。**未核实。**
3. **OpenCode 的 `OPENCODE_ENABLE_EXA` / `OPENCODE_ENABLE_PARALLEL` 在源码里的读取点**：GitHub code search（`repo:sst/opencode OPENCODE_ENABLE_EXA`）零命中；该说法**仅见于官方文档** <https://opencode.ai/docs/tools.md>，未在源码中定位到对应分支。
4. **Codex 的 `codex-rs/ext/web-search` 扩展的凭据来源与缺 key 行为**：只读到工具 spec 与 `SearchClient` 调用入口（`codex-rs/ext/web-search/src/tool.rs`），未读到它如何取凭据、缺凭据时走什么分支。**未核实。**
5. **Codex `indexed` 模式与 `WebSearchMode` 的完整枚举定义**：`codex-rs/protocol`（`codex_protocol::config_types::WebSearchMode`）未逐字段读取；`indexed` 分支只在 `hosted_spec.rs` 的 match 里出现过。
6. **OpenHands 的网页搜索实现**：`OpenHands/OpenHands`（main，TypeScript 重写版）全树里只有前端 browser 面板（`src/components/features/browser/*`）与一个 `src/components/features/chat/tool-visualizers/search/` 展示组件，**未找到内置 web search 工具**；其浏览代理的历史实现不在本仓库，**未能核到**。
7. **Roo Code**：本轮未单独取证（Cline 侧取证已足够代表其同一代码血脉）。**未核实。**
8. **Continue / Amp**：本轮未取证。**未核实。**
9. **Serper / SearXNG MCP 服务器的具体缺 key 行为**：只核到 SearXNG 在 Goose skill 里作为**自托管 URL**（`SEARXNG_URL`）被使用；未核到独立的 SearXNG MCP 服务器仓库行为。
10. **本次未实测调用任何搜索 API**（无 Brave / Tavily / Exa / DeepSeek key）→ 「Tavily keyless 下 search 真的可用」「Exa 托管 MCP 免 key 可用」等均为**文档/源码声明**，未运行验证。
11. **mcp-agent 的搜索消费方式只核到示例配置层**（`examples/usecases/mcp_researcher`），未核到其 SDK 在 MCP server 启动失败时的上层表现（是抛异常、还是把该 server 的工具静默跳过）。

## 10. 快照与复核命令

**抓取日期**：2026-10-20。**版本快照**：`openai/codex` / `sst/opencode`（分支 `dev`）/ `cline/cline` / `block/goose` / `zed-industries/zed` / `brave/brave-search-mcp-server` / `tavily-ai/tavily-mcp` / `exa-labs/exa-mcp-server` / `lastmile-ai/mcp-agent` 均取 `HEAD`；Claude Code 文档取 `code.claude.com/docs/en/*` 当日版；`@anthropic-ai/claude-code` npm 包版本 `2.1.304`（仅确认它是安装引导壳，**不含 CLI 实现源码**，故未用于取证）。

```bash
# ---------- 文档侧 ----------
# Claude Code 工具参考（本笔记 §2.1 / §3.1 的主来源）
curl -sSL https://code.claude.com/docs/en/tools.md            | sed -n '/^## WebFetch tool behavior/,/^## /p'
curl -sSL https://code.claude.com/docs/en/tools.md            | sed -n '/^## WebSearch tool behavior/,/^## /p'
# Claude Code 环境变量（§7.3 的开关与配额）
curl -sSL https://code.claude.com/docs/en/env-vars.md | grep -E "CLAUDE_CODE_(DISABLE_WEB_FETCH|MAX_WEB_SEARCHES_PER_SESSION|WEB_SEARCH_REFILLS_PER_HOUR|WEBFETCH_)"

# OpenAI Responses API web search（§2.2）
curl -sSL https://developers.openai.com/api/docs/guides/tools-web-search.md | sed -n '/^## Citations/,/^## /p'

# DeepSeek 的 Claude Code / Codex 集成页（§2.3）
curl -sSL https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code | python3 -c "
import sys,re,html
t=sys.stdin.read(); t=re.sub(r'<script.*?</script>','',t,flags=re.S)
t=re.sub(r'</(p|div|tr|h1|h2|h3|li|pre|table)>','\n',t); t=re.sub(r'<[^>]+>','',t)
print(re.sub(r'\n{3,}','\n\n',html.unescape(t)))" | grep -n -A4 "Web Search"
curl -sSL https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex | grep -o 'web_search = \"[a-z]*\"'

# OpenCode 官方文档（§3.2）
curl -sSL https://opencode.ai/docs/tools.md | sed -n '/^### websearch/,/^### /p'
curl -sSL https://opencode.ai/config.json | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['properties']['websearch'], ensure_ascii=False))"

# ---------- 源码侧 ----------
# OpenCode：codemode 语义 + MCP 工具默认进 CodeMode + websearch 留在原生工具面
curl -sSL https://raw.githubusercontent.com/sst/opencode/dev/packages/core/src/tool/AGENTS.md | grep -n -A3 "CodeMode"
curl -sSL https://raw.githubusercontent.com/sst/opencode/dev/packages/core/src/tool/mcp.ts | grep -n "codemode"
curl -sSL https://raw.githubusercontent.com/sst/opencode/dev/packages/core/src/tool/plugin/websearch.ts | grep -nE "codemode|httpErrors|NO_RESULTS|delete event.tools|forms.ask"
# OpenCode：Exa / Tavily 的凭据分支
curl -sSL https://raw.githubusercontent.com/sst/opencode/dev/packages/core/src/plugin/websearch/exa.ts    | grep -nE "mcp.exa.ai|exaApiKey|EXA_API_KEY"
curl -sSL https://raw.githubusercontent.com/sst/opencode/dev/packages/core/src/plugin/websearch/tavily.ts | grep -nE "keyless|Authorization|TAVILY"

# Codex：工具生成与否 + 模式解析 + provider 能力上限
curl -sSL https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/hosted_spec.rs    | sed -n '14,46p'
curl -sSL https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs            | grep -n -A12 "fn resolve_web_search_mode"
curl -sSL https://raw.githubusercontent.com/openai/codex/main/codex-rs/model-provider/src/capabilities.rs | grep -n -A16 "pub struct ProviderCapabilities"
curl -sSL https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/spec_plan.rs        | grep -n -B2 -A14 "standalone_web_search_available"

# Zed：provider 限定 + 缺 provider 的调用期错误
curl -sSL https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent/src/tools/web_search_tool.rs | grep -n -B3 -A6 "Web search is not available\|supports_provider"

# Goose：skill 形态的搜索（零 key 默认源）
curl -sSL https://raw.githubusercontent.com/block/goose/main/crates/goose/src/skills/builtins/web_search.md | grep -nE "ddgs|TAVILY_API_KEY|SEARXNG_URL|Pick the first"

# Cline：provider 能力过滤与「设置无效果」告警
curl -sSL https://raw.githubusercontent.com/cline/cline/main/apps/examples/desktop-app/webview/components/views/settings/web-search-provider-guidance.tsx | grep -nE "web_search|no effect|amber"

# MCP 服务器：Brave 启动失败 / Tavily keyless 降级
curl -sSL https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/src/config.ts | grep -n -A4 "A Brave API key is required"
curl -sSL https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/src/index.ts  | grep -n -A3 "Invalid configuration"
curl -sSL https://raw.githubusercontent.com/tavily-ai/tavily-mcp/main/src/index.ts | grep -nE "IS_KEYLESS|keyless mode|X-Tavily-Access-Mode"

# mcp-agent：搜索 MCP 的消费方式与凭据位置
curl -sSL https://raw.githubusercontent.com/lastmile-ai/mcp-agent/main/examples/usecases/mcp_researcher/mcp_agent.config.yaml
curl -sSL https://raw.githubusercontent.com/lastmile-ai/mcp-agent/main/examples/usecases/mcp_researcher/mcp_agent.secrets.yaml.example

# 负向核验：Aider 无内置网页搜索
gh api "repos/Aider-AI/aider/git/trees/HEAD?recursive=1" --jq '.tree[].path' | grep -iE "websearch|web_search|web-search"   # 零命中
gh api "search/code?q=repo:Aider-AI/aider+duckduckgo+OR+serper+OR+tavily+OR+brave" --jq '.items[].path'                # 零命中
```

注：`platform.claude.com` / `docs.anthropic.com` 本机不可达（地域拦截），复核 Anthropic API 侧契约需换出口网络；`code.claude.com` 与 `developers.openai.com` 支持直接取 `.md`（Mintlify / Astro 文档站），无 `.md` 后缀时需自行抽正文。
