# 增强方案：现状体检与增强路线（2026-11-13 · 第二版·已核证）

**这份文档是什么**：一次「当前项目还能增强什么」的系统体检结果 + 可执行的增强路线。
它**不是**决策——落地任何一条前，先按仓规写 ADR（`docs/adr/`），再动代码。

**第二版说明**：本文件取代同日的第一版草稿。第一版的骨架保留，**结论按实测证据改了三处**：

| 第一版的说法                                   | 实测后的更正                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| 「派发预算闸门」是最优先的收益点               | 仍是 P0，但**排在结构化产出与默认面路由文案之后**（默认部署里 PTC 程序面根本没注册） |
| 「同步看门狗」= 宿主侧「无帧超 N 秒」看门狗    | 有更便宜的**两段式**：先上 `vm` 的同步切片超时（实测有效），看门狗只兜剩下的洞       |
| 「批量等待/汇合」= 要加 `ptc_task_wait(ids[])` | **不必加**——程序里 `Promise.all([...wait:true 派发])` 已经能汇合（见 §4 P1-6）       |
| 「MCP 规范世代 2026-07-28」                    | 正确。`2026-11-09` 是站点 lastModified，**不是**新世代（别再当新特性追）             |

**结论先行**：这个仓库的**工程底座已经相当扎实**（隔离、状态机、落盘、门禁、版本矩阵、台架都到位）。
但 2026-11 的外部事实变了：**pi 自己有了 codemode**（原生「模型写程序批量调工具」），
而**本机默认部署形态里，本仓的 PTC 程序面根本不注册**——真正剩下的是**派发面**。
所以收益最大的方向不是「PTC 再加功能」，而是：

1. **让模型能拿到结构化产出**（pi 早就支持 `outputSchema`/`structuredContent`，本仓还在全文本）；
2. **把默认面（codemode）的路由文案补齐**——零 token 的 `program` 载体是 codemode 覆盖不到的唯一能力，
   而它现在只写在详情文档里，模型默认看不到；
3. **派发要有预算**（队列与每会话孩子数无上界）；
4. **程序不能靠烧满 2 分钟才判死**（同步死循环；上游 DSH 有 5 秒版，本仓没有）；
5. **让「省 token」这个核心主张在产品内可见**（现在只有台架数据）。

其余是体验与治理的补齐，可以按季度慢慢做。

---

## 0. 体检方法与证据基线

本轮做的是**读 + 量 + 联网核对 + 实测探针**，没有改任何代码（除本文件与 `docs/INDEX.md` 的一行）。

| 维度     | 怎么查的                                                                                                   | 结果                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 仓库面   | `git log` / 包结构 / LOC                                                                                   | 8 个包 + website，源码 6,287 行（entry 911 / dispatch 904 / routes 422 / kimi-mcp 232 / ptc 209 …）                       |
| 测试面   | `node --test tests/{pi,output,kimi,standalone}`                                                            | **257 条全绿**（pi 200 / output 9 / kimi 35 / standalone 13）                                                             |
| 站点面   | `node packages/website/scripts/run-checks.mjs`                                                             | **5 道里 1 道红**：`landing page tool names`（`ptc_progress_update`，v7.11.0 起）                                         |
| 上游面   | 本机 `@earendil-works/pi-coding-agent@1.5.2` 的 `docs/`、`CHANGELOG.md`、`dist/core/extensions/types.d.ts` | pi 扩展面比本仓用到的宽（`outputSchema`/`structuredContent`/`before_agent_start`/`agent_settled`/`ctx.getContextUsage`…） |
| 竞品面   | pi 自带 **`docs/codemode.md`**（原生 PTC：QuickJS、`store/load`、`models.classify`、工具 schema 内联）     | **与本仓 PTC 正面重叠**；codemode 在 pi 的发版循环里                                                                      |
| 部署面   | 本机 `~/.pi/agent/settings.json`                                                                           | `defaultTools:["+codemode"]` + `extensions:["+builtin:codemode"]` ⇒ **默认形态就是 `both`**                               |
| 台架面   | `bench/ab/out-fanout24-mx-1.4.0/report.json` + `bench/ab/README.md`                                        | 四臂同分（objective 全过）；**没有一臂真用了程序面**（`ptcRunCodeCalls=0`、`codemodeCalls=0`）                            |
| 上游 PTC | 本仓存档的一手快照 `docs/research/upstream-20260930/01-dsh-ptc-core.md`                                    | 上游有 `syncTimeoutMs=5000`（**初始同步切片**）、并发上限 10——本仓已有并发 10，**独缺同步切片上限**                       |
| 同类面   | Claude Code 官方文档（sub-agents）                                                                         | 有明确的「Concurrent subagent limit」与 background agent 概念（**具体数值未取到**，文档是 JS 渲染）                       |

