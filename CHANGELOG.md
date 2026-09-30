# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.1] - 2026-09-30

### Fixed

- **The `ptc_subagent` tests no longer depend on a pi agent being registered.**
  Five tests reached for pi's `__smoke_echo` agent, which does not resolve on every pi build,
  so the suite was green on one platform and red on the release runner. The fixture is now
  written by the test into `<cwd>/.pi/agents`, the path the agent resolver actually reads at
  project scope, and every dispatch asks for project scope explicitly rather than inheriting
  the `user` default, which points at the real `~/.pi`. Verified with an empty `HOME`: the whole
  suite is green with no ambient agent state at all.

  No product code changed in this release.

## [1.2.0] - 2026-09-30

### Added

- **The surface default is detected from the pi that loaded us (ADR-0026).** With no
  `surfaceMode` set, a pi that ships its own `codemode` resolves to `subagents` and a pi that
  does not resolves to `full`. Setting the key always wins, and a probe that cannot answer
  falls back to `full` rather than guessing.

  This is the one behaviour change that is not invisible on upgrade: on pi 0.99.1 or newer, a
  user who has never set `surfaceMode` moves from `full` to `subagents`. `codemode` ships
  inactive (`defaultActive: false`), so such a session has a subagent front and no active
  orchestrator until codemode is added to the tool list -- the startup warning says so. Set
  `{ "surfaceMode": "full" }` to keep today's tools.

  Detection is a filesystem probe over `process.argv[1]`, because pi's own tool listing is
  unavailable at factory time: `getAllTools()` is a `notInitialized` stub until `bindCore`
  runs, and a throwing factory makes the extension fail to load rather than return an empty
  list.

  A detection the user cannot see is the one failure this design has, so the outcome is
  reported: at session start, through the TUI notification channel, a session with no
  `surfaceMode` set is told how the probe came out whenever it could not answer, and which
  surface the default therefore is. The expected case — a pi that ships `codemode`, detected as
  `subagents` — stays silent. A second notice covers the case the probe structurally cannot
  see: it walks the filesystem, so under `--no-extensions` or `--exclude-tools codemode` it
  answers `present` for a tool the session does not have. `session_start` cross-checks the
  probe against pi's own `getAllTools()` and reports a disagreement in either direction.

  Both notices are `ui.notify`, which is TUI-only — and that gap is **new here**, not inherited:
  measured, three `--print` runs that each emit one produced 0 bytes on stdout and 0 on
  stderr. The README is the only channel on which a `--print` user learns why they got the
  surface they got. What is established is that the outcome is issued through the documented
  TUI channel; no test observes either notice end to end through a real pi TUI.

