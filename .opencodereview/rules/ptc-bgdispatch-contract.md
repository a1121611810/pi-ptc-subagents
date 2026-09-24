# Background Dispatch Contract (audit 3d, 阻塞级)

适用文件: `src/runtime/task-*.ts` / `src/runtime/child-process-lifecycle.ts` /
`src/runtime/notification-pipeline.ts` / `src/runtime/output-storage.ts` /
`src/runtime/dispatch.ts` / `src/runtime/dispatcher.ts` / `src/tools/ptc-task.ts` /
`src/tools/task-panel-render.ts`(模式由 `.opencodereview/rule.json` 锚定)。

规范来源: ADR-0022(后台派发)`docs/adr/0022-background-dispatch.md`、ADR-0016(`pi.dispatch` binding)、
ADR-0015(截断契约)、`CONTEXT.md` 词条(background dispatch / TaskRecord / TaskStatus / TaskRegistry /
Subscription / DispatchHandle / `ptc_task_*` / `<bg-task-notification>`)。

## 状态机(ADR-0022 §2)

    running ──┬─► stopping ──► succeeded | failed | canceled
              ├─► succeeded
              ├─► failed
              ├─► canceled
              └─► lost(必须带 LostReason)

- `queued` 不存在:并发上限是"硬拒",没有任务内队列。
- 终态不可再迁移(`succeeded/failed/canceled/lost` 无出边)。

## 必查

1. **迁移守卫**:每条边都必须显式列在迁移表里;表外的边必须报错(显式错误状态或抛出),不得静默忽略。
   `-> lost` 必须携带 LostReason(`session_ended_while_running` / `user_killed_via_esc` /
   `lost_on_session_restart`);无 reason 的 lost 是阻塞项。
   **注意 v1 的可达性**:pi 扩展 API 只暴露两个可写 reason——`session_shutdown` 的 reason 枚举是
   `quit | reload | new | resume | fork`(无 Esc/abort 成员),`agent_end` 不带 stop reason,因此 **v1 生产只写
   `session_ended_while_running` 与 `lost_on_session_restart`**,`user_killed_via_esc` 是保留值(ADR-0022 §8
   已记录)。审查时不要因为"第三个 reason 没有 emitter"就报阻塞——除非 ADR/文档又把它写成已实现。
2. **单一 terminal 写入器**:终态只能由一个写入点落库。禁止"先 get、再判断、后 transition"的
   read-then-write 组合——那会产生 TOCTOU 丢失更新(模型 stop 与子进程 close 竞争时,stop 会被
   静默覆盖为 succeeded)。终态判定必须在写入器内部原子完成(CAS / 期望状态守卫 / 在命令里表达条件)。
3. **stop 必须真的发信号**:`ptc_task_stop` 只把状态推进到 `stopping`;取消信号的投递必须在
   pump 侧观察 `stopping` 并对活着的子进程执行 SIGTERM。只改状态不投递信号 = 阻塞项。
4. **信号阶梯**:SIGTERM → grace(单一命名常量,与前台 abort 共用同一个阶梯)→ SIGKILL。
   禁止第二套 grace 数值;禁止缺少 SIGKILL 升级;定时器必须在子进程关闭时清理且不得吊住进程
   (`unref` 或等价物)。drain/teardown 必须能在 grace 后强制收敛,不能永久挂起。
5. **订阅 cursor**:每个 (subscriberId, taskId) 一个 Subscription;cursor 是单调 ULID,按投递推进。
   重新订阅/重放不得让 cursor 回退;未确认的批次必须重投而不是丢失(exactly-once 由 cursor 保证)。
   fork 的默认 cursor 语义(`max(parent, child)`)若未实现,必须在 ADR 里明确记为偏差,不能只在文档里描述。
6. **通知渲染**:父 `<bg-task-notifications>` + 每个事件一个 `<bg-task-notification>`;
   属性集与 ADR §7 一致。所有插值(尤其是 label 与 preview 这类任意文本)必须 XML 转义。
   内联 preview 的上限必须引用单一常量(2048,即 `OUTPUT_PREVIEW_MAX_BYTES`),不得散落 magic number。
   批量切分必须沿事件边界进行,且不得丢弃事件(单个超大事件独占一批,不允许静默截断)。
7. **截断契约**:任何返回给模型的文本超限时必须显式标 truncated 并给出完整输出路径
   (ADR-0015);静默截断 = 阻塞项。字节分页(`sinceBytes`)不得切裂 UTF-8 多字节字符。
8. **持久化**:`TaskStorage` 的每个 IO 边界成功/失败双路径都要有明确结果——损坏记录必须抛显式错误,
   不得当作 `null`(absent)返回。写入用临时文件 + rename 之类的原子手法。启动 reconcile 必须被生产调用,
   否则"重启后如实 lost"不成立。
9. **常开注册**:三个 `ptc_task_*` 工具必须通过 `pi.registerTool` 注册,且在 `/ptc` 模式 loadout 之外
   ——`/ptc off` 只挡新 spawn,不得让在途任务失管。生产代码里搜不到注册点 = 阻塞项。
10. **投递与唤醒**:终态必须经同一管线投递给模型;idle 唤醒通道要符合 R2 实测(`agent_settled` 边界,
    扩展工厂体内禁调 `pi.*`)。一个唤醒 handler 抛异常不得中断其余 handler。
11. **并发额度**:后台任务在 running 期间占用 `dispatchConcurrency`;额度必须是会话级(或显式注入的)
    计数器,不得每 run 重建导致跨程序失效;宿主注入的计数器不得被默认值覆盖。

## 阻塞触发

- 状态迁移无守卫 / `lost` 无 reason / 终态 read-then-write 竞争 → PR 阻塞。
- stop 路径不投递信号 / 信号阶梯缺 grace 或缺 SIGKILL / teardown 会挂起 → PR 阻塞。
- 通知静默截断 / preview 上限非单源 / 事件在切分中丢失 / XML 未转义 → PR 阻塞。
- 损坏记录被当作 absent 静默成功 / 持久化失败被吞 → PR 阻塞。
- `ptc_task_*` 无生产注册点 → PR 阻塞。

## 严重性升级(Q9-D)

命中"阻塞触发"任一项 → 升级到 delegate 复核(状态机、信号、投递都是 silent failure 源,
OCR 的精确率优势补不上召回缺失)。
