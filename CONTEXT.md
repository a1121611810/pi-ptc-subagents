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

**binding result** — what a _builtin binding_ call resolves to: the tool's
model-facing payload, `{ content, details }`, and nothing else. `content` is an
**array of content blocks**, so the text of a text-file result is
`result.content[0].text` and never the result itself; `details` is the tool's
own detail object or `null`, never `undefined`. There is no `files` /
`output` / `matches` field on any binding result -- `bash`, `grep`, `find`
and `ls` hand back one text block of newline-separated rows that the program
splits itself. A call that fails (a `bash` non-zero exit, a missing path, a name
not bound this run) rejects with `ToolCallError`; a _parallel binding_ is the
exception, resolving to a `DispatchResult` that carries `text` and `status`
and has no `content` at all. The `{ content, details }` re-wrap is the only
transformation between a pi tool's own result and the binding result.
ADR-0024. _Avoid_: "binding return value" (a binding resolves to an object, not
a scalar), "tool result" (that is the pre-rewrap shape, which a program never
sees), "output" (the four senses of "output" are split above; this is none of
them).

**binding contract** — the model-facing block inside the `ptc_run_code` and
`ptc_workflow` tool descriptions that states the _binding result_ shape, so the
model never has to guess it. One module owns the text and renders it into both
descriptions, so the two surfaces cannot drift. The per-binding notes are typed
against the bound-name set, and coverage is checked in **both** directions: every
name the contract puts in backticks is either a bindable binding or listed
non-binding vocabulary, and every bound binding is either named or knowingly
covered by the shared shape (`read` is the one binding covered without being
named, and the test states that as a literal). A name written in bare prose is
outside what that first check sees. It declares
return types only -- pi already declares every tool's
arguments natively in the same request, so restating them is pure token cost.
ADR-0024. _Avoid_: "TypeScript SDK section" (DSH's name for its system-prompt
variant, which also ships a full argument map; ours is a description block
carrying return types only), "tool signature" (no per-binding signature is
emitted).

**binding note** — a per-binding clause of the _binding contract_ stating where
one binding departs from the shared _binding result_ shape: `bash` rejects on a
non-zero exit, `write` always reports `details: null`, `edit` always reports
a diff, `pi.dispatch` carries `text` instead of `content`. Written only where
behaviour genuinely differs, so the common case stays one sentence. ADR-0024.
_Avoid_: "per-binding documentation" (the contract is the block; a note is one
exception inside it).

### What this extension exposes

Pi 0.99.1 ships its own PTC, a built-in extension registering one tool,
`codemode`. The two mechanisms are **not** in a superset relation: pi's side
wins on sandbox isolation and on tool discovery, this package's side wins on
spawning a fresh pi process. Terms below name the split, so "turn PTC on"
never has to mean two different things in one sentence.

**pi codemode** — pi's built-in programmable tool calling, the single tool
`codemode`, evaluated in a fresh QuickJS sandbox with no Node, no file
system, no network and no timers. Orchestration, batching and output
filtering; `searchTools` / `describeTool` (BM25) reach nested tools, and
`store` / `load` persist across calls. It cannot spawn a process, which is
the whole reason _parallel binding_ is not replaceable by it. Its designed
centre of gravity is the MCP catalog: MCP tools default to `codemode`
exposure, so the extension activates this tool to make them reachable from
scripts (see _MCP auto-enable evidence_). ADR-0025, ADR-0033.
_Avoid_: "pi's PTC" (it is one implementation of PTC, and "PTC mode"
below already names ours), "code mode" (the pre-August-2026 DSH name).

