# 0029 测试层推倒重来：Vitest 5 作运行器 + 自研 registry 变异引擎

Status: accepted (2026-11-14)。取代「四制（test:pi / test:output / test:kimi / test:standalone）跑 node:test」这条门禁口径。

## Context

**一、旧测试层答不了「验到了没有」。** 推倒前的测试层是 38 份 node:test 探针（5329 行 / 274 条用例 / 795 条断言）。断言密度不低（`upgrade-notice` 15 用例 / 69 断言，`vm-cell-runtime` 35 用例，`ocr-tool` 15 用例 / 59 断言），但三件事它没有：

- **归属核对**：38 份里只有 2 份做过「红的是不是该红的那条用例」。探针因为别的断言红 ⇒ 变异算「杀死」⇒ 假绿。
- **能力矩阵**：没有「能力 → 探针 → 变异」这张表 ⇒ 孤儿探针（不再对应任何能力）没人发现，也没人能回答「这条变异该由谁杀」。
- **统一退出码**：仓里同时有 7 套退出语义（node:test 的 status、shell 的 fails 计数、python 的 pytest 码、site gate 的 failed 计数、press 的 exit 0/1…）。发版清单里那行 `pnpm test` 到底覆盖了什么，只能靠人记。

**二、判据（2774 行）与载体（5329 行）是两类东西，不能一起扔。** 手写判据——发布物 import 门禁（110 行）、站点 6 个 gate 与反事实 harness（1167 + 378 行）、判分器自检（260 行）、五条真机冒烟（766 行）、Kimi 正确性矩阵——是**已经写对的业务判断**（且带 battle 过的注释：ADR-0027 的收缩顺序、ADR-0024 的副作用隔离、`bench/ab/self-check.mjs` 头注释里的三条判分器误差）。旧探针是**载体**：它把这些判断装进一套框架里跑。丢判断是倒退，重写判断是双倍工作量且会把 battle 过的知识磨掉。

**三、Node 22 的假红族暴露了旧载体的脆。** commit `8171627` / `fe94327`：假孩子没有 stdio 管道 ⇒ await 窗口里零 ref 句柄 ⇒ node 22.23.4 判「event loop has already resolved」⇒ CI 22 腿连红两轮，四份探针中招。根因在载体（自造夹具 + 真等超时），不在判据。

## Decision

### 1. 刀口规则（用户拍板 `layer-only`）

**推倒的是载体（测试层），不是判据（知识）。**

| 类别                                                                                                             | 处置                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 载体：`tests/**` 38 份旧探针 + `scripts/mutation-check.mjs`                                                      | **删掉重写**（断言逐条搬，不重新发明）                        |
| 判据：import 门禁 / 站点 6 gate + counterfactuals / 判分器自检 / 五条真机冒烟 / Kimi 正确性矩阵                  | **原地保留**，由新层的薄适配探针 spawn 调用并断言退出码与输出 |
| 被判定者：产品代码、站点源与产物、Python 判分器与 fixtures/题面/轨迹、随插件发布的产品运行时、装配脚本、研究工具 | **不动**                                                      |

实施时的判断只有一句：**这个资产是载体还是判据/被判定者？**

### 2. 运行器：Vitest 5.1.0（唯一新增直接依赖）

选它不是因为熟，是因为它的源码正好把本仓要的三件事做进默认：

- **文件级 env 隔离 + 子进程池**（`docs/guide/features.md`：默认用 `node:child_process`，每个文件的环境互相隔离）⇒ 本仓「真 spawn / 真子进程 / 真 env 开关」的探针形态能直接用。
- **三条反假绿默认**（v5）：未 await 的异步断言判失败、`expect.poll` 超时判失败、`clearMocks` 默认开。旧层缺的正是这些。
- **JSON 报告给归属核对供料**（`packages/vitest/src/node/reporters/json.ts`：Jest 兼容的 `testResults[].assertionResults[]{fullName,status,failureMessages}`）⇒ 「红的是不是 kills 指定的那条」可机械判定。
- **假时钟接管全局定时器**（`packages/vitest/src/integrations/mock/timers.ts`：默认 fake 全部全局定时器，`node:timers` 要显式 `fakeNodeBuiltins`）——本仓 `packages/**` 无 `node:timers` 导入 ⇒ 引擎的 `setTimeout/setInterval` 默认就能被接管，超时收尸/停滞护栏从「真等 + ref 兜底」变成毫秒级确定性。
- **`import.meta.url` 风险被源码证伪**（`packages/vite/src/module-runner/createImportMeta.ts`：`posixPathToFileHref(modulePath)`）⇒ 本仓 6 处用它算真实路径（worker 启动、program 载体路径、已安装包定位、路由详情目录）安全。

