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

## 阶段 2 结果（2026-10-31 重跑，36 轮全有效）

⚠️ 首跑 36 轮作废：臂 bundle 缺 workspace 全量构建，`@pi-ptc/*` 被 rolldown 外置，
MCP server 起不来（wire 0 tools_discovered），0 采用率是「工具缺席」不是「引导无效」。
修 buildArm 顺序 + 执行器加 tools_discovered 硬门禁后重跑。

| 臂 | 期望形态题采用 | 过度触发 | 判分 |
|---|---|---|---|
| A（两行描述） | **7/9**（batch-read 3/3、batch-edit 3/3、grep-agg 1/3） | 0/6 | 17/18 |
| B（A+检查表+经济学 footer） | 5/9（batch-read 2/3、batch-edit 2/3、grep-agg 1/3） | 0/6 | 18/18 |

**判据裁决**（预先钉死的三条）：① B>A——**不满足**（5/9 < 7/9，差在噪声内，n=9 无显著性）；
② 质量不降——满足（唯一 FAIL 是 A/batch-read#3 模型总计算错，工具行为正常）；
③ 过度触发 ≤1/8——满足（0/12）。

**结论**：

- **场景适配是主变量，文字不是**。判据明确的批量任务上，最简引导（A 臂两行字）就有 78% 采用；
  把引导加到检查表+footer（B 臂）在 n=9 下无可测增益。pi 面 10-30 的结论在本宿主独立复现
  ——且这次工具在场性有 wire 级证据。
- 未采用的轮次里模型用**一条 Bash 循环**完成 24 文件批量（B/batch-edit#1 calls=1）——
  宿主 Bash 是模型的默认批量原语，这是四件套「没有 bash」的固有边界，散文够不着。
- **web_ds_search 首次真实采用**：B/fact-search#2（webds=3，还过了题）。
- 行动含义：Kimi 面引导散文的边际收益已饱和，停手；再要提采用只剩宿主层杠杆
  （会话中循环检测提醒）或接受利基定位。

## 未采用轮归因（案头读 wire，2026-10-31）

6 个未采用轮逐轮读 thinking + 工具序列归类：

| 轮 | 类别 | 证据 |
|---|---|---|
| A/grep-agg#1 | G（一次够用） | thinking 明说「这正是 ptc 场景」，随后一条递归 Grep 全捞完——内置 Grep 本身就是批量器 |
| A/grep-agg#2 | G（能力缝） | 「perfect for ptc——但四件套没有 write，exports.txt 写不了」→ Glob+Grep+Write |
| B/grep-agg#1/#3 | G（Bash 更快） | 「用 shell 快」→ 一条 Bash 循环 |
| B/batch-edit#1 | **R（感知）** | 原话「skill 说 ≥5 该写程序，但我在可用工具列表里没看到 ptc_run_code」→ Bash sed 循环 |
| B/batch-read#1 | **R（感知）** | 同上枚举工具列表后认定没有 → Bash 循环 |

两个 actionable 发现（都与散文无关）：

1. **工具名桥断裂**：工具在场（wire 级证据），但模型枚举工具表时没把
   `mcp__plugin-ptc-tools_ptc__ptc_run_code` 匹配到 SKILL 里的「ptc_run_code」。
   两次都发生在 B 臂 ⇒ 检查表治不了感知；候选修法是 SKILL.md 里点一次全名
   （一行字，6 轮定向可验），值得做与否待议。
2. **四件套缺 write 是真实能力缝**（kimi 面绑定 = read/grep/glob/edit，pi 面有 write）：
   「程序内创建新文件」做不到时模型会整轮放弃程序。要不要给 kimi 面补 write 绑定
   （含越界/覆写语义）是产品决定，超出本台架范围。

## 运行

```bash
node bench/kimi-ab/gen-fixture.mjs     # 造工作区（确定性内容，判分有硬答案）
node bench/kimi-ab/run-ab.mjs          # A/B 双臂 × 全题 × n=3（自动换装插件、备份/还原）
```

## 阶段 3 结果（2026-10-31）：web_ds_search vs 内置 WebSearch 回放对照

回放 ba948c91 的 8 个真实 query（另 2 个是该场 FetchURL 直开，无 query 可比）。

**优势（实测）**：
- **官方源命中强**：带 `site:doc.dcloud.net.cn` 的 query 前 2 名正是官方文档页（uni-app-x/web、vite-config.html）——原会话里模型用内置 WebSearch 没找到官方页、最后靠 FetchURL 直猜 URL 才到；web_ds_search 一步到位。
- **延迟低**：成功 query 全部 ~0.4s；返回带 date 字段，利于时效判断。
- **fail-soft 可用**：失败返回可读文本不炸会话（HTTP 500 时模型看得见原因）。

**劣势（实测）**：
- **query 级稳定 500**：`site:ask.dcloud.net.cn` 组合 2/2 复现 Internal Server Error——不是随机抖动，是后端对该 query 的稳定失败；内置 WebSearch 无此现象。fail-soft 救了场，但模型得多花一轮换措辞或换工具。
- **无摘要直读**：结果只有 title/url/snippet（snippet 即摘要），想要全文还要再 open 一次（耗配额）；内置 WebSearch 的 FetchURL 链路心智更熟。

**结论**：web_ds_search 与内置 WebSearch 是**互补**关系——官方源/site: 限定检索它更强，通用探索与全文读取内置链路更顺。单独立得住，但描述里已写明「单次搜索可直调、批量取证进程序」的分工是对的。
