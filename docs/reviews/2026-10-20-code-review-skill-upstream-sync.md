# Code review — 项目级 code-review skill 对齐上游 `mattpocock/skills`(2026-10-20)

Date: 2026-10-20. **被审对象是评审工具链本身**,不是产品代码:`.agents/skills/code-review/SKILL.md`
(本仓的项目级 skill,fork 自上游 `mattpocock/skills` 的 `code-review`)、`AGENTS.md` 的
「Code review tooling」段、`.opencodereview/rules/doc-sync.md` 的一处陈旧引用。

Scope:未提交的工作树 vs `HEAD` = `6ce8375`。本轮由**三个只读 agent 并行**产出(上游↔本地逐项对照 /
仓内耦合与事实漂移审计 / 独立方案第二意见),父级复核每一条断言后落地。

## 为什么不需要 ADR(doc-sync 必查 3 的三条触发线)

三条**全部未触发**:① 无新增对外契约(没有新 binding / 新 model-facing tool / 新 frame kind;新增的
`pnpm run check:code-review-upstream` 是仓内开发脚本,且 `package.json` 的 `files` 不含 `scripts/`,
`.agents/`、`docs/`、`tests/`,不进发布产物);② 无语义翻转(diff 不触及 `src/`,产品入口的判定条件与
默认值一条未改);③ 无状态机增删边(TaskRecord 六态、worker 状态机未触及)。现有 46 篇 ADR 覆盖的是
**产品契约**,**没有一篇覆盖评审工具链**——这不是遗漏,是评审工具链本就不在 ADR 的射程内。

## 为什么不写 CHANGELOG(doc-sync 必查 4)

判定标准是「下游 `pi install npm:pi-ptc-subagents` 装到的能不能察觉」。本轮 diff 触及的 8 个文件里,
只有 `package.json` 进发布产物,而它新增的是一个下游不会执行的 `scripts` 条目;.agents / docs /
scripts / tests / AGENTS.md 均不在 `files` 里。**无 program-visible / model-visible / wire-visible /
发布产物变更** ⇒ 不写 CHANGELOG 条目。

## Health gate

- CodeGraph:174 files / 3 985 nodes / 15 699 edges。ocr v1.12.11。
- 全树 `src/*.ts` 规则覆盖:`SYSTEM-ONLY: []`(41 个文件 / 27 groups,exit 0)。
- `.md` 选择层排除实测:`ocr scan --preview` 列 144 个 `.md`,`will_review: true` 的 **0** 个,
  `exclude_reason` 全为 `unsupported_ext`;`tests/**` 为独立排除 `default_path`。

## Finding 台账

