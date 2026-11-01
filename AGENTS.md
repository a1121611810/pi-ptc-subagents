# AGENTS.md — pi-ptc-subagents

pi 的扩展：PTC（模型写 TypeScript 程序批量调工具）+ 子代理派发。当前是 `feat/rewrite` 分支上的**干净室重写**（只按 ADR/spec 写，不抄旧实现源码）。

## 包结构（packages/，pnpm workspace）

| 包         | 职责                                                                                                                                                | 依赖                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `entry`    | pi extension 装配：session_start 注册、surface 检测、PTC 模式（程序优先引导层）、/ptc off 截断、通知投递；PTC 工具工厂、pi 折叠渲染、绑定表、任务门 | → 全部                        |
| `ptc`      | PTC 引擎（产品）：运行格、worker 池、dispatcher、严格模式编译、文件四件套绑定——零依赖零宿主，可脱离 pi 单独安装                                     | 无（叶子）                    |
| `dispatch` | 任务引擎：六道闸、DispatchSlotCounter（libuv 队列）、spawn/pump、registry（落盘+重启恢复）、child report、通知中心                                  | 无（叶子）                    |
| `task`     | 任务面：list/output/stop 的读/停语义（列表封顶 + 精简字段；产出走归约层：孩子的散文正文）                                                           | → dispatch、tui、routes       |
| `tui`      | 显示层（ADR-0022）：根 = 共享文本零件（文本卫生、截断契约、渲染预算，零依赖）；`/pi` 子路径 = pi 画面（折叠渲染 + 常驻子代理状态面板）              | 根 → 无；`/pi` → pi-tui       |
| `output`   | 输出核（P0 拆分）：renderToolResult（结果→模型可见文本）、ResultTextOutcome 结构切片；Kimi 面（MCP）与 pi 面共用                                    | → tui（叶子）                 |
| `kimi-mcp` | Kimi 面（MCP，ADR-0020）：双工具——ptc_run_code（运行格 + fs 四件套，workdir 锁）/ web_ds_search（宿主中立搜索核）                                   | → output、ptc、routes、search |
| `routes`   | 模型面散文唯一出处（ADR-0013）：7 条路的册子 + 渲染器（索引/通知/引导语）+ Kimi 面 KIMI_MCP_RUN_CODE 块                                             | 无（叶子）                    |
| `search`   | 搜索 provider 抽象（DeepSeek 首家）：三动作工具、配额、记忆、预算                                                                                   | → tui                         |

依赖铁律：**tui 的根入口 / routes / output / ptc 是叶子**（不感知领域概念；`ptc` 更是零依赖零宿主——引擎可脱离 pi 单独安装）；`dispatch` 持全部任务状态，其余只是调用方；宿主依赖单向——pi-tui 的**导入点**只在 `packages/tui/pi`（pi 画面层，ADR-0022），但 **`entry` 打包出的 `dist/index.js` 仍 import 它** ⇒ entry 的 package.json 也要声明它（**声明跟产物走，不只跟源码走**：干净树安装解析不到就是红，2026-11-02 发版前实测抓到）；`output` 与 `ptc` 零宿主依赖。

**引擎单独使用（2026-11-01）**：`packages/ptc` 是零依赖零宿主的 PTC 引擎——装根包后 `import { runPtcProgram, createFsBindings } from "pi-ptc-subagents/ptc"` 即可脱离 pi 与模型跑程序（绑定契约见 GLOSSARY.md），命令行 `ptc <program.ts> --workdir .`。模型面（工具工厂 / 绑定表 / 任务门）在 `packages/entry`，pi 画面（折叠渲染 / 常驻子代理状态面板）在 `packages/tui/pi`——只有 pi 面用；Kimi 面直接用引擎 + `createFsBindings`，不经模型面。

## 工具链（根目录）

`pnpm run check`（tsrs 类型检查）· `build`（rolldown）· `build:kimi`（kimi-mcp bundle → `release/kimi/` 装配 + 版本自检，ADR-0020）· `lint`（oxlint）· `fmt` / `fmt:check`（oxfmt）——改动后四件套全绿才算完。改文件用 Edit 工具；**不要用脚本做整段文本替换**（oxfmt 折行会让锚点失配，本仓已踩六次）。

## 验证纪律

