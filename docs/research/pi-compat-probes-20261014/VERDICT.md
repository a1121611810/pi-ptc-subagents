# PROTOTYPE VERDICT (v2, corrected) — pi < 1.0.0: 会报错吗?代价是什么?

Question (2026-10-14, v2 after the user's correction): "你没看完整,当 codemode 不可用时按照约定
应该是走了项目自己搭建的 PTC 的,基于这个前提,看看实际情况,再看看代价问题"

## 回答:**<1.0.0 运行不会报错。** v1 结论里的"三个降级"有两个是错的,错在漏了 surface 约定。

### 推翻 v1 的两条

1. **"exposure 门缺失导致重复编排面" — 错。** `src/index.ts:447` 的
   `programmingToolExposure = surfaceMode === "full" ? "direct" : "codemode"` 意味着:codemode
   不可用 ⇒ surface=full ⇒ 两个 PTC 工具注册为 `direct` ⇒ 本来就该声明给模型。0.86.1 没有
   exposure 门不是缺陷,恰恰让 "direct" 按设计工作。实测(B4):`ptc_run_code exposure=direct,
   ptc_workflow exposure=direct`。模型看到的正是项目自己 PTC 的约定面。源码注释甚至已写明
   "Measured across 0.86.1 / 0.87.1 / ... / 1.1.0"。
2. **"结构化结果失效是模型可见的降级" — 基本错。** structuredContent 的文档语义就是
   "not sent to the model; programmatic callers only"。0.86.x 上没有 codemode,唯一的
   programmatic caller 不存在;模型走的 content 通道完好。

### 运行时实测(probe-runtime.mjs,真实 dist × 真实 0.86.1 树,全部通过)

| probe                                 | result                               |
| ------------------------------------- | ------------------------------------ |
| A1: import dist/index.js              | pass,49 exports                      |
| A2: factory + session_start 注册      | pass,六个工具全部注册                |
| B1: 0.86.1 ToolDefinition 键          | 无 outputSchema/exposure(类型层缺失) |
| B2: defineTool 接受这些额外键         | pass,存储但惰性                      |
| B3: agent-loop 转发 structuredContent | 0.86.1 否 / 1.0.0 是                 |
| B4: surface=full ⇒ exposure=direct    | **pass**                             |

### 真实代价(重算后只剩两条,且都可控)

**代价 1(真实,有界):`bash` 绑定失败消息不受我们的 2000 字符上限约束。**

pi 0.86.1 的 bash 在非零退出时 **throw**(isError 通道是 1.0.0 才有的),我们的 binding 对
throw 路径没有 try/catch,`bindingFailureMessage` 的 2000 字符截断因此绕过。实测:

- 5KB 输出的失败:0.86.1 拒绝消息 **5051 字符,HEAD 保留**(1.0.0 上同调用:2014 字符,head 被切);
- 200KB 输出:pi 自己的 50KB tail-truncation 生效,拒绝消息有界(~50KB 级)。

所以上界是 **pi 自己的 50KB**,不是无限 —— 但比 1.0.0+ 的 2000 字符大 25 倍,且 head-first
而不是 tail-first,失败诊断的方向反了。

**代价 2(真实,有兜底):旧 ADR-0032 子报告的 tool 通道死亡。**

0.86.1 的 agent-loop 不发 `structuredContent`,所以 `extractChildReportFromToolEvent` 永远拿
不到报告。但 `prompt-json` 通道独立扫描 assistant 文本(dispatch.ts:1586),子进程按约定输出
fenced JSON 仍然交付。退化 = 每个子报告都走兜底通道,`reportChannel` 永远是 `"prompt-json"`
而非 `"tool"`。语义不丢,只丢首选通道。

### typecheck 错误的真实含义

那 9 个错误是**编译期**的:`.d.ts` 里没有这些类型,`import type` 不产生运行时代码。用户在
0.86.x 上安装运行**完全正常**;只有 `pnpm run typecheck`(即 release gate)在 <1.0.0 上无法
通过 —— 因为 devDeps 钉 ^1.0.0,gate 天然只对 1.0.0 编译,矩阵是改写了 devDeps 才制造出这个
场景。

## 结论(修正后)

声明 `peerDependencies >= 0.86.0` 与运行时事实**相容**:装得上、跑得起来、surface 约定
(codemode 不可用 ⇒ 项目自己的 PTC)在 0.86.x 上按设计成立。

代价是两条有界的已知限制,不是崩溃:bash 失败消息不受我们的截断约束(pi 的 50KB 上界),
child report 永远走 prompt-json 兜底。

若要消除这两条,代码侧的最小改动是:在 binding 的 `await tool.execute(...)` 外补 try/catch,
把 throw 路径也喂给 `bindingFailureMessage`(一条改动同时修掉代价 1;代价 2 由 prompt-json
兜底,不需要改)。是否值得为 <1.0.0 加这段代码,是产品决策 —— 不改的话,把这两条写进 known
limitations 即可。
