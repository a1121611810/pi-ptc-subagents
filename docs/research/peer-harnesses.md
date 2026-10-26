# dsh / kimicode / codex / Reasonix 的子代理做法对比

> 调研日期: 2026-09-23
> 范围: 四个 coding-agent harness 的子代理(广义: 包括 delegation / sub-task / multi-agent / review / fleet 等)的具体实现、各自优势、差异与权衡。
> 来源都是各仓库的源码与官方文档快照,**没有依赖二手描述**。
>
> 最近 commit 快照:
>
> - dsh (deepseek-ai/deepseek-harness): c36a83ff6bb95e3f82cf79f9be7c724270a8aa61 (v0.1.7-alpha.1)
> - kimicode (moonshotai/kimi-code): bb96d80748921618182369a40a6610f38fa16acb (v0.1.1)
> - codex (openai/codex): 94174e44cbc54cece45f6052328ca0c2cd7a8a2a
> - Reasonix (esengine/DeepSeek-Reasonix): 4fad310c931e4c24e267fbee20276f54a0fe6122

---

## 0. 一句话总览

四个项目都做子代理/委派,但抽象层完全不同:

| 项目     | 子代理的根本单位                                                                           | 主要工具面                                                                                     | 关键差异化                                                                       |
| -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| dsh      | Agent 实例 + 6 个 backend provider (含进程外跨业务回叫)                                    | tool-subagent + tool-subagent-control                                                          | 跨 harness 互通 (ACP, Codex, Claude Code, dsh-sdk); continuable subagent         |
| kimicode | Task(3 kind: process/agent/question) + 独立 Tower 协议 (worker/reviewer 多 agent git 协作) | AgentSwarm + 10 个 Tower 工具                                                                  | git-worktree 多 agent 协作 (mission frontmatter 文件); review 与 worker 显式分离 |
| codex    | Thread(会话级原语) + multi_agents handler 暴露的 collab 命名空间                           | spawn_agent / close_agent / resume_agent / send_input / wait                                   | 结构化 ReviewOutputEvent + ApprovalsReviewer 把子代理内置到审批路由              |
| Reasonix | ProfileExecSpec (Task/Worker/Grant/Context/Sched 5 维)                                     | task / read_only_task / explore / research / review / security_review / fleet / parallel_tasks | profile/TaskSpec 解耦; grant 只收不扩; context 不复制 transcript                 |

下面每个项目都先列直接源码证据,再做对比。

---

## 1. dsh (deepseek-harness)

### 1.1 仓库身份

- 主源: https://github.com/deepseek-ai/deepseek-harness,167M,pnpm workspace,packages + apps + vendor + native/system
- 架构风格: README.md:11 直接说 it is built on an everything-is-a-plugin architecture and powered by Cordis -- Cordis 是 Koishi 的 IoC 容器
- 同时提供 Python SDK: python/sdk/src/deepseek_harness/client.py(HarnessClient -- 同步 stdio JSON-RPC client)
- 三入口: Web (port 3080)、Desktop、CLI

### 1.2 子代理家族 -- 10 个包

主源: packages/subagent/README.md

| 包                          | 职责                                                              | ctx 键               |
| --------------------------- | ----------------------------------------------------------------- | -------------------- |
| subagent/                   | 定义委派服务: provider 注册表、一次性 run、可 continue 子级、发现 | ctx.subagents        |
| subagent-in-process-driver/ | 共享进程内 driver                                                 | --                   |
| subagent-spawn-in-process/  | 运行全新进程内子 agent                                            | 注册到 ctx.subagents |
| subagent-fork-in-process/   | 运行从父级已完成轮次派生的进程内子 agent                          | 注册到 ctx.subagents |
| subagent-acp/               | 跑进程外 ACP 子 agent                                             | 注册到 ctx.subagents |
| subagent-codex/             | 跑真 Codex 子代理 (官方 app-server 协议)                          | 注册到 ctx.subagents |
| subagent-claude-code/       | 跑真 Claude Code 子代理 (官方 Agent SDK)                          | 注册到 ctx.subagents |
| subagent-dsh-sdk/           | 跑进程外 Harness 子 (通过 TS SDK)                                 | 注册到 ctx.subagents |
| tool-subagent/              | 把委派暴露给模型                                                  | 注册到 ctx.tools     |
| tool-subagent-control/      | follow-up / interrupt / listing 给模型                            | 注册到 ctx.tools     |

关键设计: 一个 ctx.subagents 注册表,每个 backend 自描述 + 注册。父不直接 know 哪个 backend,只用 SubagentStartRequest。

### 1.3 Capabilities / fail-loud / continuable 子级

主源: docs/subsystems/subagent.md, packages/subagent/subagent/src/types.ts

- SubagentCapabilities 描述 start-time 能力,请求前检查(否则 fail loud, no silent degradation):
  - agentOptions、outputSchema、depthLimit、toolFilter、persona -- 5 个 boolean,与 SubagentStartRequest 字段一一对应
