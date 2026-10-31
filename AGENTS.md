# AGENTS.md — pi-ptc-subagents

pi 的扩展：PTC（模型写 TypeScript 程序批量调工具）+ 子代理派发。当前是 `feat/rewrite` 分支上的**干净室重写**（只按 ADR/spec 写，不抄旧实现源码）。

## 包结构（packages/，pnpm workspace）

| 包         | 职责                                                                                                               | 依赖                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `entry`    | pi extension 装配：session_start 注册、surface 检测、PTC 模式（程序优先引导层）、/ptc off 截断、通知投递           | → 全部                             |
| `ptc`      | 程序运行时：worker 池、dispatcher、严格模式编译、工具工厂、renderResult                                            | → sub→dispatch、tui、routes        |
| `dispatch` | 任务引擎：六道闸、DispatchSlotCounter（libuv 队列）、spawn/pump、registry（落盘+重启恢复）、child report、通知中心 | 无（叶子）                         |
| `task`     | 任务面：list/output/stop 的读/停语义（分层读取：超阈值引导读报告）                                                 | → dispatch                         |
| `tui`      | 渲染原语叶子：文本卫生、截断契约、渲染预算                                                                         | 无                                 |
| `output`   | 输出核（P0 拆分）：renderToolResult（结果→模型可见文本）、ResultTextOutcome 结构切片；Kimi 面（MCP）与 pi 面共用   | → tui（叶子）                      |
| `kimi-mcp` | Kimi 面（MCP，ADR-0020）：双工具——ptc_run_code（运行格 + fs 四件套，workdir 锁）/ web_ds_search（宿主中立搜索核）  | → output、ptc 核心、routes、search |
| `routes`   | 模型面散文唯一出处（ADR-0013）：7 条路的册子 + 渲染器（索引/通知/引导语）+ Kimi 面 KIMI_MCP_RUN_CODE 块            | 无（叶子）                         |
| `search`   | 搜索 provider 抽象（DeepSeek 首家）：三动作工具、配额、记忆、预算                                                  | → tui                              |

依赖铁律：**tui / routes / output 是叶子**（不感知领域概念）；`dispatch` 持全部任务状态，其余只是调用方；宿主依赖单向——pi-tui 只出现在 ptc（render.ts 折叠渲染），`output` 零宿主依赖。

## 工具链（根目录）

`pnpm run check`（tsrs 类型检查）· `build`（rolldown）· `build:kimi`（kimi-mcp bundle → `release/kimi/` 装配 + 版本自检，ADR-0020）· `lint`（oxlint）· `fmt` / `fmt:check`（oxfmt）——改动后四件套全绿才算完。改文件用 Edit 工具；**不要用脚本做整段文本替换**（oxfmt 折行会让锚点失配，本仓已踩六次）。

## 验证纪律

