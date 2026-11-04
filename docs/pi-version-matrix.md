# pi 版本兼容矩阵（重写版）

floor = **0.86.0**（`peerDependencies: ">=0.86.0"`），ceiling = 跟踪最新（当前 1.5.0，类型固定在 devDependencies）。
本文件是旧仓 `docs/agents/pi-compat-matrix.md` 实测结论（15 版本逐一安装探针，2026-10-14/20 两次测量）的继承 + 1.4.0 / 1.5.0 增补。**断言 pi 行为前先看本机 `pi --version`**——node_modules 里的版本、PATH 上的版本、声明的 floor 是三个不同的数。

## 能力分水岭：0.99.0

以下能力全部在 **0.99.0 出现**，0.99.0 以下一律没有（旧 ADR 写「1.0.0 起」是测量点，不是出现点）：

| 能力                                                         | <0.99.0（含 floor）                          | ≥0.99.0                      |
| ------------------------------------------------------------ | -------------------------------------------- | ---------------------------- |
| `ToolDefinition.outputSchema` / `exposure` / `defaultActive` | 类型缺失，**运行时被忽略**（注册即面向模型） | 完整支持                     |
| `AgentToolResult.isError` 通道                               | 无，失败靠 throw                             | 有                           |
| `structuredContent` 转发给 codemode 脚本                     | 无                                           | 有                           |
| codemode 本体 / MCP 自动激活 codemode                        | 无                                           | 有                           |
| **程序内调会话工具（`ctx.executeTool`）**                    | **无**（0.86/0.87 没有嵌套工具调用通道）     | 有（`ExtensionToolContext`） |

**floor 0.86.0 的运行时含义**（不是缺陷，是「pi 不提供这个 API」）：

- `exposure` 被忽略 → 我们的 codemode 门在 floor 上**压根不注册**（门控在注册之前：`surface` 判定不
  含 `codemode` → 不调 `registerTaskDoor`），floor 上模型看不见它（比「可见」更安全）
- codemode 不存在 → 门注册后无从被脚本调用（无 codemode surface）
- 失败工具 throw 而不是 isError → 调用方 try/catch 语义两版都要

## 1.x 增量（对本的包有意义的）

- **1.0.0**：`-builtin:<name>` 可禁内置扩展；`registerToolRenderer` API
- **1.1.0**：扩展 pattern 过 `normalizePath`（tilde/file://）；codemode 声明 `reachesTools`；`-p` 截断响应 exit 1；发布版 settings schema；**`--no-mcp` CLI 旗标首现（0.86–1.0 无，孩子的减量 argv 按它门控）**
- **1.2.0 / 1.3.0**：对我们无行为变化（16 项能力探针两版全 ✓，codemode switch 差分 40 案例一致）
- **1.4.0（2026-10-21，本矩阵新增，旧仓未测）**：
  - **codemode 满员改为排队等**（最长 60s，`PI_CODEMODE_MAX_WORKERS` 调上限）——与我们的 libuv 式准入队列方向一致
  - **#11062 恢复会话/分支时扩展工具默认激活**（除非 `defaultActive: false`）——影响 task face 的可见性设计
  - 摘要不再受固定输出上限（compaction 修复）；`before_provider_headers` 归因头变化（我们不碰）
  - **message_end usage 带 `cacheRead` / `cacheWrite` / `cacheWrite1h`**（jsonl 观测面已接；旧版缺省 undefined，floor 安全）
    —— ⚠️ **2026-10-31 更正**：这不是 1.4.0 新增，**floor 0.86.0 的 usage 就已带 `cacheRead`/`cacheWrite`**
    （floor 实测 `usage={input,output,cacheRead,cacheWrite,totalTokens,cost{…total},cacheWrite1h}`）
- **1.5.0（2026-11-02，本矩阵新增）**：**扩展 API 面无破坏**（`types.d.ts` 只加不改）——详见下面「pi 1.5.0 适配」一节
  - **唯一的 Breaking**：工具参数校验改走 `@earendil-works/pi-schema`——TypeBox 里 JSON Schema 之外的东西
    （`Type.Refine()` / `Type.BigInt()` / `Type.Undefined()` / codec / `Format.Set()`）**不再作用于工具参数**
    ⇒ **我们的工具 schema 全是纯 JSON Schema**（`Type.Object`/`String`/`Number`/`Boolean`/`Optional`/`Union`/
    `Literal`/`Array`/`Record`/`Integer`）**⇒ 零影响**；反过来纯 JSON Schema 的工具（含 MCP 工具）现在也吃
    同一套强制转换（数字字符串 → 数字、单值 → 数组）⇒ 只赚不亏
  - 扩展包可以自带 changelog：pi 读包 `package.json` 的 `pi.changelogPath` 或包根的 `CHANGELOG.md`，
    更新后下次冷启动在「Extension Updates」里显示——**与我们自己的升级提示（widget 区）并行，不冲突**
  - 其它新增（keybinding 提示函数、`ctx.ui.custom` 的 `blocked`、`Usage.cost.totalFromProvider`、
    `pi.exec()` 的 `maxBuffer`、自更新命令、GPT-6.1、渲染提速）**都不碰我们的面**
  - **系统提示词收紧**（pi 自称）⇒ 孩子系统提示词实测变短：1.4.0 是 4600 字符，1.5.0 是 4141 字符
    （我们注入的那节长度不变，仍省 744）

