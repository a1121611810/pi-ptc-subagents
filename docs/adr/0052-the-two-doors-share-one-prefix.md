# 两扇门共享一个前缀：`pi_task_ptc` / `pi_task_codemode`，不留别名

Status: accepted (2026-10-21). Spec #234 决定 2。修订：[ADR-0013](./0013-ptc-row-compact-summary.md)、
[ADR-0016](./0016-ptc-dispatch-binding.md)、
[ADR-0019](./0019-minify-and-source-map-exclusion.md)、
[ADR-0021](./0021-ptc-sub-call-tree.md)、
[ADR-0022](./0022-background-dispatch.md)、
[ADR-0023](./0023-background-task-ownership.md)、
[ADR-0024](./0024-binding-contract-declares-binding-result.md)、
[ADR-0025](./0025-extension-surface-is-a-setting.md)、
[ADR-0026](./0026-surface-default-is-detected.md)、
[ADR-0027](./0027-codemode-switch-decides-surface.md)、
[ADR-0028](./0028-structured-results-for-codemode.md)、
[ADR-0029](./0029-surface-follows-codemode-activation.md)、
[ADR-0032](./0032-child-report.md)、
[ADR-0033](./0033-mcp-auto-enable-evidence.md)、
[ADR-0039](./0039-an-omitted-agent-dispatches-a-generalist.md)、
[ADR-0040](./0040-bash-is-an-opt-in-binding.md)、
[ADR-0041](./0041-read-only-is-a-call-site-tier.md)、
[ADR-0042](./0042-goal-on-dispatch.md)、
[ADR-0043](./0043-a-why-switch-and-a-name.md)、
[ADR-0044](./0044-a-dispatch-inherits-the-session-model.md)、
[ADR-0045](./0045-observed-model-field-names.md)、
[ADR-0047](./0047-deepseek-search-is-program-internal.md)、
[ADR-0049](./0049-the-search-lives-in-the-child.md)、
[ADR-0050](./0050-ptc-off-stops-new-dispatch.md)、
[ADR-0053](./0053-every-dispatch-is-a-task.md)——修订的只有**名字**，决定本身不变（逐篇的指针在各记录正文顶部）。

## Context

本包有**两扇门**，一个实现：PTC 程序里的那个绑定，和 `codemode` 脚本能调的那个工具。它们的旧名是
`pi.dispatch` 与 `ptc_subagent`。

旧名有两个毛病，第二个是实测出来的：

1. **两个名字不是同一族。** 一个带点、一个不带，没有共享的前缀，读起来像两个无关的东西。
2. **带点的那个逼出了方括号取值。** `pi.dispatch` 里有一个点，而 pi 的 `codemode` 把工具名映射成
   JavaScript 标识符（`pi.dispatch` → `tools.pi_dispatch`），所以**同一个调用在两个平面上必须写成
   两种拼法**：PTC 程序里写 `await tools["pi.dispatch"]({ task })`，`codemode` 脚本里写
   `await tools.pi_dispatch({ task })`。这不是风格问题，是形状问题。

形状问题在 2026-10-20 被真机量到了（[ADR-0049](./0049-the-search-lives-in-the-child.md) 与
[docs/specs/0044-deepseek-search-module.md](../specs/0044-deepseek-search-module.md) 记着那一轮）：
父会话在 `codemode` 脚本里写了 `await tools["pi.dispatch"]({ task })`，拿到
`TypeError: tools.pi.dispatch does not exist`，**白烧三个调用**才回退到另一扇门。原因是那行示例
没有作用域标记，而抄例子的模型不会去读例子下面那段话。

第二个毛病是**模型面**上的：spec #234 决定 2 把这一票的目标写成一句话——**模型面前只调「建任务」**。
派发是任务侧内部在做的事，不该出现在模型读到的散文里。

第三个事实是这次改名**不动**的东西：两扇门共用同一个 `dispatch()`、同一份参数表、同一套失败语义。
本篇只改**名字**与**暴露面**；「两扇门给同一个对象」（决定 3）与「等不等是一个参数」（决定 5）是
别的票。

## Decision