- **The model-facing surface is now a setting, and a subagent can be started
  without writing a program (ADR-0025).** A new `surfaceMode` key in
  `~/.pi/agent/ptc.json` decides what this extension registers: `full`
  (today's behaviour, and the detected default on a pi without `codemode`)
  registers `ptc_run_code`, `ptc_workflow` and the `ptc_task_*` trio;
  `subagents` registers a new top-level `ptc_subagent`
  plus the `ptc_task_*` trio and leaves orchestration to pi's own `codemode`;
  `off` registers nothing at all, so the session is stock pi. The new tool takes
  the same arguments as the `pi.dispatch` binding and calls the same dispatcher,
  so depth, concurrency and the background task lifecycle behave identically and
  a task spawned through it is listable with `ptc_task_list`.

  Motivation, measured rather than assumed: pi 0.99.1 ships its own programmable
  tool calling as the built-in `codemode`, which is stronger than `ptc_run_code` at
  isolation and tool discovery but cannot spawn a process at all. With both
  installed the model is taught two programming models per request
  (`docs/research/codemode-vs-ptc-capability-20260930.md`).

- **The PTC tool descriptions now declare what a binding call resolves to
  (ADR-0024).** `ptc_run_code` and `ptc_workflow` carry one shared binding
  contract: a binding result is `{ content, details }`, `content` is an array of
  content blocks (the text of a text-file result is `result.content[0].text`),
  `details` is an object or `null`, and there is no `files` / `output` /
  `matches` / `entries` field to read — `bash`, `grep`, `find` and `ls` return one text block
  of newline-separated rows that the program splits itself. A `builtin binding`
  that fails rejects with `ToolCallError`; `pi.dispatch` resolves to a
  `DispatchResult` with `text` and `status` and no `content`.

  Model-facing only: the wire, the worker and every existing program are
  unchanged. Field report before: a pty-driven run of the real TUI with PTC mode
  on produced 31 program crashes across 16 runs, the largest error class being the
  model treating a binding result as a string or as an object with a `files`
  field — neither is ever true, and nothing said so
  (`docs/research/ptc-binding-contract-measurement-20260930.md`).

  Re-measured after the change, same harness and tasks: **0 of those three crash
  classes in 16 runs**, the correct `result.content[0].text` access in 16 of 16,
  and the context median for a PTC run down from 36,669 to 8,360 with median
  turns from 8 to 2. Exact-match rate is not claimed to have improved — it moved
  10/16 to 11/16 while the control arm moved 15/16 to 13/16, which is this
  harness's noise floor
  (`docs/research/ptc-binding-contract-re-measurement-20260930.md`).

### Changed

- **The dispatch concurrency cap is one counter per session, not one per run.** The acquire
  moved out of the dispatcher and into `dispatch()`, so a single `DispatchSlotCounter` now
  serves every front: concurrent programs in the same session, the `ptc_subagent` tool, and
  background children. The value is still `PtcConfig.dispatchConcurrency` (default 8) and the
  refusal shape is unchanged; what changed is whose calls the cap counts.

  This reduces effective concurrency in two measurable ways, and neither is a rounding
  difference — 24 concurrent foreground calls against a real fake-`pi` spawn:

  - two concurrent programs that could each have 8 in flight now share 8 (16 spawned -> 8);
  - a program sharing a session with 8 live background children can now be refused **every**
    foreground slot (8 foreground spawned -> 0). The refusal is a hard reject with no queue, so
    an over-cap call is not parked behind a long-running child.

  A single program on its own is unchanged (8 of 24, before and after), which is why the
  change passed three review rounds. ADR-0016 §2 and ADR-0022 §9 are amended; the depth cap is
  not.

  The knob is now live rather than dead: the live control is
  `createBackgroundTaskRuntime({ concurrency })`, which sizes the session counter from
  `PtcConfig.dispatchConcurrency`. Passing `dispatchConcurrency` through
  `runPtcProgram({ config })` no longer sizes the cap a pi session uses (measured: 2
  configured, 8 dispatched).

### Fixed

- **A background task that produced no answer is no longer reported as a
  success (#70, field report).** A child that hits a rate limit or a model
  error still exits 0: pi writes the reason onto the assistant `message_end`
  as `stopReason: "error"`, retries, and closes clean. The background pump
  read the exit code alone, so such a task was recorded `succeeded` and the
  model was told it had worked — while `ptc_task_output` answered "(no output
  yet; task X is succeeded)". `succeeded` now requires the child to exit 0
  **and** to have produced assistant text, which is the rule
  `decideCloseOutcome` already applied to the foreground path; one failure now
  has one verdict and one sentence in both paths. A failing `resolve-exit`
  writes `errorMessage`, and the child's own `stopReason: "error"` text is
  carried onto the record so the model is told _why_, not only _that_
  (ADR-0022 §2, amended). A non-zero exit is still left unlabelled and a model
  stop still resolves `canceled` — neither is relabelled by this change.

## [1.1.1] - 2026-09-30

### Fixed

- **The expanded `phases` block now says how many phases it withheld.**
  When a run declared more than eight phases, the block appended a bare
  ` …` to the roll-up line — it told the reader that something was hidden
  but not how much. ADR-0013 §3 requires a block to report _what_ it
  withheld, and the other four blocks (`code`, `log`, `out`, `warn`) all
  report a count. The tail is now `…+N more phases`, inline, because the
  phases block is a single roll-up line rather than a list of rows.

### Changed

- **Docs**: the README's `TUI rendering` section now documents the
  model-facing text block's own bounds — 100 characters for the inline form,
  200 per line (ADR-0012) — next to the on-screen tree's 4 / 6 / 120, so the
  two contracts are no longer conflated and lowering one to match the other
  does not read as a typo fix.

## [1.1.0] - 2026-09-29

### Fixed

- **Background dispatch children no longer reap their parent's tasks (field
  report, 2026-09-29).** Background children share the session's task storage
  via `--session-dir`; a child's startup reconcile and exit sweep used to be
  directory-wide, so a dispatch child — or any `pi` process started in the same
  directory — flipped every running task to `lost`. Task records now carry an
  owner identity (`ownerPid` / `ownerBootMs`) and reaping is owner-scoped
  (ADR-0023); `lost_on_session_restart` now means the owner process died
  before the task finished, or the record predates ownership (pre-upgrade
  ownerless rows, which any process binding the directory reaps).
- **`pi.dispatch` refusals are actionable.** A missing `agent` argument is
  reported distinctly (`agent is required (there is no default agent)`) and
  both the missing- and unknown-agent results list the agents registered under
  the effective scope plus the two lookup paths and the agent-file shape. The
  binding now runs its arguments through pi's own `validateToolArguments`
  (the same validation the built-in bindings use) and a validation failure
  comes back as a `rejected` DispatchResult instead of reaching the
  subprocess layer.

### Changed