## 硬约束（重写仍然成立的事实）

- pi **无 unregisterTool**：撤工具 = 同名重注册 `exposure: "hidden"`（`registerTool` 是 Map.set）；声明集每个模型请求重算，下一 turn 才生效 → `/ptc off` 的同 turn 窗口靠 `dispatch()` 里的闸接（纵深防御）
- factory 阶段的 `getAllTools()`/`getActiveTools()` 是 `notInitialized` 桩 → **注册必须发生在 `session_start`**（旧 ADR-0035）
- `ctx.ui.notify` 在 `-p`/`json` 模式下是 no-op
- pi 的**两个 settings 文件由两个不同函数解析**（项目侧位置优先、用户侧固定顺序），任何镜像都有 two-functions 陷阱——不要再写镜像，session_start 直接问 pi

## 实测增补（2026-10-26，本重写分支）

- **真 pi 冒烟：1.4.0 与 floor 0.86.0 各一次全过**（2026-10-26）：`-ne -e packages/entry/dist/index.js` 隔离；`ptc_run_code` 求值 `6*7` → 42；程序内 `tools.pi_task_ptc({wait:true})` 建真子进程并回收报告（floor 用 `PATH=/tmp/pi086/node_modules/.bin:$PATH` shim，让子进程也跑 0.86）。floor 上 `loadSkills/formatSkillsForPrompt/getAgentDir` 导出齐备（静态 import 可加载）。
- **0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3 冒烟（2026-10-26）**：每版跑真 pi 一次——`ptc_run_code` 求值 42 全过；派发用例抽测 **0.87**（分水岭前，报告走 prompt-json 兜底）/ **0.99**（分水岭，tool 通道首选）/ **1.3**（最新前一版），均 `fulfilled` + 产出 `ok`。同一 minor 内的补丁版（0.87.1、0.99.1/2、1.0.1–4）未单独安装——改动面按 minor 分水岭取样。
- floor 上报告通道走 prompt-json 兜底（`structuredContent` <0.99 不存在），结果正常；tool 通道的 floor 形状未单独取证。
- **exposure 传函数（getter）在 1.4.0 不被支持**：隔离探针（`-ne` 只加载探针扩展）翻转标志位后，工具仍不出现在声明集。动态可见性须走 `defaultActive: false` + `setActiveTools` 增删（可调用性实测有效；是否同步进模型声明清单未确证）。
- 冒烟隔离：`pi -ne -e <path>`——本机全局装有旧版 `npm:pi-ptc-subagents`，不加 `-ne` 会同名互踩（registerTool 是 Map.set，后注册者覆盖）。

## 程序内调工具的通道位置（2026-10-26 实测，逐版本矩阵）

- **通道在工具执行上下文**：`ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)`
  的第 5 个参数是 `ExtensionToolContext`，它的 `executeTool(name, args, options?)` 才是程序内
  调会话工具的入口。`session_start` 的 `ExtensionContext` 上没有它。
- **0.86 / 0.87 没有这条通道**（全包里搜不到 `executeTool`）：程序仍可求值、可派发子任务，
  且 **2026-11-01 起文件类调用改用 pi 自造的工具**（pi 公开导出的 `create*ToolDefinition(cwd)` 工厂，
  那些 `execute` 独立于 agent 循环）——`read` / `write` / `edit` / `grep` / `ls` / `find` 照常可用，
  参数形状与 ≥0.99 逐字一致。**这条路有版本门**：只在 pi < 0.99 开放，现代 pi 上认不出通道是异常 ⇒ 报错
  （详见下面「floor 自造工具加版本门」一节）。
- 工具执行上下文的位置随版本变（1.4.0 是第 5 个参数，更早是第 3 个）——实现按「哪个参数带
  `executeTool`」认，不写死位置。
- **pi 1.4.0 的可调用集 = active 的 direct 工具 + codemode/deferred 工具**：从活跃表里收窄
  内置工具，会让程序也调不到它们（`Tool read not found`）。内置工具的 exposure 不是扩展能设的，
  所以「模型看不见内置工具」与「程序能调内置工具」不可兼得——PTC 模式因此改为引导层。

### 逐版本实测（2026-10-26，兼容区间 16 个版本全跑）

> 评审修复后（2026-10-26 晚）同口径复跑一遍：**16/16 与上表逐字一致**——floor 四版仍是明确的
> 版本错误，其余 12 版仍是 `OK:295`。