- SubagentStartRequest 字段:
  - label -- 可选短标签
  - prompt -- ContentBlock[] (子级 user message)
  - parent -- Agent,必须
  - signal -- AbortSignal,前后启动期唯一取消通道
  - agentOptions -- 模型/思考/输出 token 覆盖 (需 agentOptions capability)
  - outputSchema -- 对象根 JSON schema (需 outputSchema capability)
  - maxDepth -- 委派深度上限 (需 depthLimit capability)
  - toolFilter -- 子级工具 scoping (需 toolFilter capability)
  - persona -- 每子级 persona (需 persona capability)
- Continuable 子级 (持久化 Session + 最多一个进程内 Activation):
  - SubagentRuntime.startContinuable() -- 预留稳定 id,快照 subagent/descriptor payload,让 provider 返回 detached ContinuableCreateSpec
  - SubagentRuntime.sendMessage() -- 唯一模型授权消息操作,3 状态: running (steer 同一 Activation) / waiting (wake and steer) / no Activation (cold-resume 新 Activation)
  - SubagentInterruptAuthority = { kind: user, parentSessionId } 或 { kind: ancestor, agent } -- 严格 lineage

### 1.4 优势

1. 跨 harness 互通 (设计层面最突出)。dsh 不只是启动 dsh 子代理,它能作为 orchestrator 调起 Codex 子、Claude Code 子、另一个 Harness 子,中间通过官方协议 (ACP / app-server / Agent SDK) -- 这是其他三家都没有的。subagent-codex / subagent-claude-code / subagent-dsh-sdk 三个 backend 是把 我能调你 当成一等公民。
2. Continuable 子级 -- 子是持久化 Session + 可重复 Activation,不仅一次性,可在跨进程恢复后再次 cold-resume。
3. Provider capability 描述符 -- SubagentCapabilities 是显式的,父能精确知道这个 provider 能不能做 depthLimit / outputSchema / persona,不靠运行时 if-else。
4. Python SDK -- HarnessClient 是个 stdio JSON-RPC sync client,意味着 dsh 子能嵌入到任何 Python 项目里,不用起 Node 服务。
5. everything-is-a-plugin -- Cordis 上跑,加新 backend 不改 core。

### 1.5 缺点 / 取舍

1. 复杂度高 -- 一个委派要走过 subagent/ + driver + provider + tool layer 4 层,新读者上手曲线陡。
2. DSH SDK 模式 (subagent-dsh-sdk) 需要 Node 到 Node 之间通过 SDK 拉起另一个 Harness 进程,进程内 vs 进程外 有 6 种 backend 混在一起,语义不一致需要文档约束。
3. provider capability 严格 是优点但也是缺点 -- 调用方必须先确认 provider 支持哪种字段,如果换 backend 又卡,可能 reject。

---

## 2. kimicode (moonshotai/kimi-code)

### 2.1 仓库身份

- 主源: https://github.com/moonshotai/kimi-code,102M,pnpm workspace
- 名字直白: Kimi Code CLI -- 终端里跑的 AI coding agent
- 关键包: packages/agent-core-v2 (agent 核心), kosong (LLM 抽象), acp-server (ACP), klient (客户端)
- Native binary build (Makefile),同时提供 plugin/official/{kimi-webbridge,kimi-datasource}

### 2.2 子代理家族 -- 三层

主源: packages/agent-core-v2/src/agent/task/types.ts, packages/agent-core-v2/src/features/tower/tower.ts, packages/agent-core-v2/src/features/swarm/agent/swarm.ts

#### Layer 1: Task(基础后台任务)

AgentTask 是统一后台任务,3 种 kind 的 discriminated union:

type TaskInfo = TaskInfoBase &
| { kind: process; command: string; pid: number; exitCode: number | null }
| { kind: agent; agentId?: string; subagentType?: string; model?: string; thinkingEffort?: string }
| { kind: question; questionCount: number; toolCallId?: string };

- 状态机: running -> completed/failed/timed_out/killed/lost (5 个 terminal)
- AgentTaskSink -- { signal, appendOutput(chunk), settle(settlement) }
- AgentTask.start(sink) -- 启动即 fire-and-forget

子代理就是 kind: agent 这一种,共享 process/question 的状态机。这点和 mcode 的所有子代理都走同一个 BackgroundTask 思路类似。

#### Layer 2: Swarm(批量并行 subagent)

主源: packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agent-swarm.md

- 工具: AgentSwarm -- 一次调起多个子代理,模板 {{item}} 占位符
- prompt_template 或 resume_agent_ids,二选一(也可两者都用)
- 最多 128 个,launches 排队自动
- 每条子代理独立 prompt,模型行为可独立并行
- 关键规则: If AgentSwarm is called, that call must be the only tool call in the response -- 不允许在同一 turn 里和其它工具混用

#### Layer 3: Tower(git-worktree 多 agent 协作)

主源: packages/agent-core-v2/src/features/tower/tower.ts, towerService.ts, protocol/store.ts

