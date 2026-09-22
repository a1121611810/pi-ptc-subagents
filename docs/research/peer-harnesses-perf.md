# mcode / dsh / kimicode / codex / Reasonix -- 性能与 token 消耗对比

> 调研日期: 2026-09-23
> 范围: 上份 peer-harnesses.md 中五个 harness 的 token 计量、成本/计费、缓存、压缩(compaction)、性能基准、benchmark 框架的具体差异。
> 主源都是各仓库的源码,**没有依赖二手描述**。

---

## 0. 一句话总览

五个项目都对 token 与性能做了大量工程化,但落点不同:

| 项目     | Token 计量粒度                                           | Cache 计量                      | 账单/成本                                                  | 自动压缩                                                  | Benchmark 框架                                                         | 典型路径                                 |
| -------- | -------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| mcode    | 4 字段 (input/output/reasoning/cache)                    | 显式 cacheRead/cacheWrite       | 沿用 host 价格                                             | 完整 (algorithm+execution 8 个文件)                       | 不显式                                                                 | BpeTokenEstimator + over-estimate        |
| dsh      | 4 字段 (uncached/output/cacheRead/cacheWrite)            | 显式                            | route-pricing (路由图像定价)                               | 完整 (compaction/basic/tool-result-pruner/image-offload)  | 强 (6 个 bench, 含 100 turns + 800 reads 工作负载, median budget 强制) | token-usage-projection 作为 session 投影 |
| kimicode | 4 字段 (inputOther/output/cacheRead/cacheCreation)       | 显式 + cache probe telemetry    | 弱                                                         | 有 compaction                                             | 弱 (minidb 基准,kap-server bench)                                      | agent fork 时主动 probe 缓存命中         |
| codex    | 5 字段 (input/cached/cacheWrite/output/reasoning_output) | 显式 cached_input + cache_write | Rust 中等                                                  | 完整 (BeforeLastUserMessage / DoNotInject, 20K token cap) | 弱 (单测 + rollout_budget)                                             | reasoning_output 显式分桶                |
| Reasonix | 4 字段 (prompt/completion/cacheHit/cacheMiss)            | 显式 4 桶                       | 完整 (billing/quote.go + ledger.go + money.go, 多币种聚合) | 强 (checkpoints + evidence)                               | 极强 (e2ebench: SWE-bench + 自定义 + report + meter proxy)             | sub-agent 独立计费(ledger 4 元组键)      |

下面展开每家的具体设计与差异。

---

## 1. mcode (MiniMax Code)

### 1.1 Token 计量 -- BpeTokenEstimator + Context Manager

主源: packages/agent-modules/context-manager/src/{token-estimator,settings,provider-budget}.ts, packages/local-runtime-v2/src/service/turn-system/compaction/

- 估算器: BpeTokenEstimator 用 gpt-tokenizer 的 o200k_base (GPT-4o BPE),UTF-8 byte 上界兜底
  - 文件头注释直接写: for MiniMax / Messages-compatible endpoints it consistently over-estimates a touch (safe: earlier trigger), which is the direction we want when capacity miscalculation means a hard 4xx.
  - 即: 故意 over-estimate 防 provider 4xx,宁可提早 compact
- 结构开销: 每条消息 +4 tokens (role wrappers + delimiters),图像块按 4800 tokens 算
- 触发阈值: computeCompactionTriggerAt:
  - MiniMax-M3 (512K/1M) 用 90% 线
  - 其它: Math.max(reserveTokens, perTurnMaxTokens + safetyMargin)
- 默认配置 (DEFAULT_CONTEXT_MANAGER_SETTINGS):
  - reserveTokens: 16_384 (为 output 预留 16K)
  - keepRecentTokens: 20_000 (保留最近 20K tokens)
  - minMessagesToCompact: 4 (至少 4 条消息才能 compact)
  - safetyMarginTokens: 2_048
- 预算分配: resolveCompactionTokenBudget:
  - PROVIDER_INPUT_RATIO = 0.95
  - providerInputLimit = min(floor(W * 0.95), W - reserve, W - effectiveOutput - safety)
  - automaticTriggerAt = min(providerInputLimit, W - proactiveReserve*2)

### 1.2 Compaction 系统 -- 8 个算法 + 4 个执行文件

主源: packages/local-runtime-v2/src/service/turn-system/compaction/{algorithm,execution}/

algorithm/:

