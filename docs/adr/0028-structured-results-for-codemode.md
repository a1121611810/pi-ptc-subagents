---

status: accepted (2026-10-02)

# The model-facing tools declare a structured result for codemode, and it is a projection rather than a mirror

## Context

pi 1.0.0 ships a built-in `codemode` extension: a tool that runs model-written JavaScript in a
QuickJS sandbox, where the script calls other tools and only its own output reaches the model. That
makes a subagent reachable from a script — but only if the tool it calls hands back something a
script can use.

Every tool this package registers hands back a **text string** to a codemode script:

| tool              | what a codemode script receives today                              |
| ----------------- | ------------------------------------------------------------------ |
| `ptc_subagent`    | `"Started background task 01JABC…"` — the ULID must be regex'd out |
| `ptc_task_list`   | one newline-joined line per record, to be re-parsed                |
| `ptc_task_output` | up to 50 KB of prose                                               |
| `ptc_task_stop`   | `"<id>  <status>  reason=…"`                                       |

`ptc_subagent` is the acute case. It is the ONLY way a `subagents`-surface session can start a
subagent at all, because the QuickJS sandbox has no file system, no network and no `child_process` —
ADR-0025 kept this tool precisely for that. So a script that wants to fan out to five subagents and
collect their ids has to string-parse five times to get data the host already had in a structured
form.

## What pi actually offers

`ToolDefinition` carries an optional `outputSchema`
(`pi-coding-agent@1.0.0/dist/core/extensions/types.d.ts:459-462`):

> JSON Schema of `structuredContent` in successful results. Tools that declare it should always set
> `structuredContent`; codemode scripts then receive it instead of the text content.

Three properties of it decide this ADR, each read from the installed artifact rather than the
release notes:

1. **It does not reach the model.** `AgentToolResult.structuredContent` is documented "Not sent to
   the model; `content` remains the model-facing result"
   (`pi-agent-core/dist/types.d.ts:375-378`), and that is what the code does:
   `createToolResultMessage()` in `pi-agent-core/dist/agent-loop.js:649-660` copies `role`,
   `toolCallId`, `toolName`, `content`, `details`, `usage`, `isError` and `timestamp` field by
   field, and `ToolResultMessage` has no such field to copy into. So the model-facing prompt cost
   of this change is **zero**, and no existing description or `content` block changes.
2. **Nothing validates it.** There is no `Value.Check` anywhere in pi's dist. A `structuredContent`
   that does not match its declared schema is passed through silently. Correctness is entirely ours.
3. **The consumption point is one line.** `toScriptValue()` in
   `dist/extensions/codemode/execute.js:256-259`: `if (tool.outputSchema && result.structuredContent
!== undefined) return result.structuredContent;`

The cost side: `JsonValue` is `null | boolean | number | string | readonly JsonValue[] |
JsonObject`, and `JsonObject`'s index signature admits no `undefined`. A key set to `undefined` is
not a `JsonValue`, so optional fields must be **omitted**, never blanked. pi's own `bash` does this
with conditional spread (`dist/core/tools/bash.js:286-293`).

pi ships **no** example of this — `outputSchema` appears zero times across all 80 entries in
`pi/examples/extensions/`. The four tools below are the first in this ecosystem to use it.

## The decision

**`structuredContent` is a lean projection built for the script. It is deliberately NOT a mirror of
`details`.**

`details` is the TUI's channel and it is allowed to be rich. `PtcTaskListDetails.tasks` is
`TaskRecord[]`, and one `TaskRecord` carries `outputPreview` (up to 2 KB), `outputRef` (a
filesystem path), and internal bookkeeping (`ownerPid`, `ownerBootMs`, `transitionAt`). At the
default limit of 100 records, mirroring it would push ~200 KB of preview text into a sandbox whose
whole point is to keep intermediate data away from the model. Mirroring would also couple the
codemode surface to a record shape that ADR-0022 has continued to extend, so every future internal
field would silently become public API.

So each tool projects the fields a script would filter or aggregate on, and the shapes are chosen to
match what the model was shown in the text block, so a script and the transcript agree on the shape:

> **Keys agree; values are raw.** `error_message` and `stop_reason` carry the record's string
> verbatim, while the text block runs the same values through `sanitizeText`. That is deliberate —
> filtering on a lossy string is worse for a script than seeing the real one — but it means
> "agree" is a claim about field names and structure, not about byte equality.

| tool              | `structuredContent`                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `ptc_task_list`   | `{ tasks: [{ id, status, agent, depth, label, output_bytes?, error_message? }], count }`          |
| `ptc_task_output` | `{ task_id, status, output, output_bytes, output_preview?, output_truncated, output_full_path? }` |
| `ptc_task_stop`   | `{ task_id, status, from_status, stop_reason? }`                                                  |
| `ptc_subagent`    | `{ task_id?, status, exit_code? }`                                                                |

Two naming decisions, both argued rather than defaulted:

- **snake_case, unlike this package's `details`.** pi's own builtins are snake_case
  (`exit_code`, `full_output_path`), and the consumer here is a codemode script reading OUR declared
  schema. Keeping one spelling inside one package matters more than matching a convention the
  script author does not otherwise see.
- **`agent`, not `agentName`.** This is the one deliberate exception to the above, and it is
  deliberate: `formatTaskLine` prints `${record.agentName}`, so a script comparing a structured row
  against the transcript should not have to know a third spelling of the same field.

`ptc_task_output`'s `status` is new information — `execute` already loads the record and uses it only
for the "no output yet" message, so surfacing it lets a script poll without a second `ptc_task_list`
call. `ptc_subagent`'s `task_id`/`exit_code` asymmetry is the load-bearing one: it is what lets a
script tell "I have a handle, poll it" from "this already finished", without reading prose.

`pi.dispatch` is unchanged and still declares nothing. It resolves to `{ text, status, … }` with no
`content` at all, and the binding contract already names it as the exception.

## What we deliberately do not do

- **No `structuredContent` on the PTC bindings.** ADR-0024's contract promises a failing binding
  call REJECTS, and its result shape is `{ content, details }`. Threading a third field through
  would change the shape every existing program destructures, for a consumer that already has the
  text.
- **No projection helper shared between the four tools.** The shapes share a naming convention, not a
  structure: `ptc_task_list` returns an array, the other three return flat objects, and the optional
  key per tool is different. A helper that took "the details object" would have to be told which
  projection to make, at which point it is indirection over four literals.
- **No change to `details`.** It keeps feeding the TUI renderers untouched. The two channels are
  allowed to drift; that is the price of neither freezing the other, and the tests pin both.

## Consequences

- `content` and `details` are byte-identical to before on every path. That is the property that makes
  this safe to ship against a pi whose `details` consumers are the renderers, and it is asserted
  rather than assumed.
- The failure paths are unchanged and still throw, so they have no `structuredContent`. A script that
  calls `ptc_task_output` with an unknown id gets a rejection, not a structured error object — pi has
  no channel for "structured failure" on this API, and inventing one is out of scope.
- Nothing in this repository observes the codemode side end to end. The unit tests prove the value is
  present, matches the declared schema, and is real JSON; that a QuickJS script actually receives it
  is verified separately against a real pi, and the gap is stated rather than assumed closed.

## Related

- ADR-0024 — the binding contract, whose `{ content, details }` shape this deliberately does not touch.
- ADR-0025 — why `ptc_subagent` exists at all, and why the sandbox alone cannot replace it.
- ADR-0027 — the surface default, which decides whether orchestration goes to this package or to
  `codemode`. This ADR only matters on the half where it went to `codemode`.