- 探针直接跑 `node` 打 `packages/*/dist/index.js`（假 spawn/fake pi harness）；引擎类逻辑必须探针覆盖
- **仓库测试三制**：`test:pi`（`tests/pi/`，假 pi harness）/ `test:output`（`tests/output/`，宿主中立输出核）/ `test:kimi`（`tests/kimi/`，假 MCP 客户端 stdio 打 server bundle）；`pnpm test` 串跑（改代码后先 `build` 再 `test`）——两面的探针资产互不过河
- **真 pi 冒烟必须隔离**：`pi -ne -e <entry/dist/index.js>`——本机全局装有旧版 `npm:pi-ptc-subagents`，不加 `-ne` 会同名互踩
- **16 版本冒烟脚本化**：`scripts/version-smoke.sh`（发版前手工全量，四腿契约：run_code 求值 / 程序内 tools.read（0.99 分水岭：≥0.99 返回数字、floor 明确报 ERR:）/ ptc_workflow parallel / wait:false + 任务面 list·output；`SMOKE_VERSIONS="1.3.0"` 可单版本快查；缺 shim 自动装到 `$SHIM_ROOT`——⚠️ 真包名是 `@earendil-works/pi-coding-agent`，npm 上的 `pi` 是 pi-number，装错包没有 `pi` 这个 bin）
- **旋钮真机探针**：`scripts/knobs-smoke.mjs`（断言不靠模型配合——旋钮是引擎/argv 层的，宿主自己看：`timeoutMs` 真收尸 / `projectContext` auto-vs-none 引擎层 A/B / 报告通道 / usage 兜底 / 口径事实；切版本跑：`PATH=<该版 bin>:$PATH node scripts/knobs-smoke.mjs`；2026-10-31 实测 0.86.0/0.87.1/0.99.0/1.0.0/1.1.0/1.2.0/1.3.0/1.4.0 **八版全过**）
- **`projectContext:none` 的真实语义：省 token，不隔离知识**（2026-10-31 真机 + bench）：none 只去掉注入
  （孩子系统提示词少一节 `project_context`），文件仍在 cwd、pi 内置工具无 cwd 囚禁 ⇒ 孩子会自己
  `read AGENTS.md` 并照样用上口径（实测 none 臂答案与 auto 臂相同，输入只差 −15%，不是 −45%）。
  口径确实有用时模型 **3/3 轮显式选 auto、0 次 none** ⇒ 「用不用由模型自己判断」在旋钮上成立。
- **四模式都已实测可用**（2026-10-26）：print（`-p`）/ json（`-p --mode json`，事件流可解析）/ rpc（`--mode rpc`，命令 `{"type":"prompt","message":...}` 走 stdin）/ TUI（全屏，用 kimi-cu 驱动真 Terminal——脚本方式起不来，需要图形界面）
- **floor 0.86.0 冒烟已过**（2026-10-26）：`ptc_run_code` 与程序内 `pi_task_ptc` 派发各一次；floor 测试用 `PATH=<0.86 bin>:$PATH` 让子进程也跑 0.86（详见 `docs/pi-version-matrix.md`）
- **中间版本 0.87–1.3 冒烟已过**（2026-10-26）：0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3 各跑一次 `ptc_run_code`；派发用例抽测 0.87 / 0.99 / 1.3（报告通道分水岭在 0.99）
- 子进程/execArgv 的坑：worker 是**自包含 bundle，execArgv 恒为空数组**（2026-10-28 真机修订）——继承是净亏损：pi 的 eval 系、Kimi 宿主传的 V8 调优旗标（`--max-semi-space-size=16`）都会被 worker_threads 旗标校验拒（真机实测）；shell 传秘密给探针用 `VAR=$(...) cmd`（前缀式），`&&` 链不 export
- pi 版本事实见 `docs/pi-version-matrix.md`（floor 0.86 / 当前 1.4.0；exposure getter、json 模式形状是已实测差异）

## codegraph 使用约定（2026-10-27 实测）

- 结构问题（X 怎么工作 / X 怎么调到 Y / 摸一片区域）**先 `mcp__codegraph__codegraph_explore`**，返回的源码视为已读，不要 grep 复核
- 改符号前的精确调用方/传递影响面（符号级 + 行号）：`mcp__codegraph__codegraph_callers` / `codegraph_impact`（explore 只给 caller 计数，铁律场景用这两个）；掉线时 CLI `codegraph callers/impact <symbol>` 等价
- 派发探索类子代理时，briefing 里写明「先 codegraph explore，结果视为已读」——否则子代理照旧逐文件读，图变纯开销（官方实测警告）
- 索引不覆盖 `docs/prototypes/*.html` 与 ADR——spec 对质照旧读 HTML；散文文案查找用 Grep
- 新文件 watcher 约 4s 进图（v1.6.2 实测），查不到先等再怀疑
- 已知：kimi-code 启动 MCP 默认 30s 超时，codegraph 冷启动下载 bundle 会超时掉线（已在 `~/.kimi-code/mcp.json` 加 `startupTimeoutMs: 120000`）；掉线时 CLI 是全功能退路

## 干净室规则（旧 ADR-0002）

