# General Review Baseline（audit 兜底层，阻塞级）

适用文件:未命中 `.opencodereview/rule.json` 里任何专用 path 规则的所有文件。**本文件挂在 `**` catch-all 锚上
(`merge_system_rule: true`), 与通用系统检查并存。**

## 背景

本文件是兜底 checklist, 不是重点审查对象:契约类文件(protocol / worker 生命周期 / 后台派发 / 渲染边界 /
config 接线)另有专用规则, 那些文件由专用规则审查, 本层只做补充。命中专用规则锚的文件不要用本层去
重复报专用规则已经覆盖的项 —— 一次 review 里同一个问题报两遍会稀释信号。

兜底层要覆盖的, 是**任何文件都可能犯**的错误:设计气味、错误处理、降级路径、性能、安全、迁移。
这些不看领域知识也能查, 但要看的时候必须给出 `file:line` 和具体动作, 不接受「注意质量」这类空话。

## 绑定规则(先读;它决定后面每一节的强度)

1. **仓库文档化标准优先。** baseline 标记(下一节的 12 条 smell)是通用启发, `AGENTS.md`、
   `docs/testing-constraints.md`、`docs/adr/` 里已记录并认可的做法**压制**这些标记。本仓已明确认可的形状:
   独立的 `src/runtime/adr0015-truncation.ts` 承载截断契约、`WORKER_ENV_ALLOW_LIST` 白名单式环境隔离、
   `dispatchConcurrency` 与 `maxParallelSubCalls` 各自独立计数器。命中这些形状时不要报
   「Divergent Change」「Primitive Obsession」, 那是已决策。
2. **baseline 永远是 judgement call。** 12 条 smell 一律标「possible X」, 不是硬违规, 也不构成
   阻塞触发; 只有当它同时破坏了可观察行为(见「触发式维度 checklist」)时才升级成阻塞 finding。
   报的时候要写「在什么输入 / 什么规模下会疼」, 写不出来就删掉这条 finding。
3. **跳过 tooling 已强制的项。** 本仓 tooling: `oxlint`(lint)、`oxfmt`(`fmt:check`)、`pnpm typecheck`。
   格式、导入顺序、未用变量、类型错误这类不用报 —— 跑一遍 CI 就有答案, 占用 review 预算不产生信息。
   **同时不报与本次 diff 无关的历史技术债**:只在本次改动触碰的行上评, 除非该技术债是本次改动的直接诱因
   (例如本次改动把一个既有的 O(N^2) 路径推到了新的调用点上)。

## 设计基线:12 条 Fowler smell

每条给「是什么 → 怎么修」。按本仓出现频率排序, 前六条最常见。

1. **Mysterious Name**:名字不揭示用途(`handler` / `data` / `process` / `tmp` / `flag` / `x`)。
   修:重命名为能回答「它是什么、谁用、为什么存在」的名字。若认真想不出一个诚实的名字, 说明**职责本身不清晰**
   —— 这时先拆职责, 名字是症状不是病。导出符号、config 键、常量尤其严格。
2. **Duplicated Code**:同一形状的逻辑出现在两处以上(不是两行相似, 是同一种结构:同样的分支序列、
   同样的校验、同样的错误包装)。修:提取成有名字的函数 / 常量 / 判别式;若两处「看起来像但会分叉」,
   提取时要留出分叉点, 不要用布尔参数硬合。
3. **Feature Envy**:一个函数大量访问别的对象的数据, 而自己的状态几乎不用(函数体全是 `other.foo`)。
   修:把该行为搬到它依赖的数据旁边, 或把缺失的那一小块数据取回来。
4. **Data Clumps**:同一组参数 / 字段在多处反复一起出现(`{ surface, runId, callerId, depth }`、
   `{ bytes, source, at }`)。修:封装成一个对象 / 值对象(如 `type Source = { file, line }`), 出现处引用它。
   本仓高危区:dispatcher 上下文、通知渲染属性集、truncation 元信息。
