# PTC 程序强制严格模式：与上游 DSH 对齐

status: accepted (2026-10-21). Ticket #244（spec #234 的实现决定 12）。本篇是**新增**决定，不修订任何既有 ADR——理由与核对过程见 §"本篇不修订任何既有记录"。

## Context

上游 DSH 给每段程序加一个 `'use strict';` 前缀。取证的原文在
[DSH PTC core 调研笔记](../research/upstream-20260930/01-dsh-ptc-core.md) §1.1：

```
new AsyncFunction(...globals, ...errorClassNames, "console", "'use strict';\n" + data.code)(...)
```

笔记在那一行自己点了一句 "Note the `'use strict'` prefix"。也就是说：上游把「程序体」直接当作一个 async 函数体来物化，严格指令落在**函数体的第一句**。

而本仓的**对齐清单没有登记这一条**。那张清单是
[上游对齐审计](../research/ptc-upstream-parity-audit-20260930.md) 里的 A1–A12 表——A1 OS 沙箱、A2 三档文件策略、A3 人工审批、A3b 子代理恒定 `approval:'never'`、A4 生成的 TypeScript SDK 段、A5 绑定集、A6 并发分类、A7 可观测事件、A8 原型污染加固、A9 Python 后端、A10 `timeoutMs: null`、A11 agent 上限、A12 `console.inspect` 有界——**唯独没有一行问「程序跑在哪种模式」**。

所以这是一条**未登记的分叉**：不是有人决定过要分叉，是没有人记过它存在。spec #234 的问题陈述第 6 条把它点了出来，本篇是它的落点。

还有一条与「为什么是 TypeScript」有关：TypeScript 给模块默认发严格指令，编译选项长这样：

```json
{ "alwaysStrict": true }
```

程序是模型在运行时提交的 TypeScript，走 `stripTypeScriptTypes` 剥类型——**剥类型等于把作者预期的严格性一起剥掉了**。上游 DSH 也有同一个剥类型步骤（笔记 §1.1 的 `stripped.slice(35, stripped.length - 2)`），但它在剥完之后又补回了 `'use strict'`。我们没有。

## Decision

**1. 程序体以 `"use strict";` 开头。** 落点在 `src/runtime/worker-main.ts` 的 `compileProgram`：包住程序体的那个 async 包装函数，函数体的第一句是 `"use strict";`，然后才是模型写的代码。

```
async function __ptcProgram() {
"use strict";
<模型写的程序体>
}
```

指令在**体里面**而不是包在外面，这不是排版偏好：它让「程序自己写了 `"use strict";`」这件事保持合法——第二个严格指令是 no-op，不是重复指令报错。剥类型的回退路径（TypeScript 解析器拒绝的那段源码）用的是同一个包装，所以回退出来的程序一样是严格的。

**2. 没有 opt out。** JavaScript 没有 `"use sloppy"` 指令，所以「严格模式 + 一个开关」这个形状不存在。程序里想宽松，唯一办法是不写 PTC 程序。

**3. 程序自己写 `"use strict";` 仍然是合法的，而且什么也不改变。** 它不是一个「重复声明」的失败，而是一个 no-op——本篇的验收用例把「带自己指令的程序」与「不带指令的程序」在同一个 worker 里各跑一次，两次都必须严格。

**4. 判定落在编译期与运行期两处，两处都要响。** 编译期（重复参数、八进制字面量）走 `compileProgram` 抛错那条路，worker 报 `program failed to compile: …`；运行期（未声明的赋值）走程序抛错那条路，worker 报 `ReferenceError`。两处都不是静默失败。

## Evidence

以下全部是**实测**，不是推理。基线是本篇落地前的提交 `c923f78`，改后是同一台机器（Node v24）上的同一组程序，跑在同一个 worker 里。