旧分支（`main`、feat/258 等）的 `src/**` 实现源码**不许抄**；ADR、`docs/prototypes/*.html`、研究文档是合法输入。spec 是 `docs/prototypes/dispatch-doors-flow.html`（29 条决策，**决策 28：一个面一个编排器**——codemode_ptc 面上不注册 PTC 对，修订了 旧 ADR-0025 §3；**决策 29：任务痕迹容量边界**——终态记录留最近 500 条，最老先出，未终态永不驱逐）。

## 文档地图

- `docs/prototypes/dispatch-doors-flow.html` — spec/决策（改动语义前先对质它）
- `docs/prototypes/ptc-runtime-status.html` / `dispatch-engine-status.html` — 两包现状全景（已做/未做/验证基线）
- `docs/adr/` — 决策记录 20 份（0001–0020，0001–0015 于 2026-10-26 重排）；旧实现的 0001–0046 / 0062–0065 归档在 `backup/main-legacy-20261026` 分支，文中引用写作「旧 ADR-xxxx」
- `docs/INDEX.md` — 全量文档索引（每份一行：是什么 / 验证状态 / 处置候选）——要压文档或决定删哪份，先看它
- `GLOSSARY.md` — 领域词表（词汇随 ADR/spec 走；写 issue/提案/测试名时用这里的词）
- `docs/research/` — 历史证据笔记（含旧实现时期的研究；其中的 ADR 引用按旧编号）
- `docs/pi-version-matrix.md` — pi 版本兼容矩阵

## 规矩

- **改 PTC/dispatch 相关代码后，同步更新两份状态 HTML**（运行链路图、已做表、未做表、验证基线横幅）——用户明确要求，硬规矩
- 模型面散文（工具描述、通知文案、引导语）一律进 `routes`，工具/引擎文件里不许字面量。
  例外：子代理进程侧工具（`web_ds_search` / `ptc_child_report`）的描述留在各自包——它们只在 `PI_PTC_DEPTH>0` 注册，不进宿主路由册
- pi 接入事实：注册只发生在 `session_start`（factory 阶段 getActiveTools 是 throw 的桩）；动态可见性走 `defaultActive:false` + `setActiveTools`（exposure getter 在 1.4.0 实测不支持）

## 已知未做（按价值）

**发布包不带 dts —— 已评估，不做**（2026-10-31 实测过）：卡点不是「能不能生成」——
`tsrs`（TS7 原生编译器）能直接 emit d.ts（8 个包 50 个 .d.ts 出得来，**不必引入 typescript 依赖**），
假发布形态下消费者解析实测也通过；真卡点是**发布形态**：单包 `pi-ptc-subagents` 的 d.ts 引用 7 个
未发布的 `@pi-ptc/*` 子包（npm 上 `@pi-ptc/routes` = 404）⇒ 消费者解析会断。三条可选路：
(a) 9 个子包各自发布、各带 dts；(b) dts 打包内联（需新工具或新依赖）；(c) 收窄 entry 的公开类型面。
当前 TS 消费者为 0（宿主是 JS 运行时）⇒ 维持不做。

floor 三处考古（executeTool / json 模式形状 / exposure）——**2026-10-31 已做完**，结论见
`docs/pi-version-matrix.md` 的 2026-10-31 节（含三处文档事实更正：floor 上 codemode 门不注册、
floor 的 usage 早有 cacheRead/cacheWrite、floor 有 setActiveTools）。

已知小拧（记录在案）：pid 复用误判窗口（旧 ADR-0023 原样接受）；`-p` 模式通知进不进模型上下文未实测。

## Agent skills

### Issue tracker

Issue 走 GitHub Issues，一律用 `gh` CLI（远端 `a1121611810/pi-ptc-subagents`，已登录）。详见 `docs/agents/issue-tracker.md`。

### Triage labels

五个标准 triage 标签原样使用：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：根目录一个 `GLOSSARY.md`（已建，词汇随 ADR/spec 走）+ 根目录 `docs/adr/`（已有 0001–0016）。详见 `docs/agents/domain.md`。