代价：与仓规「不新增依赖」的旧取向相反——但本轮是用户明确要求的「工具全部重新规划」，取舍记在这里。传递依赖 `vite@8` → `rolldown ~1.2.18`，该原生包本仓树里已有（同包同代）。

### 3. 变异引擎：仓内自研，registry 驱动（`scripts/mutate.mjs`）

**否决 11 个在役引擎（StrykerJS / oxmutate / tzap / @mizchi/mutator / testguard-cli / gutcheck / hollow-test / ai-test-check / mutant-bounty / aster / mutant-cafe），理由是同一条：它们的算子集都是 AST 衍生的自动算子。** 本仓要验的变异大半是**语义级**的：删掉工具描述里的一句话、把工具名改成 `doc_ds_ocr_v2`、把表单字段名拼错、把指定行的逻辑删掉——`StringLiteral` 算子只把整串置空，生成不出来。

另三条硬冲突：

- **判据不同**：Stryker 答「测得多不多」（覆盖报告驱动成千上万条变异 + 变异分数门禁），本仓要答「该测的有没有测到」（人工策划的「锚点 → 缺陷 → 归属」对照表）。
- **探针打产物**：本仓仓规是探针直接打 `packages/*/dist/index.js`（ADR-0022/0024/0025/0026 的全部价值都在产物形态上）。Stryker 的模型是「变异源码 → 跑测试」，要让它看见变异得每个 mutant 全量重建。
- **沙箱在本仓不可用**：它的项目复制默认排除 `node_modules`，而本仓是 pnpm workspace（兄弟包 `workspace:*` 软链、`typebox` 只在 `packages/entry/node_modules`）⇒ 副本里既建不出产物也跑不了探针。

**取其形，不取其核**：吸收 Stryker 的 `killedBy` 归属语义与报告 schema（将来换引擎不必重写判据层），其余自研。**还原用内存里的原文写回 + `process.on("exit")` 兜底——不用 `git checkout`**：仓里有并行会话的未提交改动，误伤别人在途工作比变异失败更贵。

### 4. 三条机械判据（本轮重写的真正价值）

1. **杀死归属核对**：注入变异 → 重建 → `vitest run <probe> --reporter=json` → 解析 failed 的 `fullName` ⇒ 必须命中该 mutant 的 `kills`；对不上 = **假杀死**（探针因别的断言红）⇒ 不计杀、判红。
2. **锚点唯一性**：`from` 在目标文件里必须恰好出现一次（旧脚本用 split/join 全量替换，改一处等于改一片）。
3. **能力矩阵完整性**：登记表是单一事实源（`tests/registry/<面>.mjs` 分片 + `tests/registry.mjs` 聚合）；**探针文件不反向声明覆盖哪些能力**（事实副本会烂且没人发现）；孤儿探针 = 红。

### 5. 能力矩阵：58 能力 / 102 条 mutant / 约 12–15 份探针文件

- 每条能力 ≥1 条 mutant（证明探针有牙）；**22 条高风险能力各 3 条**，高风险名单的唯一出处是「真的坏过」清单（CHANGELOG 行号 / ADR / 探针自证记录 / 脚本头注释），不是「我觉得重要」。
- 探针**按面聚**：一份探针承载同面 3–5 条能力；归属核对按**用例**而不是按文件。
- 七个 project（pi / output / kimi / standalone / website / bench / live）⇒ 面内探针互不过河，从目录约定升级为**配置强制**。

