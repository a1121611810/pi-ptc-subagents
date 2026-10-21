# DeepSeek 搜索的门禁：一个默认关的开关 + 一条凭据判定

status: accepted (2026-10-20). Ticket #228 (map #226). 配套记录：[ADR-0049](./0049-the-search-lives-in-the-child.md)（形状）。凭据面的取证来自已关的研究票 #230。

## Context

搜索是一个**带网络出口**的工具。DeepSeek 从 2026-11-01 00:00（北京时间）起对 server 端工具调用路径也按次计费（5 元 / 千次成功请求），本模块自己的请求同样计费。

本包对「能跑任意命令」这件事已经有过一次表态：ADR-0040 把 `bash` 定为 **opt-in binding**——它「known but NOT exposed unless the install asks for it」，**fail closed**（配置文件缺失、无 `optInBindings` 键、文件不可解析、键写错，四种情况都什么都不给），并让配置错误在 `session_start` 被报出来。理由是：binding 调用直接打到 `tool.execute()`，绕过 pi 的 `tool_call` 管线（ADR-0005），所以没有沙箱、没有权限门（ADR-0007），唯一的东西就是一次安装。

搜索比 `bash` 窄得多（它不执行命令、只发 HTTP GET 式的请求、只读不改本地），但它**有网络出口**、**要花钱**、**要凭据**——这三个性质加起来，让它至少和 `bash` 同族：**默认关**。

另一半问题是凭据。用户的要求是「开启了并且 pi 中配置了 key 后才能使用」。这句话里藏着一个真实的坑：

pi 的凭据有**三条路**（`auth.json` 存储凭据 / `models.json` 的 `apiKey` / 内置 provider 的环境变量），而 pi 导出的 `readStoredCredential`——**恰好是最容易被拿来用的那个**——只读 `auth.json` 且**原样返回、不解析不校验**（`dist/core/auth-storage.js:424-432`）。而 pi 内部走的是 `AuthStorage.read` → `resolveConfigValue`，会**执行 `!command`、插值 `$VAR`**（`:376-384`）。

也就是说：用 `readStoredCredential` 判「配了 key」，在 `!command` / `$VAR` 两种形态下会**双向误判**（假阳性 + 假阴性）。而本机的 `models.json` 用的**正是** `!command` 形态。

## Decision

### 1. 开关：独立键，默认关，加载时读一次

`~/.pi/agent/ptc.json` 新增：

```json
{ "webDsSearch": { "enabled": false, "maxCallsPerSession": 100 } }
```

- **配置键为什么也带 `ds`**：这个能力只走 DeepSeek（检索源固定，不做可插拔），键名要让人一眼看出它绑在哪家服务商上；理由与命名三连见 [ADR-0049](./0049-the-search-lives-in-the-child.md) §命名（原始论证在被它撤销的 [ADR-0047](./0047-deepseek-search-is-program-internal.md) §命名，那三条**继续成立**）。
- **独立键，不并进 `optInBindings`**：`optInBindings` 是一个**许可**（"给我这个已知的 pi 内置 binding"，目前只有 `bash`），fail closed；搜索是**包自有能力**的开关。两者的语义与失败方向都不同，混在一个家族里会让两个开关的读法互相干扰。
- **默认 `false`**：贴 `bash` opt-in 的 fail-closed 家族。用户必须显式开。
- **读一次**（扩展加载时）：与 `optInBindings` / `whyEnabled` 同纪律——一次运行内第 3 次 dispatch 看到不同答案、而 transcript 里什么都不留，是 #73 拒绝的那种形状。要改就重载。

### 2. 开关关 ⇒ 工具**不注册**

任何地方都不出现：父会话里没有，子代理里也没有。**不注册 = 模型面干净 = 模型不会去调一个调不了的东西。** 先例：OpenCode 的 `delete event.tools[name]`、Codex 的 `create_web_search_tool` 返回 `None`。

### 3. 开关开但缺 key ⇒ 工具**仍注册**，但标注不可用

**业界没有完全同形先例**——研究覆盖的 7 种缺 key 行为里，没有一个是「总开关打开 + 缺 key 时既保留工具又只在启动时告警一次」。所以本契约自己写死。三件事同时发生：

1. **标注不可用**：工具描述里写明「本会话未配置 DeepSeek 凭据，调用会失败」。**这句话出现两处，且是同一份共享常量**（one-home rule）：**工具的描述**（它每会话注册一次，所以那一句说的是这一会话的真话）与**调用失败时抛出的那句**。模型在调用前后读到的措辞完全一致。
   **调用约定由工具描述给出**：工具在 pi 的工具表里，参数由 pi 原生声明——这正是 ADR-0024 说的分工（契约只讲结果形状，因为它不列参数；描述给调用约定）。搜索**不再是 binding**，所以契约里没有它、也不需要它。
2. **启动告警一次**：`ctx.ui.notify(..., "warning")`（先例：codemode drift 告警，`src/index.ts:783`）。once-only latch，不刷屏。**只在子代理里发**——父会话根本没有这个能力，也就没有可告警的东西。
3. **调用返回面向模型的可读错误**，不是原始 `401`。

