# Code review — 路由工程化（一次派发一条任务，模型面散文只有一个出处）(2026-10-22)

Date: 2026-10-22. **被审对象是整个 `feat/routing-engineering` 分支**（`main...feat/routing-engineering`），
需求来源是 #234 与它的 13 张子票 #235–#247。

Scope:固定点 `main`（merge-base `c923f78`）→ 第 1 轮审查 tip `9222a2c`；随后一轮修复；
再一轮 delta 审查（范围 `9222a2c..feat/routing-engineering`）。本轮由**两个只读 agent 并行**产出
（Standards 轴 / Spec 轴），父级复核每一条断言后落地；修复由四个 agent 按文件归属并行。

## 为什么需要 ADR(doc-sync 必查 3 的三条触发线)

三条**全部触发**：① 新增对外契约（新的 model-facing tool `pi_task_codemode`、新的 binding
`pi_task_ptc`、`TaskStatus` 新增 `queued` 态、新的 route registry 与随包详情文件）；② 语义翻转
（`background` 参数退役且**默认值翻转为「不等」**、并发上限从「拒绝」翻转为「排队」、`/ptc off` 从
「开关」翻转为「截断」）；③ 状态机增删边（`queued → running | canceled | lost`）。
新增 11 篇 ADR（0051–0061），修订 6 篇（0016 / 0022 / 0024 / 0029 / 0039 / 0048 / 0050 / 0052 /
0053 / 0054 / 0055 / 0056 / 0057 / 0058 视实际），指针双向可达。

## 为什么写 CHANGELOG(doc-sync 必查 4)

下游 `pi install npm:pi-ptc-subagents` 装到的**能察觉**：两个门改名、两个表面值改名、`wait` 取代
`background` 且默认不等、并发上限改排队、`/ptc off` 改截断、程序改严格模式、模型面散文集中到册子、
详情文件随包发布。全部写进 `CHANGELOG.md` 的 `[Unreleased]` 段（破坏性变更逐条列明）。

## Health gate

- CodeGraph：同步后 206 files / 4 877 nodes / 18 057 edges（审查前先 `codegraph sync`——索引过期会让
  blast radius 的证据是假的）。ocr v1.12.11。
- 全树 `src/*.ts` 规则覆盖：`SYSTEM-ONLY: []`（exit 0）——**这是审查前必须过的门禁**：任何 src 文件落到
  system built-in 都会拿到通用样板而不是本仓的契约规则。
- spec 注入 OCR 的背景文件裁到 **6 204 字符**（OCR 硬限 8 000，超了直接 abort 且只有一行报错）。
  裁法：只留 Solution / Implementation Decisions / Testing Decisions / Out of Scope 四节。
- `.md` 在 OCR **选择层**不可见（实测每个 `.md` 都是 `will_review: false` / `unsupported_ext`），
  `tests/**` 是独立排除（`default_path`）。⇒ **文档与 ADR 的审计只能由父级手工套 doc-sync 清单**。

## Finding 台账（第 1 轮）