### 6. 执行模型：收窄重建 + 隔离复核

每条变异只重建「内联了被改包的产物 + 其依赖包」（别名图实测：entry 内联 dispatch/output/ptc/routes/search/task/tui 的 src；kimi-mcp 内联 output/ptc/routes/search/tui 的 src；output/search/task 的 dist 反过来把 tui（task 还有 dispatch/routes）的 dist 打进自己的 bundle）。**安全阀**：做一次性逐字节等价校验——窄重建产物与根构建产物不一致就退回全量根构建。这不是假想风险：ADR-0027 记过「只重建 tui ⇒ 变异冒烟误判 ⇒ 必须根构建」的同类事故。

### 7. 门禁接线

- `pnpm test` = `check:imports` + vitest 四个快腿 project（pi/output/kimi/standalone）。
- `pnpm run test:site` / `test:bench` / `test:live` = 三个重资产面，各自一条命令。
- `pnpm run test:mutations` = 快腿四面的变异门禁（CI 的 `mutations` job，node 24）；`test:mutations:full` = 全部八面（要站点产物与 uv，进 release 人工 checkpoint）。
- CI **不加** site / bench job：这两个面本来就不在 CI 上（site gate 只在 site build 里跑、判分器自检是手工跑），新增 job 属扩范围。publish 也不加变异 job（trusted publishing 的 OIDC token TTL 短）。
- **缺依赖一律显式失败，不许 skip**（website 没构建 ⇒ 报「站点产物不存在」；bench 缺 uv ⇒ 报「缺 uv」；live 缺凭据 ⇒ 报缺什么）。

## Alternatives considered

| 方案                                      | 否决理由                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 继续用 node:test + 自写垫片               | 归属核对（解析 TAP）与假时钟（`mock.timers`）都能做，但「未 await 异步断言判失败」与「clearMocks 默认开」要自己长期维护，且两套框架并存 ⇒ 退出码语义重新分裂，正是本轮要消掉的东西 |
| StrykerJS                                 | §3 三条硬冲突；且要表达散文/工具名/字段名类变异必须自己写 Babel visitor，工作量与自研相当，还多背 core + vitest-runner + 插件三层耦合                                              |
| oxmutate / tzap / @mizchi/mutator         | 形态最像（oxc 引擎、跑在本仓 Vitest 里），但算子集是 Stryker 规格的移植；oxmutate 明说「no plugin key of its own」⇒ 无自定义算子位                                                 |
| 覆盖率工具（c8 / @vitest/coverage-v8）    | 答「跑过没有」，本轮要「验到了没有」；可作变异点发现辅助，后议                                                                                                                     |
| 插桩式温热执行（一轮构建服务全部 mutant） | 要多写一套插桩，且探针会从「打真实 dist」变成「打插桩件」，与仓规冲突——记为后续升级，本轮不做                                                                                      |

## Consequences

- **代价**：新增直接依赖 vitest；判据脚本的退出码与报错文本从此是新探针的断言对象 ⇒ **契约要冻结**（改判据要考虑新探针，新探针也不能替判据改语义）。
- **覆盖空洞窗口**：Slice 0b 拆旧之后到 Slice 6 铺完能力矩阵之前，行为覆盖只有 OCR ⇒ **该窗口内不合并 main、不发版**（全删的必然代价，用单分支多切片消化）。
- **变异运行期源码处于「被改坏」状态** ⇒ 那段时间不提交、不切分支、不跑其它读源码的命令；还原只靠内存原文写回。
- **变异覆盖不到**：纯渲染像素差异、模型输出质量、真机时序 ⇒ 由五条真机冒烟脚本与真机走查兜底。

## Verification

实测（2026-11-14，Node v26.13.1 / pnpm 12.15.0）：

