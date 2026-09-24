# Background dispatch: PTC programs can fan out to long-lived child agents with model-visible lifecycle

ADR-0016 added `pi.dispatch(...)` as a parallel binding that returns a `DispatchResult` once the child pi subprocess exits. What ADR-0016 explicitly did NOT add is the lifecycle face of that child: the parent turn's model has no tool to ask "is task X still running", "give me task X's output", or "stop task X". The child lives only as long as the awaited Promise in the program; its state evaporates when the call resolves.

Background dispatch is the long-lived variant. A child may outlive the spawn turn, may run across program boundaries, may finish while the parent is in a 30-minute tool loop, may fail because the host rebooted, and the parent turn's model must observe all of these. The binding remains the spawn surface (so the program keeps agency over who spawns what), but the _state_ moves out of the binding's return value into a session-level **TaskRegistry** whose cursor advances on delivery, and a small set of model-visible `ptc_task_*` tools whose semantics are documented here.

Status: accepted (2026-09-24). Behavior change on the program-visible side (new optional `{ background: true }` opt on the existing binding; new optional `subscribe` interface for cursor-based observation; new model-facing tools `ptc_task_list` / `ptc_task_output` / `ptc_task_stop`; new TaskRecord 21-field schema persisted under `<sessionDir>/`; new subscription event schema with `<bg-task-notifications>` parent + per-event `<bg-task-notification>` children). All changes are additive: existing foreground `pi.dispatch(...)` keeps its `DispatchResult` shape and semantics unchanged.

## Context

This ADR closes the bgdispatch map. The four research/decision tickets it crystallizes are:

- **R1** (background-tasks-peer-survey.md): pi subprocess session-file mechanism -- `--session-dir` dedicated directory, `--session-id <taskId>` for retry idempotence, `--name bgdispatch:*` for audit; pi has no session GC, cleanup is the host's job; resume has no identity check.
- **R2** (pi wake/steer runtime): idle wake = `sendUserMessage(content, { triggerTurn: true })`; mid-turn injection = `deliverAs: "steer"`; agent_end `sendUserMessage` calls lose messages -- new-run pushes to `agent_settled`; extensions must not call `pi.*` from the factory body.
- **G1** (TaskRecord design): 6-state machine (`running / stopping / succeeded / failed / canceled / lost`) -- `queued` deliberately absent in v1 (spawn-or-reject, no in-task queue); 21-field schema; TaskRecord independent of `DispatchResult` and `SubCallRecord`; `ptc_task_list / ptc_task_output / ptc_task_stop` three-tool surface; sub-call tree stripped to a one-shot `dispatched <label> -> <taskId>` anchor, live state moves to the backend panel.
- **G2** (Notification pipeline): four-scheme prototype settled on **B. SUB + Map + preview** -- winner on 4/6 dimensions (perf, tokens-effective, boundary, exceptions) across 12 scenarios x 4 schemes x 6 dimensions.

## What we add

1. **`{ background: true }` opt on `pi.dispatch`** (existing binding). Caller-program passes an opt object instead of a positional argument list; the second positional argument becomes the opts bag. Foreground calls (the existing path, no opts) keep returning `DispatchResult`; background calls return `DispatchHandle`. See Decision section 1.

