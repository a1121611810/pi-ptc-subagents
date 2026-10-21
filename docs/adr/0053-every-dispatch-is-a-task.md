# 每个派发都是一条任务：前台也建记录、也落盘，生命周期面是记录的后果

Status: accepted (2026-10-21). 修订：[ADR-0022](./0022-background-dispatch.md) §"What we add" 3 与 6、[ADR-0023](./0023-background-task-ownership.md) 的记录归属范围、[ADR-0050](./0050-ptc-off-stops-new-dispatch.md) 决定 3。

> **Amended by [ADR-0052](./0052-the-two-doors-share-one-prefix.md) (2026-10-21): the two task doors are renamed — `pi.dispatch` → `pi_task_ptc` (the PTC door, a binding inside a program) and `ptc_subagent` → `pi_task_codemode` (the codemode door, reachable from a `codemode` script) — with no alias and no compatibility shim. This record's decisions stand unchanged; read its `pi.dispatch` / `ptc_subagent` as those names.**

> **Amended by [ADR-0054](./0054-the-two-doors-give-one-object.md) (2026-10-21): the reason this record gave for NOT calling the foreground result's id `taskId` is gone — the door now tells a handle from a result by `status` (`isDispatchHandle`), not by the presence of an id, so the two shapes can no longer be confused. The fields keep the names this record gave them (`recordId` / `recordLabel` on the result, `taskId` / `label` on the handle); unifying the two names is now two lines in `src/runtime/dispatch.ts` and rides along with the ticket that owns that file.**

## Context

到 2026-10-21 为止，本包里有**两件**叫「派发」的事，而它们只在后台那件上留下痕迹：

- **前台**（`pi.dispatch` 不带后台开关、`ptc_subagent`）全程纯内存。它不铸任务 id、不进 registry，产出只在返回值里。模型回头查不到一个前台孩子的报告——**它跑过了，但它不在任何地方**。
- **后台**（`{ background: true }`）铸 id、进 registry、起一个脱离的泵，产出落盘。

两者的差别不是设计，是历史：ADR-0022（2026-09-24）加后台那一面时，把「任务记录」定义成了**后台**的生命周期面，于是前台那面从未被纳入。ADR-0016（2026-09-23）的前台路径比它早一个多月，写的时候没有 registry 这个东西。

这条分裂在 2026-10-21 变成了一个用户能看见的问题：模型派了一个前台孩子，孩子答完了，答案在返回值里，**但模型没有任何办法回头再看它一次**——没有 id，没有记录，没有输出文件。任务的痕迹只在后台那面存在，于是「查得到」这件事取决于你用哪种派发方式。

同一段时间里还有两处相邻的毛病，都是「前台没有身份」的直接后果：

1. **并发槽在前台是匿名的。** ADR-0016 的前台闸用 `slots.tryAcquire()`（无 key），后台闸用 `slots.tryAcquire(taskId)`（有 key）。匿名预留说不出「这次释放的是哪一个任务」，所以一次迟到的释放可以放掉另一个在飞任务的槽。`DispatchSlotCounter` 的注释自己写着这件事：keyed 的预留「让 acquire/release 按任务幂等，而幂等正是阻止迟到的泵释放放掉另一个活任务槽的原因」。
2. **三个生命周期工具（`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`）的可见性是一条独立规则。** ADR-0050（2026-10-21，同日）把它们的露面条件定成「PTC 关着**且**没有在飞任务」。于是「模型面前有没有这三个工具」与「这个会话有没有任务」是两件互不相干的事，各有各的开关。

spec #234 的决定 4 把这三件事并成一句：**派发的唯一痕迹是任务记录**。记录是派发存在的证据，于是「生命周期面可不可见」不再是独立规则，而是**有记录就在模型面前、第一次派发之前收走**的后果。

## Decision

**1. 每次派发都先建一条任务记录，前台也建；闸在建记录之前。**

闸的顺序是：`readOnly` 参数校验 → `/ptc off` 闸 → 深度闸 → 名字闸 → **并发闸** → 建记录。被闸拒掉的请求**不建记录**：它没有起过孩子，也就没有可查的东西，留下记录反而会让「模型回头查得到一个根本没跑过的孩子」成为可能。

记录在**起进程之前**建，所以记录的生命周期覆盖整次派发——包括一次起不来的 spawn（那条记录读作 `failed`，而调用方拿到的是一个 `started: false` 的拒绝）。**记录是派发的唯一痕迹**，所以一条写不下来的会话不能诚实地跑一次派发：那种情况下派发被拒绝，并把原因写进 `errorMessage`（不留静默失败）。