**没做的**：真 pi 会话复验（本轮只跑探针）、Kimi 端到端、MCP 2026-07-28 新特性逐条对表、Claude Code 并发上限数值。

---

## 1. 现状：已经很强的部分（不要动）

| 能力         | 证据                                                                                                | 为什么强                                             |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 程序隔离     | `packages/ptc/src/worker-main.ts:16`（vm cell + 桥脱手）、`dispatcher.ts:47`（堆上限 512MB / 64MB） | 程序只有 `tools.*` 一扇门，没有宿主对象跨 realm 暴露 |
| 任务状态机   | `packages/dispatch/src/registry.ts:4`（7 态迁移表）、`:85`（写锁串行）                              | 非法迁移拒绝、并发判定在锁内                         |
| 派发永不误拒 | `packages/dispatch/src/slots.ts:25`（满则 FIFO 排队）                                               | libuv 语义：忙 = 等，不是拒绝                        |
| 痕迹双层存储 | `packages/dispatch/src/engine.ts:807`（挤最老）、`:839`（压缩归档）、`:861`（TTL 清理）             | 终态 500 条热存 + 30 天压缩冷存，精确 id 可回捞      |
| 发布物工程   | ADR-0024/0025/0026（一次构建四入口、minify、typebox 外置）                                          | npm 包 JS ≈ 74.7 KB，比压缩前 −72%                   |
| 产物门禁     | `scripts/check-artifact-imports.mjs` + `tests/pi/artifact-shape.test.mjs`                           | 依赖声明跟产物走；副作用隔离有钉子                   |
| 版本兼容     | `scripts/version-smoke.sh`（19 腿）+ `knobs-smoke` / `session-model-smoke` / `compact-inject-smoke` | 0.86–1.5.2 全矩阵有真机证据                          |
| 台架文化     | `bench/ab/`（四臂对照 + 判分器自检 + 工具面自检）+ `bench/kimi-ab`                                  | 结论有数据支撑，不是感觉                             |

---

## 2. 最重要的发现：默认部署形态已经变了（本轮战略结论）

**事实链**（每条都有出处）：

1. **pi 1.x 自带 `codemode` 工具**：模型写 JS 脚本批量调工具，只有脚本输出进模型；
   QuickJS 沙箱、`store()/load()`、`models.classify()/generateImages()`、内联工具 schema、`timeout_ms`、256MB 内存上限。
   ⇒ 它就是本仓 PTC 的同代物（`node_modules/@earendil-works/pi-coding-agent/docs/codemode.md`）。
2. **本仓已在 codemode 面前主动退让**：决策 28「一个面一个编排器」——
   `packages/entry/src/index.ts:160` 探测 `pi.getActiveTools().includes("codemode")` ⇒ surface=`codemode_ptc`
   ⇒ **不注册** `ptc_run_code`/`ptc_workflow`，只注册 `pi_task_codemode`（`exposure:"codemode"`，模型不可见、脚本可调）。
3. **本机（作者自己）的默认配置就是 codemode 开**：`~/.pi/agent/settings.json` 里
   `defaultTools:["+codemode"]` + `extensions:["+builtin:codemode"]` ⇒ 装上本仓插件后的**真实默认形态是 `both`**。
   仓里自己的台架 README 也写着这条：「**`both` 档 = 默认部署形态**……自研 PTC 退让，`ptc_run_code` **不在模型面前**」。
