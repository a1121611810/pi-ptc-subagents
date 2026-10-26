# 准入排队：满了不拒绝，FIFO 无界，入队即建记录

status: accepted (2026-10-21). 修订：[旧 ADR-0016](./0016-ptc-dispatch-binding.md) §Decision 2 与 §Decision 3、[旧 ADR-0022](./0022-background-dispatch.md) §"What we add" 2、§"What we deliberately don't add" 2、G1 与 §2 状态机。**本篇与 旧 ADR-0016 / 旧 ADR-0022 读得不一样的地方，以本篇为准。**

> **Amended by [ADR-0011](./0011-cancellation-only-reaches-queued-tasks.md) (2026-10-21): both items this record left as "the next step" are now done — the model can withdraw a task that is still waiting (`ptc_task_stop` on a `queued` task takes it out of the queue and marks it `canceled`), and `/ptc off` pulls the queued ones out while the running ones continue. Decision 7 (the foreground abort withdraws its queued request) stands unchanged.**

## Context

并发槽满了的时候，今天的答案是**拒绝**：来晚的那次调用拿到

```
{ status: "rejected", errorMessage: "dispatch concurrency limit reached" }
```

后台那面还多教了一句「去看 `ptc_task_list`，用 `ptc_task_stop` 空出一个槽」。这两条消息是 旧 ADR-0016 §2 与 旧 ADR-0022 §9 的直接产物，两篇都把「故意不做等待队列」写进了正文——旧 ADR-0016 §Decision 3 写的是「The cap is **hard** (reject, never queue)」，旧 ADR-0022 §"What we deliberately don't add" 2 写的是「There is no in-task queue (`queued` state absent, per G1). Spawn above the cap resolves with `rejected` immediately.」

今天这条规则有一个可测的代价，旧 ADR-0022 自己记着：八个长跑的后台孩子 + 一个程序并发 24 次前台调用，前台**起了 0 个**。原文写「Because the refusal is a hard reject with no queue, a foreground call is not made to wait for a background child to finish; if a session needs foreground headroom while long background children are live, it needs a bigger cap, not a later retry.」

**那个前提是错的。** 调用方本来就要等孩子跑完——前台的 `pi.dispatch` 一直等到子进程退出才 resolve，后台的模型本来就在等完成通知。排队不是新增成本，**拒绝才是**：拒绝把一次「现在忙」变成了「这件事没做」，而模型对这件事的合理反应是重试，于是「现在忙」在重试里变成「更忙」。

拒绝还有第二个代价：它让「排队中的任务」不存在。ADR-0007 把任务记录定成派发的唯一痕迹之后，这条尤其刺眼——一个被拒绝的请求不留任何记录，模型回头查不到它，它就彻底没了，连「它当时在等什么」都问不出来。

## Decision

**1. 固定槽位；满了排队，FIFO、无界、无超时，从不拒绝。**

准入从一道**闸门**变成一道**队列**：

- 槽位数量不变（`dispatchConcurrency`，session 级，所有门共用一份，见 旧 ADR-0016 §2 与 旧 ADR-0022 §9）。
- 槽满时，请求**进队列等**，不是被拒绝。
- 队列是 FIFO：先到的先跑。
- 队列**无界**，**没有超时**。跟 libuv 的线程池一个形状。

**2. 入队即建记录（状态 `queued`）。排队中的任务已经是任务。**

被排队的请求立刻在 registry 里有一条 `queued` 记录——有 id、有标签、有 agent 名。所以：

- 它在 `ptc_task_list` 里**看得见**（`ptc_task_list({ status: ["queued"] })` 就能筛出来）。
- **队列就是 registry 里 `queued` 的那些记录**——队列状态与任务状态是同一份数据，不是两份。想知道谁在等，读任务列表就够了。

旧 ADR-0022 的 G1 与 §2 状态机把 `queued` 明确排除在外（"`queued` deliberately absent in v1"）。本篇把它放回来：状态机从 6 态变成 7 态，新增的行是 `queued -> running`（出队）、`queued -> canceled`（抽掉排队中的请求，见下）、`queued -> lost`（会话死了，排队中的任务被回收）。

**3. 槽只被「跑起来的孩子」占。排队的不占。**

