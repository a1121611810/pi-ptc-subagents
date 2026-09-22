# Glossary — pi-ptc-subagents

Terms captured during wayfinder chart session on 2026-09-21. This is glossary
only — no implementation lives here. Source of truth for decision-records is
the wayfinder map issue (`wayfinder:map` label).

## Project terms

**pi-ptc-subagents** — this npm package. Hosts a pi extension that implements
DSH PTC mode. The repo name carries `-subagents` for historical reasons (a
previous `pi-subagents` peer existed); **subagents are explicitly not in scope
for the current effort** (see wayfinder map, 2026-09-21 grill round 3).

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

**binding** — a pi tool whose `execute` is callable from within a PTC
program as `tools.<name>(args)`. DSH uses a generated TS SDK with one
typed function per tool. The pi version is data-driven via the
`BINDING_NAMES` whitelist (not yet built for this effort; pin during G1 /
G2 decision).

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
  There is no `agent()` (G1 #13 decision B — that seam is deferred to a
  future map). The `result(value)` form in `ptc_workflow` is the script's
  async return, materialized lossless-JSON.

**run_code** — the model-facing tool name DSH exposes in PTC mode. The pi
version exposes `ptc_run_code` to avoid collision with pi's hypothetical
future native `run_code`, plus a sidekick `ptc_workflow` for structured
(with `meta` + `args`) runs.

## Out-of-glossary (do not confuse)

- **DSH `subagent`** (a separate dsh concept: continuable sub-agent with
  capability flags) is NOT the same as the historical `pi-subagents` npm
  package. Neither is in scope here; both surface only via the `agent()`
  helper stub.

- **DSH preset / agent-preset** (Standard / PTC / Minimal / Creative) is a
  dsh-side concept. pi has no equivalent preset system today; this package
  is _only_ the PTC mode implementation, not a preset framework.
