# pi 的 provider 凭据存储面：「pi 中配了 key」到底怎么判定

> 调研日期: 2026-10-20。回答「pi 在发请求时，一个 provider 的 key 到底从哪取、优先级是什么；pi 导出的 `readStoredCredential` 读的是哪一条、跟 pi 内部真正用的路径是不是同一条；这个 API 从哪个 pi 版本存在、本仓 declared floor 上在不在；『配了 key』的判定口径是什么；key 会从哪些地方漏出去；机器级凭据与用户级开关错配时各路径分别返回什么」，为 `pi-ptc-subagents` 的内置网页搜索模块（复用 pi 已配置的 deepseek 凭据）定判定口径。
> 方法: 一手源码精读（读**已安装实体** `node_modules/@earendil-works/pi-coding-agent@1.3.0` 的编译产物 `dist/**/*.js` + `.d.ts`，并用上游 GitHub 仓库 `earendil-works/pi` 的原始 TS 交叉核对）+ 跨版本取证（`npm view versions` + `npm pack` 解包 4 个版本 tarball 逐个 grep）+ 本机实测（合成 auth.json 探针，比对 `readStoredCredential` 与 `AuthStorage.read` 的解析差异）+ 本机配置实测（`~/.pi/agent/` 下三个文件，只看结构不看密钥值）。**未调用 DeepSeek 任何 API**（不需要）。
> 一手来源说明: 每条机制性断言给「安装实体文件路径 + 行号/符号名」；跨版本结论给 npm tarball 版本对照；上游源码给 GitHub URL。**本机密钥值一律不出现在本笔记**（只记长度、条目名、字段名、文件权限）。GitHub code search / commit search 对 `earendil-works/pi` 返回 0 条（连已知符号 `readStoredCredential` 也是 0），**故该仓库未被代码搜索索引，搜索结果不作为证据**；上游证据改用 `gh api repos/.../git/trees` 与 `raw.githubusercontent.com` 直接取文件。
> 复核命令: 见 §9。
> 仓库快照: `pi-ptc-subagents` HEAD `64de4bd`；本笔记只新增本文件，未改动仓库其它任何文件。

## 0. 结论速查表

| #   | 问题                          | 结论                                                                                                                                                                                          | 出处                                                                                                 |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | pi 发请求时 key 从哪取        | **五级链**：①单次请求显式 `apiKey` → ②**auth.json 存储凭据** → ③**models.json 的 `apiKey`** → ④内置 provider 的环境变量（`DEEPSEEK_API_KEY`）→ ⑤都无 → 未配置                                 | `pi-ai/dist/auth/resolve.js:14-39`；`pi-coding-agent/dist/core/provider-composer.js:280-305`         |
| 2   | 三条路谁覆盖谁                | **auth.json > models.json.apiKey > 环境变量**。存储凭据一旦存在就"拥有"该 provider，环境变量只在**什么都没存**时才被查                                                                        | `pi-ai/dist/auth/resolve.js:5-8, 24-38`（注释明写 "A stored credential owns the provider"）          |
| 3   | `provider-keys.json` 是什么   | **不是 pi 的文件**。pi 全包（dist/docs/schemas/CHANGELOG）零引用，pi 官方 agent-dir 文件表里也没有；本机它是用户自建的，靠 `models.json` 的 `apiKey: "!jq -r ... provider-keys.json"` 接进 pi | `grep -rn "provider-keys" node_modules/@earendil-works/` = 0 命中；`docs/configuration.md:11-24`     |
| 4   | `readStoredCredential` 读哪条 | **只读 auth.json**，且是**原始 JSON、不解析、不校验**：返回条目的 `key` 原样字符串（`!command` 仍是命令串、`$VAR` 仍是模板串）                                                                | `dist/core/auth-storage.js:424-432`；上游 `packages/coding-agent/src/core/auth-storage.ts` 同名函数  |
| 5   | 它和 pi 内部路径同一条吗      | **不同**。pi 内部走 `AuthStorage.read` → `resolveConfigValue`，会**执行 `!command`、插值 `$VAR`**；`readStoredCredential` 两样都不做 → **用它判「配了 key」会误判**                           | `dist/core/auth-storage.js:376-384` vs `:424-432`；`dist/core/resolve-config-value.js:123-129`       |
| 6   | 多 key 轮换看得到吗           | **看不到，也不存在**：pi 没有 `activeKeyName` / `keys` 概念，一个 provider 在 auth.json 里**只有一条**凭据                                                                                    | `pi-ai/dist/auth/types.d.ts:42-49`（"one credential per provider"）                                  |
| 7   | 从哪个版本存在                | **0.80.8**（2026-07-16）首次存在。0.80.7 无、0.80.8 有；本仓 declared floor **0.86.0 > 0.80.8 → 存在**；capability floor 0.99.0 也存在；签名 0.80.8→1.3.0 未变                                | npm tarball 逐版 grep（§3）；`CHANGELOG.md:1313,1323`                                                |
| 8   | 凭据类型有几种                | **两种**：`api_key`（`key` 可选 + `env` 可选）与 `oauth`（必须 `access`/`refresh`/`expires`）。**没有第三种**                                                                                 | `pi-ai/dist/auth/types.d.ts:15-32`；`dist/core/auth-storage.js:187-210`                              |
| 9   | 「配了 key」的判定口径        | **条目存在 ≠ 配了**。`type` 必须是 `api_key`、解析后 `key` 必须是**非空字符串**；`oauth` 条目、`key` 缺失、`!command` 解析失败，一律判**未配置**                                              | §4                                                                                                   |
| 10  | key 会漏到哪                  | 5 个面：`models.json` 明文字面量、`!command` **原文进错误消息**、`before_provider_headers` 事件把完整请求头交给任意扩展、聊天原文落 session jsonl、`PI_CODING_AGENT_DIR` 指进仓库时明文进 git | §5                                                                                                   |
| 11  | pi 会把 key 放进环境变量吗    | **不会**。pi/pi-ai 全量 grep `process.env.X =` 只有 `PI_CODING_AGENT`/`AI_AGENT`/`PI_OFFLINE`/`PI_SKIP_VERSION_CHECK`/`DEBUG` → 本仓 `WORKER_ENV_ALLOW_LIST` 确实挡住了 key 类变量            | `src/runtime/limits.ts:147-154`；§5.4                                                                |
| 12  | 扩展能向 pi 要已解析的 key 吗 | **不能直接要**：`ExtensionAPI` 没有任何 ModelRuntime / 凭据访问器。但 `ModelRuntime` 是根导出的公开类，`getAuth(providerId)` 返回**已解析**的 key（实测 10ms 建实例）                         | `dist/core/extensions/types.d.ts`（`ExtensionAPI` 无凭据成员）；`dist/core/model-runtime.js:369-383` |

