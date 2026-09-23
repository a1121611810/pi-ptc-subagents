# Glossary — pi-ptc-subagents

Terms captured during wayfinder chart session on 2026-09-21. This is glossary
only — no implementation lives here. Source of truth for decision-records is
the wayfinder map issue (`wayfinder:map` label).

## Project terms

**pi-ptc-subagents** — this npm package. Hosts a pi extension that implements
DSH PTC mode. The repo name carries `-subagents` for historical reasons (a
previous `pi-subagents` peer existed); **subagents are explicitly not in scope
for the current PTC-mode effort** (see wayfinder map, 2026-09-21 grill round 3).
A separate effort (ADR-0016, 2026-09-23) added **pi.dispatch** — a binding that
lets a PTC program explicitly fan out to per-call pi sessions. The word
_subagent_ is not used for that mechanism (see _parallel binding_ below); use
precise terms.

**PTC mode** = **P**rogrammable **T**ool **C**alling, also known as
DSH "Code Mode" before the August-2026 rename. The model submits a program
(JS / TS) that composes multiple tools in one shot, and only the program's
return value plus collected logs flow back into the model's context.

**dsh** = DeepSeek Harness, `deepseek-ai/deepseek-harness` on GitHub. Source
of truth for what PTC mode "means" behaviour-wise; pi-ptc must be re-aligned
to dsh's current behaviour (not the old pi-ptc SPEC's frozen decisions — see
map decisions).

## pi-side terms

### The four things "output" can mean

The word "output" is ambiguous in this project; use these instead (grill
round 2026-09-22, when "PTC 输出没可读性" turned out to mean the third one).

**completion value** — the value the program `return`s. Carried structurally
as `details.result` and textually as the last block of the tool-result text.
_Avoid_: output, result (when you mean the return value).

**captured output** — the `console.log` lines plus workflow narration
(`log()`): the `logs` / `narrations` arrays. _Avoid_: output.

**tool-result text** — the single text block handed to the model
(`content[0].text`), assembled by `renderToolResult()`. This is what the model
reads; it is not what the human sees. _Avoid_: output, "the result".

**PTC row** — the TUI rendering a human reads, produced by `renderCall` /
`renderResult` from the `details` payload. _Avoid_: output.

**value tree** — the shape a **PTC row** gives a container **completion value**: one row per
property (or array index), nested containers behind `├─` / `└─` / `│` connectors, bounded by
depth / children / line-width caps whose withheld amount is stated in-band. A scalar completion
value is a one-line hint instead. _Avoid_: value block (removed by ADR-0013 §5), JSON dump, payload.

**hoisted image** — an image block that a _successful_ binding call handed to a PTC
program and that the host then lifted out of the program onto the PTC tool result, so
the model sees the picture without it crossing the program's JSON return value.
Mechanism and the deviations from DSH: ADR-0014 (DSH parity: `dsh-tools`'s
`exec.deferContext`). Nothing is capped or deduped. _Avoid_: attachment, "the program returns the image", base64
result.

**default-on / 默认开启** — for this package, "default-enabled" means: a user
who runs `pi install npm:pi-ptc-subagents` immediately gets the PTC tools
(`ptc_run_code`, `ptc_workflow`) on next pi startup, with **no** extra setup.
Mechanism: pi reads the npm package's `package.json` `pi.extensions` field
and registers the extension in `~/.pi/agent/settings.json` automatically.
**Not** a postinstall hook. **Not** a manual `pi-ptc install` CLI command.

**binding** — a function callable from within a PTC program as
`tools.<name>(args)` (builtin) or `pi.<name>(args)` (parallel binding). Two
kinds:

- _builtin binding_ — a pi built-in tool whose `execute()` is invoked
  directly from the PTC worker (no `pi.on("tool_call")` route; see
  ADR-0005 §2). Currently: `read`, `bash`, `edit`, `write`, `grep`, `find`,
  `ls`. Listed in `BUILTIN_BINDING_NAMES`; the default table exposes all of
  them; callers may pass an explicit subset (R3 read-only PTC surface).
- _parallel binding_ — a non-builtin binding whose semantics are independent
  of pi's parallel-tool execution and which is explicitly designed for
  fan-out. Currently: `pi.dispatch(...)` (see ADR-0016). It spawns a
  fresh `pi` subprocess per call, so the PTC program gets session-level
  isolation without inventing a new task state machine.

_Avoid_: "subagent" (overloaded; CONTEXT.md §Out-of-glossary), "BINDING_NAMES
whitelist" (the binding config is a _policy_, not a _filter_; Q1 grill round,
2026-09-23).

**helper** — a global function injected into a worker's runtime. **Not all
DSH helpers appear in plain PTC mode** — per R1 (`research/dsh-ptc-behaviour-inventory.md`,
dsh-v0.1.6-alpha.2), `log / phase / parallel / pipeline / agent` are
workflow-engine globals in DSH's `@deepseek-ai/dsh-workflow-ptc`; they do
NOT appear in PTC `run_code`'s worker surface. Plain PTC `run_code`
exposes only `tools.<name>(args)` + standard Node API + `console.log`. The
pi-ptc worker split mirrors this:

- **`ptc_run_code` worker** — bindings + Node + `console.log`; the
  script's async return value goes back to the model as the result;
  there is no `result()` helper in plain PTC.
- **`ptc_workflow` worker** — bindings + Node + `console.log` PLUS
  workflow helpers `log / phase / parallel / pipeline` (real in this map).
  There is no `agent()` helper (G1 #13 decision B — the DSH helper is
  deferred to a future map). For fan-out to per-call pi sessions today,
  the program uses the `pi.dispatch(...)` _binding_ (see _binding_), not
  a helper. The `result(value)` form in `ptc_workflow` is the script's
  async return, materialized lossless-JSON.