4. **codemode 覆盖不到本仓的唯一能力**：`program` 载体（零模型、零工具表、token 归零的程序型子代理，v7.13.0）。
   codemode 脚本能调 `tools.pi_task_codemode({ program })`——**本仓的门已经支持 `program` 参数**
   （`packages/entry/src/index.ts:883` 用的是含 `program` 的 `TASK_DOOR_PARAMETERS`），
   但**默认面的路由索引里没提它**（索引只写 `tools.pi_task_codemode({ task, label? })`，
   `program` 只在详情文档 `docs/routes/create-a-task.md`）。

**⇒ 战略结论（ponytail ultra 的「先质疑需求」落在这里）**：

> **不要和 codemode 比 PTC 能力面。** QuickJS 沙箱、`store/load`、非 LLM 模型、内联 schema——这些在 pi 的发版循环里，
> 本仓追不上也不该追。**本仓该占的位置是「可编程的派发」**：codemode 负责编排，**本仓负责把孩子派出去并管住他们**。
> PTC 引擎继续存在，但它的身份从「模型面主角」变成「program 载体的执行体 + Kimi 面 + 独立 CLI」。

这条结论决定了下面所有排序：**先修默认面（codemode）上的缺口，再修引擎的洞，最后才是加分项。**

---

## 3. P0：这一迭代就做（成本低、杠杆高）

### P0-1　结构化产出：pi 早就支持，本仓还在全文本

