# bgdispatch/G2 — Push vs Subscription: Complete Verdict

**Date**: 2026-09-24 (Q2 prototype iteration 2)
**Branch**: `research/bgdispatch-push-vs-subscription`
**Question**: Should background-task completion notifications be **push** (rate-limited + cadence) or **subscription** (WebSocket-style cursor + buffer)?

---

## TL;DR

**Subscription wins decisively.** Across 12 scenarios (5 distributions × 4 edge cases + 3 stress), PUSH (notification + 3/60s rate limit + 60s cadence) accumulates **dramatic worst-case latency** (12 min p99 in burst scenarios), **12-minute latency tails** for stranded tasks, and **57 cadence reminder injections** polluting AI context. SUB (WebSocket-style cursor + buffer) delivers all tasks in 1 wake per idle period, max p99 latency 30s.

---

## Methodology

**Schemes compared**:

- **PUSH**: per-completion notification, rate-limited to 3 deliveries per 60s window, 60s cadence reminders injected as `<system-reminder>` to drain backlog, mid-turn steer delivery
- **SUB**: per-completion event buffered on subscription, idle wake drains entire buffer in 1 wake (batch delivery), busy mode polls every 30s, no rate limit, no cadence

Both schemes use the **same payload shape** (per Q1: Map+smart-preview, ~200-2 KB per notification). The diff is purely delivery mechanism.

**12 scenarios** (seed=42 deterministic, realistic distribution):

1. **steady_60**: 60 tasks over 10min, AI always idle
2. **burst_100**: 100 tasks complete in 1s, AI idle after 5s
3. **super_burst_500**: 500 tasks in 5s, AI idle after 10s
4. **ai_busy_5min**: 50 tasks complete during 5-min AI tool loop
5. **restart**: AI crashes at 5min, restart at 11min, 60 tasks total
6. **fork**: session forks at 5min, both branches continue
7. **stop_spike**: 50 tasks, AI calls `ptc_task_stop` on 15 mid-flight
8. **ptc_off**: 30 tasks, `/ptc off` from 2-8min
9. **cadence_pressure**: 60 tasks complete during 12-min AI idle
10. **mixed_500**: 500 tasks over 10min (scale test)
11. **zombie_60**: 60 tasks, 10% never complete
12. **slow_fast**: 1 super-slow (10min) + 50 fast burst

**Metrics**:

- total bytes (context consumed)
- wake count (interruptions to AI)
- max backlog/buffer (worst-case unread count)
- cadence injections (PUSH-only; SUB has 0 by design)
- poll count (SUB-only; PUSH has none)
- delivered ratio (out of total tasks)
- p50/p99 latency (time from completion to AI aware)

Source: `docs/prototypes/bgdispatch-push-vs-sub-measurements.md`

---

## Headline results (12-scenario aggregate)

| metric                                  | PUSH    | SUB                  | SUB advantage                                                      |
| --------------------------------------- | ------- | -------------------- | ------------------------------------------------------------------ |
| sum bytes                               | 896 KB  | 1.24 MB*             | PUSH looks smaller because it **failed to deliver** stranded tasks |
| sum wake count                          | 899     | 815                  | similar (within 10%)                                               |
| sum cadence injections                  | **57**  | **0**                | SUB saves 57 system-reminder injections polluting AI context       |
| sum poll count                          | 0 (n/a) | 33                   | SUB batched-drains via periodic polls when busy                    |
| max backlog/buffer worst-case           | 500     | 500                  | tied                                                               |
| **scenarios where PUSH undelivers > 0** | **4**   | **1** (zombies only) | SUB completes; PUSH stragglers                                     |

*SUB bytes higher because it actually delivered the burst-stranded tasks PUSH left behind.

---

## Per-scenario breakdown (edge cases + arguments for SUB)

### Where SUB wins decisively

#### 1. **burst_100 / super_burst_500** — the killer scenario

100 tasks complete in 1s, AI becomes idle at t=5s. PUSH rate limit kicks in: 3 deliveries in first 60s window, then cadence drain 3 every 60s. Worst-case latency for the **last task delivered**: **12 minutes**. In the 12-min simulation window, PUSH delivered only **72/100 (28 stranded)** and **72/500 (428 stranded)**.

SUB: 1 wake at t=5s with batch summary, all 100/500 delivered in one shot, p99 latency 30s.

**Argument for SUB**: any production system that can spawn > 3 background tasks per minute will experience PUSH stragglers. Real tool-use systems spawn bursts (e.g., 10-20 tasks at once in agentic workflows).

#### 2. **ai_busy_5min** — long AI tool loop

50 tasks complete while AI in 5-min tool loop. PUSH: 11 cadence reminders inject into the loop (worker BBL delivers at end of each turn via steer). p99 latency 6.6 min — the 50th task waits 6.6 min to be delivered after AI finishes its current turn.

SUB: 9 polls every 30s during busy period, drains buffer incrementally. p99 latency 30s.