## 1. pi 自己发请求时，key 到底从哪取：五级链

### 1.1 链路全貌

一次 provider 请求的鉴权解析发生在 pi-ai 的 `resolveProviderAuth`：

```
resolveProviderAuth(provider, credentials, authContext, overrides)   pi-ai/dist/auth/resolve.js:10
 └─ resolveProviderAuthWithSignal(...)                               pi-ai/dist/auth/resolve.js:14-39
     ① overrides.apiKey !== undefined → 直接用（单次请求显式覆盖）    resolve.js:17-23
     ② stored = await credentials.read(providerId)                    resolve.js:24
        stored.type === "oauth" → 走 provider.auth.oauth（无则 undefined）  resolve.js:26-28
        stored.type === "api_key" → resolveApiKey(..., credential)    resolve.js:29-32
        其它 type → undefined（不回落环境变量）                        resolve.js:33
     ③ stored 为空 → provider.auth.apiKey.resolve({ credential: undefined })
        = 环境变量 / models.json / 内置 ambient 路径                   resolve.js:35-38
```

第 ② 步的 `credentials` 在 coding-agent 侧是 `RuntimeCredentials` 包 `AuthStorage`（`dist/core/model-runtime.js:80`）。`AuthStorage.read()` 会**解析** key 值：

```js
// dist/core/auth-storage.js:376-384
async read(provider, options) {
    const credential = (await this.readLatestData(options))[provider];
    if (credential?.type !== "api_key") return credential;
    if (credential.key === undefined) return credential;
    return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
}
```

`resolveConfigValue`（`dist/core/resolve-config-value.js:123-129`）有三种形态：

| 形态         | 语法              | 行为                                                                              | 出处                                                                |
| ------------ | ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 命令         | `!cmd args`       | 执行命令取 stdout（trim），空输出/超时/非零退出 → `undefined`；结果**进程内缓存** | `resolve-config-value.js:65-70, 172-188`                            |
| 环境变量模板 | `$VAR` / `${VAR}` | 读环境变量；`credential.env` 里的同名项**优先于**进程环境                         | `resolve-config-value.js:71-96`；`pi-ai/dist/auth/helpers.js:22-24` |
| 字面量       | 其它              | 原样当 key                                                                        | `resolve-config-value.js:118-122`                                   |

### 1.2 第 ③ 步里 models.json 与环境变量的先后

coding-agent 把内置 provider 与 `models.json` 合成一个 provider（`dist/core/provider-composer.js:240-307`）。合成后的 `resolve`：

```js
// dist/core/provider-composer.js:280-298
resolve: async (input) => {
    let result;
    if (input.credential) {                       // ← auth.json 有存储凭据
        result = inherited ? await inherited.resolve(input) : (input.credential.key ? {...} : undefined);
    }
    else if (rawKey !== undefined) {              // ← models.json 的 apiKey
        const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
        result = inherited ? await inherited.resolve({...input, credential: { type: "api_key", key }})
                           : { auth: { apiKey: key }, source: "configured API key" };
    }
    else {                                        // ← 内置 provider 的 ambient（环境变量）
        result = await inherited?.resolve(input);
    }
    ...
}
```

`rawKey` 就是 `models.json` 里那个 provider 对象的 `apiKey`（`provider-composer.js:221-223`）。内置 provider 的 ambient 回退是 `envApiKeyAuth`：

```js
// pi-ai/dist/auth/helpers.js:16-25
resolve: async ({ ctx, credential, signal }) => {
  if (credential?.key)
    return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
  for (const envVar of envVars) {
    // deepseek → ["DEEPSEEK_API_KEY"]
    const value = await ctx.env(envVar);
    if (value) return { auth: { apiKey: value }, source: envVar };
  }
  return undefined;
};
```

DeepSeek 的内置定义（`pi-ai/dist/providers/deepseek.js:7-14`）：`auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) }`；官方文档同口径（`docs/providers.md:36`）。

**一个必须注意的短路**：`composeProvider` 在「该 provider 既没有 models.json 配置、也没有扩展注册」时**直接返回内置 provider 原件**，合成层根本不参与（`dist/core/provider-composer.js:156-163`）。所以对 `deepseek`（本机 models.json 里没有它的条目）来说，**第 ③ 步只有环境变量一条路**，`models.json.apiKey` 那条路不存在。

### 1.3 完整优先级（一条 provider 请求实际拿到的 key）