- 探针直接跑 `node` 打 `packages/*/dist/index.js`（假 spawn/fake pi harness）；引擎类逻辑必须探针覆盖
- **仓库测试四制**：`test:pi`（`tests/pi/`，假 pi harness）/ `test:output`（`tests/output/`，宿主中立输出核）/ `test:kimi`（`tests/kimi/`，假 MCP 客户端 stdio 打 server bundle）/ `test:standalone`（`tests/standalone/`，引擎脱离 pi 与模型自跑）；`pnpm test` 串跑（改代码后先 `build` 再 `test`）——各面的探针资产互不过河
- **真 pi 冒烟必须隔离**：`pi -ne -e <entry/dist/index.js>`——本机全局装有旧版 `npm:pi-ptc-subagents`，不加 `-ne` 会同名互踩
- **真 TUI 可脚本化验证（2026-11-02 新路，不必等图形界面）**：真 pi 的 TUI 模式能跑在真 pty 上——`(cat prompt.txt; sleep 4; printf "\r"; sleep 100) | script -q /tmp/tui.log sh -c 'stty rows 40 cols 120; pi -ne -e <entry/dist/index.js>'`（`script` 造 pty 并定死 120×40；⚠️ **管道里的换行不会提交提示词**，必须补一个显式 `\r`；捕获是字节流，要用 `pyte` 重建屏幕帧再断言）⇒ 比 kimi-cu 驱动真终端更可复现，也更严（窄屏更容易折行/撞上限）。2026-11-02 用它验了常驻子代理状态面板：画在编辑器正上方、随任务完成实时更新、全部跑完即消失——并抓到「标题把历史会话的恢复记录算进来（succeeded 180）」这个真缺陷
- **16 版本冒烟脚本化**：`scripts/version-smoke.sh`（发版前手工全量，四腿契约：run_code 求值 / 程序内 tools.read（≥0.99 走 pi 会话工具返回数字；floor 无通道 ⇒ 用 pi 自造的工具，同样返回数字）/ ptc_workflow parallel / wait:false + 任务面 list·output；`SMOKE_VERSIONS="1.3.0"` 可单版本快查；缺 shim 自动装到 `$SHIM_ROOT`——⚠️ 真包名是 `@earendil-works/pi-coding-agent`，npm 上的 `pi` 是 pi-number，装错包没有 `pi` 这个 bin；2026-11-01 引擎抽出后实测 **16/16 全过**：0.86.0/0.86.1/0.87.0/0.87.1/0.99.0/0.99.1/0.99.2/1.0.0–1.0.4/1.1.0/1.2.0/1.3.0 + PATH 1.4.0，fails=0；同日第二轮 floor 退回绑定后**再跑 16/16 全过**——floor 四版的 READ 从「ERR:」变成数字 2216；同日第四轮 floor 自造工具加版本门后**第三次 16/16 全过**——floor 四版与 ≥0.99 的 READ=2216 逐字相同；**2026-11-02 显示层拆子路径（packages/tui/pi）+ entry 瘦身后复跑仍 16/16 全过**，fails=0）
- **旋钮真机探针**：`scripts/knobs-smoke.mjs`（断言不靠模型配合——旋钮是引擎/argv 层的，宿主自己看：`timeoutMs` 真收尸 / `projectContext` auto-vs-none 引擎层 A/B / 报告通道 / usage 兜底 / 口径事实；切版本跑：`PATH=<该版 bin>:$PATH node scripts/knobs-smoke.mjs`；2026-10-31 实测 0.86.0/0.87.1/0.99.0/1.0.0/1.1.0/1.2.0/1.3.0/1.4.0 **八版全过**）
- **压缩重注入真机探针**：`scripts/compact-inject-smoke.mjs`（断言不靠模型配合——压缩由 rpc 的 `compact` 命令在 agent 空闲时触发，注入由第二个扩展读请求上下文验；脚本自建隔离配置目录：只拷凭据与 models*，`keepRecentTokens` 压到 1000；切版本跑：`node scripts/compact-inject-smoke.mjs <该版 bin 目录>`；2026-11-01 实测 floor 0.86.0 与 1.4.0 **两端全过**）。⚠️ 四个坑写在脚本头：rpc 命令走 **stdin**、压缩要等 **agent 空闲**、floor 0.86 读 **`models.json`** 拿 provider 配置、会话要比 **`keepRecentTokens`** 大
- **会话模型继承真机探针**：`scripts/session-model-smoke.mjs`（断言全宿主自读——父的模型从父的 `message_end` 读、孩子的从孩子自己的 `output.log` 事件流读；模型只负责「派一个孩子」，程序体里出现 `model:` 参数即判红，那测的就不是继承了。**跑两轮差分**：父显式 `minimax-cn/MiniMax-M3.1-Flash` vs 父用默认（`minimax-cn-512k/…`）——孩子必须跟着各自的父走，写死任何一个模型都会红。切版本跑：`PATH=<该版 bin>:$PATH node scripts/session-model-smoke.mjs`；2026-10-31 实测 0.86.0/0.87.1/0.99.0/1.0.0/1.1.0/1.2.0/1.3.0/1.4.0 **八版全过**；负向对照已验：撤掉 entry 的接线重跑即红——孩子落到 pi 默认模型 `minimax-cn-512k`）
- **停滞护栏（宿主自愈，2026-10-31 深夜）**：孩子「什么都没在做」就被收尸——**引擎侧**默认 5 分钟，**不进模型面**（不是旋钮，宿主不替模型选）；口径两条同时成立才算停滞：① 距上次有动静（stdout 新字节）超阈值 ② 没有在飞的工具调用（`tool_execution_start` 没配上 `tool_execution_end`）。收尸复用既有信号阶梯（SIGTERM → 5s → SIGKILL），`stopReason` 写明 `stalled: no activity for Nms`。**与 `timeoutMs` 并行**：墙钟管预算与 straggler 摘除，护栏只管「什么都没在做」——**不改 `timeoutMs` 语义**（bench 实测本仓痛点是慢孩子拖住整轮，不是误杀）。抓不到的：工具循环（一直在出声）——那要模型判进展。阈值必须大于「provider 等首 token」与「一次上下文压缩」的耗时（这两段是静默的：pi 的 assistant `message_start` 在 provider start 事件**之后**才发，压缩没有事件）
- **`projectContext:none` 的真实语义：省 token，不隔离知识**（2026-10-31 真机 + bench）：none 只去掉注入
  （孩子系统提示词少一节 `project_context`），文件仍在 cwd、pi 内置工具无 cwd 囚禁 ⇒ 孩子会自己
  `read AGENTS.md` 并照样用上口径（实测 none 臂答案与 auto 臂相同，输入只差 −15%，不是 −45%）。
  口径确实有用时模型 **3/3 轮显式选 auto、0 次 none** ⇒ 「用不用由模型自己判断」在旋钮上成立。
