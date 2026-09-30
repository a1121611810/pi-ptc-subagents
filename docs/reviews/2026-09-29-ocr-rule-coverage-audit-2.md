# OCR 规则覆盖审计 · 第 2 轮(机器防线:配置读点 / 渲染上限登记)

日期:2026-09-29。第 1 轮见 `2026-09-29-ocr-rule-coverage-audit.md`。
本轮范围:把第 1 轮列出的三个「未闭环开口」中的前两个变成机器防线,并在写的过程中又抓到 4 个新 finding。
方法:写 fixture → 跑反事实 → 修规则/文档 → 整条发布门禁。**声称完成但拿不出红色输出的行一律不算闭环。**

## 本轮闭环

| #    | Finding                                                                               | 证据                                                                                                                            | 处置                                                                                                                                 | 状态       |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| C-11 | `ptc-render-bounds.md` 自称适用 text.ts「的部分函数」,但它一个字都没提 text.ts 的上限 | `MAX_LINE_CHARS=200` / `INLINE_MAX_CHARS=100`(后者未 export),规则表格零覆盖                                                     | 新增「text.ts 行宽与 inline 判定」表,来源标 **ADR-0012:32 / ADR-0012:34**(不是 ADR-0015)                                             | **CLOSED** |
| C-12 | 规则自称登记 13 个上限,实际只登记 4 个                                                | 守卫红:列出 13 个未登记常量(render.ts 8 + 树形 3 + text.ts 2)                                                                   | 新增「render.ts 折叠/展开分块上限」表 8 行 + 树形表挂上常量列                                                                        | **CLOSED** |
| C-13 | `task-panel-render.ts` 被 rule.json 锚到本规则,但 5 个上限一个都没登记                | 守卫扩到该文件后红:`MAX_LABEL_CHARS=48` / `MAX_OUTPUT_LINE_CHARS=160` / `MAX_OUTPUT_PREVIEW_LINES=6` / `MAX_TASK_PANEL_ROWS=32` | 新增第三张登记表 + 守卫 `SCANNED_FILES` 加入该文件 + 哨兵名单加 5 项                                                                 | **CLOSED** |
| C-14 | 规则必查第 1 条的占位符 `MAX_DEPTH` / `MAX_CHILDREN` / `MAX_WIDTH` 在仓库里根本不存在 | `grep` 全仓无这三个标识符;真实名是 `TREE_VALUE_MAX_*`。「四个上限」也已过期                                                     | 改成指向真实常量名 + 「新增上限必须同时登记进表格」                                                                                  | **CLOSED** |
| C-15 | `ptc-config-wiring.md` 第 7 条要求「每个键有读点」,但对泛读形态不可兑现               | `WORKER_ENV_ALLOW_LIST` 的 6 个名字在 `src/` 里**只以字符串字面量存在**(limits.ts:113-118),逐名 identifier 出现次数为 0         | 规则第 7 条加第三/四条防御:泛读面改用「名单被读 + 消费函数在生产路径被调用 + 逐名行为断言」,并写明**把判据放松到恒真比没有判据更糟** | **CLOSED** |
| C-16 | 配置读点没有任何机器防线(规则承诺过但没兑现)                                          | 第 1 轮账本「下一轮的开口」第 2 条                                                                                              | 新建 `tests/config-read-points.test.ts`(10 tests)                                                                                    | **CLOSED** |
| C-17 | 渲染上限登记没有任何机器防线                                                          | 同上                                                                                                                            | 新建 `tests/render-bounds-registry.test.ts`(8 tests)                                                                                 | **CLOSED** |

## 被推翻的 finding(REFUTED,按纪律留档而非静默删除)

| #    | 原 finding                                                                                                                       | 复验结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 状态        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| C-18 | 「ADR-0015 §3 称 per-line cap 是 byte-based,而 `text.ts` 实现是 UTF-16 码元切片 → ADR 与实现漂移 + `truncateLine` 是幽灵函数名」 | **错。** ADR-0015:28-31 §3 原文:`truncateLine` is byte-based … **Our cap is char-based on purpose** … and is four lines of code; this is the one place the audit kept a local helper over a pi utility。byte-based 描述的是 **pi 的** `truncateLine`(真实存在于 `@earendil-works/pi-coding-agent/dist/core/tools/truncate.js`),而我们有意不用它。本地 `capLines`(text.ts:194-199)正是那四行 char 助手。ADR-0012:46-49 的修订记录复述同一句。**把 pi 的工具与本地助手混为一谈是我的错误。** | **REFUTED** |

