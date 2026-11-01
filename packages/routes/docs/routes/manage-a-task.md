# 管一个任务

三个工具，有任务记录才出现在模型面前（ADR-0007：可见性 = 有无记录，不是独立开关）：

- `ptc_task_list()`：在飞的全部 + 最近完成的任务。响应是对象。
- `ptc_task_output({ task_id })`：读一条记录。响应是对象。
- `ptc_task_stop({ task_id, reason? })`：排队中的抽掉（canceled）；在跑的转 stopping

任务记录是派发的唯一痕迹：每次建任务都建记录，等不等也一样建。

终态记录热存留最近 500 条（决策 29），被挤出的进压缩存档（默认留 30 天，
`archiveEnabled: false` 则直接删），凭精确 task id 经 `ptc_task_output` 仍读得到。

## ptc_task_list

参数：

- `scope`：`recent`（默认，只热存）/ `all`（连压缩归档一起列，更全也更慢）
- `limit`：取多少条（默认 50，上限 200）
- `status`：只看某个状态（七个状态之一）
- `session`：`current` = 本会话，或给一个会话 id

响应：

```json
{
  "scope": "recent",
  "total": 520,
  "tasks": [
    {
      "id": "5d90e136…",
      "status": "succeeded",
      "label": "口径汇总",
      "finishedAt": 1758000123456,
      "task": "读 AGENTS.md 并汇总六个包的对外口径",
      "summary": "六个包口径一致"
    }
  ]
}
```

- `total` = 候选总数。它比 `tasks.length` 大，说明还有更早的记录没列出来。
- 每条字段各自封顶（task 80 字、summary 100 字、label 120 字）。响应按字节预算逐条裁剪，超预算就停——返回的永远是合法 JSON（不会砍成半截 JSON）。
- `scope=all` 时归档条目带 `archived: true`。
- `session` 筛选时条目回显 `sessionId`。老记录没有这个字段，不匹配任何会话。

## ptc_task_output

参数：`task_id`（一条任务记录 id）。

响应 = 那条记录 + 归约层：

- `text`：孩子的散文答案。**交付物是这段正文**，报告只是摘要。正文从事件流现算，不另存一份。
- 没有正文时给 `output`（原始事件流尾部，50KB 截断，砍头留尾）+ `guidance`（分层引导：先看报告，完整原文在 `outputPath`）。
- `report`：孩子交的报告（`summary` + `findings`）。孩子没交报告时，这个键整个不存在。
- `outputPath`：原始事件流的路径。

registry 里记不住的 id 会回落压缩归档（TTL 窗口内仍可解，标 `archived: true`）。

## 程序内检索

`ptc_run_code` 的程序内可调 `tools.task_records({ scope: "all" })`：拿全部任务记录（含压缩归档）。

机械扫描在宿主做，筛选与归约在程序里做。程序只 `return` 要的几条，其余不进上下文。

正则跑在运行格里，运行格有 terminate 兜底；宿主本身没有隔离——病态正则要在程序里跑，别在宿主里跑。

## 交付核对（delivery）

任务记录与产出里带 `delivery`：**引擎从孩子的进程事件流抽的实测轨迹**，不是孩子的自述。

- `tools`——孩子实际调用了哪些工具、各几次
- `paths`——它实际碰过的路径（去重，按出现顺序）
- `errors`——工具执行失败次数
- `textChars`——孩子最终正文长度（0 = 空交）

另有一行人话 `deliveryNote`，是同一份事实的渲染版。怎么用：

- 结论声称来自某份材料 ⇒ 对一下 `paths` 里有没有那份：**没有 ⇒ 这条结论没有依据**
- `paths` 空 + 报告 0 条 + 正文 0 字 ⇒ 这孩子零产出：**重派它，或明说缺口，别替它补数**
- `errors` > 0 ⇒ 它撞过错（路径不对、读不到），先看错在哪再决定重派还是改任务书