- compact-context.ts -- 主算法
- assistant-iteration-cadence.ts -- 主循环 cadence
- background-cadence.ts -- 后台任务 cadence
- todo-cadence.ts -- todo cadence
- history-reduction.ts -- 历史减量
- tool-result-archiver.ts -- 工具结果归档
- tool-trim-admission.ts -- 工具结果修剪接纳
- checkpoint-format.ts

execution/:

- checkpoint-prompt.ts / checkpoint-provider.ts -- checkpoint prompt 与 provider
- local-context-footprint.ts -- 上下文 footprint 测量
- usage-anchor.ts -- 用 token anchor 状态
- automatic-context-compactor.ts -- 自动 compact 编排

SubagentCheckpointStateSource 是子代理上下文状态的接口 -- 也就是说 subagent checkpoint 是 compaction 系统的一等公民。

### 1.3 性能 / bench 证据

- mcode 没有显式 benchmark 目录(看到的 test/ 是 vitest 用例)
- 但 usage 链路完整: agent-modules/context-manager + local-runtime-v2/.../turn-system/compaction 形成大代码量
- packages/llm/token-meter/ 也存在(在 dsh 里是同一作者抽象)

---

## 2. dsh (deepseek-harness)

### 2.1 Token 计量 -- 4 字段 + projection

主源: packages/llm/token-meter/src/{usage-projection,projection,turn-usage,route-pricing,surface-fold}.ts

TokenUsageProjection:

uncachedInputTokens: number; // 未缓存
outputTokens: number;
cacheReadTokens: number; // 缓存命中
cacheWriteTokens: number; // 缓存写入

注释直接说: Pure folds for durable provider-reported token usage and context occupancy.

4 字段对应 4 个 fallback 桶 + bucketsFrom(usage: TokenUsage) 把 provider 报告转 4 桶。addReplacing 做减法 + 加法(用于本轮新增)。

### 2.2 ContextPressureProjection

pressureTokens: number; // 当前 pressure
projectedTokens: number; // 预计下次请求
contextWindow: number; // 模型窗口

pressureFrom = usage.inputTokens + usage.cacheRead + usage.cacheWrite (无 output)。

### 2.3 Route Pricing -- 按路由模型定价

主源: packages/llm/token-meter/src/route-pricing.ts

interface PricedSurface {
readonly nodes: TokenSurfaceNode[]
readonly surfaceTokens: number // sum of route prices
}

关键: 用 LlmImageRequestPricing 替固定启发式;图像文件按路由模型的实际定价算;comment 直接写: throws when the pricing answers a different occurrence count than it was asked -- misalignment would silently misprice nodes, so it must fail loud.

### 2.4 Benchmarks -- 6 个, 强 median budget

主源: benchmarks/{session-open,active-stream-reconnect,agent-continuation,conversation-fold,long-session-browser,terminal-io}/

agent-continuation/README.md 直接说:

- 跑 100 turns + 800 real file reads 用 sdk-minimal profile + 显式 editor patch
- 评测阈值: Catalog and tool continuation each use a 900 ms standard hosted CI expectation with 1.25x headroom (1,125 ms); request history uses a separately reviewed 297 ms hosted limit
- enforces reviewed median budgets -- median 预算,失败即 fail
- 完整的 sample + CPU model + parallel + platform/arch + Node/V8 报告

工作负载分维度: synthetic-released-v0-session (历史会话恢复), long-session-browser (长 session 浏览器负载), conversation-fold (对话压缩), session-open (会话冷启动)。

### 2.5 Compaction -- 3 个独立子包

主源: packages/compaction/{compaction,compaction-tool-result-pruner,compaction-image-offload,compaction-basic}/

- compaction-basic -- 基础压缩
- compaction-tool-result-pruner -- 工具结果剪枝
- compaction-image-offload -- 图像外提(到对象存储/本地)
- compaction -- 顶层 orchestration

---

## 3. kimicode (moonshotai/kimi-code)

### 3.1 Token 计量 -- 4 字段 + Session Usage

主源: packages/agent-core-v2/src/human/llm/agent/usage/session/usage/

TokenUsage:

inputOther: number; // 未缓存
output: number;
inputCacheRead: number; // 命中
inputCacheCreation: number; // 写入
raw: Record<string, unknown>;

helpers: emptyUsage, inputTotal, grandTotal, addUsage, mergeUsagePatch.