## 反事实证据(闭环判据:必须能让具名测试变红)

### `tests/config-read-points.test.ts`

真实改 `src/runtime/limits.ts`(接口 + 字面量都加 `zzzNeverRead`,typecheck 不红)→
立刻红并逐键报出最强读点:`缺生产读点的 config 键: zzzNeverRead`。还原后 `git diff src/` 为空。
另带 4 条抽取器自检:假键名报 missing、去注释生效、声明缺失抛错、语料砍到只剩声明文件时全称断言当场不成立。

### `tests/render-bounds-registry.test.ts` —— **第一版守卫被自己的反事实打穿过**

初版守卫只要求「文档某处同时出现标识符和数值」。反事实:把 `MAX_LINE_CHARS` 的表格行删掉、
只留散文里那句 `MAX_LINE_CHARS = 200 与 INLINE_MAX_CHARS = 100 管送给模型的文本块`——**守卫照样绿**,
等于没守住。收紧成「必须是表格行(以竖线开头)+ 标识符边界匹配」后,同一反事实才转红。教训已写进测试注释。
三个反事实:

- A(删表格行、散文不动)→ 2 个测试红,报 `- src/tools/text.ts MAX_LINE_CHARS = 200`
- B(登记了但把 200 抄成 999)→ 只有「数值一致」那条红,「已登记」那条仍绿 → 两条断言不冗余
- C(哨兵抽不到 / 扫描面清空)→ 哨兵包含性 + 数量下界先红,不空转

## 被 teammate 纠正的两处 Lead 错误(已独立复验,均成立)

1. Lead 任务书写「排除整个 `src/runtime/limits.ts` 文件」。**错**:`maxTimeoutMs` 的唯一生产读点就是
   `limits.ts:167` 的 `effectiveTimeoutMs` 内部(`grep` 实证:该键在 `src/` 的 6 次出现里,只有 167 是值读取,
   其余是接口声明 / 字面量 / 注释)。正确做法是「声明语句结束行之后才算读点」。
2. Lead 任务书写「`WORKER_ENV_ALLOW_LIST` 的 6 个名字每个都该有 identifier 读点」。**不可兑现**,见 C-15。

## 守卫的已知局限(随测试一起读,不要高估它们)

- **同名同值分不开**:`task-panel-render.ts:87` 与 `render.ts:84` 各有一个 `MAX_ERROR_CHARS = 120`,
  同名同值但是两个常量。守卫在 task-panel 这一处的绿是巧合,不是证据。规则文件里已写明。
- **守卫证明「有读取语法」,不证明「值流入承诺行为」**。`config-read-points` 自己也命中同名局部变量
  (如 `worker-main.ts` 的 `const write = ...`);备份 / 回放 / 迁移路径上的读点与生产读点不可区分。
- **抽不到非顶层数值 const**:函数体内的局部上限、或从别处 import 进来的上限常量,按当前口径扫不到。
- **非上限常量按名字排除**:`shimmer.ts` 的 `DEFAULT_SHIMMER_INTERVAL_MS = 150`、`task-panel-render.ts`
  的 `AGE_TICK_MS = 1000` 是节拍不是上限,名字不含 `MAX`,天然排除——这是刻意的,不是遗漏。

## 仍未闭环(不是「已关闭」)

- **`shimmer.ts` 被 rule.json 锚到 `ptc-render-bounds.md`,但该文件里没有任何渲染上限可登记**。
  锚点目前是空的,要么将来补内容,要么把锚点收窄。
- **render.ts 那 8 个分块上限:纪律有出处(ADR-0013 §3/§4),数值没有出处**。README 只说
  「each block labelled and capped」,这 8 个常量名在 README 与 `docs/` 全域零命中。规则里已标
  「未挂账的既有事实」,**没有编来源**。要闭环需要补 ADR 数值表,或明确写「数值由可读性定,无独立来源」。
- **README 的 TUI rendering 段只写了 120**,text.ts 的 `MAX_LINE_CHARS = 200` / `INLINE_MAX_CHARS = 100`
  没进 README。属 `doc-sync.md` 必查 4/5 的范围,本轮未做。
- **`doc-sync.md` 仍无法自动投递**:`.md` 在 OCR 选择层(preview / review / scan)一律 `unsupported_ext`,
  这是工具事实,不是配置问题。文档漂移在本仓没有机器防线。
