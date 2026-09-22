# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