### 3.2 UsageStatus -- 三种粒度

主源: packages/agent-core-v2/src/agent/usage.ts

interface UsageStatus {
readonly byModel: Record<string, TokenUsage>;
readonly total: TokenUsage;
readonly currentTurn: TokenUsage;
}

- byModel -- 按模型分桶(多模型场景)
- total -- 累计
- currentTurn -- 本轮

### 3.3 CacheProbe -- Fork 时主动探测缓存命中

主源: packages/agent-core-v2/src/agent/usage/cacheProbeService.ts

代码逻辑: 在 fork 出来的子代理第一次记录 usage 时(firstRecord: true 且 source.type === turn),主动调用 probe:

this.telemetry.track2('prompt_cache_probe', --LT
source: 'fork', // 标明这是 fork 子
turn_id: e.source.turnId,
provider_type, protocol,
input_tokens, input_cache_read, input_cache_creation, output_tokens,
});

关键洞察: kimi 关心 fork 时 cache 命中率 -- 父子通常共享前缀,fork 后子代理应该能从父的 prompt cache 复用,这条 telemetry 就是验证这个优化是否有效。

### 3.4 性能 / bench

- 没有显式的 perf benchmark 目录
- packages/minidb/bench/ -- minidb 自己的 bench
- packages/kap-server/test/search/searchService.bench.ts -- search service bench

总体看,kimicode 的 perf 工程化弱于 dsh/codex/Reasonix。它更偏功能完整性 + 协议丰富。

---

## 4. codex (openai/codex)

### 4.1 Token 计量 -- 5 字段 (含 reasoning_output)

主源: codex-rs/protocol/src/protocol.rs:2235

pub struct TokenUsage {
pub input_tokens: i64,
pub cached_input_tokens: i64, // 缓存命中
pub cache_write_input_tokens: i64, // 缓存写入
pub output_tokens: i64,
pub reasoning_output_tokens: i64, // 思考 token,显式分桶
}

辅助:

- TokenUsage.cached_input() = cached_input_tokens.max(0)
- TokenUsage.non_cached_input() = (input_tokens - cached_input()).max(0)
- TokenUsage.total_tokens = non_cached_input() + output_tokens.max(0)

codex 是五个里唯一显式把 reasoning_output 单独分桶的。这对 o1/o3 类推理模型计费/限额至关重要。

### 4.2 TurnTokenUsage -- 按模型聚合的 turn 级 histogram

主源: codex-rs/core/src/state/turn_token_usage.rs

struct TurnTokenUsage {
by_model: BTreeMap of String, (SessionTelemetry, TokenUsage),
}

发射到 OTEL:

for (token_type, value) in [
('total', usage.total_tokens),
('input', usage.input_tokens),
('cached_input', usage.cached_input()),
('cache_write_input', usage.cache_write_input_tokens),
('output', usage.output_tokens),
('reasoning_output', usage.reasoning_output_tokens),
] {
telemetry.histogram(TURN_TOKEN_USAGE_METRIC, value.max(0), &[('Token_type', token_type), tmp_mem]);
}

### 4.3 MultiAgentUsageHint -- 给子代理的 token 使用提示

主源: codex-rs/core/src/context/multi_agent_usage_hint.rs

- ContentItemKind = 'multi_agent.usage_hint'
- role = 'developer'
- requires_separate_message = true
- 作为 standalone developer message 注入上下文

也就是说 codex 在 spawn 子代理时,会主动注入一个 developer message 提示其 token 使用模式(不是限制,而是 advisory)。

### 4.4 Token Budget -- 显式

主源: codex-rs/core/src/--LTcontext/token_budget_context,session/token_budget,config/token_budget_startup}.rs

- token_budget_context.rs -- 上下文层 token 预算
- session/token_budget.rs -- session 级
- token_budget_startup.rs -- 启动预算

### 4.5 Compaction -- BeforeLastUserMessage vs DoNotInject

主源: codex-rs/core/src/compact.rs

const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;

enum InitialContextInjection {
BeforeLastUserMessage { world_state, step_context }, // mid-turn 模式
DoNotInject, // pre-turn / manual 模式
}

两种策略:

- Pre-turn/manual 用 DoNotInject: 替换历史为 summary,清空 reference_context_item,下一轮全重注
- Mid-turn 用 BeforeLastUserMessage: 因为模型训练看到 summary 在最后一条之后,所以把初始上下文注入到最近 user message 之上

