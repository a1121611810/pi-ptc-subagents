# Agent 搜索工具「把结果交给模型」的四种做法

**日期**：2026-10-20
**问题**：本仓的 DeepSeek 搜索模块要把结果交给模型。一次 `count=10` 的搜索实测 **6,414–31,020 字符**（见
`docs/prototypes/search-context-budget-measurements.md`）⇒ 一个 128k 上下文的子会话只装得下 **16–19 次**。
**要问的是**：业界怎么处理这个量级，有没有比「整份结果塞进上下文」更好的做法。

**方法**：联网检索 + 读一手文档页（Anthropic 平台文档、OpenAI 平台文档、MCP 规范页）。
**结论先行**：**没有一家把整个结果集放进模型的上下文。** 全部是「概览 + 按需取」。

---

## 1. Anthropic 的 web search（server tool）：结果块只给 title + url，内容加密

结果块的实际形状（平台文档示例）：

```json
{
  "type": "web_search_result",
  "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
  "title": "Claude Shannon - Wikipedia",
  "encrypted_content": "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y...",
  "page_age": "April 30, 2025"
}
```

⇒ **没有全文，也没有 snippet。** 内容是**加密**的，模型读不到；模型看到的是 title + url + 页龄。

**深度怎么来**：模型**引用**某一条时，服务端才把被引段落注入上下文：

```json
{
  "text": "Claude Shannon was born on April 30, 1916, in Petoskey, Michigan",
  "type": "text",
  "citations": [
    {
      "type": "web_search_result_location",
      "url": "https://en.wikipedia.org/wiki/Claude_Shannon",
      "encrypted_index": "Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..",
      "cited_text": "Claude Elwood Shannon (April 30, 1916 – February 24, 2001) was an American mathematician, …"
    }
  ]
}
```

⇒ **「概览 + 在模型决定引用的那一刻注入那一段」**。未被引用的结果**永远不进上下文**。

出处：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>（2026-10-20 抓取，页面在部分地区被网关拦截，内容经搜索结果页取回）。

### 1.1 同一家的两个相邻机制

- **动态过滤（dynamic filtering，`web_search_20260209` 起）**：文档原话——模型可以「write and run code that **filters the search results before they reach the context window**」。
  ⇒ **让模型在结果进上下文之前自己筛**，比「先全给、再让模型挑」便宜得多。
- **Context editing（`clear_tool_uses_20250919`）**：上下文超过阈值时，**自动清掉最旧的工具结果**，换成占位文本。
  文档点名被清的是「older tool results (like file contents or **search results**)」。

  出处：<https://platform.claude.com/docs/en/build-with-claude/context-editing>（同上）。

**原则原话**（同上，中文页）：

> 「上下文是一种**收益递减的有限资源，不相关的内容会削弱模型的专注度**。」

## 2. OpenAI Responses API 的 web_search：结果集不进上下文，答案带引用，动作可审计

- 模型看到的是 `message.content[0].text` + `annotations[]`，其中 `url_citation` 给出 **url + title + 位置**。
- **动作是结构化、可审计的**：`web_search_call.action` 是三者之一——
  `search`（带**实际执行过的 query**）、`open_page`（打开某一页）、`find_in_page`（在页内找）。
  文档原话：这些 action 记录「how you verify the model actually searched」。
- **有一个正对口的旋钮**：`search_context_size`——
  「sets **how much context from search results reaches the model**: low / medium (default) / high」。

出处：<https://platform.openai.com/docs/guides/tools-web-search>（2026-10-20 抓取，经搜索结果页取回）。

⇒ **三个动作（search / open_page / find_in_page）+ 一个「多少结果进上下文」的旋钮**，
是本仓能直接对标的**动作模型**。

## 3. MCP：把「给句柄、不内联」写进了协议

MCP 的工具结果内容块有三种新类型，其中一种就是这件事：

> **Resource Links** —「Return a URI reference to an existing resource. The client can then fetch it independently.」
> `{ "type": "resource_link", "uri": "file:///project/src/main.rs", "name": "main.rs", "mimeType": "text/x-rust" }`

中文规范原话：「工具可以 (MAY) 返回指向资源的链接，以提供额外的上下文或数据…返回一个可由客户端订阅或获取的 URI」。

