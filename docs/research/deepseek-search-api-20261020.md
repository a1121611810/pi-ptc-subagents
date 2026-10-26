# DeepSeek Search / Fetch API 调研：独立的原始 JSON 检索接口，不是模型内置能力

> 调研日期: 2026-10-20。回答「DeepSeek 官方 API 文档的『网页搜索与抓取』指南页里，Search 到底是什么、怎么开、返回什么、怎么计费、对做 agent/工具编排的人意味着什么」。
> 方法: 一手文档抓取 + 交叉核对（指南页 → API Reference → 更新日志 → 新闻 → 定价 → Responses API → Chat Completions Reference → Claude Code/Codex 集成页 → 限速页），中英双版本逐条比对。**未实测调用 API**（无 API Key）。
> 一手来源: 全部为 `api-docs.deepseek.com` 官方页面（每条断言后给 URL）。`help.deepseek.com` 与 `static.deepseek.com/faq` 未能抓取，见 §7.11。
> 复核命令: 见 §8（逐条给出可直接粘贴的 curl + 抽正文管道）。
> 仓库快照: `pi-ptc-subagents` HEAD `dc32db6`；本笔记只新增本文件，未改动其它任何文件。

## 0. 结论速查表

| #   | 问题                 | 结论                                                                                                                                 | 出处                                                                                                                                                  |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Search 是什么        | **独立的服务端 HTTP 接口**（`POST /v1/tools/search`），不是模型内置能力，也不是工具调用；请求体**没有 model 字段**，与任何模型无关   | [guide](https://api-docs.deepseek.com/zh-cn/guides/search)、[api ref](https://api-docs.deepseek.com/zh-cn/api/search)                                 |
| 2   | 怎么开               | 显式发 HTTP 请求即可：Bearer 鉴权 + JSON body。**不是**靠模型名触发，也**没有** OpenAI 风格的 `tools` 开关                           | [guide](https://api-docs.deepseek.com/zh-cn/guides/search)                                                                                            |
| 3   | 引用怎么表示         | 响应里**没有引用标记/角标/id**，只有 `url` + `title` + `snippet`/`summary` + `authority`/`rerank_score` 等字段；引用需自己拼         | [api ref](https://api-docs.deepseek.com/zh-cn/api/search)                                                                                             |
| 4   | 计费                 | 按**成功请求次数**（非 token、非条数）：Search / Fetch 各 5 元 / 千次（EN 页写 $0.75）。空结果、失败、超时**不计费**                 | [guide](https://api-docs.deepseek.com/zh-cn/guides/search)、[pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)                        |
| 5   | 配额                 | 账号级 QPS：Search 100 / Fetch 25，彼此独立，与模型并发限制独立                                                                      | [guide](https://api-docs.deepseek.com/zh-cn/guides/search)                                                                                            |
| 6   | 与模型内建搜索的关系 | Responses API 有内置 `web_search`，但**仅 deepseek-v4-pro 支持**，deepseek-flash 下忽略；Chat Completions 的 `tools` 只支持 function | [responses_api](https://api-docs.deepseek.com/zh-cn/guides/responses_api)、[chat ref](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion) |
| 7   | 上线时间             | 2026-10-17「开放自研搜索 API」（随 V4.1-Flash-1017 发布）；server 端工具调用路径自 2026-11-01 00:00（北京时间）起按次收费            | [news261017](https://api-docs.deepseek.com/zh-cn/news/news261017)、[updates](https://api-docs.deepseek.com/zh-cn/updates)                             |
| 8   | 主要坑               | 计费口径跨页冲突（§7.1）、Search 两页不在 sitemap（§7.2）、错误码与 QPS 只在指南页（§7.3/§7.4）、无 OpenAPI/机器可读 schema（§7.5）  | 本笔记 §7                                                                                                                                             |

## 1. Search 到底是什么：三条互不相同的能力

DeepSeek 侧「搜索」现在有 **三个不同入口**，很容易被混为一谈。做编排前必须先确定要哪一个。

### 1.1 A. 独立原始 JSON 接口（本次调研主体）

- 「Search 接口按 query 搜索网页，返回结构化结果。该接口由 DeepSeek 自研搜索引擎提供支持。」；「Fetch 接口抓取单个网页，以 Markdown 文本返回页面内容。」；「两者都是**原始 JSON API**，使用与 DeepSeek API 相同的 Bearer 鉴权。」——<https://api-docs.deepseek.com/zh-cn/guides/search>
- 端点：Search `POST https://api.deepseek.com/v1/tools/search`、Fetch `POST https://api.deepseek.com/v1/tools/fetch`——同上（EN 版同表：<https://api-docs.deepseek.com/guides/search>）。
- 请求体**只有** `query` / `count` / `ori_question` / `localization` / `need_content`，**没有 `model` 参数**——<https://api-docs.deepseek.com/zh-cn/api/search>。
  → 结论：**模型无关的服务端检索服务**，任何持有 API Key 的客户端都能直接调，与 chat 模型调用完全解耦。

### 1.2 B. Responses API 的内置 `web_search`（服务端工具，与 A 不是一回事）

- 「web_search | deepseek-v4-pro 支持。接口会在服务端执行搜索，将结果加入上下文并继续生成响应；**deepseek-flash 下忽略**。」——<https://api-docs.deepseek.com/zh-cn/guides/responses_api>
- 顶层参数 `tools`：「部分支持。function 支持；web_search 在 deepseek-v4-pro 下支持；其他类型忽略」——同上。
- 流式事件：`response.web_search_call.in_progress` / `.searching` / `.completed`（**仅 deepseek-v4-pro**）——同上。
- 「上一次响应返回的 `web_search_call` item 可以回传到 `input`，接口会还原对应的搜索结果并拼接到上下文中。」——同上。
  → 与 A 的差别：B 的结果**由服务端自动进上下文**，客户端拿不到原始 `results` 结构（没有 `rerank_score`/`authority` 那套字段暴露在响应里）；B 只在 v4-pro 上可用。

### 1.3 C. Agent 框架里的 server 端工具调用（Claude Code / Codex / Harness）

- Codex：「Codex 内置的联网搜索仅支持 deepseek-v4-pro，一键脚本默认将其禁用」；配置 `web_search = "live"`；「搜索由 DeepSeek 在服务端执行，请求按 Search 接口的计费规则计费。」——<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex>
- Claude Code：「DeepSeek API 原生支持 Claude Code 中的 Web Search 功能……模型会调用 Web Search 工具，并通过 DeepSeek 提供的 API 进行搜索。因为调用 Web Search 工具会产生额外的大模型 API 请求来对获取到的搜索内容进行总结，因此会产生额外的模型 Token 费用。**搜索请求本身还会按 Search API 计费规则计费。**」——<https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code>
- 指南页/定价页同时说：这类 server 端工具调用「目前未计费，并将于北京时间 **2026 年 11 月 1 日 00:00** 起按次收取调用费用」——<https://api-docs.deepseek.com/zh-cn/guides/search>、<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（口径冲突见 §7.1）。

### 1.4 明确排除项

- **Chat Completions 没有搜索入口**：`tools` 参数说明为「模型可能会调用的 tool 的列表。目前，**仅支持 function 作为工具**」——<https://api-docs.deepseek.com/zh-cn/api/create-chat-completion>。该页 `finish_reason` 枚举为 `[stop, length, content_filter, tool_calls, insufficient_system_resource, aborted]`，**没有**新增的搜索相关取值——同上。
- **不是模型名触发**：定价页列出的模型只有 `deepseek-flash` / `deepseek-v4-pro`，与 Search 无绑定关系——<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>。

## 2. 请求侧：怎么开、传什么

### 2.1 鉴权

| 请求头          | 必填 | 值                          | 出处                                                            |
| --------------- | ---- | --------------------------- | --------------------------------------------------------------- |
| `Authorization` | 是   | `Bearer <DeepSeek API Key>` | [guide#鉴权](https://api-docs.deepseek.com/zh-cn/guides/search) |
| `Content-Type`  | 是   | `application/json`          | 同上                                                            |

### 2.2 Search 请求字段

| 字段           | 类型    | 必填 | 默认值  | 说明                                                                          | 出处                                                      |
| -------------- | ------- | ---- | ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `query`        | string  | 是   | -       | 搜索词，1～128 个 Unicode 字符，不能全为空白，支持下表搜索语法                | [api ref](https://api-docs.deepseek.com/zh-cn/api/search) |
| `count`        | integer | 否   | `10`    | 返回条数，1～50                                                               | 同上                                                      |
| `ori_question` | string  | 否   | -       | 触发搜索的用户原始问题，1～128 字符，有助于理解搜索意图；传 `null` 视为未提供 | 同上（guide 与 ref 表述一致）                             |
| `localization` | string  | 否   | `""`    | 用于优先返回本地化搜索结果的 IP 地址                                          | 同上                                                      |
| `need_content` | boolean | 否   | `false` | 是否在 `content` 返回网页正文；为 `false` 时 `content` 恒为空字符串           | 同上                                                      |

- 「请求体中的**未知字段会被忽略**。」——<https://api-docs.deepseek.com/zh-cn/guides/search>（注意：这条只在指南页，API Reference 页未复述）。
- API Reference 的机器可读约束：`query` non-empty and ≤ 128 characters；`count` ≥ 1 and ≤ 50，Default 10；`ori_question` nullable，non-empty and ≤ 128 characters；`localization` default `""`；`need_content` default `false`——<https://api-docs.deepseek.com/zh-cn/api/search>。

### 2.3 搜索语法（仅在 query 内生效，原样透传给搜索服务）

| 操作符    | 示例                                         | 说明                                     |
| --------- | -------------------------------------------- | ---------------------------------------- |
| `site:`   | `DeepSeek site:github.com`                   | 限定站点；多站点用空格分隔并以 `OR` 连接 |
| `-site:`  | `DeepSeek -site:example.com`                 | 排除站点；多站点空格分隔                 |
| `-`       | `DeepSeek -广告`                             | 排除含指定词的网页；多词空格分隔         |
| `-"..."`  | `DeepSeek -"release notes"`                  | 排除含指定短语的网页（短语内可含空格）   |
| `"..."`   | `DeepSeek "精确短语"`                        | 精确匹配短语；多短语空格分隔             |
| `lang:`   | `DeepSeek lang:zh,en`                        | 限定语言，多语言逗号分隔                 |
| `after:`  | `DeepSeek after:2025` / `after:2025-01-01`   | 限定发布日期之后                         |
| `before:` | `DeepSeek before:2026` / `before:2026-06-01` | 限定发布日期之前                         |

出处：<https://api-docs.deepseek.com/zh-cn/guides/search#搜索语法>（EN 同表：<https://api-docs.deepseek.com/guides/search>）。
「可以组合多个操作符」——同上。

### 2.4 最小可用请求（可直接复制）

```bash
curl https://api.deepseek.com/v1/tools/search \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "DeepSeek site:github.com OR site:huggingface.co lang:en after:2025",
    "count": 10
  }'
```

（`query`/`count` 取自指南页「搜索语法 → 例如」给出的 JSON 示例体；上面的 curl 外壳是按同页 curl 示例的形状拼装的。ZH 版示例用 `lang:zh`，EN 版用 `lang:en`——仅示例本地化差异，机制相同。出处：<https://api-docs.deepseek.com/zh-cn/guides/search>）

### 2.5 Fetch 请求字段

| 字段  | 类型   | 必填 | 说明                                                                   |
| ----- | ------ | ---- | ---------------------------------------------------------------------- |
| `url` | string | 是   | ≤ 8192 字符，必须为含 host 的 HTTP/HTTPS URL，**不能携带用户名或密码** |

出处：<https://api-docs.deepseek.com/zh-cn/api/fetch>、<https://api-docs.deepseek.com/zh-cn/guides/search>。

## 3. 响应侧：结构、来源表示、有没有新字段

### 3.1 Search 响应

「请求成功时返回 HTTP 200 与 `results` 数组。搜索正常结束但没有匹配结果时，返回空数组。」——<https://api-docs.deepseek.com/zh-cn/guides/search>

| 字段           | 类型           | 说明                                                            | 出处                                                      |
| -------------- | -------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `rerank_score` | number         | 排序分数，0～3，综合相关性/权威性/时效性；**≥ 1.5 为优质结果**  | [api ref](https://api-docs.deepseek.com/zh-cn/api/search) |
| `title`        | string         | 标题                                                            | 同上                                                      |
| `url`          | string         | 结果链接                                                        | 同上                                                      |
| `snippet`      | string         | 短摘要，与 query 相关，通常 100～200 字符，**适用于前端展现**   | 同上                                                      |
| `summary`      | string         | 长摘要，与 query 相关，通常 600～800 字符，**适用于给模型阅读** | 同上                                                      |
| `content`      | string         | 网页正文；`need_content` 为 false 或正文缺失时为空字符串        | 同上                                                      |
| `site_name`    | string 或 null | 站点名称，缺失时为 null                                         | 同上                                                      |
| `site_icon`    | string 或 null | 站点图标 URL，缺失时为 null                                     | 同上                                                      |
| `date`         | string 或 null | 发布时间，统一为 UTC 的 RFC 3339 格式，未知时为 null            | 同上（schema 类型为 `date-time`）                         |
| `authority`    | integer        | 网页权威性，0～4（`-1` 表示未知），**≥ 3 为极权威结果**         | 同上（schema 约束 `>= -1 and <= 4`）                      |

```json
{
  "results": [
    {
      "rerank_score": 2.4,
      "title": "DeepSeek V4 模型发布",
      "url": "https://example.com/deepseek-v4",
      "snippet": "DeepSeek V4 已上线，支持工具调用与长上下文。",
      "summary": "DeepSeek 发布了 V4 模型。此次发布改进了工具调用与长上下文能力，适合 Agent 工作流。",
      "content": "DeepSeek V4 现已正式上线……",
      "site_name": "Example News",
      "site_icon": "https://example.com/favicon.ico",
      "date": "2026-06-01T00:00:00+00:00",
      "authority": 3
    }
  ]
}
```

（示例出自 <https://api-docs.deepseek.com/zh-cn/guides/search>；API Reference 的 `Example` 面板同结构，见 <https://api-docs.deepseek.com/zh-cn/api/search>。）

### 3.2 「引用/来源」怎么表示 —— 关键结论

- 响应**没有** citation id、引用角标、`annotations`、或 OpenAI 风格的 `citations` 字段：结果项只有上表 10 个字段，其中 `url` 是唯一的来源标识——<https://api-docs.deepseek.com/zh-cn/api/search>。
- 没有 `finish_reason` / 特殊标记变化：Chat Completions 的 `finish_reason` 枚举未新增取值——<https://api-docs.deepseek.com/zh-cn/api/create-chat-completion>。
- 官方给「喂模型」的字段是 `summary`（600～800 字符，「适用于给模型阅读」），`snippet`（100～200 字符）明确是给前端 UI 的——<https://api-docs.deepseek.com/zh-cn/guides/search>。
- `content` 只有在 `need_content: true` 时才可能有值；默认 `false` 时**恒为空字符串**——同上。

### 3.3 Fetch 响应

| 字段      | 类型   | 说明                       |
| --------- | ------ | -------------------------- |
| `title`   | string | 页面标题，缺失时为空字符串 |
| `content` | string | 抓取后的 Markdown 正文     |

出处：<https://api-docs.deepseek.com/zh-cn/api/fetch>。「Fetch 的结果受目标站点的可用性和访问策略影响。」——<https://api-docs.deepseek.com/zh-cn/guides/search>

## 4. 计费与配额

### 4.1 价格与计费单位

| API    | 计费单位            | 价格（ZH 页） | 价格（EN 页） |
| ------ | ------------------- | ------------- | ------------- |
| Search | 每 1,000 次成功请求 | 5元           | $0.75         |
| Fetch  | 每 1,000 次成功请求 | 5元           | $0.75         |

出处：<https://api-docs.deepseek.com/zh-cn/guides/search#计费>、<https://api-docs.deepseek.com/zh-cn/quick_start/pricing#网页搜索与抓取价格>、<https://api-docs.deepseek.com/guides/search>（EN）。

- 「Search 和 Fetch 按请求次数计费，**不按 token 或返回结果条数计费**。」——<https://api-docs.deepseek.com/zh-cn/guides/search>
- 「只有返回 HTTP 200 且产生结果的请求才会计费（Search 的 `results` 必须非空，Fetch 必须返回网页正文）。请求失败、搜索无结果或超时不计费。`count` 只控制返回的结果条数，**不影响单次请求的价格**。」——同上。
- 扣费来源与优先级：「对应的费用将直接从充值余额或赠送余额中进行扣减。当充值余额与赠送余额同时存在时，优先扣减赠送余额。」——<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- **无缓存计费概念**：指南页与定价页都没有 Search/Fetch 的缓存命中价（模型 token 侧才有缓存命中价，`<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>`）。上下文缓存是模型侧能力，与 Search/Fetch 无关——见 <https://api-docs.deepseek.com/zh-cn/guides/kv_cache>。

### 4.2 限速

| API    | QPS 限制 |
| ------ | -------- |
| Search | 100      |
| Fetch  | 25       |

- 「对每个账号，Search 和 Fetch 分别独立限速，互不占用额度。」「QPS 限制按**账号粒度**计算，与使用哪个 API Key 无关，并与**模型并发限制相互独立**。」——<https://api-docs.deepseek.com/zh-cn/guides/search#限速>
- 「除了账号级限制，Fetch 还针对**目标域名**有 QPS 限制，超过该限制也会收到 HTTP 429 错误码。」——同上。
- 模型并发限制是另一套：账号级 `deepseek-flash` 2500 / `deepseek-v4-pro` 500，且可按 `user_id` 细分——<https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit>（该页**完全不提** Search/Fetch）。

### 4.3 错误与重试

- 「错误响应使用 OpenAI 兼容的错误格式，`param` 字段恒为 `null`。」——<https://api-docs.deepseek.com/zh-cn/guides/search>

| 状态码 | 含义                                                                                             | 可重试 |
| ------ | ------------------------------------------------------------------------------------------------ | ------ |
| 400    | 请求头/请求体不合法（含 JSON 格式错误或字段值无效）                                              | 否     |
| 401    | API Key 缺失或无效                                                                               | 否     |
| 402    | 账号余额不足                                                                                     | 充值后 |
| 403    | Fetch 请求被安全策略拒绝                                                                         | 否     |
| 404    | Fetch 未取得可用内容（URL 不可用/被站点策略拦截/站点报错/内容类型不支持/无可提取 Markdown 正文） | 否     |
| 408    | 读取请求体超时                                                                                   | 是     |
| 413    | 请求体超过大小限制                                                                               | 否     |
| 429    | 超过 Search 或 Fetch 的 QPS 限制                                                                 | 是     |
| 500    | 服务器内部错误                                                                                   | 是     |
| 504    | 下游请求超时                                                                                     | 是     |

- 「Search 和 Fetch 都是只读请求。遇到 HTTP 408、429 或 5xx 错误时，请等待后重试。遇到 HTTP 402 时，请先充值再重试。对于其它 4xx 错误，如不修改请求，请勿重试。」——<https://api-docs.deepseek.com/zh-cn/guides/search>

## 5. 限制与坑（文档写明的）

1. `query` 上限 128 个 Unicode 字符；`count` 1～50；`ori_question` 1～128 字符；Fetch 的 `url` ≤ 8192 字符——<https://api-docs.deepseek.com/zh-cn/api/search>、<https://api-docs.deepseek.com/zh-cn/api/fetch>。
2. 未知请求字段被忽略（拼错参数名不报错，行为静默退化）——<https://api-docs.deepseek.com/zh-cn/guides/search>。
3. `need_content` 默认 false，此时 `content` 恒为空字符串——同上。
4. `summary`/`snippet` 只有长度区间（600～800 / 100～200 字符），**没有**长度上限契约——同上。
5. `rerank_score` 只有 0～3 的区间说明与「≥1.5 优质」的经验阈值，**没有**排序稳定性/去重契约——同上。
6. `authority` 可为 `-1`（未知）、`site_name`/`site_icon`/`date` 可为 null——<https://api-docs.deepseek.com/zh-cn/api/search>。
7. Fetch 受目标站点可用性与访问策略影响，可能 403/404——<https://api-docs.deepseek.com/zh-cn/guides/search>。
8. Fetch 额外有按目标域名的 QPS 限制——同上。
9. 错误格式虽「OpenAI 兼容」，但 `param` 恒为 `null`（不能靠 `param` 定位是哪个字段错，只能读 `message`）——同上。
10. **没有流式**：Search/Fetch 是普通请求-响应，文档未提供 SSE/流式形态——同上（全文无流式描述）。
11. 与普通 chat 的行为差异：Search/Fetch **完全不经过模型**，不产生模型 token、不写对话历史；官方只明确「QPS 限制与模型并发限制相互独立」（<https://api-docs.deepseek.com/zh-cn/guides/search>），**未**明说 Search 请求是否会占用账号的模型并发额度——这一点属于文档未覆盖项。模型侧唯一相关的入口是 Responses API 的 `web_search`（v4-pro 专有）——<https://api-docs.deepseek.com/zh-cn/guides/responses_api>。

## 6. 对做 agent / 工具编排的人意味着什么

> 以下「能不能当检索源」是基于上述一手事实的推论，标 **【推测】** 的是未在官方文档中直接写明的判断。

1. **可以把它当成一个可编程的检索源，但必须自己承担「引用装配」**【推测，基于 §1.1 + §3.2】：它是模型无关的裸 HTTP 接口（无 model 字段、OpenAI 兼容错误格式、Bearer 鉴权），插在任意 agent 循环里都成立；但响应里没有 citation id/角标，「哪句话来自哪个 URL」得由编排层自己用 `url` + `title` + `summary` 组装成带序号的上下文块。
2. **喂模型优先用 `summary`，展示优先用 `snippet`**（§3.2，官方原文区分了这两个字段的用途）。要全文得自己再开一次 `Fetch`（或 `need_content: true`，但官方**没说** `need_content` 与正文体积/延迟的关系——这是未知项）。
3. **计费按成功请求、不按条数**（§4.1）→ 想要更多结果时把 `count` 拉大比发多次请求便宜；反过来，**空结果不收费**，所以「多发几次探针」的成本只在命中时产生【推测，基于「results 必须非空才计费」+「count 不影响价格」两条】。
4. **不能依赖的地方**：
   - 不能依赖它给出模型内建的引用标注（§3.2）；
   - 不能依赖 `content` 一定有内容（默认空串 + 站点策略，§5.3/§5.7）；
   - 不能依赖 `authority`/`rerank_score` 覆盖全部结果（`-1`/null 合法值，§5.6）——把它们当**软信号**做阈值过滤可以，当硬保证不行；
   - 不能依赖错误响应里的 `param` 定位问题（§5.9）；
   - 不能依赖「官方错误码总表」覆盖 Search/Fetch（`/quick_start/error_codes` 完全未提，见 §7.3）；
   - 不能依赖 QPS 与模型并发互相让路（两者独立，见 §4.2）。
5. **与 Responses API `web_search` 的取舍**（§1.2）：要「模型自己决定搜、结果自动进上下文」→ 走 v4-pro 的 `web_search`，省掉编排层，但要接受只有 v4-pro 可用、拿不到 `results` 原始字段；要做「确定性的检索 + 自己装配引用」→ 走独立 Search/Fetch 接口，跨模型可用，但要付装配成本。
6. **成本模型会变**（§1.3 + §4.1）：如果 sub-agent 走的是 DeepSeek Harness / Claude Code / Codex 这类 server 端工具调用路径，官方口径是 2026-11-01 00:00（北京时间）起 Search/Fetch 按次收费——同日 server 端调用还额外产生「总结搜索内容」的模型 token 费用（Claude Code 页明说）。对高频检索型 sub-agent，这是**从 0 到正**的成本变化【推测：官方未给出典型用量下的量级估算】。
7. **本仓（pi sub-agent 派发）相关性**：Search/Fetch 的错误格式与鉴权都是 OpenAI 风格，接进 pi 的工具层不需要额外 SDK 适配；但**它不是 pi 扩展的既有能力**，本次调研未涉及本仓任何代码改动，仅作为「要不要给 sub-agent 加一个检索源」的输入。

## 7. 文档自身的可疑 / 不确定点（实际核到了什么、没核到什么）

| #    | 观察                                                                                                                                                                                                                                                                                                                                                                                            | 证据                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1  | **计费口径跨页冲突**：指南页/定价页说 Harness/Claude Code/Codex 的 server 端工具调用「目前未计费，2026-11-01 起按次收费」；但 Claude Code 集成页与 Codex 集成页直接写「按 Search API 计费规则计费」。**中英表述一致**，故不是翻译差异，是同站跨页冲突。最合理解读是「免费期只覆盖 server 端工具调用路径」，但文档没写这句                                                                       | [guide](https://api-docs.deepseek.com/zh-cn/guides/search) vs [claude_code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code) / [codex](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) / [pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| 7.2  | **Search 的两个页面不在站点 sitemap**：<https://api-docs.deepseek.com/sitemap.xml> 共 54 条，含 `/api/fetch`，**不含 `/guides/search` 与 `/api/search`**（两页实测 200 可访问）；但 sitemap 里另外 11 个 `/guides/*` 页**都在**（`vision`/`thinking_mode`/`kv_cache`/`responses_api` 等）⇒ 是增量更新漏了 search 这两页，**不是 guides 整段缺失** → 靠 sitemap 抓文档的脚本会漏掉 Search 的一半 | [sitemap](https://api-docs.deepseek.com/sitemap.xml)                                                                                                                                                                                                                                                                 |
| 7.3  | **错误码双轨**：Search/Fetch 的状态码表只存在于指南页，`/quick_start/error_codes` 全文无 Search/Fetch 相关内容                                                                                                                                                                                                                                                                                  | [guide](https://api-docs.deepseek.com/zh-cn/guides/search) vs [error_codes](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)                                                                                                                                                                             |
| 7.4  | **限速口径分散**：QPS（100/25）只在指南页，`/quick_start/rate_limit` 只讲模型并发与 user_id 隔离，无 Search/Fetch                                                                                                                                                                                                                                                                               | [guide](https://api-docs.deepseek.com/zh-cn/guides/search) vs [rate_limit](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)                                                                                                                                                                               |
| 7.5  | **没有公开的机器可读 schema**：`https://api-docs.deepseek.com/openapi.json` 返回 200 但内容是 SPA 首页 HTML（`<!doctype html>`），不是 OpenAPI 文档 → 无法据此做代码生成；schema 只以渲染页形式存在                                                                                                                                                                                             | `curl -sSL https://api-docs.deepseek.com/openapi.json \| head -c 60` → `<!doctype html><html lang="en" …>`                                                                                                                                                                                                           |
| 7.6  | **币种表述不同且无换算说明**：ZH 页 5 元/千次，EN 页 $0.75/千次。两处都没写汇率或「等值」字样，数值是否严格等价**未核实**（汇率非官方来源，故不引用）                                                                                                                                                                                                                                           | [guide ZH](https://api-docs.deepseek.com/zh-cn/guides/search) vs [guide EN](https://api-docs.deepseek.com/guides/search)                                                                                                                                                                                             |
| 7.7  | **同一批字段在两处各写一遍**：API Reference 的约束只给上界（`rerank_score: <= 3`、`authority: >= -1 and <= 4`），指南页给完整区间（0～3、0～4）→ 以指南页为准更安全；Reference 里 `localization` 是唯一**没有** `Possible values` 标注的字段；「请求体中的未知字段会被忽略」这条只写在指南页，Reference 未复述                                                                                  | [api ref](https://api-docs.deepseek.com/zh-cn/api/search) vs [guide](https://api-docs.deepseek.com/zh-cn/guides/search)                                                                                                                                                                                              |
| 7.8  | **示例本地化差异（非机制差异）**：组合操作符示例 ZH 用 `lang:zh`、EN 用 `lang:en`；curl 示例 query ZH 为「DeepSeek V4 模型 发布」、EN 为「DeepSeek V4 release」                                                                                                                                                                                                                                 | 同 7.6 两页                                                                                                                                                                                                                                                                                                          |
| 7.9  | **schema 示例的 `date` 不是固定值**：Reference 页 "Example (from schema)" 的 `date` 为 `2026-10-19T05:41:50.168Z`（ZH）/ `.090Z`（EN），两语言版本毫秒不同 → 属构建/生成产出的动态值，不宜当固定样例引用（推断：同一构建内生成）                                                                                                                                                                | [api ref ZH](https://api-docs.deepseek.com/zh-cn/api/search) / [EN](https://api-docs.deepseek.com/api/search)                                                                                                                                                                                                        |
| 7.10 | **「都是只读请求」措辞不严谨**：同一页又说成功请求会计费、402 为余额不足——「只读」只能理解为不改动被搜站点/不写用户数据，不是「无副作用」                                                                                                                                                                                                                                                       | [guide](https://api-docs.deepseek.com/zh-cn/guides/search)                                                                                                                                                                                                                                                           |
| 7.11 | **帮助中心未核到**：<https://help.deepseek.com/> TLS 握手失败（`SSL_ERROR_SYSCALL`）；文档站实际指向的 <https://static.deepseek.com/faq/index.html?lang=zh#/category/4> 是纯 JS SPA，主 bundle 内**无任何中文字符串**，也未定位到其内容数据接口（仅见 `/api/v0/client/settings`，实测 404）→ **FAQ 是否存在关于搜索的条目，未核实**                                                             | curl 实测                                                                                                                                                                                                                                                                                                            |
| 7.12 | **未实测 API 行为**：本次无 API Key，未发起任何 Search/Fetch 调用 → 「空结果确实不收费」「`summary` 的 600～800 字符只是 typically 而非契约」「`authority` 分布」等均为文档声明，**未运行验证**                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                    |

## 8. 快照与复核命令

**抓取日期**：2026-10-20。**页面版本标识**：Docusaurus v3.1.0，`docs-version-current` / `docs-tag=docs-default-current`，doc-id `guides/search`；页脚 `Copyright © 2026 DeepSeek, Inc.`；**页面自身无「最后更新」时间戳**，故版本只能记到「2026-10-20 抓取时的 current 版」。

抽取正文的通用管道（下列所有命令共用）：

```bash
curl -sSL "<URL>" | python3 -c "
import sys,re,html
t=sys.stdin.read()
m=re.search(r'<article>(.*?)</article>',t,re.S); b=m.group(1) if m else t
b=re.sub(r'<script.*?</script>','',b,flags=re.S); b=re.sub(r'<style.*?</style>','',b,flags=re.S)
b=re.sub(r'<br\s*/?>','\n',b); b=re.sub(r'</(p|div|tr|h1|h2|h3|h4|li|pre|table)>','\n',b)
b=re.sub(r'</t[dh]>',' | ',b); b=re.sub(r'<[^>]+>','',b); print(re.sub(r'\n{3,}','\n\n',html.unescape(b)))"
```

逐页复核：

```bash
# 目标页（中/英）
curl -sSL https://api-docs.deepseek.com/zh-cn/guides/search | head -c 2000
curl -sSL https://api-docs.deepseek.com/guides/search   | head -c 2000   # EN 无 /en/ 前缀

# API Reference
curl -sSL https://api-docs.deepseek.com/zh-cn/api/search
curl -sSL https://api-docs.deepseek.com/zh-cn/api/fetch

# 上线时间与计费口径
curl -sSL https://api-docs.deepseek.com/zh-cn/updates   | head -c 2000
curl -sSL https://api-docs.deepseek.com/zh-cn/news/news261017 | head -c 2000
curl -sSL https://api-docs.deepseek.com/zh-cn/quick_start/pricing | head -c 2000

# 与模型侧搜索的关系
curl -sSL https://api-docs.deepseek.com/zh-cn/guides/responses_api   | head -c 2000
curl -sSL https://api-docs.deepseek.com/zh-cn/api/create-chat-completion | head -c 2000
curl -sSL https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code | head -c 2000
curl -sSL https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex      | head -c 2000

# §7.2 / §7.5 的两处实测
curl -sSL https://api-docs.deepseek.com/sitemap.xml | grep -c '<loc>'
curl -sSL https://api-docs.deepseek.com/sitemap.xml | grep -E 'search|fetch'
curl -sSL https://api-docs.deepseek.com/openapi.json | head -c 60
```

注：`api-docs.deepseek.com` 对未带尾斜杠的路径返回 302，统一用 `-L` 跟随；`/en/` 前缀不存在（会落到英文首页），英文页路径就是 `/guides/search`。
