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
`tools["<name>"](args)`. Every binding lives in the one `tools` table —
there is no `pi` global in the worker — so the parallel binding named
`pi.dispatch` is reached as `tools["pi.dispatch"](args)` and takes a single
object (`{ agent, task, cwd?, agentScope?, model?, thinkingLevel?, background?, label? }`),
not a positional argument list. Two
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
fresh `pi` subprocess (`--mode json -p` plus session-file flags from R1
when `{ background: true }` is set) and returns a structured result
(see _DispatchResult_ for foreground, _DispatchHandle_ for background).
Subject to a per-run _dispatch concurrency_ cap (default 8, matches pi's
`subagent` extension `MAX_PARALLEL_TASKS`).
The spawn surface is binding-only (the model cannot call `pi.dispatch`);
but the **lifecycle face** for background tasks is model-visible via
`ptc_task_*` tools and `<bg-task-notification>` events (see ADR-0022).
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

## TUI rendering — partial-state visibility (ADR-0020, ADR-0021)

**partial-state render** — the visual treatment of a PTC row while a run is in
flight (`isPartial: true`). Three visible parts: a shimmered description on
the parent row, a sub-call tree under it, and right-aligned meta not yet
present. _Avoid_: "running state", "loading state" (these collide with pi's
own `toolPendingBg` / settled-state distinctions elsewhere in the TUI).

**settled-state render** — the visual treatment after the run completes
(`isPartial: false`). Description is uniformly `accent` (no character is
highlighted), sub-call tree is fully populated with their final statuses, and
right-aligned meta is present. By ADR-0020 §5 and ADR-0021 §8, the only
visible difference between partial and settled is the shimmer band on
running rows + the row colour of sub-calls still in flight.

**shimmer** — DSH's `TextShimmer` design, adapted to ANSI: same text
content, one character at a time is bright (`accent`) and the rest dim — except at the
sweep-off step, where every character is dim.
The bright character's position advances one step per 150ms, wrapping at
the description's length. Subtle by design (DSH §A; ADR-0020 "trade-off,
restated"). _Avoid_: "TextShimmer" alone (that name refers to DSH's CSS
implementation, not ours); "pulse" (that name covers too many distinct
visuals — see ADR-0020 §1 vs `Loader`, Knight-Rider, trailing dots).

**shimmer band** — the bright accent character at the current band
position. In a description of length N the band visits positions 0 … N
inclusive (`% (N + 1)` in the formula). At the extra step N the band has
swept past the end and the whole description rests at the off-band colour
(`dim`) — never the settled all-`accent`, which would make one frame per
sweep indistinguishable from a finished run. Everywhere else the bright
character is the **only** colour difference; font, position and glyphs are
identical in both states.

**bandPos** — the integer index of the bright character on a running row,
computed in `render()` as `floor((Date.now() - startedAt) / intervalMs) %
(desc.length + 1)`. It is **derived, never stored**: the "no character
highlighted" state is a cleared `startedAt` (settle), which short-circuits
the whole band computation. _Avoid_: a `-1` sentinel (an earlier draft
stored one; the render path no longer tests for it).

**ShimmerDecorator** — the module that owns the shimmer mechanism:
`src/tools/shimmer.ts`. Exposes `withShimmer<T extends Component>(inner,
options): T`, which wraps a pi-tui `Component` with the band's colour
cycle, and attaches a `dispose()` hook that stops the interval (belt-and-braces:
production settle rides pi's `isPartial` flip, and pi never disposes a tool row
itself — the hook exists for a caller that replaces a still-partial row). Its
lifecycle state — `startedAt` and the interval handle — lives in the
**`ShimmerState`** bag the caller passes in, which is pi's
`ToolRenderContext.state`. It cannot live on the decorated instance:
pi rebuilds the row on every `updateDisplay()`, and the shimmer's own
interval triggers one, so instance state would restart `startedAt`
each tick (band frozen at position 0) and leak the previous interval.
Used only by `PtcRow`'s call row — sub-call rows do not shimmer
(US16). _Avoid_: "shimmer wrapper" (too generic), "shimmer component"
(collides with the `Component` vocabulary elsewhere).

