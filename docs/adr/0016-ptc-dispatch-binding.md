# PTC dispatch binding: PTC programs may explicitly fan out to per-call pi sessions

A PTC program is a single-threaded JS program; a Promise.all over tools.X(...) calls already exercises pi's parallel tool execution (preflighted sequentially, executed concurrently). What the program cannot do today is give each call its own session boundary, which is the unit pi (and DSH, and mcode, and codex, and Reasonix) use for isolation, lineage, and persistence.

Status: accepted (2026-09-23). Behavior change on the program-visible side (a new binding, pi.dispatch(...), returning a structured DispatchResult); no protocol, dispatcher-contract or worker-visible change.

Amendment (same day): Decision §2 initially described the cap as a rename of the existing `maxParallelSubCalls` knob. The implementation keeps two independent caps instead — `dispatchConcurrency` for `pi.dispatch`, `maxParallelSubCalls` for ordinary binding fan-out — and §2/§3 below are corrected to say so.

Amendment (2026-09-30, review round 4): **the cap is one counter per pi session, and it serves both dispatch fronts.** §2 below originally read "the cap is per-run … the 9th concurrent `pi.dispatch` from one run". That was true while the acquire lived at the dispatcher's own call site, and it stopped being true when the acquire moved into `dispatch()` so that `ptc_subagent` — which calls `dispatch()` directly, bypassing the dispatcher — is gated too. Every front now draws on the same `DispatchSlotCounter`: both programs running in a session, every `ptc_subagent` call, and every background child. The number is still `PtcConfig.dispatchConcurrency` (default 8), the refusal shape is unchanged, and the depth cap is untouched; what changed is **whose** calls the cap counts.

Amendment (2026-10-12, [ADR-0039](./0039-an-omitted-agent-dispatches-a-generalist.md)): **`agent` is no longer required.** §Decision 1 below listed it without a `?`, and this record never said why — it read as a safety property and was not one. The child is spawned with `--append-system-prompt`, which appends to pi's own system prompt rather than replacing it, and `--tools` is passed only when a definition declares `tools:`; a definition can therefore only ever NARROW the child, so requiring a name asked every caller to name a narrowing that does not exist. Omitting `agent` now dispatches a generalist child; a name that was _given_ and is unusable is still refused. Every other section of this record stands unchanged. The reasoning, the preset plan this rejects, and the measurement behind the roster are in ADR-0039.

