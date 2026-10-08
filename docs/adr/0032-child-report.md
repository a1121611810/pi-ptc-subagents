---

status: accepted (2026-10-08)

# A dispatched child returns a child report, over one of two channels, and always says which

## Context

A dispatched child is a fresh `pi` subprocess. Everything it hands back crosses one boundary: the
host reads the child's stdout, parses it as JSONL, and keeps the **last text part of its final
assistant message** (`assistantText`, `src/runtime/dispatch.ts:1055` — whose own comment says "the
last part wins"). That string is the entire result.

Both kinds of caller are worse off than they need to be, for different reasons:

- A **PTC program** calling `tools["pi.dispatch"](...)` gets a `DispatchResult` whose only payload
  is prose. To use it, the program — or the model writing the program — parses English. That is the
  least reliable link in the chain.
- A **model** using `ptc_subagent` gets the same prose and has nowhere else to look. The tool
  already declares an `outputSchema` (`src/tools/subagent.ts:108`), but ADR-0028 established that
  `structuredContent` is "not sent to the model" — and in `surface mode: subagents` there is no
  `codemode`, so that channel currently reaches **nobody**.

Two facts are already collected and never surfaced:

- `DispatchResult.usage` is accumulated from the child's `message_end` blocks
  (`src/runtime/dispatch.ts:1715`) and then dropped, so neither caller can budget a child.
- Which files a child touched is only knowable by the child. A child that edits through `bash`
  cannot be observed by the host at all.

## What pi 1.0.0 actually offers

Measured against the installed artifact, not the release notes.

1. **There is no structured-output facility for an assistant message at any layer.** The complete
   flag surface is `Args` at `dist/cli/args.d.ts:8-56`; it has no `--output-schema`, `--format` or
   `--response-format`. `CreateAgentSessionOptions` (`dist/core/sdk.d.ts:10-56`),
   `PromptOptions` (`dist/core/agent-session.d.ts:165-176`), `AgentSessionConfig`
   (`dist/core/agent-session.d.ts:111-153`) and `StreamOptions`
   (`@earendil-works/pi-ai/dist/types.d.ts:111-131`) have no schema or format field. What does exist
   — `Tool.constrainedSampling` (`pi-ai/dist/types.d.ts:517-522`) — is a property of a **tool
   declaration**: it constrains a tool call's _arguments_, never the assistant's reply.
2. **No terminal event carries a result object.** `agent_end` (`dist/core/agent-session.d.ts:50-52`)
   carries `messages`; `agent_settled` (`:54`) carries nothing. A design that waits for a "done"
   event with a payload will never fire against pi 1.0.0.
3. **`tool_execution_end.result.structuredContent` _is_ reachable.** It is the full
   `AgentToolResult` (`pi-agent-core/dist/types.d.ts:370-391`), emitted verbatim at
   `pi-agent-core/dist/agent-loop.js:640-648`. This repo already depends on that mechanism
   (`src/tools/subagent.ts:146`, `src/tools/ptc-task.ts:224, 352, 499`).

So a structured return is reachable exactly two ways, and neither is enforced by pi: prompt the
child into emitting JSON, or give it a tool whose declared schema the host reads back.

## Decision

A dispatched child produces a **child report**: a structured value crossing the child→parent
boundary. It carries four things and no more — `summary` (one line, the child's own words),
`findings` (each with `what` and independent `evidence`), `files_touched`, and `usage`. The child's
prose is preserved alongside it, never replaced.

### Two channels, both implemented

1. **Tool channel (preferred).** A report tool with a declared output schema, registered by this
   extension and activated in the child. The host reads its `structuredContent` off the
   `tool_execution_end` event.
2. **Prompt channel (fallback).** The child's appended system prompt states the contract in one
   clause; the host parses a fenced JSON block from the final text.

The fallback is not a formality. The tool channel has a **reachable** failure mode: it exists in
the child only when this package loads there. `src/index.ts:279` returns early when
`surfaceMode === "off"`, and pi's `-ne` removes extensions entirely. A design that treated the
fallback as decorative would have a primary channel that is simply absent on a meaningful fraction
of installs — silently, since nothing reports a missing tool.

This is the acknowledged bet of this ADR: **if models follow the prompt contract poorly, the
feature is dead and CI will not have said so.** No test can retire it. It is recorded here so the
next reader knows which assumption is doing the work.

### The channel is always stated

The result names its channel: `tool`, `prompt-json`, or `none`. The field is **total** — present
whether or not a report arrived — because that is what keeps the degradation explicit. Under
`docs/testing-constraints.md` (no silent failure; failure paths carry a warning or an explicit
status) a silent fallback to prose is a defect, not a graceful default.

`none` is an ordinary outcome: the contract was on and the child did not comply. Such a child
resolves **fulfilled with its prose intact**, because discarding a completed child's answer over a
formatting failure is worse than handing the answer over marked as untrusted.

### The contract has exactly one home — and it is the PROMPT

The child's appended system prompt states the shape. The report tool's description describes the
tool and points at the prompt rather than repeating the shape. There is deliberately no second copy:
this repo has already paid for that twice — `parseAgentMarkdown` versus pi's own frontmatter parser,
and tool descriptions versus the binding-contract module.

**Amendment (2026-10-08, #101) — this decision was made the other way round first, and building
#101 is what proved it wrong.** The tool's description was originally the one home, on the reasoning
that a tool's description is where pi expects a contract to live. But the tool exists in the child
only when this package loads there — `src/index.ts` returns early on `surfaceMode: "off"`, and pi's
`-ne` removes extensions entirely. With the shape in the tool and a one-sentence prompt, a child
without the tool had **nothing to comply with**: the prompt channel stopped being a fallback and
became dead code that still had tests.

The distinction that was missing: the tool is the channel that is **reliable when present**; the
prompt is the one that is **always present**. Those are different virtues, and putting the shape in
the tool quietly traded the second for the first. The host writes the prompt unconditionally, so
the prompt is the home. The rule was never "prompt versus tool" — it was "exactly one", and the
shape now has exactly one home that survives the install where the tool is missing.

### Activation is load-bearing

The host merges the report tool into the child's tool list when the contract is on. This is easy to
get wrong in a way that fails silently: `buildArgv` only emits a tool-list flag when the agent's
markdown declares tools of its own (`src/runtime/dispatch.ts:976`), so a child whose agent declares
none would receive **no** flag at all, and the tool would sit inactive with no error anywhere.

Amendment (2026-10-08, #101): the merge is necessary but **not sufficient**, and the reason is a
property of the flag rather than of this code. pi reads `--tools` as an ALLOWLIST — `sdk.js` turns
it into `allowedToolNames`, and `AgentSession._isAllowedTool` filters both the registry and the
active set through it. So the flag cuts both ways, and activation needs **two** halves:

1. the argv merge, which is what keeps the tool alive for a child whose agent **restricts** its
   tools (`tools: read, bash` → `--tools read,bash,ptc_child_report`). Without the merge the
   allowlist filters the report tool straight back out — the silent failure above;
2. `defaultActive`, set from `PI_PTC_DEPTH`, which is what puts the tool in front of a child whose
   agent declares **no** tools. That case cannot be served by the flag, and emitting
   `--tools ptc_child_report` on its own would leave the child with exactly one tool and no
   `read` / `bash` / `edit` / `write` — a strictly worse outcome than the silence it fixes.

The same amendment fixes the "single home" claim for the prompt: the shape moved out of
`CHILD_REPORT_PROMPT_CLAUSE` and into the tool's description, and the clause is now one sentence
that requires the child to call the tool. The consequence is stated rather than hidden — a child
that cannot call the tool has no shape to comply with, so in an installation where this package
does not load in the child (`surfaceMode: "off"`, pi's `-ne`) the report is unreachable rather than
merely unlikely. The host still READS a compliant fenced block if one arrives; that is what the
prompt channel is for now.

### The opt-out

Agent frontmatter carries one switch, **defaulting to on**. It names a yes/no; it does not carry a
schema, because a per-agent schema reopens the two-copies problem and buys flexibility nobody has
asked for.

Amendment (2026-10-08, #102): the switch is `childReport: false` (also `no`), read by
`parseAgentMarkdown` and threaded through `discoverAgent`. Only `false`/`no` opts out — a typo
leaves the contract ON, because the two failure modes are not symmetric: a contract nobody expected
is a visible extra field, while a child marked non-compliant for a contract it was never given is
not recoverable by the reader.

An opted-out agent is never asked (no prompt clause, no tool in its argv) and never marked. That
last half needed a **fourth** channel value, `opted-out`, and it is the amendment's substantive
change: with only `tool` / `prompt-json` / `none`, an agent that opted out and a child that ignored
the contract produced the same string, and §"The channel is always stated" has already defined
`none` as the latter. `docs/testing-constraints.md` #3 treats a value that cannot distinguish those
two as a silent failure, so the union grew rather than the guarantee weakening.

Known gap, stated rather than hidden: `tools/render.ts`'s no-report block has two branches, keyed
on `"none"` and on "anything else", so an `opted-out` result currently renders through the second
and says "the opted-out channel was announced but no report reached the host". That is inaccurate
(it was never announced) though not non-compliance, and the renderers were explicitly out of scope
for this ticket — `tools/ptc-task.ts` degrades correctly without a change, because its fallback
branch only reports the channel value and the absence. The third branch belongs with the renderer
work in #105.

### Rendering

The model-facing surface does not hand over raw JSON: the host renders the report into a fixed
shape, following the existing value-tree conventions, bounded at 20 findings with the withheld
count stated in-band. The child's prose follows the rendered block — conclusion first, reasoning
second. The program-facing surface gets the field, not the rendering; a program is not a display
surface.

## Consequences

- A program can branch on a child's findings without parsing English.
- `usage` becomes visible to both callers, so a child that is not earning its cost can be seen.
- **The tool channel may be the minority path in the field**, inverting the stated preference. See
  the bet above.
- A child that ignores the contract is reported as having ignored it. A degradation path no test can
  distinguish from success is not a degradation path.
- The extension gains a registered tool, which breaks `scripts/verify-dist-render.mjs` — that gate
  pins the exact expected tool set, and it broke silently for a previous feature that passed
  several review rounds and a green suite.

## Rejected

- **In-process children (`createAgentSession`).** Measured feasible (`dist/core/sdk.d.ts:107`), and
  it would buy a structured channel with no prompt compliance at all. Rejected as
  disproportionate: it drops the subprocess isolation that ADR-0005's boundary and the whole
  background-task registry depend on, and `PI_PTC_DEPTH` / `PI_PTC_TASK_ID` would need rebuilding.
- **A persistent child process / follow-up turns.** Same isolation bookkeeping, much larger change.
- **A retry loop on non-compliance.** Doubles the cost of the failure and can loop. Explicit
  degradation instead.
- **Per-agent report schemas.** Reopens the two-copies problem for flexibility nobody has asked for.
- **Replacing the prose with the structured value.** Discards the only place a child can say _why_
  it concluded what it did.

## See also

- ADR-0016 — the `pi.dispatch` binding this returns into.
- ADR-0022 — background dispatch, whose report parity lands separately.
- ADR-0025 — the `subagents` surface that has no `codemode` and therefore no reader for
  `structuredContent`.
- ADR-0028 — `structured result`, a **different** term. See the glossary entry for `child report`.
