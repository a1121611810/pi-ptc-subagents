# Background dispatch

`pi.dispatch` is a PTC **binding**: a program calls it, the extension spawns a fresh `pi`
subprocess for a named agent, and the program gets a structured result. The foreground form
([ADR-0016](../adr/0016-ptc-dispatch-binding.md)) resolves only when the child exits — the child
has no life beyond that `await`. Background dispatch
([ADR-0022](../adr/0022-background-dispatch.md)) is the long-lived variant: the binding returns a
handle immediately, a detached pump drives the child's lifecycle, and the child keeps running after
the spawning program and the spawning turn have ended.

Reach for it when the work is longer than the program's useful lifetime, or when the model should be
able to check on it later: a scout over a large tree, a review that runs while the model does
something else, a batch of children fanned out from one program.

## Foreground vs. background

|                    | foreground `pi.dispatch`                | `pi.dispatch({ background: true })`                                                       |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| return             | `DispatchResult`, after the child exits | `DispatchHandle`, immediately after spawn                                                 |
| blocks the program | yes, until the child exits              | no                                                                                        |
| child lifetime     | the awaited `Promise`                   | independent of the program and of the turn                                                |
| observation        | the return value                        | `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` and `<bg-task-notification>` events |
| failure            | `status: "rejected"` on the result      | a terminal `TaskStatus` on the `TaskRecord`                                               |