**ShimmerState** — the two-field bag `{ startedAt?, interval? }` that
carries the shimmer across the row recreation pi performs. Owned by pi
(`ToolRenderContext.state`, one bag per tool call) and threaded through
`PtcRenderOptions.state`; `withShimmer` reads and writes it. Direct
library callers and tests may pass a throwaway `{}`.

**sub-call tree** — the list of `SubCallRecord` rows under a PTC parent
row, always visible: both while the run is in flight (pushed live through
pi's `onUpdate`, so the reader can see which binding is currently in
flight) and at settle, and in both collapsed and expanded states. Each row
carries its own status + duration; order = host-side dispatch order; capped
at `maxSubCalls = 32` with a `└─ …+N more calls` tail. ADR-0021.

**SubCallRecord** — the per-binding-call data the dispatcher tracks and
the renderer reads:

```
{ callId, name, args, status, startMs, endMs?, durationMs?,
  resultSummary?, errorMessage? }
```

Copied out of `SubCallTracker.snapshot()` and into `PtcToolDetails.subCalls`
by `renderToolResult`. The snapshot copies the records, so a captured push
shows the state as of that moment rather than the state the record was later
mutated into. _Avoid_: "binding call", "tool call" (those refer to the
binding's own concept, not the record we surface to the renderer).

**SubCallStatus** — the five-state union on a `SubCallRecord`:
`"running" | "ok" | "error" | "cancelled" | "rejected"`. `running` is the
moment between `call`-frame arrival and binding resolve; `ok` / `error`
follow `binding.execute` resolution; `cancelled` is set when the run's
`AbortSignal` fired before the binding resolved; `rejected` is set when
the `pi.dispatch` capacity gate (ADR-0016 §2) declined the call before
it started. ADR-0021 §6. _Avoid_: three-state collapsing (DSH has
running/ok/error; we add `cancelled` + `rejected` because the dispatcher
already knows them).

**SubCallTracker** — the module that owns the `SubCallRecord` lifecycle:
`src/runtime/sub-call-tracker.ts`. Exposes `recordStart(callId, name, args)`,
`recordEnd(callId, status, summary?)`, `snapshot(): readonly SubCallRecord[]`.
Dispatcher holds one instance per run and calls `snapshot()` on every start
and end (feeding the tool's throttled live push) and once at settle. The
renderer never sees the tracker directly, only snapshots that reached it via
`PtcToolDetails.subCalls`. ADR-0021 §9. _Avoid_: "sub-call store",
"sub-call list" (the data is a snapshot, copied per call, not a live view of
the tracker's internals).

**args preview** — the one-line summary of a sub-call's args, rendered
after the status cell. `read` → `args.path`, `bash` →
`args.command`, `grep` → `args.pattern`, `find` → `args.pattern`,
`ls` → `args.path`, `edit` → `args.path`, `write` → `args.path`.
Falls back to `JSON.stringify(args)` truncated to 40 chars when the
selector misses — **the only place** `JSON.stringify` is acceptable on a
sub-row. ADR-0021 §3. _Avoid_: "args display" (vague), "args format"
(implies the JSON-format capability).

**DispatchHandle** — the thin 3-field snapshot returned by background
`pi.dispatch(...)` when `{ background: true }` is set:
`{ taskId: ULID, label: string, status: "running" }`. Spawn-time projection
of the TaskRecord; not updated on transition. Programs that need live
state call `ptc_task_list` instead. See ADR-0022.

**background dispatch** — the long-lived variant of `pi.dispatch`. The
spawning program's model observes the spawned child via `<bg-task-notification>`
events delivered through the TaskRegistry subscription buffer, and via
model-facing tools `ptc_task_list` / `ptc_task_output` / `ptc_task_stop`.
The child may outlive the spawn turn, run across program boundaries,
finish while the parent is in a tool loop, fail because the host
rebooted, or be stopped explicitly (`ptc_task_stop`) or implicitly by
session abort (`Esc`). See ADR-0022.

**TaskRecord** — session-level _TaskRegistry_ row tracking the full
lifecycle of one background child. 21-field schema persisted to
`<sessionDir>/tasks/<taskId>.json` per R1. Independent of `DispatchResult`
and `SubCallRecord`. See ADR-0022.

**TaskStatus** — the 6-state enum for `TaskRecord.status`:
`running / stopping / succeeded / failed / canceled / lost`. The `queued`
state is deliberately absent in v1 (spawn-or-reject, no in-task queue).
See ADR-0022.

**TaskRegistry** — session-level singleton holding `TaskRecord` rows and
their per-subscriber `Subscription` cursors. On session restart,
replays events whose cursor is ahead of the highest-scanned position;
tasks left `running` at shutdown are marked `lost` (reason
`lost_on_session_restart`). See ADR-0022.

**Subscription** — per-subscriber cursor for one `TaskRecord`.
Persisted to `<sessionDir>/subscriptions/<subscriberId>-<taskId>.json`.
The ADR's fork-cursor rule is `max(parent, child)` (child observes
post-fork events only) and it names an explicit-reset surface
`ptc_task_resubscribe(taskId, since: "initial")`; neither the helper nor that
tool ships in v1 — the caller supplies `since` and a resubscribe tool is
deferred to v2. See ADR-0022.

**`ptc_task_*` (model-facing management tools)** — three tools always
on (not gated by `/ptc off`, per ADR-0022 + map Notes clause 5):
`ptc_task_list({ status?, limit? })` returns matching TaskRecords
(newest first, default limit 100); `ptc_task_output({ taskId, sinceBytes? })`
dereferences `outputRef` and applies ADR-0015 truncateTail;
`ptc_task_stop({ taskId, reason? })` triggers
`running → stopping → canceled` (the dispatcher delivers the signal).
See ADR-0022.

**`<bg-task-notification>` (event schema)** — user-role XML emitted to
the model when a `TaskRecord` changes. Batch parent `<bg-task-notifications>`
wraps N per-event children; per-event `<bg-task-notification>` carries
`id="task:<ulid>:-><status>"`, `task-id`, `subscription-id`, `status`,
`label`, `agent-name`, `depth`, `duration-ms`, `transition-at-ms`,
`<output-bytes>`, optional `<output-ref>`, optional `<output-preview>`
(only when outputBytes <= 2048). See ADR-0022.

**dispatch sub-row** — the variant of a sub-row for `pi.dispatch(...)`
calls. Uses the binding's `agent` argument for the args preview and reads
its state from `DispatchResult`: a refusal (`status: "rejected"` with
`started: false` — depth or concurrency gate, unknown agent, a spawn that
never happened) is `rejected`, a child that ran and failed
(`started: true`) is `error`, and everything else is `ok`. One per dispatch call; no recursion into the child PTC run's
tree (ADR-0021 §7).

## Release & supply chain

**release tag** — an annotated git tag `v<version>` on `main`; pushing it is the act
that publishes the package (the `v*` workflow does the rest). The tag must agree with
`version` in `package.json`. _Avoid_: "version bump" (the commit that precedes the
tag), "npm publish" (the mechanism the tag triggers).

**trusted publishing** — npm's OIDC publish path: the `publish.yml` workflow is
registered on npmjs.com as this package's trusted publisher, so no long-lived npm
token exists anywhere. ADR-0018 §2. _Avoid_: "NPM_TOKEN" / "automation token" (this
package has none).

**provenance** — the signed build attestation npm attaches to a published version.
**Absent for this package**, because npm generates it only for public source
repositories; the absence is expected, not a publishing defect, and it clears by
itself if the repository is ever made public. ADR-0018 §7. _Avoid_: "signature"
(registry signatures are a different npm feature).

**staged publishing** — npm's optional approval gate (`npm stage publish`, then a 2FA
`npm stage approve`). Not adopted here; ADR-0018's considered options say why, and
when to revisit. _Avoid_: "draft release" (that is a GitHub Releases concept).

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
