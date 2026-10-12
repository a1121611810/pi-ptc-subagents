# An omitted `agent` dispatches a generalist child, and the package ships no preset

status: accepted (2026-10-12)

## Context

ADR-0016 §Decision 1 gave `pi.dispatch` the input fields
`{ agent, task, cwd?, agentScope?, model?, thinkingLevel? }`. `agent` and `task` are the two without
a `?`, and ADR-0025 restated that shape when it put the same arguments behind the top-level
`ptc_subagent` tool. Neither record says _why_ a name is required. The requirement reads as a safety
property. It is not one.

Three facts, each checkable in the code, leave the requirement with a cost and nothing on the other
side of it:

1. **The child is spawned with `--append-system-prompt`.** The dispatch prompt is _appended_ to pi's
   own system prompt, never substituted for it. A child running with no definition is still a full pi.
2. **`--tools` is passed only when a definition declares `tools:`.** No declaration means no flag,
   which means pi's entire toolset stands.
3. Therefore **a definition can only ever narrow the child.** There is no capability it can add that
   the child did not already have.

So a required `agent` asked every caller to name a narrowing that does not exist. On a fresh install
the consequence was concrete: both fronts refused with _"agent is required (there is no default
agent)"_, and the first useful dispatch sat behind learning the agent-markdown format, choosing a
scope, and writing a file.

The cost of that gate is not hypothetical. Measured 2026-10-12: a session whose model wanted to fan
out spent twenty-plus tool calls inspecting the install and guessing at argument values before
abandoning the idea. The registry listing that would have answered it existed only inside a refusal,
and a refusal is reachable only by already knowing a name.

### The preset plan this record rejects

The first attempt to soften that friction was to ship a preset agent **inside the npm package** —
one definition, reached by a third lookup path below user and project scope, copied into `dist/` at
build time. It was specced and its definition written before anyone asked whether the argument
should be required at all.

The shape chosen for it is what exposed the error: a **read-only researcher**. That is a narrowing,
offered as the default answer to "what does dispatching give me?". Even a flawless version of it
would have taught every user that dispatch is for handing research to something that cannot act on
what it finds.

Separately, the roster work established that a definition's `description` had **no production readout
at all** — `listRegisteredAgents` returned `string[]` and the model could only learn a name existed by
guessing wrong. That is fixed and independent of this decision. What this record settles is that the
thing being described should not have been a preset.

## Decision

**An omitted `agent` dispatches a generalist child, and no preset agent ships.**

1. **`agent` is optional.** Absent, the dispatch resolves a generalist: pi's own system prompt, pi's
   own full toolset, no model pin, no narrowing of any kind. It is not a special code path — the
   generalist is an ordinary agent config with an empty name and prompt and no declared tools,
   resolved by the same helper both fronts already share, so the two cannot disagree about what an
   omission means.

2. **Absent and malformed are different inputs.** A name that was _given_ and is empty,
   whitespace-only, or not a string is still refused, and the refusal names both ways out: a
   registered name, or omitting the argument. Collapsing the two would let a caller's typo silently
   dispatch something it never asked for, which is the silent-failure class the original guard was
   written against (field report pitfall #2, 2026-09-29).

3. **No agent definitions ship in the package.** The third lookup path, the generated `dist/agents/`
   directory and the `files`-whitelist work all go away with the plan. Definitions remain a user- and
   project-scope escape hatch, reached when a caller wants to narrow — and only then.

4. **Every child is told what it is.** That it was dispatched, that it cannot see the dispatching
   session, and that its output is the deliverable. Appended for named definitions too, so a
   definition does not have to restate what the dispatch already knows.

   **This decision is carried by issue #186.** What ships today is the existing PTC context block:
   depth, remaining budget, and the report clause. That block already tells the child it is a
   dispatched run, but neither of the other two clauses is in it — so stating all three here as
   though they were is the same over-claim Decision 5 carried, a record describing work a different
   ticket owns. A generalist needs those two sentences more than a named child did: a definition's
   own body used to be where a child learned what it was, and with no definition there is nothing
   else to say it.

5. **The startup availability warning goes.** It reported that no agent was registered, and
   therefore that `ptc_subagent` had nothing to dispatch. That was true only while a name was
   required; an empty registry is now the normal state of a fresh install, and a notice that fires
   on the normal state is the noise that teaches people to stop reading notices.

   It went with issue #187, which was blocked on this change and landed with it. The `ptc-mode`
   status marker that mirrored the notice for the rest of the session went too — same subject,
   same reason. The interval between the two tickets is on the record rather than hidden: while it
   was open, a fresh install was told the tool "has nothing to dispatch" at a moment when the tool
   dispatched fine.

## What this amends

- **ADR-0016 §Decision 1** — the input shape becomes
  `{ task, agent?, cwd?, agentScope?, model?, thinkingLevel? }`. Nothing else in that record moves:
  the concurrency cap, the never-throws contract, the cancellation ladder and the depth bound are
  untouched.
- **ADR-0025** — it restates the required-field list; that restatement is superseded for `agent`.

Both records keep their text. This one carries the reversal, by the rule that kept ADR-0025's own
reasoning intact when ADR-0034 withdrew it. **Where ADR-0016 or ADR-0025 and this record read
differently about `agent`, this one governs** — that is the only field either record is amended on.

## Consequences

- **A fresh install can dispatch immediately.** `ptc_subagent({ task })` and
  `tools["pi.dispatch"]({ task })` are complete calls.
- **`agentScope` is inert without a name** — it selects directories to search, and there is nothing
  to search for. It keeps its meaning for a named dispatch, including its `"user"` default.
- **The result reports an empty `agentName`** when no definition resolved, rather than inventing a
  synthetic name that no file answers to. The background path's task record says the same.
- **Existing definitions are unaffected.** Tool restriction, model pins, appended role text and the
  child-report opt-out all behave as before, and a definition that declares `tools:` still narrows
  its child.
- **The generalist has no report opt-out.** With no definition there is no `childReport: false` to
  read, so the child-report contract is on, and because pi's full toolset stays in place the report
  tool is registered in the child — the registration is depth-gated (`src/index.ts:505`,
  `createChildReportTool(ptcDepth > 0)`), and a dispatched child always runs above depth zero.
  Measured on a real dispatch with the argument omitted: `report_channel: "tool"`, with the child
  filing a summary and findings. Same channels as any other dispatch; only the opt-out is
  unavailable.

## Rejected alternatives

**Ship a preset generalist instead of nothing.** The child already _is_ a generalist; a file would
add a name to maintain, a third lookup path to order against the other two, and a package artifact to
keep in sync — all to make the default overridable by a same-named file. Omitting the argument is the
better override, because there is nothing to name.

**Treat an empty string or whitespace as an omission.** Friendlier on paper, and it deletes the only
signal a malformed call produces. The wire can deliver anything; a caller that sends `""` by accident
should hear about it rather than receive a child it did not describe.

**Keep the availability warning and reword it.** It would then say, at every startup, on the normal
state of a fresh install, that no custom agents exist. There is no longer a failure for it to report.

## Evidence

The roster's effect on model behaviour was measured before being trusted — real pi, real provider,
one variable: 4 dispatches against 0, with the model splitting 38 documents into four parallel
batches unprompted and passing `agentScope` explicitly. The prototype and its verdict live on the
throwaway branch `prototype/routing-check`. Its relevance here is the negative half: a build whose
tool description carried no roster produced zero dispatches, which is what a preset the model cannot
see would have amounted to.
