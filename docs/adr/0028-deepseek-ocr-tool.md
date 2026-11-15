# 文档识别（doc_ds_ocr）：DeepSeek OCR 作为一个模型直调工具，只活在子代理里

Status: accepted (2026-11-14)。沿用 [ADR-0003](./0003-the-search-lives-in-the-child.md) 的形状；配套门禁见 [ADR-0002](./0002-deepseek-search-gate.md)。

## Context

**一、本仓有个实洞：程序读不了 PDF / Office / 图片。** 五件套的 `read` 只读 utf8，`readPlainText` 遇到二进制返回 undefined（`packages/ptc/src/fs-bindings.ts:85`）⇒ grep 跳过、read 出乱码。bench 轨迹 `bench/ab/out-ws-dg/` 里孩子已经在自己造轮子（`Let me check tools: curl, pdftotext`）——解析能力缺了，模型就自己找。

**二、官方 2026-11-13 开放了整套应用 API**，其中 `POST /v1/tools/ocr` 正好是这件事：multipart/form-data，字段 `file`（本地文件直接传，格式从内容探测）+ `purpose`（`text_recognition` / `rich_layout_recognition`），逐页返回文本。官方口径：≤100 MiB、≤1000 页、整体 ≤180s；计费 $0.225/千页（1.5 元/千页）。另有 Search / Fetch / ASR / TTS 四个接口。

**三、只有 OCR 值得做。** ASR/TTS 在本仓没有语音入口，加了就是没人要的功能。Search/Fetch 本仓早就在用（`packages/search/src/deepseek.ts:81,86`）。

**四、本仓的搜索通道不会被官方取代。** 官方 `deepseek_web_search` 是模型内 server tool，只对 DeepSeek 模型的孩子有效；本仓孩子跟随父模型（session-model 继承契约），父可能是 minimax-cn ⇒ 官方那条路覆盖不了非 DeepSeek 用户。本仓的价值不在「能搜索」，在**模型无关 + 可配额 + 可记忆 + 拿得到原始 results**。

## Decision

**1. OCR 是模型直调工具，不是 binding。** 沿用 ADR-0003 §4 的理由：判断力在干活的子代理侧，模型自己决定要不要解析哪份文件。程序侧维持「文件五件套」这条既有契约（Kimi 面 `ptc_run_code` 的描述里明写「五件套」），不为它开第五个口子。

**2. 只活在子代理里；两个面各包一个形状。**

- pi 面：子代理进程里注册 `doc_ds_ocr`（`exposure: "direct"`），父会话不注册、不解析凭据（ADR-0003 的形状原样）。
- Kimi 面：第三件 MCP 工具 `doc_ds_ocr`（参数 `path` + `workdir`），与 `web_ds_search` 同族。
- 宿主中立的核住在 `packages/search`（`ocr.ts`），pi 形状住 entry、Kimi 形状住 kimi-mcp——与 P2 过河时搜索核的拆法同构。

**3. 门禁：独立键 `webDsOcr`（默认关），配额与搜索共用。** `~/.pi/agent/ptc.json`：

```json
{ "webDsSearch": false, "webDsOcr": false, "searchMaxCalls": 30 }
```

- **独立键，不并进 `webDsSearch`**：ADR-0002 的纪律是「开关名要说清它关的是什么」。搜索是「发关键词出去」，文档识别是**把本地文件上传出去**——性质更敏感，必须能单独关。
- **配额共用一份**（`searchMaxCalls`）：一个进程的 DeepSeek 调用总护栏。两个能力各管各的配额会让总暴露变成两倍乘积。
- 开关关 ⇒ **工具不注册**（ADR-0002 §2）；开关开但缺 key ⇒ 仍注册、调用返回可读错误。
- strict 档的读集随开关**派生**（不是常量）：`searchEnabled` ⇒ 含 `web_ds_search`，`ocrEnabled` ⇒ 含 `doc_ds_ocr`。ADR-0003 实测踩过「strict 名单是常量 ⇒ 能力静悄悄消失」。

**4. 路径必须 jail，两层判。** `file` 是本地文件、路径由模型给 ⇒ 先按字面判（`..` 越界立刻拒，即便文件不存在），再按 realpath 判（软链指向外部也拒）。**这一条不可砍**：它是「模型能让本机把任意文件发到外部」的那道门。

