## Problem Statement

A session that starts a child agent today gets back **prose** — the last text part of the child's final assistant message (`src/runtime/dispatch.ts:980`, `assistantText`, whose own comment says "the last part wins"). Nothing structured crosses the boundary.

That is a problem for both kinds of caller, in different ways:

- **A PTC program** calling `tools["pi.dispatch"](...)` inside a `Promise.all` gets a `DispatchResult` whose only payload is a natural-language string. To use it, the program — or the model writing the program — has to parse prose. That is the least reliable link in the chain.
- **A model** using the `ptc_subagent` tool gets the same prose, and there is nowhere else for it to look. `ptc_subagent` already declares an `outputSchema` (`src/tools/subagent.ts:108`), but per ADR-0028 `structuredContent` is "never sent to the model" — and in `surface mode: subagents` there is no `codemode`, so that channel currently reaches **nobody at all**.

Two further losses ride along:

- `DispatchResult.usage` is accumulated from the child's `message_end` blocks (`src/runtime/dispatch.ts:1482`) and then never surfaced to the model, so neither caller can budget a child.
- The child cannot report which files it touched. That fact is only knowable by the child, and the host cannot reconstruct it.

A dispatched child today is a chat turn. It cannot be a result.

## Solution

Give a dispatched child a **child report**: a structured value the child produces and the host validates, carrying a summary, findings with independent evidence, files touched, and token usage. The host renders it into a fixed shape for a model, and hands it as a field for a program. Prose is preserved alongside it, not replaced.

The report arrives over one of two channels, and **both are implemented for real**:

1. **Tool channel (preferred).** A `ptc_report_result` tool with an `outputSchema`, registered by this extension and activated in the child. The host reads its `structuredContent` off the `tool_execution_end` event. This is the same mechanism the repo already depends on for `ptc_subagent` and `ptc_task_*`.
2. **Prompt channel (fallback).** The child's appended system prompt states the contract in one clause; the host parses a fenced JSON block from the final text. This channel carries the load whenever the tool channel is unavailable — which is a **real and reachable** condition, not a hypothetical: `src/index.ts:280` returns early when `surfaceMode === "off"`, and pi's `-ne` flag removes extensions entirely.

The contract is **on by default** and an individual agent opts out. When the contract was on and neither channel produced a report, the result says so explicitly. It never degrades silently to prose.

## User Stories

1. As a model writing a PTC program, I want `tools["pi.dispatch"](...)` to resolve to an object with a `report` field, so that I can branch on a child's findings without parsing English.
2. As a model writing a PTC program, I want a child's report to carry per-finding evidence, so that I can tell a conclusion from an assertion.
3. As a model writing a PTC program, I want a child's token usage on the result, so that I can decide whether to fan out further or stop.
4. As a model writing a PTC program, I want to know **which channel** a report arrived over, so that I can judge how much to trust it.
5. As a model writing a PTC program, I want a child that ignored the contract to still resolve as `fulfilled` with its prose intact, so that one disobedient child does not fail my whole fan-out.
6. As a model writing a PTC program, I want to know that a child ignored the contract, so that I do not mistake its prose for a report.
7. As a model using `ptc_subagent`, I want the child's report rendered as a fixed shape in the tool-result text, so that I see the same structure every time rather than whatever prose came back.
8. As a model using `ptc_subagent`, I want the child's own reasoning to survive alongside the rendered report, so that I can understand _why_ it concluded what it did.
9. As a model using `ptc_subagent`, I want to see the child's token cost in the rendered report, so that I can stop paying for children that are not earning their keep.
10. As a model using `ptc_subagent`, I want a missing report to be visibly marked in the text I read, so that I do not read an unmarked gap as an empty result.
11. As a model using `ptc_subagent`, I want to see which files a child touched, so that I know what to review.
12. As a user writing an agent markdown, I want the report contract on by default, so that my agents return structured results without me doing anything.
13. As a user writing an agent markdown, I want a documented way to opt out, so that an agent which genuinely answers in prose is not forced into a shape.
14. As a user writing an agent markdown, I want the contract stated in exactly one place, so that it cannot drift from what the tool actually accepts.
15. As a user, I want a child's report to survive the child process exiting, so that a background task's report is as inspectable as a foreground one.
16. As a user, I want a failed or refused dispatch to carry no report rather than an empty one, so that "no report" always means something.
17. As a user, I want the report shape to be stable across releases, so that a program written against it keeps working.
18. As a maintainer, I want the report channel to be observable in tests without spawning a real pi, so that the reliability claim is measured rather than assumed.
19. As a maintainer, I want a broken report channel to fail the build, so that a silently dead channel cannot ship.
20. As a maintainer, I want the glossary and an ADR to record what a child report is, so that the term does not get reused for something else.