**2. 前台孩子的产出落盘到 `<sessionDir>/tasks/<id>/output.log`，跑完的记录还留着。**

前台路径现在把孩子的产出写进 `OutputStorage`——与后台**同一个**存储面，同一个布局（`<sessionDir>/tasks/<id>/output.log`），所以 `ptc_task_output` 读的是同一份字节，不是第二份拷贝。记录在派发返回**之后**才被驱动到终态：产出先写、终态转换后写、然后调用方才拿到结果。顺序是刻意的——调用方拿到结果就可能立刻问「那个孩子说了什么」，若产出写在结果之后，那次提问会读到半个文件和一条还写着 `running` 的记录。

跑完的记录**不删**。registry 从不删记录，这就是「记录是唯一痕迹」这句话的字面意思。

**3. 并发槽按任务 id 键记账与释放，两个面都键。**

前台不再匿名占槽。预留用派发自己的任务 id 当 key，释放用同一个 key，所以：一次释放只能放掉它自己那一次预留，而放不放得掉取决于**哪个任务**的预留，不取决于计数器里还有几个。前台与后台共用同一个计数器（ADR-0016 第 4 轮修订定下的 session 级计数），所以两个面的释放会互相看得见——**这正是键存在的理由**：匿名的释放看不出自己放的是谁的。

**4. 生命周期面的可见性是记录的后果，不是独立规则。**

三个工具的 `exposure` 是一个**活读**（getter），每次 pi 读它的时候都问同一个问题：**这个会话有没有任务记录**。

- 有记录 ⇒ `direct` ⇒ 在模型面前。
- 没有记录 ⇒ `hidden` ⇒ 不在模型面前。第一次派发之前就是这个状态：没有东西可列、可读、可停。
- 会话**恢复**（resume）时也一样：绑定会话时的那次扫描已经知道这个会话有记录，于是面从第一个请求起就在。

工具**始终注册**（pi 不能注销工具），收走的是「模型面前有没有它」。

**5. 等的结果里带任务 id 与标签。**

前台的结果带 `recordId` 与 `recordLabel`：调用方拿得到它去 `ptc_task_output` / `ptc_task_stop` 查那条记录。名字见下面「为什么不是 `taskId`」。

## 为什么不是 `taskId`

结果上的这两个字段叫 `recordId` / `recordLabel`，**不叫** `taskId` / `label`。这不是偏好，是一道撞出来的边界：

`src/tools/subagent.ts` 用「结果上有没有一个**字符串** `taskId`」来认出「这是一次后台派发、返回了句柄」。若前台的结果也带 `taskId`，那么**每一次前台 `ptc_subagent` 调用都会把自己当成后台句柄**，模型拿到的是 `Started background task <id>` 而不是孩子的答案。那条探测在 `src/tools/subagent.ts` 里，而那个文件不归本票所有。

所以前台的结果按**记录自己的词汇**命名：`recordId` 就是 `TaskRecord.id`，`recordLabel` 就是 `TaskRecord.label`。后台句柄的 `taskId` / `label` 保持不变。两边最终要并成同一个对象（spec 决定 3），那一步由门面的形状那一票（#238）做，届时句柄的探测也一起改。

## Evidence

1. **前台不留痕，是实测出来的行为差异。** 两条路都建记录之前，前台那面在 registry 里**一条记录都没有**：模型派完孩子回头查，`ptc_task_output` 只能报「unknown taskId」。
2. **匿名槽能被区分出来。** 改动前把前台的释放改回匿名（`slots.release()`），本票的并发测试立刻变红：两个并发前台任务里第一个结束时，`slots.active` 停在 2 而不是回到 1——因为匿名的释放在 keyed 持有者还在的时候是 no-op。**这正是「结束一个任务不该放掉另一个任务的槽」的可观测形状。**
3. **闸在前，记录在后，是可测的。** 把记录创建挪到并发闸之前，本票的「被闸拒掉的请求不建记录」立刻变红（registry 里多了一条记录）。
4. **「有记录才有面」是 pi 自己的机制，不是本包的发明。** pi 读工具的 `exposure` 时机有两次：注册时（决定工具进不进 active 集合）与每次请求时（决定模型被声明了什么）。所以一个**活读**的 `exposure` 能同时满足两处，而注册时写死的值不能——它会让面在会话中途变一次却没人看见。
5. **前台产出与后台产出落在同一个布局里。** 后台那面早就用 `OutputStorage` 写 `<sessionDir>/tasks/<id>/output.log`；前台现在走同一个存储面，所以 `ptc_task_output` 对两个面是同一段代码、同一份字节。

