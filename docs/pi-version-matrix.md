# pi 版本兼容矩阵（重写版）

floor = **0.86.0**（`peerDependencies: ">=0.86.0"`），ceiling = 跟踪最新（当前 1.4.0，类型固定在 devDependencies）。
本文件是旧仓 `docs/agents/pi-compat-matrix.md` 实测结论（15 版本逐一安装探针，2026-10-14/20 两次测量）的继承 + 1.4.0 增补。**断言 pi 行为前先看本机 `pi --version`**——node_modules 里的版本、PATH 上的版本、声明的 floor 是三个不同的数。

## 能力分水岭：0.99.0

以下能力全部在 **0.99.0 出现**，0.99.0 以下一律没有（旧 ADR 写「1.0.0 起」是测量点，不是出现点）：

| 能力                                                         | <0.99.0（含 floor）                          | ≥0.99.0  |
| ------------------------------------------------------------ | -------------------------------------------- | -------- |
| `ToolDefinition.outputSchema` / `exposure` / `defaultActive` | 类型缺失，**运行时被忽略**（注册即面向模型） | 完整支持 |
| `AgentToolResult.isError` 通道                               | 无，失败靠 throw                             | 有       |
| `structuredContent` 转发给 codemode 脚本                     | 无                                           | 有       |
| codemode 本体 / MCP 自动激活 codemode                        | 无                                           | 有       |

**floor 0.86.0 的运行时含义**（不是缺陷，是「pi 不提供这个 API」）：

- `exposure` 被忽略 → 我们的 codemode 门在 floor 上对模型可见（≥0.99.0 才真正实现「模型不可见」）
- codemode 不存在 → 门注册后无从被脚本调用（无 codemode surface）
- 失败工具 throw 而不是 isError → 调用方 try/catch 语义两版都要

## 1.x 增量（对本的包有意义的）

- **1.0.0**：`-builtin:<name>` 可禁内置扩展；`registerToolRenderer` API
- **1.1.0**：扩展 pattern 过 `normalizePath`（tilde/file://）；codemode 声明 `reachesTools`；`-p` 截断响应 exit 1；发布版 settings schema
- **1.2.0 / 1.3.0**：对我们无行为变化（16 项能力探针两版全 ✓，codemode switch 差分 40 案例一致）
- **1.4.0（2026-10-21，本矩阵新增，旧仓未测）**：
  - **codemode 满员改为排队等**（最长 60s，`PI_CODEMODE_MAX_WORKERS` 调上限）——与我们的 libuv 式准入队列方向一致
  - **#11062 恢复会话/分支时扩展工具默认激活**（除非 `defaultActive: false`）——影响 task face 的可见性设计
  - 摘要不再受固定输出上限（compaction 修复）；`before_provider_headers` 归因头变化（我们不碰）

## 硬约束（重写仍然成立的事实）

- pi **无 unregisterTool**：撤工具 = 同名重注册 `exposure: "hidden"`（`registerTool` 是 Map.set）；声明集每个模型请求重算，下一 turn 才生效 → `/ptc off` 的同 turn 窗口靠 `dispatch()` 里的闸接（纵深防御）
- factory 阶段的 `getAllTools()`/`getActiveTools()` 是 `notInitialized` 桩 → **注册必须发生在 `session_start`**（ADR-0035）
- `ctx.ui.notify` 在 `-p`/`json` 模式下是 no-op
- pi 的**两个 settings 文件由两个不同函数解析**（项目侧位置优先、用户侧固定顺序），任何镜像都有 two-functions 陷阱——不要再写镜像，session_start 直接问 pi

## 实测增补（2026-10-26，本重写分支）

- **真 pi 冒烟：1.4.0 与 floor 0.86.0 各一次全过**（2026-10-26）：`-ne -e packages/entry/dist/index.js` 隔离；`ptc_run_code` 求值 `6*7` → 42；程序内 `tools.pi_task_ptc({wait:true})` 建真子进程并回收报告（floor 用 `PATH=/tmp/pi086/node_modules/.bin:$PATH` shim，让子进程也跑 0.86）。floor 上 `loadSkills/formatSkillsForPrompt/getAgentDir` 导出齐备（静态 import 可加载）。
- **0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3 冒烟（2026-10-26）**：每版跑真 pi 一次——`ptc_run_code` 求值 42 全过；派发用例抽测 **0.87**（分水岭前，报告走 prompt-json 兜底）/ **0.99**（分水岭，tool 通道首选）/ **1.3**（最新前一版），均 `fulfilled` + 产出 `ok`。同一 minor 内的补丁版（0.87.1、0.99.1/2、1.0.1–4）未单独安装——改动面按 minor 分水岭取样。
- floor 上报告通道走 prompt-json 兜底（`structuredContent` <0.99 不存在），结果正常；tool 通道的 floor 形状未单独取证。
- **exposure 传函数（getter）在 1.4.0 不被支持**：隔离探针（`-ne` 只加载探针扩展）翻转标志位后，工具仍不出现在声明集。动态可见性须走 `defaultActive: false` + `setActiveTools` 增删（可调用性实测有效；是否同步进模型声明清单未确证）。
- 冒烟隔离：`pi -ne -e <path>`——本机全局装有旧版 `npm:pi-ptc-subagents`，不加 `-ne` 会同名互踩（registerTool 是 Map.set，后注册者覆盖）。

## 待测

中间版本的**执行链冒烟**已覆盖（0.87 / 0.99 / 1.0 / 1.1 / 1.2 / 1.3，见上）；仍未做的：同一 minor 的补丁版逐版安装（按 minor 分水岭取样）、`1.x` 能力表里未直接观测的 codemode 差分（依赖旧仓 16 项探针结论）、floor 的 codemode/exposure 行为（0.99 以下本就没有）。下次 pi 发版或动了门/可见性/codemode 探测相关代码时补测。