| pi 版本                                                                                          | 程序内 `tools.read`                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.86.0 · 0.86.1 · 0.87.0 · 0.87.1                                                                | ✗ 平台没有嵌套调用通道 → 明确报错「需 pi ≥ 0.99」                                                                                                                            |
| 0.99.0 · 0.99.1 · 0.99.2 · 1.0.0 · 1.0.1 · 1.0.2 · 1.0.3 · 1.0.4 · 1.1.0 · 1.2.0 · 1.3.0 · 1.4.0 | ✓ 程序读 `/etc/hosts` 拿到 295 字符（结果统一成文本）                                                                                                                        |
| 1.5.0（2026-11-03）                                                                              | ✓ 程序内 read 走会话工具仍通（真机 `READ=2436`，读 `package.json` 的长度）；`/etc/hosts` 越界读取**静态同构**（`dist/core/tools/path-utils.js` 与 1.4.0 逐字相同）⇒ 行为不变 |

### 引擎抽出后复跑（2026-11-01）

> `packages/ptc` 拆成「引擎 + 模型面」（模型面搬进 `packages/entry`，fs 四件套绑定搬进 ptc，
> 引擎零依赖零宿主）后，同口径全量复跑：**16/16 全过，fails=0**——floor 四版当时的 `tools.read`
> 仍是明确的版本错误（`ERR:此 pi 版本没有程序内调用工具的通道（需 pi ≥ 0.99）`，**扩展不崩，
> 只是那条调用失败**），0.99.0–1.3.0 与 PATH 1.4.0 是 `RUN=42` / `READ=2216`（读 `package.json`
> 的长度）/ `PAR=2` / 任务面 handle 非空。

### floor 退回绑定（2026-11-01，同日第二轮）

> floor 四版的**文件类**调用先改成**退回宿主中立的文件绑定**（`createFsBindings`：`node:fs` 底 +
> workdir realpath 锁）——`read` / `write` / `grep` / `edit` 照常可用。改动只在 `packages/entry`
> 的绑定表，**引擎一行没动**。⚠️ 但这版留了个**契约分叉**：pi 的 edit 是
> `{path, edits:[{oldText,newText}]}`（驼峰），文件绑定是 `{path, old_string, new_string}`
> （蛇形）——为 ≥0.99 写的程序到 floor 上 `tools.edit` 会坏。

### floor 用 pi 自造工具（2026-11-01，同日第三轮，取代上一轮）

> floor 上 pi 的**工具工厂是公开导出**（`create*ToolDefinition(cwd)`，0.86.0 / 0.86.1 / 0.87.0 /
> 0.87.1 与 1.4.0 全有），返回带 `execute` 的完整 ToolDefinition；那些 `execute` **独立于 agent
> 循环**（只用 `ctx?.cwd || cwd`，ctx 可缺省）⇒ floor 改为**自己造出 pi 的真工具来调**。
>
> **程序工具集与形状与 ≥0.99 逐字一致**：`read` / `write` / `edit` / `grep` / `ls` / `find`
> （`bash` 是 opt-in，从未在程序绑定表里），`edit` 用 pi 的 `{path, edits:[{oldText,newText}]}`。
>
> 直接调 `execute` 会跳过管线的两件事：**`prepareArguments` 垫片**（已补：edits 传成字符串/单对象的
> 归一化）与**参数 schema 校验**（未补：管线的 `runToolCall` 做）——参数不合法时由工具自身抛错。

| pi 版本                           | 程序内 `tools.*`                                  |
| --------------------------------- | ------------------------------------------------- |
| 0.86.0 · 0.86.1 · 0.87.0 · 0.87.1 | ✓ pi 自造工具：同一批工具、同一套参数形状         |
| 0.99.0 … 1.3.0 · 1.4.0（12 版）   | ✓ 走 pi 会话工具（`ctx.executeTool`，过工具管线） |

**老版本不再是「更窄的路」**：工具集与参数形状与 ≥0.99 相同，差别只在调用路径（自造 vs 管线）。

**真机冒烟 16/16 全过**（`scripts/version-smoke.sh`，fails=0）：floor 四版的 READ 腿从「`ERR:`」
变成数字 **2216**（读 `package.json` 的长度，与 ≥0.99 逐字相同），其余各腿 `RUN=42` / `PAR=2` /
任务面 handle 非空 / 0 个 `isError:true` 全程不变。

探针口径：真实 pi（隔离 `-ne`），程序里 `try { tools.read({path:"/etc/hosts"}) } catch { 回错误原文 }`，
程序自己回字符串，模型只负责原样转述。

### floor 自造工具加版本门（2026-11-01，同日第四轮）