| 程序                                                                | 宽松（改前）                                  | 严格（改后）                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `leakedGlobal = 42;` 之后查 `globalThis`                            | `own: true`、`globalThis.leakedGlobal === 42` | `ReferenceError: leakedGlobal is not defined`                                                 |
| `leakedGlobal = 42; return 1;`                                      | 成功，`result` 帧，值为 1                     | `ReferenceError: leakedGlobal is not defined`                                                 |
| `return { self: typeof this, isGlobalObject: this === globalThis }` | `{ self: "object", isGlobalObject: true }`    | `{ self: "undefined", isGlobalObject: false }`                                                |
| `const result = 1; results = result; return result;`（手滑）        | 成功，`result` 帧，值为 1                     | `ReferenceError: results is not defined`                                                      |
| `const result = 1; return results;`（读一个未声明的名字）           | `ReferenceError: results is not defined`      | 同前，**没有变化**                                                                            |
| `function f(a, a) { return a; } return f(1, 2);`                    | 编译通过，返回 2                              | 编译期失败：`program failed to compile: Duplicate parameter name not allowed in this context` |
| `return 010;`                                                       | 返回 8                                        | 编译期失败：`program failed to compile: Octal literals are not allowed in strict mode.`       |
| `"use strict"; return typeof this;`                                 | `"undefined"`（它自己声明的）                 | `"undefined"`（no-op）                                                                        |

两条「实测后果」要分开说，因为它们的成立程度不一样：

**（一）跨运行污染：机制是真的，可观察的泄漏今天已经不存在了。** 宽松模式下漏声明的变量**确实**建在 worker 的 realm 的 `globalThis` 上——上表第一行实测到 `own: true` 且 `globalThis.leakedGlobal === 42`，它是 `globalThis` 的自有可枚举属性。但**同一个 worker 里连跑两段程序，第二段看不到它**：ADR-0017 的 `startRun` 会调 `restoreWarmBaseline`，把 `globalThis` 上所有不在开机基线里的自有可枚举键删掉（第一段程序留下的隐式全局正好落在这一类里），所以第二段读到的是 `undefined`。

也就是说，spec 与 ticket 说的「隐式全局跨 run 残留」在**今天**不是一条可观察的缺陷，而是**一个真实存在的机制**。严格模式把这条机制从源头掐断：赋值不再成功，全局压根不会被创建。区别是「跑完再擦」变成「压根不发生」。

**（二）手滑静默成功：也是机制，成立的只有一半。** 今天的宽松模式下，**写**一个未声明的名字（`results = result`）是静默成功的，程序照常返回，全局被留下——上表第四行实测。而**读**一个未声明的名字（`return results`）今天就已经是 `ReferenceError` 了，宽松模式也一样响：ECMAScript 里「读一个解析不到的引用」在两种模式下都抛 `ReferenceError`，宽松模式放过的只有**写**。

所以 ticket 里「模型拿到 `undefined`、零错误信号」这句话在今天的实现上不成立：裸标识符读不到会响，`typeof` 一个未声明名字返回 `"undefined"`（两种模式都一样，严格模式也改不了），而属性名手滑（`result.results`）跟本篇无关。严格模式真正改掉的那一半是**写在左边的那个手滑**——它从「静默成功 + 留一个全局」变成响亮的 `ReferenceError`。

## Consequences

**破坏性变更**（随 CHANGELOG 的未发布段一起发布，由发布面那张票负责）：

1. **顶层 `this` 从全局对象变成 `undefined`。** 程序里 `this === globalThis` 今天为真，之后为假；`this.foo = 1` 今天写得到全局，之后写到 `undefined` 上会抛 `TypeError`。
2. **隐式全局变成 `ReferenceError`。** 程序里任何对未声明名字的**写**都不再成功。
3. **重复参数变成编译期 `SyntaxError`。** 程序里 `function f(a, a) {}` 今天能编译，之后编译不过。
4. **八进制字面量变成编译期 `SyntaxError`。** `010` 今天求值为 8，之后编译不过。

**不受影响的部分**（免得读这份记录的人以为更严了）：