- **PTC program prompts name the dispatch binding precisely.** The
  `ptc_run_code` / `ptc_workflow` descriptions and the `/ptc` briefing state
  that `pi.dispatch` is always bound under its literal dot name (call it as
  `tools["pi.dispatch"](...)`; `tools.pi.dispatch` does not exist), and each
  run exposes its actual bound names on the new `ptcBindings` global so
  programs never guess the binding surface.
- **Docs**: `ptc_run_code`'s `timeoutMs` description and `docs/usage/bgdispatch.md`
  now state that a run timeout terminates in-flight foreground dispatches, and
  the guide gains prerequisites (no default agent) and an output-compactness
  convention (page via `ptc_task_output` instead of truncating).

## [1.0.0] - 2026-09-24

### Added

- **Background dispatch: PTC programs can fan out to long-lived children.**
  `pi.dispatch(...)` gains an opt-in `{ background: true }` path: instead of
  awaiting the child, the binding returns a `DispatchHandle`
  (`{ taskId, label, status: "running" }`) immediately, and a detached pump
  drives a session-level `TaskRecord` through
  `running / stopping / succeeded / failed / canceled / lost`, past the end of
  the program and of the turn. The handle is a frozen spawn-time projection;
  live state comes from three model-facing tools that stay on when PTC mode is
  off (`/ptc off` only blocks new spawns):
  - **`ptc_task_list`** — list this session's tasks (`status?`, `limit?`,
    default 100, newest first);
  - **`ptc_task_output`** — read a task's captured output (`taskId`,
    `sinceBytes?`), tail-truncated to pi's 50 KB / 2000-line contract
    (ADR-0015) with the full text written to a temp file;
  - **`ptc_task_stop`** — ask a running task to stop (`taskId`, `reason?`,
    default `"model stop"`), moving it `running -> stopping -> canceled`.

  Lifecycle changes arrive as user-role `<bg-task-notification>` events under a
  `<bg-task-notifications>` batch, cursor-delivered per subscriber with a
  2048-byte inline-preview ceiling. Background tasks count against the existing
  `dispatchConcurrency` (8) for their whole lifetime and share the
  `maxDispatchDepth` (3) recursion bound. Existing foreground `pi.dispatch`
  keeps its `DispatchResult` shape unchanged. ADR-0022.

## [0.1.3] - 2026-09-23

### Added

