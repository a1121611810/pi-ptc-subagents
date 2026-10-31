# 派一个子代理

入口两扇门面（ADR-0006），同参同形（名字随所在平面），只是所在平面不同：

- `pi_task_ptc`：PTC 程序内的 binding，程序里 `tools.pi_task_ptc({...})`
- `pi_task_codemode`：注册的工具（exposure: codemode，模型不可见），codemode 脚本里 `tools.pi_task_codemode({...})`

参数：`task`（必填，孩子要干的活）、`label`、`wait`、`why`、`agent`、`agentScope`、`model`、`thinkingLevel`、`readOnly`、`timeoutMs`；
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
- **写清两件事：交付物格式 + 报告块**：孩子要同时交「交付物」和「报告」（末尾 JSON 块，或调
  `ptc_child_report` 工具）。只写交付物格式时，孩子多半不交报告——父就只剩原始产出可读，只能重算。
  更别写「恰好 N 行」这类排他措辞：孩子会照排他措辞办，把报告丢掉（实测 3/12 孩子中招，
  父重算被记成幻觉）。
  **要报告就点名形状**：「最后附上 child report 的 JSON 块（summary / findings / files_touched /
  usage）」——实测点名形状 4/4 孩子照交；只说「附上报告块」1/4 交；**自己发明一套报告格式更糟**
  （实测 4/4 不交契约块：孩子照父的格式办，把契约块顶掉了）。

## 旋钮（用不用你自己判断）

参数都在参数表里。下面是它们的代价——什么时候值得付，由你判断：

- **`why`**（调用方自己的话）：它进孩子的提示词 = 花孩子的 token。孩子从 task 里已经能读懂为什么要干，就别传。
- **`readOnly: "strict"`**：孩子的工具表压到 read/grep/find/ls（搜索开启时含 web_ds_search）。
  只需要读的活别给写权限——省 token，也省掉它改坏东西的可能。
- **`thinkingLevel` / `model`**：孩子的成本项。活简单就给孩子低档位或更便宜的模型。
- **`wait: false`**（默认）：立刻返回 handle，结果经任务面/通知回来。多个孩子并行时别在第一个上阻塞。
- **`timeoutMs`**：孩子的运行时长上限（毫秒）。**不传 = 不限**（默认行为）；传了超时就收尸——
  慢孩子不再一直烧 token，但它的活可能没干完。给了就别再无脑等它。
- **`projectContext`**：孩子的项目上下文（AGENTS.md/CLAUDE.md）。`auto`（默认）= 照常加载；
  `none` = 不加载——**它占孩子固定税约一半**（实测 2127 字符 ≈ 1000 token），
  这活只需要孩子读材料/算数、不需要项目约定时传 `none`；要孩子遵守项目规矩就照常传。

台架口径（2026-10-30，pi 1.4.0，facts 题 n=3）：每个孩子付一份固定 harness 税 ≈ 1800 input token；
省掉 why + 用 `readOnly:"strict"` 可让子成本降约 63%，端到端成本减半——但仍比不派发贵 8 倍。
**派发值得的是准确性，不是省钱**：同样的题，派发档准确率 100%，不派发 92%。
