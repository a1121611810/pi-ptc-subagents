# PTC dispatch binding: PTC programs may explicitly fan out to per-call pi sessions

A PTC program is a single-threaded JS program; a Promise.all over tools.X(...) calls already exercises pi's parallel tool execution (preflighted sequentially, executed concurrently). What the program cannot do today is give each call its own session boundary, which is the unit pi (and DSH, and mcode, and codex, and Reasonix) use for isolation, lineage, and persistence.

Status: accepted (2026-09-23). Behavior change on the program-visible side (a new binding, pi.dispatch(...), returning a structured DispatchResult); no protocol, dispatcher-contract or worker-visible change.

## What we add

1. A new binding, pi.dispatch({...}), exposed alongside tools.<name>(args) in every PTC worker. Its return type is a structured object (see Decision section 4) so a PTC program can branch on status, aggregate usage, and compose with the Promise.allSettled combinator.
2. A per-run dispatch concurrency cap, configurable, default 8 (matches examples/extensions/subagent/index.ts MAX_PARALLEL_TASKS = 8). The cap is enforced at the dispatcher: the 9th concurrent pi.dispatch from one run resolves as { status: rejected, errorMessage: dispatch concurrency limit reached } instead of being queued or spawned.
3. Default binding config -- BUILTIN_BINDING_NAMES already exists (read, bash, edit, write, grep, find, ls); the dispatch binding is _added_ to the default, not used to replace it. Users can still pass an explicit subset (R3's read-only PTC surface pattern).
4. Persistent-on-the-wire, ephemeral-on-disk -- each pi.dispatch invocation spawns a fresh pi subprocess with --mode json -p --no-session --append-system-prompt <tmpfile> (the same flags the examples/extensions/subagent/index.ts reference uses). The child's transcript is NOT written to ~/.pi/agent/sessions/, so dispatch leaves no state behind; the parent's PTC program receives only the structured DispatchResult and any image blocks the child emitted (DSH parity, ADR-0014).

## What we deliberately don't add

1. No per-call gate on tool bindings -- once a tool is in the binding table, the model can call it whenever it wants. The default binding config is a _policy_ set at run start, not a _filter_ at every turn. The user changes the policy by editing BINDING_NAMES (current behaviour); the model's per-turn choice of whether to call is its own.
2. No reliance on pi's subagent extension being installed -- pi-ptc's pi.dispatch is implemented inside this package (a child_process.spawn mirroring the examples/extensions/subagent/index.ts reference), so the binding works whether or not the user has installed subagent. The two paths are _behaviour-compatible_, not _cooperative_.
3. No new task / session state machine -- pi.dispatch is a _binding_, not a tool with model-visible lifecycle (task / task_append / task_query / task_output / task_stop a la mcode, collab_spawn_agent / collab_close_agent a la codex). PTC programs that want to track multiple in-flight dispatches use the Promise.allSettled combinator on their own; the model has no dispatch_status to ask. This is consistent with PTC's standing design -- bindings are untrusted program input (ADR-0005 section 2).
4. No subagent terminology -- the word _subagent_ is overloaded (CONTEXT.md section Out-of-glossary, DSH's subagent with capability flags, pi's examples/extensions/subagent/ extension). This effort uses _parallel binding_, _concurrent tool call_, and pi.dispatch. CONTEXT.md is updated to enforce the rename.

## Decision

1. New binding name and shape. Add pi.dispatch to the binding table, with input fields { agent, task, cwd?, agentScope?, model?, thinkingLevel? } and result fields { text, status, agentName, durationMs, exitCode, usage?, stderr?, errorMessage? } (see CONTEXT.md for canonical terms).

2. Concurrency cap. Default dispatchConcurrency = 8, exposed via PtcConfig.dispatchConcurrency and capped at the existing dispatcher.acquireDispatchSlot site (config.maxParallelSubCalls in the current code base). The cap is per-run, hard, not per-turn. Rationale: dispatch spawns a fresh pi subprocess; allowing unbounded concurrent subprocesses from one PTC run would let a runaway program exhaust the host's process table. The cap is shared with the existing maxParallelSubCalls knob, which is renamed in the implementation; the _behaviour_ is hard cap on concurrent in-flight dispatch calls from one PTC run, which today is the only kind of dispatch.

3. Promise semantics for pi.dispatch. Each pi.dispatch call resolves to a DispatchResult whose status field is fulfilled or rejected. The binding never throws: a rejected child subprocess yields a DispatchResult with status rejected, exitCode set, stderr and errorMessage populated, and usage possibly absent. This is the same shape as the Promise.allSettled combinator's settled records, so PTC programs compose naturally: a Promise.all over pi.dispatch calls yields the same shape, no try/catch required.

The program's _ordinary_ binding calls (e.g. tools.read, tools.grep) keep their existing semantics: a Promise.all over tools.X calls invokes pi's parallel tool execution (preflight sequentially, execute concurrently, each tool's result delivered independently). The dispatcher already enforces maxPendingCalls (ADR-0004) and maxParallelSubCalls (the rename target); no change to that path.

4. Cancellation. When the PTC run's signal fires (deadline, abort), every in-flight pi.dispatch subprocess receives SIGTERM, then SIGKILL after a 5-second grace window (mirroring examples/extensions/subagent/index.ts runSingleAgent's signal handling). The dispatch binding's Promise resolves with { status: rejected, errorMessage: dispatch cancelled } after the kill; the surrounding Promise.all / Promise.allSettled is not invalidated.

5. Tool-result binding for the parent model. The host view of a PTC run that called pi.dispatch returns the usual PtcRunOutcome (logs / narrations / phases / value / images). The program's return value flows through unchanged. The images array hoists any image blocks the dispatch binding surfaced from the child subprocess, per ADR-0014.

## Boundary with the existing tool-call pipeline

ADR-0005 section 2 records that pi-ptc bindings call execute() directly and do not flow through pi.on(tool_call). pi.dispatch inherits that boundary: extension hooks like permission-gate.ts and protected-paths.ts do not see dispatch calls. ADR-0005's inherited risk applies a fortiori -- pi.dispatch can spawn any agent the dispatcher session's user is willing to run, with whatever tools the agent's markdown declares. This ADR does not change the boundary; it restates it for the new binding.

## What becomes of the deferred G1 #13 agent() helper

CONTEXT.md says G1 #13 decision B deferred the agent() helper (DSH's PTC-mode agent() global) to a future map. This ADR does not implement agent(). The helper, if added later, would be a thin wrapper over pi.dispatch, exposed as a worker-side global rather than a binding. Today's pi.dispatch is the lower-layer mechanism; the future helper, if any, would be a syntactic convenience on top.

## Implementation outline (deferred to a follow-up commit)

- Add src/runtime/dispatch.ts: spawn helper, JSON-line parser, usage accumulator, DispatchInput / DispatchResult types. Pure of pi-extension awareness; reads agent markdown from the standard pi locations (getAgentDir() + ~/.pi/agent/agents/, optionally .pi/agents/ per agentScope).
- Extend src/runtime/bindings.ts: register pi.dispatch next to the builtin tool factories, with the same per-run instantiation granularity.
- Extend src/runtime/limits.ts: dispatchConcurrency in PtcConfig (default 8), per ADR-0004-style validation.
- Extend src/runtime/dispatcher.ts: dispatch slot acquisition is already in place; thread the spawn lifecycle into the existing cancel / deadline paths.
- Tests: unit-test dispatch.ts (process mock); integration-test the binding through runPtcProgram with a small agent script.
- Update CONTEXT.md glossary to add parallel binding, concurrent tool call, pi.dispatch, DispatchResult, dispatch concurrency; remove the BINDING_NAMES whitelist (not yet built for this effort) line.

## Recursive dispatch (depth-bounded PTC)

A second pass (2026-09-23 grill) added a question this ADR did not initially answer: when the dispatched child pi subprocess is started with the standard flags --mode json -p --no-session --append-system-prompt <tmpfile>, does it see pi-ptc? The answer is yes, by accident of pi's settings.json model: the child loads settings.json normally, so pi-ptc is registered as an extension in the child exactly as in the parent. The child can therefore write PTC programs of its own, and pi.dispatch inside them spawns further children.

The first pass left this as an unstated hole. The decision is to make it explicit, configurable, and bounded.

**Depth.** Each PTC run carries a depth (0 for the parent turn's run, 1 for a child spawned by pi.dispatch, and so on). The depth is threaded through DispatchContext into the dispatch binding; the binding computes childDepth = currentRunDepth + 1 and rejects when childDepth > maxDispatchDepth. The default maxDispatchDepth is 3, exposed as PtcConfig.maxDispatchDepth. A grand-child PTC run at depth 2 has its own dispatch concurrency cap and can itself call pi.dispatch up to depth 3.

**Hint.** The dispatched child's system prompt is the agent's own markdown body, unchanged. pi-ptc appends a hint block to that system prompt at spawn time, so the child agent can see how much room it has to recurse:

  <pi-ptc-context depth="N" max-depth="M">
  You are a PTC run at depth N (root is depth 0). You may write PTC programs and you may
  call pi.dispatch(...) to spawn further children, but each level costs a fresh pi
  subprocess. The remaining depth budget is M - N. Beyond it, pi.dispatch rejects with
  { status: "rejected", errorMessage: "dispatch depth limit reached" }.
  </pi-ptc-context>

The shape mirrors DSH's existing subagent-context injection (@deepseek-ai/dsh-tools) so the general pattern is one the field already recognises; the only difference is the depth / max-depth attributes, which are pi-ptc-specific.

**Why not forbid it.** Disallowing the child from writing PTC programs would close off the natural multi-level pattern (orchestrator PTC -> scout agent PTC -> sub-scout PTC) and would also force pi-ptc to inject counter-prompts (do not write PTC programs) that the field at large does not write. The chosen design lets the child do whatever its agent markdown tells it to do, while making recursion observable (the hint) and bounded (the cap).

**Why not unbounded recursion.** Each level pays its own context window and its own dispatch concurrency slot. Allowing unbounded recursion lets a runaway model write while (true) pi.dispatch({...}) and exhaust the host's process table. The cap is the only thing that prevents that.

## What becomes of the agent_max_depth contract

Codex's agent_max_depth (codex-rs/core/src/agent.rs) and dsh's SubagentCapabilities.depthLimit are the prior art this section aligns with. pi-ptc ships with a smaller default (3 instead of dsh's larger cap) because pi-ptc's recursion is implicit: there is no agent-level manifest that names the depth in advance, so a tighter default is the safer starting point. Users raise the cap by editing PtcConfig.maxDispatchDepth.
