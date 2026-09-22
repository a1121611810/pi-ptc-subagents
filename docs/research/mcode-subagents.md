# mcode (MiniMax Code) 对子代理的做法

> 调研日期:2026-09-23
> 来源: https://github.com/MiniMax-AI/minimax-code/ (GitHub API 描述:"An open-source coding agent for your terminal, powered by MiniMax",1.7k+ stars)
> 默认分支: main,快照 commit bcb1d96553e06bf2a0d44d06f40ac79350696465
> 本调研基于对该仓库浅克隆 (/tmp/minimax-code) 后的源码阅读,不引用未直接核对的二手描述。仓库中并没有一份独立的 "subagent design doc",设计意图散落在工具描述字符串、注释和模块边界上,所以下文每节都先标出主源文件路径。

---

## 0. 一句话总结

mcode 把 "启动一个子代理" 这件事建模成统一的 `BackgroundTask` 对象,通过同一个状态机、同一种持久化行、同一种 "父↔子" 关系驱动 bash 长任务、子代理、workflow、自定义 agent 四类工作。"子代理" 因此不是单独子系统,而是 `BackgroundTask.kind === 'subagent'` 的一个具体 kind;而 "它是什么角色、能不能写文件、跑前台还是后台、由谁调度" 由 `canonicalRole` / `executionMode` / `TaskRunner` / `filterCanonicalNativeToolCeiling` 这些正交维度一起决定。

---

## 1. 仓库全景与子代理相关包

- `packages/agent-tools` — 子代理对外的工具面 (模型看得到的 `task` / `task_append` / `task_query` / `task_output` / `task_stop`、内置 `subagent-roles`、`canonical-tool-policy`)。
- `packages/agent-modules/background-task` — `BackgroundTaskManager` + 状态机 + 持久化抽象 (`@mavis/background-task`)。
- `packages/local-runtime/src/background-task` — 子代理执行的实现: `domain.ts`、`subagent-task-row.ts`、`runner.ts`、`task-query.ts`、`terminal.ts`、`delivery.ts` 等。
- `packages/local-runtime/src/api/local-task-*.ts` — 实际跑子代理的入口: `local-task-runner.ts`、`local-task-subagents.ts`、`local-task-append-lifecycle.ts`、`injected-conversation-task-turn.ts`。
- `packages/shared/src/subagent-roles.ts` — 角色单一事实源 (`@mavis/shared/subagent-roles`),被工具描述字符串、`filterCanonicalNativeToolCeiling`、agent 解析共用。
- `packages/tui/src/tui/agent-team/model.ts` — TUI 侧的 "agent team" 投影,把每个子会话聚合成一个可见成员,带状态/活动/工具计数。
- `packages/config/src/agent-capabilities.ts` — `AgentCapabilityConfig.features.delegation`,即子代理的全局开关。

> `docs/architecture.md` 明确写到: "The unused `@mavis/team` cycle engine is excluded from this projection. TUI delegation uses the current runtime task services." — 也就是说历史上曾有一个 `@mavis/team` 周期引擎,但目前的 TUI delegation 走的是 runtime task services。这是个常被错过的退路说明,值得在引用 mcode 时区分 "现在的" 和 "以前"。

---

## 2. 工具面: 模型看到的就是这 5 个

主源: `packages/agent-tools/src/desktop/index.ts` (`buildLocalToolRegistry` 注册顺序) 与 `packages/agent-tools/src/desktop/builtin-defs.ts` (具体 schema)。

| 工具          | 行为                                           | 备注                                                    |
| ------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `task`        | 启动一个子代理,返回 `task_id`                  | 默认前台阻塞; `run_in_background=true` 立即返回 id。    |
| `task_append` | 给已存在的 `task_id` 追加内容                  | 返回三种 ack: `activated` / `steered` / `duplicate`。   |
| `task_query`  | 列出或查询任务,支持按状态过滤                  | 用于跨子代理盘点。                                      |
| `task_output` | 按 `offset` 增量读子代理输出, `wait_ms` 限 30s | 完成后由 `<background-task-finished>` 通知,而不是轮询。 |
| `task_stop`   | 停止任务 (queued 取消、running 中止子 session) | —                                                       |

`task` 的 schema (精简):

