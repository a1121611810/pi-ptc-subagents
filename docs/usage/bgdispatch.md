# Background dispatch

`pi_task_ptc` is a PTC **binding**: a program calls it, the extension spawns a fresh `pi`
subprocess for a named agent, and the program gets a structured result. Whether the call **waits**
for that child is one parameter, `wait` ([ADR-0055](../adr/0055-wait-is-one-parameter.md)): `wait:
true` resolves only when the child exits, so the child has no life beyond that `await`; **omitted
(or `false`), the binding returns a handle immediately**, a detached pump drives the child's
lifecycle, and the child keeps running after the spawning program and the spawning turn have ended.
That long-lived form is the background dispatch of
[ADR-0022](../adr/0022-background-dispatch.md), and it is the **default** — a call that says
nothing about waiting gets a handle, not an answer. Precisely (ADR-0023): the child survives the
spawning program, the spawning turn, and `/ptc off`; it is **owned by the dispatching pi process**
and ends only when that session ends or is replaced (`session_ended_while_running`) or when the
owner process dies before completion (`lost_on_session_restart`).

**Both forms are tasks** ([ADR-0053](../adr/0053-every-dispatch-is-a-task.md)). Since 2026-10-21 the
foreground form registers a task record too, persists the child's output to
`<sessionDir>/tasks/<id>/output.log`, and keeps the record after the call returns — so a foreground
child is readable later instead of evaporating with the return value. The gates stay above the
record creation, so a refused call leaves no record behind.

Reach for it when the work is longer than the program's useful lifetime, or when the model should be
able to check on it later: a scout over a large tree, a review that runs while the model does
something else, a batch of children fanned out from one program.

## Waiting vs. not waiting

|                    | `pi_task_ptc({ wait: true })`           | `pi_task_ptc({ ... })` — the default                                                                                                           |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| return             | `DispatchResult`, after the child exits | `DispatchHandle`, immediately after the child is up                                                                                            |
| blocks the program | yes, until the child exits              | no                                                                                                                                             |
| child lifetime     | the awaited `Promise`                   | the dispatching pi process's lifetime — survives the program, the turn, and `/ptc off`; ends on session end/replacement or owner process death |
| observation        | the return value, plus the task record  | `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` and `<bg-task-notification>` events                                                      |
| failure            | `status: "rejected"` on the result      | a terminal `TaskStatus` on the `TaskRecord`                                                                                                    |

