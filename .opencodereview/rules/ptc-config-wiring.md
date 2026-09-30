# PTC Config Wiring（audit 3e，阻塞级）

适用文件:`src/runtime/limits.ts`、`src/runtime/turn-pools.ts`(锚点在 `.opencodereview/rule.json`,
`merge_system_rule: true`)。生效面比锚点宽:只要 diff 新增 / 改名 / 删除任一 config 键,或改动任何读
`PtcConfig` 字段的生产文件(`dispatcher.ts` / `worker-pool.ts` / `dispatch.ts` / `bindings.ts` /
`background-runtime.ts` / `run-code.ts`),就必须按本规则自查 —— 读点不在锚点文件里, 而在你改的那个文件里。

锚点注记:本规则的两个锚点都是 `.ts`,所以 **review 模式会正常投递**(`ocr delegate preview` 收 `.ts`/`.js`/`.json`)。
但有一个投递盲区必须手动补:`preview` 对 `.md` 一律 `exclude_reason: unsupported_ext`,只收它们的
`ocr scan` 才收(全文件模式额外收 `.md`/`.yml`/`.mjs`)。因此当 diff 只动了文档 —— 例如新写一篇 ADR 声明了
一个新旋钮、或改了 `docs/usage/*.md` 的旋钮说明 —— host agent **必须手动套用本清单**,不能因为
`reviewable_files` 里没有 `.md` 就认为本规则没被投递:「声明侧」恰好住在文档里,而本规则治理的正是
「声明了但没接线」。

## 风险

本仓最大的风险不是写错, 而是**少写**:spec、README、ADR 或源码注释声明「行为 X 由旋钮 Y 驱动」,
但生产代码里根本没有 Y 的读点。审计目标是 omission / silent misconfiguration。

- diff 只包含已经写下的代码。**缺席的读点不进 diff**, 逐行评审永远撞不见它 —— 你把 diff 从头看到尾,
  也不会看到「这个键没人读」, 因为它在 diff 上不存在。
- 现有验证恰好绕开它。「机制存在」不等于「接线存在」:API 有 guard、函数可调用、schema 校验通过、
  `DEFAULT_CONFIG` 里有这个键、`resolveConfig` 能把它合并出来 —— 这些全部为真, 行为照样是错的。
  这类「验证存在但绕开缺口的」假阳性是本规则的靶心。
- 结论是 silent wrong behavior:用户设了旋钮, 系统接受、记录、却在别处硬编码了另一个值。
  没有报错、没有日志、单测全绿, 只有在生产上以「调了没用」的形式暴露。

`limits.ts` 是这条风险的集中地:`PtcConfig` 15 个键 + `WORKER_ENV_ALLOW_LIST` 构成一整个对外承诺面,
每个键背后都是一条「用户以为能调 → 谁兑现 → 兑现成什么」的链。

## 承诺面基线(15 键 + 1 白名单,及其当前生产读点)

评审时以此为比对基线:任一键在生产路径上找不到读点, 就是发现。行号取自 `src/`。