| 级  | 来源                                    | 覆盖谁   | 触发条件                                    | 出处                                                                                       |
| --- | --------------------------------------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ①   | 单次请求显式 `options.apiKey`           | 覆盖全部 | 调用方显式传                                | `pi-ai/dist/auth/resolve.js:17-23`；`dist/core/model-runtime.js:456-460, 477`              |
| ②   | **auth.json** 存储凭据                  | 覆盖 ③④  | `credentials.read()` 返回该 provider 条目   | `pi-ai/dist/auth/resolve.js:24-32`；`dist/core/auth-storage.js:376-384`                    |
| ③   | **models.json** `providers.<id>.apiKey` | 覆盖 ④   | ② 无条目，且该 provider 有 models.json 配置 | `dist/core/provider-composer.js:289-295`；`dist/core/model-config.js:57`                   |
| ④   | **环境变量** `DEEPSEEK_API_KEY`         | ——       | ②③ 都无                                     | `pi-ai/dist/auth/helpers.js:20-25`；`pi-ai/dist/providers/deepseek.js:12`                  |
| ⑤   | 都无                                    | ——       | ——                                          | 判定为"该 provider 未配置"，`checkAuth` 返回 `undefined`（`pi-ai/dist/models.js:283-293`） |

**结论**：`auth.json` > `models.json.apiKey` > 环境变量。语义依据是 pi-ai 源码里的原话：_"A stored credential owns the provider: ambient/env is consulted only when nothing is stored. No silent env fallback after a failed refresh or for a credential type without a matching handler."_（`pi-ai/dist/auth/resolve.js:5-8`）

### 1.4 `provider-keys.json` 在这张表里的位置：不在

- pi 全包检索 `provider-keys` / `activeKeyName`：**0 命中**（`node_modules/@earendil-works/` 全量 grep，含 dist、docs、schemas、CHANGELOG）。
- pi 官方 agent-dir 文件表只列了 `settings.json` / `keybindings.json` / `mcp.json` / `models.json` / `auth.json` / 指令与资源目录，**没有 `provider-keys.json`**（`docs/configuration.md:9-24`）。
- 本机 `~/.pi/agent/models.json` 里 `providers["minimax-cn-512k"].apiKey` 是一个 **`!command`**：
  `!jq -r '.["minimax-cn"].keys[0].apiKey' "$HOME/.pi/agent/provider-keys.json"`
  —— 也就是说，**`provider-keys.json` 是用户自建的多 key 轮换文件，靠 pi 的 `!command` 机制挂在 `models.json` 上**，pi 自己完全不知道它的存在（`docs/providers.md:71-84` 描述 `!command` 机制；本机实测 `~/.pi/agent/provider-keys.json` 形状为 `{ "<providerId>": { activeKeyName, keys: { "0": { name, apiKey } } } }`）。
- **对 deepseek 的直接影响**：本机 `provider-keys.json` 里也有一条 `deepseek`（`activeKeyName` 指向「密钥 1」，`keys` 只有 `"0"` 一项），但**它对 pi 的 deepseek provider 完全无效** —— 它只被 `minimax-cn-512k` 的 `!command` 引用。pi 的 deepseek 走的是 `auth.json` 那条。

### 1.5 三条读取路径对照表

| 路径                   | 载体 / 位置                                                                                              | pi 发请求时读吗                                      | 相对其它路径的位次 | `readStoredCredential` 看得到吗 | 解析语义                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| ① 存储凭据             | `~/.pi/agent/auth.json` → `{ "<providerId>": { type: "api_key", key, env? } \| { type: "oauth", ... } }` | **读，最高优先**                                     | 覆盖 ②③            | **看得到**（唯一看得到的）      | pi 内部：`resolveConfigValue` 解析 `!command`/`$VAR`；`readStoredCredential`：**不解析** |
| ② provider 配置        | `~/.pi/agent/models.json` → `providers.<id>.apiKey`                                                      | 读（仅当 ① 无条目且该 provider 有 models.json 配置） | 覆盖 ③             | **看不到**                      | `resolveConfigValue`：`!command` 会**被执行**（10s 超时，进程内缓存）                    |
| ③ ambient 环境变量     | `process.env.DEEPSEEK_API_KEY`                                                                           | 读（仅当 ①② 都无）                                   | 最低               | **看不到**                      | 直接取值                                                                                 |
| ④ 运行时覆盖           | `RuntimeCredentials.setRuntimeApiKey()`（`dist/core/runtime-credentials.js:8-10`）                       | 读，**覆盖 ①②③**（`resolve.js:17-23`）               | 最高               | **看不到**                      | 内存内                                                                                   |
| — `provider-keys.json` | `~/.pi/agent/provider-keys.json`                                                                         | **不读**（pi 零引用）                                | 不在链路里         | **看不到**                      | 用户自建的多 key 轮换，经 `models.json` 的 `!command` 间接触发                           |

> 表中"覆盖 ①②③"指 `RuntimeCredentials.read()` 先查 `overrides` 再查底层 store（`dist/core/runtime-credentials.js:17-21`）。

## 2. `readStoredCredential` 读哪一条：只读 auth.json，且不解析

### 2.1 实现（安装实体 1.3.0）

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js:420-432
/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(providerId, authPath = join(getAgentDir(), "auth.json")) {
  try {
    const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8")));
    return data[providerId];
  } catch {
    return undefined;
  }
}
```

上游原始 TS 同形：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/auth-storage.ts>（文件末尾 `readStoredCredential`）。

四个必须记住的性质：

1. **只读 `auth.json`**。不看 `models.json`、不看环境变量、不看 `provider-keys.json`、不看运行时覆盖。
2. **不解析**。`key` 字段原样返回。`!command` 仍是命令字符串，`$VAR` 仍是模板字符串。
3. **不校验**。不像 `ReadOnlyAuthStorage.load()` 会逐条校验 `type`/`key`/`env`/`access`/`refresh`/`expires`（`dist/core/auth-storage.js:187-210`），这里直接返回 `data[providerId]`，畸形条目原样返回。
4. **失败即 `undefined`**。文件不存在、JSON 解析失败、provider 无条目，全部返回 `undefined`（无异常）。

### 2.2 与 pi 内部路径**不是**同一条（实测差异）

用合成 auth.json 逐形态比对（本机实测，密钥为合成值）：

| auth.json 里 `deepseek` 的 `key`       | `readStoredCredential` 返回                          | `AuthStorage.read`（pi 内部）返回              | 一致？                     |
| -------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- | -------------------------- |
| `"sk-test-literal-value"`              | `"sk-test-literal-value"`                            | `"sk-test-literal-value"`                      | ✅                         |
| `"!printf synthetic-key-from-command"` | `"!printf synthetic-key-from-command"`（**命令串**） | `"synthetic-key-from-command"`（**执行结果**） | ❌                         |
| `"$SYNTHETIC_ENV_KEY"`                 | `"$SYNTHETIC_ENV_KEY"`（**模板串**）                 | `"synthetic-env-value"`（**插值结果**）        | ❌                         |
| `"${SYNTHETIC_ENV_KEY}"`               | `"${SYNTHETIC_ENV_KEY}"                              | `"synthetic-env-value"`                        | ❌                         |
| 字段缺失（只有 `type`）                | `{"type":"api_key"}`                                 | `{"type":"api_key"}`                           | ✅（但两者都**没有 key**） |

