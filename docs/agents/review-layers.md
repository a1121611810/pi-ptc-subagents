# 评审装置的三层(review layers)

本文件是**三层归属表、不交错规则、三个不变量、路由判据与业界依据的唯一实体**。
`.agents/skills/code-review/SKILL.md` 与 [`docs/agents/ocr-rules.md`](./ocr-rules.md) 各留一条指针 + 最短触发语,
**不复制那张表** —— 一份事实一处家,复制出来的第二份会漂(本仓已经因为手抄清单漏掉过一整条规则)。

## 目标形态

评审装置 = 三层,每层一个载体。**层与层之间不交错:一个关注点只有一层有权说「这里有问题」,别的层可以提供证据,
但不得重复下结论、重复报、重复升级。**

| 层     | 载体                                        | 接口                                                          | 归属（这层拥有的关注点）             | 不归它管                                   |
| ------ | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| 事实层 | CodeGraph 符号图                            | `codegraph explore` / `codegraph callers`（SKILL.md 第 5 步） | 谁调用了它、影响半径（blast radius） | 不下「有没有测试」这类结论；不判对错       |
| 判断层 | OCR delegate + `.opencodereview/rules/*.md` | rule.json 锚点 → per-file checklist（第 4 步）                | 这样写对不对、意图对不对、口径对不对 | 不重复报机械层已强制的项；不替事实层下结论 |
| 机械层 | `tests/**` 确定性测试 + 发布门禁            | 规则文件里的 `[机械: X]` 声明 + fixture                       | 能写成脚本的                         | 不做意图判断                               |

