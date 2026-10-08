# PTC Render Bounds (audit 3c)

适用文件:`src/tools/render.ts`、`src/tools/text.ts`、`src/tools/task-panel-render.ts`(这三个文件里**全部**渲染/截断上限常量都归本规则,不只是最初那四个)。

机器守卫:`tests/render-bounds-registry.test.ts` 把三个文件(render.ts / text.ts / task-panel-render.ts)里每个上限型常量与下面四张表(树形硬约束表 + 三张分模块登记表)逐一比对,漏登记即红。反向不要求——规则写得比常量更细不算缺陷。补登记时每个常量要在自己的表格行里与数值同行出现。

`.opencodereview/rule.json` 另有两个文件锚到本规则:`src/runtime/output-storage.ts` 与
`src/runtime/adr0015-truncation.ts`。**这两个是刻意锚的,不是锚点比规则宽的残留**:它们是 ADR-0015
截断契约的两个实现方(输出解引用与共享截断原语),而那个契约的 50 KB / 2000 lines 上限就是上面
硬约束表里的「文本块 tail-truncation」一行。两个文件**本地不声明任何上限常量**——它们 import pi 的
`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`(外部常量,本仓不声明),所以**没有需要登记的行**,
守卫也不扫它们。它们在本规则下的义务是「截断必须显式可见、不得静默」,不是「登记数值」。

(`src/tools/shimmer.ts` 曾被同样锚在这里,但它唯一的数值常量是重绘节拍
`DEFAULT_SHIMMER_INTERVAL_MS = 150`,与渲染上限无关,**该锚点已撤除**,现落 `**` 兜底。)

守卫的一个已知局限:它按「标识符 + 同一行的数值」匹配,**分不清同名同值的两个独立常量**。
`src/tools/task-panel-render.ts:87` 的 `MAX_ERROR_CHARS = 120` 与 `src/tools/render.ts:84` 的
`MAX_ERROR_CHARS = 120` 同名同值但是两个常量。task-panel 那一行仍然照实登记,只是别把它读成
"render.ts 那一行顺带覆盖了它"——守卫的绿在这里是巧合,不是证据。

## 硬约束(README 'TUI rendering' + ADR-0015)

树形 completion value 的上限(render.ts 的 export 常量):

| 维度                   | 上限                | 常量                                                                 | 来源     |
| ---------------------- | ------------------- | -------------------------------------------------------------------- | -------- |
| 树深度                 | 4                   | `TREE_VALUE_MAX_DEPTH`                                               | README   |
| 容器子节点数           | 6                   | `TREE_VALUE_MAX_CHILDREN`                                            | README   |
| 单行字符数             | 120                 | `TREE_VALUE_MAX_LINE_CHARS`                                          | README   |
| 文本块 tail-truncation | 50 KiB / 2000 lines | pi 的 `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`(外部常量,本仓不声明) | ADR-0015 |

### render.ts 的折叠/展开分块上限

README 只写到「each block labelled and capped」,没给数值;下面这八个的**纪律**有出处(ADR-0013 §3),**数值**由 ADR-0013 §6 登记。

| 常量                        | 值  | 作用                                                            | 来源        |
| --------------------------- | --- | --------------------------------------------------------------- | ----------- |
| `MAX_RESULT_HINT_CHARS`     | 60  | 摘要行 `→ …` 上 hint 的字符上限                                 | ADR-0013 §6 |
| `MAX_ERROR_CHARS`           | 120 | 失败行错误文本的字符上限                                        | ADR-0013 §6 |
| `MAX_CODE_LINE_CHARS`       | 120 | 展开态 code 块每一行的字符上限                                  | ADR-0013 §6 |
| `MAX_CODE_LINES_EXPANDED`   | 3   | 展开态 code 块显示的行数上限                                    | ADR-0013 §6 |
| `MAX_LOG_LINES_EXPANDED`    | 12  | 展开态 out / log 块,以及失败态错误文本的行数上限                | ADR-0013 §6 |
| `MAX_PHASES_EXPANDED`       | 8   | 展开态 phases 折叠行的条数上限                                  | ADR-0013 §6 |
| `MAX_WARNINGS_EXPANDED`     | 4   | 展开态 warn(plan-drift) 的条数上限                              | ADR-0013 §6 |
| `MAX_SUBCALL_PREVIEW_CHARS` | 40  | sub-call 树里实参预览的字符上限(唯一允许 JSON.stringify 的地方) | ADR-0013 §6 |