| 键                         | `DEFAULT_CONFIG` 值                     | 生产读点(file:line)                                                                            | 值如何流入承诺行为                                                  |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `timeoutMs`                | 120_000                                 | `limits.ts:166`(`effectiveTimeoutMs` 回退)→ `dispatcher.ts:355` → `dispatcher.ts:1056`         | run 截止定时器 `setTimeout(beginCancel("timeout"), timeoutMs)`      |
| `maxTimeoutMs`             | 600_000                                 | `limits.ts:167`(`Math.min` 夹取)、`run-code.ts:87`                                             | 请求截止时间的上限, 夹取后才是生效值                                |
| `maxOutputBytes`           | 67_108_864                              | `dispatcher.ts:610`、`dispatcher.ts:614`                                                       | `accountOutput` 累加 logs + completion, 超预算以 `outputLimit` fail |
| `maxMessageBytes`          | 134_217_728                             | `dispatcher.ts:596`、`dispatcher.ts:768-783`                                                   | 单帧序列化字节上限, 双向生效                                        |
| `maxPendingCalls`          | 128                                     | `dispatcher.ts:588`、`worker-main.ts:111,253`                                                  | worker→host binding 调用的准入控制                                  |
| `maxParallelSubCalls`      | 10                                      | `dispatcher.ts:622`(`acquireBuiltinSlot`)                                                      | builtin 绑定扇出的并发槽, 溢出 FIFO 排队                            |
| `dispatchConcurrency`      | 8                                       | `dispatcher.ts:455`(`new DispatchSlotCounter`)、`dispatch.ts:116`、`background-runtime.ts:505` | `pi.dispatch` 在飞调用的硬拒上限                                    |
| `maxDispatchDepth`         | 3                                       | `dispatcher.ts:734`、`dispatch.ts:258,977`                                                     | 递归 dispatch 深度判定(childDepth <= maxDispatchDepth)              |
| `maxItemsPerCall`          | 4_096                                   | `dispatcher.ts:587`、`worker-main.ts:584-594`                                                  | 单次 `parallel()`/`pipeline()` 接受的项目数                         |
| `graceMs`                  | 3_000                                   | `dispatcher.ts:1001`(`armGraceTimer`)                                                          | 协作取消窗口, 到期强杀                                              |
| `maxOldGenerationSizeMb`   | 512                                     | `worker-pool.ts:71`(→ `resourceLimits`)、`turn-pools.ts:56`                                    | V8 老生代上限, 仅在 spawn 时生效                                    |
| `maxYoungGenerationSizeMb` | 64                                      | `worker-pool.ts:72`                                                                            | V8 新生代上限, 仅在 spawn 时生效                                    |
| `poolSize`                 | 4                                       | `turn-pools.ts:45`、`worker-pool.ts:239`                                                       | 每 turn 池容量(常驻 worker 数)                                      |
| `poolAcquireTimeoutMs`     | 30_000                                  | `turn-pools.ts:46`、`dispatcher.ts:371`                                                        | acquire 等待上限, 超时以 `kind: workerExit` 失败                    |
| `drainGraceMs`             | 5_000                                   | `turn-pools.ts:50`、`worker-pool.ts:93`                                                        | 池退役 drain 的上限, 无论如何都 resolve                             |
| `WORKER_ENV_ALLOW_LIST`    | PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP | `index.ts:143`(对外导出)、`limits.ts:129`(`createWorkerEnv`)                                   | worker 唯一可继承的环境变量集合                                     |

并行旁注:`BUILTIN_BINDING_NAMES`(`bindings.ts:41`,消费点 `ptc-mode.ts:41`、`common.ts:124`、
`dispatcher.ts:586`)与 `DEFAULT_BINDING_NAMES`(`bindings.ts:64`,消费点 `index.ts:121`、`bindings.ts:187`)
属于同一承诺面:「暴露哪些 binding」也是配置承诺, 改动必须报读点。

## 必查

1. **键的读点清单**。对 diff 中每个新增 / 改名 / 删除的 config 键(含 `WORKER_ENV_ALLOW_LIST`、
   `BUILTIN_BINDING_NAMES` 这类名称表), 逐个报出:
   - 生产路径读点的 `file:line` 清单;
   - 该值如何流入承诺行为(哪一行把值交给了哪个行为)。
     报不出读点的键 = 断言「本键未接线」, 直接进阻塞触发。改名与删除最容易漏:改名后旧名残留读点
     (写了新键、忘了改读点)是 `silent misconfiguration` 的经典形态, 要同时 grep 新名和旧名。

2. **接线证据的唯一标准:读点存在, 且值流入承诺行为。** 以下一律**不计**为接线证据:
   - `PtcConfig` 接口里的字段声明(`limits.ts:19-86`);
   - `DEFAULT_CONFIG` 里的写入(`limits.ts:88-104`);
   - `resolveConfig` 的合并与校验(`limits.ts:142-153`)—— 它只把值搬到对象上, 不产生行为;
   - schema 校验 / typebox `PARAMETERS` 声明(`run-code.ts:68-90`);
   - 备份、回放、迁移路径上的读点 —— 这些路径**不产生生产行为**, 只在恢复历史状态;
   - 只有测试引用了该键。
     报读点时要给「读点到行为」的中间那一跳, 不能只贴一个 `config.maxXxx` 出现的行号就算交差。