完整 telemetry 维度:

- CompactionReason / CompactionStrategy / CompactionPhase / CompactionStatus / CompactionTrigger / CompactionImplementation
- pre_compact_hooks / post_compact_hooks

### 4.6 Rollout + Budget 测试

主源: codex-rs/core/tests/suite/--LTrollout_budget,token_budget,token_usage_rollout}.rs

- rollout_budget -- rollout 路径上 token budget 守门
- token_budget -- 通用 budget
- token_usage_rollout -- rollout 中的 token 用量快照

### 4.7 TUI 端的 usage 视图

- codex-rs/tui/src/--LTanalytics/tokens,token_usage,status/thread_usage,app/agents_overview_usage}.rs

agents_overview_usage 是专门给 agent team overview 显示的用量汇总。

---

## 5. Reasonix (esengine/DeepSeek-Reasonix)

### 5.1 Token 计量 + 成本(全栈最强)

#### 5.1.1 TokenUsage -- 4 字段,语义清晰

主源: cmd/e2ebench/meter.go (meterUsage struct)

type meterUsage struct {
Requests int
PromptTokens int
CompletionTokens int
CacheHitTokens int
CacheMissTokens int
Injected int // 注入的故障数
WithoutUsage int // 报告 zero usage 的次数(明确区分零 vs 未报告)
RequestsAfterFault int
}

注释直接写: WithoutUsage is reported rather than folded into zero: a harness whose responses carry no usage block is unmeasured, and that is a finding, not a zero.

#### 5.1.2 Billing -- 多币种 + 多估值基础

主源: internal/billing/--LTquote,ledger,money,balance,catalog}.go

Billing modes:

- PAYG (pay-as-you-go)
- SubscriptionEquivalent

Valuation basis:

- identity
- official_table
- fx (pre-v6 persisted quotes only)

Display status:

- matched / fallback_original / bucketed / unavailable

Aggregate modes:

- single_currency / common_valuation / currency_buckets

CostQuote 字段: Original (pricing-table currency fact), valuations (identity or official regional rate-card estimates), Selected (display pick for current preference)。

### 5.2 Ledger -- 子代理独立计费的关键

主源: internal/billing/ledger.go

type LedgerEntry struct {
Key string // modelRef|usageSource|pricingFingerprint|rateDate
ModelRef string
UsageSource string // 子代理路径独立 key
PricingFingerprint string
RateDate string
OccurredAt time.Time
Quote CostQuote
PromptTokens int
CompletionTokens int
TotalTokens int
CacheHitTokens int
CacheMissTokens int
RequestCount int
}

注释直接写: Ledger keys include model, usage source, pricing fingerprint, and legacy rate date so model switches and sub-agents never collapse into a single scalar.

也就是说 Reasonix 的 ledger 用 4 元组 (model, usageSource, pricingFingerprint, rateDate) 作为 key,子代理因为有独立的 usageSource,永远不会和父或其它子合并成单标量。

### 5.3 ContextUsage -- 5 字段 memoization

主源: internal/agent/context_usage.go

type contextUsage struct {
transcriptVersion uint64
projectionVersion uint64
calibration *promptTokenCalibration
tools *tool.Registry
toolSchemaRevision uint64
tokens int
}

5 字段全部相等才复用缓存 -- 因为任何一个变化都可能改 token 估算结果。

文件注释直接批评常见 bug: A gauge fed from the last turn's usage instead lags a turn, counts completion tokens the trigger ignores, and reads zero on a rebound session -- which is how a session displays 8% while it is compacting.

即 Reasonix 的策略是精确投影下次请求的真实 prompt 大小,不是用上轮的 usage 猜。Gauge 应该 projection,不是 history。

### 5.4 E2E Bench 框架(最强)

主源: cmd/e2ebench/

模块清单:

- meter.go -- 透明 HTTP proxy
- swebench.go -- SWE-bench 集成
- report.go -- 报告渲染
- cognition.go / cognition_test.go
- compare.go / pareto.go -- 多 arm 对比
- longrun.go / longrun_test.go
- meter.go / meterrun.go / meterconfig.go
- integrity.go / mutation.go -- 完整性检查
- trajectory.go / trajectory_record.go -- trajectory 录制
- mechanism.go -- 支持 hypothesis
- profile.go / profile_test.go -- profile 测试
- report.go / report_test.go -- 报告