⇒ **判定"配了 key"不能只看 `readStoredCredential` 返回了条目**。`!command` 与 `$VAR` 两种形态下，`readStoredCredential` 会给出"看起来配了、实际拿不到可用 key"的假阳性。

### 2.3 `provider-keys.json` 的多 key 轮换：pi 看不到，也不存在

- pi 的凭据模型是**一个 provider 一条凭据**：`CredentialStore` 文档明写 _"one credential per provider"_（`pi-ai/dist/auth/types.d.ts:42-49`），`AuthStorage.modify` 是整条替换（`dist/core/auth-storage.js:385-402`）。
- 全包无 `activeKeyName` / `keys` 概念（0 命中，§1.4）。
- ⇒ **本仓要判「deepseek 配了 key」，pi 内部根本不存在"多 key 里挑 active 那把"这一步**。`activeKeyName` 是用户自建文件的字段，与 pi 无关。

### 2.4 公开 API 的边界（决定实现路径）

| 想要的能力                                        | 有没有公开 API                                                                                                                              | 出处                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 读 auth.json 原始条目                             | ✅ `readStoredCredential`（根导出）                                                                                                         | `dist/index.d.ts:4`                                              |
| 拿 agent 目录路径                                 | ✅ `getAgentDir`（根导出）                                                                                                                  | `dist/index.d.ts:2`；`dist/config.js:491-497`                    |
| 拿 auth.json 路径                                 | ❌ `getAuthPath` **未从根导出**（实测 `typeof pi.getAuthPath === "undefined"`）；它在 `dist/config.d.ts:112`，实现 `dist/config.js:507-509` | 实测 + 声明                                                      |
| 拿**已解析**的 key                                | ⚠️ `ModelRuntime` 根导出，`getAuth(providerId)` 返回解析后的 `{auth:{apiKey}}`；但 `AuthStorage` 本身**未从根导出**（0.80.8 起移除）        | `dist/index.d.ts`（`ModelRuntime`）；`CHANGELOG.md:1323`         |
| 深路径 import `dist/core/resolve-config-value.js` | ❌ 包的 `exports` 只暴露 `.` 与 `./rpc-entry`                                                                                               | `package.json` `exports`（实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`） |
| 扩展直接向 pi 要凭据                              | ❌ `ExtensionAPI` 无任何 ModelRuntime / 凭据访问器                                                                                          | `dist/core/extensions/types.d.ts`（`ExtensionAPI` 成员清单）     |

⇒ **`resolveConfigValue` 没有公开出口**。想复用 pi 的解析语义，只能：(a) 自己复刻三种形态；(b) 用 `ModelRuntime.getAuth()` 让 pi 自己解析。

`ModelRuntime` 路线的实测代价（合成目录，`refreshOnCreate:false`）：`import` 464ms（一次性）、`ModelRuntime.create()` **10ms**、`getAuth()` **0ms**、heap 33MB。可行，但它**只对 pi 已知的 provider 有效**——实测 `getAuth("literalprov")`（只写在 auth.json、pi 不认识的 provider）返回 `undefined`，`getAuth("deepseek")` 正常返回已解析的 key。

> ⚠️ 另注：`ModelRuntime.getProviderAuthStatus("deepseek")` 在同一探针里返回 `{"configured":false}`，因为 `snapshot.storedProviders` 只在 `runAvailabilityRefresh()` 后才填充（`dist/core/model-runtime.js:189-214, 441-451`），`refreshOnCreate:false` 时快照是空的。**不要用 `getProviderAuthStatus` 当"是否配了 key"的判据**，用 `getAuth()`。

## 3. 版本兼容：`readStoredCredential` 从 0.80.8 起存在

### 3.1 跨版本取证（npm tarball 实测，非记忆）

用 `npm pack` 逐版本解包，grep `dist/index.d.ts`（根导出）与 `dist/core/auth-storage.js`（实现）：

| pi 版本                                | 根导出 `readStoredCredential` | `dist/core/auth-storage.js` 里有定义 | 签名 / 实现                                                                                                                       |
| -------------------------------------- | ----------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **0.80.7**                             | ❌ 无                         | ❌ 无                                | ——                                                                                                                                |
| **0.80.8**                             | ✅ 有                         | ✅ 有                                | `readStoredCredential(providerId, authPath = join(getAgentDir(), "auth.json"))`；`JSON.parse(readFileSync(...))`（无 `stripBom`） |
| **0.86.0**（本仓 declared floor）      | ✅ 有                         | ✅ 有                                | 同上 + `stripBom(...)`                                                                                                            |
| **0.99.0**（capability floor）         | ✅ 有                         | ✅ 有                                | 同 0.86.0                                                                                                                         |
| **1.3.0**（本仓 dev 依赖，本笔记实体） | ✅ 有                         | ✅ 有                                | 同 0.86.0                                                                                                                         |

首次出现的版本与 CHANGELOG 对得上：`## [0.80.8] - 2026-07-16`（`CHANGELOG.md:1313`）的 Breaking Changes 首条即 _"…`AuthStorage` and its storage backends are no longer exported; use `ModelRuntime` (or a custom pi-ai `CredentialStore`), or `readStoredCredential()` for one-off reads of auth.json."_（`CHANGELOG.md:1323`）。全 CHANGELOG 里 `readStoredCredential` 只出现在这一行（grep 命中 1 次）。