「未挂账的既有事实」的意思:纪律有出处(ADR-0013 §3「expanded 永不是 unbounded」、§5 第 4 条「树与分块同属一条连接符链」),**数值本身没有出处**。这是「来源」列的一列取值,标记的正是本规则最该防的那类行——登记表登了、ADR 没挂账;ADR-0013 §6(render.ts 八个)与 ADR-0022 §11(task-panel 五个)落地之后,下面几张登记表里已经没有任何一行用它了。仍要盯住的是另一类缺口:开头那段更宽的锚点(output-storage / adr0015-truncation / shimmer),那三个文件不是数值缺出处,是整行都还没有。

render.ts 的那八个已闭环:ADR-0013 §6 补上了数值表,并在同节显式写明「这些数值由 TUI 可读性选定,没有独立来源(不是从任何规范、第三方文档或 pi 的默认值推导来的)」,登记为契约冻结值——改动任何一个都属于行为变更,需要新的 ADR,不是在实现里改个数字。注意 §6 与 §5 的树形三个数(4 / 6 / 120)互不联动,别并成一张表。

改动前先确认该数值是否已被 tests/render*.test.ts 钉住(钉住的是防回归,不是防错误,别拿测试当来源)。

### text.ts 的行宽与 inline 判定

作用在 model-facing 文本块(`renderModelValue` 的返回值)上,与上面那个 120 **是两套独立契约**,不要并成一行。

| 常量               | 值  | 作用                                                                      | 来源        |
| ------------------ | --- | ------------------------------------------------------------------------- | ----------- |
| `MAX_LINE_CHARS`   | 200 | 每一行渲染后超过该长度就按 `…` 截断(text.ts `capLines`:切到 199 再补 `…`) | ADR-0012:34 |
| `INLINE_MAX_CHARS` | 100 | 值能否留在单行(inline 形态)的判定,超了就退化成缩进块(text.ts `tryInline`) | ADR-0012:32 |

三者的区别,改之前先分清:

- `TREE_VALUE_MAX_LINE_CHARS = 120` 管 TUI 树行的显示宽度(按 `visibleWidth` 对齐窄列),服务人眼;来源是 README。
- `MAX_LINE_CHARS = 200` 与 `INLINE_MAX_CHARS = 100` 管送给模型的文本块,服务模型可读性;来源是 ADR-0012,**不是** ADR-0015——ADR-0015 管的是文本块尾截断(50 KB / 2000 lines),那是另一个轴。
- 三个数字互不联动:把 200 调到 120 属于行为变更,需要 ADR,不是在表格里改个数字。

### render.ts 的 child report 渲染上限(ADR-0032)

`renderChildReportText` 把 child report 画成模型读的文本块,与上面几张表是**另一条轴**:它不
服务 PTC 行的人眼可读性,服务 subagent surface 上没有 `codemode` 时的唯一读者(ADR-0025 +
ADR-0028)。连接符 / `Array(n)` / 标签槽沿用 value tree 的形状,行宽沿用 `MAX_LINE_CHARS`。

| 常量                              | 值  | 作用                                                                    | 来源                |
| --------------------------------- | --- | ----------------------------------------------------------------------- | ------------------- |
| `CHILD_REPORT_MAX_FINDINGS`       | 20  | 模型可见的 child report 渲染的 findings 条数上限,超出部分计数后按行注明 | ADR-0032 §Rendering |
| `CHILD_REPORT_MAX_FILES`          | 20  | 同一块里 `files_touched` 的条数上限,同样在行内注明被扣留的条数          | ADR-0032 §Rendering |
| `CHILD_REPORT_MAX_EVIDENCE_CHARS` | 150 | 单条 finding 的 evidence 字符上限,截断时在该行注明被截断                | ADR-0032 §Rendering |