#### 5.4.1 Meter -- 透明 HTTP proxy

meter 是 harness 中立的测量点: every harness talks to instead of the provider, so nobody in a comparison reports their own token use.

注释还写: It is also where LongRun injects provider faults, because the request boundary is the only place both benchmarks can reach without a harness's cooperation.

也就是说 meter 还能注入 provider 故障 -- 通过请求边界,不需要 harness 配合。

故障脚本语法: 3:429,every:5:500 -- 3 号请求 429,每 5 个 500。

#### 5.4.2 SWE-bench 集成

runs the agent inside the official per-instance evaluation container, so it can execute the repo's tests exactly like the harnesses it is compared against, then hands the resulting patch to the official grader.

用 --permission-mode=workspace-write/read-only/danger-full-access 三档。

#### 5.4.3 Report 维度

fields passed/ran/pass1/maxAttempt, pTok/cTok/hit/miss/compacts/tools/toolFails/steps/modelWalls, cost, walls/ttcs/ttft/firstCorrect/postWaste, classes map, prefixChangeReasons map, bySource map (子代理独立计费)

arm 标识: full / cache-cold / cache-warm / ...

输出格式: markdown + JSON (accuracy, cache-hit rate, token use, cost) for a PR。

### 5.5 Checkpoint + Evidence

主源: internal/--LTcheckpoint,evidence}/

- checkpoint.go -- 持久化 compaction 检查点
- evidence.go -- 事实存档(注册表)

### 5.6 不复制 transcript -- 对 token 经济性的直接影响

Reasonix 的设计选择(Subagent boundaries):

- profile = 身份, TaskSpec = 这一次, Grant = 只收不扩, Context = 不复制 transcript
- 这意味着 fork 子代理不会把父的整个 transcript 复制过去
- 直接影响: 大上下文 fork 的成本大幅降低(避免 O(N) 输入)

对比 mcode 的 fork-in-process: 子能看到所有已完成轮次 -- 显式更贵的设计。

---

## 6. 五方 token / 性能维度横向对比

### 6.1 Token 计量粒度对比

| 项目     | 字段                                      | 思考 token      | cache 显式          | 计费独立                   |
| -------- | ----------------------------------------- | --------------- | ------------------- | -------------------------- |
| mcode    | input/output/reasoning/cache              | 是              | 是                  | 中等                       |
| dsh      | uncached/output/cacheRead/cacheWrite      | 否(共用 output) | 是                  | session projection         |
| kimicode | inputOther/output/cacheRead/cacheCreation | 否              | 是 + fork probe     | session usage              |
| codex    | input/cached/cacheWrite/output/reasoning  | 是(显式独立桶)  | 是                  | session token + budget     |
| Reasonix | prompt/completion/cacheHit/cacheMiss      | 否              | 是 + e2ebench meter | ledger 4 元组键,子代理独立 |

### 6.2 Cache 命中率优化路径对比

| 项目     | cache 优化                          | 主动探测                            | 父继承                                   |
| -------- | ----------------------------------- | ----------------------------------- | ---------------------------------------- |
| mcode    | 显式 cacheRead/cacheWrite 桶        | 否                                  | fork-in-process 子看到已完成轮次(高复用) |
| dsh      | surface-fold 按路由模型实际算       | 否                                  | continuable 子可持久化                   |
| kimicode | 显式 cacheRead/Creation             | 是 (AgentCacheProbeService on fork) | fork 子共享前缀                          |
| codex    | cached_input/cache_write_input 双桶 | 否                                  | 子 agent 继承 runtime state              |
| Reasonix | cacheHit/cacheMiss 桶               | 否 (但 meter proxy 能观测)          | 不复制 transcript,几乎零继承             |

### 6.3 Compaction / 上下文压缩对比

| 项目     | 触发阈值                                          | token 估算                                          | 特殊策略                               |
| -------- | ------------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| mcode    | MiniMax-M3 90% / 其它 reserve+safetyMargin        | BPE o200k_base + over-estimate 故意                 | checkpoint provider; 8 个 cadence 算法 |
| dsh      | reserved 自动 (token-meter + pressure projection) | surface-fold + route pricing                        | image-offload 独立子包                 |
| kimicode | provider                                          | 一般; protocol 层 tokenCountingAgentModel           | 无显式 over-estimate                   |
| codex    | BeforeLastUserMessage / DoNotInject 双策略        | 20_000 token user-message 上限; rollout_budget 测试 |
| 所有     | 都有 token budget + 触发器                        | mcode 的 over-estimate 是显式选择                   |