- **PTC rows show what the program is doing while it runs.** Two partial-state
  visuals on the `ptc_run_code` / `ptc_workflow` row, both absent until now:
  - a **shimmer** on the call row — same text, one character at a time bright,
    the highlight sweeping at 150ms — so a running row is distinguishable from a
    settled one in a column (ADR-0020);
  - a **sub-call tree** under it: one row per binding call the program made,
    live from the moment the call is made, with its own five-state status
    (`running` / `ok` / `error` / `cancelled` / `rejected`) and duration,
    visible without expanding the row and capped at 32 with a `+N more` tail
    (ADR-0021). A failed run shows the failure text but no sub-call tree: the
    tool throws (pi's convention), and pi builds that error result with an empty
    `details`, so the tracked calls are dropped with it.

### Changed

- **Build pipeline: minify + source-map exclusion.** `pnpm run build`
  (`vp pack`) now produces minified `dist/*.js` (rolldown's built-in oxc
  minifier; no new dependency). The npm tarball excludes `dist/**/*.map`
  via the `package.json#files` whitelist — sourcemaps stay on disk for
  local stack traces, but no longer ship. Tarball shrinks from 168.7 kB
  packed / 548.6 kB unpacked (v0.1.2 baseline) to 40.5 kB / 113.6 kB
  (−76% / −79%); `dist/*.js` total shrinks from 161,303 B to 53,959 B
  (−66.5%). All 39 public exports retain their original names. ADR-0019.

## [0.1.2] - 2026-09-23

### Fixed

- **`pi.dispatch` is registered in production again.** The injection check compared the
  binding-name array by reference against `DEFAULT_BINDING_NAMES`; production resolves
  names through a `.filter()` that always returns a fresh array, so the comparison never
  held and shipped sessions had no `pi.dispatch` at all. Injection now keys off a new
  `includeDispatch` option (defaulting to "the caller passed no explicit `names`"), and
  both shipped tools pass it explicitly. ADR-0016.
- **The dispatch concurrency cap honours `dispatchConcurrency` (default 8) and rejects
  immediately instead of queueing.** The dispatcher used to read `maxParallelSubCalls`
  (default 10) and FIFO-queue the overflow; per ADR-0016 §2 the N+1th concurrent
  `pi.dispatch` now resolves at once with `{ status: "rejected", errorMessage:
"dispatch concurrency limit reached" }`. The cap applies to `pi.dispatch` only and
  has its own counter; builtin binding fan-out keeps DSH's `maxParallelSubCalls` (10)
  FIFO-queueing semantics (ADR-0004), so in-flight builtin calls never consume
  dispatch slots.
- **The depth-limit rejection message is verbatim again.** The program receives
  exactly `dispatch depth limit reached`, matching what the child's
  `<pi-ptc-context>` hint promises — the diagnostic suffix is gone.
- **`maxDispatchDepth` bounds recursion again.** Every run reported depth 0 and
  children never inherited it, so the depth check could never fire. `dispatch()` now
  stamps `PI_PTC_DEPTH` on the child subprocess's environment, the extension
  entrypoint reads it back, and `runPtcProgram()` accepts a `depth` baseline that
  reaches the binding context. ADR-0016 Recursive section.

## [0.1.1] - 2026-09-23

PTC runs inside one agent turn no longer pay a cold start each. Nothing changes in
what a program may call or return; the difference is latency and cancellation
behaviour.

### Changed

- **Per-turn worker pool.** One warm `worker_threads` Worker per surface
  (`run_code`, `workflow`) is kept for the duration of an agent turn and reused
  across its PTC runs — ~0 ms against ~58 ms for a cold spawn (median of 5). The
  pool is created lazily by the first PTC run of the turn, the two surfaces do not
  share one, and the extension's `turn_end` hook retires it. Idle workers are
  `unref()`-ed, so a warm pool never keeps `pi` alive. `runPtcProgram()` gains an
  optional `pool` field; without it the original cold-start path runs unchanged.
  ADR-0017.
- **The worker entry is a real `dist/worker.js`.** The `data:` URL built from
  `Function.prototype.toString()` is retired, so V8's code cache and Node's module
  cache survive warm reuse. TypeScript the _model_ submits at run time is still
  type-stripped inside the worker — that is `compileProgram`'s path, not the
  bootstrap's.

### Fixed

- **Cancellation settles within a bound in every ordering.** A still-armed deadline
  is the ceiling when a cancel arrives first; a worker that never answers a timeout
  settles at `timeoutMs + graceMs`. A superseded run's frames can no longer settle
  its successor, and an idle worker answers a cancel instead of making the host wait
  out its grace window. ADR-0017 §10.
- **`serializedBytes` no longer bills containers as zero bytes.** `[null × 100k]`
  was counted as nothing, so a frame could slip past `maxMessageBytes`; the helper
  now matches `JSON.stringify` byte-for-byte and sums `ArrayBuffer` / typed-array
  leaves.

## [0.1.0] - 2026-09-22

First npm release. Ports DSH PTC mode — Programmable Tool Calling, formerly
DSH "Code Mode" — to `pi`. Behaviour tracks
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).
Not a new design. Re-alignment.

Install with `pi install npm:pi-ptc-subagents`. PTC tools register on next
`pi` startup. No postinstall hook. No setup.

### Added

- **`ptc_run_code`**. Model submits a JS/TS program. Multiple tools execute
  in one shot. Return value and collected logs return to context. Worker
  protocol, dispatcher, and surfaces back it.
- **`ptc_workflow`**. Narration over `ptc_run_code`. Uses the in-program
  `log()` helper.
- **`pi.dispatch` binding**. PTC programs fan out to a fresh per-call `pi`
  subprocess. DSH parity.
- **Builtin bindings**. `read`, `bash`, `edit`, `write`, `grep`, `find`,
  `ls`. Callable from a PTC program as `tools.<name>(args)`. DSH parity.
- **Hoisted images**. Successful bindings lift image blocks onto the PTC
  tool result. The model sees the picture. The program never carries it
  through the return value. Parity with `dsh-tools`'s `exec.deferContext`.
- **Value-tree rendering**. Container completion values render as a tree.
  One row per property or array index. Bounded by depth and width caps.
  Withheld amount is shown in-band. Scalar values render as one-line hints.
- **Truncation contract**. Model-facing text honors `pi`'s truncation cap.
  Container values render as compact PTC rows.
- **Skills restored**. The skills section `pi` withholds is restored. PTC
  programs call them as bindings. DSH parity.
- **Build verification scripts**. `verify:dist`, `json-to-tui`,
  `preview-ptc-render`. Run before publishing.

### Changed

- Build pipeline switched to `vite-plus` (`vp pack`). Type declarations
  bundle via `rolldown-plugin-dts`.
- Tooling moved to pnpm 12.5.1. `vitest` coverage pinned. Lockfile
  determinism set via `minimumReleaseAge: 0`.
- Lint and format moved to `oxlint` (type-aware) and `oxfmt`.

### Fixed

- `pi.dispatch` now spawns `pi` directly. The host script used to swallow
  the child's exit.
- `maxPendingCalls` stays in the worker. The caller no longer trips on
  arrivals.
- Bindings mirror the session's active tools. A session that disables a
  tool also disables it inside PTC programs.
- pnpm overrides dropped. No-op under pnpm 12.5.1.
