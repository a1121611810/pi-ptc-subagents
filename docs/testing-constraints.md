# Testing Constraints (pi-ptc-subagents)

本仓库的 6 条测试硬约束。任何新增 / 修改测试必须满足。`tests/test-meta-discipline.test.ts` 自动扫其中部分违反模式。

## 约束一览

| #   | 约束                                                                                     | 反例                            |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | IO 边界成功/失败双路径都有单测                                                           | 只测 happy path,失败路径留白    |
| 2   | Mock / fixture 数据来自真实样例(响应快照、线上文件、字面量常量)                          | 手写字段或从被测实现反推        |
| 3   | 失败路径有 warn 或显式错误状态 — 不留静默失败                                            | catch 块空 / resolve(undefined) |
| 4   | 期望值能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分测试)                  | 实现反推 / 同义反复断言         |
| 5   | 反事实判据:把实现改成显然错误但符合该断言的版本,测试必须红                               | 改坏实现测试还绿                |
| 6   | characterization vs specification 区分:防回归 ≠ 防错误;snapshot / 实现输出抄写只能防回归 | 用 snapshot 断言 '实现正确'     |

## 各条详细

### 1. IO 边界成功/失败双路径都有单测

任何读取外部资源(fs / net / worker / child process / clock)的代码路径,必须有 happy path 单测 + 至少一个失败路径单测(权限错 / 不存在 / 超时 / EOF / ENOENT 任一)。

**反例**:`dispatch()` 只测一个 agent 能跑通,不测 agent 不存在 / spawn 失败 / 子进程超时 / 子进程退出码非 0 / abort signal。

**正例**:`tests/dispatch-helpers.test.ts` 覆盖 `discoverAgent()` 三种 scope + `decideCloseOutcome()` 的三种结局;`tests/dispatch-e2e.test.ts`(修正后)需要覆盖 happy + agent-not-found + spawn-failure + timeout + abort。

### 2. Mock / fixture 数据来自真实样例

写 mock 时,**禁止**对着被测实现凑字段。允许来源:

- **真实响应快照**:从 dev / staging / 线上抓取,固化在 fixture 文件
- **字面量常量**:从规范 / 第三方文档直接抄录(如 PTC 协议 frame kind 字符串)
- **不变量 / 性质**:如 'tree 深度 ≤ 4' 这种结构性质
- **差分 oracle**:双实现互为 oracle

**反例**:测试反推 `expect(decideCloseOutcome({...})).toEqual({status: 'fulfilled'})`,而 `decideCloseOutcome` 的源码就在隔壁 — 实现改了测试跟着改,毫无 oracle 意义。

### 3. 失败路径有 warn 或显式错误状态

任何 catch / onError / abort handler 必须留下可观察信号:

- `console.warn` / `console.error` 或 logger 输出
- 返回带 `errorMessage` 的 rejected 结构
- 设置状态字段(`status: 'rejected'` / `kind: 'workerExit'`)
- 抛出显式 error

**禁止**空 catch、`catch { /* ignore */ }`、静默 `resolve(undefined)`。

### 4. 期望值能指向独立来源

每个 `expect(...)` 的 right-hand-side 都能回答:

> 这个值从哪来?能指到 spec 行号 / 真实样例 / 字面量 / 不变量 / 差分测试吗?

合法 5 类来源:

1. **规格 / 需求原文** — 引用 spec 行号或 ticket 验收条件
2. **可执行验收样例** — ticket 附的输入 → 期望输出样例
3. **真实数据 / 字面量** — 真实响应快照、第三方文档常量、线上文件
4. **性质 / 不变量** — property-based(幂等、round-trip、守恒)
5. **差分测试** — 双实现互为 oracle

非法 3 类(标嫌疑):

1. **从被测实现反推** — 先看实现再写期望值
2. **自洽 mock 字段** — 手写 mock 与实现共享同一错误假设
3. **同义反复断言** — `expect(add(a, b)).toBe(a + b)`