今天**只有判断层有接口**(rule.json 锚点 + per-file checklist)。事实层与机械层原本只有散文在缝 ——
本票(#254)给另外两层补上接口,并加一条路由判据(见下)。

## 不交错规则与三个不变量

**规则**:一个关注点只有一层有权说「这里有问题」。别的层可以提供证据,但不得重复下结论、重复报、重复升级。

判完之后的三个不变量:

1. **已被机械层守卫的项,判断层不报、不升级。**
2. **事实层给证据,判断层不替它下事实结论。**
3. **一条关注点只有一个层有权说「这里有问题」。**

## 路由判据:新增一条必查项时先判层,判完只留一条

新增一条必查项时,**判它属于哪一层,判完只留一条**。

> 三问是**判定程序**,不是三个可以同时命中的筛子 —— 写成「顺序清单」会让一条同时落进几层,那正是交错本身。
> 第 1 问成立就归机械层,第 2 问成立就归事实层,都不成立才归判断层。一条必查项只留在它所属的那一层。

1. **能被写成确定性脚本吗?** 能 ⇒ **机械层**。写成 CI 守卫;规则文件里只留 `[机械: X]` 指针,判断层**不**再把它写进逐条检查。
2. 不能 ⇒ **它要回答的是「谁调用了它 / 影响半径」吗?** 是 ⇒ **事实层**。规则文件里写清「结论看 CodeGraph,不在 diff 里找」。
3. 都不是 ⇒ **判断层**。OCR 逐条检查。

### 反例(本仓已有、今天放错层)

3a 必查项 1 —— 「grep 字面量 `'connect'` / `'init'` / `'call-result'` / …」。形状上属机械层(能写成脚本),
今天每轮靠人或 sub-agent 手工 grep。判据样本就是它。

## 业界依据

三个原型 + 一条负结果。**负结果同样是指引**:知道哪条规则业界没有,比多抄一条有用。

| 原型                         | 归属事实放哪                                                                                                      | 判断层怎么处理已机械覆盖的项                                                              | 陈旧声明谁抓                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **ESLint**                   | 紧挨着被管的东西(源码行内 `eslint-disable` 注释)                                                                  | **不删**规则/行;声明让工具**压掉报告**                                                    | ESLint 自己(`reportUnusedDisableDirectives`,默认 `warn`) |
| **CodeRabbit**               | 工具集成层的**硬编码清单**(ESLint 工具页的 "Ignored rules":camelcase / comma-dangle / indent / no-var / quotes …) | 另一条路径过滤掉这些 rule ID 的 finding                                                   | 无人管 —— 清单漂了就漂了                                 |
| **CodeRabbit（规则迁移侧）** | **逐条规则的归属映射表**是唯一事实源,两边 config 都从它生成                                                       | 迁走的规则从旧 linter 里删掉(实测案例:ESLint→oxlint hybrid,649 → 224 enabled / 425 moved) | directive-hygiene 插件抓迁移后残留的 `eslint-disable`    |

**CodeRabbit 自己的两句话**,决定了「写在规则文件里的标记本身不会关掉任何东西」:

> _"Path instructions only affect CodeRabbit's review guidance for matching files. They do not disable other features that inspect the same code."_
>
> _"Path instructions work best as a targeted supplement, not a replacement."_

⇒ 标记写在规则文件里不会自动生效:**必须有东西读它**(本仓对应的是 checklist 构建那一步:带 `[机械: X]`
标记的条目不进入交给 OCR 的清单)。

### oxlint / oxfmt 的形态

| 工具               | 归属怎么做                                                                                                                                    | 陈旧声明                                                                                    | 实测结果                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **oxlint**         | 行内豁免注释(`// oxlint-disable-next-line <rule>` / `oxlint-disable-line` / `oxlint-disable` / `oxlint-enable`),并兼容 `eslint-disable*` 形式 | `oxlint --report-unused-disable-directives`(配置项 `options.reportUnusedDisableDirectives`) | 两种注释形式都生效;开了该选项后,无诊断的声明被报 `Unused oxlint-disable directive (no problems were reported)`(warning)                                                            |
| **oxfmt**          | 整个接管「格式」,没有 rule 粒度;行内豁免 `// oxfmt-ignore` 与 `// prettier-ignore` **都认**                                                   | —                                                                                           | 被忽略的块保持原样,其余被格式化                                                                                                                                                    |
| **oxlint ↔ oxfmt** | 靠**类别默认**分层:oxlint 官方 "Correctness-focused defaults" —— 默认只查 correctness,style/formatting 归 formatter                           | —                                                                                           | **本仓实测**:`.oxlintrc.json` 只开 `correctness: "error"` ⇒ 探针里的 `var a = 1` / `a == 1` / `console.log` **一条不报**;开 `style` 才报 `id-length` / `no-magic-numbers`(warning) |

三条可直接照抄的:

1. **声明只声明归属,不承载配置** —— oxlint 官方限制原文:_"Ignore comments can enable or disable rules, but they cannot change rule options. **Rule options belong in configuration files.**"_
   我们的 `[机械: X]` 同理:只说「这条归哪层」,不承载第二个事实。
2. **陈旧检查默认是关的 —— 抄形态就要显式打开。** oxlint 的 `reportUnusedDisableDirectives` **默认 off**
   (ESLint 的同名项默认 `warn`)。**本仓现在没开**(`.oxlintrc.json` 无此键)⇒ 本仓今天没有任何 lint 陈旧声明的守卫。
   教训:**光有机制不算有,必须显式打开。** 我们的 fixture 同理 —— 它必须在门禁里默认生效,否则等于没有。
3. **更省事的两种形态,我们套不上,但要写明为什么排除**:
   - **类别默认**(oxlint 的 correctness 默认 / oxfmt 整块接管):零维护,但我们的必查项是散文,粒度对不上「类别」⇒ 套不上。
   - **工具清单派生另一边**(oxlint 官方迁移方案 `eslint-plugin-oxlint`:oxlint 拥有规则表,ESLint 那边的重叠规则由
     plugin 自动关掉,官方原话 "This reduces duplicate diagnostics"):零人工维护,但前提是**两边的规则清单都在机器可读处**。
     我们的规则文件是散文 ⇒ 这正是 checklist 构建要补的缺口:**归属事实要有一份机器可读的表,由它生成分流结果。**

### Google 那边查不到这条

**canonical 的 eng-practices 两页(`reviewer/looking-for.html`、`reviewer/standard.html`)实读后没有
「reviewer 不重复报工具已抓的」这条规则 —— 别拿 Google 背书。**

Google 的原话是 "Technical facts and data overrule opinions and personal preferences"(`standard.html`),
以及 reviewer 要判断测试本身("Will the tests actually fail when the code is broken?",`looking-for.html`)——
是另一条主张。

## 本仓今天的三处违反(立项时的快照,2026-10-22)

层与层不交错不是抽象原则,它是仓库里当时就在发生的三件事。这三条会随后续票变化,读到时以代码为准。

1. **F1–F4 被报两次。** 机械层已经强制(`tests/test-meta-discipline.test.ts` 在 CI 门禁里跑),但判断层的
   `.opencodereview/rules/test-discipline.md` 仍把 F1/F2/F3 列为逐条检查的**阻塞 finding**,Q9-D 一节还写
   「任何 F1/F2/F3/F4 命中 → delegate 复核」。**归属**:F1–F4 属机械层;判断层引用 fixture 结果即可,自己不下 finding、不升级。
2. **3c 的登记项被查两遍。** `ptc-render-bounds.md` 的机械守卫已把常量登记做成「漏登记即红」,但同一规则的必查项
   仍逐条要求复查登记。**归属**:登记属机械层;「截断必须显式可见、不得静默」属判断层 —— 同一条规则文件里两种归属要分开。
3. **事实层越界下了结论。** CodeGraph 的 "no tests found within 3 caller hops" 是**图上事实**,被读成「无测试」这个
   **结论**。子进程式测试(复制脚本再 spawn,不 import 被测符号)在图上必然没有调用边。
   **归属**:「没有直接调用边」属事实层能说的;「有没有测试」属机械层(去数、去跑)。

第 3 条的判读纪律已经写进
[SKILL.md 的 `### Audit 1 · 调用点完备性(blast radius)`](../../.agents/skills/code-review/SKILL.md);
Q9-D 升级事实的机器侧副本在
[`rule.json`](../../.opencodereview/rule.json) 的顶层 `q9d` map(读它的不是 OCR,是 skill 编排端与对齐 fixture)。
