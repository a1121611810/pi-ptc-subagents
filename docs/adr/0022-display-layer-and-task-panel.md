# 显示层归位 tui：子路径隔离、三种受众与常驻子代理状态面板

Status: accepted (2026-11-01)。

## Context

**一、一个包的边界从来没被写下来，于是名字和职责分了家。**

旧实现里**没有 `tui` 这个包**：旧树 `src/` 只有 `mode` / `runtime` / `tools`，画面渲染住在 `src/tools/render.ts` 与 `src/tools/task-panel-render.ts`。`packages/tui` 是干净室重写（`60ae2e7`）时**新造**的包，而 spec 决策册（`docs/prototypes/dispatch-doors-flow.html`）一次都没提过它——二十余份 ADR 里也没有一份覆盖它的边界（只有 ADR-0016 顺带引用过 `packages/tui/src/bounds.ts`）。于是包被切出来时只带走了名字，没带走意图。

今天 `@pi-ptc/tui` 的五个消费方里，四个（`output` / `search` / `task` 的两处）用它做**模型面字符串整形**，只有 `entry` 用它做**pi 画面**。也就是说：它的真实职责是「共享字符串零件」，而 `tui` 这个名字承诺的是「界面层」。**名字与职责的裂缝**就是「本该专门渲染显示（乃至 todo 式面板）的那层」在重写里丢掉的地方。

**二、需求：一个常驻在 pi TUI 编辑器上方的子代理状态面板。**

参照物是 `@juicesharp/rpiv-todo`：它给 pi 补了 `todo` 工具 + `/todos` 命令 + 编辑器上方的实时浮层，面板跨 `/reload` 与压缩存活。取用的不是它的 todo 语义（那是模型自己的计划清单，本仓不重造），而是**「把状态从模型上下文搬到人的视线里」这件事**——本仓的状态是**派出去的子代理**（`TaskRegistry` 里的 `TaskRecord`）。

**三、实测事实（2026-11-01，逐条读 pi 1.4.0 与 floor 0.86.0 的类型与实现）。**

| 事实                                                                                                                                                                              | 出处                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ctx.ui.setWidget(key, string[] \| factory, { placement })` 在 0.86.0 与 1.4.0 **签名逐字同形**                                                                                   | `pi086/.../extensions/types.d.ts:98` vs `pi-1.4.0/.../types.d.ts:101`          |
| `placement` 只有 `aboveEditor` / `belowEditor`，默认 `aboveEditor`                                                                                                                | 同上 `WidgetPlacement`                                                         |
| 宿主自带 **10 行** widget 上限，超出追加 `... (widget truncated)`                                                                                                                 | `interactive-mode.js` `MAX_WIDGET_LINES = 10`                                  |
| 同一 key 重复 set **幂等**（先删旧再设新）；`undefined` = 卸载                                                                                                                    | `setExtensionWidget` → `removeExisting`                                        |
| pi-tui 的 `Text` **保留 ANSI**、不套默认颜色 ⇒ 字符串数组可直接上色                                                                                                               | `pi-tui/dist/components/text.js`（`wrapTextWithAnsi` 注释明写 preserves ANSI） |
| floor 0.86 也有 `ctx.ui.theme` 与 `Theme.fg` ⇒ 颜色无需版本门                                                                                                                     | `pi086/.../types.d.ts:108`、`theme.d.ts:31`                                    |
| `ctx.hasUI` 在 **RPC 模式也是 true**；print/json 模式下 `ctx.ui` 是 **no-op 桩**（`setWidget: () => {}`，不抛）                                                                   | pi `types.d.ts` 的 `hasUI` 注释、`core/extensions/runner.js:143`               |
| RPC 模式**真的实现了** `setWidget`（只支持 string[]，factory 被忽略），会向客户端发 `extension_ui_request`                                                                        | `modes/rpc/rpc-mode.js:123-136`                                                |
| registry **每次记录变迁都 `#emit`**（spawn / transition / stop / resolve-exit / attach-report / attach-output）                                                                   | `packages/dispatch/src/registry.ts:100,136,147,178`                            |
| 发布产物 `dist/index.js` 只有两个外部 import（`pi-coding-agent` / `pi-tui`），根包 `dependencies` 为空 ⇒ pi 宿主在运行时提供它们                                                  | `dist/index.js`、根 `package.json`                                             |
| **Kimi 产物 `release/kimi/server.js` 里 `@earendil-works` 出现 0 次**                                                                                                             | 实测 grep                                                                      |
| rolldown 的 `resolve.alias` 对字符串键是**前缀匹配** ⇒ 子路径导入需更长 alias 且排在短 alias 之前（实测：短 alias 单独存在时子路径 `UNRESOLVED_IMPORT`，长 alias 在前则构建成功） | 本仓 `rolldown@1.2.15` 实测                                                    |

