# 文档索引：88 份 docs 的压缩视图

**这张表把 `docs/` 下的文件压成一行一条**：每份文档是什么、**验证状态**（能信到什么程度）、以及一个处置候选。**本表生成时没有删任何文件**——删哪些等你在这张表上拍板。

## 口径（先读这一段）

**语料**：`docs/` 下 **80 份 git 跟踪文件**。磁盘上 `docs/` 有 88 个文件，多出的 8 个不是文档（发布副本 + 系统垃圾），见末节。

**验证状态** —— 一份文档能信到什么程度：

| 值          | 含义                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| 权威        | 决策/规范本体：它**定义**事实，不陈述事实。状态由 ADR 的 `Status:` 字段给出 |
| 权威·已撤销 | 同上，但已被后续 ADR 取代（只有 ADR-0001）                                  |
| 已实测      | 结论带真机/探针证据（日期 + pi 版本），且台账仍在维护/复测                  |
| 历史归档    | 定格在某日期的一次性调研或快照；保留作证据，结论**不保证**仍成立            |
| 草稿        | 明示「草稿」或 throwaway 原型，未成结论                                     |
| 未核对      | 约定/清单类，无验证信号                                                     |
| 探针资产    | 可执行证据载体（脚本），本身不是文档                                        |

**处置候选** —— 只是建议，删不删你说了算：

| 值       | 含义                                         |
| -------- | -------------------------------------------- |
| 留       | 现行且有人维护                               |
| 留·压    | 留，但正文可压进别处（保留引用式摘要即可）   |
| 合并候选 | 内容已被别处覆盖，并进去后可删               |
| 删候选   | 一次性 / 已被取代 / 结论已落到别处，可直接删 |

**断链说明**：现行 ADR 里指向「旧 ADR-00xx」的链接在当前分支**必然断链**——那 45 份旧 ADR 归档在 `backup/main-legacy-20261026` 分支，这是 AGENTS.md 记着的约定，不是坏链。本表不把它们算作缺陷。

---

## 一、决策与规范（27 份）