- **四模式都已实测可用**（2026-10-26）：print（`-p`）/ json（`-p --mode json`，事件流可解析）/ rpc（`--mode rpc`，命令 `{"type":"prompt","message":...}` 走 stdin）/ TUI（全屏，用 kimi-cu 驱动真 Terminal——脚本方式起不来，需要图形界面）
- **floor 0.86.0 冒烟已过**（2026-10-26）：`ptc_run_code` 与程序内 `pi_task_ptc` 派发各一次；floor 测试用 `PATH=<0.86 bin>:$PATH` 让子进程也跑 0.86（详见 `docs/pi-version-matrix.md`）
- **floor（0.86/0.87）自己造出 pi 的真工具来调**（2026-11-01）：平台没有 `ctx.executeTool`，但 pi 的
  **工具工厂是公开导出**（`create*ToolDefinition(cwd)`，0.86.0–1.4.0 全有），返回带 `execute` 的完整
  ToolDefinition，且那些 `execute` **独立于 agent 循环**（只用 `ctx?.cwd || cwd`）⇒ floor 的程序工具集
  与参数形状与 ≥0.99 **逐字一致**（`read`/`write`/`edit`/`grep`/`ls`/`find`；`edit` 是 pi 的
  `{path, edits:[{oldText,newText}]}`）。改的是 entry 的绑定表，**引擎一行没动**。直接调 `execute` 会
  跳过管线的 `prepareArguments` 垫片（已补）与参数 schema 校验（未补，参数不合法由工具自身抛错）
- **floor 那条自造工具的路有版本门**（2026-11-01）：只在 **pi < 0.99** 开放（判定照抄
  `packages/dispatch/src/child-process.ts` 的 `supportsNoMcp` 写法，版本来自 `pi --version`）。现代 pi 上
  认不出 `ctx.executeTool` 是**异常** ⇒ 报错，不悄悄绕过 pi 的工具管线——否则别的扩展的 `tool_call` 钩子
  拦不到程序发起的调用、用量也不记。版本认不出（取不到）→ 当作有通道
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
- **任务面响应一律是对象，不是数组**（2026-11-01 起）：`ptc_task_list` 给 `{ scope, total, tasks[] }`（`total` 是候选总数，比返回条数大说明还有更早的记录没列出来）；`ptc_task_output` 给记录 + 归约层（`text` = 孩子的散文正文，报告只是摘要）。列表**只能做条目级裁剪**——文本级截断会把 JSON 砍成半截，`JSON.parse` 直接抛
- 压缩后重注入：pi 的 `context` 事件的 handler 返回值**替换**本次请求的可见消息（不累积、不进会话记录）⇒ 要连 `event.messages` 一起返回；`session_compact` 置标志、下一次 LLM 调用前注入一次即清标志。事件形状在 floor 0.86 与 1.4.0 同形（无版本门），但**真机只验过 1.4.0**

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
