# 评审装置的三层(review layers)

本文件是**三层归属表、不交错规则、三个不变量与业界依据的唯一实体**。
**判层三问(判定程序)的唯一实体在 [`docs/agents/ocr-rules.md`](./ocr-rules.md) §7.5** —— 写规则的地方就是判层的地方,
三问跟着规则作者手册走,本文件只留指针(一份事实一处家)。
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

本票(#254)**落地前只有判断层有接口**(rule.json 锚点 + per-file checklist)。事实层与机械层原本只有散文在缝 ——
本票给另外两层补上接口,并加一条路由判据(见下)。

**标记的形状**:`[机械: X]` / `[待补守卫: <理由>]` / `[判断层: <理由>]`。一条必查项可以由**多个**守卫共同覆盖
(它的子命题住在不同的守卫里),那时把几个都列上:`[机械: a.test.ts, b.test.ts]` —— 只列第一个的标记是**半真的话**,
而半真的话正是这套装置要防的东西。`[待补守卫: …]` 的语义是「**属机械层、但守卫缺席或不完整**」——
守卫缺席的那部分没人看,所以它标的是**缺口**,不是「交给判断层去查」;守卫**在场但不完整**时,它只覆盖了这项的
一部分子命题,剩下的那部分同样没人看,同样要写成 `[待补守卫: <已有守卫覆盖到哪一部分、哪一部分没有守卫>]`。
两种缺口都归机械层,判断层都不报 —— 报不报由归属决定,不由有没有守卫决定。

## 归属标记怎么变成清单:checklist 构建这一步

标记写在规则文件里**不会自己关掉任何东西**(见下文 CodeRabbit 那两句话)。**必须有东西读它**:
`scripts/build-review-checklist.mjs` 读 `ocr delegate rule --format json` 的输出,把带 `[机械: X]` /
`[待补守卫: …]` 标记的必查项**整条**从交给评审的清单里拿掉,把带 `[判断层: …]` 的留下;
被拿掉的那些连同它们的守卫写进 **交接清单**(脚本的 stderr),交 host agent 写进报告 —— 拿掉而不交接 = 静默丢弃。

用法(命令的完整说明在脚本自己的文件头,本文件只留指针):

```bash
ocr delegate rule --format json <paths> | node scripts/build-review-checklist.mjs > checklist.json
```

守卫:`tests/review-layer-checklist.test.ts` 跑真脚本,并对交接清单与「机械项不在清单里」两条断言。

## 不交错规则与三个不变量

**规则**:一个关注点只有一层有权说「这里有问题」。别的层可以提供证据,但不得重复下结论、重复报、重复升级。

判完之后的三个不变量:

1. **已被机械层守卫的项,判断层不报、不升级。**
2. **事实层给证据,判断层不替它下事实结论。**
3. **一条关注点只有一个层有权说「这里有问题」。**

## 路由判据:新增一条必查项时先判层,判完只留一条

新增一条必查项时,**判它属于哪一层,判完只留一条**。

**三问(判定程序)的唯一实体在 [`docs/agents/ocr-rules.md`](./ocr-rules.md) §7.5** —— 判层是写规则的前置步骤,
写规则的地方就是判层的地方,三问跟着规则作者手册走;本文件不复制那三问(复制出来的第二份会漂,理由见本文开头)。
本文件负责的是判完之后的那张表、不交错规则与三个不变量。

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

⇒ 标记写在规则文件里不会自动生效:**必须有东西读它**。本仓对应的那件东西是
`scripts/build-review-checklist.mjs`:带 `[机械: X]` / `[待补守卫: …]` 标记的条目不进入交给评审的清单,
被拿掉的那些连同守卫写进交接清单(见上面「归属标记怎么变成清单」)。

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

## 立项时的三处违反(快照,2026-10-22;每条后面是它今天的状态)

层与层不交错不是抽象原则,它是仓库里立项时就在发生的三件事。**这一节是快照,不是现状** ——
每条后面标了状态:哪些已被本票解决,哪些还在。读到时以状态为准,不要把标题读成「今天仍然如此」。

1. **F1–F4 被报两次。** 机械层已经强制(`tests/test-meta-discipline.test.ts` 在 CI 门禁里跑),但判断层的
   `.opencodereview/rules/test-discipline.md` 仍把 F1/F2/F3 列为逐条检查的**阻塞 finding**,Q9-D 一节还写
   「任何 F1/F2/F3/F4 命中 → delegate 复核」。**归属**:F1–F4 属机械层;判断层引用 fixture 结果即可,自己不下 finding、不升级。
   **状态:仍在。** 本票的 Out of scope 明确「不重写 F1–F4 与 3c 登记项的规则正文(只做归属声明,让交错暴露出来)」,
   所以重复登记的**规则正文**仍在;归属声明加在 `test-discipline.md` 的 `## 必查` 表格的「归属」列里
   (反事实改错还红 = `[待补守卫: …]`、conditional assertion = `[机械: tests/test-meta-discipline.test.ts]`)。
   **但那两节(`## 阻塞 finding` 与 `## 严重性升级(Q9-D)`)本身不是带标记的必查项**,
   所以 checklist 构建那一步**不会**把它们从清单里拿掉 —— 判断层读到它们仍会照着报。这就是它仍在的原因。
   这条登记在下面的「剩下的缺口」里。
2. **3c 的登记项被查两遍。** `ptc-render-bounds.md` 的机械守卫已把常量登记做成「漏登记即红」,但同一规则的必查项
   仍逐条要求复查登记。**归属**:登记属机械层(`tests/render-bounds-registry.test.ts`)。
   ⚠️ **立项时对「截断必须显式可见、不得静默」的归属判断被实测推翻**:原判给判断层,实测
   `tests/unit/adr0015-truncation.test.ts` 已经断言 `truncated === true` + `[Showing …]` 字面量
   (覆盖 ADR-0015 的两个调用点;第三处截断点不被覆盖)⇒ 它也属机械层。**3c 的五条必查项今天全部是机械层。**
   **状态:已解决。** 五条必查项全部标成机械层,判断层不再逐条复查登记;第 5 条的守卫在本票里被实测改正
   (原先标的 `tests/text.test.ts` 不覆盖那个调用点,现为 `tests/run-code-tool.test.ts`、
   `tests/workflow-tool.test.ts`、`tests/binding-policy.test.ts`)。
3. **事实层越界下了结论。** CodeGraph 的 "no tests found within 3 caller hops" 是**图上事实**,被读成「无测试」这个
   **结论**。子进程式测试(复制脚本再 spawn,不 import 被测符号)在图上必然没有调用边。
   **归属**:「没有直接调用边」属事实层能说的;「有没有测试」属机械层(去数、去跑)。
   **状态:已解决(以纪律形式)。** 判读纪律写进了
   [SKILL.md 的 `### Audit 1 · 调用点完备性(blast radius)`](../../.agents/skills/code-review/SKILL.md);
   它是纪律,不是守卫 —— 靠人读那句「不能读作『无测试』」。

Q9-D 升级事实的机器侧副本在
[`rule.json`](../../.opencodereview/rule.json) 的顶层 `q9d` map(读它的不是 OCR,是 skill 编排端与对齐 fixture)。

## 这套装置自己看不见的东西(写下来,别再让它只活在提交信息里)

**没有一条检查验证「标记里点名的守卫,今天还覆盖这一项吗」。** 守卫文件不读标记(它们读的是源码、测试与文档),
所以它们回答不了这个问题;标记里点名的路径**存在**,由 `tests/review-layer-ownership.test.ts` 断言,
但「它存在」不等于「它覆盖这一项的完成判据」。

**实测反例(F3)**:`.opencodereview/rules/ptc-render-bounds.md` 必查 5 标着 `[机械: tests/text.test.ts]`。
把 `src/tools/common.ts:417` 从 `renderModelValue(outcome.value)` 改成 `JSON.stringify(outcome.value)`,
**`tests/text.test.ts` 14 个测试全绿** —— 它只 import `renderModelValue`,测的是渲染器,不是那个调用点。
真正抓住这个变异的是 `tests/run-code-tool.test.ts`、`tests/workflow-tool.test.ts`、`tests/binding-policy.test.ts`
(7 个测试转红)。标记已按实测改正,但**这类错误今天没有任何机制能自动发现**:
守卫存在 ≠ 守卫覆盖。这就是下面「剩下的缺口」里的第 2 条。

## 剩下的缺口(不吞掉,写在这里等 follow-up issue)

本票落地后,归属装置仍有三处**已知缺口**。按仓库的纪律(订正文档到交付现状 + 建 follow-up issue),
它们写在这里,由 follow-up issue 接手,不会被当成已完成:

1. **`doc-sync` 必查 2 / 6 / 7 的完成判据有一部分没有守卫。** `tests/doc-integrity.test.ts` 覆盖的是:
   断言一(相对链接的目标文件存在)、断言二(规范文档点名的**符号名**在 `src/` 里出现过)、
   断言三(账本里的 commit SHA 能在 git 解析)、断言四(规范文档的 `file:line` 行号落在目标文件行数内,
   `docs/reviews/**` 是快照,不在这个面)。**没覆盖**的是:必查 2 的「读点证据 / 显式挂账行 / 零『后续处理』字样」
   与 src→ADR 反向对照;必查 6 的「每个 closed 行点名一个具名测试 + 回滚后变红的陈述」与「Evidence 行号指向正确段落」;
   必查 7 的「常量与 `src/` 定义相等」(断言二是**名字出现**,不是**取值相等**)。
   这三项已从 `[机械: …]` 改标为 `[待补守卫: …]`,理由逐条写在标记里。
2. **没有检查验证「标记点名的守卫仍覆盖这一项」。** 见上一节。守卫文件不读标记,所以这题今天无人作答。
3. **F1–F4 在机械层与判断层之间仍然重复登记。** 规则正文没重写(本票 Out of scope):`test-discipline.md` 的
   `## 阻塞 finding` 一节仍把 F1/F2/F3 列为**阻塞 finding**,`## 严重性升级(Q9-D)` 一节仍写
   「任何 F1/F2/F3/F4 命中 → delegate 复核」。归属声明加在 `## 必查` 表格里,但那两节**不是带标记的必查项**,
   所以 checklist 构建那一步拿不掉它们 —— 判断层读到它们仍会照着报。这就是这条缺口仍在的原因。
4. **`AGENTS.md` 那一句对三问不再准确(本轮制造出来的漂移,显式挂账)。** 它写的是
   「评审装置的三层归属、层间不交错规则与「新增规则先判层」的路由判据 = `docs/agents/review-layers.md`(唯一实体…)」。
   三问搬到 `docs/agents/ocr-rules.md` §7.5 之后,那句话对**三问**那部分不再成立。
   **本轮没有改 `AGENTS.md`**(不在本轮的改动面内),所以这里写下来而不是让它悄悄漂:正确解是改 `AGENTS.md` 那一句
   (「三层归属表、不交错规则与三个不变量 = `docs/agents/review-layers.md`;判层三问 = `docs/agents/ocr-rules.md` §7.5」),
   **不是**在本文件里把三问复制回来 —— 后者与「一份事实一处家」直接冲突。

## 为什么不新开 ADR(记在这里,免得下一个人重新讨论一遍)

本票的 diff **不改任何对外契约、不改语义、不改状态机边界,并且不碰任何 `src/` 文件**
(实测:`git diff --name-only 0621aac..HEAD -- src/ scripts/ packages/` 返回 0 个文件)。
新出现的词(机械层 / 判断层 / 事实层)是**评审工具的词汇,不是领域词汇** ——
`GLOSSARY.md` 是单上下文领域词表(见 `docs/agents/domain.md`),它记的是 PTC 这个领域里的概念,
不记「一套评审装置有几层」。所以:`GLOSSARY.md` 不动,`docs/adr/` 不新增。
