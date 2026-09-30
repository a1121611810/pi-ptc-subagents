# OCR 规则覆盖审计与修复(finding → 证据 → 处置)

日期:2026-09-29(基于 `fbb8d1c chore(release): 1.1.0`)
范围:.opencodereview/rule.json + .opencodereview/rules/*.md + code-review skill 的承载能力
方法:全树 `ocr delegate rule` 覆盖扫描 + `ocr rules check` 逐文件解析 + v1.12.10 行为实测 + 反事实验证

## 结论

`.opencodereview/rule.json` 长期存在**三个互相掩盖的缺陷**:一个孤儿规则文件、7 个裸奔的生产文件、
以及一个把所有 markdown 挡在选择层之外的工具事实。它们合起来的效果是:本仓的通用审查层(Fowler、维度表、
文档同步)在实际投递中**基本不存在**,而 SKILL.md 与 AGENTS.md 都把它写成活的。

## Finding 台账

| #    | Finding                                                                 | 证据                                                                                                                                                                                               | 处置                                                                                                                          | 状态       |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C-1  | `general.md` 是孤儿规则                                                 | `grep -c 'general.md' .opencodereview/rule.json` = **0**;被 SKILL.md:45 与 AGENTS.md 同时引为 Standards 轴来源                                                                                     | rule.json 末尾加 `**` catch-all(merge=true)→ general.md;规则重写为 12 条 Fowler + 5 维触发表                                  | **CLOSED** |
| C-2  | 7/33 `src/*.ts` 无项目规则                                              | 全树扫描 SYSTEM-ONLY:`limits.ts` / `turn-pools.ts` / `sub-call-tracker.ts` / `skills-section.ts` / `text.ts` / `shimmer.ts` / `env.d.ts`。其中 `limits.ts` 是全部 15 个 `PtcConfig` 键的唯一声明源 | 补 6 个具体锚 + catch-all;覆盖复测 **SYSTEM-ONLY = 0**                                                                        | **CLOSED** |
| C-3  | 裸奔文件拿到的是 JS/React 通用样板                                      | `ocr rules check src/runtime/limits.ts` → `## React Best Practices` / "Using `var` is strictly prohibited" / "`==` and `!=` is prohibited"                                                         | 同 C-1 / C-2                                                                                                                  | **CLOSED** |
| C-4  | `ptc-render-bounds.md` 自称适用 `src/tools/text.ts`,但 rule.json 无此锚 | 规则正文第 3 行 vs `ocr rules check src/tools/text.ts` 改前 `Source: System built-in`                                                                                                              | 补锚 `src/tools/text.ts` → ptc-render-bounds(merge=true)                                                                      | **CLOSED** |
| C-5  | `ptc-worker-lifecycle.md` 引用不存在的 `src/runtime/worker-state.ts`    | `git ls-files 'src/runtime/worker-state.ts'` 无此文件(git log --all 亦无);只有 `tests/worker-state.test.ts`                                                                                        | 改「适用文件」为实际存在的 worker-entry/worker-source/worker-main/worker-pool,并注明状态机测试在 `tests/worker-state.test.ts` | **CLOSED** |
| C-6  | SKILL.md 的阻塞清单漏 `ptc-bgdispatch-contract.md`                      | 该规则是 rule.json 中锚定最多的一组(dispatch / dispatcher / background-runtime / notification-pipeline / child-process-lifecycle / bindings / index 等);SKILL.md 表中缺席 → Q9-D 对它从未触发      | 取消手抄清单,改为「唯一事实源是 rule.json」+ 当前契约规则对照表,并写明漏抄这件事本身                                          | **CLOSED** |
| C-7  | 升级机制与规则文件冲突                                                  | SKILL.md 把 ptc-render-bounds(严重级)列入升级;规则文件末尾明确写「不升级 — visual contract」                                                                                                       | 以规则文件为准,对照表标注 **否**                                                                                              | **CLOSED** |
| C-8  | 悬空引用「详 `.opencodereview/rule.json` 头部注释」                     | 该文件第 1 行即 `{`;JSON 不可能有注释。SKILL.md 两处引用                                                                                                                                           | 新建 `docs/agents/ocr-rules.md` 作者手册(schema / first-match-wins / merge 语义 / 文件类型覆盖 / 新锚点模板),引用改指过去     | **CLOSED** |
| C-9  | ADR 计数过期                                                            | SKILL.md 写「18 个 ADR」;`docs/adr/` 实为 **21** 篇                                                                                                                                                | 改为 21                                                                                                                       | **CLOSED** |
| C-10 | 无任何机器守卫防止孤儿规则 / 悬空锚点复发                               | 上一轮 general.md 成为孤儿时无任何测试变红                                                                                                                                                         | 新建 `tests/ocr-anchor-coverage.test.ts`(5 条结构断言 + 8 个 sentinel + 1 条 .md 选择层守卫),14 passed                        | **CLOSED** |

## 被推翻的假设(记录以免下一轮重犯)

| 假设                                                 | 实测                                                                                                         | 结论                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「`ocr scan` 能审 markdown,所以文档/ADR/CI 走 scan」 | `ocr scan --preview` 列 70 个 `.md`,`will_review: true` 的有 **0** 个,全部 `exclude_reason: unsupported_ext` | **假**。scan 只是把 .md 列进清单,同样不审。分界线是**解析层 vs 选择层**:`.md` 在 `rules check` / `delegate rule` 解析正常,在 preview / review / scan 三条路径上全被丢。文档审计只能由 host agent 手动套 `doc-sync.md`。已写进 SKILL.md 第 4/8 步、AGENTS.md,并由 `tests/ocr-anchor-coverage.test.ts` 固化 |
| 「`merge_system_rule` 的效果 = 78 行 vs 31 行」      | 该行数随「哪个文件 + 哪个 ocr 版本」变化                                                                     | 数字不可作不变量。结构性判据才是稳定的:`true` → 输出同时含 `## System-Specific Rules (Mandatory)` 与 `## User-Specific Rules (Mandatory)` 两段;`false` → **完全没有** `System-Specific` 段。已按结构性表述写入手册                                                                                        |
| 「`ocr rules check` 的输出含规则文件名」             | `ocr rules check src/runtime/protocol.ts` 中含 `ptc-protocol-pair-correctness` 的行数 = **0**                | **假**。ocr 只打印解析后的正文,从不打印正文来自哪个 .md(`delegate rule` 的 groups[] 也没有这一列)。sentinel 断言已改用各规则的 H1 标题                                                                                                                                                                    |
| 「`rule.json` 里 catch-all 放前面无害」              | 实验:catch-all 在前时 `protocol.ts` 命中 general.md 而非专用规则                                             | **假**,严格 first-match-wins。catch-all 必须在数组末位,已固化为测试断言                                                                                                                                                                                                                                   |

## 反事实验证(闭环证据)

闭环判据是「改动必须能让某个具名测试变红」,不是「测试全绿」。按此对 `tests/ocr-anchor-coverage.test.ts` 逐条验证:

- **反向操作**:从 rule.json 抽掉 `general.md` 的 catch-all 锚(复现孤儿状态)
  → `every rule file is referenced by at least one anchor (no dead rules)` 红
  → `the catch-all resolves to general.md` 红
  → `README.md resolves to General Review Baseline` 红
  → 3 failed | 11 passed。还原后 14 passed。
- **结论**:该测试是 specification(防错误)而非 characterization(防回归)——它会在缺陷复发时变红,不是永远绿。

## 整条发布门禁(AGENTS.md 要求,不可只看 diff)

```
typecheck  ✅        lint  ✅ 0 warnings / 0 errors
fmt:check ✅ 172 files   build ✅
test     ✅ 758 passed | 4 skipped (45 files)
verify:dist ✅ 29 checks
```

`fmt:check` 首跑是**红**的:4 个文件未格式化,其中 3 个正是本次改动的 .md。这正是 AGENTS.md 记的那条教训
——「作者只对手挑文件跑了 oxfmt,整仓 fmt:check 照样红」。本轮复现:4 个文件未格式化,其中 3 个是本次改动的 .md。已按纪律跑整仓 `pnpm run fmt` 而非手挑。

## 下一轮的开口(未闭环,不是 finding 已关闭)

- **`doc-sync.md` 永远无法自动投递**。`.md` 在 OCR 选择层不可见是工具事实,不是本仓配置问题。因此文档漂移
  (ADR↔实现、CHANGELOG、CONTEXT.md、`docs/reviews/` 账本)在本仓**没有机器防线**,只有纪律。若要机器化,
  只能另写 vitest fixture 做 source-scan,与 OCR 无关。
- **`ptc-config-wiring.md` 要求的 source-scan fixture 尚未存在**。该规则第 7 条要求「每个 config 键在 `src/` 有读点」
  的机器断言,目前只有人工基线表(规则正文里的 15 键读点表)。存量键全接上了(逐键实测),但**没有守卫防止下一个键只写进
  `PtcConfig` 就完事**。
- **`text.ts` 的截断契约覆盖未经证实**。`ptc-render-bounds.md` 声称适用 text.ts 的部分函数,本轮只补了锚点,
  未逐函数核对哪些函数真的受 50 KiB / 2000 lines 约束。
