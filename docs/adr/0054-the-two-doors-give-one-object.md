# 两扇门给同一个对象：不投影、不套信封、都不抛

Status: accepted (2026-10-21). Spec #234 决定 3。修订：[ADR-0028](./0028-structured-results-for-codemode.md)、
[ADR-0053](./0053-every-dispatch-is-a-task.md) 的字段命名一节。

> **Amended by [ADR-0055](./0055-wait-is-one-parameter.md) (2026-10-21): the two shapes name the id the same way, and one parameter chooses between them.** The result's id is `taskId` and its label is `label` — the handle's names — so the object a script reads no longer needs two vocabularies for one task. The discriminant stays `status`: a handle is `"running"` or `"queued"`, a result is `"fulfilled"` or `"rejected"`. A task door resolves with a handle unless the caller asks it to wait (`wait: true`), and a refusal is a result on both. Where this record and ADR-0055 read differently, ADR-0055 governs.
> **Amended by [ADR-0059](./0059-route-registry.md) (2026-10-21): the shared door note (`TASK_DOOR_RESULT_NOTE`) moved into the route registry — one home for every piece of model-facing prose. Decision 6 is unchanged: the same sentence on both planes, one constant, and a test asserting both sides carry it.**

## Context

本包有**两扇门**，一个实现：`pi_task_ptc`（PTC 程序里的绑定）与 `pi_task_codemode`（`codemode` 脚本能调的
工具）。spec #234 决定 2 把它们改成了共享前缀的一个族，决定 3 要把它们**给同一个对象**。

开工时两边给的是两种形状，差在两处：

1. **codemode 门给的是一个投影，不是结果本身。** 那个门声明了 `outputSchema`，于是 pi 交给脚本的是一个
   **结构化值**代替文本块；而那个投影里**没有 `text`**——所以脚本派出去的子代理，它的工作输出正文
   读不到，只能读到结构化报告。这不是形状不齐，是**功能缺口**。
2. **codemode 门拒绝时抛异常，PTC 门不抛。** 一道闸门说「不行」被表达成了「调用失败」：在
   `Promise.allSettled` 里，一个兄弟的拒绝会把整批的结果一起吃掉。

还有一件 [ADR-0053](./0053-every-dispatch-is-a-task.md) 留下的事：前台结果上多了一个 id 字段，它不叫
`taskId` 而叫 `recordId`，理由是 `src/tools/subagent.ts` 用「结果上有没有一个**字符串** `taskId`」来
认出「这是一次后台派发、返回了句柄」。#237 为此加了 `isDispatchHandle` 守卫（按 `status` 判别）并把九个
测试文件的判别点挪到了守卫上——**但那个「理由」当时还留在原地**。

## Decision

**1. 两扇门给同一个对象：原始 `DispatchResult` / `DispatchHandle`，不投影、不套信封。**

PTC 门本来就 resolve 原始值；codemode 门现在把**同一个值**交给脚本（`structuredContent` 原样放进去），
字段名一个不改。不套信封，是因为信封会多一层嵌套，而 PTC 程序已经在读的字段必须原样活下来。

**2. codemode 门保留 `outputSchema`，但扩成完整的结果形状（含 `text`）。**

不是删掉它——删掉会让脚本只剩一段文本，`status` / 任务 id / `report` 这些结构化字段全丢，模型反而更难用。
是把**投影**换成**原始形状**：字段名与 PTC 门那边的值同名，脚本与程序读同一套词汇。

**3. 两个门都不抛。** 拒绝是一次「闸门说不行」，不是一个异常：`status: "rejected"` 加 `errorMessage`，
形状在两个门上、两种等法下完全相同。

**4. 判别式是 `status`，不是「有没有 id」。** 句柄恒为 `"running"`，结果恒为 `"fulfilled"` 或
`"rejected"`；`isDispatchHandle` 就是这条判别式。前台结果自己也带 id（`recordId`），所以
「有没有 `taskId`」已经不能分辨两者。

**5. 字段命名的定论：结果上仍是 `recordId` / `recordLabel`，句柄上是 `taskId` / `label`；改名不在本篇。**

见下面「为什么不是 `taskId`」一节。

**6. 「结果长什么样」这句话是**一个共享常量**（`TASK_DOOR_RESULT_NOTE`），两个平面各说一次。**

PTC 平面的模型在绑定契约里读到它，`codemode` 平面的模型在门自己的描述里读到它。同一句话写两遍就是
同一句话会漂——这正是本仓一路在消灭的毛病。一条测试断言两边都含那个常量本身。