| 路径                                                                                                     | 是什么                                                | 验证状态                                   | 处置候选                         |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| [adr/0001-deepseek-search-is-program-internal.md](adr/0001-deepseek-search-is-program-internal.md)       | 「DeepSeek 搜索程序内可达」的第一版形状               | 权威·已撤销（2026-10-20 被 ADR-0003 取代） | 删候选（已被 0003 取代）         |
| [adr/0002-deepseek-search-gate.md](adr/0002-deepseek-search-gate.md)                                     | 搜索门禁：默认关的开关 + 凭据判定                     | 权威（accepted 2026-10-20）                | 留（与 0003 配套）               |
| [adr/0003-the-search-lives-in-the-child.md](adr/0003-the-search-lives-in-the-child.md)                   | 搜索能力活在子代理，由子代理的模型直接调              | 权威（accepted 2026-10-20）                | 留                               |
| [adr/0004-ptc-off-stops-new-dispatch.md](adr/0004-ptc-off-stops-new-dispatch.md)                         | PTC off 停掉新的派发，在飞的不动但要说一声            | 权威（accepted 2026-10-21）                | 留（被 0012 修订，以 0012 为准） |
| [adr/0005-the-surface-names-the-orchestrator.md](adr/0005-the-surface-names-the-orchestrator.md)         | 表面值 `full_ptc` / `codemode_ptc` 的定义             | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0006-the-two-doors-share-one-prefix.md](adr/0006-the-two-doors-share-one-prefix.md)                 | `pi_task_ptc` / `pi_task_codemode` 共享前缀，不留别名 | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0007-every-dispatch-is-a-task.md](adr/0007-every-dispatch-is-a-task.md)                             | 每个派发都是一条任务：前台也建记录、也落盘            | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0008-the-two-doors-give-one-object.md](adr/0008-the-two-doors-give-one-object.md)                   | 两扇门给同一个对象：不投影、不套信封                  | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0009-wait-is-one-parameter.md](adr/0009-wait-is-one-parameter.md)                                   | 「等不等」是一个参数：`wait` 取代 `background`        | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0010-admission-queues-instead-of-rejecting.md](adr/0010-admission-queues-instead-of-rejecting.md)   | 准入排队：满了不拒绝，FIFO 无界，入队即建记录         | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0011-cancellation-only-reaches-queued-tasks.md](adr/0011-cancellation-only-reaches-queued-tasks.md) | 取消只对「还没起进程」的任务生效                      | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0012-ptc-off-truncates-the-chain.md](adr/0012-ptc-off-truncates-the-chain.md)                       | `/ptc off` 改成截断，两个表面各自的截断点             | 权威（accepted 2026-10-21）                | 留（修订 0004）                  |
| [adr/0013-route-registry.md](adr/0013-route-registry.md)                                                 | 模型面散文只有一个出处：类型化 route registry         | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0014-ptc-programs-run-in-strict-mode.md](adr/0014-ptc-programs-run-in-strict-mode.md)               | PTC 程序强制严格模式，与上游 DSH 对齐                 | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0015-the-route-index-and-its-detail-files.md](adr/0015-the-route-index-and-its-detail-files.md)     | 路表两层输出：常驻索引一行一条 + 随包详情文件         | 权威（accepted 2026-10-21）                | 留                               |
| [adr/0016-render-bounds-cleanup.md](adr/0016-render-bounds-cleanup.md)                                   | 富行渲染契约除名，RENDER_BOUNDS 裁到现行四项          | 权威（accepted 2026-10-27）                | 留（3KB）                        |
| [adr/0017-test-framework-gates.md](adr/0017-test-framework-gates.md)                                     | 测试框架：探针转正 + spec 决策 21 机械门禁            | 权威（accepted 2026-10-27）                | 留（3KB）                        |
| [adr/0018-restore-project-site.md](adr/0018-restore-project-site.md)                                     | 恢复项目站点为第二个 workspace 成员                   | 权威（accepted 2026-10-27）                | 留                               |
| [adr/0019-programs-run-in-a-vm-cell.md](adr/0019-programs-run-in-a-vm-cell.md)                           | PTC 程序在专属运行格（vm context）内执行              | 权威（accepted 2026-10-28）                | 留                               |
| [adr/0020-kimi-mcp-face.md](adr/0020-kimi-mcp-face.md)                                                   | Kimi 面：MCP 形态 `ptc_run_code` + 宿主中立输出核     | 权威（accepted 2026-10-28）                | 留                               |
| [prototypes/dispatch-doors-flow.html](prototypes/dispatch-doors-flow.html)                               | 派发与路由全景 = **spec**，决策的唯一出处             | 权威（现行；改语义前先对质它）             | 留（AGENTS.md 硬规矩）           |
| [prototypes/ptc-runtime-status.html](prototypes/ptc-runtime-status.html)                                 | ptc 运行时现状全景：运行链路 / 已做 / 未做            | 已实测（随 PTC 改动同步维护）              | 留（站点 `public/status/`）      |
| [prototypes/dispatch-engine-status.html](prototypes/dispatch-engine-status.html)                         | 子代理派发现状全景                                    | 已实测（随 dispatch 改动同步维护）         | 留（站点 `public/status/`）      |
| [prototypes/full-flow-anatomy.html](prototypes/full-flow-anatomy.html)                                   | 全功能流转解剖 · 基准流程图 v6.1.0                    | 权威（基准流程图，ADR-0017 引用它）        | 留                               |
| [prototypes/audit-findings-source-map.html](prototypes/audit-findings-source-map.html)                   | 审计发现来源图（一次性 PROTOTYPE）                    | 草稿（一次性）                             | 删候选（发现已落 ADR-0016/0017） |
| [prototypes/render-bounds-anatomy.html](prototypes/render-bounds-anatomy.html)                           | RENDER_BOUNDS 五项解剖（一次性图解）                  | 草稿（一次性）                             | 合并候选（结论已落 ADR-0016）    |
| [prototypes/search-memory-flow.html](prototypes/search-memory-flow.html)                                 | 搜索记忆 F5 流程图解（一次性）                        | 草稿（一次性）                             | 删候选                           |

## 二、现行台账与仓库约定（5 份）

| 路径                                               | 是什么                                                | 验证状态                       | 处置候选             |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------ | -------------------- |
| [pi-version-matrix.md](pi-version-matrix.md)       | pi 版本兼容矩阵：0.99 分水岭 / floor 0.86 / 16 版冒烟 | 已实测（2026-10-31 八版实测）  | 留（站点读者面）     |
| [kimi-ptc-tools.md](kimi-ptc-tools.md)             | Kimi Code 插件（ptc-tools）安装与两件 MCP 工具用法    | 未核对（用法说明，随发布漂移） | 留（站点读者面）     |
| [agents/domain.md](agents/domain.md)               | 领域文档消费约定：先读 GLOSSARY / ADR                 | 未核对（约定类）               | 留（AGENTS.md 指向） |
| [agents/issue-tracker.md](agents/issue-tracker.md) | GitHub issue 约定：一切走 `gh` CLI                    | 未核对（约定类）               | 留（AGENTS.md 指向） |
| [agents/triage-labels.md](agents/triage-labels.md) | 五个 triage 角色 → 本仓标签字符串的映射               | 未核对（约定类）               | 留（AGENTS.md 指向） |