- **四件套绿**：`pnpm run check` / `build` / `lint` / `fmt:check` 全部退出 0。
- **快腿面全绿**：`pnpm test`（`check:imports` + vitest 四 project）⇒ **16 份探针 / 341 条用例全绿**（矩阵拆成独立文件后从 15 份变 16 份，用例数不变）。
- **性能：接 Vitest 后没有变慢**（同机同负载交替实测；旧层 37 份探针原样落盘到 `tests-old/` 跑完即删）：旧层 `node:test` **4.78 / 4.94s**（274 用例）vs 新层 Vitest **5.56 / 5.71s**（341 用例 + import 门禁）⇒ 只慢 0.8s（+16%），换来 +25% 用例与旧层完全没有的 Kimi 正确性矩阵。
- **两处真根因已修**：① 探针在 PATH 上拉起**真 pi**（`entry` 的 `resolvePiVersion()` 走 `execSync("pi --version")`）⇒ 共享夹具顶层即装一份假 pi（版本 1.5.2 = 本机真 pi 同版本，行为等价），显示面 9.4s → 0.7s、产物形态面 10.6s → 2.1s；② 8 秒的矩阵与其它用例塞在同一文件里串行 ⇒ 拆成独立探针文件（kills 归属按用例标题，搬家不影响归属），快腿面 13.6s → 9.4s。
- **快跑路径的硬地板 = 矩阵自身的 4.5s**（其中 2s 是「无限循环超时取消」那条判定的超时预算）：矩阵是新层**新加进快跑路径**的（旧层快跑路径里没有它），其余 15 份探针都在它周围并行 ⇒ 再压快跑路径只能动判据本身。
- **绝对秒数不可跨机器比**：本机 load 15 / 10 核（用户自己的 `core-fooms/ocrm` dev server 常驻 40% CPU）⇒ 同一套代码在负载下测到 12–13s、机器空转时 8.3s。
- **变异门禁提速**（2026-11-14 同日，用户反馈「跑完比之前慢」）：快腿四面 96 条 **326s → 74s（快 4.4 倍）**，判定一条没放松（仍是 96/96 全杀、0 存活，归属逐条对上 `kills`）。三处砍的都是不碰判定的开销：
  ① **基线每份探针文件只跑一次**（能力 56 条 ⇒ 探针文件只有 16 份；按能力跑会让同一份文件重复跑几十次）——但标了 `alone` 的探针必须**单独跑**：站点反事实 harness 会对**真实工作树**取摘要（性质 4：跑完必须与跑之前逐字节相同），别的探针并发写工作树就会让它红（2026-11-14 踩到：基线并成一次调用 ⇒ `--all` 基线红在「反事实·落地页工具名」⇒ 改成 `alone` 标记 + 其余并行）
  ② **每条变异只跑 `kills` 指定的那一条用例**——归属判定只看「那条红没红」，与整文件跑等价；那条没红就回退整文件（「真存活」与「假杀死」的诊断需要别的用例的失败信息）；前提是探针的用例彼此独立（每条自己备料），单跑与合跑同结果
  ③ **不经 `pnpm exec` / `pnpm --filter`**（bin 路径从包 manifest 解析；收窄重建改跑包自己的 build 脚本，与根构建逐字节等价已由 `--check-narrow` 验过：7 个包通过）
  ⚠️ **旧门禁只有 21 条 mutant**（全在 OCR/Kimi 两份探针上），新门禁 96 条 ⇒ 慢的主因是**活变多 4.6 倍**，不是判定变慢。
