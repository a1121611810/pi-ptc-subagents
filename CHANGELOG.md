# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
