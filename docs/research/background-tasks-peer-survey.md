# 四家 peer 的后台任务 / 后台子代理机制调研（kimicode / minimax-code / Reasonix / codex）

> 调研日期: 2026-09-24。wayfinder `bgdispatch` 图的 evidence base。
> 方法: 各仓库 shallow clone 后源码精读，无二手描述。完整逐条报告（含全部
> path:line 引文）产生于建图会话；本文件是决策层摘要 + 载重引文，复核命令
> `git clone --depth 1 <url> /tmp/<name>`。
>
> HEAD 快照:
>
> - kimicode (moonshotai/kimi-code): `a1e4c13d411f75bd327e2c33077daff42ee63582`
> - minimax-code (MiniMax-AI/minimax-code): `a914a306c9aa84a71e8c49f03e1d539416287397` (v0.5.2)
> - Reasonix (esengine/DeepSeek-Reasonix): `cebd689b6fa4bc7e641d655832adc2456ba2008c`
> - codex (openai/codex): `ab021e9f137c9daacf6ae06a495f3c7d6199fab2`

## 0. 决策对照表

| 维度 | kimicode | minimax-code | Reasonix | codex |
| --- | --- | --- | --- | --- |
| spawn 面 | 干活工具上的 `run_in_background` flag（Bash/Agent/AskUserQuestion），无专用 spawn 工具 | 专用 `task` 工具（带 flag）+ bash flag | task/fleet 工具上的 `run_in_background` | `spawn_agent` 纯异步，只回 `{agent_id, nickname}` |
| 管理面 | TaskList / TaskOutput / TaskStop / WaitFor（flag 门控） | task / task_append / task_query / task_output / task_stop | job_output / job_kill / wait / read_subagent_result | wait_agent / send_input / close_agent / resume_agent |
| 立即返回物 | task_id + 元数据文本（`automatic_notification: true` + `next_step:` 教学） | `<task_background task_id session_id>` 回执 | job id（`task-3` 形）+ `sa_` transcript 引用 | agent_id + nickname |
| 完成→模型 | 自动 user-role XML，恰好一次，**唤醒 idle**，mid-turn drain | steer 注入隐藏 `<background-task-finished>` + 投递调度器（重试/限速/cadence 兜底），**唤醒** | drain-once 一行摘要，**搭下一轮用户输入的车**，不唤醒，可能永不被看到 | watcher 注入 `<subagent_notification>` 片段，`inject_without_turn`，**明确不唤醒** |
| 等待原语 | WaitFor（≤600s，等任一，flag 门控） | task_output 长轮询（wait_ms≤30s） | job_output(wait=true≤10min)，服务端游标；wait 工具 | wait_agent：多目标任一先完成先返回，**返回值携带子代理最终消息** |
| 状态机 | running + completed/failed/timed_out/killed/lost | queued/running/stopping/succeeded/failed/canceled/lost（迁移显式校验 + 单一 terminal 写入器） | running/done/failed/killed/interrupted + 墓碑；kill 同步翻转 | 运行态 AgentStatus 七态 + 磁盘 Open/Closed 两态，两层正交 |
| 子代理持久化 | per-session `tasks/<id>.json` + output.log；重启→lost+reminder；**agent session 独立持久 → `resume=agent_id`** | 全局 SQLite 行 + per-task output.log/summary.txt + child=正式 Session V2 → **`task_append` 可复活 lost child** | job artifact（`{id}.log`+meta 带 OwnerID）+ 子 transcript 双轨；重启→Interrupted（ownership probe 守卫）；**完成者 `continue_from` 可续，interrupted 拒续** | 每线程 rollout JSONL + SQLite 边图 → **`resume_agent` 复活并递归复活 Open 后代** |
| 并发 | maxRunningTasks 默认无限，超限快速失败 | 无上限；限流在投递侧（3 turn/60s，批≤32/8KB） | 调度器 maxTotal 6 / maxWriters 3，顶层 FIFO 排队 + **嵌套 fail-fast**；legacy 上限 3 拒绝 | 硬上限（V1 6 / V2 4）超限即拒；**完成未 close 占额度**；深度默认 1 |
| 超时 | `timed_out` 态 + bash 超时可自动转后台 | bash 看门狗 30min；subagent 无 | **无墙钟超时**：stalled 告警 + MaxSteps/MaxOutputTokens 预算（超限=partial+可重试） | 子代理无超时；仅 wait 有 |
| 中途 steer | 无（resume 代替） | task_append 三态 ack（activated/steered/duplicate），幂等键不含 content | 无正式机制（continue_from 只对已完成；inbox 是用户侧） | send_input（`start_or_steer_turn`；interrupt flag）；V2 拆 QueueOnly/TriggerTurn 两档 |
| 父看子进度 | 子代理不流式，settle 一次性写 | subagent 不流式（bash 流式） | 不流式（transcript 终态才落盘）；进度只给 UI（ToolProgress 相位） | 不流式（SubAgentActivity 仅 UI） |
| 批量 | AgentSwarm 独立同步批（≤128，模板，resume_agent_ids 收集） | 批量只在通知层 | fleet = **一个 job 包整个 DAG**，聚合结果 + 逐 item UI 事件 | 无 |