> 自造工具那条路的判定原本是「这个工具上下文上没有 `executeTool`」——**只看当下认不认得出通道**。
> 问题：未来的 pi 若挪了 `executeTool` 的位置，我们会**悄悄绕过 pi 的工具管线**——别的扩展的
> `tool_call` 钩子拦不到程序发起的调用、用量也不记。改动前是明确报错。
>
> 现在**用版本号把这条路锁在 pi < 0.99**（判定照抄 `packages/dispatch/src/child-process.ts` 的
> `supportsNoMcp` 写法，版本取自 `pi --version`；取不到 → 当作有通道）。现代 pi 上认不出通道 ⇒ 报
> 「此 pi 版本没有程序内调用工具的通道（需 pi ≥ 0.99，binding: …）」。
>
> 顺带删掉了一条**走不到的路**：上一轮先加的「宿主中立文件绑定」退回落（`createFsBindings`）——
> floor 四版都有工具工厂，那条路永远进不去；而且它的 `edit` 形状（`{path, old_string, new_string}`）
> 与 pi 的（`{path, edits:[{oldText,newText}]}`）不同，留着是雷。fs 绑定仍留在 `packages/ptc`，
> 服务 Kimi 面与独立 CLI。
>
> 覆盖：`tests/pi/floor-file-fallback.test.mjs`（用 PATH 上的假 `pi` 脚本控版本，6 个用例：floor 读文件 /
> ls / edit 两种形状 / **现代 pi 缺通道必须报错** / 有通道时仍走会话工具）。
>
> **真机冒烟 16/16 全过**（`scripts/version-smoke.sh`，fails=0）：floor 四版与 ≥0.99 的 `READ=2216`
> 逐字相同——版本门放行自造工具、≥0.99 照旧走会话工具，两条路给模型的形状是同一个。

老版本另有一处语义差异：**0.86/0.87 的 `getActiveTools()` 只含扩展自己的工具**（实测 `["zz_probe"]`），
内置工具只在 `getAllTools()` 里——那两版没有「向模型声明的集合」这个语义，所以绑定作用域退回
「已注册的内置工具」；0.99+ 的 `getActiveTools()` 就是声明集，直接用（`--tools` 收窄也随之生效）。
**退回的判据是「有没有嵌套调用通道」，不是「活跃表里有没有已知绑定名」**（2026-10-26 修订）——
后者在 1.4.0 上也会触发（`--tools` 收窄到只剩扩展工具的会话），于是程序会看到一批调不到的绑定。

## 实测增补（2026-10-27）

- **pi 内置工具无 cwd 囚禁（strict 白名单 ≠ 沙箱）**：`read/grep/find/ls/edit/write` 的路径处理全部只有
  `resolveToCwd`（相对路径拼 cwd，**绝对路径原样放行**）+ 存在性/可读性检查，没有任何
  "路径必须在 cwd 内"的拒绝逻辑。源码在 floor 0.86.0 与 1.4.0 同构（`dist/core/tools/path-utils.js`），
  中间版本由 2026-10-26 的 16 版探针覆盖（`tools.read(/etc/hosts)` 0.99–1.4.0 全过）。
- **两端真机实证（2026-10-27，严格孩子的真实 argv 形状）**：`pi -p --no-session --mode json
  --tools read,grep,find,ls`，cwd 放在 /tmp 子目录，任务 = 读 cwd 之外的 `/etc/hosts`——
  **floor 0.86.0 与 1.4.0 双双成功**（toolResult isError=false，原样回显文件头）。
- 对本包的语义：readOnly `strict` 的真实含义只是「工具白名单收窄（无 bash/edit/write）」，
  **不是目录囚禁**——strict 孩子用绝对路径可读宿主任何可读文件。给孩子的 argv 即便未来接上
  `cwd`，也只是改相对路径落点，不开启新能力。审计发现 F1（任务门 cwd 参数未接线）的分析以此为准。

## 实测增补（2026-10-31，floor 三处考古 + 新旋钮跨版本复测）

> ⚠️ **前提修正**：npm 上的 `pi` 包是 `IonicaBizau/pi-number`（算 π 的数学库，只有 16 个版本、
> 最早 1.0.0、**没有 0.8x/0.9x**）。真包名是 **`@earendil-works/pi-coding-agent`**（61 个版本，
> 0.80.1→2.0.5，0.86.0 = floor，发布于 2026-09-19）。`scripts/version-smoke.sh` 的 shim 自愈此前写的是
> `npm install "pi@$want"` → 装成 pi-number（没有 `pi` 这个 bin）→ `INSTALL-FAIL`——
> **「老版本装不上、floor 考古做不了」是假象**，已修包名。

### floor 0.86.0 真机（`@earendil-works/pi-coding-agent@0.86.0` 实装实跑）

- **我们扩展在 floor 上加载成功**（`-ne -e <entry/dist>` 退出码 0），模型面前的工具 9 个：
  `read / bash / edit / write` + `ptc_task_list / ptc_task_output / ptc_task_stop / ptc_run_code / ptc_workflow`。
  **`pi_task_codemode` 不在其中**（门不注册，见上）；`pi_task_ptc` 本就不是模型面工具（程序内 binding）。
- **floor 的 json 事件形状与 1.4.0 同构**，我们 `parseChildStream` 的假设逐条成立：
  事件类型 = `session / agent_start / turn_start / message_start / message_update / message_end / turn_end / agent_end / agent_settled`；
  assistant `message_end` 的 `content=[{type:"text",text}]`、`usage{input,output,cacheRead,cacheWrite,cost.total}`、
  `model`/`provider` 全部符合。**无需改动**。