- 实验特性 KIMI_CODE_EXPERIMENTAL_TOWER=1 或 config [experimental] tower = true
- 关键约束: tower mode is only supported by the main agent (其它 agent 调 TowerSpawn 直接拒)
- 协议层: WORKTREES_DIR, MISSIONS_DIR, baseWip, TowerStore, TowerProtocolError
- 角色: tower-worker profile(pinned permission mode),reviewer
- 工具面(10 个): TowerPlan, TowerSpawn, TowerMerge, TowerTeardown, TowerSend, TowerInbox, TowerFinding, TowerReview, TowerMission, TowerStatus
- Spawn 流程:
  - 创建 mission worktree
  - 如果 base checkout 有未提交改动,会被 snapshot 成 mission branch 的第一个 commit
  - briefing prompt 由工具装配(worktree path, scope, protocol rules); instructions 只放额外上下文
  - TowerMerge 把 mission branch merge 回主分支
- 子代理发消息: TowerSend (发送) + TowerInbox (收件箱) -- 走 TowerStore 持久化
- TowerRateLimitService -- 速率限制

### 2.3 优势

1. git-worktree 是天然的多 agent sandbox。每个 worker 在独立 worktree 里,merge 是显式的 git 操作,review 是单独角色(mission file 在 MISSIONS_DIR 用 frontmatter 描述),无歧义。
2. 三层抽象 非常清晰: 基础 Task (process/agent/question) -> Swarm (批量并行) -> Tower (git 协作),各管一层,互不打扰。
3. review 与 worker 显式分离 -- review 是个独立 profile,不是 worker 兼任的; TowerReview 工具拉起独立评审,避免自我审视偏差。
4. Swarm 模板化批量 prompt_template + {{item}} 非常工程化,适合同一类任务对多输入的场景(例如对 N 个文件做同一类检查)。
5. mission frontmatter 文件系统 -- 任务持久化用人类可读 frontmatter (类似 YAML),与 git 自然融合。

### 2.4 缺点 / 取舍

1. Tower 还是 experiment -- 还没稳定,需要显式 flag 开启。
2. 子代理强绑 git -- Tower 协议假设你有 git worktree,非 git 项目下用不了 (其它层 Task/Swarm 不受影响)。
3. main-agent-only 强约束 -- 限制了在子 agent 内递归开 Tower 的能力。
4. 状态机粒度比 mcode 略粗 -- mcode 有 queued/running/stopping/... 7 个,kimicode 只有 6 个 (running + 5 terminal),没有 stopping 状态。

---

## 3. codex (openai/codex)

### 3.1 仓库身份

- 主源: https://github.com/openai/codex,120M
- Bazel monorepo (BUILD.bazel + MODULE.bazel),不是 pnpm/yarn
- 两个实现: codex-cli (TS,轻量 npm 包装) + codex-rs (Rust,核心) -- 主要逻辑在 Rust
- 大量 crate (codex-rs/ 下 50+ 个子 crate),分为 core / tools / app-server / mcp / chatgpt / 等

### 3.2 子代理 -- 真正的 Thread-as-Agent

主源: codex-rs/core/src/tools/handlers/multi_agents.rs (99 行,内含 5 个子模块), codex-rs/agent-graph-store/src/, codex-rs/agent-roles/src/

#### 3.2.1 抽象原语: Thread

codex-rs/agent-graph-store/src/lib.rs 第一行注释: Storage-neutral parent/child topology for thread-spawned agents.

- ThreadSpawnEdgeStatus = Open / Closed (简单二元生命周期)
- LocalAgentGraphStore -- 存储中立,可以是本地 / server
- 子代理 = 一个新的 Thread,挂在 ThreadSpawnEdge 上

#### 3.2.2 工具面(命名空间 collab_)

主源: codex-rs/core/src/tools/handlers/multi_agents.rs:97-106

5 个 handler:

- spawn_agent -- 启动
- close_agent -- 关闭
- resume_agent -- 恢复
- send_input -- 发送消息
- wait -- 等待

ToolName::namespaced(MULTI_AGENT_V1_NAMESPACE, spawn_agent) -- 命名空间化(multi_agent_v1),通过 ToolSearchSourceInfo 给模型搜索。

#### 3.2.3 深度限制 + 配置继承

codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:

- next_thread_spawn_depth(&session_source) -- 计算当前深度
- agent_max_depth -- 配置上限
- exceeds_thread_spawn_depth_limit(child_depth, max_depth) -- 超过深度直接拒,返回错误 Agent depth limit reached. Solve the task yourself.
- 子代理继承 runtime-only state (provider, approval policy, sandbox, cwd),然后 layer role-specific config on top
- SpawnAgentForkMode -- spawn 时 fork 父历史或不 fork
- SpawnConfigOptions + SpawnConfigVersion + prepare_agent_spawn_config -- 子代理配置准备

#### 3.2.4 Agent Roles -- 用户配置

主源: codex-rs/agent-roles/src/agent_role_config.rs

- AgentRoleConfig = { description?, config_file?, nickname_candidates? }
- TOML 格式,放在配置文件目录里
- ResolvedAgentRoleFile = { role_name, description, nickname_candidates, config }
- 启动 spawn 时可指定 role name, profile 加载后 layer

#### 3.2.5 Review/Guardian -- 内置到审批路由

主源: codex-rs/protocol/src/config_types.rs:183