⇒ **「返回句柄而不是内容」是协议级的标准做法**，不是某个产品的私有技巧。

出处：<https://modelcontextprotocol.io/specification>（2026-10-20 抓取，经搜索结果页取回）。

## 4. 对本仓的意义

| 业界做法                                        | 我们能不能照做                                                                                                | 本地等价物                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Anthropic：结果块只给 title+url，**引用点注入** | **不能**——DeepSeek 原始 API 无引用角标、无引用注入（已实测，`docs/research/deepseek-search-api-20261020.md`） | **概览 + 工具动作取深度**（open_page / find_in_page） |
| Anthropic：动态过滤（进上下文前自己筛）         | **能**——子代理有 bash/grep                                                                                    | 落地文件 + grep，或 `find_in_page` 动作               |
| Anthropic：context editing（清旧工具结果）      | **不能**——pi 没有这个 API                                                                                     | pi 自己的 compaction 兜底（不是我们的旋钮）           |
| OpenAI：`search_context_size`                   | **能**（等价物）                                                                                              | 概览的大小（我们这边概览本来就小）                    |
| OpenAI：动作可审计                              | **能**                                                                                                        | 把 action + 实际 query 放进工具结果                   |
| MCP：`resource_link`                            | **不能直接用**（pi 工具没有这个内容块类型）                                                                   | 文件路径 + 行号，或工具动作                           |

### 4.1 我们有一条 DeepSeek 独有的便宜

**API 已经为每条结果算好了 `summary`**（实测 191–4,757 字符的整页摘录）。
那是一份**已经付过钱的资产，只是没进上下文** ⇒ **按需取它，零额外 API 成本、零额外延迟**。
（对比：再抓一次那一页要走 Fetch，**正文带 706 处反斜杠转义**，而且是一次新的计费请求。）

⇒ 这是「概览 + 按需取」在本仓能做得比 Anthropic 更省的地方：
**Anthropic 的 `encrypted_content` 要等服务端在引用点注入；我们的 `summary` 已经在手里了，只是先不给。**

### 4.2 三个变体的实测代价（真数据，count=10）

| 变体                                                     | 每次搜索的模型可见字符 | 128k 能装几次 |
| -------------------------------------------------------- | ---------------------- | ------------- |
| **A** 只给 title + url + 阈值（Anthropic 式）            | 827–1,778              | **292–628**   |
| **B** 再加 `snippet`（DeepSeek 自己的 query 相关短摘要） | 1,505–4,452            | **116–345**   |
| **C** 全量（含 `summary`，= 现状）                       | 8,078–33,692           | 15–64         |

⇒ **B 是平衡点**：比现状便宜 3–10 倍，**且不必再发一次 API 调用**就能判断相关性；
A 更省，但标题常常不足以判断（实测很多标题就是答案，但也有很多不是）。

### 4.3 「再问」那一跳，三个动作的代价

| 动作                                | 代价                                              | 说明                                                              |
| ----------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `open_page(url)`                    | 该条的 `summary`：中位 493–3,267，最大 4,757 字符 | **零额外 API 成本**（API 已经算好）                               |
| `find_in_page(url, pattern)`        | 命中片段（通常几百字符）                          | 同上                                                              |
| 落地文件 + 模型自己 `read` / `grep` | 模型自己决定读哪段                                | 同上；**且等价于 Anthropic 的动态过滤**（模型在进上下文前自己筛） |

⇒ **推荐用工具自己的两个动作，而不是落地文件**：
不产生临时文件（无权限、无生命周期）、**不依赖子代理有 `read`/`bash`**（agent 声明里排掉 `read` 的 child 仍然拿得到深度）、
深度以**工具结果**回来（pi 能正常渲染）、且动作**可审计**（对标 OpenAI 的 `web_search_call.action`）。

## 5. 这份笔记没有回答的

- **pi 自己有没有「工具结果清理」的能力**（对标 `clear_tool_uses_20250919`）——本轮没查 pi 的 compaction 是否会清工具结果。
- **Claude Code 的 `WebSearch`（客户端工具，不是 server tool）给模型什么**——搜到过相关条目，但它的实现细节没读到一手文档。
- Gemini grounding 一侧没查（本轮的三家已足够回答问题）。