- **floor 的 toolResult 消息无 `details` / `structuredContent`**（只有 `content/isError/role/timestamp/toolCallId/toolName`）
  → **工具通道在 floor 上必然拿不到报告**，只走 prompt-json 兜底（与旧结论一致）。
  注意：消息层的 `isError` 有，但**扩展工具返回值里的 `isError` 没有**（floor 的 `AgentToolResult` =
  `content/details/usage?/terminate?`）→ 我们返回的 `isError: rejected` 在 floor 上被忽略。
- **floor 的 `ToolDefinition` 没有 `outputSchema` / `exposure` / `defaultActive`**；`execute` 的第 5 个参数
  是 `ExtensionContext`（1.4.0 是 `ExtensionToolContext`）→ 「通道位置随版本变」成立；
  `dist` 里的 `executeTool` 全是内部函数 `executeToolCalls`，**没有 `ctx.executeTool` 这个 API** → 旧结论成立。
- **floor 有 `setActiveTools` / `getActiveTools`**（旧矩阵未记）→ 任务面可见性设计在 floor 可用。
  但 floor 无 `defaultActive` 字段 → 我们写的 `defaultActive:false` 被忽略 →
  **floor 上 `ptc_task_list/output/stop` 默认对模型可见**（实测在上面那 9 个工具里）；1.4.0 上默认隐藏。
- **「旧实现在 floor 能跑的机制」这条悬案收敛**：floor 上程序内调 pi 内置工具确实不可用（无 `ctx.executeTool`），
  但**我们自己的 binding（`pi_task_ptc`）不依赖它** → floor 的派发走 PTC 门（程序内 binding），实测可用。
  本仓是干净室重写、不抄旧实现 → 这条悬案对本仓**无待办价值**。

### 新旋钮跨版本复测（`scripts/knobs-smoke.mjs`，真机真子进程）

探针断言不靠模型配合（旋钮是引擎/argv 层的）：`timeoutMs` 真收尸 + `projectContext` auto/none
引擎层 A/B（孩子系统提示词节表）+ 报告通道 + usage 兜底（宿主观测值非零）+ **口径事实**
（带上下文必按项目口径算；none 臂只记录不断言——理由见下）。

| pi 版本         | timeoutMs 收尸 | auto 带上下文 | none 不带上下文 | 报告通道 + usage 兜底 | 口径事实 | 孩子系统提示词 auto→none   |
| --------------- | -------------- | ------------- | --------------- | --------------------- | -------- | -------------------------- |
| 0.86.0（floor） | ✓              | ✓             | ✓               | ✓                     | ✓        | 4441 → 3697（省 744 字符） |
| 0.87.1          | ✓              | ✓             | ✓               | ✓                     | ✓        | 4441 → 3697（省 744）      |
| 0.99.0          | ✓              | ✓             | ✓               | ✓                     | ✓        | 4468 → 3724（省 744）      |
| 1.0.0           | ✓              | ✓             | ✓               | ✓                     | ✓        | 4558 → 3814（省 744）      |
| 1.1.0           | ✓              | ✓             | ✓               | ✓                     | ✓        | 4558 → 3814（省 744）      |
| 1.2.0           | ✓              | ✓             | ✓               | ✓                     | ✓        | 4558 → 3814（省 744）      |
| 1.3.0           | ✓              | ✓             | ✓               | ✓                     | ✓        | 4558 → 3814（省 744）      |
| 1.4.0           | ✓              | ✓             | ✓               | ✓                     | ✓        | 4600 → 3856（省 744）      |
| 1.5.0（现行）   | ✓              | ✓             | ✓               | ✓                     | ✓        | 4141 → 3397（省 744）      |

- **省的是系统提示词的固定字节**（本探针的 AGENTS.md 是 744 字符，含新增的口径节）；`usage.input` 受缓存冷热影响，
  **跨版本/跨轮不可横比**（缓存命中时几乎为 0）——比大小要看节长，不看 input。
- **⚠️ `none` 的真实语义（2026-10-31 新结论，取代先前「省一半固定税」的说法）**：none 关掉的是**注入**，
  不是**知识**——none 臂孩子的系统提示词没有 `project_context` 节，却**自己 `read` 了 AGENTS.md**
  （工具序列：read 材料 → bash `ls -R` → read AGENTS.md），照样按项目口径（×1.2）算出 3432；
  实测输入只差 **−15%**（1887 vs 2229），不是 −45%。⇒ 真要隔离知识，得靠文件可达性 / 工具面，
  不是这个旋钮。
- **口径事实检查用不可猜倍率（×1.2）**：模型自带中国劳动法「加班费 1.5 倍」的常识 ⇒ 口径若写 ×1.5，
  模型不读上下文也能答对，信号不唯一。×1.2 下「带上下文必为 3432」才是可断言的确定结论。