### 6.4 Benchmark 框架对比

| 项目     | 框架                                        | 工作负载                        | 阈值                                  |
| -------- | ------------------------------------------- | ------------------------------- | ------------------------------------- |
| mcode    | 弱 (test/ vitest)                           | 无显式 perf bench               | 无                                    |
| dsh      | 强 (6 个 bench)                             | 100 turns + 800 real file reads | median 强制 (900ms / 1,125ms / 297ms) |
| kimicode | 弱 (minidb + kap bench)                     | 无                              | 无                                    |
| codex    | 中等 (rollout_budget + token_budget)        | rollout 路径 budget             | 弱                                    |
| Reasonix | 极强 (e2ebench + meter + swebench + report) | SWE-bench + 自定义 suite        | 完整 (cost + cache-hit + accuracy)    |

### 6.5 性能优化的具体差异

#### 6.5.1 估算器误差处理

- mcode: 故意 over-estimate (gpt-tokenizer 的 o200k_base 对 Messages 协议 over-count 一点,安全)
- dsh: route-pricing 按实际路由定价,对齐真价(fail loud 不对齐)
- kimicode: 一般(provider 估算)
- codex: 显式 reasoning_output 桶,直说 o1/o3 类模型需要
- Reasonix: projection 真实大小,不滞后,不带 output

#### 6.5.2 子代理继承 vs 重算

- mcode: fork-in-process 子看到父已完成轮次 -- 高 cache 复用但高 token
- dsh: continuable 子可持久化,可 cold-resume;fork 子有 parent 历史
- kimicode: AgentSwarm fork 用模板,AgentCacheProbeService 主动验证 cache 命中
- codex: spawn_agent fork 可选 inherit,默认 inherit runtime state
- Reasonix: 不复制 transcript,只传 Decisions/Evidence/FileAnchors -- 大 fork 极便宜

#### 6.5.3 多 agent 并行的 token 隔离

- mcode: per-session BackgroundTask 状态;metadata 含 agentName 等
- dsh: SubagentRuntime 各自的 UsageProjection
- kimicode: SessionUsageService 按 agent 维度记
- codex: TurnTokenUsage.by_model + multi_agent_usage_hint developer message
- Reasonix: LedgerEntry.UsageSource 强制子代理独立 key

### 6.6 性能瓶颈的工程取舍

| 项目     | 痛点                                     | 取舍                                                            |
| -------- | ---------------------------------------- | --------------------------------------------------------------- |
| mcode    | CJK chars/4 underestimate 4-8x, hard 4xx | over-estimate 故意,gpt-tokenizer 而不是 Messages 协议 tokenizer |
| dsh      | cache 命中显示不对齐                     | bucketsFrom + cache_fail_loud                                   |
| kimicode | cache 优化是否有效                       | telemetry probe,数据驱动                                        |
| codex    | 中间 compaction 中显示 0%                | BeforeLastUserMessage / DoNotInject 二态                        |
| Reasonix | 用上轮 usage 滞后,rebound session 0      | projection-based gauge,5 字段 memo                              |

---

## 7. 共同模式 / 启示

1. 4 字段 token 桶(input/output/cacheRead/cacheWrite)是事实标准,所有项目都做。但 codex 是唯一额外加 reasoning_output 的。
2. cache 显式分桶对 fork/inherit 优化至关重要。kimicode 的 CacheProbe 是唯一把 cache 探测做成 telemetry 事件的,值得借鉴。
3. 成本独立计费 = ledger 级 key 不能只含 model。子代理用 usage_source 区分,模型切换用 pricing_fingerprint 区分(Reasonix 做得最干净)。
4. token 估算误差处理:mcode 的 over-estimate 是显式选择(safe: earlier trigger),不是 bug。reasonix 的 projection 不带 output 也是显式选择(避免 compaction 中显示 0%)。
5. benchmark 必须有强制阈值:dsh 的 median 900ms / 1,125ms / 297ms + Reasonix 的 e2ebench 全套(accuracy + cache-hit + cost + token)。其它三家没有显式 perf gate。
6. compaction 触发后不能用上轮 usage 显示,Reasonix 直接说: 这是 session displays 8% while it is compacting 的根因。Codex 的 BeforeLastUserMessage 是另一种解。
7. 跨 harness 的 token 计量独立(dsh 跨 harness 调起子)需要 route pricing -- dsh 走 LlmImageRequestPricing 是这条路。
8. e2e bench 的 metering 必须 harness 中立:Reasonix 走 transparent HTTP proxy 是唯一的方案(避免 harness 自己报数),其它做法都 benchmark。