pub enum ApprovalsReviewer {
#[default]
User,
#[serde(rename = auto_review, alias = guardian_subagent)]
AutoReview,
}

注释直接说: auto_review uses a carefully prompted subagent to gather relevant context and apply a risk-based decision framework before approving or denying the request.

也就是说,Codex 把 子代理 当成 审批路由器的一个分支,而不是通用的委派工具。当 sandbox escape / blocked network / MCP approval / ARC escalation 这些需要用户确认的事件到来时,可路由到 user 或 auto_review。

ReviewTarget = UncommittedChanges | BaseBranch | Commit | Custom -- review 是个有结构的 protocol,不是 通用的 task。

ReviewOutputEvent = { findings, overall_correctness, overall_explanation, overall_confidence_score } -- 结构化 review 结果。

#### 3.2.6 Guardian MCP

主源: codex-rs/core/tests/suite/codex_delegate.rs -- build_review_delegate / build_guardian_delegate

codex_delegate_rejects_escalation_requests_when_parent_can_prompt / codex_delegate_rejects_legacy_mcp_approvals_without_prompting -- guardian 子代理处理 MCP elicitation。

子代理继承 restricted permission profile(guardian_delegate 应该 inherit a restricted permission profile)。

### 3.3 优势

1. 结构化 Review 是核心 -- ReviewRequest + ReviewOutputEvent 是 typed protocol,而不是 verifier 输出文本里写 VERDICT 这种约定。
2. 深度硬限制 -- agent_max_depth 在配置层强制,超过直接报错,不允许无限递归。
3. 多 agent 隔离的 permission profile -- review / guardian 子代理 inherit restricted profile,从设计源头避免越权。
4. Rust 实现 + Bazel monorepo -- 性能 + 工程纪律。
5. 跨进程 agent 协议 (MCP) -- Codex 提供 codex-mcp crate,外部 agent 可以通过 MCP 把 Codex 当子代理调。
6. Storage-neutral graph -- agent-graph-store 设计上不绑存储,local 或 server 都行。

### 3.4 缺点 / 取舍

1. 没有通用 spawn -- 只有 collab_ 命名空间,且偏向权限路由 + 协作,不是为了 task 加速的通用 subagent (虽然 spawn_agent 是模型可见的)。
2. 命名不如 mcode/kimicode 直接 -- 用了 multi_agents、collab、guardian、reviewer 多个名字混用,初读不易判断主入口。
3. 门槛高 -- Rust + Bazel,贡献者门槛显著高于 TS-only 项目。
4. fork model 不直观 -- SpawnAgentForkMode 不像 kimicode 那样把 fork 写成 backend 一等公民(separate provider)。

---

## 4. Reasonix (esengine/DeepSeek-Reasonix)

### 4.1 仓库身份

- 主源: https://github.com/esengine/DeepSeek-Reasonix,124M,Go 模块(go.mod,没有 package.json)
- 跨平台单二进制 (CGO_ENABLED=0),npm 包 reasonix 只是 wrapper
- 核心架构: internal/control/controller.go, internal/agent/, internal/tool/, internal/skill/
- 项目级 SPEC (docs/SPEC.md + REASONIX.md) 直接写设计契约

### 4.2 子代理 -- 4 维分离的 ProfileExecSpec

主源: internal/agent/profile_spec.go

type ProfileExecSpec struct {
Task TaskSpec // what one delegated run must accomplish
Worker WorkerSpec // who carries the run out
Grant CapabilityGrant // what the run may touch
Context ContextRequest // what context the child starts from
Sched SchedulerPolicy // when and how the run executes
}

type TaskSpec struct {
Objective string
Description string
}

type WorkerSpec struct {
Kind, Name, Profile, SystemPrompt string
UseProfilePrompt bool
Model, Effort string // 已解析
}

type CapabilityGrant struct {
ReadOnly bool
AllowNoTools bool
CallTools []string // per-call
ProfileTools []string // frontmatter ceiling
WritePaths WritePathSet
}

type ContextRequest struct {
ContinueFrom, ForkFrom string
Ephemeral bool
Decisions []acceptedDecision
EvidenceSummary string
FileAnchors []string
OutputFormat string
}

type SchedulerPolicy struct {
MaxSteps, MaxOutputTokens int
RunInBackground, BackgroundWriter, Nested bool
}

每维度都有自己的不变式,REASONIX.md 写得很直白:

> Subagent boundaries: profile = worker policy/ceilings, TaskSpec = this call, CapabilityGrant = permitted resources, ContextRequest = initial context, SchedulerPolicy = scheduling. Keep per-call values out of profiles

#### 4.2.1 不变式 (核心)

1. profile 是 worker 的身份,TaskSpec 是这一次的任务 -- 调用方不能把 this call 的字段写进 profile 上(边界测试 profile_boundary_test.go)。
2. Grant 只收不扩 -- IntersectToolLists 注释:
   - 两边都空 -> nil (all tools)
   - 一边空 -> 另一边的
   - 两边都有 -> 求交;空交 = error(无法扩大权限)
   - profile 设上限,call 只能 narrowing