### 5. 反事实判据

每个断言都要跑这个心智实验:

> 把被测实现改成 '显然错误但符合该断言' 的版本,测试会红吗?
>
> - 会红 = specification(防错误)。OK
> - 不会红 = characterization(防回归)或根本没覆盖。X

**典型反例**:`expect(result.status).toMatch(/^(fulfilled|rejected)$/)`(dispatch-e2e.test.ts 当前状态)。把 `dispatch()` 改成永远返回 `status: 'rejected', text: ''` — 测试还过。false-pass。

**修复**:期望值必须是具体值之一,不是 '两者皆可':
expect(result.status).toBe('fulfilled'); // OK

### 6. characterization vs specification

| 类型                         | 防什么                | 来源                              | 例子                               |
| ---------------------------- | --------------------- | --------------------------------- | ---------------------------------- |
| **characterization**(防回归) | '上次这样,这次也这样' | 快照、从实现抄                    | `toMatchSnapshot()`                |
| **specification**(防错误)    | '必须是这样'          | spec / 真实样例 / 字面量 / 不变量 | `expect(result.text).toBe('PONG')` |

characterization 测试**只能**作为 '实现行为未意外变化' 的证据;**不能**作为 '实现正确' 的证据。

**反例**:用 snapshot 锁定 dispatch 返回结构,然后说 'dispatch 是对的' — snapshot 是从第一次跑出来的输出抄的,实现可能本来就有 bug。

**正例**:用 spec 中的 'spawn pi subprocess with agent X, expect text to contain PONG' 作为断言,字符级对比 spec 原文。

## F1/F2/F3/F4(自动扫描模式)

`tests/test-meta-discipline.test.ts` fixture 扫这 4 类 false-pass 模式:

**编号不是全局唯一的。** [ADR-0005](./adr/0005-ptc-execution-boundary.md) 的 F1–F4 是 worker 边界的加固项,与这里的 false-pass F1–F4 是两套编号;全仓 grep `F4` 会同时命中两者,读 ledger 或 ADR 时先确认说的是哪一套。

### F1: accept-both 断言

    expect(result.X).toMatch(/^(A|B)$/)      // X
    expect(result.X).toMatch(/^(\d+|null)$/) // X

期望值要么是 A 要么是 B,**不能接受两者**。

### F2: conditional assertion

    if (result.status === 'fulfilled') {
      expect(...)   // X 仅 success path 真验证
    }

失败路径被静默放过。改为无条件断言或拆成两个测试。

### F3: opt-in gate + early return without assert

    if (process.env.<GATE> !== '1') { return; }   // X vitest 视为 pass

改为 `test.skipIf(...)` 让 CI 看到 SKIPPED,或去掉 gate 默认必跑。

### F4: assertion-free test body(函数体无断言)

    test("budget guard", () => {
      // 这里应该断言 headroom <= 320
    });                       // X 名字在、注释在、一条断言都没有,vitest 记 passed

**为什么有这一条。** 本仓评审账本里这类 false-pass 守卫出现过三次(同一个文件
`docs/reviews/2026-09-30-binding-contract-code-review.md` 的 R4-1 / R4-7):测试名还在,
函数体里还留着一句说明它该断言什么的注释、而**一条断言都没有**,而 vitest 把这种用例报成
passed。F1/F2/F3 各自只认自己的形态(接受两者的正则 / 条件断言 / gate 提前 return),空
函数体不是其中任何一种,三条一起全绿 —— 断言被删掉这件事,没有一条守卫看得见。
反事实实测:把预算守卫的函数体清空,F4 变红(账本 Round 4 闭环表「budget guard body
emptied | F4 red」)。

**判据。** 从声明行往下读到**下一条同缩进的 test / it 声明**(或文件末尾);窗口里出现任何
名字里带 `expect` / `assert` 的调用就算有断言,所以把断言委托给助手的用例
(`assertSitesAgree(x)`)也算数。窗口按缩进切,不按大括号配对 —— 先试过大括号匹配,本仓
当场 24 处误报(`test` 也出现在正则和助手名里),一个在 24 个真实文件上乱叫的检查器比没
有更糟,所以上线的是更笨的那条。