Both forms share the same depth and concurrency gates (see [Limits](#limits)). A pre-spawn refusal
uses the foreground `DispatchResult` shape, so a background call returns either a
`DispatchHandle` **or** a refusal `DispatchResult`.

## Spawning

A binding is reached as `tools["<name>"]` inside a program; this binding's name is `pi.dispatch`.

```ts
// ptc_run_code
const handle = await tools["pi.dispatch"]({
  agent: "researcher", // required: agent markdown name
  task: "survey the peer implementations", // required: the child's task text
  background: true, // switch to the long-lived path
  label: "peer survey", // optional; defaults to task.slice(0, 64)
});

// A background spawn returns a DispatchHandle:
// { taskId: "01JBZ000000000000000000001", label: "peer survey", status: "running" }
return handle;
```

Input fields are the foreground binding's fields plus two:

| field           | type                            | default                  | meaning                                  |
| --------------- | ------------------------------- | ------------------------ | ---------------------------------------- |
| `agent`         | `string`                        | — (required)             | agent markdown name                      |
| `task`          | `string`                        | — (required)             | task text handed to the child            |
| `cwd`           | `string`                        | the run's cwd            | child working directory                  |
| `agentScope`    | `"user" \| "project" \| "both"` | `"user"`                 | which agent directories are searched     |
| `model`         | `string`                        | agent markdown's `model` | model override                           |
| `thinkingLevel` | `string`                        | `"off"`                  | thinking-level override                  |
| `background`    | `boolean`                       | `false`                  | long-lived dispatch                      |
| `label`         | `string`                        | `task.slice(0, 64)`      | human label on the handle and the record |

On a refusal — depth cap, concurrency cap, unknown agent, or a spawn that never came up — the call
resolves with a `DispatchResult` instead: `{ status: "rejected", started: false, errorMessage: … }`.
The binding never throws, so branch on the shape:

```ts
const result = await tools["pi.dispatch"]({
  agent: "researcher",
  task: "survey the peer implementations",
  background: true,
});

if ("taskId" in result) {
  console.log("spawned", result.taskId); // DispatchHandle
} else {
  console.log("refused:", result.errorMessage); // DispatchResult
}
```

### The handle

```json
{
  "taskId": "01JBZ000000000000000000001",
  "label": "peer survey",
  "status": "running"
}
```

The handle is a **spawn-time projection** of the `TaskRecord`, frozen at creation and never updated.
It always reads `"running"`. Live state comes from `ptc_task_list`; the handle is only an address.

## Observing a task

The handle's value flows back to the model as the program's completion value. A later program does
not inherit it, and the management tools are model-facing tools (not bindings), so a later turn
observes the task by calling them directly:

```ts
// Later turn — the model calls this tool, not a program.
ptc_task_list({ status: ["running", "succeeded", "failed", "canceled", "lost"] });
```

The text block is one line per record, newest first:

```text
01JBZ000000000000000000001  running    researcher depth=1  peer survey  0B
01JBZ000000000000000000002  succeeded  researcher depth=1  db review  1893B
```

```ts
// Then read the body of one of them.
ptc_task_output({ taskId: "01JBZ000000000000000000002" });
```

### Management tools

All three tools are always active: they are **not** part of the PTC-mode loadout, so `/ptc off`
does not remove them. `/ptc off` only blocks _new_ spawns (ADR-0016 R6); in-flight tasks keep
updating and keeping their output reachable.

**`ptc_task_list`** — list this session's background tasks.

| parameter | type           | default        | notes                                                                      |
| --------- | -------------- | -------------- | -------------------------------------------------------------------------- |
| `status`  | `TaskStatus[]` | all six states | return only these states                                                   |
| `limit`   | `number`       | `100`          | maximum rows, ordered `createdAt` descending; an invalid limit is an error |

```ts
ptc_task_list({ status: ["running"], limit: 20 });
```

**`ptc_task_output`** — read a task's captured output.

| parameter    | type     | default      | notes                                                                |
| ------------ | -------- | ------------ | -------------------------------------------------------------------- |
| `taskId`     | `string` | — (required) | the id from the handle or `ptc_task_list`; an unknown id is an error |
| `sinceBytes` | `number` | `0`          | skip this many bytes of the stored output before returning it        |

```ts
ptc_task_output({ taskId: "01JBZ000000000000000000002", sinceBytes: 1024 });
```

**`ptc_task_stop`** — ask a running task to stop.

| parameter | type     | default        | notes                                 |
| --------- | -------- | -------------- | ------------------------------------- |
| `taskId`  | `string` | — (required)   | an unknown id is an error             |
| `reason`  | `string` | `"model stop"` | recorded as the record's `stopReason` |

```ts
ptc_task_stop({ taskId: "01JBZ000000000000000000001", reason: "no longer needed" });
```

A stop while the task is already `stopping` is idempotent (no second event). A stop on a task that
is already terminal is an illegal-transition error.

## Status and transitions

`TaskStatus` has six values. `queued` is deliberately absent: the concurrency cap is a hard reject,
there is no in-task queue.

| status      | terminal | can move to                                           |
| ----------- | -------- | ----------------------------------------------------- |
| `running`   | no       | `stopping`, `succeeded`, `failed`, `canceled`, `lost` |
| `stopping`  | no       | `succeeded`, `failed`, `canceled`                     |
| `succeeded` | yes      | —                                                     |
| `failed`    | yes      | —                                                     |
| `canceled`  | yes      | —                                                     |
| `lost`      | yes      | —                                                     |

- `running -> succeeded` — the child exited 0.
- `running -> failed` — the child exited non-zero.
- `running -> stopping` — `ptc_task_stop` (explicit model stop).
- `stopping -> canceled` — the stop resolves; the child's close is the writer of the terminal state.
- `running -> lost` — the session ended while the child was running, or restart reconciliation swept it.

### The `lost` reasons (two emitted in v1)

`lost` carries a distinct reason in the record's `errorMessage` field so the reasons stay
auditable. v1 emits **two**:

- `session_ended_while_running` — the session stopped while the task ran (`session_shutdown`).
- `lost_on_session_restart` — startup reconciliation found a `running` or `stopping` record after a
  restart; `reconcileLostTasks()` sweeps both and is idempotent.

`user_killed_via_esc` is **reserved and unreachable in v1**: pi's `SessionShutdownEvent` exposes no
Esc/abort signal (`reason` is only `quit | reload | new | resume | fork`), so an Esc kill cannot be
separated from a normal session end. The value stays in the `LostReason` union for a future
Esc-identifiable signal (ADR-0022 §8).

## Notification delivery

When a `TaskRecord` changes, the change is delivered to the model as a user-role batch: one
`<bg-task-notifications>` parent carrying N per-event `<bg-task-notification>` children.

```xml
<bg-task-notifications batch-id="01JBZ0000000000000000000A1" delivered-at-ms="1758700000123">
  <bg-task-notification
    id="task:01JBZ000000000000000000001:->succeeded"
    task-id="01JBZ000000000000000000001"
    subscription-id="01JBZ0000000000000000000B2"
    status="succeeded"
    label="peer survey"
    agent-name="researcher"
    depth="1"
    duration-ms="18422"
    transition-at-ms="1758700000123">
    <output-bytes>913</output-bytes>
    <output-preview>…only when outputBytes &lt;= 2048…</output-preview>
    <!-- <output-ref>…/tasks/01JBZ…/output.log</output-ref> once the log exists -->
  </bg-task-notification>
</bg-task-notifications>
```

- **Inline preview.** `<output-preview>` is included only when the task's `outputBytes` is at or below
  **2048 bytes**. Above that the event carries `<output-bytes>` only, and the model dereferences the
  body with `ptc_task_output`.
- **Batch split.** A batch is split along event boundaries so its estimated payload stays within the
  default **100 KiB** budget (`DEFAULT_MAX_BATCH_BYTES = 100 * 1024`). The split never drops an event:
  an event that alone exceeds the budget gets its own batch. The cursor advances by _events_, not by
  batches.
- **The spawn event is not redelivered.** The owner subscription opens with its cursor already at the
  `task:<id>:running` event, because the spawning program already holds the handle. The first
  delivered event is the next transition.

### The subscription cursor

A `Subscription` is one per `(subscriberId, taskId)`; the subscriber **is** the owner — the spawning
run's id (`callerId`, defaulting to `dispatch:<callId>`). The cursor is a monotonic ULID that
advances on _delivery_, not on drain, so an unacknowledged batch is re-delivered rather than lost.
An acknowledgement never moves the cursor backwards, and a re-subscribe returns the persisted
subscription unchanged.

- **Default fork cursor.** A forked branch starts at the **maximum** of the parent and child cursors
  (`max(parent, child)`), so it observes post-fork events only; pre-fork events are not redelivered.
- **Resubscribe.** An explicit reset to the beginning ("initial" / the zero cursor) replays the whole
  event log from task creation. The ADR names this surface `ptc_task_resubscribe(taskId, since)`.

## Limits

Two per-run caps apply to background dispatch exactly as they do to foreground; both are
`PtcConfig` fields.

- **`dispatchConcurrency` — default 8.** A hard cap on concurrently in-flight dispatches per run.
  The N+1th resolves immediately with
  `{ status: "rejected", errorMessage: "dispatch concurrency limit reached" }` — never queued.
  A background task **counts against the cap for its whole lifetime**, from spawn to its terminal
  transition, not just until `pi.dispatch` returns.
- **`maxDispatchDepth` — default 3.** Each dispatch computes `childDepth = parentDepth + 1` and is
  rejected when `childDepth > maxDispatchDepth` with
  `{ status: "rejected", errorMessage: "dispatch depth limit reached" }`. The child subprocess also
  loads pi-ptc, so the child can dispatch further children within the same budget.

## Signals

Signal handling is layered by who asked:

| source                  | transition                        | notes                                                                                                                                        |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptc_task_stop` (model) | `running -> stopping -> canceled` | explicit and synchronous; the dispatcher pump owns the actual signal and writes `canceled` when the child closes. A late stop is idempotent. |
| session stop / Esc      | `running -> lost`                 | implicit; v1 records `session_ended_while_running` (pi exposes no Esc-specific signal, so `user_killed_via_esc` is not emitted).             |
| session restart         | `running -> lost`                 | startup reconciliation, reason `lost_on_session_restart`; also sweeps a task caught mid-`stopping`.                                          |

## On disk

The task state goes through the `TaskStorage` seam. There are two adapters: an in-memory one
(process-local, used when no session directory is available) and `FileTaskStorage`, which persists
under the session directory so a restart can reconcile:

```text
<sessionDir>/tasks/<taskId>.json                                 # the 21-field TaskRecord (atomic temp+rename)
<sessionDir>/subscriptions/<subscriberId>-<taskId>.json          # the per-subscriber cursor (atomic temp+rename)
<sessionDir>/events/<subscriberId>-<taskId>.jsonl                # append-only newline-delimited events
<sessionDir>/tasks/<taskId>/output.log                           # the captured output
```

The record's optional `sessionFile` field is deliberately left unset in v1: the extension cannot
learn pi's session-file path for the child (reopen R-m12), so no `.pi-*` file is named.

A missing file is "absent" (`null` / no events); a file that exists but does not parse throws a
path-naming error rather than being reported as absent. The event log deviates from ADR-0022
"What we add" #5 (which named `event-log/<eventId>.json`): it is partitioned by
`(subscriberId, taskId)` so an append is one file append and the subscriber's stream is a merge of
its own per-task logs. One caveat: `listTasks` throws on a corrupt record, so startup reconcile is
best-effort and visible rather than per-record tolerant.

Output goes through the `OutputStorage` seam. `FileOutputStorage` writes
`<base>/tasks/<taskId>/output.log` and reports that path as `outputRef`; the in-memory adapter
reports `memory:tasks/<taskId>/output.log`. The dispatcher pump drains the child's stdout, persists
the raw text on the terminal transition, and projects `outputRef` / `outputBytes` / `outputPreview`
onto the record.

When the run has a session directory, a background child drops the foreground `--no-session` flag
and is launched with the R1 session triple:

```bash
pi --mode json -p \
   --thinking off \
   --append-system-prompt <prompt-tmpfile> \
   "Task: <task text>" \
   --session-dir <sessionDir> \
   --session-id <taskId> \
   --name bgdispatch:<taskId>
```

### Pagination and truncation

`ptc_task_output` reads the stored bytes, slices from `sinceBytes` (default `0`; must be a
non-negative integer no larger than `outputBytes`, and on a UTF-8 character boundary — an offset
that would split a multi-byte character is rejected with an explicit error rather than decoded
into U+FFFD), and then applies pi's truncation contract
([ADR-0015](../adr/0015-pi-truncation-contract.md)):

- `outputBytes` always reports the **full** stored size, regardless of `sinceBytes` or truncation.
- The returned text is tail-truncated to **50 KB / 2000 lines** (`DEFAULT_MAX_BYTES` /
  `DEFAULT_MAX_LINES`), keeping the _last_ lines.
- When anything was cut, the complete text is written to
  `os.tmpdir()/pi-ptc-task-output-<uuid>.txt` first, and the text ends with pi's footer, e.g.
  `[Showing lines 501-2500 of 2500. Full output: /tmp/pi-ptc-task-output-….txt]`.
- `details.outputFullPath` names that file only when the output was truncated.
- `outputPreview` is present only when the full output is at or below 2048 bytes.

## Not in v1

Deferred deliberately; the map items and reasons are in ADR-0022 §8/§10.

- **Resume** (`ptc_task_resume`) — restarting a task from its session file.
- **Steering / append** (`ptc_task_append`) — injecting a message into a running task.
- **Handoff** (`ptc_task_handoff`) — redirect a task mid-flight by spawning a successor.
- **Reverse query** (`ptc_parent_query` / `ptc_query_response`) — a child asking its parent a question.
- **Per-task timeout** — no individual deadline on a task beyond the run's own limits.
- **`outputSchema`** — structured output validation on `pi.dispatch` is out of scope here.
- **Foreground → background promotion** — spawn-or-reject only; a running foreground call cannot be
  moved to the background.
- **`queued`** — no in-task queue; spawning above the concurrency cap is an immediate rejection.

## See also

- [ADR-0022 — background dispatch](../adr/0022-background-dispatch.md) — the full design and decisions.
- [ADR-0016 — the `pi.dispatch` binding](../adr/0016-ptc-dispatch-binding.md) — the foreground binding this extends.
- [ADR-0015 — the pi truncation contract](../adr/0015-pi-truncation-contract.md) — the 50 KB / 2000-line rule.
- [`CONTEXT.md`](../../CONTEXT.md) — canonical terms (background dispatch, TaskRecord, TaskStatus, TaskRegistry, Subscription, DispatchHandle, `ptc_task_*`, `<bg-task-notification>`).
