# 直接用内置工具

单次调用、或每步都需要模型判断的场景（写操作、审批敏感），不要写程序，直接调。

- PTC 程序内：`tools.read / grep / find / ls / edit / write`（绑定表收窄规则见 run-one-program）
- `bash` 需 opt-in：embedder 的 optIns 参数或 `~/.pi/agent/ptc.json` 的 optInBindings，处处 fail-closed
- 程序外的逐个直调走 pi 自己的工具调用管线
