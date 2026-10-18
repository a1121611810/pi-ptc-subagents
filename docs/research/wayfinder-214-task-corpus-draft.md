# 实验任务样本集草稿（wayfinder #214）

状态：**草稿**，供 [ticket #214](https://github.com/a1121611810/pi-ptc-subagents/issues/214) react。
样本的**规格**在这里；fixture 代码是 spec 之后的事。

---

## 0. 一条硬规则：真值必须机械可判

每个样本都必须自带一个**确定性检查**。做不到这一点的任务不进样本集——它会退回人工评审，而人工评审会毁掉 R1。

| 类型              | 真值形态         | 检查方式                                             |
| ----------------- | ---------------- | ---------------------------------------------------- |
| **T1 调查问答**   | 可核对的字面量   | 最终答案包含预期字面量（归一化空白 + 大小写不敏感）  |
| **T2 执行改文件** | 一个测试从红转绿 | 跑 fixture 自带的测试命令，退出码 0                  |
| **T3 裁决验证**   | 预先植入的缺陷   | 答案包含预期文件路径 **且** 包含缺陷机制的关键词之一 |

---

## 1. T1 调查问答（6 个，真值已在本仓库核实）

| #    | 问题                                             | 预期字面量                                                            | 核实位置                             |
| ---- | ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------ |
| T1-1 | 哪个类守护 dispatch 并发？哪两个方法获取/释放？  | `DispatchSlotCounter`、`tryAcquire`、`release`                        | `src/runtime/dispatch.ts:88,115,127` |
| T1-2 | read-only strict 工具集是什么？                  | `read`、`grep`、`find`、`ls`                                          | `src/runtime/dispatch.ts:288`        |
| T1-3 | 声明的 pi peer 下限是多少？                      | `>=0.86.0`                                                            | `package.json` peerDependencies      |
| T1-4 | 哪个模块拥有 child report 的形状？字段有哪几个？ | `src/runtime/child-report.ts`、`summary`、`findings`、`files_touched` | `src/runtime/child-report.ts:132`    |
| T1-5 | 有几处调用 `appendDepthHint`？分别在哪个文件？   | `2` 处、`src/runtime/dispatch.ts`                                     | `:2100`、`:2466`                     |
| T1-6 | 后台子进程通过哪个环境变量拿到 task id？         | `PI_PTC_TASK_ID`                                                      | `src/runtime/dispatch.ts:2115`       |

**为什么不用行号做真值**：行号会漂移，样本会静默失效。T1-5 只要求「2 处 + 文件名」，不要求行号。

---

## 2. T2 执行改文件（6 个，每个自带失败测试）

每个 fixture 是一个独立目录，含 `task.md`（给父级的任务描述）、一个被测模块、一个当前失败的测试。

| #    | 缺陷                                             | 通过判据                                |
| ---- | ------------------------------------------------ | --------------------------------------- |
| T2-1 | `slice(0, n - 1)` 差一                           | 测试断言长度等于 n                      |
| T2-2 | 异步函数漏 `await`，调用方拿到 Promise           | 测试断言拿到的不是 Promise              |
| T2-3 | 正则写成 `^(A\|B)$`，两条路都能过（F1 形状）     | 测试断言错误输入被拒                    |
| T2-4 | 模块级可变默认值，两次调用互相污染               | 连续两次调用结果独立                    |
| T2-5 | 超时定时器在 `await` 之后才设置，等于没有超时    | 测试注入慢依赖，断言在限定时间内 reject |
| T2-6 | JSON 往返丢掉 `undefined` 键，读取方以为键不存在 | 测试断言往返后键集合相等                |

**T2-3 特别说明**：它同时是 `docs/testing-constraints.md` 里 F1 的一个活样本。如果父级修成 `^(A)$` 而不是 `^(A|B)$` 的严格版，测试会红——真值能区分。

---

## 3. T3 裁决验证（6 个，预埋缺陷）

fixture 含一个**有缺陷但能跑**的模块 + 一段描述现象的文字。任务不是修，是**指出缺陷**。

| #    | 预埋缺陷                      | 预期答案                                           |
| ---- | ----------------------------- | -------------------------------------------------- |
| T3-1 | 计数器在错误路径上只增不减    | 文件路径 + `decrement` / `finally` / `error path`  |
| T3-2 | 重试路径上重复获取锁          | 文件路径 + `double acquire` / `retry` / `deadlock` |
| T3-3 | 缓存键漏了一个参数            | 文件路径 + 参数名 / `cache key`                    |
| T3-4 | 清理路径里未 await 的 Promise | 文件路径 + `await` / `cleanup`                     |
| T3-5 | 分支吞掉错误，没有 warn       | 文件路径 + `swallow` / `silent` / `catch`          |
| T3-6 | 边界判断用 `<` 而不是 `<=`    | 文件路径 + `off-by-one` / `boundary` / `<=`        |

**预期答案是「路径 + 关键词之一」，不是精确句子**——否则会退化成措辞匹配。

---

## 3b. T4 意图敏感任务（goal 实验专用，至少 6 个）

T4 是 ticket #217 新增的。它存在的唯一理由：**任务必须歧义，否则 goal 实验测的是零。**

每个样本四段：

| 字段           | 内容                                     |
| -------------- | ---------------------------------------- |
| `task`         | 故意欠明确的任务文本                     |
| `goal`         | 消歧的那段意图                           |
| `placebo_goal` | 长度相近（±20%）、看着合理、但**不消歧** |
| `expect`       | 只有正确消歧才能通过的检查               |

示例：

```
task:          "Check whether the retry path is safe."
goal:          "We're preparing a release and a previous child ruled out the obvious
                explanation. Check whether concurrent retries can double-charge."
placebo_goal:  "We're preparing a release and want a second opinion on this module
                before we ship."
```

候选样本（待核）：

| #    | 歧义点                     | goal 消歧方向        |
| ---- | -------------------------- | -------------------- |
| T4-1 | 重试路径「安全」指什么     | 并发重试导致重复扣费 |
| T4-2 | 配置加载「有问题」指什么   | 环境变量优先级       |
| T4-3 | 新工具「审查一下」审查什么 | 是否泄露父级 cwd     |
| T4-4 | 缓存「不一致」指什么       | 多实例之间           |
| T4-5 | 日志「太多」指什么         | 单次运行的字节数     |
| T4-6 | 测试「不稳定」指什么       | 顺序依赖而非随机失败 |

**安慰剂必须机械校验**：不含任消歧关键词，长度在 ±20% 内。否则 G1 ≈ G2 会被误读成「goal 没用」，而实际是安慰剂把答案说了。

---

## 4. 缺陷放在哪：不污染主分支

```
docs/research/wayfinder-214-tasks/
├── manifest.json
├── t1/
│   └── t1-1.json … t1-6.json
├── t2/
│   └── t2-1/ … t2-6/    每个含 src/ + test/
└── t3/
    └── t3-1/ … t3-6/    每个含 src/ + EXPECTED.md
```

三条规则：

1. **T2 / T3 的 fixture 只在这里，不在 `src/`。** 主分支的 `src/` 一个字符都不动。
2. **每次运行复制到临时目录**，不在原地跑。并行运行会互相覆盖，而且失败会把 fixture 弄脏。
3. **`manifest.json` 是唯一入口**，记录每个样本的类型、真值、难度分层。任务顺序由它决定，不由目录遍历顺序决定。

---

## 5. 难度控制：用实测，不用主观标签

主观标注「简单/中等/困难」在这个仓库里没有可信度——写标签的人和评估的人都会漂移。

**做法**：

1. **试点**：用默认臂（A）跑每个样本 **n=10**。
2. 得到每个样本的基线通过率。
3. **剔除无区分度的样本**：通过率 ≥ 0.9 或 ≤ 0.1 的样本不进样本集——它们对 A/B 没有信息量，只会稀释效应。
4. 按基线通过率分三层（低 / 中 / 高），**每个 cell 的三层样本数相等**。

这一步必须在 A/B 正式跑之前完成，且结果写进预注册。否则「任务太难」会被误读成「B 臂更差」。

---

## 6. manifest 形状

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "t1-1",
      "type": "T1",
      "prompt": "Which class guards dispatch concurrency, and which two methods acquire and release it?",
      "expect": { "all": ["DispatchSlotCounter", "tryAcquire", "release"] },
      "tier": null
    },
    {
      "id": "t2-3",
      "type": "T2",
      "prompt": "The test in fixture/t2-3 fails. Make it pass without weakening the assertion.",
      "expect": { "command": "node --test fixture/t2-3/test/*.test.mjs" },
      "tier": null
    },
    {
      "id": "t3-2",
      "type": "T3",
      "prompt": "This module deadlocks under retry. Identify the defect.",
      "expect": { "path": "src/lock.mjs", "any": ["double acquire", "retry", "deadlock"] },
      "tier": null
    }
  ]
}
```

`tier` 在试点之后填入，试点之前为 `null`。

---

## 7. 需要 react 的点

1. **T1 的 6 个问题够不够区分**？它们都是「在本仓库里找事实」，难度可能过于接近。
2. **T2 的 6 个 fixture 要写多少代码**？如果每个超过 50 行，维护成本会超过收益。
3. **T3 的关键词匹配会不会太宽松**？`"<=` 这种关键词可能被无关上下文命中。
4. **试点剔除规则**（≥0.9 或 ≤0.1）是不是太激进？会剔掉多少样本还不确定。
5. **样本集是否要随 pi 版本变化**？0.86.x 没有 codemode，某些任务可能不可做——建议**不**变，用同一套样本跨版本比较，这样版本差异才不会被样本差异污染。

---

## 8. 不在本票范围内

- 实际写 fixture 代码（spec 之后）
- 试点跑（需要 E1 的 harness 先就位）
- R1 的检查器实现