**1. 两扇门改名，旧名退役，不留别名、不留兼容垫片。**

| 门          | 旧名           | 新名               | 住在哪                                          |
| ----------- | -------------- | ------------------ | ----------------------------------------------- |
| PTC 门      | `pi.dispatch`  | `pi_task_ptc`      | PTC 程序里的一个**绑定**（`tools.pi_task_ptc`） |
| codemode 门 | `ptc_subagent` | `pi_task_codemode` | 注册的工具，**`codemode` reach**                |

**2. 两个名字共享 `pi_task_` 前缀，后缀是唯一的差别。** 这是刻意的：两个名字都是**合法的 JavaScript
标识符**，所以**两个平面都只用点号访问**——`tools.pi_task_ptc(...)` 与 `tools.pi_task_codemode(...)`，
任何地方都不需要方括号取值。旧名做不到这一点，而那正是模型在真机上踩到的形状错误。

**3. codemode 门对模型不可见。** 它的 `exposure` 是 `codemode`：只有 `codemode` 脚本能调它。在
`codemode_ptc` 表面上，对模型负责的编排器是 pi 自己的 `codemode`，这扇门在它**下面**——模型编排，
脚本调用。同时声明给模型会给模型摆出**第二条**建任务的路，而那两次调用不是同一个调用。

PTC 门仍然只作为程序里的绑定存在，从来没有被注册成一个 pi 工具。

**4. 模型读到的散文里不出现「派发」这个词，门被描述为「建任务」。** 派发是任务侧内部在做的事
（[ADR-0053](./0053-every-dispatch-is-a-task.md) 让每一次派发都建一条任务记录），不是模型的词。

**5. 不留别名是刻意的。** 留一个别名就是把同一个事实挂在两个名字下，正是本仓一路在避免的那种漂移
（与 ADR-0045 对 `observedProvider` / `observedModel` 的处理同一条理由）。**旧名作为历史只留在两处**：
被修订的记录正文（历史不改写，只加一行指针）、以及本记录。模型面与源码里都不再出现。

**6. 同一句话在两个平面上只写一次。** 共享的散文是**一个常量**：reach note（`common.ts` 里的
`PTC_BINDING_REACH_NOTE`）同时出现在 `ptc_run_code` 与 `ptc_workflow` 的描述里，`<ptc>` 段的搜索句
（`PTC_CHILD_SEARCH_SECTION_LINE`）同时出现在两个表面上。测试断言**两边都含那个常量本身**，所以漂移
在结构上不可能发生。

## Evidence

1. **形状错误是实测出来的，不是推理。** 2026-10-20，父会话在 `codemode` 脚本里写
   `await tools["pi.dispatch"]({ task })`，得到 `TypeError: tools.pi.dispatch does not exist`，烧掉三个
   调用才回退（[ADR-0049](./0049-the-search-lives-in-the-child.md) §"第三个 e2e"）。
   ⇒ 旧名在两个平面上必须写成两种拼法，而模型会照抄它看到的那一种。
2. **pi 的 codemode 把工具名映射成标识符。** 所以一个带点的工具名在 `codemode` 侧本来就与在
   PTC 侧不同名——这是「同一个调用两种拼法」的第二半，与上面那条实测合起来才是完整的形状错误。
3. **两个新名都是合法标识符。** `pi_task_ptc` 与 `pi_task_codemode` 都匹配
   `/^[A-Za-z_$][A-Za-z0-9_$]*$/`，所以点号访问在两个平面上都成立；`pi.dispatch` 不匹配
   （点不是标识符字符），`ptc_subagent` 匹配但不在同一族。
4. **模型面不出现内部实现词，是 spec #234 决定 2 的原话**（"模型面不出现「派发」这个词：模型调的是
   「建任务」，派发是任务侧内部做的事"），不是本篇新增的偏好。
5. **门只有一个实现，改名不碰行为。** 两扇门都调同一个 `dispatch()`、共用同一份
   `DISPATCH_PARAMETERS`（一份 schema，两处声明，一份测试钉住键集相等），所以这次改名只改名字与
   暴露面。

## Cost

