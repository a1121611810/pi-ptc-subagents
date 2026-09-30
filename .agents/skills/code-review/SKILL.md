---
name: code-review
description: >
  审查 git diff(固定点到 HEAD)的双轴 code review(Standards + Spec),基于 open-code-review(OCR 负责确定性工程 — 文件选择 + per-file 规则解析 + spec 上下文注入 + 全文件契约扫描;host agent 负责 LLM 决策) + CodeGraph 符号索引(blast radius 机器证据) + 项目特定 audit 规则(`.opencodereview/rule.json` 锚定的 ptc-protocol / ptc-worker-lifecycle / ptc-bgdispatch / ptc-render-bounds / ptc-config-wiring / test-discipline / doc-sync,以及 catch-all 兜底 general.md)。spec 轴强制「翻转/接口变更的调用点完备性审计」(blast radius review,CodeGraph 证据)、「声明驱动关系的输入源接线审计」(读点证据,对抗 silent misconfiguration)、测试「期望值溯源」(Oracle check,反事实判据 + 6 条 testing-constraints);OCR 升级规则:命中阻塞级规则必升级到 delegate 复核并同时开 `--effort high --no-filter` 召回旋钮(precision 优势无法补偿 recall 缺失)。健康门禁用全树 `ocr delegate rule` 覆盖检查(任一 src 文件落到 system built-in 即失败)。项目级 skill,按加载优先级遮蔽全局同名 skill。
license: Apache-2.0
compatibility: >
  Requires `ocr` CLI (open-code-review >= 1.9) and `codegraph` CLI installed and
  initialized for this repo. Degradation channel (grep + explicit evidence commands)
  kicks in if either is missing — degrades to candao-style audit 1/2 with no audit 3.
---

# Code Review(PTC pi-ptc-subagents · thin orchestrator · OCR delegate + CodeGraph)

对 `git diff <fixed-point>...HEAD`(three-dot,基于 merge-base)的双轴审查:**Standards**(仓库文档化标准 + Fowler smell baseline)与 **Spec**(忠实实现源起 issue/PRD/spec)。**OCR 决定看哪些文件、用什么 checklist**;**我们决定这些文件意味着什么**;**CodeGraph 提供 blast radius 机器证据**。

## 为什么存在这个版本

四个来源,缺一不可:

1. **OCR 是 deterministic engineering 工具**:它的 `delegate` mode 把 file selection + rule resolution 当作硬约束,不靠 LLM — 不会漏文件、不会审错对象。host agent 才能专注在 LLM 决策(这句话意味着什么)。
2. **AI 生成测试会迎合实现**(Oracle 缺陷,详 `.opencodereview/rules/test-discipline.md`)。'测试全绿' 不证明 '测试正确' — 期望值必须能指向独立来源(spec 行号 / 真实样例 / 字面量 / 不变量 / 差分)。dispatch-e2e 实证:`expect(...).toMatch(/^(fulfilled|rejected)$/)` 接受两者 = 测试是 characterization(防回归)而非 specification(防错误)。
3. **AI 执行会跳过或假装完成**。措辞是弱强制;硬指令(brief 注入)、机器证据(CodeGraph、grep 输出、未截断计数)、'声称成功无效' 纪律才是硬强制。
4. **平台契约层对 diff 评审结构性失明**。pi-ptc 的 audit 3a(协议 paired-correctness)、3b(worker lifecycle)、3c(render bounds)是 silent failure 源 — 改一处忘了改另一处 = 静默 wrong behavior。OCR 系统默认规则不知道这些,需要 `.opencodereview/rule.json` 项目规则覆盖。

## 流程

1. **Pin fixed point**:用户给定 commit/branch/tag/`main`/`HEAD~N`。确认 `git rev-parse` 可解析、diff 非空。bad ref 或空 diff 在此失败,不进入 sub-agent。
2. **Identify spec source**(Spec 轴的前提,顺序不可换):
   ① commit message 的 issue 引用(`#123`)→ 经 `docs/agents/issue-tracker.md` 用 `gh` 取正文与验收条件;
   ② 用户传入的路径;③ `docs/specs/`、`docs/adr/` 下与分支/功能匹配的文档;
   ④ 都不命中 → **询问用户**,不得默认挑一份最像的 ADR。
   取到的 spec 正文(含验收条件)存成临时 Markdown,然后**注入 OCR**(第 3 步的 `--background-file`)。无 spec 时 Spec 轴只输出 `no spec available` + Standards 轴结果并注明依据,**禁止用实现反推生成 spec**。