5. **Primitive Obsession**:用裸 string / number 表达领域概念(`"rejected"`、`0`、`"workerExit"`),
   拼错就是静默失败。修:并集类型 / 字面量联合 / 常量表。本仓已有正确形态: `HOST_FRAME_KIND.*`、
   `PTC_ERROR_KIND.*`、`PTC_LOG_LEVEL.*`; 出现裸字面量应当要求改常量引用。
6. **Repeated Switches**:同一组条件分支按同一个维度重复出现(每个 handler 都重新判一次 surface /
   status / 角色)。修:抽成判别表 / 策略表, 或用多态、查表把分支收敛到一处。
7. **Shotgun Surgery**:改一个概念要同时改多个文件(加一个 error kind 要动五处)。修:把「变化的轴」
   收到一个注册表 / 映射里, 新增项只在一处登记, 其余由表驱动。
8. **Divergent Change**:一个模块因多种不相关的原因被改(既是协议定义, 又是渲染器, 又是配置入口)。
   修:按变化原因拆模块。本仓 `limits.ts` 只准是「旋钮的声明与合并」, 行为执行要落在读点所在的文件里;
   一旦 `limits.ts` 出现 spawn / 渲染 / 调度逻辑, 就是越界。
9. **Speculative Generality**:为「以后可能要」加的参数、钩子、抽象基类、可配置项, 当前无第二个调用方,
   无第二个使用者。修:删掉, 等第二个用例出现再加回来。特别审查新加的**可选 config 键**与只有一个
   调用点的扩展点。
10. **Message Chains**:`a.getB().getC().getD().doE()` 式的长链, 调用方知道了太多内部结构。
    修:在中间补一个返回结果对象的方法(问一个对象一个问题), 或把这条链收进拥有它们的模块。
11. **Middle Man**:一个函数 / 类只把参数转发给另一个, 不加判断、不加策略。修:删掉它让调用方直连;
    或给它真正的职责(校验、重试、单位换算、默认值)。
12. **Refused Bequest**:子类 / 实现继承了父类或接口的大半成员, 却把关键的那几个覆写成 throw / 拒绝 /
    空实现。修:拆成两个更窄的接口, 让不支持的能力从类型上就不可见。

## 触发式维度 checklist

命中触发信号才检查对应维度;没命中就整节省略, 不要为了填满 checklist 而报。

### A. 错误处理与日志(对应 `docs/testing-constraints.md` 约束 #3)

触发信号:新增 / 修改了 `catch`、`onError`、abort handler、promise rejection 路径、IO 边界
(fs / net / worker / child process / clock),或新增了降级 / fallback 分支。

必查项:

- 成功与失败两条路径都可观察:每个 IO 边界都要有失败分支, 且失败分支有 `console.warn` /
  `console.error`、或返回带 `errorMessage` 的 rejected 结构、或设置显式错误状态
  (`status: 'rejected'` / `kind: 'workerExit'`)、或抛显式 error。四选一, 零选是阻塞项。
- 禁止空 `catch`、`catch { /* ignore */ }`、静默 `resolve(undefined)`、以及「返回默认空值当作成功」。
- 降级路径要报出降级本身:「拿不到就退回旧值 / 跳过 / 用缓存」必须在 warn 里留痕, 否则用户看到的是
  过期数据而不是错误。
- 错误信息要能定位:带来源标识(`file:line`、runId、callId、source name)。本仓 `dispatcher.ts` 的
  `fail(PTC_ERROR_KIND.*, message)` 与 `accountOutput` 的 source 参数是正面形态。
- 失败结果在类型上要能分辨:`null` / `undefined` / `{ ok: false }` 各自有独立语义, 不共用。

### B. 多轨 / 兜底 / 降级设计

