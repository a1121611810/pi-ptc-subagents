---

status: accepted (2026-09-30)

# The model-facing surface is a setting, not a fixed set

## Context

Pi 0.99.1 ships its own programmable tool calling: a built-in extension registering one tool,
`codemode`, evaluated in a fresh QuickJS sandbox. Measured against this package's
`ptc_run_code`, the two are **not** in a superset relation.

pi's side is stronger at the job `ptc_run_code` mostly does. The sandbox has no Node, no
file system, no network and no timers; `searchTools` / `describeTool` reach nested tools by
BM25 so a large tool set does not have to fit in one prompt; `store` / `load` persist
across calls; and `max_output_tokens` / `timeout_ms` are settable per script.

This package's side has the one capability `codemode` cannot have. A nested tool call there
resolves to "an object or a string, based on the description" -- the model is left to
infer, which is what a 31-crash field run measured before ADR-0024. And a QuickJS sandbox
with no file system, no network and no timers cannot spawn a process at all, so
`pi.dispatch` -- a real pi subprocess, with the six-state lifecycle behind `ptc_task_*` --
has no equivalent there and cannot be given one inside that runtime.

So the honest position is: pi's `codemode` can take over the orchestration this package
does today, and cannot take over the subagents. Which makes "install both" a real choice
rather than a redundancy -- and right now the package makes it badly. Measured with both
loaded, the session carries **two** model-facing orchestration tools and two system-prompt
sections , and the model has to
pick a programming model per request. The package also has no off switch: `ptc.json`'s
`{"defaultMode": false}` gates _entering PTC mode_, not _registering tools_, so five
tools and a briefing section are present no matter what the user asked for.

## What we add

A **surface mode**, read from the same agent-dir `ptc.json` the mode already reads,
deciding which model-facing tools this package registers. The glossary names it, its three
values, the _orchestration surface_ it chooses between, and the _subagent surface_ it keeps.

1. **`ptc_subagent`** -- a top-level tool the model calls directly to start a fresh pi
   subprocess, with no program in between. Its arguments are the real `DispatchInput`
   (`agent`, `task`, and the optional `cwd` / `agentScope` / `model` / `thinkingLevel` /
   `background` / `label`), because the schema has to match the binding it fronts, not an
   invented one. It reuses `dispatch()` unchanged, so `maxDispatchDepth`,
   `dispatchConcurrency` and the background registry all keep applying, and a spawned task
   is visible to `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` exactly as one spawned
   from a program is.
2. **The `surfaceMode` key** in `ptc.json`, beside `defaultMode`, read **once before
   registration** so the decision is available to the `registerTool` calls rather than
   arriving a turn later.
3. **Registration becomes conditional.** `off` registers nothing and injects no briefing;
   `subagents` registers `ptc_subagent` plus the lifecycle face; `full` -- today's set --
   stays the default, so installing an upgrade changes nobody's behaviour.

## What we deliberately don't add

1. **No in-session switching.** `pi.registerTool` has no counterpart, so a surface change
   needs a new session. A `/ptc surface` command that appears to work and does not would be
   worse than the config key, so it is a follow-up, not this change.
2. **No auto-exclusion of `codemode`.** It is a pi built-in the user may be using
   independently; a third-party package silently disabling a host built-in is not ours to
   do. `--exclude-tools codemode` remains the escape hatch, and the mode that needs it says
   so (see 4).
3. **No `pi.dispatch` from inside `codemode`.** Not a work item: the runtime has no
   filesystem and no network, so there is no honest implementation to write.
4. **No silent degradation.** In `subagents`, if `codemode` is not in the active tool set,
   the model would be left with a subagent tool and no way to compose anything. The
   extension warns on entry instead of quietly shipping that.

## Decision

1. Three values, `off` / `subagents` / `full`, default `full`.
2. The key is read before `registerTool` runs; the read is a pure function over the file so a
   malformed value warns and falls back rather than changing the surface silently.
3. `subagents` never registers `ptc_run_code` / `ptc_workflow`, and `full` never registers
   `ptc_subagent`: the model is told about exactly one orchestration surface in either case.
4. `subagents` without `codemode` active warns at entry and still registers -- removing the
   user's subagents would be a worse answer than a warning.
5. The lifecycle face registers in every mode except `off`, and stays outside the PTC mode
   loadout as ADR-0022 already requires.
6. The brief is one sentence per surface: `off` says nothing at all.
7. `ptc_subagent` is a thin top-level front for `dispatch()`. It owns no lifecycle of its
   own, so a bug fixed in the binding is a bug fixed here.

## Consequences

- A user on pi 0.99.1+ who prefers pi's sandbox can install this package for the subagents
  and stop paying for two orchestration surfaces.
- A user who wants a stock pi session gets one, with a config key rather than a command
  line of `--exclude-tools` flags they have to remember.
- The default is unchanged, so the only users affected without asking are the ones who set
  the key.
- `ptc_subagent` is a second front for one dispatcher. Two entry points means the depth and
  concurrency rules are enforced in one place, which is the point of decision 7, and the
  risk that a future change touches only one front.

## Known limitations

- Surface mode is per-install, not per-session, and not switchable mid-session.
- `subagents` gives the model `codemode` for orchestration whether or not `codemode` is the
  right tool for a given job. There is no measurement of that split; this record is about
  removing a duplicate surface, not about routing the work to the better engine.
- The warning in decision 4 is a `ui.notify`, which is TUI-only. A `--print` session in
  `subagents` without `codemode` gets no warning, and that is a real gap rather than a
  deliberate omission.
- Nothing here is measured for crash rate. The orchestration surface the model uses in
  `subagents` mode is pi's, so ADR-0024's binding contract does not reach it: a
  `codemode` program still infers a nested tool's shape from its description. That is pi's
  design, and the field data from ADR-0024 does not transfer to it.

- A caveat on what the PTC side is buying, found while measuring the comparison: a PTC
  program runs in a real Node ESM worker, so it can import node:child_process and start a
  pi subprocess itself. That path bypasses maxDispatchDepth, the concurrency slot and the
  task registry -- the three things ptc_subagent and the parallel binding exist to enforce.
  It is a hole, not a feature, and it is why "PTC owns the managed subagent" is a claim
  about the managed path rather than about the sandbox. Closing it is not this record's work;
  the capability note carries the evidence.
- ptc_subagent is registered in subagents mode only, so a session wanting both the top-level
  front and pi.dispatch from inside a program needs full mode. Deliberate: two ways to start
  a subagent is the duplicate-surface problem one level down.

## Reopen triggers

Making the surface switchable mid-session, if pi grows an unregister call or a
per-turn tool filter that would make it honest. Auto-excluding `codemode` with the surface
mode, if user research says the double surface is being missed rather than noticed. Dropping
`ptc_run_code` as a default, if `codemode` measurably matches it on a workload that needs a
real Node runtime -- which, on the evidence in the capability note, is exactly the
subagents.

## Cross-references

- docs/research/codemode-vs-ptc-capability-20260930.md: the measured capability
  comparison this record's context rests on.
- [ADR-0016](./0016-ptc-dispatch-binding.md): `pi.dispatch` and the depth and
  concurrency rules `ptc_subagent` inherits unchanged.
- [ADR-0022](./0022-background-dispatch.md): the six-state lifecycle behind the
  `ptc_task_*` face.
- [ADR-0024](./0024-binding-contract-declares-binding-result.md): the declaration that
  covers this package's orchestration surface and does not reach pi's.
