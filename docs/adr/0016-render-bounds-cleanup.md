# 富行渲染契约的除名：RENDER_BOUNDS 裁到现行 renderer 的四项

Status: accepted (2026-10-27)。审计 F6 二次确认 + render-bounds 解剖。修订：[旧 ADR-0013](../prototypes/dispatch-doors-flow.html)（其 §6 的八上限冻结表属于已退役的富行 renderer）。

## Context

旧 ADR-0013 §6 登记的八上限表，绑定的是旧实现 `src/tools/render.ts`（1400+ 行）的**富行 renderer**：折叠行有完成值提示、失败时错误首行直接上折叠行、展开态有独立 code 块、workflow 有阶段汇总行与漂移警告行、子调用树带参数预览。

重写的 renderer（`packages/ptc/src/render.ts`，68 行）是**有意简化**的另一个设计：折叠 = 标题 + 状态一行，展开 = 纯文本块。富行对应的 UI 部位不存在，绑定它们的上限自然空转——重写版登记七项，其中三项（`MAX_RESULT_HINT_CHARS` / `MAX_ERROR_CHARS` / `MAX_CODE_LINES_EXPANDED`）自登记起零引用，状态页记在"shimmer、task/sub 的 renderer 还没写"里。

按旧 ADR-0013 §6 自己的规矩，改/删冻结值要走新 ADR——本篇就是那篇。审计一度想把这五项当死代码删，考古（旧表原文 + 旧 render.ts 消费点 + 状态页登记）判定其为契约占位而非死代码，处置改为本篇的正式除名。

## Decision

**1. 除名三项。** `MAX_RESULT_HINT_CHARS`（60）、`MAX_ERROR_CHARS`（120）、`MAX_CODE_LINES_EXPANDED`（3）从 `RENDER_BOUNDS` 移除。理由：富行 renderer 已被有意简化替代（重写版无值提示位、折叠态只显示状态词、无独立 code 块），这三个上限绑定的部位**不存在**；保留它们只会给读者"这些部位该存在"的错误预期。旧表其余未在重写版登记的项（`MAX_CODE_LINE_CHARS` / `MAX_PHASES_EXPANDED` / `MAX_WARNINGS_EXPANDED` / `MAX_SUBCALL_PREVIEW_CHARS`）随旧 renderer 一同退役，不再另行除名。

**2. 保留四项。** `MAX_LOG_LINES_EXPANDED`（12，唯一两版共同项）、`VALUE_TREE_MAX_DEPTH`（4）、`VALUE_TREE_MAX_CHILDREN`（6）、`VALUE_TREE_MAX_LINE_CHARS`（120）。值树三项绑定的 `renderModelValue` 是现行活特性：DEPTH 已接线；CHILDREN/LINE_CHARS 未接线（程序返回超大数组时全量渲染）——由审计 F7 兑现，接线时引用本表、删除 `text.ts` 的本地常量 200。

**3. 登记即契约。** `RENDER_BOUNDS` 从此只登现行 renderer 实际消费的上限；新增上限（shimmer/task renderer 等特性落地时）须走新 ADR 增补，不再预埋。

## Consequences

- `packages/tui/src/bounds.ts` 七项 → 四项；状态页"渲染预算表/第 8 项"两行同步。
- 审计 F6 的可删清单最终落定：`listAgentNames` / `runAbort` / `drainGraceMs` / pi-tui 重复声明（真死代码，已删）+ 本篇三项（契约除名）——RENDER_BOUNDS 不再出现在死代码台账里。
- F7 修复后值树输出会收窄（本地 200 → 契约 120），对模型是可观察行为变化，以本篇 + F7 的提交记录为据。