## 三、历史归档：调研与快照（33 份）

| 路径                                                                                                                     | 是什么                                                        | 验证状态                    | 处置候选                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| [research/upstream-20260930/01-dsh-ptc-core.md](research/upstream-20260930/01-dsh-ptc-core.md)                           | DSH PTC 核心一手快照（pin `dsh-v0.2.0-rc.2`，逐条 path:line） | 历史归档                    | 留·压（存摘要 + 引用即可）                                                          |
| [research/upstream-20260930/02-dsh-tool-surface.md](research/upstream-20260930/02-dsh-tool-surface.md)                   | DSH 工具面一手快照（104KB，最大一份）                         | 历史归档                    | 留·压（存摘要 + 引用即可）                                                          |
| [research/upstream-20260930/03-dsh-sandbox-approval.md](research/upstream-20260930/03-dsh-sandbox-approval.md)           | DSH 沙箱与隔离一手快照                                        | 历史归档                    | 删候选（我们明确不做 OS 沙箱，见 ADR-0014）                                         |
| [research/upstream-20260930/04-dsh-presentation.md](research/upstream-20260930/04-dsh-presentation.md)                   | DSH 呈现层一手快照                                            | 历史归档                    | 删候选                                                                              |
| [research/upstream-20260930/05-pi-host-contract.md](research/upstream-20260930/05-pi-host-contract.md)                   | pi 宿主契约一手快照（pin pi 0.86.1 = floor）                  | 历史归档                    | 留·压（别处没有这份 floor 契约）                                                    |
| [research/upstream-20260930/06-upstream-web.md](research/upstream-20260930/06-upstream-web.md)                           | 上游 web / 一手资料汇总（81KB）                               | 历史归档                    | 删候选                                                                              |
| [research/ptc-upstream-parity-audit-20260930.md](research/ptc-upstream-parity-audit-20260930.md)                         | 上游对照审计母文档（47KB，六轴并发调研）                      | 历史归档                    | 删候选（是上列 6 份的母文档，结论已进 ADR）                                         |
| [research/codemode-vs-ptc-capability-20260930.md](research/codemode-vs-ptc-capability-20260930.md)                       | Codemode vs PTC 实测能力对照（对照基于 0.99/1.0）             | 历史归档                    | 合并候选（结论已被版本矩阵吸收）                                                    |
| [research/deepseek-search-api-20261020.md](research/deepseek-search-api-20261020.md)                                     | DeepSeek Search/Fetch API 一手调研（上游契约，40KB）          | 历史归档                    | 留·压（上游事实，存摘要）                                                           |
| [research/pi-compat-probes-20261014/README.md](research/pi-compat-probes-20261014/README.md)                             | 兼容探针说明：14 版 × 15 特征点 = 210 检查                    | 已实测（一次性跑通）        | 合并候选（结论已在版本矩阵；**它指向的 `docs/agents/pi-compat-matrix.md` 不存在**） |
| [research/pi-compat-probes-20261014/VERDICT.md](research/pi-compat-probes-20261014/VERDICT.md)                           | 探针结论 v2（针对 pi < 1.0.0）                                | 已实测（定格在 2026-10-14） | 合并候选（同上）                                                                    |
| [research/dispatch-loop-e2e-spike-20261016.md](research/dispatch-loop-e2e-spike-20261016.md)                             | 派发环 e2e spike（pkg 3.2.0 + pi 1.2.0）                      | 历史归档                    | 删候选（版本已过）                                                                  |
| [research/dispatcher-test-timing-rootcause.md](research/dispatcher-test-timing-rootcause.md)                             | 计时断言根因分析（2026-09-23）                                | 历史归档                    | 删候选                                                                              |
| [research/ptc-binding-contract-measurement-20260930.md](research/ptc-binding-contract-measurement-20260930.md)           | 绑定契约首次测量                                              | 历史归档                    | 删候选                                                                              |
| [research/ptc-binding-contract-re-measurement-20260930.md](research/ptc-binding-contract-re-measurement-20260930.md)     | 绑定契约复测                                                  | 历史归档                    | 删候选                                                                              |
| [research/ptc-dispatch-field-pitfalls-20260929.md](research/ptc-dispatch-field-pitfalls-20260929.md)                     | `pi.dispatch` 在 PTC 模式下的使用陷阱                         | 历史归档                    | 删候选（表面已改名，ADR-0006/0007）                                                 |
| [research/dsh-ptc-image-hoisting.md](research/dsh-ptc-image-hoisting.md)                                                 | DSH 图像如何到达模型                                          | 历史归档                    | 合并候选（契约已在 `packages/ptc` 协议/工具面代码里）                               |
| [research/dsh-ptc-page-rendering.md](research/dsh-ptc-page-rendering.md)                                                 | DSH 程序运行中页面显示什么                                    | 历史归档                    | 删候选                                                                              |
| [research/pi-capability-audit.md](research/pi-capability-audit.md)                                                       | 我们 vs pi 扩展 API 审计                                      | 历史归档                    | 删候选                                                                              |
| [research/pi-extension-wasm-feasibility.md](research/pi-extension-wasm-feasibility.md)                                   | pi 扩展能否用 Wasm 实现（34KB）                               | 历史归档                    | 删候选                                                                              |
| [research/mcode-subagents.md](research/mcode-subagents.md)                                                               | mcode（MiniMax Code）子代理做法（25KB）                       | 历史归档                    | 删候选                                                                              |
| [research/peer-harnesses.md](research/peer-harnesses.md)                                                                 | 四家 peer 子代理做法对比（41KB）                              | 历史归档                    | 删候选                                                                              |
| [research/peer-harnesses-perf.md](research/peer-harnesses-perf.md)                                                       | 四家 peer 性能对比（29KB）                                    | 历史归档                    | 删候选                                                                              |
| [research/background-tasks-peer-survey.md](research/background-tasks-peer-survey.md)                                     | 四家 peer 后台任务/子代理机制调研                             | 历史归档                    | 删候选                                                                              |
| [research/zcode-grep-embedded-search-20261016.md](research/zcode-grep-embedded-search-20261016.md)                       | ZCode embedded search 调研（26KB）                            | 历史归档                    | 删候选                                                                              |
| [research/vp-pack-js-output.md](research/vp-pack-js-output.md)                                                           | `vite-plus vp pack` 能否产出 .js/.d.ts                        | 历史归档                    | 删候选（结论已写进 AGENTS.md「发布包不带 dts」）                                    |
| [research/prototype-image-delivery-ab/README.md](research/prototype-image-delivery-ab/README.md)                         | PROTOTYPE（throwaway）：图像投递走工具结果还是消息            | 草稿                        | 删候选（结论：留工具结果）                                                          |
| [research/prototype-pulse-tui-variants/README.md](research/prototype-pulse-tui-variants/README.md)                       | PROTOTYPE（throwaway）：TUI 运行态视觉方案                    | 草稿                        | 删候选                                                                              |
| [research/prototype-pulse-tui-variants/industry-findings.md](research/prototype-pulse-tui-variants/industry-findings.md) | 行业「运行中」指示器调研                                      | 历史归档                    | 删候选                                                                              |
| [research/wayfinder-208-negative-results.md](research/wayfinder-208-negative-results.md)                                 | 两个候选特性没活下来的负面结论记录                            | 历史归档                    | 留（防下一个人重做）                                                                |
| [research/wayfinder-209-ab-harness-design.md](research/wayfinder-209-ab-harness-design.md)                               | A/B 实验设计草案（wayfinder #209）                            | 草稿                        | 删候选                                                                              |
| [research/wayfinder-213-prompt-contract-draft.md](research/wayfinder-213-prompt-contract-draft.md)                       | 两臂 prompt 契约措辞草稿（#213）                              | 草稿                        | 删候选                                                                              |
| [research/wayfinder-214-task-corpus-draft.md](research/wayfinder-214-task-corpus-draft.md)                               | 实验任务样本集草稿（#214）                                    | 草稿                        | 删候选                                                                              |

