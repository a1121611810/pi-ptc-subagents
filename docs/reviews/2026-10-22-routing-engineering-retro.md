# Retro — 路由工程化走完一轮之后，agent 环境该改什么

Date: 2026-10-22. 需求：#234。票：#235–#247（13 张，全关）。分支 `feat/routing-engineering`。
评审账本（findings、证据、处置、被推翻的假设）只写在
[./2026-10-22-routing-engineering-code-review.md](./2026-10-22-routing-engineering-code-review.md)，
本文件不重复它 —— 本文件只记录**不属于这次改动**的那部分：**agent 环境本身**该改什么。

原型图（26 条决策）：[../prototypes/dispatch-doors-flow.html](../prototypes/dispatch-doors-flow.html)。

## 一句话

这轮 chain 跑完了，但**评审的两只眼睛里有一只天生看不见带点的名字** —— 落地页门禁对一个
本包真实注册的工具报绿；而**并行修复的分支合并没有守卫**，差一次就少两条修复落地。
下面七条按严重度排，前两条阻塞级。

---

## C1【阻塞】落地页门禁对自己的注册表是瞎的 —— 实测可复现

**失效。** `packages/website/scripts/check-landing-tool-names.mjs` 的注册集是用 `NAME_FAMILY`
扫源码得到的，所以**门禁的字母表决定了它能看见什么**，而没有任何东西断言这个字母表覆盖注册表。
`NAME_FAMILY = "(?:(?:ptc|pi_task)_[a-z0-9_]+|pi\\.[a-z0-9_]+)"`，而 `web_ds_search`
**不在其中**：`src/search/contract.ts:46` 声明 `WEB_DS_SEARCH_TOOL_NAME = "web_ds_search"`，
`src/tools/web-ds-search.ts:96` 用它注册。

**实测（本次 retro 现场跑的反事实，两次都复现）。**

| 落地页里写上                        | 门禁判定       | 对不对                    |
| ----------------------------------- | -------------- | ------------------------- |
| `pi.dispatch`（已退役）             | 红，退出 1     | 对（这是本轮 F-1 的修复） |
| `ptc_totally_fake`（凭空造）        | 红，退出 1     | 对                        |
| `web_ds_search`（**本包真实注册**） | **绿，退出 0** | **瞎**                    |

绿的时候它还报了一句看起来配平的话：`8 tool claim(s) against 8 registered tool(s)` ——
而 `web_ds_search` **不在那 8 个里面**。同一个名字在 claim 侧和 registered 侧都被滤掉了，
所以「数字配平」这个信号永远证明不了覆盖。

**为什么是环境的错，不是这一轮的错。** 这轮的门禁是被 review 抓出来并修好的那一类
（F-1：名字族匹配不到带点的名字 ⇒ 门禁对那个形状是瞎的，还报绿）。**修复只补了退役名那一侧**，
「字母表覆盖注册表」这一侧仍然是空的：下一个**新**工具只要名字不在家族里，
门禁对它就是完全隐形的 —— 落地页写它没人管、它不存在于门禁的必需清单里也没人管。

**机械判据。** 注册集改用**宽模式**扫（任何 `name: "…"` 字面量 + 任何 `*_TOOL_NAME = "…"` 常量），
再断言「宽集 == 家族集」；不等就红，报「有个工具名这个门禁看不见」。差一个名字就红，
和 doc-integrity 断言四「新增一条就要有人重新确认一次」是同一种纪律。

**归属。** `packages/website/scripts/check-landing-tool-names.mjs` +
`tests/website-landing-tool-names.test.ts`（该测试已有反事实 harness 的形状可套）。
**注意**：这是站点包的五个检查之一，改完要按 `packages/website/README.md` 跑全。

---

## C2【阻塞】并行修复的分支合并没有守卫 —— R-1 的根因

**失效。** 评审第 2 轮抓到 R-1（阻塞）：`fix/review-d` **从未合进集成分支**，两条 finding
（e2e 判据还是名字代理、脚本红了退 0）一直留在那个分支上。

**根因不在合并那一下，在流程里没人负责它。** `review-fix-loop` 第 2 步把阻塞 finding 分给
并行 subagent，本仓约定每个修复一个 worktree 一个分支 —— 但**没有任何一步**负责把它们合回来，
更没有一步验证「都合了」。后果是**静默的部分落地**：delta 审查范围
`9222a2c..feat/routing-engineering` 自然不含未合并的分支，**差分工具本身不会报警**。
如果没跑那一轮 delta，两条 finding 永远不会落地，而门禁与 1690 个测试**全绿**。

**机械判据。** 本轮创建的每个分支跑一遍
`git merge-base --is-ancestor <branch> HEAD`，有一条不成立就停。可做成
`scripts/check-merged-branches.sh <base>`：列出相对 base 未并入的本地分支，退出码非零。

**归属。** 两个地方各补一句：
① `.agents/skills/code-review/SKILL.md` —— 它现在**只有第 1 轮的 9 步，没有 delta 轮**；
delta 轮的第一步就该是「断言本轮所有分支已合」，否则 delta 范围本身就是个谎言。
② `AGENTS.md` 的「Dispatching sub-agents」段 —— 现在只讲「文件归属不重叠」「撞车就停手」，
没有讲**合回是父级的责任**。

---

## C3【中】AGENTS.md 的 79% 是评审专用内容，却每一轮都加载

**实测。** `AGENTS.md` 共 16915 B，按二级标题切：

