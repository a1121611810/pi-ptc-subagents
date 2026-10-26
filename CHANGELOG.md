# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.2] - 2026-10-26

### Fixed

- **Program-internal tool calls work across the whole supported range.** The tool
  execution context sits in a different argument slot on older pi releases, so the
  bridge now identifies it by "whoever carries `executeTool`" instead of a fixed position.
- **Tools return text to programs on every version.** pi 0.99–1.0.3 hand back a
  content-block array where 1.0.4+ hands back a string; the bridge normalises both into
  text, so `tools.read` reads the same way everywhere.
- **The binding scope is read from the session's own tool set.** On pi 0.86 and 0.87
  `getActiveTools()` lists only an extension's own tools, so the built-in tools are taken
  from `getAllTools()` there; on 0.99+ the active set is the declared set and is used as is.
- **A clear message where the platform has no channel at all.** pi 0.86 and 0.87 expose no
  nested tool execution API; a program's `tools.*` call now says so — "this pi version has
  no in-program tool channel (needs pi ≥ 0.99)" — instead of failing vaguely.

## [6.0.1] - 2026-10-26

### Fixed

- **Programs can call the session's tools again.** The binding bridge looked for
  `ctx.executeTool` on the session context. pi 1.4.0 exposes it on the **tool execution
  context** — `execute(toolCallId, params, signal, onUpdate, ctx)` — with the signature
  `executeTool(name, args, options)`. Every `tools.*` call inside a program failed with
  "executeTool 不可用". Measured on a real pi: a program that reads `/etc/hosts` now gets
  its length back.
- **Route details ship with the package and resolve.** The seven `docs/routes/*.md` files
  are in the npm tarball now, and the route index points at their absolute path inside the
  installed package, so the model's `read` finds them instead of a path relative to the
  user's project.

### Changed

- **PTC mode no longer narrows the tool loadout.** On pi 1.4.0 a tool is callable from a
  program only while it is active, so narrowing took `tools.read` away from programs too
  ("Tool read not found"). A built-in tool's exposure is not an extension's to set, so the
  two cannot both hold. PTC mode is now a routing lead in the system prompt: the built-in
  tools stay visible and callable, from the model and from programs.

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
