# Kimi 面：MCP 形态的 ptc_run_code + 宿主中立输出核

Status: accepted (2026-10-28)。P0（output 拆分，commit 8961bf5）+ P1（kimi-mcp）。分析依据：Kimi Code 插件清单（manifest 无 JS 运行时扩展点）+ 官方仓 MoonshotAI/kimi-code 源码（更新检测只认 github 来源，见「发布物形态」）。

## Context

pi 面之外要一张 Kimi 面：Kimi Code 插件能带的六种载荷（skills/agents/commands/systemPrompt/sessionStart/mcpServers）里，只有 mcpServers 是真工具能力。PTC 的执行核（vm 运行格 + 严格模式编译 + 并发/超时闸门）是宿主中立的，但输出整形（renderToolResult）原本与 pi 线协议类型同住 ptc，而 pi 的 TUI 折叠渲染（render.ts）依赖 pi-tui——不拆，Kimi 面一复用就把 pi 的宿主依赖拖过河。且 Kimi 插件按用户安装、对所有项目生效，工作目录不能靠会话 cwd。

## Decision

**1. `packages/output`（P0）**：renderToolResult + `ResultTextOutcome` 结构切片（就地声明，与 ptc/protocol.ts 的 RunOutcome 结构兼容由 ptc type check 钉住）。只依赖 tui，零宿主依赖，两面共用。`limits.ts` 因「全部数字唯一出处」契约整体留 ptc 不劈；`render.ts`（pi-tui 折叠渲染）留 ptc——唯一消费者 tools.ts 同包，搬走造成 ptc→entry 依赖倒置。console 捕获住 worker（运行格），本就宿主中立，不搬。

**2. `packages/kimi-mcp`（P1）**：MCP stdio server，单工具 `ptc_run_code({code, description, workdir, timeoutMs?})`——复用 runPtcProgram（运行格/编译/闸门全继承），绑定表 = 本地 fs 四件套 read/grep/glob/edit。MCP 协议层用官方 SDK 低层 `Server` 类（JSON Schema 手写，不引 zod）。**依赖铁律：kimi-mcp 零 pi 依赖**（不 import pi-coding-agent / pi-tui）——宿主代码只能属于那个面。

**3. workdir 是信任边界**：四件套所有路径 realpath + 前缀判定（防符号链接逃逸），越界即拒；edit 原子落盘（tmp+rename），old_string 必须唯一匹配。插件跨项目生效，workdir 由模型显式传用户工作区绝对路径——写进工具描述与 SKILL.md。

**4. 契约差异写进散文**：程序内 tools 是固定四件套（没有 bash、没有 pi_task_ptc），与 pi 面「会话工具全集」不同——这句必须在工具描述里喊出来（KIMI_MCP_RUN_CODE 块，routes 册子）。Kimi 面无新编排器（spec 决策 28）：编排器是宿主自己，kimi-mcp 只是运行格供应商。

**5. 发布物形态（Kimi 侧更新检测的硬约束）**：Kimi 的插件更新检测只认 `source = github` 的安装（`manager.ts checkUpdates` 过滤），且 `tryResolveLatestReleaseTag` 走 `/releases/latest` 重定向——认 **GitHub Release 对象**不是裸 tag。因此：发布 checklist 每版必须 `gh release create`；`release/kimi/`（server.js + worker.js + 共享 chunk + skills，**入库**——tag 快照是分发单元，快照里没有的文件用户拿不到）；裸仓库 URL 安装（钉 tag 的 URL 更新检测硬编码 false）。`build:kimi` 装配 + 版本一致性校验（manifest version 必须与根 package.json 同号）。

**6. 散文渲染目标登记（过渡形态）**：Kimi 面工具描述住 routes 册子 `KIMI_MCP_RUN_CODE` 块；八条机械门禁的双向覆盖扩展**随 P2**（web_ds_search 过河时）落地，此前由 tests/kimi 协议探针守存在性。SKILL.md 源在 `packages/routes/docs/kimi-ptc/`，装配时拷入 release/kimi/skills/。

## Consequences

- 测试三制：tests/pi（61）/ tests/output（5）/ tests/kimi（9）= 80 用例；假 pi harness 与假 MCP 客户端互不过河；`scripts/kimi-smoke.sh` 三腿（布局版本 / bundle 自包含 / 真 spawn 协议探针）。
- 已知边界：fs 四件套语义对齐 pi 常用子集但非逐字节等价（read 无行号区间参数、grep 无 pi 的全部开关）——程序跨宿主移植时以册子契约为准；grep 二进制嗅探靠 U+FFFD + 后缀黑名单，不保证全覆盖。
- 已知未做新增：Kimi 面八条门禁扩展、web_ds_search 过河（P2）、真 Kimi Code /plugins 面板安装冒烟（需 TUI，手工）、marketplace JSON（不上）。
