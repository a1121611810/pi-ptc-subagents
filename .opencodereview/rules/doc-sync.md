# Doc Sync (audit 3f, 阻塞级)

适用文件:docs/**(rule.json 锚点 `docs/**`,merge_system_rule: true)。仓库根的 `CONTEXT.md`、
`CHANGELOG.md`、`AGENTS.md` 不在 `docs/**` 里,它们命中 `**` 兜底 —— 本规则的必查项 4 与 5
针对它们同样成立,评审时要把这些路径显式传给 `ocr delegate rule` 才能拿到本清单。

锚点有效性注释(必读,否则会误判这条规则是否在跑):在 ocr v1.12.10 上,`.md` 在**文件选择层**
——`ocr delegate preview` / `ocr review` / `ocr scan` 三条路径——一律 `exclude_reason: unsupported_ext`。
实证:commit `5b54601`(ADR-0023 + 账本 + 词表同步)改了 9 个文件, `reviewable_count = 1`,
唯一可审的是 `.opencodereview/rule.json`(它被 `**` 兜底命中);纯文档 commit `67136a9` 改了 4 个
.md,`reviewable_count = 0`。`.md` 的**规则解析层**是好的:把路径显式喂给
`ocr delegate rule docs/adr/0022-background-dispatch.md` 仍返回 `source: project` / `pattern: docs/**`。
所以审文档时,自己枚举该 commit 的 .md 路径显式传给 `ocr delegate rule`,与 tests/** 的
`default_path` 排除同一处置。

## 风险

文档与实现之间的漂移是 silent failure:没有任何 CI 会在链接 404、ADR 声明在 src/ 里零读点、
账本把「代码存在」记成闭环时变红。仓库已经吃过一次:`scripts/verify-dist-render.mjs` 断言「恰好两个
已注册工具」,一个通过了三轮评审和 696 个测试的特性因此在发布产物上构建失败,三轮 diff 评审全都
看不见(AGENTS.md 已记录)。本规则管的就是这一类「破在 diff 之外」的门禁。

## 必查

1. **ADR 状态机一致性**。每篇 ADR 顶部的 `Status: accepted (YYYY-MM-DD).` 行必须与实现现状相符;
   修订必须双向可达:被修订方有 `> Amended by ADR-00XX (date): ...` 指针(现存实例
   `docs/adr/0022-background-dispatch.md:9`),修订方写明 `This ADR amends ADR-00YY by reference` +
   `Where the two ADRs read differently, this one governs`(现存实例
   `docs/adr/0023-background-task-ownership.md:82`)。单边指针 = 阻塞。
   新增 ADR 必须进 `docs/adr/README.md` 的表格三列(# / Decision / Status);编号缺口只能在表格里以
   `(reserved — dropped: ...)` 显式占位(既有先例:0001 / 0006),不允许静默跳号。
   完成判据:本次 diff 涉及的每个 ADR 编号在 README.md 表格里能查到,且表格每一行指向的文件存在。

2. **ADR 声明 → 生产实现双向对照**。ADR 正文里出现的每个具名符号 / 字段 / 状态字符串都要在 `src/`
   找到读点:例 ADR-0022/0023 的 `ownerPid` / `ownerBootMs` / 21-field TaskRecord /
   `lost_on_session_restart`,ADR-0017 的 run identity 与 `drainGraceMs`,ADR-0015 的 50 KiB /
   2000 lines。声明了但生产代码零读点 = 阻塞,处置按 `.opencodereview/rules/ptc-config-wiring.md`
   的读点纪律走(给出 `file:line` 读点,或显式挂账:订正文档 + follow-up issue 号)。
   反向也要走一遍:本次 diff 改的 `src/` 行为若落在某篇 ADR 的语义范围内,在报告里点名那篇 ADR 的章节号。
   完成判据:每条声明都有读点证据或显式挂账行,零「后续处理」字样。

3. **代码改动是否需要 ADR**。三条触发线,任一命中就要求本次 diff 带 ADR 改动:新增对外契约(新 binding /
   新 model-facing tool / 新 frame kind)、语义翻转(同一入口的判定条件或默认值改变)、状态机增删边
   (TaskRecord 6 态、worker 状态机)。未触发也要在报告里写明「已有 ADR-00XX 覆盖,本次不改变其
   Decision」并给章节号,不能默认略过。

4. **CHANGELOG 与用户可见变更**。`CHANGELOG.md` 走 Keep a Changelog + SemVer。判定标准是「下游
   `pi install npm:pi-ptc-subagents` 装到的能不能察觉」:program-visible / model-visible /
   wire-visible / 发布产物(tarball 内容、minify、source map 排除)算;纯内部重构与测试不算。
   版本号必须与 `package.json` 的 `version` 一致(当前 1.1.0,对应 `## [1.1.0] - 2026-09-29` 条目)。
   完成判据:用户可见变更 100% 有条目;反过来每条 CHANGELOG 条目都能在 diff 里指出对应改动。

5. **CONTEXT.md 词条与实现同步**。仓库根 `CONTEXT.md` 是单上下文领域词表,它里面的 _Avoid:_ 约束
   (如 output / result 的四义拆分)只有在实现统一后才成立。本次 diff 新引入的领域名词(新 TaskRecord
   字段、新 model-facing tool、新 lost reason 字符串)必须给出词条,或明确说明为何不进词表。
   词表说禁用、实现照用 = 阻塞。
   完成判据:新名词有词条或有意排除的说明;被本次 diff 触碰的词条,其定义与 `src/` 里的常量逐字一致。

6. **docs/reviews/ 账本与实际 commit 对齐**。账本每一行要四元对上:finding → 证据(`file:line` 或
   未截断 grep 计数)→ 处置 → 闭环 commit / snapshot SHA。现存四份:
   `2026-09-24-bgdispatch-code-review.md` 及其 `-2` / `-3`,以及
   `2026-09-29-field-report-fix-code-review.md`。按 AGENTS.md 闭环纪律 (a):closure 只有在**回滚修复能让
   某个具名测试变红**时才算真闭环,「线上有这条路径」不是闭环,测试全绿也不是。
   完成判据:每个 closed 行能引出一个具名测试 + 回滚后变红的陈述;账本引用的 SHA 在 `git log` 里可解析;
   账本 `Evidence` 列的行号仍指向正确段落。

7. **文档里的行号 / 路径 / 常量值仍然有效**。这类漂移完全 silent:链接 404、行号错位、常量值过期
   都没有拦截。逐条验证本次 diff 触碰的文档里的 `./xxx.md` 相对链接、`file.ts:123` 行号、具体数字
   (字段数、字节数、行数、超时值)。已知历史漂移类型:ADR-0022 的「21 fields」出现在 Status 行 / G1 /
   §3 开头 / §3 标题四处,而 §3 的 code block 只列 19 个字段——ADR-0023 §Boundary 已把它记为
   authoring miscount 并声明以 ADR-0023 为准,这种**已显式挂账**的漂移不开新阻塞 finding,同类的
   未挂账漂移要报。
   完成判据:文档中每个引用都能被一条命令验证(链接存在、行号落在目标文件范围内、常量与 `src/` 定义相等)。

8. **文档里写死的整跑门禁必须真的能跑**。文档若把某条命令写成「发布前必须跑」,它就得在任何 diff 外
   的场景成立。仓库的发布门禁逐字对应 `package.json` 的 scripts 字段:
   `pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run build && pnpm exec vp test --run --coverage && pnpm run verify:dist`。
   文档改动若涉及 `verify:dist` / `scripts/verify-dist-render.mjs` 的断言形状,必须在同一次改动里
   同步断言与文档两处。

## 阻塞触发

- ADR 声明在 `src/` 零读点,且未显式挂账 → PR 阻塞。
- 新增 ADR 未进 `docs/adr/README.md` 索引,或 amendment 指针单边 → PR 阻塞。
- 用户可见变更缺 CHANGELOG 条目,或 CHANGELOG 版本与 `package.json` 不一致 → PR 阻塞。
- 账本把「代码存在 / 路径在 / 测试全绿」记成 closure → PR 阻塞(改回 open,或补具名测试的反事实判据)。
- 文档里失效的链接 / 行号 / 常量值既不订正也不挂账 → PR 阻塞。
- 改了 `verify:dist` 断言形状而文档未同步 → PR 阻塞。

## 严重性升级(Q9-D)

升级。与 3a 同理由,这里更重:文档漂移破的是**不住在 diff 里**的门禁,没有 CI 会在 ADR 声明零读点、
链接 404 或伪闭环时变红,OCR 的 precision 优势补不了这个 recall 缺口。判定口径:命中「ADR 声明零读点 /
单边 amendment 指针 / 账本伪闭环 / 未挂账的行号与常量漂移」任一条,必须走 delegate 复核。