### 3.2 对本仓的结论

| 本仓约束                          | 值            | `readStoredCredential` 是否可用 |
| --------------------------------- | ------------- | ------------------------------- |
| `peerDependencies` declared floor | **>= 0.86.0** | ✅ **可用**（0.86.0 > 0.80.8）  |
| capability floor                  | **0.99.0**    | ✅ 可用                         |
| dev 依赖                          | 1.3.0         | ✅ 可用                         |

⇒ **在本仓声明的版本范围内不需要 fallback。** 若将来把 declared floor 降到 **0.80.8 以下**，fallback 是：`getAgentDir()`（根导出，各版本都在）+ `join(dir, "auth.json")` + 自行 `JSON.parse(readFileSync(...))` —— 也就是把 `readStoredCredential` 的 5 行实现抄一遍。**注意不要用 `getAuthPath()`**：它没从根导出（§2.4）。

### 3.3 agent 目录不是硬编码路径

`getAgentDir()` 会读环境变量 `PI_CODING_AGENT_DIR`（`dist/config.js:476, 491-497`；`ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`），官方文档同口径（`docs/configuration.md:9`）。⇒ **任何自己拼路径的实现都必须走 `getAgentDir()`，不能写死 `~/.pi/agent`。**

## 4. 「配了 key」的判定口径

### 4.1 凭据类型：只有两种

```ts
// pi-ai/dist/auth/types.d.ts:15-32
export interface ApiKeyCredential {
  type: "api_key";
  key?: string;
  env?: ProviderEnv;
}
export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
} // access/refresh/expires
export type Credential = ApiKeyCredential | OAuthCredential;
```

`auth.json` 的逐条校验规则（`dist/core/auth-storage.js:187-210`）：

| `type`    | 合法字段                                               | 校验                                      |
| --------- | ------------------------------------------------------ | ----------------------------------------- |
| `api_key` | `key?: string`、`env?: Record<string,string>`          | `key` 可缺省；`env` 的每个值必须是 string |
| `oauth`   | `access: string`、`refresh: string`、`expires: number` | `expires` 必须有限                        |

**没有第三种类型**（没有 `radius` 这种 credential type；`radius` 是 `models.json` 里 provider 级的 `oauth: "radius"` 配置，`schemas/models.schema.json:35-38`，与凭据类型无关）。`AuthType` 也只有 `"api_key" | "oauth"`（`pi-ai/dist/auth/types.d.ts:96-98`）。

### 4.2 四种容易踩的边界

| 情形                                                                    | `readStoredCredential` 返回 | pi 内部实际能否拿到 key                                                                                            | 判定                                                           |
| ----------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `type: "api_key"` + 非空字面量 `key`                                    | 条目                        | ✅ 能                                                                                                              | **已配置**                                                     |
| `type: "api_key"` + `key` 是 `!command` 且命令成功                      | 条目（命令串）              | ✅ 能（执行结果）                                                                                                  | **已配置**（但 `readStoredCredential` 单独判会误判为"未解析"） |
| `type: "api_key"` + `key` 是 `!command` 但命令失败 / 输出为空           | 条目（命令串）              | ❌ **拿不到**（`resolveConfigValue` 返回 `undefined`）→ 内置 provider 回落环境变量；无内置的 provider 直接判未配置 | **未配置**（`readStoredCredential` 单独判会误判为"已配置"）    |
| `type: "api_key"` 但**没有** `key` 字段                                 | `{"type":"api_key"}`        | ❌ 拿不到（内置 provider 回落环境变量；无内置的 provider 未配置）                                                  | **未配置**（条目存在 ≠ 配了 key）                              |
| `type: "oauth"`                                                         | oauth 条目                  | ❌ deepseek 无 oauth handler → `resolveProviderAuth` 返回 `undefined`（`pi-ai/dist/auth/resolve.js:26-28, 33`）    | **未配置**（对搜索而言）                                       |
| auth.json **无该 provider 条目**，但 `models.json` 有 `deepseek.apiKey` | `undefined`                 | ✅ 能                                                                                                              | **已配置**（`readStoredCredential` 单独判会误判为"未配置"）    |
| auth.json **无该 provider 条目**，但 `DEEPSEEK_API_KEY` 在环境变量      | `undefined`                 | ✅ 能                                                                                                              | **已配置**（同上，误判）                                       |

### 4.3 判定口径（结论）

**「配了 key」= 能拿到一个非空字符串的 key**，而不是"条目存在"。具体三步：

1. **来源判定**：`auth.json` 的 `deepseek` 条目（`type === "api_key"`）→ `models.json` 的 `providers.deepseek.apiKey` → 环境变量 `DEEPSEEK_API_KEY`。
2. **解析**：按 pi 同款语义解析该值 —— `!` 前缀 → 执行命令取 stdout；`$VAR`/`${VAR}` → 读环境变量（`credential.env` 同名项优先）；否则按字面量。**解析失败（空 / 非零退出 / 超时 / 变量不存在）= 未配置。**
3. **取值**：解析结果必须是**非空字符串**。

## 5. 泄露面清单

### 5.1 `models.json` 的 `apiKey` 可以是明文字面量