触发信号:同一能力有两条以上实现路径(池化 vs 冷路径、builtin vs dispatch、内联 vs 外部文件、
同步 vs 异步、SSR vs 客户端),或新增了 fallback / 降级 / 兜底分支。

必查项:对**每一轨**写出三元组「输入源 → 判定逻辑 → 输出行为」, 写不全的轨就是没读懂。

- **输入源缺失读点 = 未接线。** 每一轨都必须能在生产路径上指出读点 `file:line`。只在测试 / 回放 /
  备份 / 迁移路径出现的读点, 对生产承诺不算接线。
- **两轨输入源相同 = 冗余警报。** 如果设计声称两轨由不同输入源区分(例如「池化用 holder 的 config,
  冷路径用 per-run config」), 而两轨实际读的是同一个来源, 必须追问「设计承诺的第二输入源去哪了」——
  这类不一致的最终形态是「看起来可调, 实际不可调」。
- **每轨的触发条件必须可观察。** 「用池 / 不用池」这类选择要能从代码或日志判断, 不能是隐式的复合条件。
- 本仓典型双轨, 评审时要主动想起: `maxParallelSubCalls` vs `dispatchConcurrency` 两套计数器
  (`limits.ts:35-36` 明确「neither cap throttles the other」, 数值 10 vs 8 都是有意的, 溢出语义也不同:
  一个 FIFO 排队、一个立即 rejected); 池化路径 vs 冷路径(`turn-pools.ts:51-62` 记录了 per-run override
  在池化路径上惰性、冷路径生效)—— 后者是**已显式挂账**的正面样板, 改动时不能把这条挂账删掉或改写。
- 轨与轨之间的差异必须是**故意**的:若两轨本该等价而 diff 让它们分叉, 要求说明理由。

### C. 性能

触发信号:新增循环内的 IO / await、新增大数组 / 大字符串操作、引入新的序列化或拷贝、
扩大了本已很高的量级。

必查项:

- 循环内是否有 IO / await(逐条 append、逐条 `stat`、逐条 `await` spawn)—— 必须批量化或并行化。
- 是否在重复计算同一个值(反复 `serializedBytes(frame)`、反复 `JSON.stringify`、反复扫同一个数组)。
- 是否重复构建大对象 / 大字符串(`+=` 累积大块文本、每次渲染重建整棵树)。
- **量级校准**:本仓默认预算是 `maxOutputBytes = 67_108_864`(64 MiB)、
  `maxMessageBytes = 134_217_728`(128 MiB)、`maxItemsPerCall = 4_096`。按「几 KB、几行」的直觉判断
  在这里是错的:任何在 64 MiB 级数据上做的 O(n^2) 拼接、逐字符字符串操作、全量排序都是实打实的问题,
  而「多几次数组 push」不是。给 finding 时要附量级估算(元素数 × 元素大小), 不要只写「可能慢」。
- 早退 / 短路是否真的提前了(条件是否在昂贵操作之后才求值)。

### D. 数据迁移与 schema

触发信号:新增 / 修改了落盘数据格式、持久化记录、配置 schema、状态机迁移函数、序列化 / 反序列化代码,
或引入了「旧数据会被新版读到」的路径。

必查项:把迁移当**运维审**来读, 四个问题逐个答:

- **幂等性**:同一个迁移跑两次, 结果与跑一次相同吗?中断在中间, 再次启动会怎样?
- **可回滚路径**:出错时能否退回旧格式 / 旧数据?回滚代码是否也覆盖了已迁移的数据?
- **只跑一次的生产数据**:生产上已存在的记录会被改写吗?改写不可逆吗?不可逆就要有备份 / 幂等标记 /
  显式挂账。
- **枚举转换**:新增 / 删除 / 改名字段值时, 未知值怎么办。必须报错, 不能用 `?? default` 静默吞掉——
  静默 default 是 schema 变更里最常见的 silent failure。