## Implementation Decisions

### The report shape

A child report carries exactly four things, and the shape is fixed:

- `summary` — a one-line conclusion, in the child's own words.
- `findings` — a list; each has `what` (the claim) and `evidence` (the independent thing that supports it). Evidence is mandatory and may be empty **only** when the finding is explicitly a question rather than a claim.
- `files_touched` — paths the child believes it modified or created. Host-reconstructed paths are not a substitute: a child that edits through `bash` cannot be observed by the host.
- `usage` — input, output, cost, turns, lifted from the usage block the host already collects.

The host is lenient about extra keys the child invents and strict about missing required ones. Leniency in the middle is deliberate: a child that adds a field is doing something useful, and rejecting it would push authors toward the prompt channel, which is strictly worse.

### Two channels, both real

The tool channel is preferred because its payload is JSON produced by a declared schema rather than scraped from prose. The prompt channel exists because the tool channel has a **reachable** failure mode: this extension is not guaranteed to be loaded in the child. `surfaceMode: "off"` short-circuits registration, and pi's `-ne` removes extensions. A design that treats the fallback as decorative would be a design whose primary channel silently does not exist on a meaningful fraction of installs.

Every install that reaches the prompt channel must be **tested**, not assumed.

### How the parent learns which channel won

The result states it, always: `report` is present or absent, and a separate field names the channel (`tool`, `prompt-json`, or `none`). Making the channel field total rather than optional is what keeps the degradation explicit — under the repo's testing constraints, a silent fallback to prose is a defect, not a graceful default.

`none` is a real, reachable outcome: the contract is on and the child did not comply. It resolves `fulfilled` with the prose intact, because discarding a completed child's answer over a formatting failure is worse than reporting the answer as untrusted.

### How the child learns the contract

The tool's own description, snippet and guidelines **are** the contract. The appended system prompt adds exactly one clause requiring the child to call it before finishing. There is deliberately no second copy of the schema text maintained anywhere else — this repo has already been bitten twice by a shape existing in two places (`parseAgentMarkdown` versus pi's own frontmatter parser; tool descriptions versus the binding contract module). One source, rendered once.

### Activating the tool in the child

The host merges the report tool into the child's tool list when the contract is on. This merge is load-bearing and easy to get wrong in a way that fails silently: the argv builder only passes a tool-list flag when the agent declares tools of its own, so a child whose agent markdown declares none would otherwise receive **no** tool flag at all and the tool would stay inactive with no error. A dedicated test drives exactly that case.

### The opt-out

Agent frontmatter carries one switch, defaulting to on. Opting out is for an agent that genuinely answers in prose — a translator, say — not a way to avoid a failing feature. The switch names a yes/no; it does not carry a schema, because a per-agent schema reopens the two-copies problem and buys flexibility nobody has asked for.

### Rendering

The model-facing surface does not hand over raw JSON. The host renders the report into a fixed shape — summary, then findings, then files, then usage — following the existing value-tree rendering conventions in this repo. The child's own prose follows the rendered block, so the model sees the structured conclusion first and the reasoning second.