```ts
{
  description: string;        // 子会话标题
  prompt: string;             // 自包含的"用户第一消息"
  agent_name: string;         // mavis | explore | worker | verifier | agent:<stable> | <custom name>
  model?: string;             // 仅当用户明确指定
  effort?: string;            // 仅当用户明确指定
  run_in_background?: boolean;
}
```

`LOCAL_TASK_TOOL_DESCRIPTION` 里把 "何时用、用哪种 agent、上下文、并行执行" 四段写成了模型可见提示,几处关键约束:

- 子没有父历史, `prompt` 必须 self-contained。
- 父负责解读、scope、决策与最终交付; 子只负责 "按 contract 给出 evidence"。
- 前台默认; 后台仅用于 "继续做不重叠的事"; 完成时自动唤醒 owner,不要 polling。
- 继续子代理用 `task_append(task_id)`,而不要新开 task。
- "Parallel writers must own disjoint files; otherwise use one writer serially." — 即并行要求文件互斥。

工具描述里的 "等价指引" (`roleDirectoryText`) 是模型唯一可见的目录:

```text
- mavis    — Broad or mixed-scope work that does not fit a specialist role.
- explore  — Read-only mapping for unfamiliar, cross-file, or evidence-heavy questions...
- worker   — Bounded production work with explicit scope, ownership, deliverable, and acceptance.
- verifier — Independently validate an existing deliverable and report findings; no project-file changes...
```

主源: `packages/shared/src/subagent-roles.ts:roleDirectoryText()`。

---

## 3. 角色模型: explore / worker / verifier + mavis

主源: `packages/shared/src/subagent-roles.ts` (同源消费方: `canonical-tool-policy.ts`、`local-task.ts` 工具描述)。

```ts
export type CanonicalSubagentRole = "explore" | "worker" | "verifier";
export const SUBAGENT_ROLES = {
  explore: { whenToUse: "Read-only mapping ..." },
  worker: { whenToUse: "Bounded production work ..." },
  verifier: { whenToUse: "Independently validate an existing deliverable ..." },
} as const;
```

关键设计点 (都直接读自该文件):

1. 角色是 canonical names,不是用户可定义的字符串。`RESERVED_SUBAGENT_NAMES = [...CANONICAL_SUBAGENT_ROLES, 'main', 'mavis']`,用户的自定义 Agent 不能直接占用这些裸名,要写 `agent:<stable-name>`。
2. `mavis` 是另一个顶级别名 (非 canonical role)。`TASK_AGENT_TARGETS = ['mavis', ...CANONICAL_SUBAGENT_ROLES]`,所以模型看到 4 个名字,其中 3 个走天顶板裁剪, `mavis` 不裁剪。
3. 角色裁剪只对 builtin 生效。`filterCanonicalNativeToolCeiling` 的判据是 `builtinAgent === true && isCanonicalSubagentRole(canonicalRole)`。一个 "被用户声明但不是 builtin" 的 agent 不享受默认天顶板; `README.md:209` 一行 "use subagents" 也只是能力声明。
4. 每个角色的工具天顶板 (主源: `canonical-tool-policy.ts`):

   | 角色       | 工具削减                                                                                                                                |
   | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
   | `worker`   | 禁掉 `task` / `task_append` (不可再分委)                                                                                                |
   | `explore`  | 禁掉 write/edit/deploy/todowrite/task*/memory/ask_user/feature_enable/任何 `desktop_*`,保留 task_query/task_output/task_stop 用于读别人 |
   | `verifier` | 同 explore,且不保留 task_query/task_output/task_stop                                                                                    |

   MCP 维度: explore 与 verifier 只保留内置 Matrix 的 `web_search`,Worker/自定义保留配置入口集。函数: `filterCanonicalBuiltinMcpEntries`。

5. `verifier` 有显式的 `agentRole`。`local-task-runner.ts`:
   ```ts
   ...(target.canonicalRole === 'verifier' && target.trustedBuiltin
     ? { agentRole: 'verifier' as const }
     : {}),
   ```
   其它角色 (包括 worker) 没有显式 agentRole。
6. `verifier` 的产物模型。主源: `task-verification.ts`。verifier 子代理的输出文本里需要出现一行 `VERDICT: PASS|FAIL|PARTIAL`,被解析成 `ModelVerdict`; `formatLocalTaskParentReport` 把 verdict + file_change 观察 + final_text 一起结构化喂给父。