**为什么「仍注册」而不是「不注册」**：不注册的话，模型分不清「没这功能」和「缺凭据」，不会主动告诉用户去配 key。注册并标注，模型能自己转告。

**为什么错误必须面向模型写**：业界共同避开的失败形态是「工具在、key 不在、调用了才炸出一句看不懂的错」。先例：OpenCode 的 `Web search authentication failed (HTTP 401)` / `Web search rate limited (HTTP 429)`、Tavily keyless 模式下「other tools will return a message explaining that an API key is required」。

### 4. 凭据判定口径

**「deepseek 已配置」当且仅当**能从下列任一处取到至少一个**非空字符串**：

1. `auth.json` 的 `deepseek` 条目：`type === "api_key"` 且**按 pi 同款语义解析后**的 `key` 是非空字符串；
2. `models.json` 的 `providers.deepseek.apiKey`（同样解析）；
3. `DEEPSEEK_API_KEY` 环境变量（非空字符串）。

**都取不到 / 条目是 `oauth` / `key` 缺失 / `!command` 或 `$VAR` 解析失败 ⇒ 判未配置。**

优先级与 pi 一致：单次请求显式 `apiKey` → **auth.json** → **models.json** → **环境变量** → 未配置。源码注释：_"A stored credential owns the provider: ambient/env is consulted only when nothing is stored."_（`pi-ai/dist/auth/resolve.js:5-8,14-39`）

**实现约束**：

- **不得用 `readStoredCredential` 的「有没有返回条目」当判定**（它不解析 `!command` / `$VAR` ⇒ 双向误判）。要已解析的 key 的**唯一公开路**是 `ModelRuntime.getAuth(providerId)`（根导出的公开类）。
- **不要用 `getProviderAuthStatus`**——快照未刷新会假阴性。
- 路径走 `getAgentDir()`，**不写死 `~/.pi/agent`**（`getAuthPath()` 未从根导出）。
- **开关关时完全不读凭据文件**（连路径都不解析）；**父会话时也完全不读**——搜索只活在子代理里（[ADR-0049](./0049-the-search-lives-in-the-child.md)），父进程里不持有一把能开网络出口的 key。

### 5. 泄露禁令

key **不得**出现在：工具描述、错误文案、日志、异常栈、请求 header 打印。`WORKER_ENV_ALLOW_LIST`（`src/runtime/limits.ts:154-161`）已经挡住 key 类环境变量进 PTC worker，但**扩展跑在 host 进程里**，`process.env.DEEPSEEK_API_KEY` 对它可见 ⇒ 判定必须涵盖环境变量这一级，而它**绝不能被回显**。

## Alternatives considered

| 方案                             | 为什么没选                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 开关默认开                       | 带网络出口 + 按次计费；且 `whyEnabled` 已经是本包里 fail-open 的那个开关，再加一个会把「默认给什么」的判断摊薄 |
| 并进 `optInBindings`             | 那是「许可一个已知 builtin」的语义，与「启用一项能力」不同，混用会让两个开关互相干扰                           |
| 缺 key 时**不注册**工具          | 模型分不清「没这功能」与「缺凭据」，不会提醒用户去配 key                                                       |
| 缺 key 时**只告警不标注**        | 模型看到工具却不知道它调不了，会反复试                                                                         |
| 走 `readStoredCredential` 判凭据 | `!command` / `$VAR` 形态下双向误判，且本机正是 `!command` 形态                                                 |
| 用 `getProviderAuthStatus`       | 快照未刷新时假阴性                                                                                             |
| 在 `ptc.json` 里另存一份 key     | 重复的 secret，且与 pi 自己的凭据可能不一致                                                                    |

## Consequences

- **默认行为是零**：不装扩展、不开开关，这台机器不会多一条隐形联网出口。
- **缺 key 是一个被说明的状态，不是一个静默失败**：模型面有标注、启动有一次告警、调用有可读错误。
- **凭据判定的正确性有一条明确的回归护栏**：`!command` 与 `$VAR` 两种形态各一例测试——用 `readStoredCredential` 的实现会在这两例上红。
- **门禁读一次**：改开关要重载，和 `optInBindings` / `whyEnabled` 的既有纪律一致。
- **配额与门禁共用一个配置对象**（`webDsSearch`），但两者是独立的键：关掉开关时配额不生效，开着开关时配额照样兜底。
- **这条门禁只管「能不能用」，不管「在谁手里」**：搜索只活在子代理里，那是 [ADR-0049](./0049-the-search-lives-in-the-child.md) 的形状决定。两条门禁**同时**成立才有这个工具。

## See also

- ADR-0040 —— `bash` 是 opt-in binding（fail-closed 的先例）
- ADR-0041 —— read-only 是 call site 上的一档
- ADR-0049 —— 搜索只活在子代理里，由子代理的模型直接调用
- ADR-0042 / ADR-0043 —— `why` 开关：一个 fail-open 的开关长什么样
- `docs/specs/0044-deepseek-search-module.md` —— 本决策的规格
- `docs/research/pi-credential-surface-20261020.md` —— 凭据面的完整取证