**surface mode** — the installed setting that decides which model-facing
tools this package registers, independent of _PTC mode_ (which decides
which of the registered tools are _active_). Read from the agent-dir
`ptc.json` beside `defaultMode`. Three values, in increasing order of what
this package takes responsibility for: `off`, `subagents`, `full`.
With no key set it is **detected**, and the detection asks three questions,
not one. Does this pi ship a `codemode` extension directory, will pi
actually load it, and will `codemode` be **active** for the model? The
second one is not redundant: since pi 0.99.0 a user can disable a
built-in extension, so a pi can ship `codemode` and be told not to run it.
The third is not redundant either: pi registers `codemode` inactive, and
since pi 1.0.0 the MCP extension may activate it at runtime (see
_MCP auto-enable evidence_). Shipped **and** loading **and** active
resolves to `subagents`; any other combination resolves to `full` -- and a
probe that cannot answer also resolves to `full` in the safe direction. The
session names that outcome at startup rather than defaulting in silence,
because a detection that cannot be seen is indistinguishable from a pi that
moved its `dist`. ADR-0025, ADR-0026, ADR-0027, ADR-0029, ADR-0033.
_Avoid_: "PTC mode" (that is the hide-the-built-ins
toggle; the
two are separate and both exist), "mode" unqualified (ambiguous in this
repository), "enable" (a surface mode of `off` leaves the package
installed and doing nothing, which "disabled" would hide), "default"
(the default is a function of the pi, so call it the detected default).

**codemode activation** — the third question surface-mode detection asks: will
`codemode` be **active**, i.e. callable by the model? It is distinct from the
_codemode switch_ (whether the extension loads) and from presence on disk, and
it has two evidence classes that answer independently, because pi activates
`codemode` by two mechanisms:

- **loadout mirror** — the settings-side answer: the `--tools` allowlist, then
  the merged `defaultTools` (`<cwd>/.pi/settings.json` over `<agentDir>`), then
  pi's own default, which does not name it.
- _MCP auto-enable evidence_ — the file-side answer: pi's MCP extension calls
  `pi.setActiveTools` to activate `codemode` whenever an enabled MCP server's
  tools are only reachable from scripts, which no settings file records.

Either one being positive means the model can call it, so the probe
**unions** them; the loadout's provenance is reported when both agree, and
`"mcp"` names the case where the loadout said inactive and the evidence said
otherwise. Both classes resolve to `inactive` by default, deliberately: pi
registers `codemode` with `defaultActive: false`, so "nobody configured
anything" is a decision and lands on the safe surface (`full`). ADR-0029,
ADR-0033. _Avoid_: "the activation probe" (the probe is the whole question;
this term is the question), "codemode enabled" (that is the switch, a different
question), "codemode loaded" (that is presence plus the switch).

**MCP auto-enable evidence** — the file-side answer to _codemode activation_,
computed from `<agentDir>/mcp.json` and `<cwd>/.pi/mcp.json` in that order:
true when `autoEnableCodemode` is not `false` and some **enabled** server's
exposure set -- its own `exposure` (default `codemode`) union the per-tool
`toolExposure` values -- contains `codemode`. pi computes it _from the config,
before the servers connect_, so whether a server connects is not part of the
question and this evidence is a pure function of the two files. What it cannot
see: a server an extension registered through `pi.registerMcpServer()`, which
activates `codemode` with no `mcp.json` at all -- that case is caught by the
session's real tool loadout instead (the drift notice), and only when the
surface was detected rather than pinned. ADR-0033.
_Avoid_: "the activation probe" (see _codemode activation_), "MCP settings"
(the same file also configures transports; only the auto-enable decision is
read).

**codemode switch** — whether the pi that loaded us will actually load its own
`codemode` extension, as distinct from the **codemode probe** (whether the
extension directory is on disk). Three states: `absent` (nothing configured it,
and pi loads built-ins by default), `enabled`, `disabled`. Read from the same
three places pi reads it and in the same order: the command line
(`-e builtin:codemode`, then `-ne` / `--no-extensions`), then
`<cwd>/.pi/settings.json`, then `<agentDir>/settings.json`. It exists because
pi 0.99.0 added `-builtin:<name>`, which made the two questions have different
answers; answering only the first one hands orchestration to a tool that is not
running. ADR-0027. _Avoid_: "codemode probe" (that is the filesystem
question), "is codemode enabled" (the tool is separately registered inactive via
`defaultActive: false`, which this switch does not read), "extension enabled"
(ambiguous between the extension loading and the tool being in the active set).