## Cost

**前台派发变慢了。** 每一次前台派发现在多付：一次 registry 写（建记录）+ 一次产出落盘 + 一次 registry 写（终态），而且**都发生在结果返回之前**——因为「调用方拿到结果就能查到那条记录」是这张票的验收条件之一，顺序不能反。

实测（2026-10-21，macOS，本机；直接量这三步，不含派发本身——派发本身被子进程主导，秒级，把噪声全淹了）：

| 后端组合                                       | 每次前台派发多付                                 |
| ---------------------------------------------- | ------------------------------------------------ |
| 内存 registry + 内存产出（测试与库调用）       | **约 0.03 ms**                                   |
| 内存 registry + 文件产出                       | 约 0.5 ms（中位；三次运行的区间 0.24–1.3 ms）    |
| **文件 registry + 文件产出（真实会话的布局）** | **约 1.7 ms**（中位；三次运行的区间 1.7–4.9 ms） |

区间宽的是文件系统，不是代码：同一段代码连跑三次，文件那一档落在 1.7–4.9 ms 之间。内存那一档三次都在 0.02–0.04 ms。

相对一次派发动辄几秒到几分钟的子进程，**这 1.7 ms 是可忽略的**——但它**不是零**，所以写在这里而不是留给下一个人去发现。

**另一处代价：前台任务不再推完成通知。** 前台的产出是**inline 交到调用方手里**的，所以再推一条「你早就知道结果的那个任务完成了」只会白花模型一个 turn。记录上因此多了一个 `awaited` 标记（`TaskSpawnSource` 的可选字段），投递层跳过带这个标记的记录。记录的形状没有变（可选字段缺席即「没有等过」），后台那面的通知行为一字未改。

## 与其它记录的关系

- **[ADR-0022](./0022-background-dispatch.md)**：§"What we add" 3 的记录不再只是后台的产物（前台也建），6 的三个工具的露面条件从「PTC 关着且没有在飞任务」改成「这个会话有没有任务记录」。
- **[ADR-0023](./0023-background-task-ownership.md)**：归属（owner 标记与 owner-scoped 的两轮清扫）从前台的记录也成立——前台任务同样带 owner 标记，同样只被拥有它的运行时实例清扫。
- **[ADR-0050](./0050-ptc-off-stops-new-dispatch.md)**：决定 3 的露面条件改了（见上）。`/ptc off` 停新派发、在飞的不动——那一条**不变**。

## 已知缺口：`/ptc off` 与 active 集合

本票把「面」的机制做完了（工具的 `exposure` 跟着记录走），但**还有一根线不在本票的文件范围内**：`src/index.ts` 的 `applyTaskToolVisibility` 在 `/ptc off` 时把那三个工具**从 active 集合里摘掉**，判据是「没有在飞任务」。

于是有一格还没对上：**PTC 关着、而会话里有一条已经跑完的记录**时，index.ts 仍然把面收走（因为没有在飞任务），而本票的规则说它应该在（因为有记录）。

补上它是一处很小的改动：`src/index.ts` 里那个「数在飞任务」的辅助函数应当问「这个会话有没有**任何**任务记录」，而不是「有几个在飞」——`TaskRegistry` 上的 `taskFaceVisible()` 已经是这个问题的答案。**该文件不归本票所有**（`/ptc off` 的截断是另一票的事），所以这里只把它记下来，不假装它已经做完。

在飞的那一格本来就是对的：ADR-0050 的行为是「PTC 关着且有在飞任务 ⇒ 面留着」，而本票的规则在那一格上给出同一个答案。

## Reopen triggers

- **前台任务的完成通知被证明有用**（模型确实需要被告知前台孩子结束了，尽管答案已经 inline 交回）——那 `awaited` 标记与投递层的跳过都要重估。
- **前台的落盘被证明太贵**（真实会话里的 fs 开销被测量为大头）——那可以只落产出不落记录，但那样「记录是唯一痕迹」就不成立了，是另一条决定。
- **门面形状那一票（#238）把两个结果并成一个对象**——届时 `recordId` / `recordLabel` 与句柄的 `taskId` / `label` 的命名统一在同一处发生，`src/tools/subagent.ts` 的探测也在同一处改。