- **`--no-context-files` 在 0.86.0/0.87.1/0.99.0/1.0.0/1.1.0/1.2.0/1.3.0/1.4.0/1.5.0 全有**
  （`npm pack` 静态核验 + floor 真机）→ `projectContext` **无需版本门**；`--no-mcp` 确证 1.1.0 起才有。
- 顺带一条行为差异：**floor 的孩子更可能不按契约交报告**（任务只写「只回答 OK」时 floor 的
  `reportChannel=none`，1.4.0 照交）→ 父面**点名 child report 的 JSON 块形状**在老版本上更必要
  （实测：点名后 4 个版本全部交上）。

### 模型行为级专项实验（bench 新题 `task-facts-ctxneed`，2026-10-31）

问的是「上下文有用时模型还关不关 `projectContext`」。口径只写在项目上下文里、档案本身不写
（`bench/ab/task-facts-ctxneed/AGENTS.md`），真值另配（`bench/ab/truth-ctxneed.json`：F3-2 = 3630、
F3-3 = 330；按字面读是 3300 / 300）。**判分器零复制**：bench 加 `--truth` 旗标，同一份判分器配不同题。

- **上下文有用时模型不关**：3/3 轮的派发脚本里**显式写了** `projectContext: "auto"`，0 次 `"none"`；
  父的发言原话「project context auto so they inherit the project's 口径 from AGENTS.md」。
- **auto 确实把上下文送到孩子**：12/12 孩子的系统提示词都带 `project_context` 节；孩子**只读自己那份档案**
  （工具调用只有一次 read）→ bench 侧 auto 是「注入唯一通道」的干净对照。
- **孩子用上了口径**：轮 1/2 的 topic-3 孩子正文引用了只有注入上下文才有的措辞（「基础时薪」「口径」——
  材料里查无此词）。⚠️ 本题倍率取 ×1.5，与法定倍数重合 ⇒ 答对不能单独作证，引用措辞才是。
- **⚠️ 注入有副作用**：3 轮共 4 条错误全是「元 → 分」×100 改写（466.56→46656、3630→363000、330→33000），
  源头是**孩子**把 AGENTS.md 里「金额一律用整数分存储」这条**编码规矩**套到答案单位上，父如实照抄
  （幻觉 0/0/0）⇒ `projectContext:auto` 不是「无害的知识补充」。
- 细节见 `bench/ab/README.md` 第十一轮。

### 会话模型继承（2026-10-31 实测，`npm pack` 静态核验 floor 与 ceiling）

孩子的模型默认继承父会话的当前模型（entry 的 `buildEngineContext` → 孩子 argv 的 `--model provider/id`）。
静态核验 **0.86.0 与 1.4.0 完全同形** ⇒ **无版本门**：

- `ExtensionContext.model` 两版都在，且**都是活 getter**（0.86.0 `dist/core/extensions/runner.js:559`
  `get model()` → `getModel()`；1.4.0 同构）⇒ 派发那一刻才读，用户中途切模型孩子跟着切。
- 模型引用格式两版都是 `${model.provider}/${model.id}`（0.86.0 `dist/core/model-resolver.js:75`；
  1.4.0 同）；`--model` 的接受格式两版都是 `provider/id` + 可选 `:<thinking>`（`cli/args.js` help 同文）。
- ⇒ **floor 上孩子同样继承父会话模型**；不发 `--model` 的唯一情形是「会话本身没有模型」。
- **真机矩阵**：`scripts/session-model-smoke.mjs` 在 0.86.0/0.87.1/0.99.0/1.0.0/1.1.0/1.2.0/1.3.0/1.4.0/1.5.0
  **九版全过**（1.5.0 于 2026-11-03 补测）——两轮差分（父显式 `minimax-cn/MiniMax-M3.1-Flash` vs 父用默认 `minimax-cn-512k/…`），
  孩子都跟着各自的父走；负向对照（撤掉 entry 的接线）如期变红——孩子落到 pi 默认模型。

### 压缩事件与任务面血缘（2026-11-01 静态核验 + 1.4.0 真机）

任务面要能跨上下文压缩找回旧任务，需要宿主侧两个 API：**会话 id** 与 **压缩事件**。

- `ctx.sessionManager.getSessionId()`：floor **0.86.0 就有**（实测返回 UUIDv7）⇒ 任务记录盖 `sessionId` **无版本门**。
- `session_compact` / `session_compact_failed` / `context` 三个事件：floor **0.86.0 全有**
  （`dist/core/extensions/types.d.ts:515` 的 `ContextEvent = { type: "context"; messages: AgentMessage[] }`、
  `ContextEventResult = { messages?: AgentMessage[] }` 与 **1.4.0 逐字同形**；
  `agent-session.js:1666` / `:1933` 经扩展总线 emit `session_compact`）。
  ⇒ 压缩后重注入**无版本门**。