3. Context 不复制 transcript -- 只传 Decisions, EvidenceSummary, FileAnchors, OutputFormat;父 transcript 不被复制(避免 prompt-cache 不稳定 + 信息泄露)。
4. Fork/Continue 路径 -- ContextRequest.ContinueFrom / ForkFrom 是 transcript 续接引用(写入路径),不是 I/O。

### 4.3 工具面 -- 7 个工具

主源: internal/agent/task.go (subagentRecursiveTools / subagentAlwaysHiddenTools)

| 工具                                          | 用途                                     | 类别     |
| --------------------------------------------- | ---------------------------------------- | -------- |
| task                                          | 启动子代理 (write)                       | 委派     |
| read_only_task                                | 启动只读子代理                           | 委派     |
| run_skill                                     | 按 skill profile 跑                      | 委派     |
| read_only_skill                               | 按 skill profile 跑,只读                 | 委派     |
| explore / research / review / security_review | 内置 profile 入口                        | built-in |
| parallel_tasks                                | 并行 dispatch 多个 read-only 子代理      | 批量     |
| fleet                                         | 批量 2-64 个,有依赖图 + write_paths 互斥 | 批量     |

### 4.4 Fleet -- 图式批量

主源: internal/agent/fleet.go

- 每个 task 有 id (默认 1-based position), depends_on 数组
- Pre-flight 拒绝: unknown ids / self-edges / cycles -> 一个也不启动
- fail_fast: 第一个失败后停止启动新 task,已启动的不强制停(避免半途放弃 partial writes)
- run_in_background: 整个 fleet 作为 job 异步跑
- write_paths: writers 并行时声明互斥路径,preflight 检查
- 子任务结果返回 bounded previews + stable Subagent references(完整结果从持久化子代理查)

FleetTool 内部用 TaskTool 复用 sub-agent 基础设施 -- 不再写一套。

### 4.5 Transport-agnostic Controller

主源: internal/control/controller.go 第一段注释:

> A Controller owns the agent run loop and session lifecycle, takes commands (Send/Cancel/Approve/SetPlanMode/Compact/NewSession/...), and emits everything that happens -- reasoning, tool calls, approvals, turn completion -- as a typed event stream to a single event.Sink. The point is one orchestration layer behind every frontend: a terminal TUI, a desktop webview, or an HTTP/SSE server each drive the Controller identically... and none of them re-implement turn lifecycle, cancellation, or approval.

也就是说 Reasonix 与 dsh 同样的设计目标: 一个 controller 后面挂多种 transport(TUI / Desktop / HTTP/SSE),前端只是 event sink。

### 4.6 Default 子代理系统 prompt(直接引用 task.go)

DefaultTaskSystemPrompt: You are a sub-agent invoked by a parent coding agent to carry out one focused task.
Use the provided tools to investigate or act. For MCP, use the stable use_capability
proxy (list -> inspect -> call); do not expect direct mcp__* tool schemas. Return a
single final answer that is concise and self-contained -- the parent will see only
that answer, not your tool calls or reasoning. If you need to ask for clarification,
fail with a precise question instead of guessing.

DefaultReadOnlyTaskSystemPrompt: You are a read-only research sub-agent invoked by a parent coding agent.
...never attempt to write files, install capabilities, mutate memory, control long-lived
processes, or delegate to writer-capable agents. If a read-only delegation tool is
available and genuinely useful, you may use it within the configured depth limit.

### 4.7 优势

1. 5 维度正交分离 ProfileExecSpec -- 这是四个项目里最干净的边界设计。每维度都有显式不变式(profile = 身份,TaskSpec = 这一次,Grant = 只收不扩,Context = 不复制 transcript,Sched = 调度不干扰身份)。
2. Grant narrowing (IntersectToolLists 求交) -- 从语言层面把 profile 是上限、call 只能 narrower 做成了 API。空交集直接 error,不可能越过 profile 上限。
3. ContextRequest 干净 -- 不复制 transcript 是其他三个都没显式写出来的;这一点对 prompt-cache 稳定 + 隐私 + 防 prompt injection 都重要。
4. Fleet 是真个有向图 -- depends_on + cycle preflight + write_paths 互斥 + fail_fast,是个显式的调度引擎。
5. subagentRecursiveTools + subagentAlwaysHiddenTools -- 显式列哪些工具在子代理里禁用(避免 forwardChild 死循环 + 移除 deprecated)。
6. transport-agnostic Controller + Go 单二进制,部署比 TS/Rust 都简单。
7. go.mod + 无外部重型依赖 (SPEC.md 写 Lean dependencies. Standard library by default.) -- 编译快,二进制小。

### 4.4 缺点 / 取舍

1. 品牌 vs 项目名不一致 -- repo 是 esengine/DeepSeek-Reasonix,但底层 namespace 是 reasonix,npm 包也是 reasonix,目录却叫 reasonix/。第一次接触需要花时间对齐。
2. fleet 复杂度中等,2-64 上限、cycle preflight 这些对模型来说都是额外心智负担。
3. prompt-cache 稳定性约束 (prompt_identity.go) -- 因为 profile 名字不能进系统提示/工具 schema,所以子代理 profile 只能是 backend 解析,模型看不到 profile 名字。这把模型基于 profile 名字选工具这条路堵了。