**四、旧 ADR-0022 §11 的教训要照着走。**

旧 ADR-0022 §11 为旧任务面板（工具结果里的那一块）注册了五条冻结上限，并写明「本文件是这些数字的第一次书面登记；改动其中任何一个都是行为变更，需要新 ADR」。但同一节也承认：**任务面板的状态→颜色映射从未写进任何文档**（`docs/` 下没有），只有旧实现自己的常量表里有。本 ADR 补上这一条。

## Decision

**1. 「显示」有三种受众，不是一个。** 模型可见文本（`packages/output` 的输出核，pi 面与 Kimi 面共用）、pi 画面（编辑器里给人看的东西）、共享字符串零件（谁都能用的文本整形与截断）。把三者混成「显示层」会再次分家。

**2. `packages/tui` 是显示层，形状是「一个包、两个子路径」。**

```
packages/tui/
  src/index.ts      → 共享文本零件（truncateLine / sanitizeText / RENDER_BOUNDS / 截断契约）· 零运行时依赖
  src/pi/index.ts   → pi 画面（折叠渲染 + 常驻子代理状态面板）· peer: pi-tui + pi-coding-agent
```

根入口的四个现有消费方（`output` / `search` / `task`）**零改动**。

**3. 根入口不得 re-export pi 分面。** `kimi-mcp` 的构建 alias 指向 `packages/tui/src/index.ts`；根入口一旦 re-export pi 分面，pi-tui 就会进 Kimi 产物，「Kimi 面零 pi 依赖」当场破。子路径隔离是这条约束的机械保障。

**4. `tui/kimi` 留位不建。** 今天没有内容：Kimi 面的「显示」就是输出核的模型可见文本，它**两个面共用**、本就宿主中立。空门面是最容易变成僵尸代码的东西；等 MCP 侧真出现独立画面需求再开子路径。

**5. Kimi 产物必须零 `@earendil-works` 引用。** 这条今天靠人守，改包结构后必然有人误 re-export ⇒ `build:kimi` 装配时加门禁（`scripts/assemble-kimi.mjs`），失败即抛。

**6. 构建陷阱钉进文档：rolldown alias 是前缀匹配。** 子路径必须给更长的显式 alias，且**排在短 alias 之前**；否则 `@pi-ptc/tui/pi` 会被短 alias 捕获并解析失败（`Matched alias not found`）。`kimi-mcp` 的 alias 表有同样的形状，将来 Kimi 面若要 import 子路径，同样得加长 alias。

**7. 模式守卫用 `ctx.mode === "tui"`，不是 `ctx.hasUI`。** `hasUI` 在 RPC 也是 true；print/json 下 `ctx.ui` 是 no-op 桩（不抛，但也不画）。守卫是**语义**判断（没有屏幕就别假装画），不是防崩。模式在进程内固定 ⇒ `session_start` 判一次即可。

**8. 常驻子代理状态面板：字符串数组形态，自带两条冻结上限。**

- 形态：`ctx.ui.setWidget("ptc-tasks", lines)`，**不用** pi-tui 组件形式（factory）。理由：宿主已给 10 行上限、字符串数组可透传 ANSI（同 key 幂等、卸载即 `undefined`），组件形式要额外背 `requestRender` 管线与宽度截断。
- 守卫：`ctx.mode === "tui"`；子代理进程（`PI_PTC_DEPTH>0`）沿用既有早退分支，不注册。
- 刷新：registry 每次变迁（既有的 `onTransition` 回调）⇒ 重算并重设；没有进行中的任务 ⇒ `undefined` ⇒ 面板消失。
- **只算本会话的记录**：registry 启动会把磁盘上的历史会话记录一并恢复（真机实测：标题一度写「成功 180」——那是上一轮会话攒下的）⇒ 按 `record.sessionId` 过滤（engine 在 spawn 时盖章，`engine.ts:265`）；`sessionId` 缺失时不筛（老记录没这个字段）。
- **上限（冻结，改动需新 ADR）**：