Both are **one path with one parameter** (ADR-0055): the gate order, the task id minting, the slot
acquisition and the record creation are the same code, and only the last step differs — whether the
caller awaits the child. Since the admission moved into `dispatch()`, they share one **counter**
rather than one each (see [Limits](#limits)). A pre-spawn refusal is a `DispatchResult` on **both**
modes — never a handle, because a refused task never ran — so a not-waiting call returns either a
`DispatchHandle` **or** a refusal `DispatchResult`.

A result also carries the record it created: `taskId` and `label`
([ADR-0053](../adr/0053-every-dispatch-is-a-task.md),
[ADR-0055](../adr/0055-wait-is-one-parameter.md)). That is how a program — or the model, through
the tool that projects it — looks the child up after the fact with `ptc_task_output`. The handle
carries the same two names for the same task, so a caller reads one vocabulary either way. Both
fields are absent on a refusal, because a refused call left no record.

## Spawning

A binding is reached as `tools.<name>` inside a program; this binding's name is `pi_task_ptc`.

### Prerequisites

**None.** `task` is the whole required input — omit `agent` and the dispatch runs a **generalist
child**: pi's own system prompt, pi's full toolset, no model pinned by a definition
(the child still resolves a model — see [Which model the child runs](#which-model-the-child-runs)).

That is not a fallback. The dispatch prompt is _appended_ to pi's own system prompt rather than
substituted for it, and no tool list is passed unless a definition declares one, so the child is a
full pi either way. Naming an `agent` is how you **narrow** it.

Narrowing is an agent markdown file at `~/.pi/agent/agents/<name>.md` (user scope) or
`<cwd>/.pi/agents/<name>.md` (project scope, searched when `agentScope` is `"project"` or `"both"`):

```text
---
name: researcher
description: Surveys peer implementations and reports what it found, with citations.
tools: read, grep, find, ls
---

You are a research agent. ...
```

The file's frontmatter `name:` is the name the dispatch uses, and it is the only thing that is — a
`.md` file carrying no `name:` is not an agent at all, so it is neither listed nor dispatchable.
The file name is conventional, not binding: `beta.md` whose frontmatter says `name: gamma` is the
agent `gamma`, and it is not reachable as `beta`. That matches pi's own subagent loader and every
comparable system; the file name is never an identity.
One thing distinguishes a definition you wrote that silently failed from a file that was never a
definition: a `.md` whose first non-blank line opens a frontmatter block or is a `name:` key, but
which then fails to parse, is skipped _and_ reported — it emits a `console.warn` naming the path.
Prose kept beside the agents (a `README.md`, a `notes.txt`) is skipped silently. Either way the
roster listing is the same; only the signal differs.
`description:` is what the model reads to decide whether to name this agent at all, so it is worth
writing as a trigger condition rather than a title. `tools:` restricts the child to that list; a
definition that omits it leaves pi's full toolset in place, exactly as the generalist has it.

Two places list what is registered. The `pi_task_codemode` tool description carries a **roster** —
every registered definition with its description and the scope that reaches it — so a model can see
what is available before trying anything. A name that resolves to nothing still produces a refused
`DispatchResult` whose `errorMessage` names what _is_ registered under the effective scope, both
lookup paths, and the minimal file shape; read that rather than re-probing the file system. An
empty registry is not an error: it means everything dispatches as a generalist.

```ts
// ptc_run_code
const handle = await tools.pi_task_ptc({
  task: "survey the peer implementations", // required: the child's task text
  // wait is omitted: the call does NOT wait, and the task keeps running.
  label: "peer survey", // optional; defaults to task.slice(0, 64)
  // agent: "researcher", // optional: narrow the child with a definition
});

// A not-waiting spawn returns a DispatchHandle:
// { taskId: "01JBZ000000000000000000001", label: "peer survey", status: "running" }
return handle;

// The other shape: ask for the answer, and the result comes back in this call.
const result = await tools.pi_task_ptc({
  task: "survey the peer implementations",
  wait: true,
});
// { text: "...", status: "fulfilled", taskId: "01JBZ...", label: "...", ... }
```

Input fields are the binding's fields:

| field           | type                            | default                          | meaning                                                                |
| --------------- | ------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `agent`         | `string`                        | omitted = generalist             | optional: narrow the child                                             |
| `task`          | `string`                        | — (required)                     | task text handed to the child                                          |
| `cwd`           | `string`                        | the run's cwd                    | child working directory                                                |
| `agentScope`    | `"user" \| "project" \| "both"` | `"user"`                         | which agent directories are searched                                   |
| `model`         | `string`                        | unset: inherit the session model | model override                                                         |
| `thinkingLevel` | `string`                        | `"off"`                          | thinking-level override                                                |
| `wait`          | `boolean`                       | `false`                          | wait for the result (`true`), or take a handle and let the task run on |
| `label`         | `string`                        | `task.slice(0, 64)`              | human label on the handle and the record                               |
| `readOnly`      | `"strict" \| "lenient"`         | omitted = no tier                | ask for a read-only child (ADR-0041)                                   |

`readOnly` is a mode, not a role, and a **string, not a boolean** — strings only, because pi's
validator coerces booleans and that coercion could silently turn `readOnly: 0` into "no tier".
`"strict"` beats the agent's
declared `tools:` outright rather than merging with it, narrowing the child's tools to the read set
— no `bash`, no `edit`, no `write` — so it cannot modify anything. `"lenient"` never reaches the
tool list at all, so the declared tools (or the child's full toolset) still decide it: the child is
handed byte-for-byte the list an untiered dispatch would have handed it, and is only told to work
read-only. Strict is a capability narrowing, **not** a sandbox: nothing here contains a hostile
child, and a strict child cannot run tests or call `git`.

The tier that took effect is reported twice, because the two readers are different. A program
reads `readOnlyTier` on the result — `readOnlyTier` on the record, `read_only_tier` in the
projection — and a **model** reads a rendered line above the child report, since pi never hands a
`direct` tool's `structuredContent` to the model. Neither line appears when no tier was requested.

### Which model the child runs

A child is a fresh `pi` subprocess, so it resolves its own model. First match wins:

1. the dispatch's `model` argument;
2. the named agent definition's frontmatter `model:`;
3. **the caller session's current model** — passed to the child as one
   `--model provider/id` argument;
4. pi's own configured default — no `--model` flag is passed at all.

Tier 3 is inherited behaviour ([ADR-0044](../adr/0044-a-dispatch-inherits-the-session-model.md)):
a session that switched provider or model mid-conversation carries that choice into the children it
dispatches, instead of silently falling back to pi's global default. It is a **snapshot**: the
model the session is on when the dispatch is issued is the one the child gets. A model switched
after the spawn does not change a child that is already running, a nested dispatch inherits the
child's own session model, and re-running the dispatch is how a caller picks up a new model. If the
child should run on a different model — cheaper, pinned, or deliberately not the session's — name it
at the call site (tier 1) or in the definition (tier 2); those tiers are unchanged, and there is no
config key or opt-out for tier 3. A direct library caller with no session-model context, or a pi
that does not expose one, falls through to pi's configured default exactly as before.

That is an orchestration fact, not only an implementation one. In the 2026-10-19 field report the
parent had switched provider, and the child it dispatched afterwards resolved to pi's default
provider and died on a **429** before writing a byte. The failure notification, `ptc_task_output`
and a rejected `pi_task_codemode` call now carry the cause (see
[Notification delivery](#notification-delivery) and [The child report](#the-child-report)), and the
model the child actually ran is reported on the result and the record — so the class of mismatch is
visible even when the call site did not pin it.

**What the child ran is reported.** The host observes the provider/model from the child's own
assistant turns (last turn wins) and states it on every surface that carries the child's facts:
`observedProvider` / `observedModel` on a foreground `DispatchResult`, the same optional pair on the background
`TaskRecord`, as a `model: provider/id` line on this page's `ptc_task_output` text and on a
successful `pi_task_codemode` result, and as a `model=` fact in a rejected `pi_task_codemode` call's
diagnostic. Either half may be absent when the transcript named only the other; both absent means
no observed assistant turn named the pair — no turn, a supported pi that does not report it, or an
old record — never "unknown model".

On a refusal — depth cap, unknown agent, or a spawn that never came up — the call
resolves with a `DispatchResult` instead: `{ status: "rejected", started: false, errorMessage: … }`.
The concurrency cap is **not** one of them any more: over the cap a call is queued, not refused.
The binding never throws, so branch on the shape:

```ts
const result = await tools.pi_task_ptc({
  agent: "researcher",
  task: "survey the peer implementations",
  // wait is omitted, so the call does not wait.
});

if (result.status === "running" || result.status === "queued") {
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
It reads `"running"` when the child is up, and `"queued"` when the call had to wait for a
concurrency slot (the child starts later, when the task reaches the head of the queue).
Live state comes from `ptc_task_list`; the handle is only an address.

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

The three tools are **not** part of the PTC-mode loadout, so `/ptc off` does not remove them from the
registration — and what is withheld from the model is a different question now
([ADR-0053](../adr/0053-every-dispatch-is-a-task.md)):

> **The lifecycle face is in the model's face exactly when the session has a task record.**
>
> A task record is the only trace a dispatch leaves, so "is there something for these three tools to
> do?" and "does this session have a task record?" are one question. Before the session's first
> dispatch there is nothing to list, read or stop, and the three tools are out of the model's face;
> the moment a dispatch creates a record they are back, and they stay for the rest of the session.
> A resumed session that already has records shows them from its first request.

The tools stay **registered** either way (pi cannot unregister a tool); what changes is whether the
model is offered them. `/ptc off` truncates this package's segment of the chain — on `full_ptc`
the whole orchestration layer goes, on `codemode_ptc` this package's segment under pi's `codemode`
goes ([ADR-0058](../adr/0058-ptc-off-truncates-the-chain.md)) — and an in-flight task still has to
stay readable and stoppable. It also pulls the QUEUED tasks out of the queue
([ADR-0057](../adr/0057-cancellation-only-reaches-queued-tasks.md)): a task that has not
started is withdrawn rather than signaled, so `/ptc off` means "stop accepting new tasks, pull
the queued ones out, let the running ones continue".

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

For a `failed` or `lost` task whose record carries an `errorMessage` — the same reason the
failure notification carried — the text block gains an `error=…` line ahead of the body: the
record's reason sanitized for the text surface (`sanitizeText`: ANSI escapes and control
characters are stripped; embedded newlines and tabs are preserved, so this is a prefixed line,
not a guaranteed single line). The codemode projection exposes the record's own **raw**
`errorMessage` as `error_message` (and the `details` object carries it as `errorMessage`), so a
script that needs the exact bytes asks there rather than parsing the text line. This is the
empty-log case: a child that died before writing output has no other model-facing evidence, so
the reason is the one thing worth reading.

The TUI panels attached to these calls say it too, without a pull: the `task-output` panel prints
the record's failure reason as an `error: …` line first in the output block — ahead of the
preview, the full-output pointer or the empty-output placeholder — and the `task-list` panel
appends one to each `failed` / `lost` row whose record carries an `errorMessage`. Both reuse
the panel's existing `MAX_ERROR_CHARS` bound (120, first non-blank line — ADR-0022 §11), so a
failure reason never grows a row past one line; neither annotation is counted against the panel's
row caps. A settled failure's empty-output placeholder also reads `(no output)` instead of
`(no output yet)`; a page with no recorded reason keeps the `yet`.

#### The child report

A background child's [child report](../adr/0032-child-report.md) is as inspectable as a
foreground child's: the pump reads it off the child's final message with the same extraction the
foreground loop runs, and the registry persists it on the `TaskRecord`, so it survives a restart
exactly as the rest of the record does. `ptc_task_output` renders it above the child's prose —
conclusion first, reasoning second — bounded at 20 findings with the withheld count stated in
band.

**A foreground child's report is now inspectable too**
([ADR-0053](../adr/0053-every-dispatch-is-a-task.md)). The foreground front persists the report on
its own record and writes the child's output to the same `<sessionDir>/tasks/<id>/output.log` the
background front writes — so after the call returns, `ptc_task_output` on the result's `taskId`
renders the report and the prose, exactly as it does for a background task. Before that, a foreground
child's report existed only in the return value and nowhere else.

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

That measurement is independent of the report channel: the record carries the host's own six-field
counter (`input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `turns`), written on every terminal
close for a child the host actually started — so a `none` / `opted-out` child, and one that failed
or was canceled, still shows what it cost. The `usage:` line in the block above is the report's
four-field view of that counter, and a started child with **no** report block shows the
host-measured `usage:` line as well; the structured projections carry it too, shaped to match what
the model was shown. When the record carries an observed model, the block gains a
`model: provider/id` line after that report/usage block and ahead of the prose — the model the
child actually ran, stated by the host rather than by the child (ADR-0044).

**When there is no report block at all** — a task that is still `running` or `stopping`, or one
that ended `failed`, `canceled` or `lost` — the absent report is a claim, not a gap. Those records
carry neither `report` nor `reportChannel`: a child that has not finished has not reported _yet_,
and "has not reported yet" is a different claim from "ran and complied with nothing to say"
(`reportChannel: "none"`). Usage is a separate claim: `failed` and `canceled` are terminal closes
of a started child, so their records still carry the host-measured `usage`; `running` / `stopping`
have simply not reached a close yet, and a `lost` record carries none.

For a `failed` or `lost` record that carries an `errorMessage`, the reason is now rendered
rather than left on the record: `ptc_task_output` puts an `error=…` line ahead of the body, and
the codemode projection exposes the record's `errorMessage` as `error_message`. That is what
makes an empty log readable. The empty-output fallback agrees with it: a terminal task reads
`(no output; task <id> is <status>)`, and only `running` / `stopping` keep the `yet` — a task
that will never write again is not still waiting to write.

**`ptc_task_stop`** — ask a task to stop.

| parameter | type     | default        | notes                                 |
| --------- | -------- | -------------- | ------------------------------------- |
| `taskId`  | `string` | — (required)   | an unknown id is an error             |
| `reason`  | `string` | `"model stop"` | recorded as the record's `stopReason` |

```ts
ptc_task_stop({ taskId: "01JBZ000000000000000000001", reason: "no longer needed" });
```

A stop while the task is already `stopping` is idempotent (no second event). A stop on a task that
is already terminal is an illegal-transition error.

**The stop reaches two different states, and which one it is depends on whether the task has
started** ([ADR-0057](../adr/0057-cancellation-only-reaches-queued-tasks.md)):

- A task that is still **waiting for a concurrency slot** (`queued`) is **withdrawn**: it leaves
  the queue, it never starts a child, and its record goes `canceled` with your `reason` on it.
  There is no process to signal, so no signal is sent — the task simply never runs.
- A task that is already **running** (`running`) cannot be canceled: it goes `running -> stopping`
  and the dispatcher sends the signal, so the task transitions through `stopping` to `canceled`
  when the child exits.

That is the same split libuv's `uv_cancel` makes: a work item still in the queue is removed
(the call returns 0), one a worker has already taken is busy and keeps running.

## Status and transitions

`TaskStatus` has seven values. `queued` is the admission-queue state: the task exists and is
waiting for a concurrency slot, and it has not started a child yet
([ADR-0056](../adr/0056-admission-queues-instead-of-rejecting.md)).

A foreground dispatch's record uses the same seven states and the same transitions
([ADR-0053](../adr/0053-every-dispatch-is-a-task.md)) — the foreground front writes the same
`running -> succeeded | failed | canceled` edges, with the same rules about what counts as a
success (exit 0 **and** assistant text).

| status      | terminal | can move to                                           |
| ----------- | -------- | ----------------------------------------------------- |
| `queued`    | no       | `running`, `canceled`, `lost`                         |
| `running`   | no       | `stopping`, `succeeded`, `failed`, `canceled`, `lost` |
| `stopping`  | no       | `succeeded`, `failed`, `canceled`                     |
| `succeeded` | yes      | —                                                     |
| `failed`    | yes      | —                                                     |
| `canceled`  | yes      | —                                                     |
| `lost`      | yes      | —                                                     |

- `queued -> running` — the task took a concurrency slot and its child started.
- `queued -> canceled` — the task was withdrawn from the queue before it started (a foreground
  program was aborted while it waited, or `ptc_task_stop` withdrew it).
- `queued -> lost` — the owning session ended while the task was still waiting.
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

**A foreground task's completion is not pushed.** Its result was handed to the caller inline, so a
completion message would spend a turn telling the model something it already holds
([ADR-0053](../adr/0053-every-dispatch-is-a-task.md)). The record still exists and is still
readable with `ptc_task_output`; it just never becomes a message.

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
    <!-- <error-message> only when the record carries one (failed / lost in practice) -->
    <report-channel>tool</report-channel>
    <!-- <output-ref>…/tasks/01JBZ…/output.log</output-ref> once the log exists -->
    <output-preview>…only when outputBytes &lt;= 2048…</output-preview>
  </bg-task-notification>
</bg-task-notifications>
```

- **Inline preview.** `<output-preview>` is included only when the task's `outputBytes` is at or below
  **2048 bytes**. Above that the event carries `<output-bytes>` only, and the model dereferences the
  body with `ptc_task_output`.
- **Failure text.** A record that carries an `errorMessage` (`failed` / `lost` in practice —
  a `succeeded` or `canceled` close records no reason) renders it as `<error-message>`, between
  `<output-bytes>` and `<output-ref>`: head-truncated to at most 1024 **code points**, an ellipsis
  marking the cut, and XML-escaped (the cut never splits a surrogate pair). A record with no
  `errorMessage` omits the element — a `failed` child that exited non-zero with no diagnostic has
  no stated cause, and the element does not invent one. This is what makes a zero-byte failure
  readable: the log is empty and `status="failed"` alone reads as an infrastructure fault. The
  rule is the ADR-0022 §7 amendment of 2026-10-19, which records the field report behind it.
  **The cap is this push surface's alone** — it bounds the batch. `ptc_task_output` states the
  record's full `errorMessage`, so a reader who needs the whole string pulls instead of being
  handed a truncated one.
- **Report channel.** A `succeeded` event carries `<report-channel>` — `tool`, `prompt-json`,
  `none` or `opted-out`, the same **total** field ADR-0032 defines — between `<error-message>`
  and `<output-ref>`. It is rendered whenever the joined record carries a channel — in practice
  the `succeeded` event alone; an event that cannot have a channel claim omits it (a running task
  has not reported _yet_, and a `failed` / `lost` / `canceled` close has no report to describe),
  so absence means "has not reported yet", never "reported nothing". (A `succeeded` record written
  before ADR-0032 has no recorded channel either: there, absence means the field predates the
  record.) The completion push
  therefore states whether the child honoured the report contract, which previously took a
  `ptc_task_output` poll to discover;
  `none` means the child ran and ignored the contract, `opted-out` means the agent disabled it
  (`childReport: false`) and nobody asked — different claims, kept unmerged. See
  [The child report](#the-child-report) for what each channel means.
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

- **`dispatchConcurrency` — default 8, one counter per pi session.** A cap on how many dispatch
  children run **at once** across the whole session. The N+1th call is **queued**, not refused:
  the queue is FIFO, unbounded and has no timeout, and the call runs when it reaches the head
  ([ADR-0056](../adr/0056-admission-queues-instead-of-rejecting.md)). A background task
  **counts against the cap for its whole lifetime**, from spawn to its terminal transition, not
  just until `pi_task_ptc` returns.

  Three things follow:

  - **Foreground and background draw on the same 8.** A session with eight long background children
    running has no foreground dispatch headroom left _right now_, so a program issuing
    `Promise.all([...pi_task_ptc])` in that state gets every call **queued** rather than refused —
    they run as the background children finish. The queue is what makes this usable at all: the
    caller was going to wait for its children anyway.
  - **Two concurrent programs share it.** They also share the queue, so a call from one program
    waits behind the other's rather than being turned away.
  - **The cap bounds concurrency, not the number of children.** A program that loops can queue
    as many dispatches as it likes; the queue is unbounded, and each queued task eventually runs.
    The foreground's bound is the program's own deadline (below); the background's bound is the
    session's lifetime.

  **The live control is `createBackgroundTaskRuntime({ concurrency })`** — the call that builds the
  session counter, in `src/index.ts`, handed the value of `PtcConfig.dispatchConcurrency`. It is not
  a background-only knob: it is the session's whole dispatch budget. The `dispatchConcurrency` a
  caller passes to `runPtcProgram({ config })` sizes the dispatcher's own per-run counter, and that
  counter is only reached when no session counter is supplied; in a pi session one always is, so the
  per-run one is not what enforces the cap you are looking at. `pi_task_codemode` spends this same
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
| `ptc_task_stop` (model) | `queued -> canceled`              | a task that has not started is WITHDRAWN, not signaled: no child exists, so it leaves the queue and never runs ([ADR-0057](../adr/0057-cancellation-only-reaches-queued-tasks.md)).     |
| session stop / Esc      | `running -> lost`                 | implicit; v1 records `session_ended_while_running` (pi exposes no Esc-specific signal, so `user_killed_via_esc` is not emitted).                                                        |
| session restart         | `running -> lost`                 | startup reconciliation, reason `lost_on_session_restart`; reaps only records whose owner process is dead (or pre-upgrade ownerless ones), and also sweeps a task caught mid-`stopping`. |

## On disk

The task state goes through the `TaskStorage` seam. There are two adapters: an in-memory one
(process-local, used when no session directory is available) and `FileTaskStorage`, which persists
under the session directory so a restart can reconcile:

```text
<sessionDir>/tasks/<taskId>.json                                 # the TaskRecord, 28 fields today: 19 ADR-0022 §3 originals plus the 2026-10-16 `usage`, 2 optional ADR-0023 owner fields, 2 optional ADR-0032 report fields on a succeeded record, the optional ADR-0041 `readOnlyTier`, the optional ADR-0043 `whySuppressed`, and the optional observed-model pair `observedProvider` / `observedModel` (ADR-0044, renamed by ADR-0045) (atomic temp+rename)
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
- **`outputSchema`** — `pi_task_ptc` itself declares none: the binding resolves to `{ text, status, ... }`
  and has no structured form (see the exception in the binding contract). The `ptc_task_*` tools and
  `pi_task_codemode` DO declare one, for a different consumer — see
  [Structured results for codemode](./structured-results.md).
- **Waiting → not-waiting promotion** — there is none: a call decides once, at its own call site,
  and a call that is already waiting cannot be turned into a task that outlives it.

## See also

- [ADR-0022 — background dispatch](../adr/0022-background-dispatch.md) — the full design and decisions.
- [ADR-0023 — background task ownership](../adr/0023-background-task-ownership.md) — owner-tagged
  records and owner-scoped reaping (why sibling processes no longer reap your tasks).
- [ADR-0016 — the `pi_task_ptc` binding](../adr/0016-ptc-dispatch-binding.md) — the foreground binding this extends.
- [ADR-0041 — the read-only dispatch tier](../adr/0041-read-only-is-a-call-site-tier.md) — why `readOnly` is a narrowing and not a boundary.
- [ADR-0015 — the pi truncation contract](../adr/0015-pi-truncation-contract.md) — the 50 KB / 2000-line rule.
- [`GLOSSARY.md`](../../GLOSSARY.md) — canonical terms (background dispatch, TaskRecord, TaskStatus, TaskRegistry, Subscription, DispatchHandle, `ptc_task_*`, `<bg-task-notification>`).