**已知盲点**(写下来而不是藏起来):`test.skipIf(...)` / `test.todo(...)` /
`test.concurrent(...)` 不匹配声明形态,整条用例对 F4 不可见;判定是行级的,注释或字符串
里出现 `expect(` 会被算成断言;顶格(缩进 0)的 `test(` 不扫。

## 正确的、但没有测试能区分的代码(为什么不加 gate)

F1–F4 扫的是**测试体**本身假阳性。它旁边还有一个相邻的类别,连续六个 review 轮次各命中一次:
R4-1、R4-3、R4-6、R5-1、R5-2、R6-1、R6-2 —— 七例,同一个形状:**生产代码是正确的,但没有任何测试能把它和「已经改坏」区分开**。这一节记录为什么**不加** gate,以及那七个是怎么数出来的。

### 测量

总体:取 `src/` 下**每一个** `catch` 块,向后 12 行内查找带副作用的调用
(`.release .warn .unlinkSync .delete .clear .reset .restore .kill .abort .cancel`、`console.warn/error`、
`rmSync`、`unlinkSync`)。共 16 处,实测 15 处(`task-registry.ts:777` 因语句跨度测量错误跳过)。

对每一处把**整条语句**注释掉,`tsc --noEmit` 复检(避免把「改不动」当成「测不出」),再跑全量套件。
变红 = 有测试能区分;仍然全绿 = 区分不了。

```
PINNED 7 / UNPINNED 7 / SKIPPED 1 of 15
```

七处 UNPINNED **全部在 `background-runtime.ts`**,七处 PINNED 全部在其他四个文件 —— 均为 catch 中的
`logger.warn`。已补两条测试(`tests/unit/background-runtime.test.ts` 的 `cleanup-path failure logs
(round 7)` describe),逐条反事实验证会红:站点 645 与 716。

**另外五处(526 / 594 / 616 / 663 / 683)仍然没有测试,原因是生产代码缺少可替换的接缝**,而不是没人写测试:
它们全部跑在**会话前**的 registry / outputStorage / pipeline 上,而这三者在构造时是就地
`new InMemoryTaskStorage()`(:482),`createStorage` 只供给**会话绑定后**的 delegate。所以今天为这五处
写测试,只能写出一个不会失败的测试 —— 正是这一整节要避免的东西。下一步应该读作「补接缝」,而不是「再写一遍测试」。

### 为什么不加 gate

**1. 源码谓词分不开这两组。** 实测 15 处里有 11 处是 `catch` 下一行的 `X.warn(`。已 pin 的七处与未 pin 的七处
形状完全相同。差别只在于**有没有测试能走到那个 catch** —— 那是套件的属性,不是被测代码的属性。

**2. 唯一能分开的谓词是本周提交状态的巧合,而且是陷阱。** 按文件分是 7/7。但文件级规则**今天是对的,下一次往
`background-runtime.ts` 加一条已 pin 的 logger 就会变成 7 个假阳性** —— 而那次提交的净效果是让代码库**变得更好**。
**一个会惩罚改进的 gate 比没有 gate 更糟。** 这个仓库已经有两个 checker 因为同样的问题被撤回(`findF2`、round 6 删除的
动词表),这是第三个不该写的理由,不是第三个该写的理由。

**3. 唯一能区分的信号已经被采集,并且被明确丢弃。** 每次 `vp test --run` 都输出 v8 覆盖率(branch **81.38%**),
而 `vitest.config.ts:8` 把 `thresholds: { lines: 0, branches: 0, functions: 0, statements: 0 }` 全设为 0。
「这个 catch 有没有被任何测试执行到」正是 branch 覆盖率回答的问题 —— 答案每次都算出来了,然后配置把它扔掉。

