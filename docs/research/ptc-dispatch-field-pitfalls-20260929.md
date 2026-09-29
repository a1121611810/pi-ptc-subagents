# pi.dispatch 在 PTC 模式下的使用陷阱现场报告

> 调研日期: 2026-09-29。来源: 真实业务会话（微信小程序仓库 candao-mp-cfb-mf-wx，
> 用 pi.dispatch 并发派发 code-review 双轴子代理），全部为第一手观察，错误串为原文。
> 环境: pi-coding-agent version: 0.87.1（bun 全局安装），pi-ptc-subagents 扩展，PTC 模式。
> 每条含: 现象 → 复现 → 错误原文 → 根因/规避 → 建议。

## 0. 速查表

| #   | 问题                                                                | 严重度 | 规避方式                                    |
| --- | ------------------------------------------------------------------- | ------ | ------------------------------------------- |
| 1   | 绑定名是字面 `pi.dispatch`，`tools.pi` 为 undefined                 | 中     | `tools["pi.dispatch"](args)`                |
| 2   | `agent` 参数必填，未配置时报 "unknown agent: undefined"             | 中     | 先在 `~/.pi/agent/agents/*.md` 注册 agent   |
| 3   | ptc 程序内 background 派发随程序结束丢失（lost_on_session_restart） | **高** | 程序内 Promise.all 并发 await 前台 dispatch |
| 4   | 默认 120s 程序超时截断前台 dispatch                                 | 中     | 显式传 `timeoutMs`（上限 600s）             |
| 5   | 工具绑定集在不同程序运行间不一致                                    | 低     | 首轮勿假设 grep/find 可用                   |
| 6   | 子代理长输出易被调用方截断丢失                                      | 低     | 派发提示词里要求紧凑输出                    |

## 1. 绑定名是字面 `pi.dispatch`，`tools.pi.dispatch` 不存在

**现象**: PTC 提示词写 "call this session's enabled built-in tools as `tools.<name>(args)`"，示例又是 `pi.dispatch({ background: true })`，自然写出 `tools.pi.dispatch(...)`。

**错误原文**:

```
TypeError: Cannot read properties of undefined (reading 'dispatch')
```

**根因**: 绑定名包含点号且按完整字符串注册，`Object.keys(tools)` 实测为
`["read","bash","edit","write","pi.dispatch","grep","find","ls"]` —— 必须用
`tools["pi.dispatch"]({...})`。

**规避**: 点号绑定一律用字符串索引访问。

**建议**: PTC 提示词模板与 `docs/usage/bgdispatch.md` 的示例统一写成
`tools["pi.dispatch"](...)` 形态（CONTEXT.md:71 已记录正确形态，但提示词侧未同步）。
未命名空间化的裸名工具（`tools.read`）与点号名工具混用时，建议提示词明示两类访问语法。

## 2. `agent` 参数无默认值，未配置 agent 时错误信息不可操作

**现象**: `pi.dispatch({ task, background: true, label })` 未传 `agent`，期望默认编码代理。

**错误原文**:

```
{"status":"rejected","errorMessage":"unknown agent: undefined (agentScope=user, ...)"}
```

**根因**: `agent` 是必填；agent 注册表来自 `~/.pi/agent/agents/*.md`（frontmatter
`name:` + 正文系统提示）。该机器仅有一个 `__smoke_echo` 冒烟代理，无任何编码类代理，
settings.json 也无 `agents` 键。现场验证：写入两个 agent 定义文件后重派即成功。

**规避**: 派发前确保 `~/.pi/agent/agents/<name>.md` 存在；用完自行清理（避免污染用户配置）。

**建议**:

- 错误消息改为可操作的：列出 `agentScope` 下已注册的 agent 名 + 注册路径 + 示例文件头。
- 考虑提供内置 fallback（如 `agent: "pi"` 默认当前模型/工具集），或文档明示"无默认代理"。

## 3. ptc 程序内 background 派发随程序结束被杀（本会话最严重问题）

**现象**: ptc_run_code 程序内两次 `pi.dispatch({..., background: true })`，函数返回
taskId 且 status=running；程序正常返回后，`ptc_task_list` 先显示无任务，随后两任务均
标记丢失。

**错误原文**（ptc_task_list 输出）:

```
01M3NMBCE33STF3DCBEP3YZVE9  lost  cr-spec    depth=1  review-spec   error=lost_on_session_restart
01M3NMBCDWJ9X2AMQBKVR7NHCR  lost  cr-standards depth=1 review-standards error=lost_on_session_restart
```

**根因**: 后台任务被挂到 **ptc 程序运行时**（"session"= 该次程序执行），程序返回即
会话重启/销毁，子代理被杀。宿主层工具描述（"background tasks stay callable when PTC
mode is off"）暗示任务寿命跨程序，实际并不成立——用户的直觉预期是"发后台任务 → 程序
结束 → 回头收结果"，当前实现下这是静默丢工作。

**规避**: 在**同一个 ptc 程序内**用 `Promise.all` 并发 await 两个前台 dispatch（实测
可行，两个子代理真正并行），并显式传 `timeoutMs`。

**建议**:

- 短期：`pi.dispatch` 工具描述与 `docs/usage/bgdispatch.md` 明示
  "background 任务在 PTC 程序内派发时随程序结束丢失"。
- 长期：后台任务挂到宿主 pi 会话生命周期，而非 ptc 程序会话；或在派发时给出
  存活域提示（"child of this program run"）。

## 4. 默认 120s 程序超时截断前台 dispatch

**现象**: 程序内并发 await 两个前台 dispatch，首次调用未传 `timeoutMs`：

```
code run failed (timeout): run timed out after 120000 ms
```

超时返回后，程序内已派发的前台子代理同样丢失（同 #3 的存活域问题）。

**规避**: `ptc_run_code` 显式传 `timeoutMs`（实测 540000 可用；上限 600s）。
子代理任务预算 > 剩余程序预算时，任务会被截断——长任务应拆分或提高整体预算。

**建议**: 文档写明"前台 dispatch 的可用时间 = 程序剩余超时预算"；`pi.dispatch`
可返回预估耗时提示，或支持任务级预算参数。

## 5. 工具绑定集在不同程序运行间不一致

**现象**: 同一会话内，第一个 ptc 程序报错：

```
ToolCallError: no binding named "grep" in this run; available bindings: read, bash, edit, write, pi.dispatch
```

后续程序 `Object.keys(tools)` 却包含 `grep/find/ls`。绑定面在运行间"长出来"，
提示词声称的可用工具与实际不符，首轮程序只能试错探测。

**规避**: 每个程序首轮先用 `Object.keys(tools)` 探测绑定面，勿假设扩展工具已就绪。

**建议**: 扩展（search-guard / FFF 类）的绑定注册若依赖懒加载，应在 ptc 程序启动前
固化绑定集，或把绑定面清单注入程序提示词。

## 6. 子代理长输出在调用方易被截断

**现象**: 首次并发派发返回后，调用方对结果做 `.slice(0, 4000)` 自保截断，
审查结论尾部（问题列表部分）被切断，不得不整轮重派。

**规避**: 在子代理系统提示里直接要求"最终回复 ≤ 40 行，只保留问题列表或 LGTM"
（实测有效）；调用方尽量原样透传 `result.text`。

**建议**: `pi.dispatch` 结果附结构化字段（findings 数组 / 结论标记），
而非全靠自然语言文本；宿主层提供结果暂存与分页读取。

## 附录 A: 最小复现（问题 #1/#2/#3）

```ts
// ptc_run_code 程序内
// #1 TypeError: Cannot read properties of undefined (reading 'dispatch')
await tools.pi.dispatch({ task: "hi" });

// 正确访问 + #2 未注册 agent 必失败
await tools["pi.dispatch"]({ task: "hi", background: true, label: "x" });
// → {"status":"rejected","errorMessage":"unknown agent: undefined ..."}

// #3 即使注册 agent，background 派发也会在程序返回后 lost_on_session_restart。
// 可用形态：同程序内并发前台派发
const [a, b] = await Promise.all([
  tools["pi.dispatch"]({ agent: "my-reviewer", task: "..." }),
  tools["pi.dispatch"]({ agent: "my-reviewer", task: "..." }),
]);
// ptc_run_code 需显式 timeoutMs（默认 120s，上限 600s）
```

## 附录 B: 现场排障路径（供复核）

