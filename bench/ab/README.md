# A/B 台架：无 PTC / pi 自带 codemode / 本仓自研 PTC 的分档对照（可跨 pi 版本）

同一题、同一模型、同一工作区副本，比质量分与行为指标。

| 臂         | 宿主配置                                                                              | PTC 能力来源                                                   |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `bare`     | `-ne`（不加载任何扩展）                                                               | 无                                                             |
| `codemode` | 隔离 settings `extensions: ["+builtin:codemode"]` + `defaultTools: ["+codemode"]`     | pi 自带 codemode（JavaScript，**≥0.99 才有**）                 |
| `ptc`      | 隔离 settings `extensions: ["-builtin:codemode"]` + `-e packages/entry/dist/index.js` | 本仓自研（TypeScript 严格模式），**自带 PTC 被显式关掉**       |
| `both`     | 同 codemode 的 settings + `-e` 本仓                                                   | 两者同时 = **pi 的默认部署形态**；本仓退让成 `codemode_ptc` 面 |

**两个必须知道的事实**（实测 2026-10-30）：

1. **pi 的内建扩展默认启用**——`extensions: []` **挡不住** codemode（package-manager.js：「Built-in extensions are enabled unless the user `extensions` setting excludes them」）。要关只能写 `-builtin:codemode`（0.99 与 1.4.0 都实测生效）。
2. **`both` 档 = 默认部署形态**——用户全局 `~/.pi/agent/settings.json` 里就开着 `+builtin:codemode`，所以「装了本仓插件」的真实默认状态是 both：自研 PTC 退让，`ptc_run_code` **不在模型面前**，只剩任务面三工具。要单独量自研 PTC 的能力，必须用 `ptc` 档（显式关掉自带 PTC）。

## 版本适用性（跨版本跑之前先看这张表）

| 能力                                               | 0.86.1 / 0.87.x | 0.99.0+ | 1.1.0+ |
| -------------------------------------------------- | --------------- | ------- | ------ |
| 内建 `codemode` 扩展（`dist/extensions/codemode`） | **无**          | 有      | 有     |
| settings `defaultTools` 的 `+name` 修饰符语义      | **无**          | 有      | 有     |

⇒ **0.86/0.87 上 `codemode` 与 `both` 两档不适用**（没有 codemode 可同场）；`both` 会退化成 `ptc` 档。

**`+name` 修饰符语义缺失会静默清空工具集**（0.86.1 实测踩过）：0.86 的 `sdk.js` 直接把 `defaultTools` 原样当工具名列表，
`"+codemode"` 不存在 → 激活工具变成**空集** → 模型面前一个工具都没有 → 模型把 `<tool_call>` 当正文吐出来 →
**0 工具调用、0 分**。看着像模型崩了，其实是台架配置写错。0.99.0 的 `settings-manager.js` 有 `resolveDefaultTools`，
1.1.0 起改名为 `applyToolModifiers`（语义不变）。

**为什么每臂都用隔离的 `PI_CODING_AGENT_DIR`**：用户全局 settings 里同时装着 `+builtin:codemode` 和 `npm:pi-ptc-subagents`（旧版发布包），不隔离就分不清谁在场。每臂的隔离目录只放 `auth.json`（凭据）+ 该臂的 `settings.json`。

判分两层：**客观**（隐藏验收测试 / 检查脚本，主）+ **LLM judge**（pi 中立档 checklist，辅助）。

## 纪律：先自检，再开跑

**开跑正式实验之前，这两步必须先过**：

```bash
# ① 判分器自检：每道题跑「参考答案 → 必须满分」与「人为破坏 → 必须抓到」
node bench/ab/self-check.mjs

# ② 每臂工具面自检：让模型必须用该臂的主工具跑一次——「真调通了」才算可用
node bench/ab/run-ab.mjs --probe --arms bare,codemode,ptc,both
```

判据说明：②的判据是**模型实际调用了该工具**，不是「system prompt 的 tools 节里出现了它」——扩展工具不一定出现在那一节里（实测：本仓工具不在，但 `ptc_run_code` 确实可调）。

**②已经内建进矩阵流程**（不用手动跑）：`run-ab.mjs` 开跑前先对每臂做一次工具面自检，**主工具调不通就跳过该臂并写明原因**，绝不把「工具压根不存在」记成「模型没做到」。跳过的档写进 `report.json` 的 `skipped` 字段。

为什么要有这两层：判分脚本与「工具是否真的可用」都是**沉默的失败源**——判分器认错格式会静默判 0/分，工具没加载也会静默让模型回退到 bash。自检就是为了让这两类失败在开跑前就炸出来。

## 纪律：工作区必须在仓库外（第五轮新踩，最隐蔽的一个）

**pi 会向上遍历祖先目录加载 `AGENTS.md`/`CLAUDE.md`**（`loadProjectContextFiles` 逐级 dirname 上溯），
并按 `package.json` 的 `pi.extensions` 做**项目级发现**。工作区放在本仓内 ⇒ 本仓根的 `AGENTS.md`
（通篇讲 PTC、讲「派一个子代理」怎么走）+ 本仓扩展一起灌进父/子会话 ⇒ **整个实验被污染**。

台架已改：工作区用 `mkdtemp` 建在**仓库外的临时目录**，跑完把产物拷回归档；
并在每轮跑完做**污染自检**（`detectContamination`，结果写进 `report.json` 的 `contamination` 字段）：

- 上下文泄漏（本仓 `AGENTS.md` 的路径/内容进了会话）→ **任何档**算污染；
- 工具面泄漏（本仓 PTC 工具出现在**不该有**的档）→ 算污染。
  `ptc`/`both` 档经 `-e` 显式加载本仓扩展，**有本仓工具是预期**（`--no-extensions` 不挡显式 `-e`）。

详见下面「第五轮：台架污染自查」。

## 纪律：工作区归档必须在客观判分**之后**（第七轮新踩）

判分的输入（父最终输出 `final_answer.md`、ground truth `truth.json`、判分器拷贝）
都是**客观判分阶段**才写进工作区的。若在 `runArm` 里就把工作区拷回归档，
归档目录会**缺这些文件** → 归档看起来完整（模型产物都在），但**根本复现不了判分**。

踩过的具体表现：facts 题第一轮跑完，归档里没有 `final_answer.md`，
手工复跑判分器只能拿现写的临时目录才判得出分（12/12），归档目录直接判 0/12。

⇒ 台架已改：归档挪到 `main` 里 `objectiveGrade()` 之后做。
⇒ 验收口诀：**判完一轮后，只用归档目录里的文件就能复跑判分器并得到同一个分数**
（`cd <out>/<arm>-<n>/workspace && python check_facts.py`）。

## 复跑