**5. 归约口径。** 官方逐页识别会带版面标记 `<｜ref｜>`（包裹正文）与 `<｜box｜>[[…]]<｜box｜>`（坐标）⇒ **剥标记不剥字**（把 `<ref>` 连同它包的正文一起删掉 = 丢识别结果，探针抓过这个 bug）。逐页给正文；模型可见预算 12,000 字符（与搜索共用一个额度），超了**整页丢弃**并明说省略了哪些；官方 `finish_reason: "length"` 的页（该页被官方按页截断、文本不完整）**必须明说**；官方**没识别出正文**（页在但正文空 / 一页没给）**同样必须明说**——不说，模型分不清「官方没识别出来」与「这份文档本来就是空白页」。机器可读通道（pi 面的 `outputSchema`/`structuredContent`）另带一个 `recognized` 布尔：**页数说不了「正文为空」这件事**——`pages: 1` 既可能是「识别了 1 页」，也可能是「官方返回了 1 个空页」。

**6. 记忆：同一份文件不重复计费。** 按 realpath 做键存归约后的文本；命中即免费返回（并标 `cached`）。**没识别出正文的结果不入记忆**——一次失败不该被固化成「这份文件就是空的」；代价是同一份空白文档反复识别会反复请求官方、反复计费（代码里以 `shortcut:` 注释标了这个上限与升级条件）。

**7. 双通道「二选一」写进工具描述。** 官方 2026-11-13 起 **deepseek-flash 也支持** `deepseek_web_search` / `deepseek_read_url`（旧 ADR-0001 Alternatives 表里写的「仅 deepseek-v4-pro」**已过期**）。孩子跑 DeepSeek 模型且开了服务端搜索时，再用本仓的 `web_ds_search` / `doc_ds_ocr` 就是重复检索 + 重复计费 ⇒ 两个工具的描述各带一句「模型自带联网搜索时别用它」。

## Alternatives considered

| 方案                                            | 为什么没选                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 只做 OCR 的独立调用接口，不进本仓               | 用户要的是「派个孩子去读这份 PDF」，不是「再集成一个 SDK」                                                                                     |
| OCR 做成 PTC 程序 binding（程序内可调）         | 要改 binding 契约（现有四条 note）、破 Kimi 面「五件套」契约，且 `packages/ptc` 是零依赖零宿主叶子包，发 HTTP 需要宿主注入——机制代价远大于收益 |
| 一并做 ASR / TTS                                | 本仓无语音入口，没人要的功能                                                                                                                   |
| 用官方模型内 server tool 代替                   | 只对 DeepSeek 模型的孩子有效；拿不到原始 results 字段；引用不可控                                                                              |
| 走 MCP 搜索/文档服务器（Tavily / Unstructured） | 要用户自己配 `mcp.json`；本仓已有 DeepSeek 一条路，多一条等于多一份依赖                                                                        |

## Consequences

- **补上了实洞**：子代理能读 PDF / Word / PPT / 图片，不再自己造 `pdftotext` 轮子。
- **文件会离开本机**（上传到 DeepSeek 侧处理）⇒ 这句话写进两个面的工具描述，模型与用户都看得见。
- **成本可忽略**：1.5 元/千页 ⇒ 一份 10 页的 PDF 约 0.015 元；真正的成本约束是**上下文预算**，不是钱。
- **配额口径是「调用次数」不是「页数」**：本地护栏按次计，官方按页计 ⇒ 一份 1000 页的文件一次调用就吃掉官方 0.225 元。护栏防的是失控调用次数，不是失控页数（页数上限由官方 1000 页兜底）。
- **父会话不会自动知道孩子能 OCR**：路由索引有 560 token 硬顶（实测 553/560，已近满）⇒ 父侧入口写进 `readOnly` 参数描述与 `reach-the-web` 详情文档（按需 read），不占索引预算。
- **两条搜索通道并存**：DeepSeek 孩子可能同时有服务端搜索与本仓工具 ⇒ 靠描述里的「二选一」提示，不做机制拦截（机制化要猜模型有没有开 server tool，猜错比重复计费更糟）。

## Verification