> **Amended by [ADR-0044](./0044-a-dispatch-inherits-the-session-model.md) (2026-10-19): the child's model resolves through the caller's session, and the result reports the model it actually ran.** §Decision 1's result fields gain optional `observedProvider` / `observedModel` (renamed by [ADR-0045](./0045-observed-model-field-names.md)); the `model` resolution order gains one tier between the agent definition and pi's default — the calling session's current model, read structurally from pi's tool-execution context, so a dispatch that names no model now passes `--model <provider>/<id>`; §Decision 3's rejected-child sentence is corrected (the child's own reported error is the result's `errorMessage`, and `stderr` was never guaranteed); and the new section [The child's model](#the-childs-model) states the precedence. Everything else — the binding surface, the concurrency cap, the depth cap and the untrusted-input boundary — stands unchanged. Where this record and ADR-0044 read differently, ADR-0044 governs. **Amended further by [ADR-0045](./0045-observed-model-field-names.md) (2026-10-19): the result/record observed-model fields are named `observedProvider` / `observedModel`, and a legacy persisted record is normalized on read.**

Measured before vs after, 24 concurrent foreground calls against a real fake-`pi` spawn:

| scenario                                                    | before                              | after                                          |
| ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| (a) one program, 24 concurrent foreground                   | 8 spawned / 16 capped               | 8 / 16 — unchanged                             |
| (b) two concurrent programs, 24 each                        | 8 + 8 = 16                          | 8 total                                        |
| (c) 8 live background children + one program, 24 foreground | 8 foreground spawned (16 in flight) | 0 foreground spawned (8 total, all background) |

Row (a) is the only case that did not move, which is why the defect survived three review rounds. Row (c) is not a rounding difference: a program sharing a session with eight live background children can be refused **every** foreground slot. Because the refusal is a hard reject with no queue, nothing waits for a slot to come back — a background task that runs for twenty minutes holds its slot for those twenty minutes.

## What we add

1. A new binding, pi.dispatch({...}), exposed alongside tools.<name>(args) in every PTC worker. Its return type is a structured object (see Decision section 4) so a PTC program can branch on status, aggregate usage, and compose with the Promise.allSettled combinator.
2. A dispatch concurrency cap, configurable, default 8 (matches examples/extensions/subagent/index.ts MAX_PARALLEL_TASKS = 8). The cap is **one counter per pi session**, serving the foreground and background fronts alike (round-4 amendment above), and it is enforced inside `dispatch()` so that every front passes through it. Qualifier, because the round-5 measurement found the unqualified form is not universally true: a caller that supplies no session counter (a library caller, or `runPtcProgram` driven directly) falls back to the per-run counter the dispatcher owns, and that fallback is the configured `dispatchConcurrency` -- measured, `dispatchConcurrency: 4` admits exactly 4. "One counter" describes a pi session, which is where the shipped wiring lives, and ADR-0022 §9 carries the same qualifier. A call over the cap — the 9th in flight, from any combination of programs, `ptc_subagent` calls and live background children — resolves as { status: rejected, errorMessage: dispatch concurrency limit reached } instead of being queued or spawned.
3. Default binding config -- BUILTIN_BINDING_NAMES already exists (read, bash, edit, write, grep, find, ls); the dispatch binding is _added_ to the default, not used to replace it. Users can still pass an explicit subset (R3's read-only PTC surface pattern).
4. Persistent-on-the-wire, ephemeral-on-disk -- each pi.dispatch invocation spawns a fresh pi subprocess with --mode json -p --no-session --append-system-prompt <tmpfile> (the same flags the examples/extensions/subagent/index.ts reference uses). The child's transcript is NOT written to ~/.pi/agent/sessions/, so dispatch leaves no state behind; the parent's PTC program receives only the structured DispatchResult and any image blocks the child emitted (DSH parity, ADR-0014).

## What we deliberately don't add

1. No per-call gate on tool bindings -- once a tool is in the binding table, the model can call it whenever it wants. The default binding config is a _policy_ set at run start, not a _filter_ at every turn. The user changes the policy by editing BINDING_NAMES (current behaviour); the model's per-turn choice of whether to call is its own.
2. No reliance on pi's subagent extension being installed -- pi-ptc's pi.dispatch is implemented inside this package (a child_process.spawn mirroring the examples/extensions/subagent/index.ts reference), so the binding works whether or not the user has installed subagent. The two paths are _behaviour-compatible_, not _cooperative_.
3. No new task / session state machine -- pi.dispatch is a _binding_, not a tool with model-visible lifecycle (task / task_append / task_query / task_output / task_stop a la mcode, collab_spawn_agent / collab_close_agent a la codex). PTC programs that want to track multiple in-flight dispatches use the Promise.allSettled combinator on their own; the model has no dispatch_status to ask. This is consistent with PTC's standing design -- bindings are untrusted program input (ADR-0005 section 2).
4. No subagent terminology -- the word _subagent_ is overloaded (CONTEXT.md section Out-of-glossary, DSH's subagent with capability flags, pi's examples/extensions/subagent/ extension). This effort uses _parallel binding_, _concurrent tool call_, and pi.dispatch. CONTEXT.md is updated to enforce the rename.

## Decision

1. New binding name and shape. Add pi.dispatch to the binding table, with input fields { agent, task, cwd?, agentScope?, model?, thinkingLevel? } and result fields { text, status, agentName, durationMs, exitCode, usage?, stderr?, errorMessage? } (see CONTEXT.md for canonical terms). **Amended 2026-10-12: the field list is `{ task, agent?, cwd?, agentScope?, model?, thinkingLevel? }` — see the header.** **Amended 2026-10-19 by [ADR-0044](./0044-a-dispatch-inherits-the-session-model.md): the result fields gain optional `observedProvider` / `observedModel` (ADR-0045), the model the child actually ran (observed by the host from its assistant turns, not the model that was requested); and the input's `model` resolution gains the caller-session tier described in [The child's model](#the-childs-model).**

2. Concurrency cap. Default dispatchConcurrency = 8, exposed via PtcConfig.dispatchConcurrency and enforced inside `dispatch()`, which is the single owner of the rule for every front. The cap is **hard** (reject, never queue) and — since the 2026-09-30 round-4 amendment — **session-scoped, not per-run**: one `DispatchSlotCounter` per pi session, shared by concurrent programs, by `ptc_subagent`, and by background children that hold a slot for their whole lifetime. In a session that is the whole story; a deps-less caller falls back to the per-run counter (ADR-0022 §9, and `src/runtime/dispatcher.ts:447` in the round-5 correction). Rationale for a cap at all: dispatch spawns a fresh pi subprocess; allowing unbounded concurrent subprocesses would let a runaway program exhaust the host's process table. The rationale for making it _one_ counter rather than two is separate and is recorded where the change was made (the round-3 review ledger, finding R3-1): one cap with one owner cannot disagree with itself about how many children a session is running, and the knob that sizes it is therefore live. The acceptance of that trade is the amendment's own statement, and its cost is the two rows of the measured table above that moved. The cap remains independent of the existing maxParallelSubCalls knob (ADR-0004), which continues to govern ordinary binding fan-out with its queueing semantics; the two use separate counters, so in-flight ordinary calls never consume dispatch slots.

3. Promise semantics for pi.dispatch. Each pi.dispatch call resolves to a DispatchResult whose status field is fulfilled or rejected. The binding never throws: a rejected child subprocess yields a DispatchResult with status rejected, exitCode set, and `errorMessage` populated when there is a diagnostic; `usage` and the observed-model fields are possibly absent. **`stderr` is best-effort, not promised (amended 2026-10-19, [ADR-0044](./0044-a-dispatch-inherits-the-session-model.md)):** a pi child can report a model error on its JSONL stream and exit 0, so the structured failure channel is `errorMessage` — the child's own reported error, stated verbatim when there is one, ahead of the exit-code and truncation inference — and the absence of `stderr` says nothing about how the child failed. This is the same shape as the Promise.allSettled combinator's settled records, so PTC programs compose naturally: a Promise.all over pi.dispatch calls yields the same shape, no try/catch required.

The program's _ordinary_ binding calls (e.g. tools.read, tools.grep) keep their existing semantics: a Promise.all over tools.X calls invokes pi's parallel tool execution (preflight sequentially, execute concurrently, each tool's result delivered independently). The dispatcher already enforces maxPendingCalls (ADR-0004) and maxParallelSubCalls; no change to that path.

4. Cancellation. When the PTC run's signal fires (deadline, abort), every in-flight pi.dispatch subprocess receives SIGTERM, then SIGKILL after a 5-second grace window (mirroring examples/extensions/subagent/index.ts runSingleAgent's signal handling). The dispatch binding's Promise resolves with { status: rejected, errorMessage: dispatch cancelled } after the kill; the surrounding Promise.all / Promise.allSettled is not invalidated.

5. Tool-result binding for the parent model. The host view of a PTC run that called pi.dispatch returns the usual PtcRunOutcome (logs / narrations / phases / value / images). The program's return value flows through unchanged. The images array hoists any image blocks the dispatch binding surfaced from the child subprocess, per ADR-0014.

## The child's model

Added 2026-10-19 by [ADR-0044](./0044-a-dispatch-inherits-the-session-model.md), which is the decision record; this section is the contract.

The child is a fresh `pi` subprocess, so it resolves its own model. First match wins:

1. the dispatch's `model` argument;
2. the named agent definition's frontmatter `model:`;
3. the **calling session's current model**, read from pi's tool-execution context for the turn that
   issues the dispatch;
4. pi's configured default — no `--model` flag is passed at all.

Tiers 1 and 2 are the dispatch's own; tiers 3 and 4 are the ambient resolution. A tier that resolves produces one `--model <provider>/<id>` argument. The session read is structural and defensive: a context without a usable model (an older pi, a direct library caller, a session started without one) skips tier 3 and falls through to tier 4, so the declared 0.86.0 floor gains no compile-time dependency on the field. Resolution happens at spawn: a model switched after the spawn does not change a running child, and a nested dispatch inherits the child's own session model rather than the originating session's.

The dispatch reports the model the child actually ran, observed from its assistant turns (last turn wins): `DispatchResult.observedProvider?` / `DispatchResult.observedModel?` on the foreground result, `TaskRecord.observedProvider?` / `TaskRecord.observedModel?` on the background record (named by [ADR-0045](./0045-observed-model-field-names.md)). Either may be absent when the transcript named only the other half; the absence of both means no observed assistant turn named the pair — not that the model is unknown, and not a claim that the child ran on another model. The model-facing surfaces state the same observation as a `model: provider/id` line on `ptc_subagent` and `ptc_task_output`, and as a `model=` fact in a refusal diagnostic.

## Boundary with the existing tool-call pipeline

ADR-0005 section 2 records that pi-ptc bindings call execute() directly and do not flow through pi.on(tool_call). pi.dispatch inherits that boundary: extension hooks like permission-gate.ts and protected-paths.ts do not see dispatch calls. ADR-0005's inherited risk applies a fortiori -- pi.dispatch can spawn any agent the dispatcher session's user is willing to run, with whatever tools the agent's markdown declares. This ADR does not change the boundary; it restates it for the new binding.

## What becomes of the deferred G1 #13 agent() helper

CONTEXT.md says G1 #13 decision B deferred the agent() helper (DSH's PTC-mode agent() global) to a future map. This ADR does not implement agent(). The helper, if added later, would be a thin wrapper over pi.dispatch, exposed as a worker-side global rather than a binding. Today's pi.dispatch is the lower-layer mechanism; the future helper, if any, would be a syntactic convenience on top.

## Implementation outline (deferred to a follow-up commit)

- Add src/runtime/dispatch.ts: spawn helper, JSON-line parser, usage accumulator, DispatchInput / DispatchResult types. Pure of pi-extension awareness; reads agent markdown from the standard pi locations (getAgentDir() + ~/.pi/agent/agents/, optionally .pi/agents/ per agentScope).
- Extend src/runtime/bindings.ts: register pi.dispatch next to the builtin tool factories. The "per-run instantiation granularity" this line originally claimed stopped being true at the round-4 cap move -- a session supplies one counter that outlives any run -- and stopped being arguable at the round-5 seam, which made the foreground branch's lifecycle injectable at all. The binding is still per-run; the cap and the lifecycle seam are not.
- Extend src/runtime/limits.ts: dispatchConcurrency in PtcConfig (default 8), per ADR-0004-style validation.
- Extend src/runtime/dispatcher.ts: dispatch slot acquisition is already in place; thread the spawn lifecycle into the existing cancel / deadline paths.
- Tests: unit-test dispatch.ts (process mock); integration-test the binding through runPtcProgram with a small agent script.
- Update CONTEXT.md glossary to add parallel binding, concurrent tool call, pi.dispatch, DispatchResult, dispatch concurrency; remove the BINDING_NAMES whitelist (not yet built for this effort) line.

## Recursive dispatch (depth-bounded PTC)

A second pass (2026-09-23 grill) added a question this ADR did not initially answer: when the dispatched child pi subprocess is started with the standard flags --mode json -p --no-session --append-system-prompt <tmpfile>, does it see pi-ptc? The answer is yes, by accident of pi's settings.json model: the child loads settings.json normally, so pi-ptc is registered as an extension in the child exactly as in the parent. The child can therefore write PTC programs of its own, and pi.dispatch inside them spawns further children.

The first pass left this as an unstated hole. The decision is to make it explicit, configurable, and bounded.

**Depth.** Each PTC run carries a depth (0 for the parent turn's run, 1 for a child spawned by pi.dispatch, and so on). The depth is threaded through DispatchContext into the dispatch binding; the binding computes childDepth = currentRunDepth + 1 and rejects when childDepth > maxDispatchDepth. The default maxDispatchDepth is 3, exposed as PtcConfig.maxDispatchDepth. A grand-child PTC run at depth 2 is a separate pi process, so it carries its own session and therefore its own dispatch concurrency counter; it can itself call pi.dispatch up to depth 3.

**Hint.** The dispatched child's system prompt is the agent's own markdown body, unchanged. pi-ptc appends a hint block to that system prompt at spawn time, so the child agent can see how much room it has to recurse:

  <pi-ptc-context depth="N" max-depth="M">
  You are a PTC run at depth N (root is depth 0). You may write PTC programs and you may
  call pi.dispatch(...) to spawn further children, but each level costs a fresh pi
  subprocess. The remaining depth budget is M - N. Beyond it, pi.dispatch rejects with
  { status: "rejected", errorMessage: "dispatch depth limit reached" }.
  </pi-ptc-context>

The shape mirrors DSH's existing subagent-context injection (@deepseek-ai/dsh-tools) so the general pattern is one the field already recognises; the only difference is the depth / max-depth attributes, which are pi-ptc-specific.

**The block carries a second thing as of 2026-10-12** (ADR-0039 §Decision 4, issue #186): what the child IS — that it was dispatched, that it cannot see the dispatching session, and that its final message is the deliverable. Same tag, same append site. The code above is this record's own subject rather than a live excerpt of the block; for a child with no agent definition the block is the whole of what the prompt file adds.

**Why not forbid it.** Disallowing the child from writing PTC programs would close off the natural multi-level pattern (orchestrator PTC -> scout agent PTC -> sub-scout PTC) and would also force pi-ptc to inject counter-prompts (do not write PTC programs) that the field at large does not write. The chosen design lets the child do whatever its agent markdown tells it to do, while making recursion observable (the hint) and bounded (the cap).

**Why not unbounded recursion.** Each level pays its own context window and its own dispatch concurrency slot. Allowing unbounded recursion lets a runaway model write while (true) pi.dispatch({...}) and exhaust the host's process table. The cap is the only thing that prevents that.

## What becomes of the agent_max_depth contract

Codex's agent_max_depth (codex-rs/core/src/agent.rs) and dsh's SubagentCapabilities.depthLimit are the prior art this section aligns with. pi-ptc ships with a smaller default (3 instead of dsh's larger cap) because pi-ptc's recursion is implicit: there is no agent-level manifest that names the depth in advance, so a tighter default is the safer starting point. Users raise the cap by editing PtcConfig.maxDispatchDepth.