3. **Health gate**:
   - `codegraph status` — 必须 "Files / Nodes / Edges" 都非零。失败 → 退化通道(见下方)。
   - `ocr --version` — 必须 >= 1.9.0。
   - **规则覆盖门禁(全树,不是单文件)**:`ocr rules check <file>` 只验一个文件,发现不了漏网;必须跑批量覆盖:
     ```bash
     ocr delegate rule --format json $(git ls-files 'src/*.ts') | python3 -c "import json,sys;d=json.load(sys.stdin);bad=[f for g in d['groups'] if 'built-in' in g.get('source','').lower() or g.get('source')=='system' for f in g['files']];print('SYSTEM-ONLY:',bad);sys.exit(1 if bad else 0)"
     ```
     必须无输出且退出码 0。**任一 src 文件落到 system built-in = 门禁失败**——本仓曾有 7 个(含 `limits.ts`,全仓 limit 声明源)裸奔,拿到的全是 React/JS 通用样板(`React Best Practices` / `prohibiting var` / `== is prohibited`)。
   - rule.json 的 schema、**first-match-wins 顺序语义**、`merge_system_rule` 取舍、新锚点模板:详 `docs/agents/ocr-rules.md`(rule.json 是 JSON,**没有**头部注释可读)。
4. **OCR 文件选择 + per-file 规则**:
   ```bash
   ocr delegate preview --format json [--from <ref> --to <ref>] [--commit <hash>] [--background-file <spec.md>]
   ocr delegate rule --format json <preview 输出里的 reviewable_files 路径>
   ```
   输出 JSON:每个文件被分配到一个 group,group 含 (source, pattern, rule text)。project rule 优先,系统规则兜底。`--background-file` 把 spec 正文作为需求上下文注入,这是 Spec 轴「独立来源」的唯一合法管道。
   **注意 `.md` 的解析层与选择层是分裂的**:`.md` 在**解析层**正常(`ocr rules check` / `ocr delegate rule` 对 .md 返回 project group),但在**选择层**被丢弃——`ocr delegate preview`、`ocr review`、**`ocr scan`** 三条路径都把每个 `.md` 标成 `will_review: false` + `exclude_reason: unsupported_ext`(实测:`ocr scan --preview` 列 70 个 .md,`will_review: true` 的有 **0** 个)。`tests/**` 是另一条独立排除(`exclude_reason: default_path`),只有显式传路径才解析。**结论:文档 / ADR / README / CI workflow 无法委托给 OCR,只能由 host agent 手动套用对应 checklist(见第 8 步)。**
5. **CodeGraph blast radius 机器证据**(仅对 spec 轴 audit 1):
   ```bash
   codegraph explore <每个 reviewable 文件的核心符号>   # 一把出源码 + 调用路径 + ⚠️ 警告
   codegraph callers <符号>                          # 5 个以上 callers 时拿总计数再下钻
   ```
   CodeGraph 不可用时退化为 grep:见下方「退化通道」。
6. **并行 spawn 两个 sub-agent**(general-purpose 或本仓库 ptc_run_code / ptc_workflow sub-agent):
   - **Standards 轴**:对照 AGENTS.md + 测试硬约束 6 条(`docs/testing-constraints.md`)+ `docs/adr/`(21 篇 ADR)+ catch-all 兜底规则 `.opencodereview/rules/general.md`(Fowler 12 条 baseline + 触发式维度表已实体化在那里)。
   - **Spec 轴**:OCR 拿到的 per-file rule groups 当 checklist;每个文件按 checklist 走。audit 1(blast radius)用 CodeGraph 证据;audit 2(Oracle check)用反事实判据 + 6 条硬约束;声明驱动关系按 `ptc-config-wiring.md` 的读点纪律走。
     Spec sub-agent brief **必须**逐字包含下方「Spec 轴强制增量」全部指令原文。
7. **升级判定**(Q9-D hook):若 spec 轴的某个 finding 命中**阻塞级规则**(见下方),自动升级 — 该文件用 delegate mode 重新审一遍(我们的 sub-agent 而非 OCR DeepSeek-flash),**并同时开 OCR 的召回旋钮**(见下方升级机制的命令)。
8. **文档 / ADR / 门禁契约审计**(host agent 亲自跑,OCR 委托不了):
   `.md` 与 `.yml` 在 OCR 选择层不可见(见第 4 步),所以这一类**不能**用 `ocr review` / `ocr scan`。做法:
   ① 显式枚举本次 diff 触及的文档路径,自己传进解析层拿 checklist:
   ```bash
   ocr delegate rule --format json <diff 触及的 .md 路径...>   # 解析层对 .md 正常,返回 project group
   ```
   ② 由 host agent / sub-agent 按 `doc-sync.md` 的 8 条必查项逐条走 —— ADR 状态机与索引、ADR 声明→`src/` 读点双向对照、CHANGELOG、CONTEXT.md 词条、`docs/reviews/` 账本四元对齐、行号/链接/常量漂移、整跑发布门禁。
   ③ `scripts/**` 与 `.github/workflows/**` 同理:它们是 `.mjs` / `.yml`,前者能进 `ocr review`,后者不能。
