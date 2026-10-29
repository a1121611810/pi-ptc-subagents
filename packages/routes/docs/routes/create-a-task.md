# 派一个子代理

入口两扇门面（ADR-0006），同参同形（名字随所在平面），只是所在平面不同：

- `pi_task_ptc`：PTC 程序内的 binding，程序里 `tools.pi_task_ptc({...})`
- `pi_task_codemode`：注册的工具（exposure: codemode，模型不可见），codemode 脚本里 `tools.pi_task_codemode({...})`

参数：`task`（必填，孩子要干的活）、`label`、`wait`、`why`、`agent`、`agentScope`、`model`、`thinkingLevel`、`readOnly`；
agent 定义里的 `tools / model / thinkingLevel / childReport` 由 frontmatter 钉住。

返回 handle：`{ taskId, label?, status: "queued" }`。默认不等；撞闸排队等（ADR-0010），
不抛异常。唯一的拒绝是派发被关（`/ptc off`，ADR-0004）：此时返回
`{ status: "rejected", errorMessage }`。

任务建成后在任务记录里排队（满员排队不拒绝，ADR-0010），经
`ptc_task_list / ptc_task_output / ptc_task_stop` 查/停。

## Briefing 纪律（省 token，派发前自查）

- **给确切路径、命令、决策**：孩子看不到父会话。task 里写死一个路径，省孩子一轮探索
  （每轮探索 = 一次工具调用结果 + 推理 token）。
- **写明最终消息要带回什么**：孩子只回一次。要什么格式、哪些字段，task 里说清。
- **不确定能否一次搜中才派**：目标明确（已知路径、已知行号）的活别派，主会话直接
  `tools.read` 更省。
- **同域的活合并给一个串行孩子**：每个孩子都付一份固定 harness 税（系统提示词 +
  项目上下文）。多个重叠的小活拆并行 = 同一份探索被付费多次。
- **孩子不写报告文件**：交付物就是最终消息（含报告 JSON 块），落盘 .md 是浪费。
