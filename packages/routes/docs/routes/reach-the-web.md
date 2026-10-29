# 上网查资料（web_ds_search · 搜索域）

pi 面上，搜索能力**只活在被派出的子代理里**（父会话不注册这个工具）——「这条来源靠不靠谱」的判断力在干活的子代理侧。

> Kimi 面（`ptc-tools` 插件）例外：`web_ds_search` 模型可直接调用，配额按 MCP server
> 进程计（默认 30 次），DeepSeek key 走 env → Kimi Code `config.toml` 两级解析。

三动作：

- `search({ query, count? })`：概览（title/url/snippet，默认 10 条）。snippet 是 DeepSeek 自算的短摘要——便宜且不丢事实；长 summary 不经概览给
- `open({ url })`：抓整页（记忆命中最近结果则免费）
- `find({ url, pattern })`：页内按正则匹配行（先查记忆）

预算与配额：

- 模型可见文本预算 12,000 字符；超了按排名**整条丢弃** + 告知丢了哪些（要哪个用 open 补抓）——不按字符截断
- 配额每进程计（`searchMaxCalls`，默认 30 次/进程，0 = 不限；只计成功调用）
- 开关 `webDsSearch`（`~/.pi/agent/ptc.json`）是布尔，**默认关**：开关关 = 工具不存在；开关开但缺凭据 = 注册但调用返回可读错误
