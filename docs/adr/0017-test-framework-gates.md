# 测试框架：探针转正 + spec 决策 21 机械强制点门禁

Status: accepted (2026-10-27)。审计 F4，issue #291。基准流程图：[full-flow-anatomy.html](../prototypes/full-flow-anatomy.html)。

## Context

审计发现「全仓无任何测试文件」：spec 决策 21 声称八条机械强制点的双向覆盖测试「已经在这个仓库里」是**过期声明**（照抄自旧仓库的 binding contract 语境，重写仓从未有过）。验证长期靠 `/tmp` 一次性探针——行为验过但不可持续：/tmp 易失、CI 没有 test 步骤（Publish 只跑 check/lint/fmt:check/build）、探针的结论随 6.1.0 源码漂移无人知（转正时即发现 f3 探针的同步删除断言已不合异步归档语义）。

## Decision

**1. `tests/` 落位根目录**（非 per-package）：跨包断言（entry 装配 + dispatch 引擎 + routes 册子 + tui 值树）一处就够，per-package 七处是纯结构税；`package.json` 加 `node --test tests/*.test.mjs`（Node 24 下目录参数会被当模块加载，必须用 glob——首个实测坑）。

**2. node:test，零第三方框架。** 引擎 >= 22.19 内建；与仓的叶子零依赖文化一致（vitest 买得到的 watch/snapshot/vi.mock 本仓都用不上，fake pi harness 是 10 行字面量）。选型先例：官方 ponytail 仓同款 `node --test tests/*.test.js`。

**3. 测试直打 `packages/*/dist/index.js`**——探针文化的转正，不改吃法；CI 中 test 步骤排在 build 后。

**4. 决策 21 八条门禁 = `tests/route-registry-gates.test.mjs`。** 机械点 6（工具 description 必须是 registry 的调用）用**行为断言**（假 pi 捕获 registerTool，逐面比对 `TOOLS[name].description(surface)`）替代源码正则扫描——同样的漂移检测力，不引入误报面；进程侧例外（pi_task_ptc / ptc_child_report / web_ds_search）以白名单注出处。

**5. CI 双闸。** publish.yml 加 `pnpm run test`（tag 发布前最后一道）；新增 ci.yml（push main + pull_request 跑四件套+test）——只挂 Publish 会让 main 在两次发版之间带红无人知。

**6. 16 版本冒烟不进 CI。** 各版本 pi shim 在 /tmp 不可移植，其价值全在发版前手工那一次，维持原状不脚本化。

## Consequences

- `pnpm test` 26 用例全绿（五探针转正 18 + 门禁 8）；门禁经变异自证（清空一条 route 的 fact → 机械点 5 立刻红；重建后 8/8 绿）。
- 转正即修出两处**测试环境**坑（与 src 无关，不动运行时）：Node 24 的 `--test` 目录参数行为；`node --test` 给宿主注入 Worker 不认的 execArgv——F8 用例内临时清空 execArgv，真实宿主只有 eval 系参数（`spawnPtcWorker` 的 deny list 已剥，见 AGENTS.md 验证纪律）。
- spec 决策 21「怎么测」列的过期声明改为指向 `tests/route-registry-gates.test.mjs`；两份状态页未做清单划掉 F4。
- 已知未做收窄为：floor 三处考古、发布包不带 dts；16 版本冒烟仍是发版前手工步骤。
