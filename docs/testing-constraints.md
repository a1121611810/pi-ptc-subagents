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
