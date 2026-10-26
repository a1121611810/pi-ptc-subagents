# 管一个任务

三个工具，有任务记录才出现在模型面前（ADR-0053：可见性 = 有无记录，不是独立开关）：

- `ptc_task_list()`：在飞的全部 + 最近完成的（默认 10 条）
- `ptc_task_output({ task_id })`：读一条记录（状态/产出/报告）
- `ptc_task_stop({ task_id, reason? })`：排队中的抽掉（canceled）；在跑的转 stopping

任务记录是派发的唯一痕迹：每次建任务都建记录，前台任务也一样。
