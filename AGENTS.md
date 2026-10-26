# AGENTS.md — pi-ptc-subagents

pi 的扩展：PTC（模型写 TypeScript 程序批量调工具）+ 子代理派发。当前是 `feat/rewrite` 分支上的**干净室重写**（只按 ADR/spec 写，不抄旧实现源码）。

## 包结构（packages/，pnpm workspace）

| 包         | 职责                                                                                                               | 依赖                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `entry`    | pi extension 装配：session_start 注册、surface 检测、PTC 模式（收窄/skills 补偿）、/ptc off 截断、通知投递         | → 全部                      |
| `ptc`      | 程序运行时：worker 池、dispatcher、严格模式编译、工具工厂、renderResult                                            | → sub→dispatch、tui、routes |
| `dispatch` | 任务引擎：六道闸、DispatchSlotCounter（libuv 队列）、spawn/pump、registry（落盘+重启恢复）、child report、通知中心 | 无（叶子）                  |
| `task`     | 任务面：list/output/stop 的读/停语义（分层读取：超阈值引导读报告）                                                 | → dispatch                  |
| `tui`      | 渲染原语叶子：文本卫生、截断契约、渲染预算                                                                         | 无                          |
| `routes`   | 模型面散文唯一出处（ADR-0013）：7 条路的册子 + 渲染器（索引/通知/引导语）                                          | 无（叶子）                  |
| `search`   | 搜索 provider 抽象（DeepSeek 首家）：三动作工具、配额、记忆、预算                                                  | → tui                       |

依赖铁律：**tui / routes 是叶子**（不感知领域概念）；`dispatch` 持全部任务状态，其余只是调用方。

## 工具链（根目录）

`pnpm run check`（tsrs 类型检查）· `build`（rolldown）· `lint`（oxlint）· `fmt` / `fmt:check`（oxfmt）——改动后四件套全绿才算完。改文件用 Edit 工具；**不要用脚本做整段文本替换**（oxfmt 折行会让锚点失配，本仓已踩六次）。

## 验证纪律

- 探针直接跑 `node` 打 `packages/*/dist/index.js`（假 spawn/fake pi harness）；引擎类逻辑必须探针覆盖
- **真 pi 冒烟必须隔离**：`pi -ne -e <entry/dist/index.js>`——本机全局装有旧版 `npm:pi-ptc-subagents`，不加 `-ne` 会同名互踩
- **四模式都已实测可用**（2026-10-26）：print（`-p`）/ json（`-p --mode json`，事件流可解析）/ rpc（`--mode rpc`，命令 `{"type":"prompt","message":...}` 走 stdin）/ TUI（全屏，用 kimi-cu 驱动真 Terminal——脚本方式起不来，需要图形界面）
- **floor 0.86.0 冒烟已过**（2026-10-26）：`ptc_run_code` 与程序内 `pi_task_ptc` 派发各一次；floor 测试用 `PATH=<0.86 bin>:$PATH` 让子进程也跑 0.86（详见 `docs/pi-version-matrix.md`）
- **中间版本 0.87–1.3 冒烟已过**（2026-10-26）：0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3 各跑一次 `ptc_run_code`；派发用例抽测 0.87 / 0.99 / 1.3（报告通道分水岭在 0.99）
- 子进程/execArgv 的坑：worker 继承宿主 execArgv，`-e` 场景要剥 eval 系参数（已实现，别回退）；shell 传秘密给探针用 `VAR=$(...) cmd`（前缀式），`&&` 链不 export
- pi 版本事实见 `docs/pi-version-matrix.md`（floor 0.86 / 当前 1.4.0；exposure getter、json 模式形状是已实测差异）

## 干净室规则（旧 ADR-0002）

旧分支（`main`、feat/258 等）的 `src/**` 实现源码**不许抄**；ADR、`docs/prototypes/*.html`、研究文档是合法输入。spec 是 `docs/prototypes/dispatch-doors-flow.html`（28 条决策，**决策 28：一个面一个编排器**——codemode_ptc 面上不注册 PTC 对，修订了 旧 ADR-0025 §3）。

## 文档地图

- `docs/prototypes/dispatch-doors-flow.html` — spec/决策（改动语义前先对质它）
- `docs/prototypes/ptc-runtime-status.html` / `dispatch-engine-status.html` — 两包现状全景（已做/未做/验证基线）
- `docs/adr/` — 决策记录 15 份（0001–0015，2026-10-26 重排）；旧实现的 0001–0046 / 0062–0065 归档在 `backup/main-legacy-20261026` 分支，文中引用写作「旧 ADR-xxxx」
- `docs/research/` — 历史证据笔记（含旧实现时期的研究；其中的 ADR 引用按旧编号）
- `docs/pi-version-matrix.md` — pi 版本兼容矩阵

## 规矩

- **改 PTC/dispatch 相关代码后，同步更新两份状态 HTML**（运行链路图、已做表、未做表、验证基线横幅）——用户明确要求，硬规矩
- 模型面散文（工具描述、通知文案、引导语）一律进 `routes`，工具/引擎文件里不许字面量。
  例外：子代理进程侧工具（`web_ds_search` / `ptc_child_report`）的描述留在各自包——它们只在 `PI_PTC_DEPTH>0` 注册，不进宿主路由册
- pi 接入事实：注册只发生在 `session_start`（factory 阶段 getActiveTools 是 throw 的桩）；动态可见性走 `defaultActive:false` + `setActiveTools`（exposure getter 在 1.4.0 实测不支持）

## 已知未做（按价值）

测试框架（探针转正 + 机械强制点门禁）· 发布形态（摘 private / dts / 详情指针）· floor 双端实测（executeTool / json 模式形状 / exposure 三处考古）· CHANGELOG（发布时新立）。详见 dispatch 状态页横幅。

已知小拧（记录在案）：`/ptc off` 后 `/ptc mode on` 会在已撤工具上收窄；pid 复用误判窗口（旧 ADR-0023 原样接受）；`-p` 模式通知进不进模型上下文未实测。
