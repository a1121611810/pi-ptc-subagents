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
- **快腿面全绿**：`pnpm test`（`check:imports` + vitest 四 project）⇒ **15 份探针 / 341 条用例全绿**。
- **能力矩阵自检**：`problemsFor("all")` 与 `problemsFor("fast")` 均 **0 条问题** ⇒ 58 能力 / 102 条 mutant / 17 份能力探针（另 5 份 live 额外探针，实测共 22 份探针文件，比 §5 预估的 12–15 份多——按面并行分工时拆得比预估细，能力覆盖与归属判据不受影响）。
- **变异门禁全杀**：`node scripts/mutate.mjs`（快腿四面 96 条 mutant）⇒ **杀死 96 / 96、存活 0**，每条都由 `kills` 指定的那条用例杀死（无假杀死）。另单独验 `node scripts/mutate.mjs bench` ⇒ **3/3 全杀**。全量 102 条中余下 3 条属 website 面，见下「如实报告」。
- **收窄重建等价**：一次性逐字节等价校验（完整 sha256 指纹 + 双向文件集比对）⇒ **7 个包通过**，§1.6 的安全阀成立，未触发退回全量根构建。
- **负向自检**：把任一 mutant 的 `to` 改回 `from` ⇒ 报「变异无效」而不是「杀死」。行为等价的变异（把 `> 0` 改成 `>= 0` 而判定处本就用 `timeoutMs ?` ⇒ 0 早已 falsy）**已识别并换成真会改行为的锚点**，重跑 3/3 全杀。
- **旧层清点**：37 份已跟踪旧探针 + 1 份未跟踪旧探针 + `scripts/mutation-check.mjs` 已删；判据脚本逐项仍在（import 门禁 / 站点 6 gate + 反事实 harness / 判分器自检 / 五条真机冒烟 / Kimi 正确性矩阵），且新层里有对应的调用型探针。

如实报告（未覆盖）：

- **站点面在 main 上本就红**：落地页门禁 `check-landing-tool-names.mjs` 因 `ptc_progress_update` 注册了却既不在 `MUST_APPEAR` 也不在 `DECLARED_ABSENT`（v7.11.0 / 2026-11-09 引入；站点构建不在 CI ⇒ 一直没被发现）⇒ `--project website` **5 通过 / 3 红**，3 红同源；反事实 harness 自己报「未变异副本上门禁本来就红 ⇒ 这条 case 证不了什么」。按本轮刀口（站点源与产物不动）**未修**，需产品侧二选一：进 `MUST_APPEAR` 并在落地页展示 / 进 `DECLARED_ABSENT` 并写理由。其余 3 条反事实（internal-links / style-scope / projection-coverage）均 ✓ caught。
- **live 面未实跑通**：本机 pi 1.5.2 与扩展都能加载、真机脚本能启动，但 **provider 返回 429「已达到 Token Plan 用量上限」**，pi 自动重试 3 次后放弃 ⇒ 父会话零工具调用，模型继承根本没被测到（**不是模型不配合**）。判据脚本已加 provider 错误的显式归因：provider 不可用时先报它，不再误报成「父没有派发孩子」。按口径 live 不进 CI，进发版人工 checkpoint。
- **真实 DeepSeek OCR 调用仍未用真 key 跑过**；`rich_layout_recognition` 不在本轮范围。