## 1. kimicode 要点

- spawn 返回即元数据文本：`task_id / pid / status: running / automatic_notification: true` + 两条 `next_step:`（bashTool.ts:377-436）——**在 spawn 瞬间完成工作流教学**，提示词明令"别轮询、别刚启动就等"。
- 完成通知 = user-role XML（`<notification id="task:<id>:<status>" …>`，带 output-file 指路 / 4KB 尾巴 / question 类 ≤16KB 内联），`loop.notify({turnScoped:false})`：mid-turn 在 step 边界 drain 进当前 turn，idle 直接开新 turn（machine.ts:233-235）。恰好一次靠 `taskDeliveredNotificationKeys` + 上下文扫描兜底；WaitFor 报告过的任务不再通知。
- 前台/后台是同一服务的 `detached` 位；前台可被 Ctrl+B 或超时（`autoBackgroundOnTimeout`）detach 成后台，工具回执注明"已转后台"。
- 持久化：`<sessionDir>/agents/<agentId>/tasks/<taskId>.json` + `output.log`；重启 `loadFromDisk → reconcile → markLoadedTasksLost`，注入"上会话任务失联，别当完成"reminder（`resumeReminded` 防重）。子代理会话独立持久，`Agent(resume=agent_id)` 续命。
- 输出治理：内存 1 MiB 尾部环形缓冲 + 磁盘全量 + process 类 16 MiB 硬顶自动停。
- swarm 与后台任务刻意分离：swarm 全同步、整批阻塞、结果下一轮 `resume_agent_ids` 收集。

## 2. minimax-code 要点

- 5 工具实为 `task / task_append / task_query / task_output / task_stop`（`task_query` 非 task_list）；三个管理工具齐备时工作工具才暴露 background 参数。
- 7 态机 `domain.ts:4-11`，`canTransitionTaskStatus` 在事务里校验；**单一 terminal 写入器** `persistLocalSubagentTaskTerminal`（"Every producer … routes through here"）；晚到的 runner 结果不覆盖 stop 结果。
- 前台 subagent 也是任务行（executionMode metadata，注释："a foreground run is as observable and as recoverable as a background one"），前台完成 `delivery:'already-delivered'` 落闩，**绝不产生第二次唤醒**；bash 特有 15s 软让渡自动升格后台（`auto_promoted`，进程不重启）。
- 完成投递：`ingress.steer(<background-task-finished hideUserMessage>)`——在飞并入当前 turn，空闲自动开新 turn；投递调度器 1s/2s/5s → 60-300s 指数重试；每会话 60s 窗口 ≤3 个交付 turn；`deliveredAt` 闩 + 批 idempotencyKey + task_output 读确认 = exactly-once；另有 cadence 化 `<system-reminder><background-task-completion-reminder>` 兜底（读过即抑制）。
- task_output 长轮询 wait_ms≤30s + 字节游标；连续相同读数注入反轮询 hint。
- 持久化：全局 SQLite 任务行（含整行 record_json）+ 事件表；输出 `<dataDir>/background-tasks/<taskId>/output.log` + summary.txt sidecar（outputRef 指文件）；child 是正式 Session V2。重启按 **runtimeOwner 存活判定**标 lost（TASK_LOST_ON_STARTUP）并 emit 'completed' **复用正常投递管线**告知模型；`task_append` 对 lost child 可再激活（activated→新 task_id）。
- task_append：activated（idle→新 task_id）/ steered（并入在飞 turn）/ duplicate；幂等键刻意不含 content；准入不检查任务状态（terminal 也能 append = 模型驱动的复活）。
- 角色天花板 `filterCanonicalNativeToolCeiling`：worker 被剥委派工具；explore/verifier 剥写类 + explore 连查询工具都没有——纯函数、装配点统一应用。

## 3. Reasonix 要点