| #   | Finding                                                                                                                                                 | 证据                                                                                                                                                                                                              | 处置                                                                                                                                                                                               | 状态       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| S-1 | **【阻塞】写任务记录失败时准入队列留下幽灵，永久丢一个并发槽**——`release` 只删 `#holders`，排队中的持有者在 `#waiters`，删除落空                        | 评审实测：`release(B) -> undefined  active: 1  queued: 1  waiting: ['B']`；随后 `#promote()` 提拔一个**无记录、无调用方**的任务，`#active` 加一、无人释放                                                         | 记录写失败改走 `withdrawAdmission`；新测 `tests/unit/admission-slot-ownership.test.ts`；反事实：还原成 `releaseSlot` → `expected 1 to be +0`                                                       | **CLOSED** |
| S-2 | **【阻塞】`withdrawAdmission` 吞掉自己造成的提拔**——`slots.release(holder)` 丢弃返回值，下一个等待者拿到槽却不被 `onGranted` 调用，永远不启动却一直占槽 | 同测第二条用例（abort 与槽交接落在同一 tick，确定性构造）；反事实：换回 `slots.release` → `expected 1 to be 2`                                                                                                    | 改用**提拔式**释放（`releaseSlot`）                                                                                                                                                                | **CLOSED** |
| S-3 | **【重大】6 处源码注释仍写 `{ background: true }`**，其中 4 处是本次 diff 自己造出来的（改了门名，把退役参数带了过去）                                  | `grep -rn 'background: true' --include='*.ts' src/` → 6 hits                                                                                                                                                      | 逐处核对 `DISPATCH_PARAMETERS` 后改成 `wait: false`；改后 0 hits                                                                                                                                   | **CLOSED** |
| S-4 | **【重大】`dispatcher.ts` 两处注释仍把并发上限描述为「超限立刻拒绝、绝不排队」**                                                                        | `dispatcher.ts:19-22` 与 `:433-438`；`DispatchSlotCounter.acquire`（`dispatch.ts:184-195`）返回 `"granted"`/`"queued"`，从不拒绝                                                                                  | 改写为现状并指向 ADR-0056                                                                                                                                                                          | **CLOSED** |
| S-5 | **【低】不等（detached）那条撤回路径报错了原因**（正常撤回被记成 "could not leave the admission queue"），且无测试                                      | `dispatch.ts:3520-3524`；`tests/unit/queued-task-withdrawal.test.ts` 只覆盖等法路径（`:207`/`:214`）                                                                                                              | 尾部分支改为读竞态的**结果**并共用一条撤回文案常量；补不等路径的测试                                                                                                                               | **CLOSED** |
| S-6 | **【非阻塞】项目规则文件仍写着「`queued` 不存在：并发上限是硬拒」**——而它正是 OCR 交给未来每次评审这些文件的 checklist                                  | `.opencodereview/rules/ptc-bgdispatch-contract.md:20`；`git diff main...feat/routing-engineering -- .opencodereview/` 原本为空                                                                                    | 改成真实的七态机 + 撤回边 + 「队列就是那批 queued 记录」+「只有跑起来的孩子占槽」，并补三条阻塞触发项                                                                                              | **CLOSED** |
| F-1 | **【阻塞】落地页两处散文仍在教退役门名 `pi.dispatch`**，同一文件的特性表却已改成新名 → 页面自相矛盾；**门禁没抓到**                                     | `grep -rn 'pi\.dispatch' packages/website/` → 2 hits（Landing.vue:70/:96）；门禁当时报 "8 claim(s) against 8 registered tool(s)" 并退出 0。根因：`NAME_FAMILY = "(?:ptc\|pi_task)_[a-z0-9_]+"` 匹配不到带点的名字 | 散文改成两扇真门 + 「等待是参数不是模式」；名字族扩到退役名，并加 `RETIRED_NAMES`（失败信息直接点名替代物）与 `NOT_A_TOOL_NAMES`（合法散文提及，带理由的显式豁免）；补反事实 harness + vitest 守卫 | **CLOSED** |
| F-2 | **【重大】词表里约 30 处「现况」说法仍在用退役门名与退役参数**（`pi.dispatch` 32 次 vs `pi_task_ptc` 2 次）                                             | `grep -c 'pi\.dispatch' GLOSSARY.md` → 32                                                                                                                                                                         | 逐条按现况改写；**刻意保留 3 处带日期的历史记述**（改名前的取值、2026-10-20 那次 `TypeError` 实测、当年 `background` 不可用的理由）                                                                | **CLOSED** |
| F-3 | **【重大】ADR-0050 留着「未竟的一格」的注记**，而同一记录 8 行前的 ADR-0058 修订说任务面已随记录走                                                      | `docs/adr/0050-…:13` vs `src/index.ts:1069-1070`（`registry.taskFaceVisible()`）                                                                                                                                  | 按仓里的修订体例改成一条带日期的更正（不改写原决定）                                                                                                                                               | **CLOSED** |
| F-4 | **【重大】e2e 脚本的判据是「名字不许出现」的代理**——ADR-0058 有意**点名**撤掉的门，判据与新契约相反；且脚本**没有退出码处理**（红了也退 0）             | main 上该断言绿（旧 section 不点名任何东西），分支上红；`grep 'process.exit' scripts/verify-ptc-off-e2e.ts` → 无                                                                                                  | 判据改成「不得给出**调用约定**」（三种形态，含方括号），并加「必须说出撤掉了什么」；补退出码；真机跑 4 次全绿                                                                                      | **CLOSED** |
| F-5 | **【轻微】网站脚本头注释仍按退役门名指路**                                                                                                              | `packages/website/scripts/project-docs.mjs:8`                                                                                                                                                                     | 改指 `pi_task_ptc`；顺手把「四份文档」改成「五份」（本次加了第五份投影）                                                                                                                           | **CLOSED** |
| F-6 | **【轻微】`tests/doc-integrity.test.ts` 里有一段重复的注释块**                                                                                          | 该块在 `PIN_TOKENS` 里出现两次，背靠背                                                                                                                                                                            | 删掉重复的一份                                                                                                                                                                                     | **CLOSED** |

## 锚点（循环之外的证据）

`scripts/verify-ptc-off-e2e.ts`：启一个**真 pi**（临时 `PI_CODING_AGENT_DIR` + 装构建产物）、真模型调用，
打开 `/ptc off`，看模型面前剩下什么。

第 1 轮跑完：**5 条断言里 1 条红**（「the section does NOT teach how to create a task」）。查实现后确认
**不是产品缺陷**：截断时 `dispatch-section.ts:104` 根本不渲染索引，返回的是「共同那句事实 + 本表面失去了
什么」，而那两句**点了撤掉的门名**——这是 ADR-0058 有意的决定（两个表面失去的东西不同，各说各的，点名才是
重点），真机模型读到后正确回答「已经被撤走」且**没有去调它**。main 上该断言绿（那时 section 不点名任何东西）。
⇒ 该改的是判据，不是产品。