- **真机两版都过（2026-11-01）**：floor 0.86.0 与 1.4.0 用同一探针
  `scripts/compact-inject-smoke.mjs` 都跑通——0.86.0：`session_before_compact branchEntries=17`
  ⇒ `session_compact reason=manual` ⇒ 下一次 `context` 里任务清单注入了（messages 14→7）；
  1.4.0：`branchEntries=28` ⇒ `session_compact` ⇒ `context messages=8 清单=有`（23→8）。
  ⇒ **压缩重注入无版本门**。中间版本（0.87–1.3）未逐版核。
- **顺带**：任务面响应改对象（`ptc_task_list` / `ptc_task_output`）在
  `scripts/version-smoke.sh` 第四腿上**真机全绿**——1.4.0 / 0.86.0 / PATH 三档 `task_face=OK`、
  `isError` 0 ⇒ 形状变更没打断既有腿。
- **探针的四个坑**（写在 `scripts/compact-inject-smoke.mjs` 头）：rpc 命令走 **stdin**（写 stdout
  等于没发 ⇒ 会话是空的 ⇒ 压缩报「会话太小」）；压缩要等 **agent 空闲**（在飞轮次里压会 abort
  在飞轮次，0.86 上 branch 为空 ⇒ 同样报「会话太小」）；floor 0.86 读 **`models.json`** 拿 provider
  配置（1.4.0 读 `models-store.json` 就够）——隔离目录缺它 ⇒ prompt 静默不跑；会话要比
  **`keepRecentTokens`** 大（默认 20000 token ⇒ 小会话没东西可摘要 ⇒ 同样报「会话太小」——
  脚本自建隔离配置目录并把阈值压到 1000）。
- **0.86–1.3 中间版本未逐版核**。

## pi 1.5.0 适配（2026-11-03 实测）

pi 1.5.0 于 2026-11-02 发布（npm `@earendil-works/pi-coding-agent@1.5.0`）。本轮按老规矩走：
**静态比对 → 真机探针 → 升钉子 → 更新文档**，代码一行没改（比对面无破坏）。

### 静态比对（1.4.0 vs 1.5.0 的包内 diff）

- **扩展类型面无破坏**：`dist/core/extensions/types.d.ts` **只加不改**——新增 `KeybindingHints`
  （`keyText()` / `keyHint()`）、`ctx.ui.custom()` 的 `blocked` 选项、消息的 `messageId` / `timestamp`；
  `ExtensionContext` / `ExtensionToolContext` / `ToolDefinition`（`exposure` / `defaultActive` /
  `outputSchema`）/ `setWidget` 的签名**逐字未变**。
- **CLI 旗标逐字未变**：`--no-mcp` / `--no-context-files` / `--mode json|rpc` / `-ne` / `-e` / `-p` /
  `--model provider/id` / `--tools` / `-builtin:` 全在（两版 `dist/cli` 的旗标集合相同）。
- **运行时导出齐备**：`getAgentDir` / `loadSkills` / `formatSkillsForPrompt` /
  `create{Read,Write,Edit,Grep,Ls,Find}ToolDefinition` / `defineTool` 全在 ⇒ floor 自造工具那条路不受影响。
- **json 事件集未变**：`dist/core/agent-session.js` 里的事件类型集合（`agent_*` / `turn_*` / `message_*` /
  `tool_execution_*`）与 1.4.0 相同 ⇒ `packages/dispatch` 的 `parseChildStream` 假设仍成立。
- **rpc 层逐字未变**：`dist/modes/rpc/**` 与 1.4.0 **无差异**（`compact` / `prompt` 等命令形状不变）。
- **内置工具的路径处理逐字相同**：`dist/core/tools/path-utils.js` 与 1.4.0 相同 ⇒ pi 内置工具仍无 cwd 囚禁。
- **alias 表不变**：pi 的扩展加载器仍把 `typebox` 指向自己那份（1.3.27）、`@earendil-works/pi-tui` 指向宿主那份
  ⇒ 我们把 typebox / pi-tui 外置（ADR-0026 / ADR-0022）照旧成立。
- **唯一的 Breaking**（工具参数校验换 `@earendil-works/pi-schema`）的结论见上面「1.x 增量」一节：
  我们的 schema 全是纯 JSON Schema ⇒ **零影响**。

### 真机探针（pi 1.5.0，2026-11-03）

| 探针                                                                                               | 1.5.0 结果                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `scripts/version-smoke.sh`（四腿：run_code 求值 / 程序内 tools.read / workflow parallel / 任务面） | **全过**：`RUN=42` / `READ=2436` / `PAR=2` / HND 非空 / `isError` 0 |
| `scripts/knobs-smoke.mjs`（timeoutMs 收尸 / projectContext / 报告通道 + usage 兜底 / 停滞护栏）    | **PASS**：孩子系统提示词 4141 → 3397（省 744，与各版一致）          |
| `scripts/session-model-smoke.mjs`（两轮差分：父显式模型 vs 父默认模型）                            | **PASS**：孩子都跟着各自的父走                                      |
| `scripts/compact-inject-smoke.mjs`（压缩后重注入）                                                 | **PASS**（见下节：先修了一处探针自己的坑）                          |

