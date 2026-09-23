---
name: code-review
description: >
  审查 git diff(固定点到 HEAD)的双轴 code review(Standards + Spec),基于 open-code-review delegate mode(OCR 负责确定性工程 — 文件选择 + per-file 规则解析;host agent 负责 LLM 决策) + CodeGraph 符号索引(blast radius 机器证据) + 项目特定 audit 规则(`.opencodereview/rule.json` 锚定的 ptc-protocol / ptc-worker-lifecycle / ptc-render-bounds / test-discipline)。spec 轴强制「翻转/接口变更的调用点完备性审计」(blast radius review,CodeGraph 证据)、测试「期望值溯源」(Oracle check,反事实判据 + 6 条 testing-constraints);OCR 升级规则:命中 audit 3a/b 或 test-discipline-oracle 必升级到 delegate 复核(OCR DeepSeek-flash precision 优势无法补偿 recall 缺失)。项目级 skill,按加载优先级遮蔽全局同名 skill。
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
2. **Health gate**:
   - `codegraph status` — 必须 "Files / Nodes / Edges" 都非零。失败 → 退化通道(见下方)。
   - `ocr --version` — 必须 >= 1.9.0。
   - `ocr rules check <任意本仓库文件>` — 必须返回 `"Source": "Project (.opencodereview/rule.json)"` 或系统兜底;若所有文件都返 "Source: System built-in" 提示用户检查 `.opencodereview/rule.json` 路径与 schema(详 `.opencodereview/rule.json` 头部注释)。
3. **OCR 文件选择 + per-file 规则**:
   ```bash
   ocr delegate preview --format json [--from <ref> --to <ref>] [--commit <hash>]
   ocr delegate rule --format json <preview 输出里的 reviewable_files 路径>
   ```
   输出 JSON:每个文件被分配到一个 group,group 含 (source, pattern, rule text)。project rule 优先,系统规则兜底。
4. **CodeGraph blast radius 机器证据**(仅对 spec 轴 audit 1):
   ```bash
   codegraph explore <每个 reviewable 文件的核心符号>   # 一把出源码 + 调用路径 + ⚠️ 警告
   codegraph callers <符号>                          # 5 个以上 callers 时拿总计数再下钻
   ```
   CodeGraph 不可用时退化为 grep:见下方「退化通道」。
5. **并行 spawn 两个 sub-agent**(general-purpose 或本仓库 ptc_run_code / ptc_workflow sub-agent):
   - **Standards 轴**:对照 AGENTS.md + 测试硬约束 6 条(`docs/testing-constraints.md`)+ `.opencodereview/rules/general.md` + Fowler smell baseline。
   - **Spec 轴**:OCR 拿到的 per-file rule groups 当 checklist;每个文件按 checklist 走。audit 1(blast radius)用 CodeGraph 证据;audit 2(Oracle check)用反事实判据 + 6 条硬约束。
     Spec sub-agent brief **必须**逐字包含下方「Spec 轴强制增量」全部指令原文。
6. **升级判定**(Q9-D hook):若 spec 轴的某个 finding 命中**阻塞级规则清单**(见下方),自动升级 — 该文件用 delegate mode 重新审一遍(我们的 sub-agent 而非 OCR DeepSeek-flash)。
7. **汇总**:两轴分列,不合并不重排,结尾一行各轴 finding 数 + 最严重项 + 升级条目数。

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

## 阻塞级规则清单(Q8 纪律)

命中下表任一规则 → PR 阻塞 + 自动升级到 delegate 复核(Q9-D hook):

| OCR 规则路径                                             | 触发 finding 类型                                         |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `.opencodereview/rules/ptc-protocol-pair-correctness.md` | 协议漂移 / 字面量硬编码 frame kind                        |
| `.opencodereview/rules/ptc-worker-lifecycle.md`          | 状态机无守卫 / drain 会 hang / signal 缺 grace            |
| `.opencodereview/rules/ptc-render-bounds.md` (严重级)    | 截断静默 / 无 `truncated` 标记                            |
| `.opencodereview/rules/test-discipline.md`               | F1/F2/F3(accept-both / conditional / opt-in early-return) |
| `.opencodereview/rules/test-discipline-oracle.md`        | T1/T2/T3/T4(dispatch 系列,以及 F1/F2/F3 继承)             |

**升级机制**:spec 轴报出 "阻塞级 finding" → skill 编排端立即重新调 `ocr delegate rule` 拿该文件 checklist → 用本仓库 ptc_run_code sub-agent 而非 OCR DeepSeek-flash 二次审 — 因为 protocol drift、worker state、test discipline 都是 silent failure,OCR precision 优势无法补偿 recall 缺失。

## 触发式维度卡点(命中才强制;tooling 已强制的不报)

| 维度      | 触发信号                     | 必查项                                                    |
| --------- | ---------------------------- | --------------------------------------------------------- |
| 错误处理  | IO 边界 / 失败路径           | 成功/失败双路径;失败有 warn 或显式错误状态;不留静默失败   |
| 并发/竞态 | 并行代码 / 定时器 / 共享状态 | 仔细读并发逻辑(人审),跑不出来                             |
| 依赖      | 新增/替换依赖                | 必要性、来源可信                                          |
| 文档同步  | 改变构建/测试/使用方式       | README / AGENTS.md / `.opencodereview/rule.json` 同步更新 |

## Standards 轴

**发现的来源**(优先于 baseline):`AGENTS.md`、`docs/testing-constraints.md`、`.opencodereview/rules/general.md`、`docs/adr/`(18 个 ADR)、README。

Fowler smell baseline(每个读 '是什么 → 怎么修',见 candao/pixivizer 原版)。**两条绑定**:仓库文档化标准压制 baseline;baseline 永远是 judgement call,标 'possible X',非硬违规。

## 双轴汇总

两轴报告分列 `## Standards` / `## Spec`,不合并、不重排。结尾一行:每轴 finding 数 + 最严重项 + **升级条目数**(Q9-D 触发的 delegate 复核数)。不选 winner。

## 仓库锚点(overlay 层)

- **审计 1(blast radius)**:CodeGraph(`codegraph explore` / `codegraph callers`),索引健康 `codegraph status`。
- **审计 2(Oracle check)**:`.opencodereview/rules/test-discipline.md`(F1/F2/F3)+ `test-discipline-oracle.md`(T1/T2/T3/T4)+ `docs/testing-constraints.md`(6 条硬约束)。
- **audit 3(平台/宿主契约)**:`.opencodereview/rules/ptc-protocol-pair-correctness.md` / `ptc-worker-lifecycle.md` / `ptc-render-bounds.md` + ADR-0017(worker 状态机)+ ADR-0015(截断契约)+ ADR-0013(row compact summary)。
- **OCR 工具链**:`~/.opencodereview/config.json`(已配 deepseek-flash)+ `.opencodereview/rule.json`(项目规则,详 header 注释)。
- **fixture**:`tests/test-meta-discipline.test.ts` 自动扫 F1/F2/F3。

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