- 运行时装的那些全局照常可读：`tools`、`ptcBindings`、`console`，以及 workflow 面上的 `log` / `phase` / `parallel` / `pipeline` / `args`。它们是 `globalThis` 上真实存在的属性，严格模式只对**解析不到的名字**发声。
- 读一个未声明的名字，两种模式都抛 `ReferenceError`（见 §Evidence 的第五行）。

**严格模式不解决原型污染。** 对齐清单的 A8 行是另一件事、仍然开着：上游在模块加载时捕获 Node intrinsics 全程使用，绑定命名空间用 `Object.create(null)`，`__proto__` 变成普通自有键；本仓这一行记的是「无」。严格模式与之无关——它管的是**名字能不能解析**，不是**对象被污染了怎么办**。A8 需要单独做。

**上游对齐清单要补一行。** 这条分叉修掉之后，A1–A12 表里仍然没有它；要让它在清单上可见，需要在审计那篇里补一行——那是调研快照，本篇不改它（快照记的是当时的调研结论，改它就把记录改成了结论）。

**本篇不修订任何既有记录。** 核对过三件事：（一）全仓 `docs/adr/**` 里没有一篇写过「PTC 程序跑在宽松模式」或「`new Function` 的 body 默认是 sloppy」，所以没有一条既有结论被本篇推翻；（二）ADR-0017 §10(d) 讲的是 warm worker 上的隔离（`startRun` 负责清场、`reset` 只清自己那一轮），本篇不动那条机制，只把「程序能留下什么」的范围收窄——它那句「whatever its program assigned」在严格模式下少了一项（隐式全局），但那句话本身没有被推翻，所以不构成修订；（三）spec #234 的「需要修订的 ADR」清单里列的是那两篇「deliberately no waiter queue」和表面值那两篇，都与本篇无关。因此本篇只新增，不改别人的正文。

## Alternatives considered

- **保留宽松模式，只加一条 lint 提示。** 否决：模型写的是代码，不是给人看的文本，lint 的意见不会到达它；而且上游已经这么做了，不对齐就是分叉。
- **做成可配置（`ptc.json` 里一个 `strict` 键）。** 否决：JavaScript 没有 `"use sloppy"`，要做出「宽松」这个选项，就得给程序另找一条物化路径（另开一个 realm、或把代码包进 `with`），那是另一套机制而不是一个开关；而且模型在两个模式之间猜规则，错的代价正好是本篇要消灭的那类静默失败。
- **只在 `run_code` 面严格、`workflow` 面宽松。** 否决：两个面跑的是同一种程序体，模型不需要知道这个区别；分面实施只会在某一个面上留下同样的洞。

## See also

- [ADR-0017](./0017-ptc-worker-pool-and-image-wire-shape.md) —— warm worker 的隔离模型。本篇实测的「跨运行污染今天已被挡住」就是它 §10(d) 的 `startRun` / `restoreWarmBaseline` 在起作用。
- [ADR-0005](./0005-ptc-execution-boundary.md) —— 执行边界（`worker_threads`）。本篇改的是这个边界里**程序怎么被编译**，不是边界本身。
- [ADR-0007](./0007-no-os-sandbox.md) —— 信任姿态。严格模式**不是**沙箱：它挡不住 `node:fs`，也挡不住原型污染（A8）。
- [上游对齐审计](../research/ptc-upstream-parity-audit-20260930.md) —— A1–A12 表；本篇是它没有登记的那一条，A8 是它记着、仍然开着的那一条。
- [DSH PTC core 调研笔记](../research/upstream-20260930/01-dsh-ptc-core.md) §1.1 —— 上游 `'use strict'` 前缀的原文出处。

## Reopen triggers

- **上游把严格前缀去掉**（或者 DSH 自己也改回宽松）——那这条对齐的方向要重估，理由仍然是「对齐上游」而不是「严格更好」。
- **有人要求一个宽松模式的逃生门**——那时该讨论的是「PTC 程序之外还有没有别的编程面」，而不是给严格模式加开关。
- **A8（原型污染加固）落地**——那是独立的一条；本篇不因它改，也不因它算作已做。
