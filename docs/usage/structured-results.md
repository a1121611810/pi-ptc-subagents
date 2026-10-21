# Structured results for codemode

Every model-facing tool this package registers returns **two** result channels:

| channel             | who reads it              | what it is                                      |
| ------------------- | ------------------------- | ----------------------------------------------- |
| `content`           | the model, and the TUI    | the text block(s) — unchanged by anything below |
| `details`           | the TUI renderers         | this package's own richer structure, per tool   |
| `structuredContent` | **codemode scripts only** | the result object, declared by `outputSchema`   |

`structuredContent` is the one that is easy to get wrong by assumption, so this page states what it
is for and what it is not.

## Why it exists

pi 1.0.0 ships a built-in `codemode` extension: the model writes a JavaScript program, the program
calls other tools, and **only the program's own output reaches the model**. That makes several things
possible that a flat tool call cannot do — fan out to N subagents in one call, filter and aggregate
their output before it reaches the transcript, keep a value in `store()` between calls.

It also breaks a tool whose result is prose. `pi_task_codemode` is the acute case: it is the only way a
session that has handed orchestration to `codemode` can start a subagent at all, because the QuickJS
sandbox has no file system, no network and no `child_process`. A script calling it used to get back
the string `"Started background task 01JABC…"` and had to regex the id out.

## What a script gets

```js
// pi 0.99.1+ / 1.0.0
const started = await tools.pi_task_codemode({ task: "survey the auth module", background: true });
text(`spawned ${started.taskId}`); // an object, not a string

const rows = await tools.ptc_task_list({ status: ["running"] });
for (const t of rows.tasks) {
  if (t.output_bytes > 100_000) text(`${t.id} is large`);
}
```

| tool               | `structuredContent`                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ptc_task_list`    | `{ tasks: [{ id, status, agent, depth, label, output_bytes?, error_message? }], count }`                                                             |
| `ptc_task_output`  | `{ task_id, status, output, output_bytes, output_preview?, output_truncated, output_full_path?, report_channel?, read_only_tier?, report?, usage? }` |
| `ptc_task_stop`    | `{ task_id, status, from_status, stop_reason? }`                                                                                                     |
| `pi_task_codemode` | the **raw** task result: `{ text, status, started, agentName, durationMs, exitCode, reportChannel, recordId?, recordLabel?, … }`                     |

Optional keys are **omitted**, never present-and-null, so `Object.hasOwn(t, "error_message")` is
the test for "this task had an error", not `t.error_message !== undefined`.

Two fields carry the useful asymmetry:

- `pi_task_codemode`: `status` is the discriminant. `"running"` is a handle to poll with
  `ptc_task_output`; `"fulfilled"` is a child that already answered; `"rejected"` is a call that was
  refused, with `errorMessage` saying which gate said no. A settled call names the task it created
  under `recordId`, and a handle names the task it is polling under `taskId`.
- `ptc_task_output`: `status` is the task's current state, so a polling script does not need a
  second `ptc_task_list` call.

`pi_task_codemode` is the **same object** the PTC door resolves with — the raw result, field for
field, under the same names. The `pi_task_ptc` binding hands a PTC program exactly this value, so
a script and a program read one vocabulary instead of two, and the child's own working text
(`text`) is in it either way.

`usage` (issue #199) is the host's own count — `input`, `output`, `cost`, `turns`, the same four
fields `report.usage` carries — and it is sourced from the record's / result's own accumulator
rather than from the report. That is what makes it readable for a child with **no** report: a
`report_channel` of `none` or `opted-out`, and a failed or canceled `ptc_task_output`, still
account for what the child cost. Absent means no top-level count was recorded: a running task,
a `lost` record, a record written before the field existed (its report, when one exists, still
renders the report's own host-stamped numbers), or a background handle in
`pi_task_codemode`. The text block states the same four numbers on its `usage` line, so the two
channels never disagree about a measurement.

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
- **Not a failure channel — for the task doors.** The `ptc_task_*` error paths throw: a script gets
  a rejected promise, not a structured error object. The two **task** doors are the exception
  (ADR-0054): a refused `pi_task_codemode` or `pi_task_ptc` call comes back as a result whose
  `status` is `"rejected"` and whose `errorMessage` says which gate said no. A gate that said no is
  not a broken call, and one child's refusal must not take its siblings down with it.

`pi_task_ptc` declares no `structuredContent` and is unchanged: it resolves to `{ text, status, … }`
with no `content` at all, and the binding contract already names it as the exception. That value is
the same one `pi_task_codemode` hands a script, so the two doors are one object seen from two
planes.

## Which surface am I on?

`structuredContent` matters when orchestration went to `codemode` — the `codemode_ptc` surface. On the
`full_ptc` surface the model drives `ptc_run_code` / `ptc_workflow` instead, where bindings are the
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

Without it, a `codemode_ptc`-surface session has the codemode door and no orchestrator to call it from.

That list is pi's own tool set, which is not the same question as what a PTC program may bind:
`bash` being in `defaultTools` enables it for pi, but binding `tools.bash` to a program is a
separate opt-in — see [Trust posture](../../README.md#trust-posture-read-me).