```bash
pnpm run build   # 先 build，ptc/both 档吃的是 packages/entry/dist/index.js

# 宽题：24 模块批量补 docstring + 出清单
node bench/ab/run-ab.mjs --task bench/ab/task-repo-wide --prompt bench/ab/task-prompt-wide.md \
  --grader bench/ab/grader-wide --checks bench/ab/checks-wide.json \
  --out bench/ab/out-wide3 --repeat 3 --skip-judge --arms bare,codemode,ptc,both

# 窄题：单模块实现 coupons（隐藏测试 14 条）
node bench/ab/run-ab.mjs --out bench/ab/out-narrow2 --repeat 2 --skip-judge --arms bare,codemode,ptc,both

# 归约题：统计 25 个模块的公开函数数出汇总表
node bench/ab/run-ab.mjs --task bench/ab/task-repo-wide --prompt bench/ab/task-prompt-agg.md \
  --grader bench/ab/grader-agg --out bench/ab/out-agg --repeat 2 --skip-judge --arms bare,codemode,ptc

# 扇出题 6 包版：6 个包各出一张接口卡 + 汇总表
node bench/ab/run-ab.mjs --task bench/ab/task-repo-fanout --prompt bench/ab/task-prompt-fanout.md \
  --grader bench/ab/grader-fanout --out bench/ab/out-fanout --repeat 1 --skip-judge --arms bare,codemode,ptc,both

# 扇出题 24 包版：复用宽题的 24 个模块，交付物换成接口卡（同一份判分器，自动发现包目录）
node bench/ab/run-ab.mjs --task bench/ab/task-repo-wide --prompt bench/ab/task-prompt-fanout24.md \
  --grader bench/ab/grader-fanout --out bench/ab/out-fanout24 --repeat 3 --skip-judge --arms bare,codemode,ptc,both

# facts 题：多主题调研 + 汇总（量**子代理的消耗与准确性**，见「第七轮」）
node bench/ab/run-ab.mjs --task bench/ab/task-facts --prompt bench/ab/task-prompt-facts.md \
  --grader bench/ab/grader-facts --out bench/ab/out-facts --repeat 3 --skip-judge --arms bare,codemode,ptc,both

# 跨 pi 版本（shim 见 scripts/version-smoke.sh，缺了自动 npm install）
# ⚠️ 0.86/0.87 没有 codemode 扩展 → codemode/both 两档会被闸门跳过（见「版本适用性」）
node bench/ab/run-ab.mjs --task bench/ab/task-repo-wide --prompt bench/ab/task-prompt-wide.md \
  --grader bench/ab/grader-wide --checks bench/ab/checks-wide.json \
  --out bench/ab/out-mx-0.99.0 --repeat 1 --skip-judge --arms bare,codemode,ptc,both \
  --pi-bin /tmp/pi-0.99.0/node_modules/.bin/pi

# 判分口径改了只补判分，不重跑四臂（judge 取每档第 1 轮轨迹）
node bench/ab/run-ab.mjs --judge-only --task bench/ab/task-repo-wide --prompt bench/ab/task-prompt-wide.md \
  --grader bench/ab/grader-wide --checks bench/ab/checks-wide.json \
  --out bench/ab/out-wide3 --arms bare,codemode,ptc,both
```

产物落 `bench/ab/out*/`（已 gitignore）：每臂每轮一个目录（`trajectory.json` = 原始轨迹），`report.json` = 聚合表。

## 判分表

`scripts/octobench-pi-checklist.mjs` 把 MiniMax 官方 OctoBench 的 checklist 转成 pi 版（绑脚手架的三类 SP / Tool schema / System reminder 换成 pi 版，其余原样搬运）：

```bash
node scripts/octobench-pi-checklist.mjs --profile pi --out bench/octobench/pi-checklist.jsonl
node scripts/octobench-pi-checklist.mjs --self-test   # 8/8
```

## 已测结论（2026-10-30，模型 `minimax-cn/MiniMax-M3.1-Flash`）

**质量：四档无差别。** 宽题 12/12 全过（每档 3 轮，检查脚本 24/24 模块）；窄题 8/8 全过（隐藏测试 0 failed）。

**效率：中位数基本持平，差异在方差。** 宽题（3 轮中位数）：

| 档       | 用时            | 轮次 | 工具调用 | 输出 token | 宽题采用 PTC 的轮次 |
| -------- | --------------- | ---- | -------- | ---------- | ------------------- |
| bare     | 59.0s（38~65）  | 10   | 32       | 6828       | —                   |
| codemode | 57.9s（50~65）  | 8    | 32       | 4853       | 2/3 轮各调 1 次     |
| ptc      | 57.4s（27~116） | 8    | 32       | 6429       | **0/3**             |
| both     | 63.0s（49~75）  | 9    | 34       | 4069       | 3/3 轮各调 1 次     |

**最关键的发现是采用率，不是速度**：

- pi 自带 `codemode`：**模型会主动用**（codemode + both 两档合计 5/6 轮）。宽题第 1 轮里它一次程序调用批量写完 24 个文件（`wrote 24 files`，脚本墙钟 0.1s）。
- 本仓自研 `ptc_run_code`：**全程 0 次被调用**（宽题 0/3、窄题 0/2）。模型在 thinking 里明说原因——「could I use ptc_run_code with tools.edit? It supports tools.\<name\>(args) **presumably**. That's for batch tool calls — good fit. But **risk of format differences**. Let me just do parallel edits」。
- 差距不在能力，在**描述**：codemode 的工具声明里带每个可用工具的完整描述与参数形状，模型敢写；`ptc_run_code` 的描述只有一句「tools.\<name\>(args)」，模型不确定参数形状就不敢用。

`both` 档（本仓 + codemode 同时在场）里，本仓按 ADR-0005 / 决策 28 退让成 `codemode_ptc` 面：**不注册 PTC 对**（`ptc_run_code` / `ptc_workflow` 不在模型面前），只保留任务面三工具（`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`）。

## 第二轮：修了描述，采用率仍为 0——但根因换了

改了 `packages/routes/src/registry.ts` 的 `TOOLS.ptc_run_code.description`（只加 full_ptc 面），
把「程序内可调本会话已启用的同名工具，**参数与直接调用该工具完全一致**；返回 Promise，要 await，
返回文本结果，失败抛异常」+ 一行最小样例写进模型面描述。

**改前 vs 改后，模型 thinking 的变化**：

|                                           | 改前                                                                                                                | 改后                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 对 `ptc_run_code` 的态度                  | 「It supports tools.\<name\>(args) **presumably** … **risk of format differences**. Let me just do parallel edits」 | 「**Let me use ptc_run_code** to write files? Actually the edit tool is fine but 24 calls. I can batch multiple edit calls in one message」 |
| 「presumably」/「format differences」命中 | 2 次                                                                                                                | **0 次**                                                                                                                                    |

⇒ **顾虑确实消除了**：决策点从「不敢用（怕参数形状不对）」变成「有更省的办法」。
但**采用率仍是 0/3**（宽题）——因为否决理由换成了「并行直调也行」。

**为什么并行直调就够**（这才是真正的根因）：

- **bash 本身就是归约器**。新造的归约题（统计 25 个模块的公开函数数，出汇总表）三档各跑 2 轮，
  **全部 0 次程序调用、全部 25/25 全过**，用的都是 `bash×8 + read×4` 之类——
  `cat src/inventory/*.py | grep -c "^def "` 一条命令就完事。
- **pi 支持一条消息里并行发多个 tool call**，模型一次发 24 个 edit 就等价于批量写。
- pi 默认系统提示还明说「Use bash for file operations like ls, rg, find」——bash 是被鼓励的路径。