---

## 4. 状态机与存储: 同一个 BackgroundTask

主源: `packages/local-runtime/src/background-task/domain.ts`、`packages/agent-modules/background-task/src/manager.ts`。

```ts
type BackgroundTaskKind = "bash" | "subagent" | "workflow" | "custom";
type BackgroundTaskStatus =
  "queued" | "running" | "stopping" | "succeeded" | "failed" | "canceled" | "lost";
```

合法迁移 (`canTransitionTaskStatus`):

- queued → running / stopping / 任意 terminal
- running → stopping / 任意 terminal
- stopping → 任意 terminal
- terminal 状态不可迁移

`BackgroundTask` 行除了基础字段 (taskId、kind、status、ownerSessionId、createdAt、updatedAt、startedAt、endedAt、outputRef、lastError、usage、metadata),还有几个直接服务子代理的字段:

| 字段                                                                                                                                                                                           | 含义                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `parentTaskId`                                                                                                                                                                                 | 任务树 (append 时用)                                                                        |
| `parentMessageId` / `toolCallId`                                                                                                                                                               | 把 task 跟父 turn 的某条 tool call 钉住                                                     |
| `outputRef`                                                                                                                                                                                    | 指向 `TaskOutputStore` 中一段可分页读的输出                                                 |
| `deliveredAt`                                                                                                                                                                                  | 幂等消费闩: 已交付过 (owner 主动读或前台同步交付),不再发第二次 `<background-task-finished>` |
| `metadata.parentSessionId` / `parentTurnId` / `agentName` / `requestedAgentName` / `resolvedAgentName` / `trustedBuiltin` / `canonicalRole` / `childSessionId` / `subTurnId` / `executionMode` | 子代理上下文快照,所有这些都允许 `task_query` / checkpoint 重建时还原                        |

执行模型是 `TaskManager` + 注册的 `TaskRunner` (主源: `manager.ts`):

- `DefaultBackgroundTaskManager.start(kind, input)` 走 `runner.start(task, input)` 拿 `outputRef`,然后改 status= `running`。
- `complete(id)` 把 `outputRef` / `usage` / `metadata` 写回; `fail(id, error)` 写 lastError。
- `stop(id, reason)` 走 `stopping → runner.stop → canceled`, 总是以 `canceled` 收尾,即便 runner.stop 抛错。
- 每次状态变化通过 `TaskLifecycleEvent` 序列发出 (`created` / `started` / `output_updated` / `stop_requested` / `status_changed` / `completed`)。

设计取舍值得记一下:

- `deliveredAt` 的存在 (主源: 同文件注释) 显式区分 "自动唤醒通知" 和 "owner 已读取或前台同步交付":同一份结果只能 "送达一次",避免重复触发 `<background-task-finished>`。
- `lost` 状态: `startup-recovery.ts` 在启动时把所有非 terminal 行扫描一遍,孤儿 (进程已不存在) → `lost`,给 owner 一次主动 `task_output` / `task_stop` 的机会。
- `checkpoint-snapshot.ts`: 压缩输出到 checkpoint,只保留前 N 条非 terminal 任务摘要 + 总数 + 截止时间,模型上下文吃不下所有 task 时靠它 "瘦身"。提示语 `"Call task_query for the live task list, then task_output(task_id) for progress or results."` 是模型侧的恢复路径。

---

## 5. 执行入口与三种 execution mode

主源: `packages/local-runtime/src/api/local-task-runner.ts`、`local-task-append-lifecycle.ts`、`subagent-task-row.ts`。

子代理任务的 "创建→行→跑子会话→收尾" 主流程:

```
task 工具 ─▶ buildLocalTaskAdapter()
              ├─ runForeground() ─▶ runForegroundLocalTask()
              └─ startBackground() ─▶ startBackgroundLocalTask()
                                  │
                                  ├─ createLocalSubagentTaskRow({ executionMode: 'foreground'|'background' })
                                  ├─ agentRoutes.createSession({ sessionType: 'branch',
                                  │                              sessionKind: 'task',
                                  │                              parentSessionId,
                                  │                              visibility: 'hidden' })
                                  ├─ backgroundTaskService.patch({ status: 'running',
                                  │                                    metadata.childSessionId })
                                  ├─ runInjectedConversationTaskTurn({ agentRole: 'verifier' | undefined })
                                  └─ persistLocalSubagentTaskTerminal({ delivery: 'already-delivered' | 'schedule' })
```