| 常量                    | 值  | 出处                                                                                                                          |
| ----------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MAX_PANEL_ROWS`        | 6   | 派生：宿主 widget 上限 10 行（`InteractiveMode.MAX_WIDGET_LINES`）⇒ 标题 1 行 + 任务行 6 行 + 溢出行 1 行 = 8 行，留 2 行余量 |
| `MAX_PANEL_LABEL_CHARS` | 48  | 沿用旧 ADR-0022 §11 的 `MAX_LABEL_CHARS`（同一个 label 字段、同一个上限，不另立数字）                                         |

- **状态→字形/颜色表（冻结，补上旧仓从未写下来的那条）**：

| 状态        | 字形 | 颜色      |
| ----------- | ---- | --------- |
| `queued`    | `○`  | `muted`   |
| `running`   | `●`  | `accent`  |
| `stopping`  | `◐`  | `warning` |
| `succeeded` | `✓`  | `success` |
| `failed`    | `✗`  | `error`   |
| `canceled`  | `⊘`  | `muted`   |
| `lost`      | `?`  | `dim`     |

配色沿用旧实现的状态色表（running=accent / stopping=warning / succeeded=success / failed=error / lost=dim / canceled=muted），`queued` 是本仓第七态，取 `muted`。

**9. pi 画面渲染从 `entry` 迁到 `tui/pi`。** `entry` 回归装配与接线（session_start 注册 / surface 检测 / 绑定表 / 任务门）。迁移是机械的（3 处 import + 构建/alias），单独成 commit，不与面板混在一起。

## Consequences

- **AGENTS.md 的包表与铁律句要改**：tui 从「渲染原语叶子」改为「显示层：根=共享文本零件，`/pi`=pi 画面」；「pi-tui 只出现在 entry」改为「pi-tui 只出现在 `tui/pi`」。
- **`entry` 去掉 `@earendil-works/pi-tui` 依赖**——它是全仓唯一的 pi-tui 导入点（`packages/entry/src/ptc-render.ts:11`）。
- **发布物不变**：`dist/index.js` 仍只有 `pi-coding-agent` 与 `pi-tui` 两个外部 import（宿主运行时提供），根包 `dependencies` 仍为空。**Kimi 产物不变**：仍 0 个 `@earendil-works` 引用，且从此有门禁。
- **`packages/tui` 从「零依赖」变成「根零依赖 + `/pi` 带宿主 peer」**。peer 声明是**包级**的，故 `pi-coding-agent` 声明为 optional peer（`peerDependenciesMeta.optional`），免得 `output` / `search` / `task` 间接背上 pi 依赖；`pi-tui` 是 `/pi` 的真实依赖。
- **旧 ADR-0022 §11 的五条上限继续只管旧面板**（工具结果里的那一块）；本面板另立两条并在本 ADR 注册。旧仓的教训是「数字没有声明来源」——这次两条都有出处。
- **旧 ADR-0022 §2 是六态无 `queued`**，本仓实现是七态；面板状态表按现在的七态写。
- **真机已验**（2026-11-01，pi 1.4.0 的真 TUI 跑在真 pty 上，120×40）：面板画在**编辑器正上方**（working 条之下、状态行之上），逐条列出进行中的子代理，状态随任务完成实时更新（`任务 · 进行中 2 · 成功 0` → `任务 · 进行中 1 · 成功 1`）。真机同时暴露了一个缺陷：标题一度把历史会话的恢复记录算进来（写「成功 180」），已按 `record.sessionId` 修掉并补了单测。
- **仍未验**：`/reload` 后是否残留死面板；floor 0.86 的真机渲染；窄终端下 `Text` 按宽度折行会多吃行预算（label 截断 48 + 宿主 10 行上限兜底）。