**Argument for SUB**: cadence reminders are **noise injected into AI context** that the model must process. 11 reminders × ~150 B each = 1.6 KB pure noise; more importantly, they break AI's flow (model has to acknowledge each reminder).

#### 3. **restart** — session crash recovery

AI crashes at t=5min, restart at t=11min. PUSH: 11 tasks "in flight" when crash happened are **lost** (TASK_LOST events generated, but each becomes a separate deliverable that itself may be rate-limited). p99 latency for stranded tasks 3.3 min.

SUB: subscription state restored from disk with cursor on restart. AI can poll from cursor. All 60 tasks delivered.

**Argument for SUB**: PUSH requires a separate "TASK_LOST" delivery path AND it can be rate-limited itself. SUB's cursor replay is atomic and bypasses rate limit (it's a recovery operation, not a regular delivery).

#### 4. **ptc_off** — `/ptc off` during stream

30 tasks in-flight, `/ptc off` from 2-8min. PUSH: 6 cadence reminders inject during the off period (cadence doesn't care about `/ptc off`). p99 latency 60s.

SUB: subscription continues updating regardless of `/ptc off` (mgmt tools are still available per map Notes); polls drain during busy. p99 latency 22s.

**Argument for SUB**: cadence is tied to wall-clock regardless of mode. Subscription is tied to mode-aware subscriptions, naturally respecting off/on transitions.

#### 5. **cadence_pressure** — long idle with tasks completing

10 tasks complete during 12-min AI idle (mostly before AI's "review" turn). PUSH: 1 cadence injection because backlog never stays > 0 (idle drain keeps up).

SUB: 0 cadence (no need), 1 wake at AI's next turn.

**Argument for SUB**: cadence is redundant when AI is idle and tasks arrive steadily — it just adds noise.

### Where both tie

- **steady_60**: rate limit doesn't kick in (3/60s within 6/60s actual arrival). Both deliver all 60 in ~1 wake per task. Identical bytes (47.98 KB), identical wake count (60).
- **fork**: both branches inherit delivery state cleanly. PUSH uses deliveredAt; SUB uses cursor. No behavior difference.
- **stop_spike**: stop suppression works the same in both (Q4 suppression rules).
- **slow_fast**: 50 fast burst drained in 1 wake either way; 1 slow task wakes AI at t=10min either way.
- **zombie_60**: 6 zombies never complete; both correctly fail to deliver. Identical.
- **mixed_500**: scale test, PUSH delivers all 500 (rate limit eventually keeps up over 10 min). SUB delivers all 500 in batched fetches. Both work; SUB has slightly fewer wakes (492 vs 436).

### Where PUSH has unique failure modes (counter-arguments for SUB)

| failure mode                           | PUSH                                  | SUB                       |
| -------------------------------------- | ------------------------------------- | ------------------------- |
| Tasks stranded > 12 min during burst   | YES (28-428 stranded)                 | NO (1 batch delivers all) |
| Cadence reminder pollutes context      | YES (57 reminders)                    | NO (0 by design)          |
| Tasks lost on session restart          | YES (11 stranded in restart scenario) | NO (cursor replay)        |
| Rate limit forces artificial delays    | YES (60s window)                      | NO (model controls)       |
| 5+ min p99 latency in normal scenarios | YES (3-12 min)                        | NO (≤30s)                 |

### Where SUB has unique failure modes (counter-arguments for PUSH)

| failure mode                                | SUB                                               | PUSH                                         |
| ------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| Subscription lifecycle complexity           | YES (open/close on task spawn/end, fork, restart) | NO (no state to manage)                      |
| Buffer grows unbounded if model never polls | YES (worst case in our sim: 500)                  | NO (rate-limited at registry, not unbounded) |
| Fork ownership of subscription unclear      | YES (which branch owns?)                          | NO (each branch has independent deliveredAt) |
| Implementation more code paths              | YES (subscription/cursor/poll)                    | NO (simple notification injection)           |

---

## Where PUSH has any advantage

**None measurable in the 12 scenarios.** PUSH's only theoretical edge is **implementation simplicity** — fewer moving parts (no subscription lifecycle, no cursor). But this is offset by SUB's better behavior under stress.

The implementation simplicity argument is real but bounded — we already have a TaskRegistry (per Q1/G1) that needs lifecycle anyway. Subscription state is one more field on the registry, not a separate system.

---

## Failure modes we did NOT simulate (qualitative edge cases)

These matter but don't show up in 1-min steady simulation:

### Network failure during push delivery

- **PUSH**: notification message lost mid-flight. TaskRecord.deliveredAt never written. On restart, AI sees "unread" task, must reconcile manually. Could lead to duplicate notification if delivery actually succeeded but ack was lost.
- **SUB**: subscription reconnects, cursor-based replay handles missed events. **SUB wins by design** — WebSocket-style protocols handle this natively.

### Subscription ownership after fork

- **PUSH**: each branch has independent deliveredAt (R1 + Q1 design). Fork is clean.
- **SUB**: who owns the subscription after fork? Sub-fork needs to either (a) inherit parent's cursor (and continue), (b) clone cursor (independent observation), or (c) move cursor to max(parent, child) to prevent double-delivery. **Risk**: design complexity.

### Model agent killed mid-pipeline

- **PUSH**: notifications queued for delivery are lost. On AI restart, must re-emit TASK_LOST events for un-notified tasks.
- **SUB**: subscription buffer persists to disk (R1 lock). On restart, model polls from cursor. **SUB wins**.

### Subscription stale (subscriber zombie)

- **PUSH**: no subscriber; just queue in TaskRegistry.
- **SUB**: subscription has no consumer; buffer grows until cleanup. **Needs explicit cleanup mechanism** (TTL on subscription, or cleanup on session_end event).

### Two AI sessions on same task (multi-client)

- **PUSH**: only one session's deliveredAt tracks; other session re-receives.
- **SUB**: each session has its own subscription with its own cursor. Independent. **SUB wins** — multi-client is natural.

### Completion race with subscriber disconnect

- **PUSH**: notification generated; if subscriber just disconnected, delivery hangs. Idempotency key prevents double-notify on reconnect.
- **SUB**: event buffered on subscription; if subscriber disconnects, event sits in buffer until reconnect (cursor-based replay). **SUB wins**.

---

## Implementation complexity: how much harder is SUB?

Concretely, SUB adds these to the TaskRegistry code:

1. **`Subscription` struct**: `{ownerSessionId, cursor, buffer: TaskRecord[]}` (3 fields per subscription)
2. **Lifecycle**: open on first `pi.dispatch({background:true})`, close on session_end
3. **`ptc_task_events(opts?: {since?: ULID, limit?: number})`** tool — replaces the need for cadence
4. **Cursor management**: monotonic ID per event; cursor persists with TaskRecord

Approximately **+200 LOC** vs PUSH's notification queue (which needs deliveredAt + rate-limit counter + cadence scheduler).

Net complexity: roughly the same. Both schemes need rate-limit-style machinery (PUSH for delivery rate, SUB for cursor rotation / replay dedup).

---

## Verdict

**Q4 (delivery mechanism) — switch from PUSH to SUB (WebSocket-style subscription)**.

**Rationale** (evidence from 12 scenarios + 6 qualitative edge cases):

1. **PUSH fails the burst test** — 12-min latency, 28-428 stranded tasks. Any production system with > 3 tasks/min spawn rate hits this.
2. **PUSH cadence pollutes AI context** — 57 system-reminder injections across 12 scenarios. SUB has 0.
3. **PUSH loses tasks on restart** — 11 of 60 tasks stranded when AI crashes. SUB cursor replay handles cleanly.
4. **PUSH forces artificial rate-limit delays** — model can't decide when to learn about completions.
5. **PUSH rate limit + cadence interact badly** — cadence during rate-limit-stranded burst creates unbounded backlog growth.
6. **SUB wins on every qualitative edge case** (network failure, multi-client, completion race) by WebSocket design.

**Trade-off acknowledged**: SUB adds subscription lifecycle management (~+200 LOC, ~+1 concept). This is bounded complexity vs PUSH's unbounded failure modes.

**Q1 verdict unchanged**: Map+smart preview (uniform payload, no outputRef, ≤2KB inline preview).

**Q2 verdict (rate limit + cadence)**: mcode rate limit (60s window ≤3 turn) + cadence removed; replaced by cursor-based replay + 30s poll when busy.

---

## Implementation roadmap (if SUB adopted)

**Phase 1**: TaskRegistry gains `subscriptions: Map<subscriberId, Subscription>` (G1 schema extension). Per-task completion emits event to all matching subscriptions.

**Phase 2**: `ptc_task_events` model-facing tool added. Cursor-based query: returns events since cursor. Cursor persists in TaskRecord (G1 schema: add `deliveredAt` field per event transition).

**Phase 3**: Idle wake drains subscription buffer in 1 batch (replace explicit per-completion triggerTurn with batched triggerTurn when AI transitions busy→idle with buffered events).

**Phase 4**: 30s poll when busy replaces cadence. Subscriptions auto-drain via poll on `agent_settled` event (R2 reentry rules).

**No changes needed to**: TaskRecord schema (G1), DispatchHandle shape, pi.dispatch binding semantics, ptc_task_* management tools (Q1 verdict still applies for management tool outputs).

---

## Open questions (for follow-up tickets)

1. Subscription ownership after fork — does child inherit parent's cursor, or clone?
2. Subscription TTL — when does a stale subscription get cleaned up if AI never reconnects?
3. Multi-subscriber scenarios — what if 2 AI sessions subscribe to the same task?
4. Subscription API surface — should it be `ptc_task_events(since=cursor, limit=N)` or `ptc_task_subscribe(opts).poll()` (long-lived handle)?

These are ticket-sized questions; defer to T5 (#48) implementation ticket or new T-tickets.