- **能力矩阵自检**：`problemsFor("all")` 与 `problemsFor("fast")` 均 **0 条问题** ⇒ 58 能力 / 102 条 mutant / 17 份能力探针（另 5 份 live 额外探针，实测共 22 份探针文件，比 §5 预估的 12–15 份多——按面并行分工时拆得比预估细，能力覆盖与归属判据不受影响）。
- **变异门禁全杀**：`node scripts/mutate.mjs`（快腿四面 96 条 mutant）⇒ **杀死 96 / 96、存活 0**，每条都由 `kills` 指定的那条用例杀死（无假杀死）。另单独验 `node scripts/mutate.mjs bench` ⇒ **3/3 全杀**。**全量 `node scripts/mutate.mjs --all`（102 条 / 58 能力 / 八面）⇒ 杀死 102 / 102、存活 0，16m27s**（含 website 面 3 条反事实：落地页工具名 / 内部链接 / 投影覆盖）。**同日再提速（2026-11-15）**：全量 16m26s → **1m40s**——根因不是变异，是**反事实 harness 的拷贝税**：`bench/ab` 里 3 GB 未跟踪实验数据（站点 gate 一个都不读）⇒ 每条 case 拷两遍 23.5s + 摘要 6.4s ≈ 36s 纯 I/O。改判据脚本 `counterfactuals/run.mjs` 的**拷贝与摘要范围**（剪掉 `bench/ab`）⇒ 整棵拷贝 23.5s → 0.28s、摘要 6.4s → 0.27s，harness 全部 5 条 case 4m55s → **5.25s**，站点探针 9 条 984s → **13.7s**。**判定零变化**（五个 gate 的判定逐条未变、5 条反事实仍全部 caught、性质 4 仍成立；性质 2「未变异副本必须绿」是这道改动的安全网：真变了就会当场报「gate 在未变异副本上已经红了」）。顺带断掉「并行会话往 bench/ab 写实验数据 ⇒ 性质 4 误报」这条路。
- **收窄重建等价**：一次性逐字节等价校验（完整 sha256 指纹 + 双向文件集比对）⇒ **7 个包通过**，§1.6 的安全阀成立，未触发退回全量根构建。
- **负向自检**：把任一 mutant 的 `to` 改回 `from` ⇒ 报「变异无效」而不是「杀死」。行为等价的变异（把 `> 0` 改成 `>= 0` 而判定处本就用 `timeoutMs ?` ⇒ 0 早已 falsy）**已识别并换成真会改行为的锚点**，重跑 3/3 全杀。
- **旧层清点**：37 份已跟踪旧探针 + 1 份未跟踪旧探针 + `scripts/mutation-check.mjs` 已删；判据脚本逐项仍在（import 门禁 / 站点 6 gate + 反事实 harness / 判分器自检 / 五条真机冒烟 / Kimi 正确性矩阵），且新层里有对应的调用型探针。

如实报告（未覆盖）：

- **站点面已全绿**（2026-11-14 修）：落地页门禁 `check-landing-tool-names.mjs` 曾因 `ptc_progress_update`（v7.11.0 引入）既不在 `MUST_APPEAR` 也不在 `DECLARED_ABSENT` 而红——CI 的 `website.yml` 每个 PR 都跑这道检查，从 7.11.0 起一直红着没人接。**决定：进 `DECLARED_ABSENT` 并写理由**（它是长任务进展的辅助通道，落地页讲清 `ptc_run_code` / `ptc_workflow` / 任务面三件就够）⇒ 站点五道检查 **5/5 绿**，`--project website` **9 条用例全绿**（984s，分钟级：反事实 harness 每个 case 要整棵拷工作树）。
- **顺带补上反事实 harness 自己报出的缺口**：第 5 个 gate `check-router-links.mjs` 没有反事实用例，harness 按它的 property 3 把它报成「unproven」——这正是那个 harness 存在的理由 ⇒ 补了 case 与对应探针用例。另修一处超时：探针里 `spawnSync` 自带 300s 上限，把「跑全部 case」那条用例砍在中间（断言收到 null 而不是退出码，看起来像门禁红了）⇒ 放宽到 900s / 1500s。
- **live 面未实跑通**：本机 pi 1.5.2 与扩展都能加载、真机脚本能启动，但 **provider 返回 429「已达到 Token Plan 用量上限」**，pi 自动重试 3 次后放弃 ⇒ 父会话零工具调用，模型继承根本没被测到（**不是模型不配合**）。判据脚本已加 provider 错误的显式归因：provider 不可用时先报它，不再误报成「父没有派发孩子」。按口径 live 不进 CI，进发版人工 checkpoint。
- **真实 DeepSeek OCR 调用仍未用真 key 跑过**；`rich_layout_recognition` 不在本轮范围。