`executionMode` 三态 (主源: `subagent-task-row.ts` 的注释):

| mode         | 何时进入                               | task 行表现                                               | 结果交付                                                            |
| ------------ | -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `foreground` | `task` 默认                            | status=queued→running,等同于 background                   | `delivery: 'already-delivered'`,不会触发 owner 完成通知             |
| `background` | `task` 带 `run_in_background=true`     | 同上,但父 turn 不阻塞                                     | `delivery: 'schedule'`,完成时通过 `<background-task-finished>` 唤醒 |
| `append`     | `task_append` 把内容注入已在跑的子会话 | status 直接 `running` (不是 queued,因为 turn 已 admitted) | 同上 schedule                                                       |

`append` 的额外设计 (主源: `local-task-append-lifecycle.ts` + `LOCAL_TASK_APPEND_TOOL_DESCRIPTION`) — 三种 ack:

- `activated` — child 空闲,新 Turn,返回 新的 task_id
- `steered` — child 已在跑,内容并入正在跑的 Turn,返回的还是那个 running 的 task_id,且无法从这个 Turn 中拆出来
- `duplicate` — 完全相同的请求已经 admission 过,返回原 task_id,不重复交付

`append` 还有 "激活后、还没收到 ack" 就崩了的兜底: `persistActivatedAppendAdmissionFailure` 用同一个 `persistLocalSubagentTaskTerminal` 把状态打回去,保证 row 不会悬空。

---

## 6. 子会话、父子链、隐藏性

主源: `local-task-runner.ts:agentRoutes.createSession({...})`。

每个子代理都被实体化为:

```ts
{
  agentName,
  workspaceDir,                  // 继承父 session
  sessionType: 'branch',
  sessionKind: 'task',           // ← 与 'main'/'branch'/'peer' 等区分
  parentSessionId,
  title: taskInput.description,
  visibility: 'hidden',          // 默认不在 TUI agent team 主列表,但仍然可显式 join
  purpose: `local-task:<parentTurnId>:<toolCallId>`,
  ...runLocation, appMode, taskModelSelection
}
```

也就是说:

- 子代理是真实的子 session,不只是 "在父 turn 里再开一段模型调用"。
- 子代理不可见于 TUI 默认列表 (`visibility: 'hidden'`),但在 TUI 的 agent team 投影里被显式列出来 (`TuiAgentTeamProjection`)。
- 子任务与父 task 通过 `metadata.parentSessionId` + `metadata.parentTurnId` + `task.parentTaskId` 双向可链。
- `purpose` 字段保留到 `LocalSessionRecord`,用于审计与恢复。

---

## 7. Capability 开关与 TUI 投影

主源: `packages/config/src/agent-capabilities.ts`、`packages/tui/src/tui/agent-team/model.ts`。

`AgentCapabilityConfig`:

```ts
{
  modelConfigId?: string;
  persona?: { enabled?: boolean };
  tools?: AgentBuiltinToolId[];            // 显式枚举,空数组 = 全禁
  builtinTools?: AgentBuiltinMcpToolId[];
  skills?: AgentBuiltinSkillId[];
  features?: {
    mavis?: boolean;
    delegation?: boolean;                  // ← 子代理总开关
    webSearch?: boolean;
  };
}
```

`AGENT_BUILTIN_TOOL_IDS` 里写死包含 `task_query / task_output / task_stop`, `task` 与 `task_append` 故意不在内置 tool id 列表里 — 它们是通过 "用户拉起子代理" 的能力开关打开的 (`features.delegation`),而不是单纯的工具白名单。

TUI 侧 (`TuiAgentTeamProjection`):