⇒ **在「本地文件 + 文本处理」这类任务上，程序化调工具打不过 bash**，
`ptc_run_code` 与 pi 自带 `codemode` 都没有优势，模型自然不用。

**这轮实验对本仓核心价值（子代理派发）零结论**：三道题都是单进程单任务，
`ptc_run_code` / `codemode` / `pi_task_ptc` / `pi_task_codemode` 一次都没被触发。
要量出本仓相对 pi 自带 codemode 的增量，**题必须是「需要派子代理」的**
（both 档的增量正是脚本内 `tools.pi_task_codemode`——纯 codemode 档没有这条派活路径）。

**LLM judge（仅第 1 轮，n=1/档；分母已按 checklist 固定）**：

| 档       | 宽题（27 项）  | 窄题（28 项）  |
| -------- | -------------- | -------------- |
| bare     | 0.667（18/27） | 0.857（24/28） |
| codemode | 0.852（23/27） | 0.964（27/28） |
| ptc      | 0.852（23/27） | 0.929（26/28） |
| both     | 0.852（23/27） | 0.857（24/28） |

两次独立判分同一批轨迹，bare 档宽题得 0.704 → 0.667、codemode 0.815 → 0.852、ptc 0.889 → 0.852、both 0.889 → 0.852——**judge 有 ±0.04~0.07 的漂移，档间差不可归因**。两次一致的方向只有一条：带 PTC 的三档都高于 bare。硬结论仍以客观判分为准。

## 第三轮：跨 pi 版本矩阵 + 显式关掉自带 PTC + 先自检

三条修正都落地了：① 跨版本（floor 0.86.1 / 中段 0.99.0 / 最新 1.4.0）；② 档位按「显式关掉 pi 自带 PTC」重设计（`ptc` 档 = `-builtin:codemode`，`both` 档 = 默认部署形态）；③ 判分器与工具面双自检固化进仓库（`self-check.mjs` + 矩阵内置闸门）。

**宽题矩阵（n=1/档，客观判分 = 检查脚本 24/24 模块）**：

| pi 版本 | bare            | codemode                       | ptc                       | both                                       |
| ------- | --------------- | ------------------------------ | ------------------------- | ------------------------------------------ |
| 1.4.0   | 24/24 ✅ 65.9s  | 24/24 ✅ 37.3s **codemode×1**  | 24/24 ✅ 51.5s **ptc×0**  | 24/24 ✅ 34.9s **codemode×2**              |
| 0.99.0  | 24/24 ✅ 171.9s | 24/24 ✅ 125.4s **codemode×1** | 24/24 ✅ 101.9s **ptc×1** | 24/24 ✅ 86.3s **codemode×1**              |
| 0.86.1  | 24/24 ✅ 91.3s  | **N/A**（该版本无 codemode）   | 24/24 ✅ 114.5s **ptc×1** | 24/24 ✅ 468.6s **ptc×33 + 派发 5 子代理** |

**① 质量：三版本 × 适用档全部 24/24 全过。** PTC 在不在、哪个版本，**都不影响这道题的对错**。

**② 采用率方差极大，n=1 不可横比**：0.86.1 上两个**有效等价**的档（本仓独场），`ptc_run_code` 调用数是 **1 次 vs 33 次**——
配置差异只是 `extensions:["-builtin:codemode"]` 与 `["+builtin:codemode"]` 的字面差别（0.86 上两者都是空操作）。
⇒ 之前「自研 PTC 全程 0 次被调用」的结论**只在 1.4.0 的那几轮成立**，不是本仓工具的性质。

**③ 派发路径第一次被真正触发**（0.86.1 的 `both` 档，468.6s / 43 轮）：模型用 `ptc_run_code` 派了 **5 个子代理**——
1 个只读侦察（`scout-inventory`）+ 3 组 docstring（`docstrings-g1/g2/g3`，**同一秒派发 = 真并行**，各 8 个 edit）+ 1 个清单&测试（`manifest-and-test`），
5 个全部 `succeeded`，父档 24/24 全过，**24/24 模块拿到模块级 docstring**。
`.pi/ptc-tasks/` 下有 5 个真子会话（各自 session id 与 JSONL 轨迹）+ 5 份落盘记录。
⇒ **本仓的 dispatch 在 floor 版本上可用**；之前的「零触发」是题型问题（单进程单任务），不是能力问题。

**④ floor `codemode` 档的 0 分是台架 bug，不是模型也不是本仓**：0.86.1 没有 codemode 内建扩展，
且 `defaultTools:["+codemode"]` 的修饰符语义要 0.99+ 才有（0.86 上原样当工具名列表 → 激活工具集为空 →
模型面前零工具 → 把 `<​tool_call>` 当正文吐出来 → 0 调用 / 25 failed）。
现在矩阵内置闸门会把该档**跳过并写明原因**，不再记成模型失败。

## 第四轮：扇出题（派发）+ 派发指标客观化

### 新题：扇出题

每个包出一张「接口卡」（模块名 / 代码行数 / 职责 / 全部公开函数的参数表）+ 一张汇总表。

- 6 包版 `task-repo-fanout`（`alpha`…`foxtrot`，每个 3 个公开函数）
- 24 包版：复用宽题的 `src/inventory/` 24 个模块，交付物换成接口卡
- **一份判分器**服务两题（`grader-fanout/check_fanout.py`，包目录自动发现 `src/pkgkit` / `src/inventory`）

判分器自检（`node bench/ab/self-check.mjs`）：6 包正例 45 passed / 负例 44+1 failed；24 包正例 171 passed / 负例 170+1 failed。
真实模型产物同样 45/45 与 171/171 全过——**判分器在真实产物上无误判**。

### 派发指标：客观采集，不看模型说什么

跑完每臂读工作区 `.pi/ptc-tasks/records/`：

| 指标     | 口径                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 派发数   | registry 记录条数                                                                                                                         |
| 并行度   | `startedAt`/`finishedAt` 区间重叠的**最大同时在跑数**                                                                                     |
| 终态     | `status` 分布（succeeded / failed / canceled…）                                                                                           |
| 走哪扇门 | `pi_task_codemode` 工具调用数（宿主记得到） vs 程序体里出现 `pi_task_ptc` 的次数（binding 不产生 `tool_execution_start`，只能从程序体数） |

### 两条派发门在 pi 1.4.0 上都实测通（探针实证，非推断）

| 门          | 入口                                                                                                                           | 探针结果                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| codemode 门 | `tools.pi_task_codemode`（注册工具带 `exposure:"codemode"`；pi 的 `_getCallableTools` 把这类工具放进 codemode 脚本的可调列表） | `codemode`×1 + `pi_task_codemode`×1 → 记录 `succeeded`（2s） |
| PTC 门      | 程序内 binding `tools.pi_task_ptc`                                                                                             | `ptc_run_code`×1 → 记录 `succeeded`（2s）                    |

### 关键发现：模型要「批量」时走的是 shell，不是 PTC

24 包版试点：**8 个工具调用 / 36.4s / 判分 171/171 全过**——模型在 `bash` 里嵌 `python3 - <<EOF`
**一次性生成全部 25 个文件**，还自己写了两段脚本回验。**0 次派发、0 次 `ptc_run_code`、0 次 `codemode`**。