- `pnpm test` 274 条全绿（pi 215 / output 9 / kimi 37 / standalone 13）。
- **变异测试**（`scripts/mutation-check.mjs`，21 条变异**全被杀死、0 存活**）：每条 = 注入一个真缺陷 → 全量重建 → 跑该能力自己的探针 → 必须红；不红 = 那条探针是假绿。覆盖：剥标记（整体 / 只剥 box）、预算裁剪、官方按页截断告知、两层 jail（字面 / 软链）、记忆命中、配额（检查 / 失败不耗 / 空结果不耗）、multipart 字段名与文件名、HTTP 200 错误对象、门禁（默认关 / 两开关独立）、strict 读集派生、引擎传参、双通道措辞（pi 与 Kimi 两面）、Kimi 工具名与上传事实。
- **变异测试抓出的两个真问题**：
  ① `JSON.parse(text.trim())` 里的 `trim()` 是**死代码**——JSON.parse 自带前导空白容忍（变异「去掉 trim」存活 = 它本来就不是缺陷）⇒ 已删。
  ② Kimi 面 `doc_ds_ocr` 的描述**漏了**「文件会上传到 DeepSeek 侧」与「模型自带联网搜索时别用它」两句 ⇒ 已补（新增 Kimi 门禁 K5 把工具名与这两句事实钉死——K2 只保证「册子 ↔ server 双向一致」，两边一起改名它照样绿）。
- **假绿 hole**（原先写着写着就会漏掉的六处，已逐条补断言）：失败不耗配额 · 空结果不耗配额 · 两个开关互相独立 · strict 读集随开关派生 · 工具真的会跑（越界路径在发请求前被拒）· 双通道提示存在。
- Kimi 面：`tests/kimi/mcp-protocol.test.mjs` 工具表 2 → 3；`tests/kimi/kimi-registry-gates.test.mjs` 新增 K3b（缺 path/workdir 拒、越界路径在发请求前被拒）与 K5（工具名与事实钉死）。
- **新框架下的归属（ADR-0029，2026-11-14）**：本篇的探针与变异随全仓测试层重写搬进 Vitest 5.1.0——OCR 能力（`ocr-core` / `entry-gates`）进能力矩阵 `tests/registry/`，探针打 `packages/search/dist` 与 `packages/entry/dist` 的**产物**；上面的 21 条变异并入登记表，判据从「红了就算杀死」升级为「**红的必须就是 `kills` 指定的那条用例**」（别的用例红 = 假杀死 = 不计杀、判红）。旧探针路径（`tests/kimi/mcp-protocol.test.mjs` 等）已随载体删除而失效，判据本身（工具表形状、jail 双层判、预算整页丢弃、记忆免重复计费）一条未丢。
- 四件套（tsrs / rolldown / oxlint / oxfmt）全绿；产物 import 门禁绿。
- **官方链路实测（2026-11-15）**：用真 DeepSeek key 跑过真实 OCR——官方 `POST /v1/tools/ocr` 返回 200（2.3s），产品层 `runOcr` 与官方逐字一致；多模态模型对扫描件会主动调 `doc_ds_ocr`、有文本层时理性不调。
- **空正文修复的验证（2026-11-15）**：产品改动在 `packages/search/src/ocr.ts`（一个私有谓词 `hasRecognizedText` 同时驱动「告不告知」「入不入记忆」「机器通道的 `recognized` 字段」）与 `packages/entry/src/doc-ds-ocr-tool.ts`（`outputSchema`/`structuredContent` 多一个布尔）。① 探针 `tests/pi/ocr.test.ts` 14/14（三条新用例：两种形态都要明说 + 正常正文不含告知语 + 记忆不命中 + 机器通道的 `recognized` 对不对）。② 变异门禁全量 **110 / 110 全杀、0 存活**（新增三条 mutant：记忆守卫退回旧口径「有没有页」、告知语被吞、`recognized` 恒为 true）。③ 真机两腿全绿（`scripts/ocr-smoke.mjs`：pi 1.5.2 真子代理腿 + Kimi 真 MCP 腿；官方端点换成本地假响应 ⇒ 假官方被命中 1 / 2 次，Kimi 第二次仍重新请求官方 ⇒ 该形态确实没入记忆）。

## See also

- [ADR-0003](./0003-the-search-lives-in-the-child.md) —— 搜索只活在子代理里（本篇沿用其形状）。
- [ADR-0002](./0002-deepseek-search-gate.md) —— 门禁与凭据口径（本篇的 `webDsOcr` 键沿用其纪律）。
- [ADR-0001](./0001-deepseek-search-is-program-internal.md) —— 已撤销；其 Alternatives 表里「provider 端 server tool 仅 deepseek-v4-pro」**已过期**（2026-11-13 起 deepseek-flash 亦支持）。