`CHILD_REPORT_MAX_EVIDENCE_CHARS = 150` 不是自由取值:它由 `MAX_LINE_CHARS = 200` 反推——
3 列连接符 + 5 列 finding 下标缩进 + `evidence: ` + 截断提示本身,留出空间让**提示不被同一行的行宽
截断**。调大它会让「此处被截断」这句话自己被截掉,那正是这条约束要挡的失败。算式是
3 + 5 + 10 + 150 + 2 + 25 = 195 ≤ 200。

### task-panel-render.ts 的面板渲染上限

| 常量                       | 值  | 作用                                                                | 来源         |
| -------------------------- | --- | ------------------------------------------------------------------- | ------------ |
| `MAX_LABEL_CHARS`          | 48  | 任务 label 的字符上限(任意文本,须先 sanitize)                       | ADR-0022 §11 |
| `MAX_ERROR_CHARS`          | 120 | 失败行错误文本的字符上限(**与 render.ts 那个同名同值但是两个常量**) | ADR-0022 §11 |
| `MAX_OUTPUT_LINE_CHARS`    | 160 | 预览区单行的字符上限                                                | ADR-0022 §11 |
| `MAX_OUTPUT_PREVIEW_LINES` | 6   | 预览区显示的行数上限                                                | ADR-0022 §11 |
| `MAX_TASK_PANEL_ROWS`      | 32  | 面板同时可见的任务行数上限                                          | ADR-0022 §11 |

`MAX_TASK_PANEL_ROWS` 的源码注释(`task-panel-render.ts:93` 附近)已经写明它是
`MAX_SUBCALLS` 的类比、**不是** README 那条「6 children per container」——
即它是一处显式的、有理由的偏离,不要拿树形上限去套它。

本文件里的 `AGE_TICK_MS = 1000` 是重绘节拍,不是渲染上限,按守卫口径(名字含 `MAX`)天然排除,
刻意不登记。

## 必查

1. cap 常量集中:上限必须是命名常量(树形三个是 `TREE_VALUE_MAX_DEPTH` / `TREE_VALUE_MAX_CHILDREN` /
   `TREE_VALUE_MAX_LINE_CHARS`;分块与文本块的在上面几张登记表里逐个列出),不是 magic number 散落在
   render 函数里。改上限时所有引用点必须联动。**新增上限必须同时登记进本文件的表格**——
   `tests/render-bounds-registry.test.ts` 会因为漏登记变红,这是本规则唯一的机器防线。
   反向不要求:规则写得比常量更细不算缺陷。

2. 截断后元信息:文本块超过 50 KiB / 2000 lines 时必须显式标 truncated(参考 ADR-0015),
   不可静默丢弃。

3. 截断保留符号:容器被截断时必须出保留符号(形如 '...+N more keys' 或尾部省略号),
   用户能看出还有更多。写死的字面量要保持单一来源。

4. 连接符正确:├─ / └─ / │ / space 四种字符用于区分 nesting vs continuation,
   不要混用 ASCII fallback(+-- / |)。

5. 不做 JSON.stringify:返回值渲染走 renderModelValue,禁止对 completion value 走 JSON.stringify。
   那会让 report 退化成换行符噪声(ADR-0013)。

## 阻塞触发

- 改了 cap 但忘了改常量 / 没引入常量 → 建议级(找出所有点)。
- 截断后无 truncated 标记 / 截断静默 → PR 阻塞(违反 ADR-0015 契约)。

## 严重性升级(Q9-D)

不升级 — render bounds 是 visual contract,OCR 视觉 review 够用,不必 delegate。