⇒ **「程序化 ≠ PTC」**：模型确实有程序化冲动，但默认载体是 **shell**（零仪式），
不是 PTC（要先有工具描述与参数契约），更不是派发（要先有门）。

### 扇出题矩阵（pi 1.4.0，四档 × n=3 = 12 轮）—— **干净态**（工作区在仓库外）

| 档       | 判分    | 全过 | 轮次 | 工具调用 | 用时中位 | `ptc_run_code` | `codemode` | 派发 | 并行度 |
| -------- | ------- | ---- | ---- | -------- | -------- | -------------- | ---------- | ---- | ------ |
| bare     | 171/171 | 是   | 8    | 8        | 35s      | 0              | 0          | 0/3  | 0      |
| codemode | 171/171 | 是   | 8    | 9        | 66s      | 0              | **0**      | 0/3  | 0      |
| ptc      | 171/171 | 是   | 11   | 10       | 48s      | **0**          | 0          | 0/3  | 0      |
| both     | 171/171 | 是   | 7    | 8        | 40s      | 0              | 0          | 0/3  | 0      |

污染自检 **12/12 全干净**（`contamination.contaminated = false`）。

**干净态的结论比污染态更硬**：

- **质量四档无差别**（12/12 轮 171/171 全过）。
- **派发 0/12**——干净态下模型**一次都没有**自发派发。
- **连 pi 自带的 `codemode` 也是 0/6 轮被选中**。
- **`ptc_run_code` 也是 0/12**：污染态那版矩阵里「ptc 档有 1/3 轮用了 3 次 `ptc_run_code`
  且那次最啰嗦（107 次工具调用）」——**那也是污染态的产物**，干净态下本仓 PTC **同样 0 次**被模型主动调用。

⇒ 污染态与干净态**在结论方向上一致**（派发 0、PTC 0、codemode 0、质量无差别），
但污染态额外造出了「floor 上 9 次自发派发」这个**假阳性**，以及「1/3 轮用了 PTC」这个**假信号**。

### 派发一旦发生，链路完整（能力侧结论仍成立）

floor 0.86.1 宽题 `both` 档（**污染态数据**，仅能力侧可用）：5 个子任务（`scout-inventory` +
`docstrings-g1/g2/g3` + `manifest-and-test`），**并行度 3**，全部 `succeeded`（16.5~66.2s），
父档 24/24 全过、468.6s。
⇒ spawn / pump / registry 落盘 / child report 在 floor 上整链可用。
（**采用率侧的结论已被污染推翻**——见下一节。）

### 干净态 floor 复测（0.86.1 宽题，`ptc` 档 × n=3）

| 档   | 判分                                                           | 全过 | 轮次 | 工具调用 | 用时中位 | `ptc_run_code` | 派发    |
| ---- | -------------------------------------------------------------- | ---- | ---- | -------- | -------- | -------------- | ------- |
| ptc  | 24/24 ×3                                                       | 是   | 10   | 11       | 99s      | 1（1/3 轮）    | **0/3** |
| both | **被闸门跳过**（0.86.1 没有 codemode 内建扩展 → 主工具调不通） |      |      |          |          |                |         |

污染自检 3/3 全干净。

**干净态 floor 与污染态 floor 的对照（同一 pi 版本、同一题、同一模型）**：

| 状态             | 派发数 | 说明                                                          |
| ---------------- | ------ | ------------------------------------------------------------- |
| 污染态（旧数据） | **9**  | 被本仓 AGENTS.md 诱导；其中 4 个 `lost`、1 个 `running` 275s+ |
| 干净态（本次）   | **0**  | 模型用 1 次 `ptc_run_code` 但没派子代理；3 轮判分全 24/24     |

⇒ **floor 上「模型自发派发」也是被诱导的假象**，不是版本差异。
⇒ **干净态下跨版本结论一致**：1.4.0 扇出题 0/12 + floor 宽题 0/3 = **0/15 轮自发派发**。

### 探针里的派发 ≠ 自发派发（第六轮补测，纠正一处误读）

探针目录里能查到落盘 record，容易被当成「模型自发派发」。核对程序体后**不成立**：

| 探针                       | 落盘 record                         | 模型实际在干什么                                         |
| -------------------------- | ----------------------------------- | -------------------------------------------------------- |
| 1.4.0 四档探针             | **0 条**（无 records 目录）         | 第一个程序 `tools.read` 一次成功 → 无需派发              |
| floor 0.86.1 `ptc` 档探针  | 6 条，全 `succeeded`                | 程序内 `read` 读不到 → 改派子代理去读（label 迭代 3 轮） |
| floor 0.86.1 `both` 档探针 | 15 条（9 成 / 4 lost / 2 stopping） | 同上，codemode 调不通 + read 失败 → 反复换派发写法       |

**引导层逐字相同**：1.4.0 `ptc` 档与 floor `ptc` 档的 `<ptc>` 节**完全一致**（均 972 字符，
都写着「派一个子代理 → `tools.pi_task_ptc`（程序内）」）——所以差异**不在**引导、**不在**工具面。

⇒ 派发的触发条件是 **任务受阻**（程序内读文件失败 → 派子代理绕过），
不是 **任务适合并行**。1.4.0 与 floor 的差别是「read 成不成功」，不是「模型爱不爱派发」。
⇒ 这条同时解释了 floor 探针里 4 个 `lost`：快速迭代派发写法时孩子超时/断链，
是**调试过程的损耗**，不是常态。

## 第五轮：台架污染自查（本轮最重要的发现，前面几轮的结论要打折）

### 污染是怎么发生的

bench 工作区原本建在 `bench/ab/out*/<arm>/workspace`——**在本仓目录内**。pi 会：

1. **向上遍历祖先目录**加载上下文文件（`loadProjectContextFiles`）→ 本仓根的 `AGENTS.md`（通篇讲 PTC、
   讲「派一个子代理」怎么走）被灌进**父会话和每个子会话**；
2. 按 `package.json` 的 `pi.extensions` 做**项目级发现** → 仓库根 `package.json` 声明了
   `"pi": {"extensions": ["./dist/index.js"]}` → 本仓扩展被装进会话。

⇒ **整个台架被污染**：本仓自己的 AGENTS.md 在教模型「该派子代理时怎么派」，
「模型自发派发」就变成了**被 AGENTS.md 诱导的假象**，不是模型行为。

### 证据：同一 floor 探针，唯一变量是工作区在不在仓内

| 工作区位置             | 探针工具调用                                                 | 派发结果                                        |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| 仓内（污染态，旧数据） | `ptc_run_code`×19 + `ptc_task_output`×11 + `ptc_task_list`×1 | **9 个孩子**，4 个 `lost`、1 个 `running` 275s+ |
| 仓外（修复后）         | `ptc_run_code`×4 + `read`×1                                  | **0 派发**，秒退                                |

父会话里的 `AGENTS.md` 命中数：仓内 **3** → 仓外 **0**。

### 修复

`run-ab.mjs` 的工作区改到**仓库外的临时目录**（`mkdtemp`），跑完再把产物拷回归档；
并加**污染自检**（`detectContamination`）：

