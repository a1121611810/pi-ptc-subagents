# 截断策略：砍头留尾 → 头尾保留、中间省略

Status: accepted (2026-11-11)。修订旧 ADR-0015 的**保留策略**；契约值不动。

## Context

Kimi 面实测痛点：模型用 `ptc_run_code` 做扇入（批量 grep/read 几十个文件）时，结果超 50KB/2000 行被截断——旧策略**只留尾、砍头**，最先的命中、开头的错误栈整段丢失，模型被迫用宿主 Read 回读 /tmp 全文（Kimi 面工具描述当时对截断只字未提，连回读协议都没有）。

横评六个 harness 后确认纯留尾是少数派：

- **omp**（oh-my-pi）：中间省略（head 窗口 + rolling tail 窗口，标记 `[…123ln elided…]`），字节切点 UTF-8 边界对齐；
- **pi codemode**：超预算文本块折叠成一块——头+尾保留，中间换 token 数，全文 spill tmpfile 并叫模型 offset/limit 读；
- **Codex**（~10KiB/256 行）、**Reasonix**（历史 read 剪短：头 120 行 + 尾 12 行）：均头尾保留；
- **pi 内建工具**：read 保头（offset/limit 续读）、bash 保尾（流式最新）——bash 保尾合理，结果文本不是流式，不适用；
- **zcode**（token 上限）、**DSH**（三层单位不同）、**Kimi Code**（Read 字符预算 + 续读协议）：上限单位各异，但**契约全写进工具描述**是所有家的共同做法。

## Decision

**1. 保留策略改「头尾两窗、中间省略」。** 行预算 2000 拆为头 500 + 尾 1500（`TRUNCATION_HEAD_LINES/TAIL_LINES`）；标记行位于头窗与尾窗之间：`…（已截断：省略第 X–Y 行 / M 字节，全文在 PATH）`——X/Y 是算好的 1-based 省略行范围，模型按它 `Read(path, offset=X, n_lines=Y-X+1)` 一把精准捞回。结构为「头窗 + 标记行 + 尾窗」三段拼接（omp 同构），不再整段压顶。

**2. 收缩顺序：交替对半缩，先动尾窗前沿、再动头窗后沿。** 字节预算吃紧时尾窗从前沿砍半（`slice(ceil(n/2))` 留尾段）、头窗从后沿砍半（`slice(0, floor(n/2))` 留头段）——**尾窗尾部锚定**：程序返回值渲染在拼接末尾，最后几行必须活到最后。两窗各剩 1 行仍超预算（病态输入）落入字节兜底。

**3. 巨行字节兜底：头 25% + 尾 75% 切分，切点对齐 UTF-8 字符边界。** 旧逻辑按字节留尾切单行会在半字符处断开（`Buffer.toString` 吐 U+FFFD）；新增 `findUtf8BoundaryForward/Backward`（各 6 行，零依赖，风格同 `text.ts` 的代理对检查），被拆的字符整体让进省略区。触发条件不变：行数 ≤2000 但字节超 50KB（巨行/单行 JSON/base64）。

**4. 上限值不动。** 50KB/2000 行是 pi 的「Tools MUST truncate」契约值（floor pi 无此导出，本地持有），一个数都不改。zcode 的 token 单位与 DSH 的 token spill 是合理替代，但换单位对本仓无实际收益（引擎零依赖，不搬 token 估算）。

**5. 恢复协议写进模型面。** pi 面与 Kimi 面的 `ptc_run_code` 工具描述各加一句截断契约（保留头尾/标记行给行范围与全文路径/按行范围 read 回读）；Kimi 面 SKILL.md 扩成三条协议（先看头尾→按行范围精准回读→能归约先归约）；`ptc_task_output` 的分层引导同步改措辞。散文全进 routes/docs（ADR-0013）；footer 模板留在 `truncate.ts`（tui 根是零依赖叶子，不能依赖 routes，与既有「（无完成值）」同属 grandfathered 文本零件）。

## Consequences

- 收益面一处改三面治好：`renderToolResult`（ptc_run_code / ptc_workflow，pi + Kimi）、`ptc_task_output` 的孩子正文、program 型子代理信封（`task/src/output.ts` 同函数）。
- 头 500/尾 1500 未经 A/B，取「头够定位、尾多保命」直觉比例；要调走新 ADR。
- 「先缩尾窗」意味着极端字节压力下头窗先变短——以尾部锚定（保返回值）优先，属登记在案的取舍。
- 测试按变异标准重写（`tests/output/result-text.test.mjs`）：只留尾/只留头/标记数字撒谎/收缩顺序写反（120B/行输入使两序分歧：头 125 vs 62）/UTF-8 半字符/footer 在但全文没写盘/行数超限，每个变异点有独立杀死的断言；人工注入三组变异验证探针必红。过程中修掉一个探针自身的假阳性：output 包 dist 内联 tui 副本，只重建 tui 会让变异冒烟误判——冒烟必须根构建。

## Verification

- `pnpm test` 256 条全绿（pi 200 / output 8 / kimi 35 / standalone 13）+ 逐文件单跑 fails=0；四件套（tsrs / rolldown / oxlint / oxfmt）全绿；产物 import 门禁绿。
- 变异冒烟：头窗归零 / 收缩顺序写反 / 边界函数删除三注全红，恢复后全绿。
- Kimi 面真机冒烟：装配产物跑 >50KB 程序，头尾标记行在、标记行范围对、按范围 Read 捞回中间段。

## See also

- [ADR-0015](./0015-the-route-index-and-its-detail-files.md) —— 被本篇修订的旧截断契约（值仍在册，策略被本篇取代）。
- [ADR-0016](./0016-render-bounds-cleanup.md) —— 渲染预算冻结表的修订先例（改在册值须新 ADR）。
