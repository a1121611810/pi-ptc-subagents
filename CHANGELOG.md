# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.0] - 2026-10-26

### Changed

- **Clean-room rewrite.** The package is rebuilt as seven packages — `entry`, `ptc`,
  `dispatch`, `task`, `tui`, `routes`, `search` — and ships as one self-contained
  artifact. The previous implementation is preserved on `backup/main-legacy-20261026`.
- **Two surfaces, detected.** `full_ptc` keeps the PTC pair model-facing; `codemode_ptc`
  registers underneath pi's codemode and exposes the task door to scripts. There is no
  setting.
- **Subagent dispatch is a task engine.** Every dispatch gets a record, a slot, and its
  own `pi` process. Busy means queue, not reject. Reports arrive through
  `ptc_child_report` first, with the trailing-JSON channel as fallback.
- **The task face** (`ptc_task_list` / `ptc_task_output` / `ptc_task_stop`) appears only
  while there is a task to see.
- **Web search lives in children.** `web_ds_search` registers only inside dispatched
  children and is off by default.

### Compatibility

- pi `>= 0.86.0`. Real-machine smoke tests cover 0.86.0, 0.87, 0.99, 1.0, 1.1, 1.2,
  1.3, and 1.4 — including a program that dispatches a real child process.