**7. TUI 标签是 `PTC Task`，行标题是 `task`。** 「subagent」这个词在模型面已经退役（ADR-0052），用户
读到的行该用同一套词汇。这是**用户面**的一行，不是模型面散文，所以「沙箱」守卫与共享常量规则都不适用；
但词汇一致适用。标签也比旧名短（8 个字符对 13 个），而门名本身变长了（`pi_task_codemode` 16 个字符），
行宽因此要重新看一遍。

## 为什么不是 `taskId`

**先把事实摆正：spec #234 从来没有给结果上的 id 命过名。** 票面引用的「决定 6 说结果带 `taskId` /
`label`」与正文对不上——决定 6 讲的是照 libuv 排队，不是 id 的名字。正文里唯一给这个字段命名的记录是
[ADR-0053](./0053-every-dispatch-is-a-task.md)，它叫 `recordId` / `recordLabel`，并且**明确把统一这件事推给
了本票**（门面形状那一票）。

ADR-0053 给出的**理由**是：`src/tools/subagent.ts` 用「有没有字符串型 `taskId`」区分后台句柄；若前台结果
也叫 `taskId`，每一次前台调用都会把自己报成后台任务。**那个理由在本票消失了**：判别式已经改成按 `status`
（`isDispatchHandle`），句柄的探测不再看 id 字段。所以改名的**障碍**没有了，**剩下的只是一次改名**。

本篇**没有**做那次改名，理由是文件的归属：结果形状声明在 `src/runtime/dispatch.ts`（`DispatchResult` 的
字段声明与那处赋值），而那个文件不归本票所有，且有一张兄弟票正在改它。于是：

- **本篇定的**：判别式（`status`）、两扇门的对象（原始值）、字段的**现状**（`recordId` / `recordLabel`）。
- **本篇记下的**：改名只剩两行（`src/runtime/dispatch.ts` 的字段声明与赋值）加上读它的两个测试文件；
  它跟着 #239 走——#239 拥有 `src/runtime/dispatch.ts`，而且它正是把「等 / 不等」变成模型看得见的那个参数
  的票，模型那时本来就要按模式分支，顺手统一 id 的名字是同一处事。

**这不是「同一个对象」的反面**：两扇门给的是同一个对象（同一份字段、同样的值、同样的名字）；结果与句柄是
**两种模式**下的两种形状，本来就长得不一样，而它们各自的形状在两个门上完全一致。

## Evidence

1. **pi 的 codemode 工具声明**：`outputSchema: tool.outputSchema ?? TEXT_OUTPUT_SCHEMA`
   （`@earendil-works/pi-coding-agent@1.3.0` 的 `dist/extensions/codemode/tool.js:79`），而
   `TEXT_OUTPUT_SCHEMA = { type: "string" }`（同文件 `:35`）。⇒ **没有** `outputSchema` 的工具，脚本拿到的是
   一段文本；**有** `outputSchema` 的，拿到的是结构化值。删掉 `outputSchema` 会让脚本只剩文本，
   `status` / 任务 id / `report` 全丢——所以正确做法是**把它扩成完整的结果形状**。
2. **pi 把 `structuredContent` 原样交给脚本**（`dist/extensions/codemode/execute.js:370`-`:377` 的
   `toScriptValue`）：`if (tool.outputSchema && result.structuredContent !== undefined) return
   result.structuredContent;`。既不校验也不改写，所以「原始对象」在 pi 这一侧是零成本的。
3. **投影里没有 `text` 的后果是可测的**：`tests/unit/ptc-subagent.test.ts` 里那条「脚本读到子代理的工作
   正文」断言，在改之前是红的——投影只有 `task_id` / `status` / `exit_code` / `report_channel` 这几个键。
4. **拒绝抛异常的代价**：`Promise.allSettled` 里一个抛异常的兄弟，其余行照样 resolve，但调用方的
   `try`/`catch` 写法会把整批一起带走；而「闸门说不行」根本不是失败。
5. **判别式必须换**：ADR-0053 给前台结果加了 `recordId`，于是「有没有 `taskId`」不再是形状的判别式——
   这一点是 #237 自己记下来的（它为此加了 `isDispatchHandle` 并把九个测试文件挪了过去）。
6. **契约的预算**：绑定契约从 288 token 涨到 312（上限 320，下限 200），涨的那句就是共享常量本身。
7. **门面的词汇**：`tests/unit/ptc-subagent.test.ts` 的行渲染断言与 `tests/render-ptc.test.ts` 的两处都
   钉着 `└─ subagent → (generalist)`，改词就要同时改这三处。

## Cost