**现象**：pi 的工具定义支持 `outputSchema`，结果可带 `structuredContent`，
注释明写「codemode scripts then receive it instead of the text content」
（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:493-496`、`:1014-1017`）。
本仓的工具**一个都没声明 `outputSchema`**（`grep outputSchema packages/*/src` 只命中一条注释）。

**半成品证据**：`pi_task_codemode` 已经返回 `structuredContent: shaped`（`packages/entry/src/index.ts:906`），
**但没有声明 `outputSchema`** ⇒ 按 pi 的规则，codemode 脚本拿到的仍是**文本**（那段 JSON 字符串），
脚本还得自己 `JSON.parse`。**等于做了一半**。

**收益**：

- codemode 脚本里 `tools.pi_task_codemode(...)` 直接拿对象（省一次 parse、省一次字段名猜）；
- 任务面三工具（`ptc_task_list`/`ptc_task_output`/`ptc_task_stop`）同款——它们的响应本来就是 JSON；
- 模型面**不受影响**（`content.text` 照旧双写）⇒ 旧宿主、旧模型、floor 版本零风险；
- Kimi 面顺带受益（MCP 2025-06-18 起支持 `structuredContent`，本仓 SDK `@modelcontextprotocol/sdk@^1.32.2`）。

**做法**：给四个工具各加 `outputSchema`（typebox，`typebox` 由 pi 提供 ⇒ 零新依赖，ADR-0026），
并把现有 `textResult(...)` 的值同时挂到 `structuredContent`。**先做本来就是结构化的那几个**——
`pi_task_codemode` / `ptc_task_list` / `ptc_task_output`；`ptc_run_code` 的结果由程序自由决定，**不做**。

**验收**：`tests/pi` 一条探针（断言 `structuredContent` 形状与 `text` 一致）；`tests/kimi` 一条
（`tools/list` 带 outputSchema、`tools/call` 回 structuredContent）。

### P0-2　默认面（codemode）的路由索引漏了 `program` 载体

**现象**：`packages/routes/src/registry.ts:250` 的 codemode 面文案是
`tools.pi_task_codemode({ task, label? })（脚本内）`——**没有 `program`**。
而 `program` 是 codemode 覆盖不到的唯一能力（零模型、零工具表、token 归零；台架 30–270×、token 归零）。
它在 `docs/routes/create-a-task.md` 里有整节，但**索引是模型默认唯一看到的东西**（详情要模型主动 read）。

**做法**：索引那行补成 `tools.pi_task_codemode({ task, label?, program? })`，
并加一句「机械批量能写死成程序就用 program（零模型零 token）」；
文案在 `routes`（模型面散文唯一出处），**加一条探针钉住「索引提到 program」**
（照 `route-registry-gates.test.mjs` 的形状）。

**为什么排 P0**：这是「默认面 + 唯一不可替代的能力 + 模型看不见」三件事叠在一起，
**一行文案的差距可能等于一个功能**。

### P0-3　站点门禁红了（v7.11.0 起一直红，不是本轮引入）

**现象**：`node packages/website/scripts/run-checks.mjs` → 5 道里 1 道红：
`landing page tool names` 报「1 registered tool(s) are neither required on the landing page nor declared absent: `ptc_progress_update`」。
`ptc_progress_update` 是 v7.11.0 加进路由册的模型面工具（commit `b75d95e`），
落地页 `packages/website/docs/index.md` 从此没更新 ⇒ **CI 的 `website.yml` 从 7.11.0 起就在红**，没人接。

**修法（两行，要人拍板）**：`packages/website/scripts/check-landing-tool-names.mjs` 的
`MUST_APPEAR` 或 `DECLARED_ABSENT`（后者要写理由——脚本自己要求理由）二选一。
**建议后者**：它是「长任务进展」的辅助通道，落地页讲清 `ptc_run_code`/`ptc_workflow`/任务面三件就够。

**顺带**：给 `website.yml` 的失败加一条通知（哪怕开 issue），否则它会像这次一样静默红几个月。

### P0-4　派发预算闸门：模型一次能排上千个孩子

**现象**（已核证）：并发上限是 8（`packages/dispatch/src/slots.ts:2`），但

- **队列无界**：`slots.ts:25` 的等待者数组只进不出，没有上限；
- **每会话孩子数无界**：`registry.ts:71` 的 `evictTerminal` 只挤**终态**记录，排队中的记录永不淘汰；
- **每次派发写穿一条记录文件**（`engine.ts:793`）。

⇒ 模型在一个程序里循环派 500 个孩子 = 500 条记录落盘 + 500 个 pi 进程排队 + token 烧穿，
而**模型侧毫无感知**（任务面只列在飞 + 最近 10 条完成，`packages/task/src/list-tasks.ts:5`）。

**同类对照**：Claude Code 有明确的「Concurrent subagent limit」概念（数值未取到）；
pi 的 codemode 满员是「排队等 60s，拿不到就失败」（`docs/codemode.md` 的 Limits 节）——
**本仓是「永远等」**，这是唯一的语义差。

**做法（照现成的形状，别新造机制）**：`packages/dispatch/src/gates.ts` 已有
`Gate = (input) => TaskRejection | null` 与 8 道默认闸（readOnly / dispatchEnabled / sessionEnding / depth /
agentName / taskText / program / agentResolve）。照抄这个形状加两道：

- `maxQueued`（排队上限，默认宽档 32）：超了**拒绝并给可读理由**（仓里闸的哲学：拒绝要说清为什么，不是静默丢弃）；
- `maxChildrenPerSession`（默认 64）。

**定档用台架数据**：`bench/ab/out-fanout24-*` 已经跑过 24 扇出 ⇒ 上限取「宽到不误杀 24 扇出」的值。
文案进 `packages/routes`，配置走 `~/.pi/agent/ptc.json`。

**验收**：`tests/pi` 假 spawn 计数探针（超限**一个进程都不起** + 拒绝口径可读）；真机一次 N+1 连派。

---

## 4. P1：能力补齐（一个迭代两到三条）

### P1-1　程序同步死循环：现在要烧满 2 分钟（两段式修，实测过）

**现象**：`packages/ptc/src/worker-main.ts:176` 的 `execute()` 里，
程序被 `program.call(context)` 调用——**调用发生在 `vm.runInContext` 之外**，
所以 `vm` 的 `timeout` 选项**管不到它**。宿主侧唯一的闸是墙钟超时（`dispatcher.ts:97`，默认 120s）。

**本轮实测（`/tmp/vmprobe*.mjs`，Node 26）**：

| 变体                                                               | 结果                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A：现状形状 `program.call(ctx)`，函数体 `while(true){}`            | **挂死**（`timeout 124`）——只有宿主 120s 墙钟兜底                      |
| B：改用 `vm.runInContext("globalThis.__p()", ctx, {timeout:1000})` | **1002ms 抛 `ERR_SCRIPT_EXECUTION_TIMEOUT`** ✅                        |
| C：`await` 之后再 `while(true)`（脚本调用 + timeout）              | **仍挂死**——vm 超时只管「初始同步切片」（DSH 的 `syncTimeoutMs` 同义） |

**修法（两段，各管一段洞）**：

1. **段一（便宜、覆盖最常见洞）**：程序调用改成走脚本 + `timeout`：
   `vm.runInContext("globalThis.__ptcProgram()", ctx, { timeout: DEFAULT_LIMITS.syncTimeoutMs })`。
   阈值取 **15s**（必须大于「一次慢 binding」与「provider 等首 token」的合理耗时；DSH 用 5s，本仓程序更重，取宽）。
   ⚠️ 改的是 `worker-main.ts` 的 `execute()`，**限值进 `limits.ts`（数字唯一出处）**。
2. **段二（兜住 C 那种洞）**：宿主侧看门狗——**「距上次任何帧超 N 秒」且「无在飞调用」** ⇒ 判死并 `terminate()`。
   判据用 dispatcher 里已有的状态（`pendingCalls`/`runningCalls`）：有在飞调用 ⇒ 在等慢工具，**不算卡死**；
   无在飞调用 + 无帧 ⇒ 卡在同步段。

**验收**：探针（假 worker 不回帧 ⇒ ≤N 秒返回 canceled，而不是等满 120s）；真机 `while(true){}` 实测墙钟。

### P1-2　PTC 格的 schema 自省（`describeTool`）——针对仓库自己的 A/B 证据

**证据（本仓路由册里写着）**：`packages/routes/src/registry.ts:36` 的实测注释——
「模型因『不确定程序内工具的参数形状』放弃写程序……对照 pi 自带 codemode 给每个工具完整
inputSchema+outputSchema，模型 **5/6 轮主动用**」。

⇒ **codemode 赢在「把工具的 schema 给模型」，不是赢在沙箱**。本仓的 PTC 程序里
`tools.read({...})` 的参数形状全靠模型记忆（描述里只能写「与直接调用该工具完全一致」）。

**做法**：给运行格加两个 codemode 同名的全局（心智可迁移）：

- `ALL_TOOLS`：`[{ name, description }]`；
- `describeTool(name)`：返回该工具的 **JSON Schema**。

**数据已经在手**：`pi.getAllTools()` 的返回类型
`ToolInfo = Pick<ToolDefinition, "name"|"description"|"parameters"|...>`（`types.d.ts:1622`）——
`parameters` 就是 typebox schema。
⇒ 注入一张 `name → schema` 映射进格（`CELL_PREAMBLE` 现在只注入 `__PTC_NAMES__`），
宿主侧从 `pi.getAllTools()` 取，只给**本会话真能调**的那几个 binding（不多不少）。

**为什么不做成「把 schema 全塞进工具描述」**：那是每轮 prompt 的固定税（`<ptc>` 索引有 560 token 硬顶），
而 codemode 的做法是**按需自省**——用同一个「要用才付」的形状。

**验收**：探针（格内 `describeTool("edit")` 返回含 `edits` 数组的 schema；未知工具返回 undefined 不抛）。

### P1-3　让「省 token」在产品内可见（`ctx.getContextUsage()`）

**现象**：PTC 的核心主张是「中间产物不进上下文」。仓里**有台架数据**（`bench/ab` 各臂的
`inputTokens`/`outputTokens`/`cacheReadTokens`），但**产品内没有任何可见性**——
面板只显示任务计数与时刻（`packages/tui/pi/task-panel.ts`），任务面也不给用量汇总。

**做法**：pi 1.5.2 有 `ctx.getContextUsage()`（`docs/extensions.md`，返回当前上下文的 token 估算）。
面板标题行加一行「context · N tokens」；任务面给会话级 usage 汇总
（registry 里每条记录已有 `usage`，引擎侧 `engine.ts:510` 有观测值兜底）。

**验收**：面板渲染探针一行；一条「记录 usage 汇总」的探针。

### P1-4　`program` 孩子的真机矩阵（状态页自认的缺口）

**现象**：`docs/prototypes/dispatch-engine-status.html` 自认「仍缺：program 孩子的失败信封真机复现 与
并发多 program 孩子的真机压测（探针只到假 spawn 层）」。`program` 是本仓对 codemode 的**唯一不可替代能力**
⇒ 它的真机证据优先级应该高于别的 P1。

**做法**：真机跑两条（失败信封：真进程返回 rejected；并发 4 个 program 孩子），
补 `tests/pi/program-child.test.mjs` 的真机版断言。

### P1-5　Kimi 面：派发门缺位 + 结构化输出没用上

**现象**：Kimi 面只有两个工具（`ptc_run_code` / `web_ds_search`，`packages/kimi-mcp/src/server.ts:186-199`）——
**没有派发门**，Kimi 上不能派子代理（Kimi Code 自带 Agent 工具，重复造是负债，见 §6）；
MCP 2025-06-18 起的 `structuredContent` / `outputSchema` 也没用（本仓 SDK `^1.32.2` 支持）。

**做法**：先只做**结构化输出**（与 P0-1 同一套形状，`packages/output` 是两面共用的输出核）；
派发门**暂不做**——除非有 Kimi 端用户明确需求（见 §6「明确不做」）。

### P1-6　超时原因要说清「卡在哪个孩子」（一行改动）

**现象**：`wait: true` 的派发会阻塞到终态（`packages/dispatch/src/engine.ts:291`），
所以程序里 `await Promise.all([...])` **已经是现成的批量扇出 + 汇合**（§6 的「不做」基于这条）。
但它**受程序自己的墙钟约束**：程序默认 120s（模型可传 `timeoutMs` 抬到 600s），
而超时原因只有一句 `timeout after 120000ms`（`packages/ptc/src/dispatcher.ts:107`）——
**看不出是在等哪个孩子**，模型只能盲猜「是不是孩子太慢」。

**做法**：dispatcher 的 timeout 分支把**在飞的 taskId / 未回的调用名**写进 `reason`
（dispatcher 已有 `pendingCalls` 与 `subCalls.snapshot()`，是现成数据源）。
顺手在路由册的「派一个子代理」详情里写一句：长扇出要么分批，要么先把 `timeoutMs` 抬上去。

---

## 5. P2：工程治理（收敛，别摊开）

### P2-1　只补两道门禁：体积预算 + 密钥扫描

**为什么是这两道**：

- **体积预算（size-limit）**：ADR-0025 已给出基线（npm 包 JS 74,690 B / `dist/index.js` 61,052 B），
  预算线可以**直接拿现有数字当阈值**，一个配置文件 + 一个 devDep。
- **密钥扫描（gitleaks）**：这个仓「会读用户仓库、会把事件流写盘」⇒ 硬编码密钥的爆炸半径最大。

**明确不做**（第一版草稿列了五道，本轮砍掉三道）：

| 不做的门禁   | 理由                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `attw`       | 本仓不发布 d.ts（已评估不做），TS 消费者为 0 ⇒ 「消费者能不能解析类型」没有对象               |
| `publint`    | manifest 的正确性已被发版流程实测覆盖（干净树安装 7 条探针红过一轮），再加一道是重复保险      |
| `fast-check` | 状态机迁移表是 7 态显式表、非法迁移抛错，已有探针覆盖；属性测试要新写生成器，边际收益低于成本 |

### P2-2　不要拆 `packages/entry/src/index.ts`（911 行）

第一版草稿建议按职责拆成三个文件。**本轮反对**：拆文件不改行为、不加能力、不减风险，
只增加 diff 面积与回归面。真要拆，等 P0/P1 里自然长出边界时再拆（**按职责拆，不按行数拆**）。

---

## 6. 明确不做（避免反复讨论）

| 事项                              | 理由                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **与 codemode 比 PTC 能力面**     | QuickJS 沙箱 / `store/load` / 非 LLM 模型 / 内联 schema 都在 pi 的发版循环里（§2）。追不上，也不该追 |
| OS 级沙箱                         | ADR-0014/0019 已决：运行格是**权力路径对齐**，不是安全边界；孩子以用户身份跑是既定信任姿态           |
| 发布包带 d.ts                     | 已评估：根包 d.ts 引用 7 个未发布子包，消费方解析会断；当前 TS 消费者为 0                            |
| **程序内派孙代理**                | 深度终结（v1 明确不做）                                                                              |
| **模型面 `ptc_task_wait(ids[])`** | 程序里 `Promise.all([...])` 已经能汇合（§4 P1-6）；模型面另开一扇门只是多一个入口                    |
| `noSkimp` 默认开                  | README 自记「无收益证据，只有更多 token 与花费」                                                     |
| Kimi 面再加子代理门               | Kimi Code 自带 Agent 工具，重复造是负债                                                              |
| 给 PTC 程序开 `bash` 绑定         | 绑定表是「能力对齐 + opt-in」；扩 bash 会让「对齐宿主工具面」的论证复杂化，除非有具体需求            |

---

## 7. 排期建议与验收纪律

**第 1 轮（1 个迭代，建议 3 条）**：P0-1（结构化产出） + P0-2（默认面 `program` 索引文案） + P0-3（站点门禁）。
这三条互相独立、都小、都不改引擎语义 ⇒ 可三个小 PR 走。

**第 2 轮**：P0-4（派发预算闸门） + P1-1（同步切片两段式） + P1-4（program 真机矩阵）。

**第 3 轮**：P1-2（schema 自省） + P1-3（用量可见） + P1-5（Kimi 结构化输出） + P2-1（两道门禁）。

**贯穿纪律（照抄仓规，不打折）**：

1. 每条改动先对质 `docs/prototypes/dispatch-doors-flow.html` 的 spec（语义变了才改 spec）；
2. 写 ADR → 改代码 → **探针必须能红**（反事实：拿掉守卫断言该红）→ **同步两份状态 HTML**；
3. 模型面散文一律进 `packages/routes`；工具/引擎文件里不许字面量；
4. 数字进 `limits.ts`（数字唯一出处），不写字面量；
5. 收尾跑四件套：`pnpm run check` / `build` / `lint` / `fmt:check`，再 `pnpm test`（四腿 257 条全绿为基线）；
6. 发版走 tag + trusted publishing，tag 与 `package.json` 版本必须一致。

---

## 8. 风险与回退

| 风险                               | 缓解                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| 结构化输出让旧宿主/模型行为漂移    | 双写（`text` + `structuredContent`），旧路径保留；用版本矩阵探针验证 0.86–1.5.2                  |
| 同步切片超时误杀「真的在算」的程序 | 段一只管**初始同步切片**（DSH 同义）；段二要求「无帧 **且** 无在飞调用」；阈值 15s 可配          |
| 派发预算闸门误杀正常大扇出         | 默认宽档（队列 32 / 每会话 64，均 > 台架实测的 24 扇出）；拒绝文案写清「上限/当前值/怎么调」     |
| `program` 进索引后模型滥用程序孩子 | 索引文案点明判据（能写死成程序才用；要探索/要 bash 的活仍派 pi 孩子）——判据已在详情文档写好      |
| 门禁补齐引入假红                   | 每道门禁必须区分「被检对象不合格」与「门禁自己坏了」（旧分支 attw/publint 的三段式退出码可沿用） |

---

## 9. 本轮未检查 / 不确定项

- 未做真 pi 会话复验（本轮只跑探针 + 读码；P0/P1 的真机项写在各自验收里）；
- 未逐条对 MCP 2026-07-28 新特性（只确认了协议世代与 SDK 版本）；
- Claude Code 的并发子代理上限**具体数值未取到**（文档是 JS 渲染，只拿到导航级信息）；
- `packages/website` 的其余分发细节（插件市场、Kimi 目录）未审；
- 老分支（`backup/main-legacy-20261026`）的实现源码未读（干净室规则禁抄，且本轮不需要）。