- schema 允许：`apiKey: Type.String({ minLength: 1 })`（`dist/core/model-config.js:57`；`schemas/models.schema.json:27-30`）。
- pi **不为 agent 目录写 `.gitignore`**（全包检索 `gitignore` 只命中 grep/find 工具的说明文本）。
- 默认 agent 目录在 `~/.pi/agent/`（仓库外），但 **`PI_CODING_AGENT_DIR` 可以把它指到仓库里**（`dist/config.js:476, 491-497`）→ 那时 `auth.json` / `models.json` 的明文 key 会**直接进 git**。
- 本机实测权限：`auth.json` / `models.json` / `provider-keys.json` / `models-store.json` 均为 `-rw-------`（0600）；pi 写 auth.json 时也强制 0600（`dist/core/auth-storage.js:27` `AUTH_FILE_WRITE_OPTIONS`）。

### 5.2 `!command` 的**命令原文**会进错误消息

```js
// dist/core/resolve-config-value.js:199-218
export function resolveConfigValueOrThrow(config, description, env) {
    ...
    if (reference.type === "command") {
        throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
    }
```

⇒ 若用户把 key 内联在命令里（如 `!sh -c 'echo sk-xxx'`），**key 原文会出现在异常消息**里 → 进日志、进 UI、进错误文案。本机的 `!command` 只引用文件路径、不内联 key，属于安全写法；但这是**用户配置决定的**，我们的实现要保证**自己的**错误文案永不含 key。

### 5.3 `before_provider_headers` 事件把完整请求头交给任意扩展

```ts
// dist/core/extensions/types.d.ts:698-705
/**
 * Fired after request headers are assembled, before the provider HTTP call.
 * Handlers mutate `headers` in place ...
 */
export interface BeforeProviderHeadersEvent {
  type: "before_provider_headers";
  headers: ProviderHeaders;
}
```

发射点：`dist/core/sdk.js:207`（`headerRunner.emitBeforeProviderHeaders(headers ?? {})`）。当 provider 配了 `authHeader: true` 时，`Authorization: Bearer <key>` 是**显式 header**（`dist/core/provider-composer.js:212-220`），会被完整交给处理器。

⇒ **同进程里的任何 pi 扩展都能读到 provider 的 key**。我们自己的扩展**不要订阅这个事件**，也不要在任何事件处理里打印 headers。

### 5.4 pi 不会把 key 放进环境变量（但扩展读得到环境里的 key）

- 全量检索 `process.env.<NAME> =`：pi 只写 `PI_CODING_AGENT` / `AI_AGENT`（`dist/cli/setup.js:5-6`）、`PI_OFFLINE` / `PI_SKIP_VERSION_CHECK`（`dist/main.js:457-458`）；pi-ai **零**写入。⇒ **pi 从不把凭据导出到环境变量**。
- 本仓 `WORKER_ENV_ALLOW_LIST`（`src/runtime/limits.ts:147-154`）只放行 `PATH`/`PATHEXT`/`SYSTEMROOT`/`WINDIR`/`TEMP`/`TMP` ⇒ key 类环境变量确实**进不了 PTC worker**。
- ⚠️ 但反过来：**我们的扩展跑在 host 进程里，`process.env.DEEPSEEK_API_KEY` 对它是可见的**。这意味着「只从 auth.json 取 key」这个实现选择，**天然漏掉了环境变量这条真实存在的能力路径**（§1.3 第 ④ 级）。这是**取舍**，不是漏洞：环境变量路径意味着 key 来自 CI / shell 环境，而 §4.3 的口径把环境变量列为来源之一。

### 5.5 聊天原文落 session jsonl

pi 的会话记录存整段对话（`~/.pi/agent/sessions/**/*.jsonl`）。本机实测这些 jsonl 里出现了 `provider-keys` 字样 —— 说明**聊天文本会落盘**；若用户在对话里粘贴过 key，它就会留在 session 文件里。⇒ 实现里**永远不要把 key 回显进工具结果 / 工具描述 / notify 文案 / 异常**，因为工具结果会进对话、会进 session。

### 5.6 会话记录不持久化请求头（弱证据）

`dist/core/session-manager.js` 检索 `headers` 只命中一条与 header 无关的注释 ⇒ 推断 pi 不把 provider 请求头写进 session。**标注为推断**（检索未命中不等于必然没有），不作为强结论。

### 5.7 泄露面速查

| 面                               | 会不会泄 key                     | 证据                                                              |
| -------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| `auth.json` 明文                 | 会（磁盘），但权限 0600          | `dist/core/auth-storage.js:27`；本机 `ls -l` 实测                 |
| `models.json` 的 `apiKey` 字面量 | 会（磁盘）；指进仓库时**进 git** | `dist/core/model-config.js:57`；`dist/config.js:476`              |
| `!command` 解析失败的错误消息    | 会（含**命令原文**）             | `dist/core/resolve-config-value.js:206`                           |
| `before_provider_headers` 事件   | 会（交给同进程任意扩展）         | `dist/core/extensions/types.d.ts:702-705`；`dist/core/sdk.js:207` |
| `process.env`（pi 侧写入）       | 不会                             | 全量 grep `process.env.X =`（§5.4）                               |
| PTC worker 环境                  | 不会（被 allow-list 挡住）       | `src/runtime/limits.ts:147-154`                                   |
| session jsonl（对话原文）        | 会（若 key 曾进对话）            | `~/.pi/agent/sessions/**/*.jsonl` 实测含 `provider-keys` 字样     |
| pi 自己的 console/log            | 未见                             | grep `console.*(apiKey                                            | Authorization | bearer)` 无命中（弱证据） |

## 6. 错配组合的行为（机器级凭据 × 用户级开关）