这是队列存在的全部意义：一个排队的任务没有孩子，没有进程，没有内存。它只在队列里占一个位置。

**4. 出队 → 取槽（按任务 id 键）→ 记录转 `running` → 起进程。**

顺序是刻意的：记录先说 `running`，孩子才起来。模型读到的记录因此从不说「running」而实际上没有子进程。`startedAt` 在**出队转 `running` 的那一刻**被改写，所以 `durationMs` 量的是孩子**跑起来之后**的时间，**排队那一段不计入孩子时长**。

**5. 不等的派发立刻返回句柄，不等槽；孩子等槽排到时才真的起。**

后台那一面不等：它返回句柄（`status` 是 `queued`），孩子排在队列里，到队首才起。这跟 libuv 每个 work item 的调用方都 await 它不一样——我们是 fire-and-forget，让它阻塞在队列上就不「不等」了。

**6. 前台那一面等。**

前台的 `pi.dispatch` 一直等到孩子跑完才 resolve，所以它等槽是顺带的事，不是新增的一步等待。**前台的界是程序自己的超时**（PTC 程序的 deadline，默认两分钟）。

**7. 前台中止抽掉排队的请求。**

前台程序中止（它自己的超时到了）时，还在排队的请求被抽掉——它是前台队列的天然界，也是一个必须的清理：否则那个排队的请求会在几分钟后拿到槽、起一个没人等的孩子。抽掉这件事在记录上留痕（`queued -> canceled`，带理由），不静默消失。模型面主动取消一个排队中的任务（`ptc_task_stop`）是另一条路，同一个边。

**8. 「满员即拒绝」不再是拒绝理由。**

两个并发拒绝工厂与它们的消息一起消失：

- `dispatchConcurrencyLimitReached()` 与 `DISPATCH_CONCURRENCY_LIMIT_MESSAGE`（`"dispatch concurrency limit reached"`）
- `backgroundDispatchConcurrencyLimitReached()` 与 `BACKGROUND_CONCURRENCY_LIMIT_MESSAGE`（后台那句教模型去看 `ptc_task_list` / `ptc_task_stop` 的）

它们没有别的用处——这个 cap 不再是任何拒绝的理由，所以留着它们就是留着一个模型永远不该再看到的消息。

**9. 闸门顺序变了一处：agent 解析在准入之前。**

今天的顺序是「取槽 → 解析 agent」，因为取槽当时是一道**拒绝**闸门，所以它可以抢在 agent 发现之前短路掉整个请求。取槽现在是**排队**，没有东西可短路了：一个解析不出 agent 的请求应当**当场失败**，而不是在队列里排半天之后才失败；一个解析得出 agent 的请求也不该因为「多了一个」而被拒。

## libuv 的证据

libuv 的线程池是这个形状的来源。下面的每一条都能在 `libuv/src/unix/threadpool.c` 里读到（`v1.x` 分支，2026-10-21 取）：

| libuv 线程池                                                                   | 我们                                           | 出处                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定 4 个 worker（`UV_THREADPOOL_SIZE` 可调，上限 `MAX_THREADPOOL_SIZE 1024`） | 固定槽位，session 级，所有门共用一份           | `static uv_thread_t default_threads[4];` / `#define MAX_THREADPOOL_SIZE 1024` / `init_threads()` 按上限预分配并 `uv_thread_create`                                           |
| `wq` 是一条**无界**链表，满了从不拒绝                                          | 待准入队列无界，满了排队等                     | `static struct uv__queue wq;` + `uv__queue_init(&wq)`；`post()` 里只有 `uv__queue_insert_tail(&wq, q)`，**没有**任何「满了吗」的判断                                         |
| FIFO（worker 从队首取）                                                        | FIFO                                           | `post()` 插**尾**（`uv__queue_insert_tail`），worker 取**头**（`q = uv__queue_head(&wq)`）                                                                                   |
| `uv_cancel`：还在队列里的能抽掉（返回 0）；已经开始执行的返回 `UV_EBUSY`       | 抽掉一个还在排队的任务；已起的不行，走信号阶梯 | `uv__work_cancel()`：`cancelled = !uv__queue_empty(&w->wq) && w->work != NULL;`——还在队列里且还没被执行就是可取消的；worker 接手后把 `w->work` 置空，于是取消返回 `UV_EBUSY` |
| 队列里的请求没有超时                                                           | 排队等待无超时                                 | 队列路径上没有任何计时器：等待是 `uv_cond_wait(&cond, &mutex)`，只有 worker 空闲才被唤醒                                                                                     |
| `uv_work_t` 从提交起就存在                                                     | **入队即建任务记录**（状态 `queued`）          | `uv__work_submit()` 把请求装好并 `post()` 进去；调用方从提交那一刻就拿着这个 handle                                                                                          |

