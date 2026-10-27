# 政策持有 vs 意外持有：JS GC 收不了的那类内存（驱逐键选完成时间）

**类型**：concept（pi-ptc-subagents；语言通用的设计判断，2026-10-27 随 spec 决策 29 沉淀）

## 判断

V8 只回收**不可达**对象，分不清"还需要"和"忘了删"。所以增长结构分两类：

- **操作边界持有**（任务跑完、工具调用结算）→ 结算时 delete，可达性镜像生命周期。例：engine `#children`、slots `#holders`、NotificationCenter `#awaited`——这些都做对了。
- **政策边界持有**（"痕迹该留多久"）→ 语言没有任何机制替你收（WeakMap 键须为对象且不可遍历；WeakRef 非确定；JS 无内建 LRU/TTL/弱值 Map）。**只能显式驱逐**。

## 驱逐键：选完成时间（finishedAt），不选创建时间/插入序

- 痕迹的价值锚在**完成时刻**——刚完成的任务随时被回看；排队久、跑得久但刚完成的任务按创建序会冤死。
- Map 插入序不可信：恢复装载走 readdir（APFS 哈希序，无序义保证）。
- 平局真实存在（`reconcile-lost` 批量同毫秒盖 `Date.now()`），受害者可互换所以正确性无差；要确定性就用 **(finishedAt, taskId)** 复合键——taskId 唯一，零新字段成全局全序。
- 推论：task-id.ts 计划换的 ULID 给的是**创建序**，落地后也替代不了 finishedAt 作驱逐键。

## 落地（spec 决策 29）

registry `evictTerminal(keep)` 纯内存挤最老、返回 id；引擎 `#evictAndPurge` 同步删 `records/<id>.json` + `tasks/<id>/`（删失败 catch，下轮 restore 收尸）；运行时每次终态后 + restore 收尾各调一次，同一机制不维护两份。红线：**未终态永不参与驱逐**（`isTerminal` 过滤就是保障）。500 = 任务面窗口（10 条）的 50 倍，政策值非推导值；产出字节**不设总预算**是知情留白（单文件 16MB 上限是唯一约束，500×16MB=8GB 纸面峰值 vs 真实均值差三个数量级）。