---

## 5. 四方横向对比

### 5.1 抽象单位

| 项目     | 子代理 =                             | 复用同一对象                                                |
| -------- | ------------------------------------ | ----------------------------------------------------------- |
| mcode    | BackgroundTask.kind = subagent       | 与 bash / workflow / custom 共用                            |
| dsh      | Agent 实例 + descriptor              | 6 个 backend provider 同一 ctx.subagents 接口               |
| kimicode | AgentTask (kind: agent) + TowerStore | 与 process / question 共用                                  |
| codex    | Thread (独立 Thread)                 | 父 thread 也是 Thread,子只是 ThreadSpawnEdge 上的 Open edge |
| Reasonix | ProfileExecSpec (5 维度)             | TaskTool 被 FleetTool 和 ParallelTasksTool 复用             |

> mcode / kimicode 都选了统一后台任务抽象,但走的子类策略不同;mcode 子类多(4 kind)、kimicode 子类少(3 kind)。dsh 选了服务注册表 + provider 的模式;codex 选了 thread 是原语的模式;Reasonix 选了 5 维度 spec 分离的模式。

### 5.2 委派的边界控制

| 项目     | 工具天花板                                                      | 调用参数                                                                       | 上下文传递                                                                              |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| mcode    | filterCanonicalNativeToolCeiling (按 builtin + canonicalRole)   | agent_name / model / effort / run_in_background                                | 子无父历史 (prompt self-contained)                                                      |
| dsh      | provider capability 描述符 (5 flags)                            | label / signal / agentOptions / outputSchema / maxDepth / toolFilter / persona | continuable 子级可持久化跨进程;fork 子级有父历史                                        |
| kimicode | worker profile = pinned permission mode                         | mission id / name / kind (worker/reviewer) / write path                        | briefing prompt 由 tool 装配(worktree path, scope, protocol rules)                      |
| codex    | agent_max_depth (硬) + restricted permission profile (guardian) | agent_type / items / fork mode                                                 | inherit runtime-only state (provider/approval/sandbox/cwd) + role-specific config layer |
| Reasonix | IntersectToolLists profile 限上限 + call 只能 narrowing         | task profile + write_paths + tools + max_steps + model + effort                | 不复制 transcript,只传 Decisions / EvidenceSummary / FileAnchors / OutputFormat         |

Reasonix 的 narrowing 规则是最显式、最严格的(code 层强制);dsh 的 capability 描述符最精细(5 flag + provider 各自声明);mcode 的天顶板是声明式但只对 builtin role 生效。

### 5.3 跨进程 / 跨 harness

| 项目     | 支持跨进程子代理                                     | 跨其他 harness                                    |
| -------- | ---------------------------------------------------- | ------------------------------------------------- |
| mcode    | 是 (subagent-acp, subagent-dsh-sdk 等)               | 是 (ACP / dsh SDK)                                |
| dsh      | 是 (in-process / out-of-process 双轨)                | 是,旗舰特性 (ACP / Codex / Claude Code / dsh SDK) |
| kimicode | 是 (Tower worker 在 worktree 里,本质跨 git worktree) | 否                                                |
| codex    | 是 (MCP / Codex agent 之间互通)                      | 限 (Codex 之间通过 MCP)                           |
| Reasonix | 否(都是 in-process)                                  | 否                                                |

结论: dsh 是唯一一个把调起其它 harness 子代理作为一等公民的项目。这也是它 README 强调 everything-is-a-plugin 的实际兑现。

### 5.4 持久化与恢复

| 项目     | 任务持久化                                                    | 子代理恢复                                             |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| mcode    | BackgroundTask 持久化(含 outputRef) + startup-recovery (lost) | 重新跑 foreground 时可重读 task_output                 |
| dsh      | Session 持久化                                                | continuable 子级可 cold-resume(新 Activation)          |
| kimicode | Task persist + TowerStore (mission frontmatter 文件)          | review mission 可 reload                               |
| codex    | rollout-trace + Thread 持久化                                 | Thread resume (close / resume_agent)                   |
| Reasonix | session/transcript + checkpoint                               | session rebind 流程(session_rebind_cleanup_test.go 等) |

### 5.5 批量并行

| 项目     | 批量入口                                            | 模型                                      | 边界                             |
| -------- | --------------------------------------------------- | ----------------------------------------- | -------------------------------- |
| mcode    | 一个 task 调用对应一个 subagent                     | 父模型发多次 task 调用                    | 父子需要 file ownership disjoint |
| dsh      | tool-subagent 同上                                  | 同上                                      | provider capability 检查         |
| kimicode | AgentSwarm (template / resume_agent_ids)            | prompt_template {{item}},128 上限         | tool call 独占 turn              |
| codex    | collab_spawn_agent 多次,无内置批量                  | 模型多次 spawn                            | agent_max_depth                  |
| Reasonix | FleetTool (2-64, 有向图) / ParallelTasksTool (只读) | depends_on / write_paths 互斥 / fail_fast | preflight 拒绝                   |

