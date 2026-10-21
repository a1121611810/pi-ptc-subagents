# PTC off 停掉新的派发：在飞的不动，但要说一声

status: accepted (2026-10-21). 修订：[ADR-0010](./0010-ptc-default-mode.md) §Decision 5、[ADR-0022](./0022-background-dispatch.md) §"What we add" 6 与 §"What we deliberately don't add" 1。

## Context

用户把 PTC 关掉之后，发现模型面前还杵着 `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` 这三个工具。他的第一反应是：**PTC 既然都 OFF 了，这三个应该也没用啊。**

这句话问的不是「工具该不该注册」，而是「off 到底关了什么」。而实测给出的答案比这更糟：**off 根本没关住派发**。

2026-10-21 对真机（pi 1.3.0）实测：`ptc.json` 写 `{"defaultMode": false}`（= 收窄关掉，也就是当时的 `/ptc off` 等价物），`subagents` 表面上父会话的工具表是

```
read, bash, edit, write, codemode, ptc_subagent, ptc_task_list, ptc_task_output, ptc_task_stop
```

父**照样调了 `ptc_subagent`**，派出了一个孩子。于是两件事同时成立：

1. **那三个工具有活干**——派单没停，后台任务照进任务名单，它们管的是真东西。
2. **「PTC 关了」名不副实**——off 当时只是把内建工具放回直接面（PTC 的收窄，ADR-0010），对派发一字未提。

用户要的是**语义**而不是改一个工具的名字：**off 对「往后新开的」生效；已经在跑的不受影响；但关的那一刻要跟他说一声在跑的不受影响。** 这条要求同时回答了上面两件事——派发停了，那三个自然没有新东西可管；而在飞的那个还得能查能停。

## Decision

**1. `/ptc off` 停掉所有新的派发，两个面都停。** 程序里直接调 `pi.dispatch`（前台）与进任务名单的后台派发，一律被拒。

闸只有一道，在 `dispatch()` 里——两个面都经过这个函数（binding 与 `ptc_subagent` 工具都调它）。闸在**每一个其它闸之上**：被拒的请求不铸 task id、不占并发额度、不起进程。

**2. 这个开关与收窄模式的 `enabled` 是两件事，不能挂在一起。** 实测：`subagents` 表面**进不去**收窄模式（`tools-unavailable`，因为 `ptc_run_code` 在那一面不是 model-facing），所以挂在 `mode.enabled` 上的开关在那一面**整场会话恒为「关」**——而那一面唯一的编排路就是 `ptc_subagent`。挂错了，那一面就彻底派不了单。

于是 `dispatchEnabled` 是独立于 `mode.enabled` 的会话级状态。收窄与派发**互斥**：off ⇒ 收窄也退出（否则两处 loadout 操作会叠在一起，而收窄的快照会让被藏起来的工具整场回不来）。

**3. 那三个工具只在「没事可管」时离开模型面前。** PTC 关着**且**没有在飞任务 ⇒ 藏起来；有在飞任务 ⇒ 留着。

留着的理由不是「保守」，是那条任务必须还能查、还能停：孩子是独立进程，off 的生命周期够不到它，把它的管理面收走就是把它丢在那儿烧并发额度（ADR-0016 那个共享计数器）。

（工具本身**始终注册**——pi 不支持注销工具；被收走的是「模型面前有没有它」。）

**4. 关的那一刻要说清楚在跑的那个怎么样。** 有在飞任务时，通告里明写「NOT affected」：不写的话，「off」会被读成「全停了」，而实际发生的是相反的事。

**5. 开关是会话级的，写进 session 记录。** 和 ADR-0043 的 `why` 同一套机制：改 `background.dispatchDeps` 这个唯一被所有面读的对象（下一个 turn 就生效），`pi.appendEntry` 记一笔（`/reload` 与 resume 都还在），**不写任何文件**。`/ptc on` 把它放回去。

**6. 模型也要被告知。** `<ptc>` 段在派发关着时只给一句话，不再给调用约定——给一条它做不到的指令是浪费一次调用。搜索那句也一并撤掉：「派个子代理让它去搜」正是此刻做不到的事。

## Consequences

- **拒绝的形状**与其它拒绝一致：`status: "rejected"`、`started: false`、无 report channel，`errorMessage` 指名出路（`/ptc on`），不是一个让模型反复重试的死胡同。
- **readOnly 的参数校验仍然是第一道拒绝**（它管的是请求自己的参数），派发闸在它下面、后台分支上面。
- **`/ptc` 的查询回复现在报两件事**：收窄状态 + 派发状态。以前那句「dispatching a child and the background-task tools still work」是照着当时的行为写的，现在那是关掉之后**不成立**的话。
- **模型可见文案要跟着改**：那三个工具的 guideline 原先写着「off 时仍可调用」，而 ADR-0022 的 item 6 写着「off 只挡新派发」——后半句当时是**假的**（ADR-0034 在 2026-10-10 删掉了那个真的存在的 `off` 档之后，它就成了陈迹）。现在代码改成兑现那句话，文案则按新行为重写。
- **没做的**：不改命令名。footer 仍然只在收窄开着时显示 "PTC"，而 `/ptc off` 现在同时关两件事——命名与心智模型的落差（用户会把「PTC off」读成「PTC 关了」）是独立的一条，尚未决定。

## 这条决策是被什么顶出来的

三条事实，都可复核：

1. **实测**（2026-10-21，真机 pi 1.3.0，`subagents` 面）：PTC 收窄关着时父**照样派单** ⇒ 旧行为不是「off 挡新派发」，是「off 什么都不挡」。
2. **实测**（同上）：`subagents` 面进不去收窄模式 ⇒ 开关不能挂在 `mode.enabled` 上，否则那一面永远派不了单。
3. **反事实**：把闸挂在 `mode.enabled` 上（一个同样自洽的实现）⇒ `subagents` 面的 `ptc_subagent` 永远被拒，`subagents` surface 整体作废。决策 2 的独立开关就是这条反事实逼出来的。

## Reopen triggers

- **在飞任务也需要被 off 停掉**（比如用户要的是「立刻全部收工」而不是「不再开新的」）——那是一个 kill 开关，不是这一条；ADR-0022 的 `ptc_task_stop` 已经是那条路，用户也可以直接用它停。
- **off 要跨会话生效**——现在是会话级（ADR-0043 的 `why` 同一形状）。长期关掉整个包的现成做法是 `pi config` 停用本包，那连工具都不注册。