- 上下文泄漏：本仓 `AGENTS.md` 的路径/内容进了会话 → **任何档**都算污染；
- 工具面泄漏：本仓 PTC 工具出现在**不该有**的档（`bare`/`codemode` 没装本仓扩展）→ 算污染；
  `ptc`/`both` 档经 `-e` 显式加载本仓扩展，**有本仓工具是预期**，不算。

### 结论要改的地方

- ❌ 「floor 0.86.1 模型自发派发 9 个子代理」——**作废**，那是本仓 AGENTS.md 诱导的。
- ❌ 「floor 派发后 4 个孩子 `lost`」——**根因不是 floor 缺能力**，是污染态下孩子拿到了本仓工具面
  （`ptc_run_code`/`ptc_task_list`）却在 floor 上没有程序内通道 → 反复重试到超时。
- ❌ 「同一道题换 pi 版本走出完全不同路径（floor 33 次程序调用 vs 1.4.0 0 次）」——**作废**，
  两边的工作区位置不同，不可比。
- ❌ 「1.4.0 扇出题矩阵里 ptc 档有 1/3 轮用了 3 次 `ptc_run_code`」——**也是污染产物**，
  干净态下本仓 PTC 同样 0/12 被模型主动调用。
- ✅ 仍然成立：两条派发门在 pi 1.4.0 上都实测通（探针实证）；spawn/pump/registry 整链可用；
  扇出题上模型要走批量时默认载体是 **shell** 而不是 PTC。
- ✅ **新的硬结论（干净态）**：**模型在 0/15 轮里自发派发过**（1.4.0 扇出题 0/12 + floor 宽题 0/3），
  质量四档无差别（171/171 × 12 + 24/24 × 3），本仓 PTC 在干净态下被模型主动调用 2/15 轮
  （floor 宽题各 1 次）。
  ⇒ **派发能力在本仓里是「可用但不被选」**——门通、链路通，模型不按。

> 教训：做「模型行为」实验时，**宿主注入的上下文本身就是变量**。
> 本仓自己的 AGENTS.md 恰好在讲派发，落在实验路径上就会污染结论——这类坑只能靠
> 「跑完查会话里有没有不该出现的东西」兜住，不能靠读代码猜。

## 第七轮：子代理的消耗速度与结论准确性（2026-10-30 晚，同日第七轮）

### 问题

前六轮测的是「模型**会不会**用派发」。本轮测的是**派发机制本身值不值**：一次多主题调研，
派发（并行子代理）比父自己串行干，快多少、贵多少、准不准；以及
**本仓自研派发 vs pi 官方 codemode 派发**，成本与准确性有没有差别。

### 方法论出处（先联网取证，再造台架）

