# bench/kimi-ab — Kimi 面（MCP 插件）引导 A/B 台架

验证问题：加强引导（SKILL.md 检查表 + 结果经济学 footer）能否提升 `ptc_run_code` / `web_ds_search` 的模型主动采用率，且不以质量和过度触发为代价。

## 铁律

- 结论只准引用本宿主（Kimi Code + 本插件）数据；pi 面数字不进报告。
- 判分客观优先（每题 `grade.mjs` 隐藏断言），LLM judge 不用。
- 每题 × 每臂 × n=3；一次通过不算数。

## 基线（2026-10-31，插件 2026-10-28 装进真机）

来源：`node scripts/adoption-mining.mjs --since 2026-10-28T00:00:00Z`（扫 `~/.kimi-code/server/events/`，桌面端日志）

| 指标                         | 数字                        |
| ---------------------------- | --------------------------- |
| 有调用的会话                 | 14 场（用过插件的仅 2 场）  |
| 总工具调用                   | 2250                        |
| ptc_run_code / web_ds_search | 3 次 / 1 次（采用率 0.18%） |
| 内置 WebSearch+FetchURL      | 45 次                       |
| 错过批量机会（启发式，量级） | 53 段 ≈ 345 次逐个调用      |

⚠️ 「错过机会」是同形态连续 ≥5 的启发式，探索式探针会误报，只当量级看。

## 宿主事实（阶段 0，2026-10-31 查证）

1. MCP 工具默认直接进模型顶层工具表，与内置工具同权（[官方 MCP 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)；`deferred` 按需加载是实验功能且默认关）。
2. 无并行工具调用：两场桌面会话 1265 次调用、时间戳差 <300ms 同批对数为 0，每调用独占一个 step ⇒ 本宿主上 `ptc_run_code` 是唯一的批量通道。
3. `kimi -p` 无头模式（2.1.1 实测）完整加载插件：MCP server 连接、`plugin_session_start` 注入、`ptc_run_code`/`web_ds_search` 进工具表。⇒ 本台架全脚本化，但**无头会话的调用记录写 `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`，不在 server/events**——复跑统计要两口径都扫。

## 两臂

- **A 臂** = `ef09ddb`（当前 HEAD：量化触发句 + web_ds_search 去降格，两行新描述）
- **B 臂** = A + P1（SKILL.md 检查表 + 反例）+ P2（renderResult 经济学 footer）

## 题集（tasks/，每题 meta.expected 标期望工具形态）

| 题             | 期望                       | 测什么                                   |
| -------------- | -------------------------- | ---------------------------------------- |
| batch-read     | ptc                        | 24 文件读+归约（统计 TODO/行数出汇总表） |
| batch-edit     | ptc                        | 24 文件同形态批量改（≥5 文件）           |
| grep-aggregate | ptc                        | 全库扫描出清单（读 ≥20 文件归约）        |
| fact-search    | web_ds_search 或 WebSearch | 联网单查（同时喂阶段 3 对照）            |
| anti-small     | **不用 ptc**               | N=2 小改——反过度触发                     |
| anti-bash      | **不用 ptc**               | 必须 shell 的活（四件套没有 bash）       |

## 验收判据（预先钉死）

1. B 臂采用率 > A 臂（n=3 同题对比，允许 1 题例外）；
2. 客观判分通过率 B 不降（两臂差距 ≤1 题×1 轮）；
3. 反例题被包进程序 ≤1/8（6 轮反例运行中 ≤1 轮过度触发）。

## 运行

```bash
node bench/kimi-ab/gen-fixture.mjs     # 造工作区（确定性内容，判分有硬答案）
node bench/kimi-ab/run-ab.mjs          # A/B 双臂 × 全题 × n=3（自动换装插件、备份/还原）
```
