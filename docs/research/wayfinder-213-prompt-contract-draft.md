# 两臂 prompt 契约措辞草稿（wayfinder #213）

状态：**草稿**，供 [ticket #213](https://github.com/a1121611810/pi-ptc-subagents/issues/213) react。
不是规范。最终措辞在 spec 里定。

---

## 0. 一条决定两臂是否可比的前提

**B 臂必须携带与 A 臂相同的信息，只改变编码方式。**

如果 B 多一个字段，A/B 就变成「结构化 vs 多一条指令」，形状这个变量被污染了。所以下面两段措辞说的是同一件事，只是序列化方式不同。

---

## 1. A 臂：`summary` 仍是 string

### 现状（`src/runtime/child-report.ts:132`）

```
a JSON object with exactly these keys: "summary" (one line, your own words),
"findings" (an array of objects each with "what" and "evidence", where evidence
is the independent thing that supports the claim), and "files_touched" (an array
of paths you created or modified)
```

### 改成

```
a JSON object with exactly these keys:
  "summary"      — what your result means for the caller: what changes because
                   of it, or what they should do with it. Not a restatement of
                   the findings.
  "findings"     — an array of objects each with "what" and "evidence", where
                   evidence is the independent thing that supports the claim.
                   State facts here, not advice.
  "files_touched" — an array of paths you created or modified.

Say what it means in "summary" and what is true in "findings". Do not make the
same statement twice. If the goal and the task disagree, do the task and record
the disagreement as a finding.
```

### 改动点

| 项                              | 变化                                                     |
| ------------------------------- | -------------------------------------------------------- |
| `summary` 的语义                | 从「一行结论」改为「对调用方的意义」                     |
| 非重复规则                      | 新增一句                                                 |
| goal/task 冲突                  | 新增一句（来自 ticket #212 的裁决）                      |
| 边界（20 findings / 150 chars） | **不写进 prompt**。渲染时 in-band 声明，子代理不需要知道 |

---

## 2. B 臂：`summary` 改成结构化对象

### 改成

```
a JSON object with exactly these keys:
  "summary"      — an object with exactly these keys:
                     "conclusion"  — one line: what you concluded.
                     "implication" — what your result means for the caller:
                                     what changes because of it, or what they
                                     should do with it. Not a restatement of
                                     the findings.
  "findings"     — an array of objects each with "what" and "evidence", where
                   evidence is the independent thing that supports the claim.
                   State facts here, not advice.
  "files_touched" — an array of paths you created or modified.

Say what it means in "summary" and what is true in "findings". Do not make the
same statement twice. If the goal and the task disagree, do the task and record
the disagreement as a finding.
```

### 为什么是两个字段

`conclusion` + `implication` 正好是 A 臂那段散文的两个成分。**不加第三个字段。**

备选过的字段：

| 候选                 | 为什么不要                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `caveat`             | 诚实度归 `findings`（ticket #206 的裁决）；单独一个字段会和 findings 抢地，重开 two-copies 问题 |
| `confidence`         | 模型自报置信度是噪声，没有校准依据                                                              |
| `recommended_action` | 它是 `implication` 的一个特例，不值一个字段                                                     |
| `next_steps`         | 同上，且会诱导子代理越过任务边界                                                                |

---

## 3. `<pi-ptc-goal>` 块

### 草稿

```
<pi-ptc-goal>
Background from the caller: why this task was dispatched.

{{goal}}

The task you were given is the deliverable. This goal is context for doing it
well, not authority to change it. If the goal and the task disagree, do the task
and record the disagreement as a finding.
</pi-ptc-goal>
```

### 三个决定

1. **位置：`<pi-ptc-context>` 之后。** context 块建立处境（depth、看不到父会话、报告契约），goal 块是唯一的调用方内容。先处境、后内容，读起来顺。
2. **最后一句是范围限制，不是礼貌话。** ticket #211 定了不给判断权；那句话必须写进子代理看得见的 prompt，不能只活在 ADR 里。ADR-0032 的教训正是「契约不写进 prompt，扩展没装上时就什么都没有了」。
3. **`{{goal}}` 要转义。** 把 `<` `>` 换成实体或等价物。风险不是恶意调用方，而是模型自己写出一段带 XML 样子的文本，意外破坏块边界（ticket #215 的裁决）。

### 不写进 goal 块的

- 不提「你看不到父会话」——那句话在 context 块里，重复会稀释。
- 不解释 goal 从哪来。
- 不说「请考虑」这类软化词。

---

## 4. 两臂共用的外层从句

`src/runtime/dispatch.ts:540` 的 `CHILD_REPORT_PROMPT_CLAUSE` 两臂不变：

````
Before you finish, hand the host a child report. Prefer calling the
`ptc_child_report` tool once with it. If that tool is not available to you, end
your reply with a fenced ```json block containing <SHAPE>. Either way your prose
answer is kept alongside the report and never replaced by it, and you must not
report usage or token counts — those are measured by the host.
````

唯一变化是 `<SHAPE>` 换成上面 A 或 B 的段落。

---

## 5. 需要 react 的点

1. **A 臂 `summary` 的措辞**会不会诱导子代理写建议而不是意义？（"what they should do with it" 可能太好用）
2. **B 臂两个字段够不够**？如果实测中子代理把 caveat 塞进 `conclusion`，说明需要第三个字段——但那是实测结论，不是现在加。
3. **goal 块的顺序**：context 先还是 goal 先？
4. **`{{goal}}` 为空时**：整个块省略，还是保留块但空着？建议省略（空块会被读成「有内容但没显示」）。
5. **goal 与 task 冲突的那句话**，放在 goal 块里还是报告契约里？现在两处都有暗示，可能重复。

---

## 6. 下一步

这些措辞要进 spec 时，需要同步改：

- `src/runtime/child-report.ts:132` `CHILD_REPORT_SHAPE`
- `src/runtime/dispatch.ts:540` `CHILD_REPORT_PROMPT_CLAUSE`（换 `<SHAPE>`）
- `src/runtime/dispatch.ts:588` `appendDepthHint` 的签名（加 `goal`）
- `src/tools/child-report-tool.ts` 的 description（它指向 prompt，不重复形状）
- `tests/unit/dispatch-child-report.test.ts:928-958`（钉住形状只有一个家）