**structured result** — the `structuredContent` a model-facing tool returns
alongside its `content`, declared by an `outputSchema`, for **programmatic
callers only**: pi's `codemode` scripts receive it instead of the text, and it
is never sent to the model. It is a **projection**, not a mirror of `details` --
lean, stable, and shaped to match what the model was shown in the text block, so
a script and the transcript agree. `ptc_task_*` and `ptc_subagent` declare one;
`pi.dispatch` does not. ADR-0028. _Avoid_: "structured output" (pi's
`outputSchema` describes the result, it does not validate it — nothing checks
the two agree), "details" (that is the TUI's own richer channel, and the two are
allowed to drift), "the result" (ambiguous between `content`, `details` and this;
say which).

**orchestration surface** — the tool a model uses to compose many tool
calls into one program. Two exist and they are alternatives, never both:
`ptc_run_code` / `ptc_workflow` (this package, Node worker, real
`tools.<name>(args)` bindings) or `codemode` (pi, QuickJS). Whichever is
the _surface mode_'s choice, the model is told about exactly one. Having
both live in a request is a measured defect, not a feature: it is two
programming models to choose between.
ADR-0025. _Avoid_: "the PTC tool" (there are two, and which one is a
mode decision), "code execution" (both are that; the word says nothing
about the shape).

**subagent surface** — the top-level tool the model calls directly to
start a fresh pi subprocess, without writing a program. This is what
`surface mode: subagents` keeps, and it is the reason that mode exists: the
_parallel binding_ `pi.dispatch` can only be reached from inside a program,
so hiding `ptc_run_code` without adding a top-level entry point would
delete the subagent capability rather than hand it to `codemode`.
ADR-0025. _Avoid_: "dispatch tool" (that is the _parallel binding_ inside
a program), "subagent" (see Out-of-glossary: DSH's subagent is a
different thing), "background task" (that is the `ptc_task_*` lifecycle
face, which can inspect and stop tasks but cannot start one).

**lifecycle face** — the `ptc_task_list` / `ptc_task_output` /
`ptc_task_stop` trio. Registered in every surface mode except `off`,
including `subagents`, and outside the _PTC mode_ loadout on purpose:
turning _PTC mode_ off must never hide the lifecycle of a task that is
still in flight. ADR-0022, ADR-0025. _Avoid_: "task tools", "subagent
tools" (they manage tasks other things started).
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
Subject to a session-wide _dispatch concurrency_ cap (default 8, matches pi's
`subagent` extension `MAX_PARALLEL_TASKS`): one counter per pi session,
spent by programs, by the `ptc_subagent` front, and by background children.
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