1. `tools.pi.dispatch` → TypeError（问题 #1）。
2. 探测 `Object.keys(tools)` 发现字面名 `pi.dispatch` 与迟到绑定的 `grep/find/ls`（问题 #5）。
3. 裸派发 → rejected unknown agent（问题 #2）。
4. 查 `~/.pi/agent/settings.json` 无 agents 键 → `ls ~/.pi/agent/agents/` 仅
   `__smoke_echo.md` → 按其 frontmatter 格式注册两个代理后派发成功。
5. background 派发返回 running → 程序结束后 `ptc_task_list` 显示
   lost_on_session_restart（问题 #3）。
6. 改程序内 Promise.all 前台并发 → 首次未传 timeoutMs 120s 超时（问题 #4）→
   传 540000 成功，双代理真实并行返回。

## 附录 C: 根因定位与修复对照

> 2026-09-29 根因调查结论。正文（问题 #1–#6）保持原样；本节是后续定位的完整机制记录。

**机制**。后台 `pi.dispatch` 子进程以
`pi --mode json -p --session-dir <parentSessionDir> --session-id <taskId> --name bgdispatch:<taskId>`
启动（ADR-0022 R1），因此子进程与父进程**共享同一个 `<sessionDir>/tasks/` 存储**。
子进程是一个完整的 pi 进程：启动时扩展执行 `bindSession` → `reconcileLostTasks()`，
这是一个**目录级**清扫，把每一条 `running`/`stopping` 记录翻成
`lost`/`lost_on_session_restart`——子进程由此杀死自己的记录以及父进程刚写入的全部
兄弟记录（这正是问题 #3 的触发路径）。子进程退出时，`session_shutdown` 清扫
（`shutdown()` 调用链）再做一次目录级翻转，reason 为
`session_ended_while_running`，杀死仍在运行的兄弟记录（第二刀）。同样，
**任何**在同一 cwd（同 session dir）下启动的 `pi` 进程都会在启动时 reap 全部后台任务。
父进程"重启会话 → 清掉自己死掉的任务"的合理假设，在共享存储 + 目录级清扫的组合下
变成了"任何一个同目录进程都能清掉所有人的活任务"。

**判决：pi 会话语义无罪**。现场曾怀疑 pi 0.87.1 的会话重启语义发生变化导致任务丢失；
对照 0.86.1 与 0.87.1 验证，两者行为等价（0.86.1≡0.87.1），`--session-dir` /
`--session-id` / `--name` 三重语义与重启后的存储可见性均无差异。任务丢失完全由上述
扩展侧目录级清扫造成，与 pi 版本无关。

**修复落点（ADR-0023，task ownership）**：

1. 每条 `TaskRecord` 增加两个可选字段 `ownerPid` / `ownerBootMs`（拥有它的
   extension-runtime 实例标识），由 registry 的 spawn 命令盖戳——单一写入者，
   覆盖全部记录创建路径。
2. 启动 reconcile 改为 owner 作用域：只清扫 owner 进程已死（`isPidAlive` 信号 0 探测）
   或无 owner 字段的遗留记录；自己的记录与活着的兄弟进程的记录一律跳过。
3. `session_shutdown` 清扫改为只 reap 完全匹配自身 owner 身份的记录，且只对
   自己持有的 child handle 走 SIGTERM→grace→SIGKILL 阶梯。
4. `ptc_task_list` 可见性不变（跨进程 list/stop 语义仍 out of scope）；
   `lost_on_session_restart` / `session_ended_while_running` 字符串不变，含义收紧为
   "owner 进程先死 / owner 会话结束"。
5. 单测矩阵覆盖 own/foreign-alive/foreign-dead/legacy × running/stopping，
   关停清扫断言 foreign 记录不被 signaling；`tests/e2e/bgdispatch.test.ts` 在同 gate 下
   新增真实 spawn 用例（hermetic harness：临时 `PI_CODING_AGENT_DIR` 让子进程只加载
   工作区构建）：子进程启动 reconcile 与退出清扫后，兄弟任务记录不带任何被清扫痕迹
   （非 `lost`、无 lost reason），并自行到达 `succeeded`（含子进程自己的 PONG 输出）。
   中途不断言 `running`——echo 任务一秒内自然完成，那是有竞态的伪规格。

详见 [ADR-0023](../adr/0023-background-task-ownership.md)。已知限制：pid 复用可使
僵尸记录保持 `running`；同 pid 旧 bootMs 实例（同进程 `/reload`）的记录被视为
foreign-alive。