## 四、探针资产与一次性产物（15 份）

不是文档，是证据载体；处置跟它们的上层文档走。

| 路径                                                                                                                             | 是什么                                         | 验证状态           | 处置候选 |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------ | -------- |
| [research/pi-compat-probes-20261014/capability-probe.mjs](research/pi-compat-probes-20261014/capability-probe.mjs)               | 能力探针：逐版逐特征点检查                     | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/surface-probe.mjs](research/pi-compat-probes-20261014/surface-probe.mjs)                     | 表面探针                                       | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/surface-decision-probe.mjs](research/pi-compat-probes-20261014/surface-decision-probe.mjs)   | codemode 在场/不在场时的表面判定               | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/run-surface-matrix.mjs](research/pi-compat-probes-20261014/run-surface-matrix.mjs)           | 表面矩阵跑批                                   | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/run-decision-matrix.mjs](research/pi-compat-probes-20261014/run-decision-matrix.mjs)         | 决策矩阵跑批                                   | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/probe-runtime.mjs](research/pi-compat-probes-20261014/probe-runtime.mjs)                     | 真机运行时探针（工具注册 / structuredContent） | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/pi086-loader.mjs](research/pi-compat-probes-20261014/pi086-loader.mjs)                       | 0.86 运行时 loader                             | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/driver-install.mjs](research/pi-compat-probes-20261014/driver-install.mjs)                   | 多版本 pi 安装驱动                             | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/build-binding-probe.mjs](research/pi-compat-probes-20261014/build-binding-probe.mjs)         | 生成 0.86.1 绑定探针 + loader                  | 探针资产           | 合并候选 |
| [research/pi-compat-probes-20261014/build-binding-probe-big.mjs](research/pi-compat-probes-20261014/build-binding-probe-big.mjs) | 200KB payload 版绑定探针（压测工作区大小）     | 探针资产           | 合并候选 |
| [research/prototype-image-delivery-ab/run.mjs](research/prototype-image-delivery-ab/run.mjs)                                     | 图像投递 A/B 原型的跑法                        | 探针资产           | 删候选   |
| [research/prototype-image-delivery-ab/probe-ab.ts](research/prototype-image-delivery-ab/probe-ab.ts)                             | 图像投递 A/B 的探针实现                        | 探针资产           | 删候选   |
| [research/prototype-pulse-tui-variants/probe.mjs](research/prototype-pulse-tui-variants/probe.mjs)                               | TUI 变体探针                                   | 探针资产           | 删候选   |
| [research/prototype-pulse-tui-variants/comparison.html](research/prototype-pulse-tui-variants/comparison.html)                   | TUI 变体对照页                                 | 草稿（一次性产物） | 删候选   |
| [research/wayfinder-217-e3/run-adoption.mjs](research/wayfinder-217-e3/run-adoption.mjs)                                         | e3 采用率实验跑法（目录里只有它）              | 探针资产           | 删候选   |

