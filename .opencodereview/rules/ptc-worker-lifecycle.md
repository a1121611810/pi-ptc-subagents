# PTC Worker Lifecycle Contract (audit 3b, 阻塞级)

适用文件:src/runtime/worker-main.ts / worker-pool.ts / worker-entry.ts / worker-source.ts(模式 src/runtime/worker-*.ts)。仓库里没有 src/runtime/worker-state.ts(该路径从未存在):状态机行为由 tests/worker-state.test.ts 覆盖,实现落在 worker-main.ts / worker-pool.ts。

## 状态机(ADR-0017 §5)

    CREATED ── function entry ───────────────► BOOTING
       │                                          │
       │                                control port installed
       │                                          │
       │                                 ┌────────┴────────┐
       │                                 ▼                 ▼
       │                            READY ◄──── ready sent
       │                              │
       │                              ▼ init
       │                          RUNNING
       │                              │
       │                  (program completes / throws / cancel)
       │                              │
       │                              ▼
       │                       reset() + ready sent ─────► READY
       │
       └── (host closes control port) ──► worker terminates

## 必查

1. 状态转换守卫:每个 post() / on() handler 都校验自己是否仍拥有这个 worker。
   run identity(runId / callId)在 init 到达时锁定,后续所有出站 frame 路由到该 run 当时捕获的 port。
   禁止通过 whichever port is open 路由。

2. warm reuse 清理:reset() 在结束 run 时必须证明我仍拥有这个 worker 才清状态。
   切换 run 时,新 init 的 ready 与旧 run 的 terminal frame 不能相互 settle 对方的生命周期。

3. signal 处理:取消时 SIGTERM → 5s grace → SIGKILL。
   跳过 grace 直接 kill 会让子进程留 zombie。

4. handover:connect frame 是 handover 不是 wait(ADR-0017 §10(h))。
   任何被宿主放弃的 worker 都要能被下一个 run 接手。

5. drain 永不挂起(worker-pool.ts):drain() 必须在 drainGraceMs(默认 5s)后强制 resolve,
   而不是 reject / hang。turn-end hook 不能因为一个坏 worker 挂掉。

## 阻塞触发

- 状态机转换无守卫 / frame 路由不锁 run identity / drain 会 hang → PR 阻塞。
- signal 链路缺 SIGTERM grace → PR 阻塞。

## 严重性升级(Q9-D)

与 3a 同:此规则命中即升级到 delegate 复核。