| #   | Finding                                                                                                           | 证据                                                                                                                                                                                      | 处置                                                                                                                                         | 状态       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S-1 | **没有任何机器守卫读 `.agents/skills/**`** —— skill 对本仓的断言无人校验,漂移完全静默                             | `git grep -ln "agents/skills" -- tests/ scripts/ .github/` → 空;6 个 workflow 无一调用 skill                                                                                              | 新建 `tests/code-review-skill-sync.test.ts`(16 条断言)+ `tests/ocr-anchor-coverage.test.ts` 补 `.yml` 行为断言;两者在 §反事实验证 里逐条变异 | **CLOSED** |
| F-1 | skill 称 `.yml` 在 OCR 选择层不可见 —— **是错的**                                                                 | `ocr delegate preview --from 06ad84b~1 --to 06ad84b` → `.github/workflows/pages.yml`、`website.yml` 出现在 `reviewable_files`;`ocr scan --preview` 11 个 yml 有 10 个 `will_review: true` | 三处口径改为「`.yml` 可审,CI workflow 可直接委托」;`ocr-anchor-coverage.test.ts` 补行为断言把这条钉住                                        | **CLOSED** |
| F-2 | skill 写「`docs/adr/`(21 篇 ADR)」—— 实为 **44** 篇                                                               | `ls docs/adr/*.md \| grep -v README \| wc -l` = 44(0002–0046)。21 是 2026-09-29 的值(见 `2026-09-29-ocr-rule-coverage-audit.md` C-9)                                                      | 删掉计数,改指 `docs/adr/README.md` 索引                                                                                                      | **CLOSED** |
| F-3 | skill 称 `ptc-config-wiring.md` 锚 `turn-pools.ts` —— 实锚 `ptc-worker-lifecycle.md`                              | `.opencodereview/rule.json` 的 `src/runtime/turn-pools.ts` → `ptc-worker-lifecycle.md`;sentinel 断言同(`tests/ocr-anchor-coverage.test.ts:152`)                                           | 改口径;新 fixture 机械对照 skill 里每条「规则↔锚点」配对与 rule.json                                                                         | **CLOSED** |
| F-4 | skill 说 fixture 扫 F1/F2/F3 —— 实际有 **F4**(assertion-free test body)                                           | `tests/test-meta-discipline.test.ts` 的 F4 段;`docs/testing-constraints.md` 的 F4 一节                                                                                                    | 三处补 F4;断言要求「含 F4 且带阻塞标记」                                                                                                     | **CLOSED** |
| F-5 | skill 写 `ocr scan --preview` 列 **70** 个 `.md` —— 实为 **144**                                                  | live `ocr scan --preview --format json`                                                                                                                                                   | 删掉数字,判据改成「`will_review` 标志,不是个数」                                                                                             | **CLOSED** |
| F-6 | skill 写「改 rule.json 后此处必须同步,`tests/ocr-anchor-coverage.test.ts` 兜底」—— **假保护**                     | 该 fixture 只验 rule.json 自身完整性,全仓无任何 test/script 读 `.agents/skills/**`(同 S-1)                                                                                                | 改口径为「那张手抄表由 `tests/code-review-skill-sync.test.ts` 兜底」,并真的建了这个 fixture                                                  | **CLOSED** |
| F-7 | skill 写 ocr `>= 1.9` / `>= 1.9.0` —— 实装 v1.12.11,仓内基线 v1.12.10                                             | `ocr --version` → v1.12.11;`tests/ocr-anchor-coverage.test.ts:19` 的注释把行为断言钉在 v1.12.10                                                                                           | 改指行为断言,不再在文档里写死版本号                                                                                                          | **CLOSED** |
| F-8 | skill 维度表称「依赖」由 `general.md` 承载 —— general.md 只有 A–F 六节,无依赖维度                                 | `general.md` 的小节标题:A 错误处理 / B 多轨 / C 性能 / D 数据迁移 / E 能力的可用前提 / F 安全与隐私                                                                                       | 该行改为「只能人审」                                                                                                                         | **CLOSED** |
| U-1 | 上游 #1208①:standards 来源改「实搜仓库 + `CONTRIBUTING.md` 必在列」—— **adapt**                                   | `CONTRIBUTING.md` 存在(2026-10-03 `c1dda59` 引入,**晚于本仓 fork**),其 House style 三条(文档同步 / 测试可伪证 / `file:line` 只在受检处引)正是可判定的写码规范,旧清单里**没有它**          | 取「实搜 + 必在列」的纪律,不取文件名;第 6 步与 Standards 轴节改写                                                                            | **CLOSED** |
| U-2 | 上游 #1208②:两个 sub-agent 一起发出、**在前台**、消费其返回的报告 —— **adopt**                                    | 本仓自己造了后台派发:`src/tools/subagent.ts` 的后台分支**只返回句柄**(`Started background task <ULID>`),报告须另用 `ptc_task_output` 轮询                                                 | 第 6 步钉死前台并写明「后台化又不轮询 = 两轴报告永不到手」                                                                                   | **CLOSED** |
| U-3 | 上游 #1208③:issue tracker 走 tracker doc —— **adapt**                                                             | 本仓 tracker doc 路径恰好固定(`docs/agents/issue-tracker.md`),但旧 skill 把 **`gh` 也写死**了;上游 setup 支持 github / gitlab / local 三种 tracker                                        | 改为「按 AGENTS.md 的 `### Issue tracker` 块指向的 tracker doc,用哪个命令由那份 doc 写明」                                                   | **CLOSED** |
| U-4 | 上游**记录了但没进 SKILL.md** 的已知 bug:sub-agent 会重新调用 `/code-review` 再派代理(上游记录有人跑到 50+ agent) | 上游 `docs/engineering/code-review.md`「Its sub-agents keep invoking /code-review again」一节,以及它给出的那一行修法                                                                      | 两个 brief 都加 `Do not invoke /code-review or spawn additional agents: perform this review directly.`                                       | **CLOSED** |
| A-1 | 固定点未给时应当问用户,而不是自己猜                                                                               | 上游 §1「If they didn't specify one, ask for it」;猜错 = 审了错的 diff 而报告看着像对的                                                                                                   | 第 1 步补「用户没给就问」                                                                                                                    | **CLOSED** |
| A-2 | 提交清单应进 brief                                                                                                | 上游 §1 / §4 都要求 diff 命令**与 commit 清单**;旧 skill 只给 diff                                                                                                                        | 第 1 步取 `git log <fixed-point>..HEAD --oneline`,两个 brief 都带                                                                            | **CLOSED** |
| A-3 | Spec 轴缺「越界实现(scope creep)」检查                                                                            | 上游 Spec brief 要求 (a) 缺 / (b) 越界 / (c) 实现错;旧 skill 有 (a)(c) 无 (b)                                                                                                             | 新增「越界实现(scope creep)」节并挂进第 6 步                                                                                                 | **CLOSED** |