3. **禁止以「机制存在」替代读点证明。** 以下都不是证据, 见到就要追问:
   - 「API 里有 guard」(`effectiveTimeoutMs` 会 clamp, 不代表调用方真的走了它);
   - 「单测全绿」;
   - 「键已注册 / 已导出 / 已校验」(`index.ts:118-145` 的 re-export 只是门面);
   - 「注释写了它是这样工作的」。
     单测尤其危险:测试断言的是 `resolveConfig({...})` 的返回值, 不是生产行为。必须追问「哪条生产路径
     会因这个键不同而给出不同结果」。

4. **双形态检索。** 每个键查两遍:
   - 字面量形态:键名在 `src/` 全量 grep(例如 `maxOldGenerationSizeMb`);
   - 常量 / 载体形态:值可能被包在结构体里再消费(例如 `resourceLimits` at `worker-pool.ts:70-73`、
     `env` at `worker-pool.ts:62`、`workerData` at `worker-pool.ts:65-68`、
     `serialize`/`serializedBytes` at `dispatcher.ts:595`)。
     只查键名会漏掉「键换了名字但仍被消费」的接线, 只查结构体名会漏掉「结构体还在但键被摘掉」。

5. **双计数器不得混淆。** `maxParallelSubCalls`(builtin 绑定扇出, `dispatcher.ts:622`)与
   `dispatchConcurrency`(`pi.dispatch` 在飞调用, `dispatcher.ts:455`)是两个**独立计数器**,
   `limits.ts:35-36` 已明确写 “neither cap throttles the other”。评审要点:
   - 两者数值不同(10 vs 8)是有意的, 不要在 diff 里「顺手对齐」;
   - 溢出语义不同:builtin 溢出 FIFO 排队, dispatch 溢出立即 `{ status: "rejected" }`;
   - 新增并发上限时, 必须说明它挂在哪个计数器上, 以及它与另一个计数器的关系;
   - 若 diff 让其中一个的占用去消耗另一个的额度(`limits.ts` 注释里禁止的形状), 这是契约变更, 阻塞级。
     附带的第三对:`poolSize`(常驻 worker 数)与 `dispatchConcurrency`(在飞调用数)也是两个天花板
     (`limits.ts:63-69`), 同样不得互相推导。

6. **显式挂账是唯一合法退路。** 「值读到了但不完全生效」的偏差, 只有两种合法形态:
   - 写进**源码注释**, 写明哪条路径惰性、为什么(参考 `turn-pools.ts:51-62`: per-run `PtcConfig` override
     对 `maxOldGenerationSizeMb` / `maxYoungGenerationSizeMb` / `env` / `workerData` 在池化路径上惰性,
     因为热 worker 保留 spawn 时的设置, 只有冷路径生效); 或
   - 写进 `docs/adr/` 并**建 follow-up issue**。
     「后续处理」「TODO 待优化」「不在本次范围」不算挂账 —— 没有 issue 号、没有可点击入口的挂账是
     无挂账。`turn-pools.ts:51-62` 是正面样板:它同时写清了惰性字段、冷路径的行为、以及调用方想要不同设置时
     应该怎么构造(`TurnPools` 或不用池)。

