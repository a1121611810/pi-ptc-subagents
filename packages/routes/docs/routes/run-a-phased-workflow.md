# 分阶段 workflow（ptc_workflow）

`ptc_workflow({ meta: { name, description, phases? }, script, args?, timeoutMs? })`。

script 内额外可用（仅 workflow 面注入）：

- `workflow.log(...)`：阶段内日志
- `workflow.phase(name)`：阶段标记
- `workflow.parallel([fn, ...])`：并行执行
- `workflow.pipeline(items, step)`：顺序流水线

args 必须是可 JSON 序列化的值（进 worker 前校验）。