### 压缩后重注入：先修了探针自己的坑，再拿到 1.5.0 的正例

- **探针的坑（不是版本问题）**：端到端探针在 **1.5.0** 与**对照的 1.4.0** 上**同样跑不出正例**——
  英文长 prompt「Count the words in the following text」实测会让模型去翻会话记录找词（不停工具调用
  ⇒ 迟迟不 settle ⇒ 压缩压根没触发）。**失败形态两版逐字相同 ⇒ 与 pi 版本无关。**
  ⇒ 修法：长 prompt 改成中文 + 明说「不要调用任何工具，不要读文件」（写进脚本头的坑 5）。
- **宿主压缩路径两版同构**（同口径 A/B，rpc 层逐字未变 + 事件逐条同形）：`compact` 命令 →
  `compaction_start` → `session_compact_failed` → `compaction_end`（`errorMessage="Compaction failed:
  Nothing to compact (session too small)"`）→ rpc 响应
  `{"command":"compact","success":false,"error":"Nothing to compact (session too small)"}`——两版逐字相同。
- **1.5.0 上的正例**（修完探针）：`session_compact reason=manual` → `compaction_end` 带摘要 →
  rpc `success=true` → **压缩后的下一次 `context` 事件里任务清单在（清单=有）** ⇒ 压缩后重注入在 1.5.0 上成立。
  **同口径在 1.4.0 上复跑同样全过**（压缩成功=是 / 压缩事件=有 / 清单注入=有）⇒ 探针这一改与 pi 版本无关。
- ⇒ **压缩后重注入仍无版本门**（`ContextEventResult = { messages?: AgentMessage[] }` 与 `session_compact`
  的形状在 1.5.0 仍逐字同形，见上）。

## Node 运行时（2026-11-04 实测）

pi 矩阵与 Node 运行时解耦（分水岭全是 pi 侧 API 面）；本节是 Node 侧的实测基线，防「原生 TS」误导。
CI 守 22/24/26 三腿（ci.yml 矩阵）；publish 仍钉 24（trusted publishing 需 npm ≥ 11.5.1，产物是
与 Node 版本无关的普通 JS）。

### 实测基线

| Node 版本                             | 证据                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 22.22.1（engines 下限 ≥22.19 的代表） | `process.features.typescript="strip"`；`node:module.stripTypeScriptTypes` API 在；`.ts` 直跑与 worker_threads `.ts` 入口均通——compile.ts 与 worker 源码回退两条 TS 依赖路径在下限可用 |
| 26.13.0（Active LTS，2026-10-28 起）  | `pnpm test` 四件套全绿（含 `.ts` worker 源码直跑回退腿）；`pnpm run check`（tsrs）通过；**全量真机冒烟 17 腿全过**（16 个 pi 版本 + PATH 1.4.0，fails=0，2026-11-04）                 |

### Node 26 的 TS 硬事实

- 类型剥离**不是 26 的新功能**：23.6/24 起默认开，22.18+ 同样默认（`--experimental-strip-types` 仍可关）。
- 26 **移除了 transform**（nodejs/node#61803）：`--experimental-transform-types` 旗标与
  `stripTypeScriptTypes(mode:"transform")` 双双不存在——**strip-only**；enum/namespace/param-props
  从「旗标可解」变成「彻底不能跑」。本仓 `packages/ptc/src/compile.ts` 只用 `mode:"strip"`，无影响。
- **node_modules 内 `.ts` 仍拒绝剥离**（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，26.13.0 实测）——
  `@pi-ptc/ptc` 源码包与「发布包不带 d.ts」的**不做决定不受 26 影响**（rolldown alias 照旧）。
- `process.features.typescript`（`"strip"`/`"transform"`/`false`）可作运行时的 TS 能力探测；
  `stripTypeScriptTypes` 仍是 experimental（stderr 有 ExperimentalWarning，CLI 噪音，不动）。
- 26 的其余 notable changes（Temporal 默认、V8 14.6、Undici 8；`_stream_*` EOL、`writeHeader` 移除、
  DEP0182 EOL、`module.register()` runtime-deprecation）在 `packages/**` **零命中**（grep 实测）——
  无一可让本仓代码变少，不追。

## 待测

中间版本的**执行链冒烟**已覆盖（0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3，见上）；
**旋钮探针覆盖 9 个版本**（每个 minor 一版：0.86.0 / 0.87.1 / 0.99.0 / 1.0.0 / 1.1.0 / 1.2.0 / 1.3.0 / 1.4.0 / 1.5.0）；
**floor 的 codemode/exposure 行为已于 2026-10-31 查清**（见上）。仍未做的：同一 minor 的补丁版逐版安装
（按 minor 分水岭取样）、`1.x` 能力表里未直接观测的 codemode 差分（依赖旧仓 16 项探针结论）。下次 pi 发版
或动了门/可见性/codemode 探测相关代码时补测。
