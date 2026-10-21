# Manage a task

**When to take this road:** you created a task and want to see it, read what it produced, or stop
it.

Every task this session created has a record, and the record is what these three tools read. The
task face follows the record: before the first task exists there is nothing to manage, and after
one exists the face stays.

## How to call it

| Surface        | The call                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `full_ptc`     | `ptc_task_list` for the live status, `ptc_task_output` for what the task produced, `ptc_task_stop` to stop it. |
| `codemode_ptc` | `ptc_task_list` for the live status, `ptc_task_output` for what the task produced, `ptc_task_stop` to stop it. |

The three tools are declared to the model on every surface, so the call is the same on both.

## What comes back

A task that is still waiting for a concurrency slot is withdrawn from the queue and never
starts; a task that is already running is signaled and goes through stopping to canceled. The
captured output is tail-truncated, and the footer names the file with the whole thing.

- `ptc_task_list` returns each task's id, status, agent, depth, label and output size, newest
  first. Filter with `status`, and cap the row count with `limit` (default 100).
- `ptc_task_output` returns the captured output, and for a succeeded task it renders the child's
  report ahead of the prose. A failed or lost task states the record's error message first, so an
  empty output is not mistaken for an infrastructure fault.
- `ptc_task_stop` is idempotent while the task is already stopping, and errors when the task is
  already terminal.

## Pitfalls

- **Only a queued task can be withdrawn.** A running task is a separate process; stopping it takes
  the signal ladder, and it goes through `stopping` before `canceled`.
- **The output is tail-truncated** to pi's limits (50 KB / 2000 lines). When anything is cut, the
  footer names the file with the complete output.
- **A succeeded task's report is rendered before the prose,** so a report and a prose answer are
  two different things in the same output.
- **`/ptc off` takes these tools out of reach** while the session has no task record. A task that
  is already running keeps going and stays listed.

## Examples

```
ptc_task_list({ status: ["running"] })
ptc_task_output({ taskId: "01JBZ000000000000000000002" })
ptc_task_stop({ taskId: "01JBZ000000000000000000002", reason: "no longer needed" })
```
