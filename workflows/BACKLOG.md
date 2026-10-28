# BACKLOG — 待钉的 loop（只记不做）

这些 loop 值得 delegate，但还没 grill 成规格。轮到它们时：按 loop-me 流程一轮拷问收口，钉成 `workflows/<name>.md` 后从这里划掉。

## L2 对照电池（child-behavior-battery）

- **什么时候运转**：改了孩子行为（argv / 报告契约 / 工具集 / 模型默认）后，验证"不损准确率"。
- **原型**：2026-10-28 减量改动的四组实验（极简 60 题/臂、多样 8 类型 50 题/臂×3 臂、难题梯度、复跑方差）。
- **原料位置**：脚本曾写在 /tmp（已失）；方法论与全部数字在 ai-memory `notes/token-reduction-shift-to-shrinking-20261028.md`；题型学参照 Terminal-Bench/SWE-bench。
- **钉规格时要 grill 的点**：触发条件（什么改动算"动了孩子行为"）、题电池生成器（truths 现算 + 突变自证内建）、判分器铁律怎么自动化（等价代码形式是最大坑：`\w-`≡`[A-Za-z0-9_-]`、常量引用、De Morgan）、归因流程与 checkpoint。

## L3 方向证伪（direction-falsification）

- **什么时候运转**：技术选型/优化方向决策前（"X 能省钱吗"类直觉）。
- **原型**：2026-10-27 缓存方向 saga——三轮定责（探针→分层归因→终审翻案），最终判死并产出"前缀温度模型"。
- **原料位置**：ai-memory `gotchas/prompt-cache-dead-for-fork-per-task-children.md`（含三层定责方法与九家对比）。
- **钉规格时要 grill 的点**：停止条件（几轮定责算闭环）、证据标准（每轮定责必须有实锤）、翻案流程（结论带版本号与重测条件）、与 L2 的分工（L3 产假设、L2 验改动）。

## L4 仓库调研（repo-survey）

- **什么时候运转**："看看 X 仓怎么做 Y"（选型、学同行）。
- **原型**：2026-10-27 九家横评（mcode / ZCode / Codex / OpenCode / dsh / Reasonix / Hermes / OpenClaw / pi）——透镜法：文件树定位 → 决策笔记（dsh 的 .agents/notes 是金标准）→ 文件级取证 → 横评表。
- **原料位置**：同上 gotcha 页横评表。
- **钉规格时要 grill 的点**：产出格式（横评表列定义）、投入上限（几家收手）、什么时候不值一轮。