- 唯一委托核 `TaskTool.RunProfileSpec`（"Every entry point compiles to a spec and runs through RunProfileSpec, so a boundary added there cannot be missed"）。
- `RunInBackground` 的实际变化：取 jobs.Manager →（legacy 路径先 `ReserveStartForSession` 超限**拒绝**）→ 同一个 run 闭包扔进 job goroutine，**并发槽在闭包内部才获取——池满也立即返回 job id**，排队发生在 job 内（task_background_queue_test.go 锁死该行为）。
- jobs.Manager 生命周期 = session 而非 turn（包注释原话）；5 态 running/done/failed/killed/interrupted，无 queued/stopping（kill 同步翻转，"clients may render a local 'stopping' state"）。
- 完成投递是三者最弱：Notice 只给 UI；`DrainCompletedNoteForSession` 的一行摘要（"task-3 (label) — done"）由 `Controller.compose` **在下一轮用户输入时**前置包装（`<background-jobs>`），没有 idle wake；结果靠 job_output（服务端 readOffset 游标，增量）/ read_subagent_result（`sa_` 引用分页，UTF-8 对齐）拉取。
- **会话 Stop ≠ job 停止**（cancel.go 只杀 turn，jobs 故意跨 turn）；session 销毁才 teardown（15s grace，超时 warn + 延迟物理清理）。
- 持久化双轨：job artifact（meta 带 OwnerID）+ 子 transcript（终态才 Save）；重启 Running→Interrupted（ownership probe 守卫，"age or an idle Session does not prove ownership loss"）；完成 = tombstone 可查；`continue_from` 需全量身份校验（kind/name/workspace/systemPromptHash/toolScope/toolSchemaHash/model/effort），**interrupted 明确拒续**（"run a fresh subagent instead"）。
- BackgroundWriter ≠ 输出流：是 checkpoint 写者所有权协调（fleet N 个可写 item 只注册一个 writer id）。
- 并发：调度器 6 总/3 写，FIFO 排队 + 整 workspace 写者成屏障；**嵌套 fail-fast**（"nested subagents fail fast to avoid parent/child slot deadlock"）；写路径 claim（declared→realized→opaque 演进 + 父写保留防 TOCTOU）。
- controller 重建（换模型）时 `SessionBackgroundScope` 引用计数保活后台 job，`RuntimeBound` job 阻塞替换——后台设施必须活过 controller 代际。
- fleet：`spec.Sched.RunInBackground = false // fleet owns backgrounding`——整群一个 job，逐 item 独立 call identity + UI 事件，模型只见聚合（有界预览 + ref 分页）；preflight 拒环/写重叠；fail_fast 只停启动不杀在跑（"so partial writes are not abandoned mid-flight"）。

## 4. codex 要点

- spawn_agent 纯异步：创建线程 + 提交初始 prompt 即返回 handle；父 turn 不阻塞，提示词直接编码并发纪律（"Call wait_agent very sparingly … do meaningful non-overlapping work immediately"）。
- wait_agent：多 targets **任一先完成先返回**，`AgentStatus::Completed(Option<String>)` **携带子代理最终 assistant 消息——wait 本身就是 output 载体**；超时默认 30s 夹 [10s, 1h]，超时仍返回各 target 快照。
- 完成通知：每个 ThreadSpawn 子代理配 **detached watcher**，终态时 `inject_fragment_without_turn`（user-role `<subagent_notification>`，V2 走信箱 `trigger_turn:false`）——**只记录进上下文，绝不唤醒空闲父**；与 wait 内容相同（"a notification message will be received containing the same completed status"）。
- 生命周期两层正交：内存 AgentStatus 七态（事件派生）+ 磁盘 Open/Closed 边（SQLite agent-graph-store）；close_agent 树状级联 shutdown 并 flush rollout；**父结束/空闲不杀子**；进程退出后 rollout + Open 边留存，resume_agent 按 id 复活并沿 Open 边递归复活后代。
- send_input：`start_or_steer_turn`——子 idle→新 turn（Started），在跑→steer（Steered），对外只回 opaque submission_id；`interrupt:true` 先打断再投递；目标已卸载先从 rollout 重载。
- 并发：硬上限超限即拒（AgentLimitReached），**已完成 agent 计入额度直到 close**（工具描述明确告知模型 close 释放额度）；深度默认 1，spawn/resume 双侧检查，超限文案 "Agent depth limit reached. Solve the task yourself."。
- 子代理无墙钟超时、close 无宽限参数；fork_context 只支持父→子单向历史继承（按白名单过滤）。

## 5. 对 pi-ptc 的直接结论（建图会话已锁定）

1. **destination 形态四方共识**：spawn 立即返回 + 模型面管理工具 + 完成信号 + 持久化，无一家停在半路。
2. **spawn 留在 PTC 程序里**（`pi.dispatch` binding 加 background 语义），模型面只加管理工具——kimicode/mcode 的"管理工具与 spawn 分离"共同支持。
3. **完成通知自动 + 唤醒 idle**（kimicode/mcode 立场，codex 不唤醒、Reasonix 被动为反例），配 mcode 式投递限速兜底唤醒循环。
4. **通知分档**（kimicode 形态）：小结果内联、大结果走 ADR-0015 截断契约文件 + preview；不采 codex 全文携带、不采 mcode 纯指针。
5. **子代理持久化 session 文件**（四方共识的地基），前置核查 pi 选择器污染；复活工具不进 v1，采 Reasonix 硬规则"interrupted 拒续、完成态才可续"。
6. **抄 mcode 7 态机**（显式迁移校验 + 单一 terminal 写入器）；**并发维持 8 硬上限**（codex 同为即拒；已完成任务不占额度）；**会话中止 ≠ 任务终止**分层（Reasonix 设计意图，现 run-AbortSignal 直杀语义必须拆开）。
7. 不造批量（PTC JS 即批量引擎）；不给父模型流式子进度（四方一致只给 UI）。