开关是用户级的（`~/.pi/agent/ptc.json`，本仓已有读取器：`src/mode/ptc-mode.ts:76` `PTC_MODE_CONFIG_FILE = "ptc.json"`）；凭据是机器级的（`~/.pi/agent/auth.json`）。四种组合：

| 组合                                                           | `readStoredCredential("deepseek")` | pi 内部路径                                                           | 门禁应当表现（设计基线）                                                                  |
| -------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **开关关 + 机器有 key**                                        | 返回条目（key 已进内存）           | 不用（不发请求）                                                      | **工具不注册**。且**应当完全不读凭据文件** —— 开关关时读 key 没有收益，只增加泄露面（§5） |
| **开关关 + 机器无 key**                                        | `undefined`                        | 不用                                                                  | 同上，无差别                                                                              |
| **开关开 + 机器有 key**（auth.json 有 `api_key` 条目且可解析） | 返回条目                           | `AuthStorage.read` 解析出 key → 可用                                  | **工具注册 + 可用**                                                                       |
| **开关开 + 机器无 auth.json 条目**                             | `undefined`                        | 回落 `models.json.apiKey` → 再回落 `DEEPSEEK_API_KEY`；都没有则未配置 | **工具注册 + 标注不可用 + 启动告警一次**                                                  |

**两个必须写进 spec 的错配细节**：

1. **开关关时不要读凭据**。门禁的短路点应在"读凭据"之前 —— 否则 §5.3/§5.5 的泄露面在一个用户根本没开搜索的机器上也被打开。
2. **"缺 key"要按 §4.3 的三步判，不能按"条目在不在"判**。否则这三种情况会被误判：
   - auth.json 无 deepseek 条目、但 `DEEPSEEK_API_KEY` 在环境里 → 实则可用，误判为缺。
   - auth.json 条目在、但 `key` 是失败的 `!command` → 实则不可用，误判为已配。
   - auth.json 条目是 `oauth` → 对搜索不可用，误判为已配。

## 7. 给实现者的建议口径

> **判定口径（可直接写进 spec）**：「deepseek 已配置」当且仅当能从 **`auth.json` 的 `deepseek` 条目**（`type === "api_key"` 且按 pi 同款语义解析出的 `key` 是**非空字符串**）或 **`models.json` 的 `providers.deepseek.apiKey`**（同样解析）或 **`DEEPSEEK_API_KEY` 环境变量**（非空字符串）中取到**至少一个**非空字符串；三条都取不到、或取到的条目是 `oauth`、或 `key` 缺失、或 `!command`/`$VAR` 解析失败，一律判为**未配置**。

实现要点（逐条对应上文出处）：

1. **短路顺序**：开关关 → **不注册工具、不读任何凭据文件**（§6）。
2. **解析要复刻 pi 的三种形态**（`!command` / `$VAR`/`${VAR}` / 字面量），因为 `readStoredCredential` 不解析（§2.2），而 `resolveConfigValue` 没有公开出口（§2.4）。`!command` 的执行语义照 `dist/core/resolve-config-value.js:172-188`（stdout trim、空即 undefined、10s 超时、进程内缓存）。
   - **替代方案**：用根导出的 `ModelRuntime` + `getAuth("deepseek")` 让 pi 自己解析（实测 10ms 建实例、返回已解析 key），但**它只对 pi 已知的 provider 有效**，且**不要用 `getProviderAuthStatus`**（快照未刷新时会假阴性，§2.4）。
3. **路径走 `getAgentDir()`**，不写死 `~/.pi/agent`（`PI_CODING_AGENT_DIR` 可改，`dist/config.js:476, 491-497`；`getAuthPath()` 未根导出）。
4. **绝不把 key 写进**：工具描述、工具结果、`ctx.ui.notify` 文案、异常消息、日志、任何 git 追踪的文件（§5）。§5.2 是 pi 自己的反面教材（错误消息带命令原文）。
5. **不要订阅 `before_provider_headers`**（§5.3）。
6. **缺 key 的表现**：工具**注册**但标注不可用 + **启动告警一次**（沿用本仓 `ctx.ui.notify(..., "warning")` 既有写法，`src/index.ts:817, 830`），文案只说"缺 deepseek 凭据、搜索不可用"，**不回显 key 或路径内容**。
7. **机器级 vs 用户级**：这里的"机器级"指**与本仓开关无关的那份配置**（`~/.pi/agent/auth.json`，随 pi 安装存在、不随本仓开关变化；它本身仍是当前 OS 用户的 home 目录文件，不是跨用户共享），"用户级"指本仓自己管的 `~/.pi/agent/ptc.json`。两者**同目录不同文件**，所以"用户开了开关但机器没配 key"是常态而非异常，§6 表格按此设计。

## 8. 未核实清单

| #   | 未核到的点                                                                          | 为什么                                                                                                                                                 | 影响                                                                                              |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | `readStoredCredential` 的**上游首次引入 commit / PR 号**                            | `gh api search/commits` 对 `earendil-works/pi` 返回 0（该仓库未被 commit 搜索索引，连已知符号也 0）；本笔记改用 npm tarball 逐版 grep + CHANGELOG 佐证 | 版本结论（0.80.8）有 tarball 与 CHANGELOG 双证据，**结论不依赖 commit**                           |
| 2   | `provider-keys.json` 的**作者与用途**                                               | 它不是 pi 的文件，是用户自建；本笔记只能证明"pi 不读它、它经 `models.json` 的 `!command` 被引用"                                                       | 对 deepseek 无影响（§1.4）；但若将来要支持多 key 轮换，需自己读这个格式（属新需求，不在本票范围） |
| 3   | pi 在 **0.80.8 之前**（≤0.80.7）是否有别的等价 API                                  | 只验证了"0.80.7 无 `readStoredCredential`"；`AuthStorage` 当时可能从根导出                                                                             | 不影响：declared floor 0.86.0 > 0.80.8                                                            |
| 4   | `!command` 执行时的**stderr / 退出码**是否进日志                                    | 只读到 `stdio: ["ignore","pipe","ignore"]`（`resolve-config-value.js:138` / `:163`），未追到 pi 的日志管道                                             | 低：stderr 被丢弃，不进日志                                                                       |
| 5   | session 是否**绝对不**持久化请求头                                                  | 只做了 grep 未命中（§5.6），未逐字段追 session 序列化                                                                                                  | 标为推断，非结论                                                                                  |
| 6   | DeepSeek Search / Fetch **实际发请求**的鉴权行为                                    | 本票只查凭据面，未调用 API（且复用 deepseek key 去打 `api.deepseek.com` 属于另一票范围）                                                               | 无影响（见同日笔记 `deepseek-search-api-20261020.md`）                                            |
| 7   | `ModelRuntime.getAuth()` 在 **pi 扩展进程**里的行为（本次是在独立 node 进程里探的） | 未在真实 pi 扩展宿主里跑过                                                                                                                             | 若选这条实现路线，需补一次宿主内验证                                                              |