但覆盖率这个**代理在关键方向上是有损的**:它说的是「这条分支从没跑过」,不是「这条分支重要」。把 branch 阈值
调上去会同时标出这七处**和**树上所有良性未覆盖分支(那 18.6% 仅仅是套件还没走到的代码)。那是同一匹狼,只是数字更大。

### 建议(是建议,不是既成事实 —— 尚未实现)

值得做的不是新 gate,而是**把计数可见一次**:对已经生成的数据做一条 review 期查询 ——
"哪些 catch-with-side-effect 分支是未覆盖的"。它没有假阳性问题,因为**没有任何东西 gate 在它上面**;
它在 diff 碰到 `background-runtime.ts` 的那一刻把这七处摆到人面前,也就是第七轮那个发现本该被抓住的时刻。
成本:一次覆盖率报告的解析,约 30 行脚本,加一条要不要维护的决定。

### 两个关于「测量本身」的错误,值得留着

下面两条和上面那个类别是同一种失败 —— 一次**不是测量**的测量,所以它们是这一节最可复用的部分。

- **第一轮扫描 15 处里有 13 处 SKIP,而这看起来像结果。** 原因是把一个五行的 `logger.warn(` 只注释了**第一行**,
  文件不再能解析,`tsc` 每次都拒,驱动脚本报 SKIP —— 如果不去看编译复检,这和「改动无效」长得一模一样。
  改成注释**整条平衡语句**之后才拿到真数据;当时唯一那条真数据(`background-runtime.ts:663` UNPINNED)是对的,另外十三条**根本没被测到**。
- **驱动脚本中途被杀,留下了改脏的 `src/runtime/dispatch.ts`**,于是「恢复后」的那次基线是 5 failed。
  半恢复的树会给出一个自信的错误基线,而它的症状看起来正是「我正在 review 的这次改动引入了回归」。
  恢复后复跑 877 passed 才继续。

### 一条附带的测量:`tests/tool-visibility.test.ts` 的 flake

5 次全量套件中有 1 次失败,是 2 条 `the probe never observed a provider request`(都是并行负载下的真实 pi 进程启动)
;另外 4 次全绿,单跑该文件 5 passed。**按实测就是 1/5**。这里**不作为缺陷记录** —— 1/5 的比率不支持下结论 ——
但仓库最贵的那个文件会按这个概率抖一下,值得知道。

## 与 code-review skill 的关系

本文件被 `.agents/skills/code-review/SKILL.md` 的 spec 轴 audit 2 引用为 Oracle check 的判定依据。
OCR `.opencodereview/rules/test-discipline.md` 承载 F1/F2/F3 的细节 + 实例,本文件承载 6 条约束的完整描述。
两者必须保持同步;改一处必须改另一处。
**F4 的同步已于本轮补齐**:OCR rule 文件、`AGENTS.md` 的两处 F 列表、以及夹具自身的文件头都写到了 F4。
补齐之前「两者必须保持同步」这一句在 F4 上不成立。写下来是为了让下一个人看得见这个缺口,
而不是让它看起来已经同步。

## What the gate does not check, and why that is accepted rather than an oversight

The gate verifies behaviour. It also verifies one narrow class of documentation claim:
`tests/doc-integrity.test.ts` 断言四 pins the list of `file:line` citations in the normative docs
that point into this repository, and adding one fails until a human re-confirms it line by line.
That is the right design for the class it covers, and it is not theoretical: the first time this
section was drafted, its own new citation pointed at `src/runtime/dispatcher.ts:435`, which the
immediately preceding comment edit had turned into a comment rather than the
`new DispatchSlotCounter(...)` line it claimed to name. The baseline caught it on its first
outing, which is the whole argument for a pinned list over a heuristic.

**What it cannot see is narrower than "documentation drift", and worth stating precisely.** Three
review rounds over one feature each found the code correct and a record wrong -- five claims -- with
every gate step green. Not one of the five was a citation that failed to resolve. Each was a
correct citation carrying a wrong **verb**:

- "this is the ONE per-run counter the binding receives" (it is the fallback; `dispatcher.ts:712`
  prefers the session counter)
- "falls back to `full`" (it falls back to the detected default)
- "the cap is one counter per pi session" (unqualified; a deps-less caller gets its configured
  per-run counter)

A pinned citation list cannot catch those, because the line it pins is real and says what the
sentence needs it to say. Catching them needs a reader, not a pattern.

**So the division is by SCOPE, not by kind.** The gate audits every claim it can recognise a
**shape** for -- the F1-F4 meta-discipline fixture is a machine checker over test bodies, and 断言四
is one over citations. Review audits claims that are **prose about control flow**, which have no
shape to recognise. Writing that as "claims are audited by review" was itself an instance of this
defect class: a record asserting what a gate covers, written once, never re-checked. Round 6 caught it.

### The standing instruction, and the three things that keep it honest

- Do not file **the meta-observation** "the gate does not check claims" as a finding. It is answered
  here, deliberately, so it is not rediscovered as news each round.
- ...but you **may and must** report a **specific** claim that drifted. The specific claim is the
  finding. The prohibition is on the generalisation, never on the instance.
- To argue a gate gap hides a defect, **name the claim it hides**. A gap you cannot name is
  theoretical, and belongs in this file rather than in a review round.
- When you add a `file:line` citation to a normative doc, expect 断言四 to fail and re-confirm the
  line by hand. That is the intended workflow, not an obstacle.
- Before filing a doc defect, check the previous round did not already fix it. Round 5 filed one
  against README text that round 4 had corrected.

### There is no cheap filter, and naming three verbs was the mistake

This guidance once listed the three words every drifted claim turned on -- **owns**, **per-run**,
**always**. Round 6 deleted that list, on a measurement rather than a preference:

**Measured as of `02def5c`.** A number printed inside the corpus it measures is
**self-invalidating by construction** -- round 7 re-measured this exact table and got 833 / 183 / 677,
because round 6 added four strong-verb sentences _to the corpus the table counts_. So if you find these
digits stale, you are not finding an error, you are finding the table doing the thing this section is about.
The claim that survives a shift of four claims is not the number: it is that no cheap predicate exists.

|                                                                                                                                                            | count         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| sentences in the 29 normative files carrying a strong universal verb (owns / always / never / guarantees / enforces / keeps / must / exactly / ONE / only) | **829**       |
| of those, sentences containing any of the three named verbs                                                                                                | **168 — 20%** |
| of those, sentences with no conditional qualifier at all                                                                                                   | **674 — 81%** |

So a checklist built from those verbs would skip four fifths of the population while feeling like
coverage, and a reviewer told to flag "unqualified strong-verb claims" would be handed 674 items,
most of them titles and rationale sentences that are perfectly correct. Sampling 8 of those from
the densest files (CONTEXT.md, ADR-0017, ADR-0022, ADR-0021) found **zero** defects -- they are dense
records, not wrong ones.

**There is no cheap predicate, and shipping something that looks like one is worse than shipping
nothing.** What caught all three examples above, and caught the citation round 5 added, was one act:
read the code a sentence points at, and ask what it does when that sentence's condition is _not_
met. That is per-claim, not a filter, which is the honest answer rather than a three-item list that
reads like one.

### What would retire this decision

A claim-class checker with a **measured** false-positive count over the whole corpus, in the spirit
of the rule that ships elsewhere in this file: a checker that cries wolf on real files is worse than
no checker. This is a hypothesis with an expiry, not a doctrine -- until that exists, review is the
auditor for prose claims, and the right response to a specific drifted claim is to fix it, not to
argue about the meta-question again.

- When you add a `file:line` citation to a normative doc, expect 断言四 to fail and re-confirm the
  line by hand. That is the intended workflow, not an obstacle.
- Before filing a doc defect, check the previous round did not already fix it. Round 5 filed one
  against README text that round 4 had corrected.
