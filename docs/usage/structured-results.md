# Structured results for codemode

Every model-facing tool this package registers returns **two** result channels:

| channel             | who reads it              | what it is                                      |
| ------------------- | ------------------------- | ----------------------------------------------- |
| `content`           | the model, and the TUI    | the text block(s) — unchanged by anything below |
| `details`           | the TUI renderers         | this package's own richer structure, per tool   |
| `structuredContent` | **codemode scripts only** | a lean projection, declared by `outputSchema`   |

`structuredContent` is the one that is easy to get wrong by assumption, so this page states what it
is for and what it is not.

## Why it exists

pi 1.0.0 ships a built-in `codemode` extension: the model writes a JavaScript program, the program
calls other tools, and **only the program's own output reaches the model**. That makes several things
possible that a flat tool call cannot do — fan out to N subagents in one call, filter and aggregate
their output before it reaches the transcript, keep a value in `store()` between calls.

It also breaks a tool whose result is prose. `ptc_subagent` is the acute case: it is the only way a
session that has handed orchestration to `codemode` can start a subagent at all, because the QuickJS
sandbox has no file system, no network and no `child_process`. A script calling it used to get back
the string `"Started background task 01JABC…"` and had to regex the id out.

## What a script gets

```js
// pi 0.99.1+ / 1.0.0
const started = await tools.ptc_subagent({ task: "survey the auth module", background: true });
text(`spawned ${started.task_id}`); // an object, not a string

const rows = await tools.ptc_task_list({ status: ["running"] });
for (const t of rows.tasks) {
  if (t.output_bytes > 100_000) text(`${t.id} is large`);
}
```

| tool              | `structuredContent`                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `ptc_task_list`   | `{ tasks: [{ id, status, agent, depth, label, output_bytes?, error_message? }], count }`          |
| `ptc_task_output` | `{ task_id, status, output, output_bytes, output_preview?, output_truncated, output_full_path? }` |
| `ptc_task_stop`   | `{ task_id, status, from_status, stop_reason? }`                                                  |
| `ptc_subagent`    | `{ task_id?, status, exit_code? }`                                                                |

Optional keys are **omitted**, never present-and-null, so `Object.hasOwn(t, "error_message")` is
the test for "this task had an error", not `t.error_message !== undefined`.

Two fields carry the useful asymmetry:

- `ptc_subagent`: `task_id` is present only for a **background** spawn and `exit_code` only for a
  foreground one, so a script can tell "I have a handle, poll it" from "this already finished"
  without parsing prose.
- `ptc_task_output`: `status` is the task's current state, so a polling script does not need a
  second `ptc_task_list` call.

## What it is not

- **Not sent to the model.** `content` remains the model-facing result; `structuredContent` is
  documented as "for programmatic callers" and is stripped when the tool-result message is built.
  Declaring one costs zero prompt tokens and changes nothing about what a model sees.
- **Not validated.** pi never checks that `structuredContent` matches the declared `outputSchema`.
  Nothing will tell you if they drift; that is why the shapes above are pinned by tests.
- **Not a mirror of `details`.** `details` carries what the TUI needs, including a per-record
  `outputPreview` of up to 2 KB; a 100-row `ptc_task_list` mirroring it would push ~200 KB into a
  sandbox whose purpose is to keep intermediate data away from the model. The two channels are
  allowed to drift, deliberately.
- **Not a failure channel.** The `ptc_task_*` and `ptc_subagent` error paths throw. A script gets a
  rejected promise, not a structured error object — pi has no channel for that on this API.

`pi.dispatch` declares no `structuredContent` and is unchanged: it resolves to `{ text, status, … }`
with no `content` at all, and the binding contract already names it as the exception.

## Which surface am I on?

`structuredContent` matters when orchestration went to `codemode` — the `subagents` surface. On the
`full` surface the model drives `ptc_run_code` / `ptc_workflow` instead, where bindings are the
program's own calls and the binding contract is what governs their return shape
(`{ content, details }`, failures REJECT). See [ADR-0025](../adr/0025-extension-surface-is-a-setting.md)
for how the surface is chosen and [ADR-0027](../adr/0027-codemode-switch-decides-surface.md) for the
default.

## Turning codemode on

`codemode` registers **inactive** on a default pi session, so the surface above is only reachable
once you add it to your tool list:

```json
{ "defaultTools": ["read", "bash", "edit", "write", "+codemode"] }
```

Without it, a `subagents`-surface session has `ptc_subagent` and no orchestrator to call it from.