## 9. 快照与复核命令

**快照**

| 项                                  | 值                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库 HEAD                           | `64de4bd`（`git log --oneline -1`）                                                                                                          |
| pi 安装实体                         | `@earendil-works/pi-coding-agent@1.3.0`（`node_modules/`，本仓 dev 依赖）                                                                    |
| pi-ai 安装实体                      | `@earendil-works/pi-ai@1.3.0`（pi 的传递依赖）                                                                                               |
| pi declared floor                   | `>=0.86.0`；capability floor `0.99.0`                                                                                                        |
| 本机 agent 目录                     | `~/.pi/agent/`（`PI_CODING_AGENT_DIR` 未设置）                                                                                               |
| 本机 `auth.json` 条目（**不含值**） | `deepseek` → `api_key`（key 长 35）；`minimax-cn` → `api_key`（key 长 125）；`kimi-coding` → `oauth`（access/refresh/expires + 模型元数据）  |
| 本机 `models.json`                  | `providers["minimax-cn-512k"].apiKey` = `!command`（引 `provider-keys.json`）；`providers["minimax-cn"]` 无 `apiKey`；**无 `deepseek` 条目** |
| 本机 `provider-keys.json`           | `deepseek` / `minimax-cn` 各一条，`activeKeyName` = 「密钥 1」，`keys` 仅 `"0"` 一项（**pi 不读此文件**）                                    |
| 本机相关文件权限                    | `auth.json` / `models.json` / `provider-keys.json` / `models-store.json` 均 `0600`                                                           |

**复核命令**（在 `pi-ptc-subagents` 根目录执行）

```bash
# §1 / §2 源码事实
P=node_modules/@earendil-works/pi-coding-agent
A=node_modules/@earendil-works/pi-ai
sed -n '420,432p' $P/dist/core/auth-storage.js       # readStoredCredential
sed -n '376,384p' $P/dist/core/auth-storage.js       # AuthStorage.read（解析 key）
sed -n '280,305p' $P/dist/core/provider-composer.js  # 合成 provider 的 resolve 分支
sed -n '14,39p'   $A/dist/auth/resolve.js            # resolveProviderAuth 优先级
sed -n '8,25p'    $A/dist/auth/helpers.js             # envApiKeyAuth（存储凭据优先于环境变量）
grep -rn "provider-keys\|activeKeyName" $P/          # 应为 0 命中

# §1.4 agent-dir 官方文件表（无 provider-keys.json）
sed -n '9,24p' $P/docs/configuration.md

# §3 跨版本取证
npm view @earendil-works/pi-coding-agent versions --json
PROBE=$(mktemp -d) && cd "$PROBE"
for V in 0.80.7 0.80.8 0.86.0 0.99.0; do
  mkdir -p "v$V" && cd "v$V" && npm pack "@earendil-works/pi-coding-agent@$V" --silent >/dev/null
  tar -xzf *.tgz && printf "%-8s root-export=%s\n" "$V" "$(grep -c readStoredCredential package/dist/index.d.ts)"
  cd ..
done
grep -n "^## \[0.80.8\]" $P/CHANGELOG.md        # 1313
grep -n "readStoredCredential" $P/CHANGELOG.md   # 1323（唯一一处）

# §2.4 公开 API 边界
node --input-type=module -e "
const pi = await import('@earendil-works/pi-coding-agent');
console.log('readStoredCredential:', typeof pi.readStoredCredential);
console.log('getAgentDir:', typeof pi.getAgentDir);
console.log('getAuthPath:', typeof pi.getAuthPath);   // undefined（未根导出）
"

# §5.4 pi 不把凭据写进环境变量
grep -rnE "process\.env\.[A-Za-z_][A-Za-z0-9_]* *=[^=]" node_modules/@earendil-works/pi-coding-agent/dist --include=*.js \
  | grep -v "===" | grep -v bundle            # 只应有 PI_CODING_AGENT / AI_AGENT / PI_OFFLINE / PI_SKIP_VERSION_CHECK

# §5.3 扩展事件面
grep -n -A5 "BeforeProviderHeadersEvent" $P/dist/core/extensions/types.d.ts
grep -n "emitBeforeProviderHeaders" $P/dist/core/sdk.js

# §6 本机配置（只打印结构，不打印 key 值）
node -e "
const fs=require('fs');
for (const [f,p] of [['auth.json','deepseek'],['models.json',null]]) {
  const d=JSON.parse(fs.readFileSync(process.env.HOME+'/.pi/agent/'+f,'utf8'));
  console.log(f, JSON.stringify(d, (k,v)=> k==='apiKey'||k==='key' ? '<REDACTED len='+String(v).length+'>' : v));
}
"
```

> 本笔记未记录任何真实密钥值；上表与正文只出现条目名、字段名、长度与文件权限。