Reasonix 的 fleet 是四个里唯一有显式调度图 + write 互斥的。kimicode swarm 走模板(简单),其它两家走多次调用(无批量语义)。

### 5.6 内置角色

| 项目     | canonical / built-in 角色                                   | 角色裁剪                                                   |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| mcode    | explore / worker / verifier + mavis                         | canonical-tool-task-ceiling 按 builtin + role              |
| dsh      | provider 自带;Capability flag 控制字段 (无 canonical names) | per-request capability                                     |
| kimicode | tower-worker (pinned permission mode)                       | profile 字段                                               |
| codex    | agent_type 用户 TOML 配置 + DEFAULT_ROLE_NAME               | SpawnConfigOptions layer                                   |
| Reasonix | explore / research / review / security_review               | Profile frontmatter ceiling + IntersectToolLists narrowing |

mcode 的角色是最显式的(3 个 canonical name + 1 个通用名);Reasonix 也是 4 个,但更依赖 profile 系统;dsh/codex 不强制角色名,角色靠 provider/capability 表达。

### 5.7 错误 / 中断 / Steer 语义

| 项目     | 中断模型                                                 | Steer 语义                                         |
| -------- | -------------------------------------------------------- | -------------------------------------------------- |
| mcode    | task_stop(queued 取消 / running 中止子 session)          | task_append 三态 (activated / steered / duplicate) |
| dsh      | SubagentRuntime.interrupt() (authority: user / ancestor) | sendMessage() (running / waiting / cold-resume)    |
| kimicode | TowerTeardown                                            | TowerSend + TowerInbox(走 TowerStore)              |
| codex    | close_agent (close edge) + wait                          | send_input (走同 thread inbox)                     |
| Reasonix | stop (implicit via jobs / cancel.go)                     | read_subagent_result + turn 投递                   |

每个项目都有中断 + 后续消息 的最小组合;细节差异主要在中断后子代理能否续 和 中断后是否影响父。

---

## 6. 优势总结

### 6.1 按场景挑项目

| 场景                                                         | 推荐项目 | 原因                                                |
| ------------------------------------------------------------ | -------- | --------------------------------------------------- |
| 需要 cross-harness 委派 (Codex / Claude Code / dsh 互通)     | dsh      | 唯一一家把调起其它 harness 做成一等 backend         |
| 需要结构化 review output(typed findings + confidence)        | codex    | ReviewOutputEvent + ReviewRequest 是 typed protocol |
| 需要 git-worktree 多 agent 并行 / git-aware merge            | kimicode | Tower 是为这个场景造的                              |
| 需要清晰的子代理边界(身份 vs 任务 vs 权限 vs 上下文 vs 调度) | Reasonix | 5 维度分离 + narrowing 规则 + 不复制 transcript     |
| 需要轻量、单二进制、跨平台 CLI                               | Reasonix | Go + CGO=0 + 单二进制                               |
| 需要 Apple-style 一致 UI + 深度 TUI agent team 投影          | mcode    | 强(参见上份调研)                                    |
| 需要 Python SDK 嵌入到现有 Python 项目                       | dsh      | HarnessClient stdio JSON-RPC sync client            |

### 6.2 按优势维度挑

| 维度                   | 第一                                 | 第二                    |
| ---------------------- | ------------------------------------ | ----------------------- |
| 跨 harness 互通        | dsh                                  | codex (MCP)             |
| 跨进程子代理(本地/ACP) | dsh, mcode                           | kimicode (git worktree) |
| 结构化 review protocol | codex                                | Reasonix                |
| 批量并行               | Reasonix (fleet 图)                  | kimicode (swarm 模板)   |
| 角色天顶板             | mcode                                | Reasonix                |
| 持久化子代理           | dsh (continuable)                    | codex (Thread resume)   |
| transport-agnostic     | dsh (Cordis) + Reasonix (Controller) | mcode                   |
| 强类型 / 单二进制      | Reasonix (Go)                        | codex (Rust)            |
| 生态友好 (Python)      | dsh                                  | codex (SDK crate)       |

---

## 7. 取舍总结

| 项目             | 最大优势                                                       | 最大代价                                                         |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| dsh              | cross-harness + continuable + Python SDK                       | 6 个 backend 复杂、provider capability 严格                      |
| kimicode         | git-worktree 协作 + 三层抽象清晰                               | Tower 仍 experiment,绑 git                                       |
| codex            | 结构化 review + depth hard limit + Rust 性能                   | 没通用 spawn,门槛高(Rust+Bazel),fork 模型不直观                  |
| Reasonix         | 5 维度分离 + Grant narrowing + 不复制 transcript + Go 单二进制 | 项目命名混乱,npm 包装不是 namespace,profile 不能进 system prompt |
| mcode (上份调研) | 统一后台任务 + 角色天顶板 + 全栈(SDK+Web+TUI+Desktop)          | 5 tool 设计已收敛,新增 capability 需走 feature.delegation        |

---

## 8. 共同模式

四个项目里都能看到的共同设计模式(适合做参考):