| 来源                                                                                                                              | 借用的东西                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Evaluating Agent Systems Beyond Accuracy](https://www.arunkumar.co/writing/evaluating-agent-systems-beyond-accuracy)             | 四维度（Correctness / Cost / Latency / Reliability）+ **cost-normalized**：`cost_per_correct = total_cost / correct`、`efficiency_score = accuracy / cost_per_correct`；「95% 准但 $2/30s 不如 90% 准但 $0.10/3s」 |
| [How to Evaluate the Cost of Running Parallel AI Agents](https://sekin.in/how-to-evaluate-the-cost-of-running-parallel-ai-agents) | **完整运行树成本**（coordinator + subagents + tools + 重试）÷ 达标任务数；**必须与串行基线同题同模同质量阈值比**；一次只改一个变量；失败的调用也要计费并单独报；报 median + 高分位                                 |
| [DeLM](https://yuzhenmao.github.io/DeLM/)（多 agent 系统论文）                                                                    | **bubble**（agent 空等占比）与 **straggler**（慢者定整轮时长）；并行加速比 = Σ子任务时长 ÷ 子任务墙钟跨度                                                                                                          |

### 题面：facts 题（4 份独立档案 → 12 条可硬核验的事实）

`bench/ab/task-facts/materials/topic-{1..4}.md` 各一份独立档案，每份 3 条**需要读+算**的事实
（不是 grep 一下就有的原文）：产能/能耗/人力/库存四个互不依赖的主题。
题面要求**每个主题派一个独立子代理**、父只做汇总，输出严格是 `F<主题>-<序号> = <数值>`。

- `bench/ab/grader-facts/truth.json` = ground truth（**模型跑完之后才拷进工作区**，不泄题）
- `bench/ab/task-prompt-facts.md` = 题面（含「没有派子代理能力就自己串行干」的兜底 → `bare` 档才有基线）

### 判分：三层（父 / 子代理 / 保真度）

`bench/ab/grader-facts/check_facts.py` 输出：

- `parent.hit` —— 父最终输出命中几条（**硬判分，分母固定 12**）
- `children.hit` —— 子代理并集命中几条（每个子代理只说自己那 3 条）
- `fidelity.hallucinated` —— 父说有、子代理没说的（幻觉）
- `fidelity.dropped` —— 子代理说对、父没写的（丢失）
- `fidelity.fabricated` —— 父输出里出现、ground truth 里根本没有的事实 id（**编造**，不占分母但必须报出来）

数值口径：四舍五入到 2 位必须完全相等（材料无歧义，算错就是错）。
格式兼容：`=`/`:`/`|`/带单位/带反引号都认；散文（`F1-1 的值是 240`）不认。

### 成本口径（两个坑）

- **父**：`events.jsonl` 的 `message_end.message.usage.cost.total` 累加。
  ⚠️ **只认 `message_end`**——pi 的 `message_start` 带同一份 usage，两边都算会翻倍。
- **子代理**：**registry record 里的 `report.usage` 是孩子自报值，实测恒为 0**
  （孩子自报了 usage → 宿主的观测兜底 `report?.usage ?? observedUsage` 就不生效了）
  → 真实用量只能从子会话日志 `.pi/ptc-tasks/tasks/<id>/output.log` 读（`collectChildUsage`）。
- 合计 = **运行树成本**（父 + 所有子代理）；`$` 用 **pi 上报的 provider 计价**，不自己按 token 定价换算。

### 四档对照（同一题、同一模型、同一工作区副本）

⚠️ 角色要分清：**`pi_task_codemode` 是本仓注册的工具**（`entry/src/index.ts` 的 `registerTaskDoor`，
`exposure:"codemode"`），**pi 自带 codemode 扩展本身没有派发能力**。

| 档       | 编排器                       | 派发能力                                               | 角色             |
| -------- | ---------------------------- | ------------------------------------------------------ | ---------------- |
| bare     | 无（pi 直接工具）            | 无                                                     | **串行基线**     |
| codemode | **pi 官方 codemode**（JS）   | **无**（这档不加载本仓扩展 → 没有 `pi_task_codemode`） | **官方能力边界** |
| ptc      | 本仓 PTC（TS 程序）          | 有：PTC 门（程序内 `tools.pi_task_ptc`）               | 本仓独场         |
| both     | pi 官方 codemode（本仓退让） | 有：codemode 门（脚本内 `pi_task_codemode`）           | **用户真实形态** |

⇒ **「本仓 vs pi 官方」的直接对照 = `both` 档 vs `codemode` 档**：
编排器都是 pi 官方 codemode，**只差「能不能派子代理」这一项**。
⇒ 派发能力本身就是本仓的增量（官方 codemode 编排器不带派发）。

**实证（1.4.0，codemode 档第 1 轮）**：模型**主动去找**派发工具——写了两个探针脚本
`ALL_TOOLS.filter(t => /agent|task|delegate|spawn|sub/i.test(t.name + " " + t.description))`
（返回 `[]`）与 `ALL_TOOLS.map(t => t.name).join("\n")`（返回 `read / bash / edit / write`）。
⇒ **官方 codemode 脚本的可调工具只有 4 个内置工具，没有任何派发入口**；
`codemode` 档的 0 派发**不是模型不选，是官方面给不了**——
这恰好把「本仓增量」的边界划清楚了：**派发（与子代理的独立上下文）**。

### 结果（1.4.0 · `minimax-cn/MiniMax-M3.1-Flash` · 四档 × n=3 = 12 轮 · 污染自检 12/12 干净）

**主表**（中位数；括号里是逐轮判分「命中条数 / 12」）

| 档       | 编排器          | 父准确率             | 派发  | 并行度 | 总成本   | 每命中成本 | 墙钟            |
| -------- | --------------- | -------------------- | ----- | ------ | -------- | ---------- | --------------- |
| bare     | 无              | 92%（12 / 9 / 11）   | 0     | 0      | $0.00262 | $0.00023   | 49s（6~182）    |
| codemode | 官方 codemode   | 92%（12 / 11 / 11）  | 0     | 0      | $0.00206 | $0.00018   | 12s（10~15）    |
| ptc      | 本仓 PTC        | **100%（12/12/12）** | 4/4/4 | 4      | $0.05896 | $0.00491   | 167s（111~192） |
| both     | 官方 + 本仓派发 | **100%（12/12/11）** | 4/4/4 | 4      | $0.03814 | $0.00318   | 43s（32~86）    |

**① 派发提升的是「准确性」，不是速度**

- 派发档 23/24 条命中（ptc 36/36、both 35/36）；不派发档合计 66/72（bare 32/36、codemode 34/36）。
- 机制不是运气：串行时父要同时扛 4 个主题的多步计算，`bare-2` 把 topic-1 **3 条全算错**
  （把「120 件/班」多乘了一次班次时长 1920 vs 240，检修时长也从每日 16h 里扣成 14h）；
  派发后每个子代理只面对一份档案 → 全对。
- **代价**：成本 15~22 倍（$0.059 / $0.038 vs $0.0026 / $0.0021）；
  成本效率（accuracy ÷ 每命中成本）反而 **codemode 5104 > bare 4241 ≫ both 315 > ptc 204**
  —— **不派发在「$ per correct」上完胜**。

**② 派发不快：spawn 开销 + straggler 吃掉并行收益**

| 轮次   | 4 个子任务时长                   | Σ      | 墙钟跨度 | 并行加速比 | straggler 占比 |
| ------ | -------------------------------- | ------ | -------- | ---------- | -------------- |
| ptc-1  | 6.5s / 7.5s / 6.0s / **77.1s**   | 97.1s  | 77.1s    | 1.26×      | 79%            |
| ptc-2  | 7.9s / **93.2s** / 10.0s / 8.2s  | 119.3s | 93.2s    | 1.28×      | 78%            |
| ptc-3  | 8.6s / 7.7s / 8.4s / **153.7s**  | 178.3s | 153.7s   | 1.16×      | 86%            |
| both-1 | 11.3s / 11.3s / **30.9s** / 9.0s | 62.4s  | 30.9s    | 2.02×      | 50%            |
| both-2 | 6.1s / 8.8s / 9.2s / **69.1s**   | 93.2s  | 69.1s    | 1.35×      | 74%            |
| both-3 | 6.9s / 7.4s / **10.9s** / 8.1s   | 33.3s  | 10.9s    | 3.05×      | 33%            |

- 每个子代理**固定启动开销 ~6~11s**（spawn 一个独立 pi 进程），而实际计算只要几秒
  → 理论 4× 并行只跑出 **1.16×~3.05×**。
- **6/6 轮都有 straggler**：一个子任务独占 33%~86% 的总时长，墙钟被它一个人定住
  （这正是 DeLM 论文说的 straggler problem）。
- 端到端看：`ptc` 档比串行基线**还慢 3.4×**（0.29×），`both` 档 1.14× 基本持平。

**③ 官方编排 + 本仓派发（both）全面优于 本仓编排 + 本仓派发（ptc）**

| 对比               | 速度                               | 成本         | 准确性 |
| ------------------ | ---------------------------------- | ------------ | ------ |
| both vs ptc        | **3.9× 快**                        | **便宜 35%** | 相同   |
| 本仓编排的额外代价 | 父侧 token 6×（$0.016 vs $0.0027） |              |        |

⇒ 回到编排器的选择：**派发能力是本仓的增量，但编排器用官方的更快更省**——
这正面支持「codemode 在场时退让」的设计。

**④ 成本结构：开销几乎全在子代理身上**

子代理成本占派发档总成本 **73%~93%**（父只负责写个脚本，几乎不花钱）。
单个子任务 ≈ **$0.009~0.018**（$0.043/4、$0.049/4、$0.073/4）。

**⑤ 汇总保真度：父基本忠实转述**

- 6 轮派发里 **5 轮幻觉 0 / 丢失 0**（父说对的都是子代理说过的，子说对的父都写了）。
- **both-2 出现幻觉 3 条**：F2 那个子代理 **0 命中**（没产出），父汇总里却仍有 F2-1/2/3
  → **父自己补上了失败子代理的活**。这是唯一的保真度失败案例。

**⑥ 官方 codemode 档的 0 派发 = 官方给不了，不是模型不选**

模型在 codemode-1 轮里主动写了两个探针脚本找派发能力
（`ALL_TOOLS.filter(/agent|task|delegate|spawn|sub/)` → `[]`；列全量 → `read / bash / edit / write`）
→ **官方 codemode 脚本的可调工具只有 4 个内置工具，没有任何派发入口**
（`pi_task_codemode` 是本仓注册的工具，官方档没装本仓扩展）。

### 怎么用这组数（选型口径）

- **适合派发**：主题多、彼此独立、每个都要读一堆材料的题 → 换到「一份材料一个子代理」的
  认知负荷分割，准确性 92% → 100%。
- **不适合派发**：材料少、模型一口气能算完的题 → 15~22 倍成本换 0~8% 准确率。
- **要用就用 both 形态**（官方编排器 + 本仓派发门）：比本仓编排快 3.9×、便宜 35%。
- **引擎侧可改进点**：子代理 spawn 固定开销（~6~11s）与 straggler（33%~86% 时长）
  是派发收益被吃掉的主因——这是**引擎**的问题，不是模型的问题。

## 第八轮：修 env 透传 bug 后的复测（2026-10-30 晚，同日第九轮改造）

### 改了什么

`packages/dispatch/src/engine.ts` 的默认 spawn 曾把 env 丢掉（`(argv) => defaultSpawn(argv)`），
`PI_PTC_DEPTH` / `PI_PTC_TASK_ID` 没进子进程 ⇒ 孩子按 depth=0 **完整装配**（注入整本 `<ptc>` 路由册、
递归闸门失效）。修成 `(argv, env) => defaultSpawn(argv, env)` 后，孩子走 depth>0 早退：
系统提示词只剩 `preamble / tools / rules / docs / addendum / cwd`，**`<ptc>` 节整节消失**。

### 复测（facts 题 · 四档 × n=3 = 12 轮 · 1.4.0 · 同一题同一模型同一工作区条件）

**机制侧（确定性，不受模型波动影响）**：修后 both-1 轮的 4/4 个子代理，系统提示词节表
`preamble/tools/rules/docs/addendum/cwd/ptc` → `preamble/tools/rules/docs/addendum/cwd`，
**`<ptc>` 节整节消失**；总字符 4679 → 2975（−36%，其中 rules 839→148、tools 339→295 也一并瘦身）。

**效果侧（中位数）**：

| 档       | 判分（passed 逐轮）     | 总成本 前→后                    | 子成本 前→后                | 每子 input 前→后    | 每子 input+cache 前→后 | 墙钟 前→后          |
| -------- | ----------------------- | ------------------------------- | --------------------------- | ------------------- | ---------------------- | ------------------- |
| bare     | 12/9/11 → 11/12/12      | $0.00262 → $0.00325             | —                           | —                   | —                      | 49s → 39s           |
| codemode | 12/11/11 → 12/12/**0**  | $0.00206 → $0.00348             | —                           | —                   | —                      | 12s → 61s           |
| ptc      | **12/12/12 → 12/12/12** | $0.05896 → $0.03774（**−36%**） | $0.04927 → $0.03326（−32%） | 2830 → 1607（−43%） | 7116 → 5511（−23%）    | 167s → 112s（−33%） |
| both     | 12/12/11 → 12/11/12     | $0.03814 → $0.02814（**−26%**） | $0.03544 → $0.02527（−29%） | 3121 → 1766（−43%） | 7304 → 4402（−40%）    | 43s → 45s           |

**相对 bare 的成本倍数**：ptc 22.5× → **11.6×**；both 14.5× → **8.7×**（派发仍贵，但贵得少了）。

**保真度**（幻/丢/编）：ptc 修前 3 轮、修后 3 轮**全部 0/0/0**；both 修前 1 轮幻3、2 轮 0，
修后 1 轮**幻9**、2 轮 0——修后那轮 4 个孩子只有 topic-1 交了事实（其余 3 个 0 产出、父自己补齐，
准确率仍 12/12），孩子 output 18207 token（特别啰嗦）。**该现象修前修后都有**（修前第 2 轮同样有孩子 0 产出），
n=3 各不足以判定趋势，只能说「没有证据表明修复引入了它」。

复跑命令：

```bash
# 修后四档矩阵（n=3）
node bench/ab/run-ab.mjs --task bench/ab/task-facts --prompt bench/ab/task-prompt-facts.md \
  --grader bench/ab/grader-facts --out bench/ab/out-facts-postfix2-mx-1.4.0 --repeat 3 --skip-judge \
  --arms bare,codemode,ptc,both

# 修前同款（对照，用 --regrade 可只重判不重跑）
node bench/ab/run-ab.mjs --task bench/ab/task-facts --prompt bench/ab/task-prompt-facts.md \
  --grader bench/ab/grader-facts --out bench/ab/out-facts-mx-1.4.0 --repeat 3 --skip-judge \
  --arms bare,codemode,ptc,both
```

**读法（重要）**：bare / codemode 两档**根本不派子代理**，修复对它们零影响——但它们的总成本在两批之间
也动了 +24% 和 +69%（codemode 修后第 2 轮 $0.02492、29 次 bash 是乱搞轮）。⇒ **母线噪声与效应同量级**，
「−26%~−36%」只能当方向，不能当精确效应量；能当硬结论的是机制侧（`<ptc>` 节 4/4 消失）与
子代理粒度（每子 input −43%，两个派发档都一致）。

**codemode 修后第 3 轮的 0/12 不是修复引起的**：那一档没装本仓扩展（官方 codemode 只有 read/bash/edit/write），
模型自己用 bash 起了 4 个 `pi` 子进程，孩子交回档案里的原始数字（`F1-1 = 120` 而非算好的 240）⇒ 判分器解析正常、
模型没算。同类的「模型自造派发路径」在派发档以外也会出现，别记成产品缺陷。

**附带效应**：孩子不再能派孙代理（depth>0 早退）⇒ 顺带关掉了「递归闸门因 depth 恒为 0 而永不触发」的
无界递归洞。子代理的报告仍走 `prompt-json` 通道（契约块在 `--append-system-prompt` 里，不受影响）。

## 第十轮：契约修复 + projectContext 旋钮 + 提示词引导实证（2026-10-31）

### 包侧改了什么（4 处，都是「没做的继续做」清单上的）

| 改动                    | 位置                            | 为什么                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **契约块修复**          | `dispatch/src/report.ts`        | 旧文案「"summary" is your deliverable」把**报告**说成交付物 → 孩子把事实塞进自造形状的 JSON 块 → 解析器只认含 `summary` 的形状 → **整块被丢**（实测 3/12 孩子中招）。改为「报告=摘要、交付物按任务格式写正文」，并把 `ptc_child_report` 工具通道提到首选（形状由 schema 保证） |
| **projectContext 旋钮** | `dispatch/src/child-process.ts` | 新参数 `none` = 孩子不加载 AGENTS.md/CLAUDE.md（旗标 `--no-context-files`，0.86.1 起就有，**无需版本门**）。默认 `auto` = 照常加载（旧行为，零回归）——用不用由模型自己判断，宿主不写死默认                                                                                     |
| **usage 兜底**          | `dispatch/src/engine.ts`        | 原判定 `!report.usage` 会让「孩子自报 usage 全 0」挡住宿主观测值 → 父在任务面永远看到 0。改为自报 input/output/cost 全空或全零 → **让位给观测值**                                                                                                                              |
| **父面 briefing**       | `routes` + `create-a-task.md`   | 报告丢不丢取决于父怎么措辞（见下）→ 引导要落在父必看的地方                                                                                                                                                                                                                     |

### 台架变了两处（不改造就测不出来）

1. **工作区加一份中性 AGENTS.md**（2279 字节，内容与派发无关）——没有它，孩子根本不背项目上下文，
   `projectContext` 旋钮无从测；加了它，孩子那份上下文实测 **2127 字符**（≈ 一半固定税）。
2. **判分器口径修正**（`grader-facts/check_facts.py`）：孩子事实来源从「只读 `record.report`」
   改成「`record.report` ∪ **孩子的最终正文**」——父在任务面实际读到的就是那份 `text`，
   报告通道一丢就把孩子说对的事实全记成「幻觉」。

### 结果（facts 题 · both 档 · 1.4.0 · n=3 · 污染自检 3/3 干净）

ctx2 = 契约修复 + usage 兜底后；ctx3 = 再加**父面 briefing 修复**（路由索引与册子改成「要报告就点名
child report 的 JSON 块（summary/findings），别自创报告格式」）后复跑。

| 轮     | 判分     | 幻觉/丢失 | 报告通道               | 旋钮自发使用            | 每子 input | 每子 input+cache | 端到端成本 |
| ------ | -------- | --------- | ---------------------- | ----------------------- | ---------- | ---------------- | ---------- |
| ctx2-1 | 12/12    | 0 / 0     | prompt-json ×4         | none + strict + timeout | 2775       | 20663            | $0.13404   |
| ctx2-2 | 12/12    | 0 / 0     | none ×4                | none + strict           | 1758       | 4446             | $0.03244   |
| ctx2-3 | 12/12    | 0 / 0     | none ×3 + json×1       | none + strict           | 1429       | 4245             | $0.01835   |
| ctx3-1 | 11/12    | 0 / 0     | none ×2 + tool×2       | none                    | 2083       | 6883             | $0.02552   |
| ctx3-2 | **3/12** | 0 / 0     | prompt-json ×4         | none + strict           | 1557       | 4501             | $0.15809   |
| ctx3-3 | 11/12    | 0 / 0     | tool×3 + prompt-json×1 | none + strict           | 1673       | 8329             | $0.02242   |

**⚠️ ctx3-2 的 3/12 不是包缺陷**：那一轮父写的任务书自己加了「compute nothing extra; if the file
states a derived value, use the value it states」——与题面「读 + 算」矛盾 ⇒ 孩子照办、交了档案里的
**原始参数**（120 / 8 / 2），父照抄 ⇒ 9 条事实错。判分器抓对了。⇒ **父的任务书是孩子的唯一规格；
父写错，孩子忠实执行，全链一致地错**（那一轮每个子代理也最贵，$0.039/个）。

**三个机制结论（可复用）**：

1. **孩子交不交报告，由父的措辞决定，不由孩子的契约决定**——两批 6 轮、24 个孩子：

   | 父在 task 里怎么写                                                            | 孩子交契约报告块          |
   | ----------------------------------------------------------------------------- | ------------------------- |
   | 点名「child report 的 JSON 块（summary / findings / files_touched / usage）」 | **12/12（3 轮全 4/4）**   |
   | 只说「附上报告块」或**自创**一套报告格式                                      | **3/8**（自创那一轮 0/4） |

   父**自创**报告格式最糟：它给了孩子一个更具体、更近的指令，把契约块顶掉了。
   **最硬的机制证据在 ctx3-3**：父的任务书原样抄了路由索引那句「最后附上 child report 的 JSON 块
   （summary / findings / files_touched / usage）」→ 4/4 交——**父面引导文案的一字之改，直接兑现到
   孩子的交付物上**。

2. **`projectContext:"none"` 模型会自发用**（6/6 轮），孩子的 `project_context` 节 **0/24 带**；
   探针实测带上该节时孩子首轮 input 2379 → 1314（省约 45%）。⇒ 「关掉孩子项目上下文」是有价值的
   默认动作，但**由模型按任务判断**，宿主不写死。
3. **「幻觉 12 条」曾是判分器误报，不是产品缺陷**：父拿到的子任务结果里 `text` 字段含孩子的全部正文
   （事实齐全，判分 12/12），`usage` 也是真实观测值（input 149 / cost $0.0139）；只有 `reportChannel=none`。
   修正口径后两批 ctx 产物重判，幻觉从 12/12 → **0/0/0**。

### 复跑命令

```bash
# 带中性 AGENTS.md 的工作区（旋钮有效的前提）
node bench/ab/run-ab.mjs --task bench/ab/task-facts-ctx --prompt bench/ab/task-prompt-facts.md \
  --grader bench/ab/grader-facts --out bench/ab/out-facts-ctx2-mx-1.4.0 --repeat 3 --skip-judge --arms both

# 判分口径改了只重判不重跑
node bench/ab/run-ab.mjs --task bench/ab/task-facts-ctx --prompt bench/ab/task-prompt-facts.md \
  --grader bench/ab/grader-facts --out bench/ab/out-facts-ctx2-mx-1.4.0 --repeat 3 --skip-judge --arms both --regrade
```

## 边界

- OctoBench 官方 Docker 环境本机不可用（无容器运行时），本题面是**自造等价任务**，结论不可当官方分数引用。
- 样本小：宽题每档 n=3、窄题每档 n=2；judge 仅第 1 轮（n=1/档），与多轮中位数不是同一批样本，不可混读。
- 窄题的「passed 条数」不可横比——那是模型自写测试的条数差异，质量指标是 `failed=0 / errored=0`。
- 两题都是**单进程单任务**形态，dispatch 引擎（子代理派发）全程未被触发，本台架对 dispatch 不构成任何结论。
  - **2026-10-30 跨版本轮修正**：0.86.1 的 `both` 档**触发了派发**（4 个子代理全 succeeded）——
    同一道题、同一个模型，**换 pi 版本就走出完全不同的路径**（1.4.0 的 `ptc` 档 0 次程序调用，0.86.1 的等价档 33 次）。
    题型（24 模块批量补 docstring）在 floor 版本上会诱导出扇出策略，在新版本上不会。
    - ⚠️ **2026-10-30 第五轮再修正：上面这两条都是污染态产物**（工作区在本仓内，本仓 AGENTS.md 灌进了会话）。
      干净态复测：floor 0.86.1 宽题 `ptc` 档 n=3 → **0/3 派发**；1.4.0 扇出题四档 n=3 → **0/12 派发**。
      「换版本走出不同路径」不成立——**干净态下跨版本结论一致**。
- 干净态总样本：1.4.0 扇出题 12 轮 + floor 宽题 3 轮 = **15 轮**，**0 轮自发派发**。
  「模型会不会自发派发」的样本量仍然偏小（15 轮、2 个题型），**只够支撑「没观察到」，不够支撑「不会」**。
- floor 0.86.1 上 `both` 档**不可测**（该版本没有 codemode 内建扩展 → 闸门跳过），
  所以「本仓 vs pi 自带 codemode」的直接对照**只能在 0.99+ 上做**。
- 跨版本**时间不可横比**（0.99 的 bare 171.9s vs 1.4.0 的 bare 65.9s）：版本差异与模型随机性混在一起，只横比「能否跑 / 质量 / 是否触发程序调用」。
- 跨版本矩阵 **n=1/档**，采用率数字只当量级参考，不当效应量。
- 判分脚本是头号误差源（历史已踩：仓库根定位错、把 Markdown 标题当条目）。任何失败先自查判分器，再归因模型。
  - 本轮新踩一坑：**judge 少返回几条 check，分母就跟着变小、reward 虚高**（窄题 codemode 档只判了 21/28 项却拿了 0.952，看着比别档高）。
    修法：判分结果按 `check_id` 与原 checklist 对齐，漏判的按 fail 计入分母；整类调用失败也按全 fail 计入。
  - 另一处已知误判：`SP_language_matches_user`——模型全程中文回答（189–391 个汉字）却被判 fail（judge 按英文字母比例判成了英文）。
    judge 分数因此只当辅助信号，**硬结论一律用客观判分**。
  - 第三处（新踩，台架侧）：**`defaultTools` 的 `+name` 修饰符语义 0.99+ 才有**——0.86/0.87 上原样当工具名列表，
    不存在的工具名会让激活工具集变成**空集**，模型面前零工具却看起来像「模型崩了」。跨版本跑之前先看上面的版本适用性表。
