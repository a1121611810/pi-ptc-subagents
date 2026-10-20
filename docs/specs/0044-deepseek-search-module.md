# Spec — 内置 DeepSeek 搜索模块：一个门禁化的、只在程序内可达的检索能力

Map: [#226](https://github.com/a1121611810/pi-ptc-subagents/issues/226)
Status: **draft** — decisions frozen from the map. 实现者开工前不需要再做任何形状或流程上的决定。

> **本 spec 不写实现代码。** 它把 map #226 的四张决策票（#227 形态、#228 门禁、#229 配额、#233 结果与错误）连同两张已关的研究票（#230 凭据面、#231 codemode 桥接）合成一份可直接实现的规格。

## Problem Statement

pi 没有任何网页检索能力：内置工具只有 `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` 七个，没有 web search，也没有 web fetch。所以一条「查一下 pi 的 codemode 怎么暴露工具」的问题，模型只能靠 `bash` + `curl` 硬凑——而 `bash` 本身在本包是 **opt-in binding**（ADR-0040），默认不暴露。

DeepSeek 官方在 2026-10-17 开放了 Search / Fetch 两个裸 JSON 接口（`POST https://api.deepseek.com/v1/tools/search` 与 `/v1/tools/fetch`），**模型无关**（请求体里没有 `model` 字段），与聊天模型完全解耦；同一把 `api.deepseek.com` 的 Bearer key 即可调用。2026-11-01 起 server 端工具调用路径也按次计费（5 元 / 千次成功请求）。

但「加一个能联网的工具」这件事本身带三个新风险，本 spec 逐个封掉：

1. **网络出口**——一个能往外发请求的工具，天然是 opt-in 能力（`bash` 的先例）。
2. **凭据**——要复用 pi 已配置的 DeepSeek 凭据，而「配了没有」的判定踩在一个真实的坑上（见 D6）。
3. **上下文**——检索结果天然体积大，而本包的主题之一就是把模型直接面收窄。

## Solution

**一个内置 DeepSeek 搜索模块**：DeepSeek Search + Fetch，一个实现，出现在**两个程序面**上，**默认不面向模型**；由一个**默认关**的开关 + 一条**凭据判定**双重门禁；带一个**per-session 配额**；结果**原样透传**，错误文案**面向模型写**。

名字里带 `ds`（`web_ds_search` / `web.ds.search` / `webDsSearch`）不是冗余：一来它只走 DeepSeek，二来 DSH 自带一个叫 `web_search` 的工具，而 pi 的工具注册表按名字做 key、同名会互相覆盖——理由见 [ADR-0047](../adr/0047-deepseek-search-is-program-internal.md)。

```
                    ┌─────────────────────────────┐
  model 写程序 ───▶ │  搜索模块（一份实现）          │
                    │  DeepSeek Search / Fetch     │
                    └───────┬─────────────┬─────────┘
                            │             │
              codemode 面    │             │   PTC binding 面
         pi 工具 web_ds_search  │             │  tools["web.ds.search"]
         exposure:"codemode" │             │  （Node worker）
                            ▼             ▼
                    模型永远不直接调它（两个面都不是 direct）
```

### 1. 形状

| 面             | 怎么到                                          | 谁能调                                                     | 跳数 |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------- | ---- |
| codemode 面    | pi 工具 `web_ds_search`，`exposure: "codemode"` | `subagents` surface 上模型的 codemode 脚本                 | 1    |
| PTC binding 面 | pi-ptc binding 表的 `web.ds.search`             | `full` surface 上模型的 PTC 程序；任何 surface 的 PTC 程序 | 1    |

**不注册** `exposure: "direct"` 的顶层工具 ⇒ 模型直接面里没有搜索。

### 2. 门禁

```
开关 webDsSearch.enabled = false  →  两个面都不出现这个工具
开关 = true  +  有凭据          →  两个面都正常可用
开关 = true  +  无凭据          →  两个面都注册，但标注不可用
                                  + 启动告警一次
                                  + 调用返回面向模型的可读错误
```

### 3. 配额

per-session，默认 100 次，可配（`0` = 不限）。Search 与 Fetch 共用一个宿主侧计数器，**只在成功请求时计数**。超限不报错，回一句让模型用已有信息继续作答。

### 4. 结果与错误

结果**原样透传** DeepSeek 的 10 个字段，不裁剪、不做引用装配。错误文案是**一份共享常量**，10 个状态码各一句，外加「200 但空数组」这个**非错误信号**各一句。

## User Stories

- **作为子代理的作者**，我希望能在派出去的活里说「顺便查一下 X 的官方文档」，而那个 child 能自己发起检索——因为 child 是完整 pi 进程，扩展在它里面照常加载，程序面能力随之到位。
- **作为写程序的人**，我希望一次能查多个关键词、并且只把我要的字段回给模型——因为 `count` 拉大不额外计费（计费按请求不按条数），而裁剪是我的事。
- **作为本机的主人**，我希望搜索**默认关**、并且在我没配 DeepSeek 凭据时**明确告诉我缺什么**——因为我不想装个扩展就多一条隐形的联网出口。
- **作为模型**，我希望搜索失败时读到的是一句**我能据此改变策略**的话（该重试 / 该换来源 / 该收工），而不是一个看不懂的状态码。

## Implementation Decisions

### D1 — 搜索是程序内可达的能力，不是 model-facing 工具

搜索**不**注册成 `exposure: "direct"` 的顶层工具。它只出现在 codemode 面与 PTC binding 面。

**「默认不面向模型」是默认状态，不是硬保证。** 真机实测观测到一条路径：会话里若有 `tool_search`，模型可以主动搜到 `codemode` 档的工具**并把它激活进模型声明**。实测证据：模型请求 1/2/3 的工具列表里没有该工具；第 3 次请求发出 `tool_search({ query: … })` 之后，第 4 次请求的工具列表里多出了它。**这一条防不住**——`tool_search` 的可搜集合就是 `codemode` + `deferred` 的注册工具（`dist/extensions/tool-search/tool.js:136-138`），pi 没有「可被 codemode 调、但不被 `tool_search` 搜到」这一档 exposure。

⇒ **实现期要接受并记录的事实**：**不注册成 `direct`** 是本决策能控制的部分；**模型主动调 `tool_search` 把搜索翻到直接面**是 pi 的机制，不是我们注册错了。工具描述里要写明它程序内可达（一旦被激活，模型会在直接面看到它）。取证：`docs/research/pi-codemode-bridge-live-probe-20261020.md`。

**理由**：本包的主题之一是收窄模型直接面（ADR-0010 的 narrowing mode）。主流 harness 恰好相反（Claude Code / Codex / Zed / OpenCode / Cline 的搜索都是顶层 model-facing 工具），但那些 harness 没有本包这条「模型只从程序里调工具」的主张。

**硬约束**：搜索工具**不得**在 `full` surface 以 model-facing 形态注册。0.86.0–0.87.x 上 `exposure` 字段不存在（`docs/agents/pi-compat-matrix.md:63`），注册的工具**一律面向模型** ⇒ 那样做会直接违反本决策。

### D2 — 一份实现，两个面

一份 HTTP 客户端 + 一个 DeepSeek provider 模块，同时被两条通道调用。

**为什么不是 A（只有 codemode 工具）**：A 之下 `full` surface 的模型写 PTC 程序，程序里没有这个 binding ⇒ 拿不到。
**为什么不是 B（只有 PTC binding）**：B 之下 `subagents` surface 的模型写 codemode 脚本，QuickJS 沙箱里没有 PTC worker ⇒ 要绕两跳（codemode → `ptc_run_code` → binding）。
**C 是唯一在两个 surface 都既默认不面向模型、又不缺能力的形状。**

**两条通道的契约本来就不同，实现要各自成立**：

- binding 侧遵循 ADR-0024 的 binding result 形状（`{ content, details }`，`content` 是内容块数组）。
- codemode 侧只拿 `structuredContent`（工具声明了 `outputSchema` 且返回了它时），否则是一坨文本字符串；**`details` 永不进脚本**（`dist/extensions/codemode/execute.js:370-378`）。

⇒ **工具必须声明 `outputSchema`**，否则 codemode 侧拿不到结构化 `results`。

**与 binding contract（ADR-0024）的交互**：搜索是一个**新的 binding 名字**，要进双向覆盖检查——契约里提到的每个名字要么可绑定、要么在非绑定词汇表里；每个被绑定的名字要么在契约里被点名、要么被共享形状覆盖。搜索**要被点名**（它有条例外行为：结果形状不是通用的 `{content, details}`）。`read` 是唯一「被共享形状覆盖但不被点名」的例外，搜索不是。

**与 narrowing mode（ADR-0010）的交互**：搜索不在模型直接面里（包自有工具 + `exposure:"codemode"`），与 ADR-0010 一致，**不需要额外豁免，也不改 ADR-0010**。

### D3 — 命名：名字里带 `ds`，两个名字，一个能力

| 面                     | 名字            |
| ---------------------- | --------------- |
| pi 工具（codemode 面） | `web_ds_search` |
| PTC binding            | `web.ds.search` |
| 配置键（`ptc.json`）   | `webDsSearch`   |

**三个名字都带 `ds`，这不是冗余，是三处各自需要说清的事。**

1. **一眼看得出这是 DeepSeek 提供的搜索。** 这个能力要 DeepSeek 的 key、走 DeepSeek 的账单、用 DeepSeek 自研的搜索引擎（2026-10-17 起开放，11-01 起 server 端路径也按次计费）。一个叫 `web_search` 的名字会让人以为它是「通用网页搜索」，而它其实**只**走 DeepSeek。模型在工具列表里看到 `web_ds_search`、人在 `ptc.json` 里看到 `webDsSearch`，都不用再查文档才知道它绑在哪家服务商上。
2. **provider 是契约的一部分，不是实现细节。** 基线 6 已经定死**不做可插拔**——检索源固定为 DeepSeek，不预留抽象层。所以「这是 DS 的搜索」是一个**永久**的事实，不是「以后可能换掉」的实现选择。把它写进名字是诚实的；同时它还**把通用名 `web_search` 空出来**，留给将来真正 provider-agnostic 的那个工具。
3. **⚠️ 与 DSH 自带工具的同名覆盖风险。** 本包的前提就是 DSH 对齐，而 **DSH 自己就带一个叫 `web_search` 的工具**（`dsh-tool-web`，`tool:web_search`）——ADR-0010 里那个「A binding for `web_search` or `todo` is therefore impossible to build」的例子就是它。而 pi 的工具注册表是**按名字做 key 的 Map**（`toolRegistry.set(tool.name, tool)`，`dist/core/agent-session.js:2895`）⇒ **同名注册会互相覆盖**。一个装了 DSH 工具的 pi 会话里，若本包也注册 `web_search`，两者直接撞车。本仓自己的 `src/mode/ptc-mode.ts` 与 `tests/ptc-mode.test.ts` 也一直拿 `web_search` 当「别的扩展的工具」的例子 ⇒ 这个名字在本仓语境里**已经指 DSH 的工具**了。

   ⇒ `web_ds_search` / `web.ds.search` 同时满足「更明显」与「不撞名」。

**另外两条命名约束**：

- pi 工具名走 `--tools` allowlist 匹配，**不带点更安全** ⇒ pi 工具名用下划线。
- binding 表里非 pi 内置的能力用点号命名空间（先例 `pi.dispatch`），一眼看出这是外部能力而不是 pi 内置工具 ⇒ binding 名用点号。

**这些是刻意的，不要被「统一名字」或「去掉冗余 ds」的善意改动。**

### D4 — 开关：独立键，默认关

- **位置与形状**：`~/.pi/agent/ptc.json` 新增 `webDsSearch: { "enabled": boolean }`。
- **不并进 `optInBindings`**：那是一个**许可**（"给我这个已知的 pi 内置 binding"，目前只有 `bash`，ADR-0040），fail closed；搜索是**包自有能力**的开关，语义不同 ⇒ **独立键**。
- **默认值 `false`**：网络出口 + 按次计费 + 默认不该改变别人机器的行为 ⇒ 贴 `bash` opt-in 的 fail-closed 家族。**用户必须显式开。**
- **读一次**：扩展加载时读一次（与 `optInBindings` / `whyEnabled` 同纪律）。要改就重载。

### D5 — 缺 key：工具仍注册，但标注不可用 + 启动告警一次

**业界没有完全同形先例**（研究结论：没有 harness 做到「总开关打开 + 缺 key 时既保留工具又只在启动时告警一次」），所以本契约自己写死。三件事同时发生：

1. **标注不可用** — 工具描述里写明「本会话未配置 DeepSeek 凭据，调用会失败」。**两处都要写**：codemode 工具的描述（codemode 工具的目录里能看到）**和** binding contract 文本（模型在 `ptc_run_code` / `ptc_workflow` 描述里读它）。**两处必须是同一个共享常量**（one-home rule；先例 `BINDING_CONTRACT`，测试断言两边 `toContain(同一常量)`）。
2. **启动告警一次** — `ctx.ui.notify(..., "warning")`（仓库先例：codemode drift 告警，`src/index.ts:653`）。**一次**（once-only latch），不刷屏。
3. **调用返回面向模型的可读错误** — 文案见 D9。

**为什么「仍注册」而不是「不注册」**：不注册的话模型分不清「没这功能」和「缺凭据」，不会主动告诉用户去配 key。

**开关关 ⇒ 两个面都不注册**：模型面干净，模型不会去调一个调不了的东西（先例：OpenCode `delete event.tools[name]`、Codex `create_web_search_tool` 返回 `None`）。

### D6 — 凭据判定口径

**「deepseek 已配置」当且仅当**能从下列任一处取到至少一个非空字符串：

1. `auth.json` 的 `deepseek` 条目：`type === "api_key"` 且**按 pi 同款语义解析后**的 `key` 是非空字符串；
2. `models.json` 的 `providers.deepseek.apiKey`（同样解析）；
3. `DEEPSEEK_API_KEY` 环境变量（非空字符串）。

**都取不到 / 条目是 `oauth` / `key` 缺失 / `!command` 或 `$VAR` 解析失败 ⇒ 判未配置。**

**优先级**（与 pi 一致）：单次请求显式 `apiKey` → **auth.json** → **models.json** → **环境变量** → 未配置。源码注释：_"A stored credential owns the provider: ambient/env is consulted only when nothing is stored."_（`pi-ai/dist/auth/resolve.js:5-8,14-39`）

**⚠️ 不得用 `readStoredCredential` 的「有没有返回条目」当判定**：它只读 auth.json 且**原样返回、不解析不校验**（`dist/core/auth-storage.js:424-432`），而 pi 内部走 `AuthStorage.read` → `resolveConfigValue` 会**执行 `!command`、插值 `$VAR`**（`:376-384`）⇒ 两种形态下**双向误判**（假阳性 + 假阴性）。本机 `models.json` 用的正是 `!command` 形态。

**实现约束**：

- 要已解析的 key 的**唯一公开路**是 `ModelRuntime.getAuth(providerId)`（根导出的公开类）。**不要用 `getProviderAuthStatus`**——快照未刷新会假阴性。
- 路径走 `getAgentDir()`，**不写死 `~/.pi/agent`**（`getAuthPath()` 未从根导出）。
- **开关关时完全不读凭据文件**（连路径都不解析）。

**泄露禁令**：key **不得**出现在工具描述、错误文案、日志、异常栈、请求 header 打印里。`WORKER_ENV_ALLOW_LIST`（`src/runtime/limits.ts:147-154`）已经挡住 key 类环境变量进 PTC worker，但**扩展跑在 host 进程里**，`process.env.DEEPSEEK_API_KEY` 对它可见 ⇒ 判定必须涵盖环境变量这一级，而它**绝不能被回显**。

### D7 — 配额

- **单位**：per-session。child 是**完整 pi 进程**（新会话）⇒ 它有自己的一份额度，与 per-session 一致，不需要单独的 per-child 规则。
- **不是 per-run**：配额要管「这个会话花了多少」，不是「这次程序发了几次」。
- **默认值 100**：5 元/千次 ⇒ 100 次 ≈ 0.5 元/会话；100 次对绝大多数会话也远超需要。
- **可配**：`webDsSearch.maxCallsPerSession`，**`0` = 不限制**。与 Claude Code 的「能调高不能关」**故意不同**——本包已有一个显式总开关（D4），再叠一个不可关的配额是重复约束。
- **Search 与 Fetch 共用一个配额**（同一个出口、单价一样），但**内部分开计数**，好让文案说清是哪种用完了。
- **只在成功请求时计数**：与计费口径一致（空结果、失败、超时不收费）。**429 不消耗配额**（这次没成功）。
- **计数在宿主侧**：两条通道共用同一个会话级计数器。
- **超限不报错**，回一句：

  > 「本会话的搜索配额已用完（100 次）。请基于已经收集到的信息继续作答，并在答案里说明这一限制。」

  先例：Claude Code 配额耗尽时 _"return a notice telling it to continue with the information it already gathered and say so in its answer"_——降级不是报错，是把提示回灌给模型让它改变策略。

**与 429 必须能分辨**（两者文案**不得**复用同一句）：

|          | 配额耗尽                 | 429 限速                                                                                  |
| -------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| 谁说的   | **本地**                 | **服务端**（账号级 QPS：Search 100/次每秒、Fetch 25/次每秒，另 Fetch 有按目标域名的 QPS） |
| 性质     | 本地策略，可以调大       | 暂时性，等一下就好                                                                        |
| 该做什么 | 用已有信息继续作答并说明 | 等一下重试                                                                                |

**不按金额计量**：DeepSeek 的 `count` 不影响单价，次数是唯一可比的单位；按金额计量要引入价格表，会随服务端调价而漂移。

### D8 — 结果原样透传，模块不裁剪

模块把 `results[]` 的十个字段（`rerank_score` / `title` / `url` / `snippet` / `summary` / `content` / `site_name` / `site_icon` / `date` / `authority`）**原样**交给程序。

- **保真**：`authority`（0–4，≥3 极权威）与 `rerank_score`（0–3，≥1.5 优质）是**程序做阈值过滤的唯一信号**，压成精简字段集就把它们丢了。
- **不裁剪**：`content` 与 `summary`（600–800 字符 × N 条）体积大，但**裁剪是程序的事**——它知道要什么。模块替它裁，就是替模型做了取舍。
- **不做引用装配**：`url` 就在结果里，引用由写程序的模型自己拼。模块**不**产出带序号的引用块。
- **`count` 默认 10**（与 DeepSeek 一致），调用方可传 1–50。**模块不擅自拉大**——虽然「一次多取更省」，但默认拉大会让**上下文**成本不可预测，而上下文比钱更贵。
- **不设体积上限**：模块无权替调用方决定截断点。文档必须写明：要控制体积就用 `need_content: false`（只拿 `summary`）或自己裁。
- **⚠️ 要全文时优先用 Search 的 `need_content: true`，不要用 Fetch**（2026-10-20 实测得出，官方文档没写）：同一个页面，**Fetch 的 `content` 带 706 处反斜杠标点转义**（`\|` `\-` `\:` `\#` `\/` ……连句点逗号都转），而 **Search 的 `content` 几乎不转义**（实测两处各 6 次）、`summary` 则是干净的（0 次）。Fetch 那份正文交给模型，标题不会渲染成标题、表格和列表会被转义噪声淹没。⇒ **Fetch 的定位收窄为「已知 URL 直接抓」与「搜不到时补抓」**，常规取全文走 `need_content: true`。取证：`docs/research/deepseek-search-api-20261020.md` §9.2。

### D9 — 错误文案是一份共享常量

10 个状态码各一句，**面向模型写**：

| 码  | 文案                                                                                             | 可重试 |
| --- | ------------------------------------------------------------------------------------------------ | ------ |
| 400 | 「搜索请求不合法（查询词超长或字段无效）：{message}」                                            | 否     |
| 401 | 「DeepSeek API key 无效或已失效。请在 pi 的凭据里更新后重试。」                                  | 否     |
| 402 | 「DeepSeek 账号余额不足，充值后才能继续搜索。」                                                  | 充值后 |
| 403 | 「该网页被安全策略拒绝抓取。换个来源，或改用搜索结果里的其它链接。」                             | 否     |
| 404 | 「这个网址抓不到可用内容（不可用、被站点拦截、内容类型不支持、或没有可提取的正文）。换个来源。」 | 否     |
| 408 | 「读取请求体超时，稍后重试。」                                                                   | 是     |
| 413 | 「请求体过大。缩短查询，或减少一次请求带的内容。」                                               | 否     |
| 429 | 「搜索接口超过 QPS 限制（Search 100 次/秒、Fetch 25 次/秒）。稍等后重试。」                      | 是     |
| 500 | 「搜索服务内部错误，稍后重试。」                                                                 | 是     |
| 504 | 「搜索服务下游超时，稍后重试。」                                                                 | 是     |

**「200 + 空 results」不是错误**，是一个**信号**：

> 「没有匹配到结果。换个说法，或去掉 site: / lang: / after: 之类的限定再试。」

**官方重试契约**（文案要能让人据此改变策略）：_"遇到 HTTP 408、429 或 5xx 错误时，请等待后重试。遇到 HTTP 402 时，请先充值再重试。对于其它 4xx 错误，如不修改请求，请勿重试。"_

**三条硬性约束**：

- **单一事实源**：codemode 工具描述、binding contract 文本、程序内调用的返回，三处引用**同一份共享常量**（one-home rule，先例 `BINDING_CONTRACT`）。测试断言三处 `toContain(同一常量)`。
- **`param` 恒为 `null`**（DeepSeek 的错误格式如此）⇒ 不能靠 `param` 定位是哪个字段错，只能读 `message` ⇒ 400 的文案**必须带上 `message`**。
- **不得泄露 key**：401 的文案只说「key 无效」，**绝不回显 key 本身或它的片段**。

## Testing Decisions

实现须满足 `docs/testing-constraints.md` 的 6 条硬约束。与本 spec 直接相关的：

- **失败路径必须有 warn 或显式错误状态** —— 缺凭据、401/402/403/404/413、配额耗尽，每条都要有可断言的显式状态，不留静默失败。
- **IO 边界成功/失败双路径都有单测** —— Search 与 Fetch 各测 200 / 4xx / 5xx / 429 / 402；Fetch 另测 403 与 404 的不同文案。
- **期望值能指向独立来源** —— 错误文案与 HTTP 码的映射，引用 DeepSeek 官方文档的原文（`docs/research/deepseek-search-api-20261020.md` §4），不引用实现自身。
- **反事实判据** —— 把「配额耗尽返回降级提示」改成抛错，测试必须红；把「缺凭据时仍注册并标注不可用」改成不注册，测试必须红。
- **两条通道的同一句话必须是一个共享常量** —— 测试断言 codemode 工具描述、binding contract 文本、程序内返回三处 `toContain(同一常量)`（先例：`BINDING_CONTRACT`）。

**要测的边界**：

1. 开关关 ⇒ `pi.getAllTools()` 里没有 `web_ds_search`，binding 表里没有 `web.ds.search`，且**不读凭据文件**。
2. 开关开 + 无凭据 ⇒ 工具**在** `pi.getAllTools()` 里、描述含「未配置凭据」、`ctx.ui.notify` 恰好被调用一次、调用返回 401 文案。
3. 凭据判定：`api_key` / `oauth` / `key` 缺失 / `!command` / `$VAR` / 环境变量 六种形态各一例——`!command` 与 `$VAR` 两例是**回归护栏**（用 `readStoredCredential` 的实现会在这两例上红）。
4. 配额：成功请求计数、失败不计数、429 不计数、Search 与 Fetch 共用计数器、child 进程独立计数、配额耗尽返回降级提示（不抛错）、配额文案 ≠ 429 文案。
5. 结果形状：十个字段原样透传（含 `site_name` / `date` 为 `null` 的情形）。
6. **跨版本**：`pnpm run compat:pi` 要在 0.86.0（declared floor）上仍绿——搜索在 0.86.0 上只能走 PTC binding 面（`exposure` 不存在 ⇒ 不能注册成 model-facing）。

**已补的实测**（2026-10-20，真机 pi 1.3.0 + 最小探针扩展 + 离线 canned provider，4 次会话跑通）：「codemode 脚本真的调到扩展注册的 `exposure:"codemode"` 工具」**已观测到**——静态结论一条也没有被证伪，且实测多出 6 条细节，其中 `tool_search` 能激活 `codemode` 档工具那条已写进 D1。取证：`docs/research/pi-codemode-bridge-live-probe-20261020.md`。

**仍需在实现期补的**：上面那条实测跑的是 **canned provider**（观测的是**桥**，不是模型的选择）⇒ **真模型**下的行为未验（模型会不会主动用 `tool_search` 把搜索翻到直接面？未观测）。

## Out of Scope

- **顶层 model-facing 搜索工具** —— D1 明确否掉。
- **检索源可插拔** —— 抽象层、扩展点、第二家 provider（Tavily / Exa / Brave）全部不做，检索源固定为 DeepSeek Search / Fetch，不预留抽象层。理由：需求范围膨胀（2026-10-20 收缩，map #226 的基线 6）。
- **引用 / 引文格式规范** —— 不做。`url` 就在结果里，引用由写程序的模型自己装配。
- **按金额计量配额** —— D7 定为按次数。
- **代码实现** —— 本 spec 是规格，不是实现。

## Further Notes

### 文档面

- `GLOSSARY.md`：**已补**（2026-10-20）——新增 `## DeepSeek search module (ADR-0047, ADR-0048)` 一节，三个词条：_program-internal reach_（程序内可达）、_DeepSeek search module_、_search gate_（门禁）；并在 `## Out-of-glossary` 里加了 **DSH `web_search`** 与本包搜索模块的区分，顺带点名 pi 工具注册表按名字做 key、同名会互相覆盖这件事。
- `docs/adr/README.md`：**已补**两行（ADR-0047 / ADR-0048）。
- `docs/usage/`：**落点定为 `docs/usage/web-ds-search.md`**（与 `bgdispatch.md` / `surface.md` / `structured-results.md` 并列，一能力一页），README 的 "Tools" 一节在实现时加一条指向。**页面内容在实现时写**——现在就写会记录一个还不存在的行为。

### 计费的时间点

2026-11-01 00:00（北京时间）起，DeepSeek 的 server 端工具调用路径也开始按次计费。**这不影响本 spec 的形状**（本模块走的是自己的 HTTP 请求，不走 server 端工具调用路径），但会影响「用 harness 内置的 server 端搜索」与「用本模块」的相对成本，值得在文档里写一句。

### Source documents

| 文档                                 | 位置                                                                                         | 支撑什么                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| DeepSeek Search / Fetch API 一手事实 | `docs/research/deepseek-search-api-20261020.md`（未提交）                                    | 端点、请求/响应字段、8 个搜索操作符、计费、限速、10 个错误码、无引用角标、无流式 |
| 业界 harness 搜索集成做法            | `docs/research/web-search-integration-practices-20261020.md`（未提交）                       | 三种形态、工具位置、缺 key 的 7 种行为、开关形态、OpenCode 两条入口并存的先例    |
| pi codemode 工具桥接取证             | `docs/research/pi-codemode-tool-bridging-20261020.md`（未提交）                              | `exposure` 四档语义、桥接四跳、序列化规则、0.86.0 / 0.99.0 跨版本产物            |
| pi 凭据面取证                        | `docs/research/pi-credential-surface-20261020.md`（未提交）                                  | 五级优先级、判定口径、`readStoredCredential` 的陷阱、泄露面 5 条                 |
| **真机实测探针**                     | `docs/research/pi-codemode-bridge-live-probe-20261020.md`                                    | 桥接成立；`tool_search` 激活路径；参数/返回的真实形状                            |
| pi 能力矩阵                          | `docs/agents/pi-compat-matrix.md`                                                            | 15 个已发布版本上 `exposure` / codemode / `isError` 等能力点的实测               |
| 既有决策                             | ADR-0010（narrowing mode）、ADR-0024（binding contract）、ADR-0040（bash 是 opt-in binding） | 形状与门禁的约束来源                                                             |
| 决策票                               | #227 / #228 / #229 / #233（已关）+ #230 / #231（已关）                                       | 本 spec 的每个决策的原始讨论与证据                                               |