业界没有一家在满员时拒绝。libuv 的注释自己写着这个前提：「If fifty tasks arrive, forty-six wait.」

## 已知取舍

**队列是无界的。**

libuv 的前提是它的生产者**天然有界**——那是一条外部请求流（一个 HTTP 服务器、一个文件遍历），请求的数量由外面决定，不是由程序自己决定的。

我们的后台生产者是一个**能循环调用的程序**。今天 `dispatchConcurrency: 8` 白送了「最多 8 个后台孩子」这个界；改成无界队列之后这个界就没了：

- **cap 不再界住一个会话能有多少孩子在飞**——它只界住「同时跑几个」。
- **后台没有界。** 一个循环调用的程序可以排出任意多个任务，每个任务最终都会起一个进程。
- **前台的界是程序自己的超时**（PTC 程序的 deadline，默认两分钟）。前台程序跑完或超时，队列里属于它的请求就抽掉了。

这个取舍是**明确接受**的，今天记在这里而不是留给下一个人去发现。真要收紧，方向是给**队列本身**加界（满了怎么办），而不是回到「拒绝」——那是一个独立的问题，且 spec #234 的 Out of Scope 已写明「收紧队列的无界性」不在本轮。

## 与其它记录的关系

- **[旧 ADR-0016](./0016-ptc-dispatch-binding.md)**：§Decision 2 的「A call over the cap … resolves as `{ status: rejected, errorMessage: dispatch concurrency limit reached }` instead of being queued or spawned」与 §Decision 3 的「The cap is **hard** (reject, never queue)」被本篇推翻——满了排队，不再拒绝。并发上限的**数目**、它的 session 级作用域、它与 `maxParallelSubCalls` 的分离，都不变。
- **[旧 ADR-0022](./0022-background-dispatch.md)**：§"What we deliberately don't add" 2（「There is no in-task queue … Spawn above the cap resolves with `rejected` immediately」）与 G1（「`queued` deliberately absent in v1」）被本篇推翻；§2 的状态机从 6 态变成 7 态。任务的记录、订阅游标、投递决策、信号阶梯，都不变。
- **[ADR-0007](./0007-every-dispatch-is-a-task.md)**：不变，但被本篇**延伸**了。ADR-0007 说「每个派发都先建一条任务记录」；本篇说入队的那一次派发**也**建记录，状态是 `queued`。「记录是派发的唯一痕迹」因此多了一条推论：**排队中的任务也是任务**，它在模型面前可见、可查、可取消。

## 遗留

- **模型面主动取消一个排队中的任务**（`ptc_task_stop` 对一个 `queued` 的任务）是下一步的事。本篇已经把边开好了（`queued -> canceled`），但工具那一面还没有接上。
- **`/ptc off` 的截断语义**（「停收新的 + 抽掉排队中的 + 在跑的照常」）是另一票的事。本篇给抽掉排队中这一步备好了零件（`cancelQueued`），但 `/ptc off` 还没有用它。

## Reopen triggers

- **队列被证明需要界**（一次会话排出成百上千个任务，内存或进程表先炸了）——那时的方向是给队列加界，而不是回到拒绝。
- **前台的等待被证明是新增成本**（模型在两分钟的 deadline 里排了十分钟队，什么也没做成）——那时该讨论的是前台要不要也走「不等」那条路（spec #234 决定 5 的 `wait` 参数是那个形状）。
- **排队中的任务被证明不能被看见**（模型看到一堆 `queued` 反而更困惑）——那时该讨论的是模型面要不要把 `queued` 折叠掉，而不是把它藏起来。