9. **汇总**:两轴分列,不合并不重排,结尾一行各轴 finding 数 + 最严重项 + 升级条目数 + SYSTEM-ONLY 门禁结果。

## Spec 轴强制增量(阻塞项)

### 共享强制机制(子代理必须执行)

- **必须+禁止配对**:不留灰色地带。
- **brief 注入**:Spec sub-agent brief **必须**逐字包含下方 audit 1、audit 2 全部指令原文 — 不缩写、不 '酌情执行'。
- **证据要求 + 声称成功无效**:claim "已枚举/已溯源" 必须配 grep 输出或 CodeGraph 命令结果 + 未截断计数。**不信任 agent 自述**。
- **反事实判据**:每个测试断言都要走 — '把实现改成显然错误但符合该断言的版本,测试会红吗?' 否 = finding。
- **characterization 识别**:只是 '当前行为' 锁定(快照、从实现抄)的期望值是 characterization(防回归)而非 specification(防错误) — 不能作为 '实现正确' 证据。

### Audit 1 · 调用点完备性(blast radius)

**触发信号**(命中任一即触发):默认值改动、export 删除/收窄、签名变化、参数 optional→required、错误模型变化、排序假设变化、配置语义变化。

**要求**:用 `codegraph explore` 列出该接口全部调用点,逐一标注 已迁移 / 不受影响(说明理由) / 遗漏。**遗漏 = 阻塞 finding**。禁止 'diff 中没出现其他调用点' 作为完备性证据。

**退化通道**(CodeGraph 不可用):`grep -rn '<symbol>' --include='*.ts' src/ tests/`(必须输出未截断计数 + 双形态检索:函数名 + 全大写常量名)。

### Audit 2 · 期望值溯源(Oracle check)

**触发信号**:diff 含新增或修改的测试(以 `tests/**/*.test.ts` 路径识别,OCR 已自动归类到 `.opencodereview/rules/test-discipline.md` 或 `test-discipline-oracle.md`)。

**要求**:

1. 逐条判定每个断言期望值的来源 — 仅以下合法:规格行号 / ticket 验收 / 真实数据 / 字面量 / 不变量 / 差分。
2. 命中 `.opencodereview/rules/test-discipline.md` 列出的 F1/F2/F3 模式 = 阻塞 finding。
3. 命中 `test-discipline-oracle.md` 列出的 T1/T2/T3/T4 模式 = 阻塞 finding(dispatch 系列)。

## host agent 保留职责(OCR 补不了的三类)

其余纪律已经下沉到 OCR:per-file checklist 由 `.opencodereview/rules/*.md` 承载,Fowler baseline 与维度表由
`general.md` catch-all 承载,spec 上下文由 `--background-file` 注入。**文档/ADR/CI 例外**——`.md` 与 `.yml` 在 OCR 选择层不可见,`doc-sync.md` 必须由 host agent 手动套用(它只经解析层投递,不进任何 OCR 自动路径)。
剩下这三类**只能由 host agent 做**,因为它们是判断与证据纪律,不是文件级检查表:

1. **机器证据规范(CodeGraph 侧)**:`codegraph explore` 输出必须核对**完整性**——是否覆盖全部调用路径、是否被截断;
   任何截断必须显式收窄范围重查(拆细符号、限定文件),**禁止把截断集当完备性证据**。grep 必须出示**未截断计数或完整清单**。
   再问一次**值流**:调用图证明不了「什么值流进了什么参数」,三元分支/变量间接传参必须人工过一遍。
2. **声明—读点对照的报告格式**:Spec 轴报告必须为每条「由 Y 驱动」输出对照行
   `声明(引用 spec/ADR 行号) | Y 的读点证据(file:line) | 判定(已接线 / 未接线-阻塞 / 显式挂账+issue 号)`。
   禁止静默;无法给读点又无法立即修复时,唯一合法退路是**显式挂账**(订正文档到交付现状 + 建 follow-up issue,报告引用 issue 号),
   「后续处理」字样不算(本仓正面先例:`src/runtime/turn-pools.ts:51-62` 记录了 per-run override 在池化路径上失效)。