- **一次破坏性改名。** 两个名字都是公开的：PTC 程序里的 `tools["pi.dispatch"]` 与 `ptc_subagent` 的
  直接调用都要改。**没有别名**意味着升级即断裂——这是刻意的，CHANGELOG 的未发布段由发布面那张票
  （#245）写。
- **模型面与源码里的散文要改五处**：`<ptc>` 段的两行、reach note、binding contract 的那条注、
  `ptc_run_code` 与 `ptc_workflow` 的描述、PTC 模式的注入简报。每一处都改「派发」为「建任务」，
  并把括号取值换成点号取值。
- **旧名留在 26 篇已接受的记录正文里。** 刻意：历史不改写，只加一行指针。所以旧名仍然出现在规范文档
  里，而 `src/` 里已经没有它了——文档完整性门禁因此需要一条**外部词汇**条目
  （文档完整性门禁的「外部词汇」清单，分类「本仓已删除的符号」），与
  `readSurfaceModeConfig` 的先例同一条机制。那条清单有两条反向守护：名字一旦重新出现在 `src/` 里
  就必须从清单里删掉，**所以 `src/` 里的旧名连注释都不能留**；没人再提的名字则是死条目，要删掉。
  被修订的记录继续提着它，所以这条条目是活的。
  —— **这一条只对 `ptc_subagent` 成立。** 两个旧名里只有它符合门禁的符号形态（snake_case），
  才进得了清单、才受那两条反向守护。带点的 `pi.dispatch` 被形态过滤器整个挡在判定面之外，
  门禁看不见它，所以它仍留在 `src/` 的注释与日志前缀里——其中「模型当时真的看到了什么」的历史
  引述刻意不改（改了记录就假了），而**描述当前绑定的活引用**（日志前缀、当前代码的注释）由
  ADR-0055 改成新名。两条旧名的命运不同，是形态过滤器的结果，不是两套规矩。
- **工具名长度变了。** `pi_task_codemode`（16 个字符）比 `ptc_subagent`（13 个）长，TUI 的行宽要
  重新看；`pi_task_ptc` 与 `pi.dispatch` 同为 11 个字符，绑定那几行不变。

## Alternatives

- **留别名**（`pi.dispatch` 仍然可用）：否决。同一件事两个名字，正是这次要消灭的毛病（ADR-0045 在
  字段名上已经拒过同一条）。
- **只改一个名字**（把 `ptc_subagent` 改成 `pi_task_codemode`，`pi.dispatch` 不动）：否决。那样两个
  平面还是两种拼法，而形状错误是实测出来的。
- **保留点号、只把 `pi.dispatch` 换成一个合法的驼峰写法**：否决。共享
  前缀是「两扇门是一族」这件事唯一能写在名字里的方式，而 `pi_task_` 同时让两个名字都落在合法的
  标识符空间里。
- **把 PTC 门也注册成一个 pi 工具**：否决。那会给模型摆出第二条建任务的路（决定 3），而本票的
  前提就是「模型面前只调建任务」这一个动作。

## See also

- [ADR-0016](./0016-ptc-dispatch-binding.md) —— PTC 绑定这一门本身；本篇只改它的名字。
- [ADR-0025](./0025-extension-surface-is-a-setting.md) —— 门住在哪个表面上；本篇不改表面的定义。
- [ADR-0051](./0051-the-surface-names-the-orchestrator.md) —— 表面值的改名（`full_ptc` /
  `codemode_ptc`）；本篇改的是门名，与它是同一串改名的两半。
- [ADR-0053](./0053-every-dispatch-is-a-task.md) —— 每次派发都是一条任务；本篇把「派发」这个词从模型
  面前收回，理由是它是任务侧内部的事。

## Reopen triggers

- **pi 的 codemode 不再把工具名映射成标识符**（或者给了一个能带点的映射）：那点号访问的必要性下降，
  但共享前缀的理由（一个族）不依赖它。
- **第三扇门出现**（一个既不是程序里的绑定、也不是 codemode 可调的工具的入口）：那时「两扇门」是假
  的，要重新审这条而不是给它加第三个后缀。