- 迁移函数必须有生产调用点(启动 reconcile 或读路径), 只有测试调用 = 未接线。
- 相关: `resolveConfig` 的 override 是「校验而非强转」(`limits.ts:142-153`)—— 新增 config 键要保持这个
  形状, 别改成 `?? DEFAULT` 兜底, 那是把调用方 bug 藏起来。

### E. 安全与隐私

触发信号:子进程 / worker 启动、`process.env` 读取、argv 构造、日志输出、路径拼接、
渲染与序列化用户或模型提供的任意文本。

必查项:

- **子进程环境泄漏**:进 worker / 子进程的环境变量必须是 `WORKER_ENV_ALLOW_LIST`(`PATH`、`PATHEXT`、
  `SYSTEMROOT`、`WINDIR`、`TEMP`、`TMP`)的子集。白名单之外一律不得进入:token / API key / proxy 配置 /
  home 路径 / 云凭据 / session cookie。新增「顺手把整个 `process.env` 传过去」的写法是阻塞项。
  反向也要查:白名单新增一个键, 要说明为什么它对 worker 必需。
- **子进程 argv 拼接**:命令以参数数组传给 `spawn`(不经 shell), 还是拼进字符串交给 shell。
  拼进 shell = 注入面; 用户 / 模型提供的字符串必须作为数组元素传入。
- **日志泄漏**:写入日志 / `errorMessage` / 通知 / task preview 的内容里不得包含 token、完整环境变量快照、
  宿主 home 绝对路径、用户文件内容全文。报错回显输入时要确认输入本身不是秘密。
- **渲染路径的转义**:任何插值进 XML / HTML / 终端控制序列的文本都要转义, 控制字符要过滤。
  上下文字符串、文件路径、agent 名、任务 label 都属于「任意文本」。
- **能力暴露面**:新增 binding / 工具 / 端点时, 它默认是否对模型可见, 是否需要显式 opt-in。
  默认面只减不增是本仓的既定方向。

## 反事实判据(每个新加的代码块)

    > 把这段代码改成「显然错误但所有现有测试都过」的版本 — 还能过吗?
    > 不能过 = specification(防错误)。
    > 还能过 = characterization(防回归)或没被测试覆盖。
    > 后者必须标出或补测试。

每个新增 / 修改的代码块都要回答, 答案要带测试文件名与断言名, 不能只写「有测试」。

## 相关规则与文档

- 测试纪律(期望值溯源、F1/F2/F3、characterization vs specification、IO 双路径):
  `.opencodereview/rules/test-discipline.md`;`tests/dispatch-*.test.ts` 另有更严的
  `.opencodereview/rules/test-discipline-oracle.md`;规范原文 `docs/testing-constraints.md`。
- 契约类文件有专用规则, **优先于本兜底**: `ptc-protocol-pair-correctness.md`(协议帧常量出口)、
  `ptc-worker-lifecycle.md`(worker 状态机 / signal / drain)、`ptc-bgdispatch-contract.md`(后台派发状态机 /
  终态写入器 / 信号阶梯 / 通知转义)、`ptc-render-bounds.md`(渲染上限与截断契约)、
  `ptc-config-wiring.md`(config 键的生产读点)、`doc-sync.md`(`docs/**` 的文档同步)。
- 设计决策原文: `CONTEXT.md`(领域词条)与 `docs/adr/`。

## 本文件的定位

本文件是 **catch-all 兜底层**:`rule.json` 里 `**` 锚在数组最后一条, 命中即生效
(`merge_system_rule: true`, 与通用系统检查并存)。两点必须记住:

1. **专用契约规则优先于本兜底。** 同一问题如果已有专用规则覆盖, 只报一次, 归在专用规则名下;
   本层只补专用规则没覆盖的部分。
2. **锚点位置不可上移。** `rule.json` 是 first-match-wins, `**` 之前插入任何条目都会让新条目失效;
   相应地, 想让一个文件获得专用规则, 必须把专用锚插在 `**` 之前, 而不是修改本文件。