## 五、不在语料里的 8 个文件

磁盘上 `docs/` 是 88 个文件，比语料多的 8 个都不是文档：

| 路径                       | 是什么                 | 说明                                                                                                                                                             |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/routes/*.md`（7 份） | 路线册子的**发布副本** | `.gitignore` 里 `/docs/routes/`（源在 `packages/routes/docs/routes`，pack 时拷过去）。**磁盘上这 7 份有 5 份与真源不一致**（陈旧），属发布产物漂移，不是文档漂移 |
| `docs/.DS_Store`           | macOS 系统垃圾         | 已被 `.gitignore` 忽略                                                                                                                                           |

---

## 处置候选汇总

| 处置候选 | 份数   | 字节        | 占语料   |
| -------- | ------ | ----------- | -------- |
| 留       | 29     | 503 KB      | 31.3%    |
| 留·压    | 4      | 278 KB      | 17.3%    |
| 合并候选 | 15     | 117 KB      | 7.3%     |
| 删候选   | 32     | 710 KB      | 44.1%    |
| **合计** | **80** | **1.61 MB** | **100%** |

**「删候选 + 合并候选」= 47 份 = 827 KB ≈ 语料的一半。** 其中 455KB 集中在 `research/upstream-20260930/` 那 6 份上游快照（占语料 28%）——它们的价值是「别处没有的一手引用」，而不是「读起来像文档」。

## 下一步（删哪些，等你拍板）

1. **先删 32 份「删候选」**：一次性原型、被撤销的 ADR、结论已落别处的调研。零阅读损失。
2. **再压 4 份「留·压」**：保留引用式摘要（上游 DSH 两份 + floor 版 pi 宿主契约 + DeepSeek API 契约），正文可清。
3. **「合并候选」15 份逐份确认引用后再动**：其中 10 份是 `pi-compat-probes` 探针脚本，它们的职责已被 `scripts/version-smoke.sh` + `scripts/knobs-smoke.mjs` 接管；5 份要先把结论并进目标文档。
4. **删除前跑一遍引用扫描**：本表只查了文档里的相对链接，代码与配置里的引用不在扫描范围内。

---

_本表生成于 2026-10-31。表内「验证状态」依据各文档自身的 `Status:` 字段、日期戳与实测信号判定；判不出来的写「未核对」，不猜。_