第 2 轮跑完：**五条全绿，退出 0**。截断后的 section 实测文本：

```
<ptc>
PTC is off in this session. No new task can be created from here on. Do not try to create one.
The PTC execution layer (`ptc_run_code`, `ptc_workflow`) and the task door (`pi_task_codemode`) are withdrawn — `codemode` still orchestrates, but it can no longer create a task.
</ptc>
```

**锚点的价值**：门禁全绿、1 690 个测试全绿的时候，只有真机跑一遍才看得见「e2e 的判据与新契约不再一致」，
以及「脚本红了也退出 0」——后者意味着**锚点在坏掉时也说绿**。

## 第 2 轮（delta 审查，范围 `9222a2c..feat/routing-engineering`）

| #   | Finding                                                                                                                                                                | 证据                                                                                                                                | 处置                                                                                                                                 | 状态                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| R-1 | **【阻塞】`fix/review-d` 从未合进集成分支**——两条 finding 仍留在分支上：e2e 判据还是名字代理、脚本仍无退出码                                                           | `git merge-base --is-ancestor 884531d feat/routing-engineering` → NO；`git diff 9222a2c..feat/routing-engineering -- scripts/` → 空 | 合并 `fix/review-d`（`19be8fa`）                                                                                                     | **CLOSED**                           |
| R-2 | **【非阻塞】新单测漏了**方括号调用形式**（`tools["pi_task_ptc"]`）——正是 ADR-0052 退役、旧文档用过的形状                                                               | 变异 M8（让截断后的 section 说出该形式）→ 12 passed / 12 仍绿                                                                       | 单测改用与 e2e 相同的三种形态正则（`b361e97`）                                                                                       | **CLOSED**                           |
| R-3 | **【非阻塞】落地门禁的**豁免路径没有单测覆盖**（豁免不被认 / 豁免条目过期，删掉自检都测不出来）                                                                        | 变异 M9、M9b → 5 passed / 5 仍绿                                                                                                    | 补两条：允许的非工具必须仍绿；过期的豁免条目必须红（后者用副本脚本的 patch 触发）                                                    | **CLOSED**                           |
| R-4 | **【观察】停机清扫仍会吞掉一次提拔**——`background-runtime.ts:831` 丢弃被提拔的等待者；且清扫只移除**有记录**的等待者，处在「占槽」与「写记录」之间的任务是无记录等待者 | `src/runtime/background-runtime.ts:828-831`                                                                                         | **未修**：窄（会话拆卸），且进程正在退出；delta 只是把那句错的注释改成了对的（"deliberately does NOT start the waiter it promotes"） | **OPEN**（记在本账本，不在本轮范围） |
| R-5 | **【观察】这一轮没有评审账本**                                                                                                                                         | `docs/reviews/` 无本分支条目                                                                                                        | 本文件                                                                                                                               | **CLOSED**                           |

## 被推翻的假设（记录以免下一轮重犯）

1. **「改了门名，旧参数的说法会跟着改」** —— 不会。四处 `pi.dispatch({ background: true })` 是**本次 diff 自己造出来的**：
   改了名字，把退役的参数原样带了过去。改名时要连参数一起看。
2. **「门禁没抓到 ⇒ 那里没有错」** —— 抓到的是**抓不到的那一类**：名字族不匹配带点的名字，于是门禁对那个形状
   是瞎的，而门禁还报「8 claim(s) against 8 registered tool(s)」。**「门禁没报」不等于「没漂」**。
3. **「e2e 跑过就算过了」** —— 脚本**没有退出码处理**，红了也退 0。锚点必须能区分「跑过」与「跑对」。
4. **「名字不许出现」是正确的断言形状** —— 只有当契约是「不许提」时才成立。ADR-0058 的契约是「**要点名，但不给调用约定**」，
   于是断言要测**调用约定**（三种形态，含方括号），不是测名字。
5. **「严格模式的代价是跨 run 污染」** —— 实现票 #244 在 base commit 上复测推翻了它：隐式全局**真的**会被创建，
   但 worker 的 warm-baseline 恢复会在下一次 run 前删掉它，所以**今天不污染**；严格模式把「事后清掉」变成
   「从不创建」。同理，「读一个未声明的名字会静默拿到 undefined」也不成立——**读**本来就抛 ReferenceError，
   静默的是**写**那一侧。spec / 原型图 / 词表 / README 的措辞已按实测订正。

## 本轮没有修、但记在这里的

- **R-4**（停机清扫吞掉一次提拔）：窄，且拆卸时进程正在退出。下一个碰这块的人该知道。
- **`TaskRecord.startedAt` 在出队时被重写**（`task-storage.ts:129-135`），所以 `durationMs` 不含排队时间。源码注释引了
  ADR-0056，但 **ADR-0056 从没提过 `startedAt`**——一条未被记录的行为改动。已记，待补 ADR 的一句话。