---

## 8. 主源文件索引(便于复检)

### 8.1 mcode

- ContextManager: packages/agent-modules/context-manager/src/--LTmanager,settings,provider-budget,token-estimator,count-tokens-body,context-usage-estimator}.ts
- Compaction: packages/local-runtime-v2/src/service/turn-system/compaction/--LTautomatic-context-compactor,local-context-compactor,contracts}.ts
- Compaction 算法: packages/local-runtime-v2/src/service/turn-system/compaction/algorithm/--LTcompact-context,history-reduction,tool-result-archiver,tool-trim-admission,checkpoint-format,assistant-iteration-cadence,background-cadence,todo-cadence}.ts
- Compaction 执行: packages/local-runtime-v2/src/service/turn-system/compaction/execution/--LTcheckpoint-prompt,checkpoint-provider,local-context-footprint,usage-anchor}.ts

### 8.2 dsh

- Token meter: packages/llm/token-meter/src/--LTindex,client,types,estimate,projection,turn-usage,usage-projection,route-pricing,surface-fold,surface-projection,breakdown-projection}.ts
- Compaction: packages/compaction/--LTcompaction,compaction-basic,compaction-tool-result-pruner,compaction-image-offload}/
- Benchmarks: benchmarks/--LTsession-open,active-stream-reconnect,agent-continuation,conversation-fold,long-session-browser,terminal-io}/

### 8.3 kimicode

- Token usage: packages/agent-core-v2/src/--LThuman/llm/usage,human/usage,agent/usage,agent/usage/usageOps,agent/usage/errors,agent/usage/cacheProbe,agent/usage/cacheProbeService,session/usage}/
- Cache probe: packages/agent-core-v2/src/agent/usage/cacheProbeService.ts
- Token counting: packages/agent-core-v2/src/session/tokenCounting/

### 8.4 codex

- Token type: codex-rs/protocol/src/protocol.rs (TokenUsage, TokenUsageRecord, TokenUsageInfo)
- Turn usage: codex-rs/core/src/state/turn_token_usage.rs
- Multi-agent hint: codex-rs/core/src/context/multi_agent_usage_hint.rs
- Budget: codex-rs/core/src/--LTcontext/token_budget_context,session/token_budget,config/token_budget_startup}.rs
- Compaction: codex-rs/core/src/compact.rs (InitialContextInjection enum)
- Tests: codex-rs/core/tests/suite/--LToken_budget,rollout_budget,token_usage_rollout}.rs
- TUI usage: codex-rs/tui/src/--LToken_usage,analytics/tokens,status/thread_usage,app/agents_overview_usage}.rs

### 8.5 Reasonix

- Billing: internal/billing/--LTbalance,catalog,ledger,quote,money,migrate}.go
- Context usage: internal/agent/context_usage.go
- E2E bench: cmd/e2ebench/--LTmeter,meterrun,meterconfig,swebench,report,compare,pareto,cognition,longrun,integrity,mutation,trajectory,trajectory_record,profile,mechanisms}.go
- Checkpoints: internal/checkpoint/
- Evidence: internal/evidence/

---

## 9. 我没能完全确认的事 / 留口

- codex 的 e2e perf gate: token_budget.rs 是设计,rollout_budget.rs 是测试,但是否有 CI 强制阈值没看到证据。
- kimicode 的 production usage 数据: 没有 telemetry/analytics 入口让我看到实际 cache 命中率是多少。
- dsh 的 token-meter 在生产中的真实分布: benchmark lane 有 median 强制,但 Session-level 累计只在 session 投影里出现。
- mcode 的 token 估算 vs provider 真实计费差异: BpeTokenEstimator 故意 over-estimate,但具体 over-count 多少没看到测试。
- Reasonix e2ebench 公开报告: cmd/e2ebench 有完整代码但没看到公开的 e2e report;无法得知其 benchmark 数字。

---

> 备注: 本笔记与 peer-harnesses.md 配套阅读。前者讲结构/语义,本篇讲成本/性能。
