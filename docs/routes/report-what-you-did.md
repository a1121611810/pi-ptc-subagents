# 交报告（child report，旧 ADR-0032）

子代理收工前交一份结构化报告，四样：`summary`（一句话结论）、`findings`（每条 what +
独立 evidence）、`files_touched`、`usage`（input/output/cost/turns）。散文保留不替换。

- 契约写在孩子的追加 system prompt（唯一处），形式：最终消息**末尾的 fenced JSON 块**
- 宿主自动解析；`reportChannel` 四值：`tool` = 经 `ptc_child_report` 工具交的（首选通道，已落地）、`prompt-json` = 末尾 fenced JSON 解析到了、`none` = 没交（散文照交但不标可信）、`opted-out` = agent 定义 `childReport:false` 声明免交
- 报告落 TaskRecord，经 `ptc_task_output` 读得到；没交报告的孩子永远明说，不静默
- 工具通道（`ptc_child_report`）在子代理进程注册，已是首选；prompt 通道兜底