| 段                                   | 字节 | 只在什么时候需要 |
| ------------------------------------ | ---- | ---------------- |
| Code review tooling                  | 6225 | 跑评审           |
| Stopping a review loop               | 3725 | 跑评审循环       |
| Review rounds and closure discipline | 3345 | 跑评审 / 关票    |
| 其余四段                             | 3597 | 日常             |

三段评审内容 = 13295 B = **全文的 79%**，而它们服务的分支（review loop）大多数轮次不触发。
每个 agent 在本仓的**每一轮**都付这份 context load。

**机械判据（按本仓已有的口径）。** 用户定的口径是「入口文件保持瘦、实体搬进被引用文档、
硬约束的指向直接指 spec 本身」。这三段正是可以搬的实体：搬进 `docs/agents/review-loop.md`，
`AGENTS.md` 留一条高优先级指向。

**搬之前要查的。** `tests/doc-integrity.test.ts` 扫仓库根三份文档，
断言二（具名符号在 `src/` 有读点）与断言四（`file:line` 钉住行号）都可能落在被搬走的行上 ——
搬完按**内容**重钉，不按行号。

---

## C4【中】锚点只在脚本头里活着，没有 package.json 入口

**失效。** `scripts/verify-ptc-off-e2e.ts` **不是** package.json 的 script —— 而它的两个兄弟
`verify:search-e2e` / `verify:parent-dispatch-e2e` 都是。全仓 grep，只有它自己的头注释
和 `tests/dispatch-section.test.ts:160` 一句注释提到它。

**为什么这条要紧。** 「锚点」在本仓是闭环的硬概念（`AGENTS.md`「Stopping a review loop」第 3 条：
对着构建产物端到端验证 = 完成的验证）。而这个锚点**红了退 0** 是本轮才补的（F-4）——
补上之前，它是唯一能看见「e2e 判据与新契约不再一致」的东西，却一直说绿。
一个只活在注释里的锚点，下一个人不会知道该跑它。

**机械判据。** ① package.json 加 `verify:ptc-off-e2e`，一步可跑。
② 一条检查：**每个 `scripts/verify-*.{ts,mjs}` 在断言失败时必须以非零码退出** ——
这条防住同类，而不是只救这一个脚本。

**要写清的边界。** e2e 要真模型，CI 没有 key ⇒ **不能进 CI**。这条边界现在是隐式的，
写进脚本头或站点 README。

---

## C5【中】OCR 的 spec 背景文件靠手裁，每次都重来一遍

**失效。** code-review skill 第 2 步记着这条坑：spec 正文 14403 字符 > OCR 硬限 8000 ⇒
abort，且**输出只有一行**，abort 发生在 preview 之前。本轮实际是手工裁的（14403 → 6204）。

**机械判据。** `scripts/build-spec-background.mjs <issue-body.md>`：按节抽
`Solution` / `Implementation Decisions` / `Testing Decisions` / `Out of Scope` 四节，
打印字符数，> 8000 直接报错退出。skill 第 2 步把「手裁 + `wc -c` 确认」换成「跑这条命令」。

---

## C6【低】一张票装不装得下，没有机制

**失效。** #243 原本装了四个机制。清点是**手工**做的，得出 87 处模型面散文 / 23 个源文件 /
21 个测试文件 —— 于是拆成 #243 / #246 / #247。票是派发的单位；一张装不下的票 =
一个上下文窗口装不下的 diff = 实现进行到一半才炸，而拆票的最佳时机是拆之前。

**机械判据。** 一个清点脚本：给定一组锚点（文件 / 符号），报出「涉及多少个独立机制、
多少个源文件、多少个测试文件、多少处模型面散文」——把「这张票太大」从判断题变成数字题。

---

## C7【低】spec 里的行为断言没有「实测 / 待实测」的标记

**失效。** 账本「被推翻的假设」第 5 条记着：**两条 spec 说法被实测推翻**
（隐式全局跨 run 污染、读未声明名字静默拿 undefined）。订正波及 5 个产物
（spec / 原型图 / 词表 / README / 措辞）—— 一句没测过的断言，错一次要改五处。

**判据。** spec 里每条行为断言要么指到一次实测，要么显式标成待实测；
`docs/testing-constraints.md` 约束 #4「期望值能指向独立来源」已经在**测试**这一侧立了同样的规矩，
spec 这一侧还没有。

---

## 本轮不做、但记在这里的

- **两条未修的观察**（停机清扫吞掉一次提拔、`TaskRecord.startedAt` 出队时被重写而 ADR-0056 从未提过它）
  记在账本末尾，**不在这里重述** —— 本文件只管 agent 环境。
- **16 个 worktree 留在盘上**：chain 六步走完，没有一步负责清理。下一轮 `git worktree list`
  是噪音，而且本仓有「同一仓并行开会话」的习惯 —— 陈旧 worktree 与在途 worktree 难分辨。
  本轮收尾时清掉；**机制**上应该进 chain 的收尾步骤。

## 留给人的问题

1. **C1 与 C2 要不要在这轮就修？** 两条都是阻塞级，但都不属于「路由工程化」这个改动 ——
   放进这一轮会让 diff 变宽、让刚做完的两轮评审的账本失真。我的建议：**都开新票，在本分支之外修**。
2. **C3 要不要现在做？** 它会动 `AGENTS.md`，而 `AGENTS.md` 刚在 `9222a2c` 改过一轮。
   建议等这一轮合入后再做，否则两处改动叠在一起审。
3. **C6 的清点脚本，其「一个机制」的定义谁说了算？** 这是判断题不是事实题：
   得先定「机制」的粒度（一个契约？一个 ADR？一个字段？），才能写出让它数得准的脚本。