2. **`DispatchHandle = { taskId: ULID, label: string, status: "running" }`** -- a three-field thin snapshot, the spawn-time projection of the TaskRecord. The handle is what the program (and the model, via the binding's return value flowing into the result tree) carries; the TaskRecord is what the TaskRegistry stores. Hand are append-only -- see Decision section 4.

3. **`TaskRecord` schema (21 fields, persisted)**, persisted to `<sessionDir>/tasks/<taskId>.json` per R1. The file is created on first state transition (lazy), updated on every transition, never deleted by pi-ptc (pi has no session GC; cleanup is the host's job, per R1).

4. **`Subscription { subscriberId: ULID, taskId: ULID, cursor: ULID, status, createdAt }`**, persisted to `<sessionDir>/subscriptions/<subscriberId>-<taskId>.json` per Q3. Subscriber == owner. The cursor is a monotonic ULID that advances on every event delivered. See Decision section 5.

5. **`<sessionDir>/event-log/<eventId>.json`** (append-only) per Q3, indexed by `(subscriptionId, cursor)`. On subscription creation, the buffer replays events since the cursor; on idle wake, the buffer drains in one wake (Decision section 6).

6. **`ptc_task_list`, `ptc_task_output`, `ptc_task_stop`** model-facing tools per G1. Constant model surface; **not** affected by `/ptc off` -- `/ptc off` only gates new spawn (ADR-0016 R6), it does not orphan in-flight tasks (per map Notes clause 5).

7. **`ptc_task_resubscribe(taskId, since: ULID | "initial")`** per Q3 fork semantics. Default `max(parent, child) cursor` for forked branches; explicit reset to `"initial"` for full-replay observation. **v1 status: deferred to v2.** The v1 `subscribe(since?)` seam takes the starting cursor from the caller, so a fork integration supplies `max(parent, child)` itself; neither the helper nor the reset tool ships in v1.

8. **Reopen hooks** (this ADR closes the agenda): when any of these happens, the TaskRegistry fires its existing notification path (cursor advances, parent wakes). They do NOT require new model-facing tools.
   - **Steering** (forwarded): `ptc_task_append(taskId, message)` -- mcode 3-state ack (`activated` / `steered` / `duplicate`). v1 scope: out of scope (map.frozen: 复活/steering 一起评).
   - **Handoff** (mid-task direction change): `ptc_task_handoff(taskId, { reason, newPrompt, label? })` -- child writes `/tmp/<doc>`; old transitions `running -> canceled (reason=handoffed_to_<newTaskId>)`; new task spawned with doc as initial context. v1 scope: out of scope (deferred to v2 + 复活).
   - **Query** (boundary clarification): `ptc_parent_query(taskId, question)` -- child->parent via subscription buffer; parent answers via `ptc_query_response`. v1 scope: out of scope (deferred).
   - **Resume** (cold start): deferred to v2 -- `ptc_task_resume(taskId)` opens `pi -c --session-id <taskId>` continuation (Reasonix "interrupted 拒续、完成态才可续" rule).

## Implementation note (BG-13, file-backed TaskStorage)

Issue #65 ships FileTaskStorage (src/runtime/task-storage-file.ts). It uses the paths in "What
we add" items 3 and 4 unchanged: <sessionDir>/tasks/<taskId>.json and
<sessionDir>/subscriptions/<subscriberId>-<taskId>.json. It deviates from item 5's
<sessionDir>/event-log/<eventId>.json: the append-only log is
<sessionDir>/events/<subscriberId>-<taskId>.jsonl, one newline-delimited file per
(subscriberId, taskId). The log is still keyed by subscriber (the TaskStorage contract and
BG-01's fixed bug): loadEvents(subscriberId, since) merges the subscriber's per-task files into
one ULID-ordered stream. Rationale: one small file per event makes the cursor scan open one file
per event, while a per-pair JSONL log gives O(1) appends and a per-file scan. The 8-method
TaskStorage interface is unchanged and both adapters are kept.

## What we deliberately don't add

1. **No `/ptc off` orphan** -- map Notes clause 5: in-flight tasks continue to deliver notifications and update TaskRecord even when `/ptc off` is on. The mode toggle affects _new spawn_ (ADR-0016 R6); it does not affect in-flight lifecycle.

2. **No spawned-into-quota** -- the existing `dispatchConcurrency` (default 8, ADR-0016) is the only concurrency gate. There is no in-task queue (`queued` state absent, per G1). Spawn above the cap resolves with `rejected` immediately. codex's `agent_max_depth` analogue maps to the existing `maxDispatchDepth` (default 3, ADR-0016 recursive section).

3. **No transparency into the spawned child's tool-calling** -- the model sees `dispatched <label> -> <taskId>` once; mid-flight it sees nothing. Live child state moves to the TUI backend panel (P1), not to the sub-call tree. (G1 verdict section 5.)

4. **No model-visible `subscribe` API** -- cursor management is wholly the TaskRegistry's job. The model decides _whether_ to query (`ptc_task_list`), but never has to manage a cursor. The cursor-based architecture is in service of the registry, not exposed.

5. **No `resume` in v1** -- `ptc_task_resume` is listed in section 8 as a deferred hook, not a v1 surface. R1 already locked "resume has no identity check (ADR 记为已知取舍)" as a known limitation; the v1 task record's `lost` state is the terminal when restart hits a non-terminal record.

## Decision

### 1. Binding shape: `{ background: true }` opt

The existing `pi.dispatch(agentName, prompt, opts?)` foreground path is unchanged. Background is a non-breaking extension on the opts object:

```ts
pi.dispatch(agentName, prompt, {
  background: true,
  label?: string,         // defaults to prompt[:64]
})
-> DispatchHandle   // vs foreground -> DispatchResult
```

Why an opt, not a new binding `pi.dispatch_background(...)`: ADR-0016 already documented the binding as the spawn surface; the long-lived variant is the same binding with a different lifecycle tail. Keeping one binding with one parameterization keeps the program-visible surface narrow.

### 2. State machine (6 states, no `queued`)

| state       | enters from                                       | triggers                                      |
| ----------- | ------------------------------------------------- | --------------------------------------------- |
| `running`   | `(spawn)` (atomic)                                | emit `task:<id>:running`                      |
| `stopping`  | `running` (model stop call)                       | emit `task:<id>:stopping`                     |
| `succeeded` | `running`                                         | child exits 0                                 |
| `failed`    | `running`                                         | child exits non-zero                          |
| `canceled`  | `running` / `stopping`                            | model stop; or `ptc_task_handoff` (v2, defer) |
| `lost`      | `running` (session restart); or restart-reconcile | TASK_LOST_ON_STARTUP                          |

`queued` is **deliberately absent** in v1 (G1 verdict): the cap is `dispatchConcurrency=8` hard reject (ADR-0016); there is no in-task queue; spawning above the cap resolves immediately as `rejected`. G2 prototype v1 surfaced 0 successful spawns that overflowed the cap in 12 scenarios.

### 3. TaskRecord schema (21 fields)

```ts
interface TaskRecord {
  id: ULID;
  label: string;
  agentName: string;
  depth: number; // 0 = parent's direct, 1 = grandchild, etc.
  status: TaskStatus; // 6-state enum
  createdAt: number; // ms epoch
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  transitionAt: number; // last state transition; used for cursor
  outputRef?: string; // <sessionDir>/tasks/<id>/output.log
  outputBytes?: number;
  outputPreview?: string; // <=2KB inline preview (Map+preview)
  stopReason?: string;
  errorMessage?: string;
  exitCode?: number;
  spawnSource: { kind: "ptc-program" | "ptc-batch"; callerId: string };
  parentTaskId?: ULID;
  sessionFile?: string; // <sessionDir>/tasks/<id>.pi-* per R1
}
```

Args and prompt text do **not** live in TaskRecord (privacy + size); they live in pi's own session log. Result body / raw text are not in TaskRecord (size); the model gets them via `ptc_task_output` which dereferences `outputRef` and applies ADR-0015 truncateTail (50 KB / 2000 lines).

### 4. DispatchHandle: thin snapshot, not the source of truth

```ts
type DispatchHandle = {
  taskId: ULID;
  label: string;
  status: "running"; // always "running" at handle creation
};
```

The handle is what the spawning program carries. The TaskRecord is what the registry stores. They diverge only at handle creation: the handle is frozen at spawn time; the TaskRecord advances. The handle is **not** updated on transition; programs that need live state call `ptc_task_list`.

### 5. Subscription cursor: own struct, not the delta of TaskRecord

```ts
interface Subscription {
  subscriberId: ULID;
  taskId: ULID;
  cursor: ULID; // monotonic per subscriber
  status: "active" | "closed";
  createdAt: number;
}
// persisted to <sessionDir>/subscriptions/<subscriberId>-<taskId>.json
```

The cursor is **per-subscriber** (not per-TaskRecord) because fork semantics differ from single-session semantics (Q3 fork):

- **Default fork cursor**: `max(parent, child)` -- child observes events from fork point onwards; pre-fork events are not redelivered.
- **Explicit reset**: `ptc_task_resubscribe(taskId, since: "initial")` resets the cursor to task creation, replays the full event log.

Multi-subscriber broadcast: each subscriber keeps its own cursor; event fan-out is one->N.

### 6. Delivery: subscription cursor-based, no rate limit, no cadence

G2 prototype v1 verified: 4-scheme head-to-head across 12 scenarios, 6 dimensions. The locked choice is **B. SUB + Map + preview** -- winner on performance (p99 30s vs PUSH 9.5 min, 19x faster), tokens-effective (925 B/delivered, smallest), boundary (100% delivered; PUSH 75%), and exceptions (cursor replay handles network / restart / fork).

The rejected schemes:

- **A. PUSH + Tiered** -- 75% delivered in burst / restart scenarios; 9.5 min p99.
- **C. SUB + Tiered** -- same delivery as B but +60% bytes (Tiered payload inflated without rate-limit).
- **D. PUSH + Map** -- 75% delivered; smallest raw bytes (1.69 MB) but effective 940 B/delivered (only marginally cheaper than B for 25% lost).

### 7. Notification message: parent `<bg-task-notifications>` + per-event `<bg-task-notification>`

G2 verdict, locked:

```xml
<bg-task-notifications batch-id="<ULID>" delivered-at-ms="<ms>">
  <bg-task-notification
    id="task:<ulid>:running"
    task-id="<ulid>"
    subscription-id="<subId>"
    status="running"
    label="research X"
    agent-name="researcher"
    depth="0"
    duration-ms="0"
    transition-at-ms="12345">
    <output-bytes>0</output-bytes>
    <!-- output-ref once output.log exists -->
    <!-- output-preview only when outputBytes <= 2048 -->
  </bg-task-notification>
  ...
</bg-task-notifications>
```

`<bg-` prefix (map Notes clause 1) avoids pi's general notification prefix. `subscription-id` is debug metadata (<=10 B), does not affect payload-size budget. Parent label carries no summary, model expands `<bg-task>` children directly. TUI panel rendering is handled in P1 (#43).

A single batch carries N events. When a single-batch content exceeds the byte budget `DEFAULT_MAX_BATCH_BYTES = 100 * 1024` (100 KiB), the TaskRegistry splits along event boundaries into N batches. Each batch has its own `<bg-task-notifications>` parent. The model sees N consecutive parent tags; the cursor advances by N events, not N batches.

### 8. Signal layering: model stop -> stopped; session stop / Esc -> lost

Map fog sub-item (the 3rd G1 sub-item), resolved:

| signal source                            | trigger  | TaskRecord transition                                  | emit key               |
| ---------------------------------------- | -------- | ------------------------------------------------------ | ---------------------- |
| `ptc_task_stop(taskId, reason)` (model)  | explicit | `running -> stopping -> canceled`                      | `task:<id>:->canceled` |
| AbortSignal / Esc (session)              | implicit | `running -> lost` (reason=session_ended_while_running) | `task:<id>:->lost`     |
| user kills the session from the Esc path | implicit | `running -> lost` (reason=user_killed_via_esc)         | `task:<id>:->lost`     |
| session restart (startup-reconcile)      | implicit | `running -> lost` (reason=lost_on_session_restart)     | `task:<id>:->lost`     |

Three `lost` reasons (distinct strings in `errorMessage` field) preserve auditability. Model stop is explicit and synchronous (cursor advances past `canceled`); session-stop is implicit and async (cursor advances at next session replay).

Late-arrival stop: if model sends `ptc_task_stop` while the child is already `stopping`, the call is idempotent (cursor advances past `canceled` once, not twice). codex's `start_or_steer_turn` semantic with `interrupt:true` first cancels, then delivers -- we don't need that here because the binding is fire-and-forget (cursor advances, not the child turn itself).

### 9. Concurrency and depth caps: unchanged from ADR-0016

- `dispatchConcurrency` = 8 (ADR-0016) -- hard reject above cap, no in-task queue.
- `maxDispatchDepth` = 3 (ADR-0016 recursive section) -- same cap on background as on foreground.
- Background tasks **count against** `dispatchConcurrency` while running (per Q3 resolved `completed tasks don't count toward cap` rule from codex; G2 v4 prototype confirmed -- burst scenarios at 100/500 tasks all delivered without overflow).

### 10. Reverse query, handoff, resume: deferred to v2

- `ptc_task_handoff` (v2): child writes `/tmp/waybg-handoff-<ulid>.md`; old transitions `running -> canceled (reason=handoffed_to_<newTaskId>)`; new task spawned with doc as initial context. **Compounding degradation** (DecompVuln paper) caps handoff chain length at 3.
- `ptc_parent_query` (v2): child->parent via subscription buffer; parent answers via `ptc_query_response`; Q4 verdict default L1 self-grill (no round-trip) with L2 reverse-query as fallback.
- `ptc_task_resume` (v2): opens `pi -c --session-id <taskId>` continuation; Reasonix "interrupted 拒续、完成态才可续" rule (R1 limitation locked).

## Boundary with ADR-0016

ADR-0016 added `pi.dispatch` as a parallel binding that returns a `DispatchResult` once the child exits. That ADR documented (section "What we deliberately don't add") that the dispatch binding is **not** a tool with model-visible lifecycle.

**This ADR flips that half-sentence.** The spawn surface remains the binding (no new binding `pi.dispatch_background`; one parameterization, not two surfaces). The **lifecycle face** is now model-visible via three tools (`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`), and the cursor-based subscription delivers events to the model. The CONTEXT.md glossary entry for `pi.dispatch` is updated accordingly: the words "_Not_ a model-visible lifecycle tool" are replaced with "spawn is binding; the lifecycle face is model-visible via `ptc_task_*` tools (see `bg-task-notification` events)".

The flip preserves ADR-0016's other invariants:

- binding is untrusted program input (ADR-0005)
- binding is called by the program, not by the model's tool-call surface
- no per-call gate on bindings
- Promise semantics (no throw) for foreground

What changes: the **result tree** now contains a `DispatchHandle` (background) or `DispatchResult` (foreground), not just `DispatchResult`. The model can still not _call_ `pi.dispatch`; it can only observe tasks that the program called.

## Boundary with existing tools

- **`ptc_run_code` / `ptc_workflow`**: unchanged. Programs that need a single program still call `ptc_run_code`; they don't need TaskRegistry.
- **`ptc_task_*` tools**: new surface. They live alongside `ptc_run_code` etc. in the same `tools.<name>(args)` table; they are **constant on** -- not gated by `/ptc off`. Map Notes clause 5.
- **`pi.dispatch` foreground**: unchanged. They return `DispatchResult`. Background is an _additive_ opt.

## Implementation outline (deferred to follow-up commits)

- New files as shipped: `src/runtime/task-storage.ts` (TaskStorage + InMemoryTaskStorage; TaskRecord / DispatchHandle / TaskStatus / Subscription / TaskEvent), `src/runtime/task-registry.ts`, `src/runtime/child-process-lifecycle.ts`, `src/runtime/notification-pipeline.ts`, `src/runtime/output-storage.ts`, `src/runtime/task-notification.ts` (notification renderer), `src/tools/ptc-task.ts` (the three tools), `src/tools/task-panel-render.ts`.
- Modified files as shipped: `src/runtime/dispatch.ts` (background opt path; `DispatchHandle` return type), `src/runtime/dispatcher.ts` (per-run `DispatchSlotCounter` + `dispatchDeps` threading), `src/runtime/bindings.ts` (`callerId` / `sessionDir` / `dispatchDeps` on the binding context), `src/index.ts` (session runtime + always-on `ptc_task_*` registration + notification delivery), `src/tools/run-code.ts` / `src/tools/workflow.ts` (session dir threading). No `subscriptionPollIntervalMs` / `notificationCadenceMs` / `notificationRateLimit` config field ships in v1.
- Tests: unit-test TaskRecord state machine transitions (G1: explicit transition table); integration-test the binding through `runPtcProgram` with a small agent script; e2e-test the 12-scenario G2 prototype as a regression suite.
- Schema validator: T5 implementation ticket.

## Cross-references

- ADR-0016: pi.dispatch foreground binding (the binding surface this ADR extends).
- ADR-0015: 50 KB / 2000 line truncateTail applied to `ptc_task_output`.
- ADR-0005: bindings are untrusted program input; this ADR inherits that.
- ADR-0014: image hoisting applies to background children exactly as foreground.
- ADR-0017: worker pool applies to background tasks (one worker per in-flight run).
- ADR-0020 / ADR-0021: row pulse / sub-call tree render -- sub-call tree is unaffected (background spawn is a one-shot anchor, per G1).

## What becomes of the deferred map items

The map's `Not yet specified` list contains four items that this ADR explicitly defers:

- **steering / steering** -- deferred to v2 + 复活一起评 (this ADR section 8).
- **复活 / resume 工具** -- deferred to v2 + steering (this ADR section 8, last bullet).
- **每任务超时** -- deferred; current PRD silently lacks per-task timeout. Will be addressed in a future ADR if/when stalled-task failure mode becomes a real problem.
- **`pi.dispatch` outputSchema** -- orthogonal (subagent extension's own concern); not part of this ADR.
- **前台任务中途转后台** (kimicode Ctrl+B) -- deferred; v1 spawn-or-reject only, no in-flight promotion.

The map's `Out of scope` items remain out of scope (this ADR does not change them).