7. **机器防线。** 每次新增 config 键, 必须配一条 source-scan fixture, 断言「每个 config 键在 `src/`
   有读点」。**已落地**:`tests/config-read-points.test.ts`(PtcConfig 15 键 / BUILTIN_BINDING_NAMES 7 个 /
   WORKER_ENV_ALLOW_LIST),形态可参考 `tests/test-meta-discipline.test.ts`(`readdirSync` + `readFileSync`
   自扫源码)、`tests/ocr-anchor-coverage.test.ts`。
   抽取器本身有三个必须满足的防御:
   - 断言命中集合**非空**且有**数量下界**(例如 `expect(键数).toBe(hits.size)` 或
     `expect(hits.size).toBeGreaterThanOrEqual(DEFAULT_CONFIG 键数)`)。正则失效 / 路径写错 / 目录改名
     会让「全称断言」静默恒真 —— 没有下界, 这条防线本身就是本规则要找的 silent failure。
   - 抽取逻辑要能被一条故意的假阴性测到(即 fixture 自身有反例测试), 否则无法区分「绿灯 = 有读点」
     和「绿灯 = 没扫到」。
   - **先剥注释再匹配, 并且只认「声明语句结束行之后」的行**。本仓 `limits.ts` 注释密度极高,不去注释
     会被 JSDoc 喂饱恒绿;而声明体(`PtcConfig` 字段、`DEFAULT_CONFIG` 字面量、名单数组元素)必须在
     声明语句之后才可能被算作读点。**注意不要整文件排除声明文件**:`maxTimeoutMs` 的唯一生产读点就是
     `limits.ts:167` 的 `effectiveTimeoutMs` 内部,整文件排除会让它误报 missing。
   - **逐名读点不是唯一合法判据。** 若某个承诺面走泛读(遍历常量 + `source[name]` 这类),逐名 identifier
     扫描要么恒红、要么只能放宽成「声明体里出现过」= 恒真。`WORKER_ENV_ALLOW_LIST` 就是这种形态:
     六个名字在 `src/` 里只以字符串字面量存在于声明体内。这种面必须换成
     「名单常量被读 + 消费函数在生产路径被调用 + 每个名字逐个走行为断言」三条,**并把降级理由写进注释**。
     把判据放松到恒真比没有判据更糟 —— 它不会红,只会假装自己扫到了。

## 反事实判据(接线专属,每个键必问)

    第一问:把旋钮 Y 翻成相反值(设成 0、设成极大、换成另一个极端), 行为 X 会变吗?
             不会 = 未接线。这是最快的判据, 也最难被文案绕过。

    第二问:该读点在生产路径上, 还是只在测试 / 回放 / 备份 / 迁移路径上?
             只有后者 = 对生产承诺而言未接线。

两问都答不出「会变, 且在生产路径上」, 就按未接线处理。补充第三问用于已经接上的键:
该值流入的路径是不是**所有**承诺路径都覆盖?例如 `maxOldGenerationSizeMb` 接上了, 但池化路径与冷路径
两条路只覆盖一条 —— 那是「已接线 + 显式挂账」的形状, 而不是缺陷;没写挂账才是缺陷。

## 阻塞触发

- 新增 / 改名 / 删除的 config 键在 `src/` 生产路径上**无读点**, 且无机器防线 → PR 阻塞,
  标 `possible silent misconfiguration`。
- 有读点但只落在测试 / 回放 / 备份 / 迁移路径上, 且被文档或注释描述为生产行为 → PR 阻塞
  (文档过度声称, 同样是 silent misconfiguration)。
- 偏差只在注释里说了「后续处理」而没有 issue / ADR 挂账 → PR 阻塞。
- 缺失 source-scan fixture, 或 fixture 的抽取器无数量下界(可静默恒真) → 阻塞级 finding。
  注意:这条针对**新增键**;存量键的补测可以先开 issue, 但必须在 diff 里显式挂账。
- `maxParallelSubCalls` / `dispatchConcurrency`(或 `poolSize`)被互相节流、对齐或合并计数 → PR 阻塞
  (契约变更, `limits.ts:35-36` 明确禁止)。

## 严重性升级(Q9-D)

升级到 delegate 复核。理由: 命中项属于 omission / silent misconfiguration —— diff 上没有证据可以看见,
缺席的读点只能靠「翻旋钮」的主动检索才能发现;OCR 的 precision 优势补不了这个 recall 缺口。
判定动作是机械的反事实检验(改值、跑、观察行为变没变), 恰好是 OCR 做不到而 delegate 复核能做的事。