1. 子代理 = 一个独立 execution unit + 独立 session/thread/agent,与父有明确 lineage
2. 子无父 history / 子有部分父 facts(决策、证据、文件 anchor 等),transcript 不复制(Reasonix 最显式,其它家族不到)
3. depth limit 是硬性约束(codex / dsh / Reasonix 都有,mcode 没显式 enforce)
4. task output -> task stop 这种 interface-friendly 工具面是标配
5. steer / continue 需要支持(三态 ack / sendMessage / TowerSend / spawn_agent send_input / read_subagent_result)
6. 角色天顶板 + capability 描述符 是防止子代理越权的两条路(mcode 走前者,dsh 走后者,codex 两者都有)
7. transport-agnostic core + 多种 frontend(Cordis IoC / Controller / runtime + multi frontend)
8. 跨进程子代理通过 ACP/MCP 协议 -- 这是 dsh 走得最远,codex 走 MCP,其它两家都还没做

---

## 9. 主源文件索引(便于复检)

### 9.1 dsh

- 家族 README: packages/subagent/README.md
- 子包 (packages/subagent/): subagent, subagent-in-process-driver, subagent-spawn-in-process, subagent-fork-in-process, subagent-acp, subagent-codex, subagent-claude-code, subagent-dsh-sdk, tool-subagent, tool-subagent-control
- 核心类型: packages/subagent/subagent/src/{types,lifecycle,continuation,inbox,depth,projection}.ts
- 子系统文档: docs/subsystems/subagent.md
- 设计记录: .agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md, 2026-07-28-continuable-subagent-conversations.md
- Python SDK: python/sdk/src/deepseek_harness/client.py (HarnessClient)

### 9.2 kimicode

- Task 模型: packages/agent-core-v2/src/agent/task/{types,service,ops}.ts
- Swarm: packages/agent-core-v2/src/features/swarm/agent/swarm.ts, tools/agent-swarm/agent-swarm.md
- Tower: packages/agent-core-v2/src/features/tower/{tower,towerService,towerOps,towerFeature}.ts, protocol/{store,git,frontmatter,repoRoot}.ts
- Tower tools: packages/agent-core-v2/src/features/tower/tools/{spawn,send,inbox,merge,finding,plan,teardown,status,mission,review,init}/

### 9.3 codex

- Multi-agents handler: codex-rs/core/src/tools/handlers/multi_agents.rs + multi_agents/{spawn,close_agent,resume_agent,send_input,wait}.rs
- Common: codex-rs/core/src/tools/handlers/multi_agents_common.rs, multi_agents_spec.rs
- 深度限制: codex-rs/core/src/agent.rs (exceeds_thread_spawn_depth_limit, next_thread_spawn_depth, agent_max_depth)
- Agent graph: codex-rs/agent-graph-store/src/{lib,types,store,local,error}.rs
- Agent roles: codex-rs/agent-roles/src/{agent_role_config,discovery,loader}.rs
- Review protocol: codex-rs/protocol/src/protocol.rs (ReviewRequest, ReviewTarget, ReviewOutputEvent, ReviewDelivery)
- ApprovalsReviewer: codex-rs/protocol/src/config_types.rs:183
- Tests: codex-rs/core/tests/suite/{codex_delegate,auto_review,review,guardian_*}.rs

### 9.4 Reasonix

- 子代理核心: internal/agent/{profile_spec,profile_boundary_test,task,subagent_context}.go
- Fleet: internal/agent/{fleet,parallel_tasks}.go
- Controller: internal/control/controller.go
- Inbox + steering: internal/control/{inbox,inbox_send,inbox_dispatch,inbox_steer,inbox_run}.go
- Session DAG: internal/control/{session_dag_unlocked,session_dag_rotate,fork_targets}.go
- Project docs: docs/SPEC.md, docs/EXTENSIONS.md, docs/ACP.md, REASONIX.md
- Execution contract: docs/DSH_EXECUTION_MIGRATION.md(注意: 这是 Reasonix 引用的迁移文档)

---

## 10. 我没能完全确认的事 / 留口

- dsh 的 cordis 版本差异 -- 它把插件系统托付给 Koishi 的 Cordis IoC,具体与 dsh 0.1.7-alpha.1 的兼容性是间接证据,没单独 clone Koishi 仓库核。
- kimicode 的 kosong 包 -- packages/kosong 是 LLM 抽象,只看到了 package 目录,未读其核心。
- codex 的 codex-mcp -- codex-rs/codex-mcp/ 是外部 agent 通过 MCP 调 Codex 的入口,本次未深入读其内部。
- Reasonix 的扩展协议 (internal/extension/extension_protocol_gen.go) -- Manifest v2 runtime block 是用户可控的 code extension,安全模型是 FULL TRUST;完整语义在 docs/EXTENSIONS.md,但 extension_protocol_gen.go 的具体实现未读。
- 每个项目的 e2e benchmark (dsh/benchmarks/agent-continuation/, codex/codex-rs/e2e/, reasonix/cmd/e2ebench/) -- 没读,无法评估真实性能数据。

---

> 备注: 本笔记与上份 mcode-subagents.md 配套阅读,可形成 四个 harness 的子代理抽象对比图。