**parallel binding** — a binding whose call spawns a per-call runtime
unit (a pi subprocess for `pi.dispatch`; potentially other backends in the
future). The term contrasts with _builtin binding_, whose call is
in-process. See ADR-0016. _Avoid_: "subagent" (DSH subagent is a different
thing; see Out-of-glossary).

**concurrent tool call** — a single tool call (whether builtin or parallel
binding) issued by the PTC program while another tool call is already in
flight. Pi native runs these concurrently (preflight sequentially, execute
concurrently); the PTC program composes with `Promise.all` /
`Promise.allSettled` and the binding return-value shape. See ADR-0016
§3.

**pi.dispatch** — the only _parallel binding_ shipped today. Spawns a
fresh `pi` subprocess (`--mode json -p --no-session
--append-system-prompt <tmpfile>`) and returns a structured
`DispatchResult`. Subject to a per-run _dispatch concurrency_ cap
(default 8, matches pi's `subagent` extension `MAX_PARALLEL_TASKS`).
_Not_ a model-visible lifecycle tool: the model cannot `task_query` /
`task_stop` it — it is program-visible only, because it is a binding.
_Avoid_: `agent()` (DSH helper stub, deferred), `subagent` (DSH / pi
extension).

**DispatchResult** — the structured return type of `pi.dispatch(...)`.
Fields: `text` (final assistant text), `status` (`fulfilled` /
`rejected`), `agentName`, `durationMs`, `exitCode`, `usage?` (input/output/
cacheRead/cacheWrite/cost/turns; absent when the child reported no usage
block), `stderr?`, `errorMessage?`. Shape matches `Promise.allSettled`
settled records, so PTC programs compose without `try/catch`. See
ADR-0016.

**dispatch concurrency** — the per-run hard cap on concurrently
in-flight `pi.dispatch(...)` calls from one PTC run. Default 8,
configurable via `PtcConfig.dispatchConcurrency`. Enforced at the
dispatcher (today the `acquireDispatchSlot` site); the 9th concurrent
call resolves immediately with `{ status: "rejected", errorMessage:
"dispatch concurrency limit reached" }`. Distinct from the soft
hint for ordinary tool-call concurrency (where pi's own parallel-tool
limits are the real ceiling).

**dispatch depth** — the per-run depth in a recursive `pi.dispatch` chain.
The parent turn's PTC run is depth 0; a child spawned by `pi.dispatch`
is depth 1; a grand-child is depth 3. Configurable via
`PtcConfig.maxDispatchDepth` (default 3). A `pi.dispatch(...)` call whose
`childDepth = currentDepth + 1` would exceed `maxDispatchDepth` resolves
immediately with `{ status: "rejected", errorMessage: "dispatch depth
limit reached" }`. Aligns with dsh's `SubagentCapabilities.depthLimit`
and codex's `agent_max_depth`. ADR-0016 Recursive dispatch section.

**`pi-ptc-context` hint** — the `<pi-ptc-context depth="N" max-depth="M">...</pi-ptc-context>`
block that pi-ptc appends to a dispatched child subprocess's system prompt,
so the child agent can see how much recursion room it has. Shape mirrors
DSH's `subagent-context` injection; the only difference is the depth /
max-depth attributes, which are pi-ptc-specific. ADR-0016 Recursive section.

**run_code** — the model-facing tool name DSH exposes in PTC mode. The pi
version exposes `ptc_run_code` to avoid collision with pi's hypothetical
future native `run_code`, plus a sidekick `ptc_workflow` for structured
(with `meta` + `args`) runs.

## Worker lifecycle (ADR-0017)

**worker pool** — the per-surface collection of warm `worker_threads` workers
owned by the parent turn, held by a `TurnPools` holder. Created lazily by the
first PTC run of the turn, passed to `runPtcProgram()` via
`RunPtcProgramOptions.pool`, retired by the extension's `turn_end` hook.
Default `poolSize` 4, `poolAcquireTimeoutMs` 30s. `run_code` and `workflow` do
not share a pool. _Avoid_: "singleton" (this is per turn), "thread pool" (Node
idiom for something else).

**warm worker** — a `worker_threads` Worker that has been retained after a
run settled and may be reused for a future run in the same pool. The worker's
internal state machine is `CREATED → BOOTING → READY ↔ RUNNING`; only
`READY`-state workers are eligible for warm reuse.

**reset handshake** — the extended meaning of the `ready` worker frame: on
warm reuse, `ready` means "this worker has cleared all per-run state and is
ready for the next `init` frame". On cold start, `ready` keeps its original
meaning ("booted"). No new frame kind.

## Out-of-glossary (do not confuse)

- **DSH `subagent`** (a separate dsh concept: continuable sub-agent with
  capability flags) is NOT the same as the historical `pi-subagents` npm
  package. Neither is in scope here; both surface only via the `agent()`
  helper stub.

- **pi `subagent` extension** (`examples/extensions/subagent/index.ts` in
  `@earendil-works/pi-coding-agent`) is the user-installable extension that
  spawns pi subprocesses. It is a separate object from `pi.dispatch`; the
  latter is implemented inside this package and is _behaviour-compatible_
  with the former but not _cooperative_ (does not require the extension to
  be installed).

**DSH preset / agent-preset** (Standard / PTC / Minimal / Creative) is a
dsh-side concept. pi has no equivalent preset system today; this package
is _only_ the PTC mode implementation, not a preset framework.