## 被推翻的假设(记录以免下一轮重犯)

1. **「全局装的那份是最新版,所以本仓这份也新」** —— 前者确实与上游 `main` 逐字节相同,但本仓这份
   是 2026-09-23 fork 的,**漏掉了之后唯一一次上游改动**。两者是不同文件,机器上装了新的不等于
   仓里用的新的。
2. **「`.yml` 不可审」** —— 抄来的口径,本仓从未验证。实测**反了**。凡是说 OCR 行为的话,先实跑
   `ocr scan --preview --format json` 看 `will_review` + `exclude_reason`。
3. **「那张手抄表有 fixture 兜底」** —— skill 自己这么写,改了半年没人发现,因为**全仓没有任何测试
   读它**。一个自己声明的保护不存在,比没有声明更危险。
4. **第一版 fixture 断言落在「整份文件任意位置」** —— 变异打上去**不转红**:规范清单里删掉
   `CONTRIBUTING.md` 仍绿(别处还提到它),删掉规则表整行仍绿(锚点节还提到它)。已收紧到**节作用域**
   并按节内具体字符串断言。这是本轮唯一一处「先写测试、后发现测试比意图弱」的返工。
5. **锚点抽取器的正则只吃裸规则名** —— skill 里规则写的是**全路径**,前向形式其实一直没被匹配到
   (反向形式匹配到了,所以 vacuity guard 看着是绿的)。已改成 `\`([^\`]*\.md)\``。

## 反事实验证(闭环证据)

闭环判据是「改动必须能让某个具名测试变红」,不是「测试全绿」。

`tests/code-review-skill-sync.test.ts` 的 16 条断言逐条变异(每组都是**改坏 skill 文件**后重跑):

| 变异                                                           | 期望               | 实测                                      |
| -------------------------------------------------------------- | ------------------ | ----------------------------------------- |
| 从规范清单里删掉 `CONTRIBUTING.md`                             | RED                | RED(1 failed)                             |
| 删掉规则表里的 `ptc-render-bounds.md` 行                       | RED                | RED(1 failed)                             |
| 写回「21 篇 ADR」                                              | RED                | RED(1 failed)                             |
| 写回「70 个 .md」计数                                          | RED                | RED(1 failed)                             |
| 还原旧的「`.md` 与 `.yml` 在 OCR 选择层不可见」                | RED                | RED(1 failed)                             |
| 删掉整条 F4 阻塞句                                             | RED                | RED(1 failed)                             |
| 规则表里的 F4 去掉                                             | RED                | RED(1 failed)                             |
| 前向写回错误锚点配对(`turn-pools.ts` → `ptc-config-wiring.md`) | RED                | RED(1 failed)                             |
| 反向写回错误锚点配对                                           | RED                | RED(1 failed)                             |
| 抽掉两种形态的锚点声明                                         | RED(vacuity guard) | RED(`no rule-anchor claim was extracted`) |
| 删掉「都走前台」                                               | RED                | RED(1 failed)                             |
| 删掉「禁止后台派发」                                           | RED                | RED(1 failed)                             |
| 删掉 `### Issue tracker` 指向                                  | RED                | RED(1 failed)                             |
| 删掉递归禁令                                                   | RED                | RED(1 failed)                             |
| 删掉「用户没给就问」                                           | RED                | RED(1 failed)                             |
| 删掉 commit 清单                                               | RED                | RED(1 failed)                             |
| 删掉「### 越界实现(scope creep)」小节标题                      | RED                | RED(1 failed)                             |

