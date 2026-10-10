# Background dispatch

`pi.dispatch` is a PTC **binding**: a program calls it, the extension spawns a fresh `pi`
subprocess for a named agent, and the program gets a structured result. The foreground form
([ADR-0016](../adr/0016-ptc-dispatch-binding.md)) resolves only when the child exits — the child
has no life beyond that `await`. Background dispatch
([ADR-0022](../adr/0022-background-dispatch.md)) is the long-lived variant: the binding returns a
handle immediately, a detached pump drives the child's lifecycle, and the child keeps running after
the spawning program and the spawning turn have ended. Precisely (ADR-0023): the child survives the
spawning program, the spawning turn, and `/ptc off`; it is **owned by the dispatching pi process**
and ends only when that session ends or is replaced (`session_ended_while_running`) or when the
owner process dies before completion (`lost_on_session_restart`).

Reach for it when the work is longer than the program's useful lifetime, or when the model should be
able to check on it later: a scout over a large tree, a review that runs while the model does
something else, a batch of children fanned out from one program.

## Foreground vs. background

|                    | foreground `pi.dispatch`                | `pi.dispatch({ background: true })`                                                                                                            |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| return             | `DispatchResult`, after the child exits | `DispatchHandle`, immediately after spawn                                                                                                      |
| blocks the program | yes, until the child exits              | no                                                                                                                                             |
| child lifetime     | the awaited `Promise`                   | the dispatching pi process's lifetime — survives the program, the turn, and `/ptc off`; ends on session end/replacement or owner process death |
| observation        | the return value                        | `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` and `<bg-task-notification>` events                                                      |
| failure            | `status: "rejected"` on the result      | a terminal `TaskStatus` on the `TaskRecord`                                                                                                    |

