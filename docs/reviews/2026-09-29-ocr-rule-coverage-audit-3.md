# OCR 规则覆盖审计 · 第 3 轮(收口未闭环开口 + 文档完整性守卫)

日期:2026-09-29。第 1 轮 `2026-09-29-ocr-rule-coverage-audit.md`,第 2 轮 `2026-09-29-ocr-rule-coverage-audit-2.md`。
本轮范围:把第 2 轮「仍未闭环」的四条逐一处理,并在过程中新挖出 3 条。

## 本轮闭环

| #    | Finding                                                                                                                                           | 证据                                                                                                 | 处置                                                                                                                                                                                                                           | 状态                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| C-19 | `shimmer.ts` 被 rule.json 锚到 `ptc-render-bounds.md`,但该文件唯一的数值常量是 `DEFAULT_SHIMMER_INTERVAL_MS = 150`(节拍,不是渲染上限)——锚点是空的 | `grep` 全文件只有这一个数值常量                                                                      | **撤掉该锚**,落到 `**` → `general.md` 兜底。撤后复测 `ocr delegate rule` 全树 `SYSTEM-ONLY: []`(33 条规则)                                                                                                                     | **CLOSED**                         |
| C-20 | render.ts 那 8 个分块上限「纪律有出处、数值无出处」                                                                                               | 八个常量名在 README 与 `docs/` 全域零命中                                                            | `docs/adr/0013-ptc-row-compact-summary.md` 新增 **§6** 数值表,并写明来源声明:「chosen for TUI readability; **they have no independent source** … registers them as frozen contract values」。规则八行来源列改为「ADR-0013 §6」 | **CLOSED**                         |
| C-21 | README 的 TUI 段只有 120,缺 text.ts 的 `MAX_LINE_CHARS=200` / `INLINE_MAX_CHARS=100`                                                              | README.md:134 只写 4/6/120                                                                           | README 新增一段,指向 ADR-0012,并明确「人眼的 4/6/120」与「模型的 100/200」互不联动;CHANGELOG 加 `## [Unreleased]` 条目(README 随 tarball 到达用户,属 doc-sync 必查 4)                                                          | **CLOSED**                         |
| C-22 | `doc-sync.md` 永远无法被 OCR 自动投递                                                                                                             | `.md` 在 ocr 选择层(preview / review / scan)一律 `unsupported_ext`——**工具事实,不是配置问题**        | 新建 `tests/doc-integrity.test.ts`(17 tests),把必查 2 / 6 / 7 里**可判定**的部分变成机器断言。**不可判定的部分(ADR 讲的决策对不对)仍然只能靠人**——这不是未完成的活,是这类规则的能力上限                                        | **PARTIALLY CLOSED**(机器面已覆盖) |
| C-23 | 真实坏链接:`docs/research/prototype-pulse-tui-variants/industry-findings.md` 第 16 / 73 / 127 行写 `../../dsh-ptc-page-rendering.md`              | 从该目录出发落到 `docs/dsh-ptc-page-rendering.md`(不存在);真实文件在 `docs/research/`,正确路径 `../` | 守卫上线第一天抓到,3 处改为 `../`                                                                                                                                                                                              | **CLOSED**                         |
| C-24 | `tests/render-bounds-registry.test.ts:93` 注释写 task-panel 的 `MAX_ERROR_CHARS` 与 render.ts 的「同名**不同值**」                                | 两边都是 120,是同名**同值**;注释由上一轮 teammate 按错误假设写下                                     | 改正注释,并补一句「守卫分不开它们,此处的绿是巧合不是证据」                                                                                                                                                                     | **CLOSED**                         |
| C-25 | 规则里把「树与分块同属一条连接符链」引作 ADR-0013 **§4**                                                                                          | 该文 §4 是 renderShell 用 pi 默认边框;连接符链是 **§5 第 4 条**                                      | 改正引用                                                                                                                                                                                                                       | **CLOSED**                         |

## 反事实(四类断言全红,6 条测试)

守卫上线当天注入四类缺陷并确认全部被抓:坏链接(一个指向不存在文档的 `./0000-….md`)、不存在的符号
(一个凭空造的 `ownerPid…` 标识符)、一个 git 解析不了的 commit 引用、越界行号
(`src/tools/render.ts` 的第 99999 行,该文件只有 1059 行)。三个被注入的文档还原后 `md5` 与注入前
逐字节一致,`git diff` 为空。