- 每个子代理被映射成 `TuiAgentTeamMember`: `sessionId / parentSessionId / agentName / task / status / phase / activity / toolCount / turnId / startedAtMs / updatedAtMs / errorMessage`。
- `status`: failed / waiting / running / queued / done / stopped
- `phase`: failed / waiting / thinking / tool / running / done / stopped / responding
- `summarize()` 输出 6 桶计数 + total。
- `tuiAgentTeamMemberLabel()` 沿 `parentSessionId` 链向上最多走 4 层,产出 `parent › child › grandchild` 文本。
- `applyStreamEvent` 把子会话的 delta / message / session-status / error 折算回 member 的 status/phase/activity/tool 计数。
- `markWaiting(member.activity)` 给 "等用户输入" 的状态; `markDone(sessionId, turnId)` 收敛到 done。

要点: 这是一个纯函数式的 projection,输入是 `(delegated agents, active runs, nowMs)`,没有副作用。`replace()` 每轮重渲,有调换保护 (`preservesTerminalStatus` / `settlesObservedTurn`) 避免状态跳变。

---

## 8. Telemetry 与可观测性

主源: `packages/local-runtime/src/agent/subagent-telemetry.ts`、调用点 `local-task-subagents.ts`。

埋点类别:

- `SUBAGENT_TELEMETRY_EVENT.resolve` — 名字解析成功/失败
- `SUBAGENT_TELEMETRY_EVENT.finish` — 通过 `createSubagentFinishTelemetrySink(host, canonicalRole | resolvedAgentName, executionMode)` 在 `runInjectedConversationTaskTurn` 的 `onFinish` 里发出

`inferNameResolutionSource(requestedName, resolved?)` 用于区分请求名是 builtin 还是用户 custom。

---

## 9. 几个有意思的工程取舍

把分散在各处的关键决策聚一下:

1. 统一后台任务抽象,不单建子代理子系统。`bash / subagent / workflow / custom` 共享一个 `BackgroundTaskManager` + 同一状态机; 新加一类工作只需注册一个 `TaskRunner`。
2. 前台也走 task row,失败留 terminal,owner 可重读。`runForegroundLocalTask` 的注释直接说: "A foreground run uses the same task state machine as a background one, so an exception anywhere below still leaves a terminal row with an output the owner can re-read through task_output."
3. 任务 = 行 = 可恢复。`startup-recovery.ts` + `lost` 状态让跨重启的孤儿 task 永远有归宿。
4. `deliveredAt` 单次送达闩,避免自动完成通知和 owner 主动读双发。
5. 角色是 canonical names,且只对 builtin 生效 (`filterCanonicalNativeToolCeiling` 的判据包含 `builtinAgent === true`),不让 user-defined Agent 蹭默认天顶板; 同时保留 `agent:<stable>` 显式选择用户 Agent 的口子。
6. explore/verifier 禁掉 `task*` 委派; worker 禁掉再委派 (留 read-only 控制); 即 "角色" 是正交的 "我能做什么工具" 的网格。
7. verifier 有显式 agentRole 和 ModelVerdict 协议。子代理输出里要带 `VERDICT: PASS|FAIL|PARTIAL`,被父用 `parseModelVerdict` 解析并通过 `formatLocalTaskParentReport` 结构化报告,父只看 verdict + file_change + final_text。
8. `task_append` 的三态 ack (activated/steered/duplicate) 明确告诉模型 steer 不能拆 Turn,避免模型再发一次 "等它回答" 造成重复。
9. 每个子代理都是真实子 session,有 `visibility: 'hidden'` 与 TUI agent team 投影两个不同的可见层。
10. TUI 投影纯函数化 + 父子链最多展示 4 层,避免 agent 树过深刷屏。
11. 历史教训写在 architecture 里: `docs/architecture.md` 注释掉了废弃的 `@mavis/team` cycle engine,提醒读者 "现在的 delegation 是 runtime task services,不是 cycle engine"。

---

## 10. 与 pi-subagents 的潜在对照点 (供后续对比)

调研是为 `pi-ptc-subagents` 做的,这里只列 mcode 侧的事实,不做评判:

- mcode 把 `task` 当成普通工具,由模型通过工具调用启动。pi-subagents 的 `subagent` 也是工具,但 PTC 模式下模型不直接调工具,而是把一段 TS 程序返回,程序里再调用 `tools.subagent({...})`。两者抽象层级不一样。
- mcode 的子代理是真实子 session + task row 的二重结构,有持久化、可恢复、状态机。pi-subagents 的 subagent 是否走同样的 "父↔子 session ↔ BackgroundTask" 还是只走 "子 agent 实例 + 输出引用",需要在子代理实现里直接核 (`@earendil-works/pi-coding-agent` 的 subagent 路径)。
- mcode 的角色 / canonical-tool-policy 是显式声明在 `@mavis/shared/subagent-roles`,全仓共用。pi-subagents 的角色如果是写在 TUI 端或 SDK 端,共享性会弱一档。
- mcode 的 `task_append` 三态 ack 与 "steered 不可拆 Turn" 是个值得抄的语义。

---

## 11. 主源文件索引 (便于复检)

按主题分组:

角色 & 天顶板:

- `packages/shared/src/subagent-roles.ts`
- `packages/agent-tools/src/desktop/subagent-roles.ts` (纯 re-export)
- `packages/agent-tools/src/desktop/canonical-tool-policy.ts`

工具面:

- `packages/agent-tools/src/desktop/builtin-defs.ts` (所有 `*ToolDef` schema)
- `packages/agent-tools/src/desktop/index.ts` (`buildLocalToolRegistry` 注册顺序)
- `packages/agent-tools/src/desktop/local-task-control.ts` (query/output/stop)
- `packages/agent-tools/src/desktop/task-verification.ts` (ModelVerdict + 父报告)
- `packages/agent-tools/src/desktop/types.ts` (adapter 接口)

任务模型 & 状态机:

- `packages/agent-modules/background-task/src/manager.ts` (DefaultBackgroundTaskManager)
- `packages/agent-modules/background-task/src/types.ts`
- `packages/local-runtime/src/background-task/domain.ts` (BackgroundTask, 状态迁移, output store 接口)
- `packages/local-runtime/src/background-task/subagent-task-row.ts` (queued 行模板)
- `packages/local-runtime/src/background-task/runner.ts`
- `packages/local-runtime/src/background-task/terminal.ts`
- `packages/local-runtime/src/background-task/startup-recovery.ts`
- `packages/local-runtime/src/background-task/checkpoint-snapshot.ts`
- `packages/local-runtime/src/background-task/delivery.ts`

执行入口:

- `packages/local-runtime/src/api/local-task-runner.ts` (runForegroundLocalTask)
- `packages/local-runtime/src/api/local-task-append-lifecycle.ts` (三态 ack)
- `packages/local-runtime/src/api/local-task-subagents.ts` (目标解析)
- `packages/local-runtime/src/api/local-task-host.ts`
- `packages/local-runtime/src/api/local-task-input.ts`
- `packages/local-runtime/src/api/injected-conversation-task-turn.ts`
- `packages/local-runtime/src/agent/subagent-telemetry.ts`

能力 & 配置:

- `packages/config/src/agent-capabilities.ts` (features.delegation)
- `packages/config/src/config.ts`

TUI 投影:

- `packages/tui/src/tui/agent-team/model.ts` (TuiAgentTeamProjection)
- `packages/tui/src/runtime/port.ts` (TuiDelegatedAgent)

高层架构说明:

- `docs/architecture.md` (已退路的 `@mavis/team`)
- `README.md` (只 1 行: "use subagents")

---

## 12. 我没能确认的事 / 留口

- `@mavis/team` cycle engine 退路的具体时间点与原因: `docs/architecture.md` 只写了 "unused","excluded from this projection",没有 commit 指针。
- `executionMode` 在任务状态机的 closed form: `subagent-task-row.ts` 注释说 "The state machine and its domain enums are identical for all three modes",但 `runForeground` 路径上仍走 `patch({ status: 'running' })`,这与 `append` 的 "直接 `running`" 的差异是否带来边界 race,需要再看 `local-task-append-lifecycle.ts:registerAppendCompletion` 才能确认。
- verifier 是否在 `mavis` 内置的更深的语义层 (例如有专门的 verifier agent card / system prompt)。`subagent-roles.ts` 只给了 `whenToUse`,具体 persona 在仓库里没翻到独立文件 (可能在 `agents/` 或 `bundled-agents/` 等其它目录,本次未追)。

---

> 备注: 本笔记按仓库已有的 `docs/research/*.md` 习惯放在 `docs/research/mcode-subagents.md`; 后续若需要与 pi-subagents 进一步对比,建议另起一份 `mcode-vs-pi-subagents.md`。