Both forms share the same depth and concurrency gates — and, since the concurrency gate moved into
`dispatch()`, they share one **counter** for them rather than one each (see [Limits](#limits)). A
pre-spawn refusal uses the foreground `DispatchResult` shape, so a background call returns either a
`DispatchHandle` **or** a refusal `DispatchResult`.

## Spawning

A binding is reached as `tools["<name>"]` inside a program; this binding's name is `pi.dispatch`.

### Prerequisites

`agent` must name a **registered agent** — there is no default agent. Registration is an
agent markdown file at `~/.pi/agent/agents/<name>.md` (user scope) or `<cwd>/.pi/agents/<name>.md`
(project scope, searched when `agentScope` is `"project"` or `"both"`):

```text
---
name: researcher
---

You are a research agent. ...
```

The file's frontmatter `name:` is the name the dispatch uses (the file name is the fallback).
A missing or unknown `agent` resolves with a refused `DispatchResult` whose `errorMessage`
lists the agents currently registered under the effective scope, both lookup paths, and the
minimal file shape — read it instead of re-probing the file system.

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

#### The child report

A background child's [child report](../adr/0032-child-report.md) is as inspectable as a
foreground child's: the pump reads it off the child's final message with the same extraction the
foreground loop runs, and the registry persists it on the `TaskRecord`, so it survives a restart
exactly as the rest of the record does. `ptc_task_output` renders it above the child's prose —
conclusion first, reasoning second — bounded at 20 findings with the withheld count stated in
band.

```text
<child-report channel="prompt-json">
summary: the depth gate is checked before the agent is discovered
findings (2):
  1. depth precedes discovery — evidence: the gate returns before discoverAgent
  2. the refusal names the next step — evidence: the message ends with next_step:
files_touched: src/runtime/dispatch.ts, docs/usage/bgdispatch.md
usage: input=900 output=260 cost=0.0123 turns=1
</child-report>
I read the dispatch gates and here is what I found. …
```

`channel` says **which** channel delivered it, and is the same total field a foreground
`DispatchResult` carries:

- **`tool`** — the child called `ptc_child_report`, whose payload the host reads back as JSON
  against a declared schema. This is the reliable channel, and it is preferred.
- **`prompt-json`** — the child ended its reply with a fenced JSON block instead. This is the
  fallback, and it is a real one: `ptc_child_report` only exists in the child when this package
  loads there (pi's `-ne` removes extensions entirely, and `pi config` can disable this package
  without loading it), so an install without it has nothing but the prompt channel.
- **`none`** — the child ran and did not comply.
- **`opted-out`** — the agent's frontmatter set `childReport: false`, so nobody was asked. A
  different claim from `none`, and the two are not merged.

A child that ignored the contract is reported as having ignored it:

```text
<child-report channel="none">the child produced no report; it did not comply with the report contract. What follows is its prose, unbacked by a report.</child-report>
```

`usage` is measured by the host from the child's own `message_end` blocks. A child is never asked
for its token count and a child-declared `usage` is discarded, because a model cannot know it.

**When there is no report block at all** — a task that is still `running`, `stopping`, `failed`,
`canceled` or `lost` — that is a claim, not a gap. Those records carry neither `report` nor
`reportChannel`: a child that has not finished has not reported _yet_, and "has not reported yet"
is a different claim from "ran and complied with nothing to say" (`reportChannel: "none"`). The
record's status and `errorMessage` are what describe those tasks.

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
- `running -> lost` — the owning session ended while the child was running, or startup
  reconciliation found the record's owner process dead.

### The `lost` reasons (two emitted in v1)

`lost` carries a distinct reason in the record's `errorMessage` field so the reasons stay
auditable. v1 emits **two**:

- `session_ended_while_running` — the **owner** session ended while the task ran (`session_shutdown`
  of the dispatching pi process).
- `lost_on_session_restart` — the record's **owner process died** before the task completed, and a
  later bind of a process sharing the session dir discovered it; `reconcileLostTasks()` sweeps
  both `running` and `stopping` records whose owner is gone (plus pre-upgrade ownerless records)
  and is idempotent.

Reaping is owner-scoped (ADR-0023): every record carries the owning runtime instance's identity
(`ownerPid` + `ownerBootMs`), a process only ever reaps records it owns, and **other pi processes
started in the same cwd neither reap nor terminate your background tasks** — a background child
itself loads this extension and shares your session dir, and pre-fix both its startup reconcile and
its exit sweep used to flip your still-running records to `lost`.

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

Two caps apply to dispatch; both are `PtcConfig` fields, and the first is no longer per-run.

- **`dispatchConcurrency` — default 8, one counter per pi session.** A hard cap on concurrently
  in-flight dispatches across the whole session. The N+1th resolves immediately with
  `{ status: "rejected", errorMessage: "dispatch concurrency limit reached" }` — never queued.
  A background task **counts against the cap for its whole lifetime**, from spawn to its terminal
  transition, not just until `pi.dispatch` returns.

  Three things follow, and they are the difference from the per-run cap this used to be:

  - **Foreground and background draw on the same 8.** A session with eight long background children
    running has no foreground dispatch headroom left, and a program issuing
    `Promise.all([...pi.dispatch])` in that state gets **every** call refused. Measured, with a real
    fake-`pi` spawn and 24 concurrent foreground calls: 8 live background children plus one program
    went from 8 foreground calls spawned to **0**. That is not a rounding difference.
  - **Two concurrent programs share it.** Measured: two programs at 24 foreground calls each went
    from 16 spawned to 8. One program on its own is unchanged (8 of 24, before and after), which is
    why the change survived three review rounds.
  - **A refusal is not a wait.** Because the overflow is a hard reject with no queue, a foreground
    call is never parked behind a background child that has twenty minutes left to run. If a
    session needs both, raise the cap rather than retrying.

  **The live control is `createBackgroundTaskRuntime({ concurrency })`** — the call that builds the
  session counter, in `src/index.ts`, handed the value of `PtcConfig.dispatchConcurrency`. It is not
  a background-only knob: it is the session's whole dispatch budget. The `dispatchConcurrency` a
  caller passes to `runPtcProgram({ config })` sizes the dispatcher's own per-run counter, and that
  counter is only reached when no session counter is supplied; in a pi session one always is, so the
  per-run one is not what enforces the cap you are looking at. `ptc_subagent` spends this same
  counter, so two of those calls contend with a program's dispatches for the same slots.

- **`maxDispatchDepth` — default 3.** Each dispatch computes `childDepth = parentDepth + 1` and is
  rejected when `childDepth > maxDispatchDepth` with
  `{ status: "rejected", errorMessage: "dispatch depth limit reached" }`. The child subprocess also
  loads pi-ptc, so the child can dispatch further children within the same budget.
- **The program's own run deadline bounds foreground dispatches.** A foreground dispatch runs
  inside the program: when the `ptc_run_code` / `ptc_workflow` run times out (default **120 s**,
  ceiling **600 s** — raise it with `timeoutMs`), its in-flight foreground dispatches are
  terminated with it. A long fan-out therefore needs either a higher `timeoutMs` (the deadline
  bounds the whole run, including every awaited child) or smaller per-child tasks; independent
  foreground dispatches compose under `Promise.all`, so one program can hold them all inside the
  same deadline.

## Output shape convention

A child's long final reply is the first thing a caller loses: any post-processing that trims
`result.text` (a `.slice` budget, a summary pass) cuts the tail, and the tail is where the
findings usually are. Two conventions keep that from costing a re-dispatch:

- **Ask for a compact final reply in the task itself.** Put the budget in the child's
  instructions — e.g. "final reply ≤ 40 lines, findings only (or LGTM)" — so the text that
  crosses the wire is already the size the caller can keep whole.
- **Page, don't truncate.** A foreground `DispatchResult.text` comes back whole; forward it
  unchanged. For long background output, read it in slices with
  `ptc_task_output({ taskId, sinceBytes })` — the stored bytes are the canonical copy, and
  `outputBytes` tells you where the next slice starts — instead of truncating a preview.

## Signals

Signal handling is layered by who asked:

| source                  | transition                        | notes                                                                                                                                                                                   |
| ----------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptc_task_stop` (model) | `running -> stopping -> canceled` | explicit and synchronous; the dispatcher pump owns the actual signal and writes `canceled` when the child closes. A late stop is idempotent.                                            |
| session stop / Esc      | `running -> lost`                 | implicit; v1 records `session_ended_while_running` (pi exposes no Esc-specific signal, so `user_killed_via_esc` is not emitted).                                                        |
| session restart         | `running -> lost`                 | startup reconciliation, reason `lost_on_session_restart`; reaps only records whose owner process is dead (or pre-upgrade ownerless ones), and also sweeps a task caught mid-`stopping`. |

## On disk

The task state goes through the `TaskStorage` seam. There are two adapters: an in-memory one
(process-local, used when no session directory is available) and `FileTaskStorage`, which persists
under the session directory so a restart can reconcile:

```text
<sessionDir>/tasks/<taskId>.json                                 # the TaskRecord: 19 ADR-0022 §3 fields + 2 optional ADR-0023 owner fields = 21 today, plus 2 optional ADR-0032 report fields on a succeeded record (atomic temp+rename)
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
- **`outputSchema`** — `pi.dispatch` itself declares none: the binding resolves to `{ text, status, ... }`
  and has no structured form (see the exception in the binding contract). The `ptc_task_*` tools and
  `ptc_subagent` DO declare one, for a different consumer — see
  [Structured results for codemode](./structured-results.md).
- **Foreground → background promotion** — spawn-or-reject only; a running foreground call cannot be
  moved to the background.
- **`queued`** — no in-task queue; spawning above the concurrency cap is an immediate rejection.

## See also

- [ADR-0022 — background dispatch](../adr/0022-background-dispatch.md) — the full design and decisions.
- [ADR-0023 — background task ownership](../adr/0023-background-task-ownership.md) — owner-tagged
  records and owner-scoped reaping (why sibling processes no longer reap your tasks).
- [ADR-0016 — the `pi.dispatch` binding](../adr/0016-ptc-dispatch-binding.md) — the foreground binding this extends.
- [ADR-0015 — the pi truncation contract](../adr/0015-pi-truncation-contract.md) — the 50 KB / 2000-line rule.
- [`CONTEXT.md`](../../CONTEXT.md) — canonical terms (background dispatch, TaskRecord, TaskStatus, TaskRegistry, Subscription, DispatchHandle, `ptc_task_*`, `<bg-task-notification>`).