- **codemode 目录的 schema 变大了。** 声明从 8 个键变成 19 个（原始结果的字段 + 句柄的三个），pi 渲染出来
  的字段清单从约 100 字符变成约 230 字符（`describeOutput` 走 `describeFields`，`dist/extensions/codemode/tool.js`
  的 `:183` 一带）。而 pi 的 codemode 目录**有预算**：`selectCatalog`（同文件 `:98`）按预算丢条目，
  每件工具的条目成本是 `Math.ceil(section.length / CHARS_PER_TOKEN)`（同文件 `:135`）。**一件工具的条目更贵，
  目录里就能少放几件工具。** 这是本篇认下的代价。
- **描述也长了**：共享常量一句约 190 字符（48 token），进的是 codemode 目录里这件工具的条目成本。
  它的回报是同一个模型在两个平面上读到**同一句**关于拒绝语义的话。
- **脚本里的旧写法会坏**：读 `report_channel` / `exit_code` / `task_id` 的脚本要改成 `reportChannel` /
  `exitCode` / `taskId`。这是破坏性变更，CHANGELOG 的未发布段由发布面那张票（#245）写。
- **句柄不再带 `readOnlyTier`。** 投影曾经往句柄上塞了一个档位；原始句柄只有三个字段（`taskId` /
  `label` / `status`），档位在任务记录上（`ptc_task_output` 读得到）也在文本里——脚本要读它得多调一次
  `ptc_task_output`。这是「不投影」这条规则的直接后果。
- **TUI 的行宽**：标签从 `PTC Subagent`（13 个字符）变成 `PTC Task`（8 个），行标题从 `subagent` 变成
  `task`，两处都变窄或持平。
- **结果的 id 字段仍然有两个名字**（结果 `recordId`、句柄 `taskId`）。理由见上，一句话：**改名只剩两行，
  它跟着拥有那个文件的票走。**

## Alternatives

- **删掉 codemode 门的 `outputSchema`**，让脚本拿回一段文本：否决。那会让 `status` / 任务 id /
  `report` 全丢，模型拿到的是一段要自己解析的散文——比今天严格更差。
- **保留投影，只把 `text` 加进去**：否决。那样两个门给的就还是两种形状（`report_channel` 对
  `reportChannel`），而 spec 决定 3 要的是同一个对象；「字段集相等」验的不是「有个 `text` 就算过」。
- **套一个统一信封**（`{ ok, value }` 之类）：否决。多一层嵌套，而 PTC 程序已经在读的字段必须原样活下来。
- **把拒绝继续表达成异常**：否决。一道闸门说「不行」不是调用失败，而抛异常会把兄弟的结果一起带走。
- **把结果上的 id 改名为 `taskId`、句柄探测改成 `isDispatchHandle`**（票面首选）：**这是对的方向，
  但本篇做不到**——字段声明在 `src/runtime/dispatch.ts`，那个文件不归本票所有，且有一张兄弟票正在改它。
  本篇把**判别式**改掉（那才是让改名安全的前提），并把改名记在这里与 #239。

## See also

- [ADR-0028](./0028-structured-results-for-codemode.md) —— 本篇修订它：它定的是「`structuredContent` 是一个
  投影，不是一面镜子」，而本篇把 codemode 门这一条换成了原始结果。
- [ADR-0053](./0053-every-dispatch-is-a-task.md) —— 本篇修订它的字段命名一节：它把统一推给本篇，本篇只做
  了让统一安全的那一半（判别式），并把改名记在了 #239 那里。
- [ADR-0052](./0052-the-two-doors-share-one-prefix.md) —— 两扇门的名字与暴露面；本篇改的是它们的**形状**。
- [ADR-0016](./0016-ptc-dispatch-binding.md) —— 「绑定永不抛」的旧约定；本篇把同一句话扩展到了 codemode 门。

## Reopen triggers

- **pi 的 codemode 改了 `outputSchema` 的语义**（或者给了一个能带嵌套对象的形状）：目录成本的算法要重新量，
  「一个扁平对象而不是联合类型」这条理由也要重写。
- **pi 的 codemode 目录不再有预算**（或者预算大到装得下全部工具）：本篇认下的那条代价就不成立了，可以考虑
  把 schema 写成一个联合类型，让每个分支各自声明自己那三个键。
- **结果上的 id 字段改名落地了**（#239）：本篇的「为什么不是 `taskId`」一节要改写成「已经改了」，而
  `isDispatchHandle` 这条判别式的理由要补上另一半。
- **出现了第三扇门**（一个既不是程序里的绑定、也不是 codemode 可调的工具的入口）：「两扇门」这个说法本身要
  重新审，而「同一个对象」这条要重新验。