The program-facing surface gets the field, not the rendering. A program is not a display surface.

### Scope of the change

Both surfaces get the report. They are not equal in urgency and the order is deliberate: the **binding** is where a consumer is a program that cannot read prose, so it is the one that gets the field first; the **tool** is where a consumer is a model that already reads prose comfortably, and its gain is the rendered shape. Both are in scope for this spec.

In-process dispatch, a persistent child process, and follow-up turns to a live child are explicitly out of scope. A fact-finding pass established that pi 1.0.0 offers no structured-output flag at any layer and no terminal event carrying a result object, so the two channels above are the complete set of what is reachable without replacing the subprocess architecture.

## Testing Decisions

A good test here asserts **what a caller receives**, not how the extraction is implemented. The event-stream is an input; the resolved result is the observable.

**Seam 1 — child transcript in, result out (highest seam, primary).** Drive the real `dispatch()` with a recorded child transcript and assert the resolved result. This is the seam that would catch the failure that matters most: a report channel that is wired but never fires. Prior art: the mock child-process lifecycle tests in `tests/unit/dispatch-wiring.test.ts` and `tests/unit/ptc-subagent.test.ts`.

**Seam 2 — pure extraction over a literal transcript.** A pure reducer from parsed events to report state, driven by literal JSONL fixtures. Cheap to write many cases for, including the awkward ones: a fenced block with prose around it, a fenced block truncated mid-way, two fenced blocks where the second wins, a tool channel that fires and a prompt channel that also fires. Prior art: the pure-helper tests in `tests/dispatch-helpers.test.ts`.

**Seam 3 — the argv the child actually receives.** Assert the report tool reaches the child's tool list for an agent that declares no tools of its own. This is the silent no-op described above; it is the one test in the set that exists purely because the obvious implementation gets it wrong.

**Seam 4 — the declared tool.** Drive the report tool and assert the shape it returns validates against its declared schema, in both the well-formed and the malformed direction.

**Seam 5 — what the model reads.** Assert the rendered text contains the summary, every finding, the file list and the usage; and assert a missing report is visibly marked. Structural assertions, not golden files.

**Seam 6 — the release artifact.** The distribution gate pins the exact set of registered tools. Adding one breaks that pin by design; the gate must be updated as part of this work, not after it. This is a recorded past failure in this repo, where a feature passed several review rounds and a green suite while the release gate still asserted the old tool count.

**Counterfactual discipline.** For every channel, a version of the implementation that silently returns prose instead of failing must turn the suite red. A degradation path that no test can distinguish from success is not a degradation path.

**Failure paths are first-class.** Every channel has both a success and a failure case covered, and a failure produces an explicit state rather than an absence — per this repo's testing constraints, which forbid silent failure and require failure paths to carry a warning or an explicit status.

## Out of Scope

- Shipping default agents. A separate, larger gap: this package currently registers no agents at all, so the dispatch surface is unusable out of the box. Worth its own spec.
- In-process child agents, replacing the subprocess with a long-lived one, or multi-turn follow-up to a live child. All three were assessed and are disproportionate to the return-channel problem.
- Env or filesystem isolation for children. A real gap, a separate change.
- Per-agent report schemas.
- A retry loop when a child fails to comply. Rejected in favour of explicit degradation: a retry doubles the cost of the failure and can loop.

## Further Notes

Two facts from the investigation shaped this spec and are worth carrying forward:

- pi 1.0.0 has **no** structured-output facility for an assistant message at any layer — no CLI flag, no session option, no stream option. `constrainedSampling` constrains a tool call's arguments, never the assistant's reply. Any design that assumes otherwise will be waiting for an event that never fires.
- `structuredContent` on `ptc_subagent` is currently read by nobody in the subagent surface. That is a defect in its own right and this spec fixes it by routing the report into the text block as well.
