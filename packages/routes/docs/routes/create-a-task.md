# 派一个子代理

入口两扇门面（ADR-0052），同参同形（名字随所在平面），只是所在平面不同：

- `pi_task_ptc`：PTC 程序内的 binding，程序里 `tools.pi_task_ptc({...})`
- `pi_task_codemode`：注册的工具（exposure: codemode，模型不可见），codemode 脚本里 `tools.pi_task_codemode({...})`

参数：`task`（必填，孩子要干的活）、`label`、`wait`、`why`、`agent`、`agentScope`、`model`、`thinkingLevel`、`readOnly` 均已生效（`cwd` 待接）；
agent 定义里的 `tools / model / thinkingLevel / childReport` 由 frontmatter 钉住。

返回 handle：`{ taskId, label?, status: "queued" }`。默认不等；撞闸（随闸门落地）返回
`{ status: "rejected", errorMessage }`，不抛异常。

任务建成后在任务记录里排队（满员排队不拒绝，ADR-0056），经
`ptc_task_list / ptc_task_output / ptc_task_stop` 查/停。