> **本行曾经让守卫变红,这是真实发生过的**:第 3 轮账本初稿在正文里**原样引用了反事实用的假 commit 引用**,
> `tests/doc-integrity.test.ts` 的断言三立刻报「账本里的 SHA 无法被 git 解析」并指到本文件第 21 行。
> 守卫是对的——账本里出现一个解析不了的 commit 引用,不管它是「举例」还是「记录」,都该被报出来。
> 处置是改文案(不把假 SHA 写进账本),**不是放宽守卫**。这同时暴露了守卫的一个误报面:
> **散文里描述一个坏 SHA 也会被抓**。当前判定可接受(账本里本就不该有假 SHA),但记在此处,
> 将来若出现「引用外部论文里的示例 SHA」这类正当场景,需要给断言三加豁免而不是删断言。

## 一个反事实逼出来的口径修正

`inRepoTarget` 最初只按「文档所在目录」解析基准,于是 ADR-0013 的 `src/tools/render.ts:78`(仓库根相对写法)
被判成「仓库外」,**断言四一度退化成空转——注入 `render.ts:99999` 测试仍然绿**。改成
「文档目录 + 仓库根」双基准后立刻抓到。
教训:**判定基准少一条不会报错,只会让守卫静默失效**——与 ptc-config-wiring 模板 B 同一类。

## 范围判断(下一轮靠它判断边界是否合理)

- **符号断言收窄**到 `docs/adr/** + docs/specs/** + docs/usage/** + README.md + CONTEXT.md`,
  排除 **AGENTS.md 与 `docs/agents/**`**——那几份讲的是评审工具与仓库流程,词表属 ocr rule schema 与
  GitHub API,对它们断言「符号必须在 `src/`」没有语义。**链接断言仍覆盖它们。**
  408 个 token 收到 239 个;剩下 36 个外部词汇写成**显式清单**(分 A 宿主 API / B 打包配置 /
  C ADR-0022 推迟到 v2 的宿主方法 / D 第三方词表),并配两条反向守护:某项将来真进了 `src/` → 红,
  某项文档里没人再提了 → 红。**排除清单本身就是新的漂移源,必须有守卫。**
- **行号断言排除 `docs/research/**` 与 `docs/reviews/**`**:全仓 248 处 `file:line` 里 **240 处在快照**
  (69 处挤在 `dispatcher-test-timing-rootcause.md`、84 处在 `docs/reviews/**`),规范文档只有 8 处。
  快照的行号在下写下时是对的,代码一改就漂移是**预期行为不是缺陷**;断言它们会立刻产生 240 条红灯——
  守卫一旦变成噪声就等于没有守卫。
- **链接 404 在任何文档里都是缺陷**,与行号会不会漂是两回事,所以链接断言扫全量(含 research/reviews)。

## 仍未闭环(不是「已关闭」)

- **`task-panel-render.ts` 的 5 个上限仍然「未挂账的既有事实」**(`MAX_LABEL_CHARS=48` / `MAX_ERROR_CHARS=120` /
  `MAX_OUTPUT_LINE_CHARS=160` / `MAX_OUTPUT_PREVIEW_LINES=6` / `MAX_TASK_PANEL_ROWS=32`)。ADR-0013 §6 只覆盖
  render.ts 的八个——**没有拿 §6 冒充 task-panel 的来源**,这是对的。但这个缺口是本轮新暴露的:
  任务面板是独立组件,归 ADR-0022/0023 而不归 ADR-0013,所以闭环路径是**给后台任务那份 ADR 补数值表**,
  不是往 §6 里塞。**本轮未做**,单列在此。
- **展开态错误文本不受 `MAX_ERROR_CHARS` 约束**:`render.ts:927-932` 取完整 content text,只按
  `MAX_LOG_LINES_EXPANDED=12` 切行,单行宽度只被视口截断;120 只作用于折叠态那一行。
  即 §3「展开态有界」对错误块的边界是**行数有界、单行宽度无独立上限**。ADR-0013 §6 表格已按代码实况写,
  数值未动。**属实现与纪律的偏差,待裁决是改实现还是改 ADR。**
- **phases 块只追加裸 `" …"`**(`render.ts:951`),不像 code/log/out/warn 那样报 `…+N more`。
  §3 要求 reports what it withheld,这一处报了但没报数量。**合规度不齐,未动代码。**

## 整条发布门禁

```
typecheck   ✅   lint ✅ 0 warnings / 0 errors   fmt:check ✅ 177 files   build ✅
四个守卫    ✅ 49 tests (doc-integrity 17 / config-read-points 10 / render-bounds-registry 8 / ocr-anchor-coverage 14)
全量        ✅ 793 passed | 4 skipped (48 files)
verify:dist ✅ 29 checks
```