3. **升级裁决**:谁在什么时候判定「阻塞 → 升级」是编排决策,包括是否值得为某条 finding 烧 `--effort high` 的 token 预算。

## 阻塞级规则清单(Q8 纪律)

**唯一事实源是 `.opencodereview/rule.json`,本文件不再手抄清单。** 手抄过一次就漏过一次:
`ptc-bgdispatch-contract.md` 曾整条缺席,而它恰恰是 rule.json 里锚定最多的一组(覆盖 dispatch / dispatcher /
background-runtime / notification-pipeline / child-process-lifecycle / bindings / index 等入口),
连带 Q9-D 升级对它从未触发过。

判定口径:某文件解析出的 per-file group 的 rule 文本里,标了「阻塞级」或「PR 阻塞」的条目即为该文件的阻塞清单,
`ocr delegate rule --format json` 直接给出。命中 → PR 阻塞 + 自动升级到 delegate 复核(Q9-D hook)。

当前契约规则(改 rule.json 后此处必须同步,`tests/ocr-anchor-coverage.test.ts` 兜底):

| OCR 规则文件                       | 审计对象                      | Q9-D 升级                                               |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `ptc-protocol-pair-correctness.md` | 3a 协议成对正确性             | 是(silent drift)                                        |
| `ptc-worker-lifecycle.md`          | 3b worker 状态机              | 是                                                      |
| `ptc-bgdispatch-contract.md`       | 3d 后台派发契约               | 是                                                      |
| `ptc-config-wiring.md`             | 声明驱动关系 / 读点证据       | 是(silent misconfiguration)                             |
| `ptc-render-bounds.md`             | 3c 渲染上限 / 截断契约        | **否** — visual contract,规则文件明确写「不升级」       |
| `test-discipline.md`               | F1/F2/F3                      | 是                                                      |
| `test-discipline-oracle.md`        | T1-T4(dispatch 系列)          | 是                                                      |
| `doc-sync.md`                      | ADR / 文档 / 账本漂移         | 是(**host agent 手动套用**,`.md` 不进任何 OCR 自动路径) |
| `general.md`                       | catch-all 兜底(Fowler + 维度) | 否(judgement call)                                      |

**升级机制**:spec 轴报出 "阻塞级 finding" → skill 编排端立即重新调 `ocr delegate rule` 拿该文件 checklist →
用本仓库 ptc_run_code sub-agent 而非 OCR DeepSeek-flash 二次审。协议 drift、worker 状态、test discipline、
配置未接线都是 silent failure,OCR precision 优势无法补偿 recall 缺失。

**升级时同时开 OCR 的召回旋钮**——只换 sub-agent 不够,这几个开关才是直接作用在 recall 上:

```bash
ocr review --from <base> --to HEAD --background-file <spec.md> \
           --rule .opencodereview/rule.json \
           --effort high --no-filter --max-tools 80 \
           --audience agent --format json
```

`--no-filter` 关掉 LLM 后置过滤(后置过滤正是 recall 的杀手,阻塞级 finding 恰是被它滤掉的那类);
`--effort high` + `--max-tools` 提高每组深度与工具轮数;`--audience agent` 纯摘要输出,直接喂 host agent。
跨轮续审用 `--resume <session-id>`,两轮 finding 差异用 `ocr session compare` 机械对比——不要靠记忆。

## 触发式维度卡点(命中才强制;tooling 已强制的不报)

**载体已迁到 `.opencodereview/rules/general.md`**(catch-all 兜底层),那里有完整的 5 维表:
错误处理与日志 / 多轨·兜底·降级设计 / 性能 / 数据迁移与 schema / 安全与隐私。
逐文件走 checklist 时以 OCR 下发的 general.md 文本为准,本表只作索引:

| 维度                   | 触发信号                               | 承载规则                                                           |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| 错误处理与日志         | IO 边界 / 失败路径 / 降级路径          | `general.md` + `docs/testing-constraints.md` 约束 #3               |
| 多轨 / 兜底 / 降级设计 | 双轨降级、迁移期新旧键双读、独立计数器 | `general.md`;输入源缺读点转 `ptc-config-wiring.md`                 |
| 性能                   | 热路径 / 大输出 / 大列表               | `general.md`(本仓 `maxOutputBytes` 是 67 MB 量级)                  |
| 数据迁移与 schema      | 枚举转换 / 键迁移 / backfill           | `general.md`                                                       |
| 安全与隐私             | 子进程环境 / argv / 日志 / 渲染        | `general.md`(`WORKER_ENV_ALLOW_LIST` 之外不得进 worker)            |
| 并发 / 竞态            | 并行代码 / 定时器 / 共享状态           | 只能人审:仔细读并发逻辑,跑不出来                                   |
| 依赖                   | 新增/替换依赖                          | `general.md`                                                       |
| 文档同步               | 改变构建/测试/使用方式/契约            | `doc-sync.md`(**host agent 手动套用**,`.md` 不进任何 OCR 自动路径) |
| UI / 用户可见变更      | 用户可见行为变化                       | `doc-sync.md` + 人工走查(只读代码看不出体验)                       |