`scripts/check-code-review-upstream.mjs` 的三条路径:

| 场景                                 | 期望                       | 实测                                                                   |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| 上游未动                             | exit 0                     | exit 0,输出「upstream has not moved」                                  |
| 基线改成旧 commit(模拟上游又动了)    | exit 1 + 列出未裁决 commit | exit 1,列出上游那一次改动(其 commit SHA 记在基线文档里,不在本仓对象库) |
| 基线 SHA 悬空 / `base-commit` 行缺失 | exit 2 + 显式错误          | exit 2,两种情形各给一句明确原因                                        |

## 整条发布门禁(AGENTS.md 要求,不可只看 diff)

`pnpm run typecheck && pnpm run lint && pnpm run fmt:check && pnpm run build && pnpm run test && pnpm run verify:dist`

typecheck ✓ / lint ✓ / fmt:check ✓ / build ✓ / **test 1478 passed, 6 skipped, 0 failed**(80 个文件)/
verify:dist exit 0,29/29 ✓。

## 下一轮的开口(未闭环,不是 finding 已关闭)

- **上游的用户说明页 `docs/engineering/code-review.md` 没有搬** —— 刻意,理由记在
  `docs/agents/code-review-upstream.md` 的「刻意偏离上游」表里。
- **`docs/reviews/2026-09-29-ocr-rule-coverage-audit.md` 的 C-9 仍写「21 篇 ADR」** —— 那是当时的
  值,属历史快照,按 `tests/doc-integrity.test.ts` 的规范 / 快照分界**不改**;F-2 是它的续集,已由
  新的 fixture 挡住复发。
- **上游基线是手工维护的** —— `docs/agents/code-review-upstream.md` 记着基线 commit 与逐条裁决,
  `pnpm run check:code-review-upstream` 会在上游再动时变红。但闸门**不进默认门禁**(它要联网),
  挂在发布前的手动检查位。

## 后续闭合(本节的口子已不在上面那份开口清单里)

- **`.opencodereview/rules/doc-sync.md` 第 4 条写「当前 1.1.0」,而 `package.json` 是 5.0.1** ——
  本轮没修(它落在 OCR 规则文件里,与本轮边界不同,不顺手改),**已由更新本账本的这次提交一并闭合**:
  括号里写死的版本号改成「以 `package.json` 的 `version` 为准,`CHANGELOG.md` 里有同名条目」,并写明
  **别在规则里写死当前版本号**。规则正文一条没动。
  同期扫了全仓同一类漂移(规则文件里写死的「当前 N」):**只有这一处**。其它命中 `1.1.0` 的地方都是
  **pi 宿主**的版本("pi 1.1.0 session"、兼容矩阵的列),与本包版本无关,不能一起改。

## Stop

单轮。理由是本仓库自己的停止条件:本轮改的是**评审工具链与文档**,不触及 `src/`,产品行为零改变;
16 组变异全部转红即闭环证据;第二轮能产出的只会是措辞打磨。账本本身按 AGENTS.md「文档 / ADR 漂移」
的口径维护——它不进规范文档的断言面,只作记录。

本轮之后另有一次提交闭合了开口清单里的一条(见上「后续闭合」),那是**一次修复,不是第二轮评审**。
