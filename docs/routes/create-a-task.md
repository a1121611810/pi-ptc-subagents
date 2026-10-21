# Create a task

**When to take this road:** the work is a question with an answer rather than a fact you can look
up, or its output would be larger than the answer.

A task is a fresh pi agent, running as its own process. It gets its own context and its own
tools, and it cannot see or change your session except through what it hands back.

## How to call it

The door has one name per surface, and the two names are plain JavaScript identifiers — so both
planes call them with a dot.

| Surface        | The call                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full_ptc`     | Write a program, run it with `ptc_run_code`, and inside it call `await tools.pi_task_ptc({ task })`. The PTC door lives inside a program, not in your tool list.                                                          |
| `codemode_ptc` | Call `await tools.pi_task_codemode({ task })` from your `codemode` script — it is a tool in that script's own table. A `codemode` script's tool table does not contain `pi_task_ptc`, and calling it from a script fails. |

The task text is the whole contract: the child sees it and nothing else about your session. Say
what to do, what "done" looks like, and what to hand back.

## What comes back

Without `wait` the call returns a handle right away (`taskId`, `label`) and the task keeps
running; pass `wait: true` when you need the result before you go on. A refusal is a
result with `status: "rejected"` and an `errorMessage`, never an exception. A task you
did not wait for is read later with `ptc_task_output`, and the child's own report comes
back with the result.

The two doors give the same object, so the code that reads a task's result does not change when
you move between surfaces.

## Pitfalls

- **`wait` defaults to not waiting.** A call without it returns a handle, not a result. If you
  need the answer before you go on, ask for it.
- **A refusal is a result, not an exception.** Read `status` and `errorMessage`; nothing is
  thrown at you.
- **`pi_task_ptc` is not a tool on the `codemode_ptc` surface.** It is a binding that lives inside
  a program. A `codemode` script calls `pi_task_codemode` instead.
- **The `agent` name is optional.** Omit it and the child is a fresh generalist pi; name a
  registered definition to narrow it, and a name with no definition behind it is refused.
- **The parent's model has no web tool of its own.** If the task needs the web, say so in the task
  text — see _Reach the web_.

## Examples

Create a task and wait for it, on the `full_ptc` surface:

```ts
const result = await tools.pi_task_ptc({
  task: "Survey the three candidate libraries and report which one fits, with a reason.",
  wait: true,
});
return result;
```

Create a task and keep working, on the `codemode_ptc` surface:

```ts
const handle = await tools.pi_task_codemode({
  task: "Check whether the failing test also fails on main, and report the answer.",
});
return handle; // { taskId, label } — read it later with ptc_task_output
```