## Standards 轴

**发现的来源**(优先于 baseline):`AGENTS.md`、`docs/testing-constraints.md`、`docs/adr/`(21 篇 ADR)、README、`CONTEXT.md`。

Fowler smell baseline **12 条已实体化在 `.opencodereview/rules/general.md`**(每个读「是什么 → 怎么修」),
并随 catch-all 锚下发给每个未被专用契约规则命中的文件——不再依赖「见原版」这种拿不到文件的引用。
**三条绑定**:① 仓库文档化标准优先,压制 baseline 标记;② baseline 永远是 judgement call,标 'possible X',非硬违规;
③ 跳过 tooling 已强制的项(oxlint / oxfmt / `pnpm typecheck`),也不报与本次 diff 无关的历史债。

## 双轴汇总

两轴报告分列 `## Standards` / `## Spec`,不合并、不重排。结尾一行:每轴 finding 数 + 最严重项 + **升级条目数**(Q9-D 触发的 delegate 复核数)。不选 winner。

## 仓库锚点(overlay 层)

- **审计 1(blast radius)**:CodeGraph(`codegraph explore` / `codegraph callers`),索引健康 `codegraph status`。
- **审计 2(Oracle check)**:`.opencodereview/rules/test-discipline.md`(F1/F2/F3)+ `test-discipline-oracle.md`(T1/T2/T3/T4)+ `docs/testing-constraints.md`(6 条硬约束)。
- **audit 3(平台/宿主契约)**:`.opencodereview/rules/ptc-protocol-pair-correctness.md`(3a)/ `ptc-worker-lifecycle.md`(3b)/ `ptc-bgdispatch-contract.md`(3d)/ `ptc-render-bounds.md`(3c)+ ADR-0017(worker 状态机)+ ADR-0022/0023(派发与归属)+ ADR-0015(截断契约)+ ADR-0013(row compact summary)。
- **声明驱动关系 / 读点证据**:`.opencodereview/rules/ptc-config-wiring.md`(锚 `limits.ts` / `turn-pools.ts`)+ `docs/research/` 下的调研材料。
- **文档与 ADR 漂移**:`.opencodereview/rules/doc-sync.md` + `docs/adr/README.md` 索引 + `docs/reviews/` 账本。
- **OCR 工具链**:`~/.opencodereview/config.json`(已配 deepseek-flash)+ `.opencodereview/rule.json`(项目规则)**作者手册 = `docs/agents/ocr-rules.md`**(schema / first-match-wins / merge 语义 / 文件类型覆盖 / 新锚点模板)。
- **fixture**:`tests/test-meta-discipline.test.ts` 自动扫 F1/F2/F3;`tests/ocr-anchor-coverage.test.ts` 自动扫孤儿规则、悬空锚点、catch-all 错位与 `Source: Project` 回归。

## 退化通道

### CodeGraph 不可用

audit 1 退化为 grep,纪律不变:

```bash
grep -rn '<symbol>' --include='*.ts' src/ tests/   # 未截断计数
grep -rn '<SYMBOL_CONST>' --include='*.ts' src/ tests/   # 双形态:函数名 + 全大写常量
```

在 spec 轴报告头标注 `codegraph unavailable, fallback to grep`,brief 模板里 `codegraph explore` 替换为 grep。

### OCR 不可用 / rule.json 加载失败

audit 3 整体失效 — spec 轴只跑 audit 1 + audit 2;standards 轴不受影响(走 AGENTS.md + testing-constraints.md + ADR)。在 spec 轴报告头显著标注 `OCR unavailable, audit 3 disabled`。

### 子代理失败

若 spec/standards sub-agent 任务失败:

1. 读取已收证据(即便未产出最终报告)。
2. 父级以已收证据 + 直接 grep 验证补全。
3. **必须**显著标注 '父级补全,非 sub-agent 原始产出'。

## 为什么双轴

一个改动可以只过一轴:符合全部规范但实现错了东西 → Standards 过、Spec 挂;忠实实现 issue 但破坏仓库约定 → Spec 过、Standards 挂。分列报告防止一轴掩盖另一轴。