**child report** — the structured value a dispatched child produces and
the host hands back, carrying exactly four things: `summary` (one line, the
child's own words), `findings` (each with `what` and independent `evidence`),
`files_touched`, and `usage`. It arrives over one of two channels — a report
**tool** the child calls (preferred) or a fenced JSON block in the child's
final text (the fallback) — and the result **always names which channel
delivered it**, including when none did: `tool`, `prompt-json`, `none` (the
contract was on and the child did not comply), or `opted-out` (the agent's
frontmatter set `childReport: false`, so nobody asked). Prose is preserved
alongside it, never
replaced. On by default; an agent's frontmatter opts out with one yes/no.
Bounded at 20 findings for a model-facing render, withheld count stated in-band
like the value tree. ADR-0032.

_NOT the same as_ **structured result** (that is `structuredContent`, defined
above as never reaching the model), and the two point in opposite directions:
`structured result` is machine-only and model-blind, a child report is
model-facing and is _also_ what a program reads. Reusing the older term for
this would invert its meaning. _Avoid_: "subagent report" (the word
_subagent_ is reserved for the top-level _subagent surface_, `CONTEXT.md`
§subagent surface), "structured output" (pi has no such concept — see
ADR-0032 §What pi 1.0.0 actually offers), "child result" (the child report is
one field of a _DispatchResult_, not the whole of it).

**dispatch concurrency** — the hard cap on concurrently in-flight
dispatch in one pi session. Default 8, configurable via
`PtcConfig.dispatchConcurrency`; the live control is the
`createBackgroundTaskRuntime({ concurrency })` call that sizes the
session's one `DispatchSlotCounter`, which is acquired inside
`dispatch()`. The cap is session-scoped, **not per-run**: every front
spends it, and a background child holds its slot for its whole
lifetime. So two concurrent programs in one session share 8 rather
than 8 each, and a program sharing a session with eight live
background children can be refused every foreground slot. The 9th
concurrent call resolves immediately with `{ status: "rejected",
errorMessage: "dispatch concurrency limit reached" }` — a hard
reject, never a queue, so an over-cap call is not parked behind a
long-running child. Distinct from the soft hint for ordinary tool-call
concurrency (where pi's own parallel-tool limits are the real ceiling)
and from `maxParallelSubCalls`, which has its own counter for builtin
fan-out.

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
The child survives the spawning program, the spawning turn, and
`/ptc off`; it is owned by the dispatching pi process (the _task owner_)
and ends when that session ends or is replaced
(`session_ended_while_running`) or when the owner process dies before
completion (`lost_on_session_restart`). See ADR-0022 + ADR-0023.

**TaskRecord** — session-level _TaskRegistry_ row tracking the full
lifecycle of one background child. 19-field schema (ADR-0022 §3's code block;
its "21 fields" heading is an authoring miscount) plus two
optional owner-identity fields (`ownerPid`, `ownerBootMs`, ADR-0023)
stamped at spawn, persisted to `<sessionDir>/tasks/<taskId>.json` per R1,
plus two optional _child report_ fields (`report`, `reportChannel`,
ADR-0032) written only when the record reaches `succeeded` — so a
still-running or failed task carries neither, because "has not reported
yet" is not "reported nothing". Independent of `DispatchResult` and
`SubCallRecord`. See ADR-0022 + ADR-0023 + ADR-0032.

**TaskStatus** — the 6-state enum for `TaskRecord.status`:
`running / stopping / succeeded / failed / canceled / lost`. The `queued`
state is deliberately absent in v1 (spawn-or-reject, no in-task queue).
See ADR-0022.

**TaskRegistry** — session-level singleton holding `TaskRecord` rows and
their per-subscriber `Subscription` cursors. On session restart,
replays events whose cursor is ahead of the highest-scanned position.
Its startup reconcile marks a `running`/`stopping` record `lost` (reason
`lost_on_session_restart`) only when the record's owner process is dead
(or the record predates ownership); its shutdown sweep marks only its own
still-running records `lost` (reason `session_ended_while_running`).
Reaping is owner-scoped — see _task owner_. See ADR-0022 + ADR-0023.

**task owner** — the identity of the extension-runtime instance that
created a `TaskRecord`: `{ ownerPid, ownerBootMs }` (process pid + the
runtime instance's start ms, minted once per _BackgroundTaskRuntime_).
A record belongs to exactly one owner; only the owning runtime reaps or
terminates it, so a sibling pi process sharing the session dir (every
background `pi.dispatch` child does) neither reaps nor kills another
owner's tasks. Listing stays cross-owner. See ADR-0023.

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
dereferences `outputRef`, applies ADR-0015 truncateTail, and renders the
persisted _child report_ ahead of the prose when the record reached
`succeeded` (ADR-0032); `ptc_task_stop({ taskId, reason? })` triggers
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
