# PTC 程序在专属运行格（vm context）内执行

Status: accepted (2026-10-28)。spec `docs/prototypes/dispatch-doors-flow.html` 决策 30。

## Context

PTC 程序一直跑在 worker 线程的**全局作用域**里（`new Function` 求值，ADR-0014 的严格模式只约束语法不约束全局）。探针实测（2026-10-28）：程序内 `await import("node:fs")` 可用、`process` 可见、`fetch` / `setTimeout` / `Math.random` 都在——binding 白名单（`bindings.ts` 名单 ∩ 会话作用域）是**意图声明，不是边界**：程序可以完全不碰 `tools.*`，直接 fs 读写、fetch 外呼，**绕过 pi 的工具管线（权限/审批）**。模型直调走管线、程序绕管线，同一件事两条权力路径。

warm 复用的清场是另一处技术债：reset 靠「init 时 globalThis baseline 对比删自有属性」，代码里自认了 shortcut——**内置原型（Object.prototype 等）的修改会渗到下一个 run**（worker-main 的 shortcut 注释）。

同期调研了两个外部参照（研究笔记在本会话，2026-10-28）：ZCode dynamic-workflow 的 **vm cell**（独立 Node 子进程 + `vm.createContext`，全局只暴露 5 个宿主函数 + 确定性禁令）与 minimax-code 0.7.0 的 **QuickJS 格**（WASM，程序零 Node 能力）。

## Decision

**1. 每 run 一个 `vm.createContext`（运行格）。** 格内全局只注入：`tools`（冻结，转发逻辑不变）、`console`（5 个 level 直接上提，不再补丁-恢复全局）、`args`（**对象也 freeze**——旧实现只锁全局绑定，`args.tag = "x"` 能改成功）、workflow 面的 `workflow` 四辅助。程序在此格内编译执行（`compileProgram` 产出从「函数」改为「格内求值源码」）。

**1a. facade 格内自建，桥用后脱手（2026-10-28 加固，闭合 CVE 同款逃逸面）。** 初版把宿主 facade 对象直接注入沙箱——`tools.constructor.constructor("return process")()` 两段原型链即拿到宿主 Function 逃逸（[vercel/workflow#1026](https://github.com/vercel/workflow/issues/1026)、n8n CVE-2025-68613 同款）。加固后宿主只放**三个桥**（`__ptcCall` / `__ptcConsole` / `__ptcArgsJson`），一段 **IIFE 序言**在格内（context realm）自建 tools/console/args/workflow，然后把三个桥**置 `undefined` 脱手**（contextified 全局属性禁 `delete` 但可写，实测）——桥只剩序言闭包可达。IIFE 不是风格是堵漏：脚顶级 `var`/`function` 会落到格全局上，review 实测不包 IIFE 时 `__bridge` 全局可达、constructor 链逃逸重开（B13 用例 + 「去 IIFE」变异探针钉住）。工具结果以 **JSON 字符串回格、格内 parse**：宿主 Promise/对象一律不跨 realm 暴露（`tools.read(...)` 返回的是格内 Promise，结果的 constructor 链也通不了宿主）。工具参数格内 `JSON.stringify`、worker 侧 parse。`workflow-helpers.ts` 随之删除（四辅助搬进序言）。

**2. reset 语义改为「丢格」。** 拒掉残留 pending 调用（代次边界不变），运行格随 run 结束自然废弃；旧 baseline 清场循环、consoleBaseline 恢复、defineGlobal 全部删除，原型污染短路**结构上消失**。

**3. 降事故面，不是安全边界。** 沿用 dispatcher.ts env 白名单的措辞纪律：信任姿态（旧 ADR-0007）不变，模型直调 bash 依旧全权。本决策的正当理由是**能力口径对齐**（程序唯一的门 = `tools.*`，与直调同管线）+ 清场 hygiene，不是堵恶意。

**4. 明确不做**：确定性禁令（Date.now / Math.random / 动态 import 一律不禁——我们没有 replay/journal，禁令是为重放付的税，现在白付）；独立进程化（warm 池是旧 ADR-0017 的资产，ZCode 要进程是为 engine 归属与 Windows argv 限制，不是隔离本身）；QuickJS（引入 WASM 依赖无对应收益，vm 在 worker 内即达同等收窄）。

**5. 破坏性变更**：程序用过 `process` / `fetch` / 动态 `import()` / `node:*` 的用户代码会断 → 下一个版本 major bump，CHANGELOG 明示。`Date` / `Math` / 标准内置保留。

## Consequences

- 跨 realm 两个工程坑已处理并各留回归钉：格内 throw 的 Error 不属于宿主 realm，`instanceof Error` 失效（errorMessage 防御性取 `.message`）；格内 async 函数返回 context realm 的 Promise（宿主 await 兼容，workflow parallel 用例钉住）。
- 测试：`tests/vm-cell-runtime.test.mjs` **32 用例五区**（A 可见性 3 / B 逃逸面 12 / C 语义跨 realm 10 / D 隔离生命周期 4 / E 协议边界 3）。防假绿三道：B 区全部用例在软格版（加固前实现）必红；变异 A（去掉桥脱手）精确 3 红（B7/B8/B12）；变异 B（args 不冻结）精确 2 红（C7/D4）。速度：fresh-spawn n=50 与格化前基线持平（35.4/37.2/37.3 vs 35.2/38.5/37.0 median——JSON 回格的成本在噪声内）。
- 已知装饰性泄漏（不修，记录在案）：`new Error().stack` 的 await 续体帧含宿主 worker 路径与 `node:internal` 帧（vm 无法剥）；桥名留在全局枚举里（vm 禁 delete）但值为 `undefined`。两者都不构成能力。
- `PtcProgram` 类型导出随编译产出形态改变一并删除（dist 无 dts，无外部消费者）。`workflow-helpers.ts` 随 facade 内移删除。
- 若未来做任务级 replay/断点（参照 ZCode journal），**届时**补确定性禁令——那是一个 replay 设计，不是禁令本身。
