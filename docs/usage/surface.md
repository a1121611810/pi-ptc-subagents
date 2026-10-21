# Surface detection — which orchestrator is responsible to the model

The README's "PTC default mode" section gives the short version. This page carries the deep
dive: the three questions, the notices, and the edge cases. Nothing here is configurable —
the surface is **detected, not configured** ([ADR-0034](../adr/0034-surface-is-detected-not-set.md)).

## What a surface is

**The surface is which orchestrator is responsible to the model**: this package's own PTC, or
pi's `codemode`. Two values:

- `full_ptc` — **this package's PTC orchestrates.** The model writes a program and runs it
  with `ptc_run_code` / `ptc_workflow`; the PTC door lives inside that program.
- `codemode_ptc` — **pi's `codemode` orchestrates.** The model composes tool calls in a
  `codemode` script, and this package's program is the execution layer underneath it. The
  codemode door (`pi_task_codemode`) is reachable from that script, so a child can be started
  without a PTC program at all.

Renamed on **2026-10-21** from `full` / `subagents`. The old pair named the _inventory_ — which
tools this package registers — and an inventory is not the question the model faces. `full` also
read as "everything is available", which was false: on that surface the PTC pair **is**
registered, at `codemode` reach, and is **not** model-facing. The new names say who orchestrates.
The detection did not change with the names: the same pi still lands on the same surface, and
only the name of that surface changed
([ADR-0051](../adr/0051-the-surface-names-the-orchestrator.md)).

Registration is not the same question as being offered, and it is not the same question as
orchestration. On the `codemode_ptc` line the PTC pair IS registered, at `codemode` reach, which
makes it callable from a pi `codemode` script without declaring it to the model:
`AgentSession._isDeclarable` admits `direct` and `model-only` only, so the request pi sends
still carries exactly one orchestrator and it is pi's. The two lines are therefore not two
orchestrators competing: `full_ptc` is this package composing tool calls, `codemode_ptc` is pi's
`codemode` composing tool calls with this package's program reachable underneath as the
execution layer ([ADR-0025](../adr/0025-extension-surface-is-a-setting.md) §3 as amended
2026-10-09).

## The three questions

The surface follows three questions, not one
([ADR-0026](../adr/0026-surface-default-is-detected.md),
[ADR-0027](../adr/0027-codemode-switch-decides-surface.md),
[ADR-0029](../adr/0029-surface-follows-codemode-activation.md)):

| does this pi ship `codemode`? | will pi load it?                               | can the model call it?                        | surface        |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------- | -------------- |
| yes                           | yes (default, or `+builtin:codemode`)          | yes (`--tools …,codemode`, or `defaultTools`) | `codemode_ptc` |
| yes                           | yes (default, or `+builtin:codemode`)          | no — **the default on a stock install**       | `full_ptc`     |
| yes                           | no (`-builtin:codemode`, or `--no-extensions`) | —                                             | `full_ptc`     |
| no                            | —                                              | —                                             | `full_ptc`     |

The third column is the one that decides most sessions, and it is why the answer is `full_ptc` on
a pi that has never been configured. pi ships `codemode` and loads it by default, but registers
it **inactive** (`defaultActive: false`) — it joins the model's tool list only when a loadout
names it. Handing orchestration to a tool the model cannot call is the failure this avoids, so
`codemode_ptc` is chosen only on positive evidence.

A probe that cannot answer falls back to `full_ptc` — the safe direction, since `codemode_ptc` as
a failure mode would take away the orchestration tool the session was relying on. There is no key
that overrides this, by design ([ADR-0034](../adr/0034-surface-is-detected-not-set.md)).

### Activation: pi answers for itself

The third question used to be answered by a settings mirror: the `--tools` allowlist, then the
merged `defaultTools`, replayed in pi's precedence. That mirror could not know whether pi had
been told to trust the project, so a project pi declined to read could still name `codemode`
there and put the session on a surface its orchestration tools could not reach. Since
2026-10-10 the answer is a live read: pi's own active tool set, asked at `session_start` with
`getActiveTools()` — the first moment the runtime exists, after pi has applied both the command
line and its project-trust decision ([ADR-0035](../adr/0035-ask-pi-for-the-loadout.md)).

One axis keeps a file-side read: pi's MCP extension can activate `codemode` at runtime by
calling `pi.setActiveTools` when an enabled MCP server's tools are only reachable from scripts
([ADR-0033](../adr/0033-mcp-auto-enable-evidence.md)). pi performs that activation from inside
its own `session_start` handler, so an extension reading the active set there loses the race:
measured, a synchronous read, a read one microtask later, and a read on a zero-delay timer all
see it inactive, and it appears ~250 ms later. So the file-side evidence answers a question the
live read is too early to have an answer to, and the probe unions the two. Either being
positive means the model can call `codemode`; `"mcp"` names the case where the loadout said
inactive and the evidence said otherwise.

Turning pi's `codemode` **off** — `"extensions": ["-builtin:codemode"]`, or launching with
`--no-extensions` — brings the PTC surfaces back on its own. Before ADR-0027 it did not: the
detection asked only whether the extension directory exists, so a pi told not to load it still
counted as an orchestrator and you got the codemode door with nothing to compose with. The switch
is read from the same three places pi reads it — the command line, `<cwd>/.pi/settings.json`,
and `<agentDir>/settings.json` — in the same order.

> In the **project-level** `.pi/settings.json`, write `"extensions": ["!dist/index.js"]` rather
> than `"extensions": []`. The two settings files are resolved by two different functions in pi
> (`package-manager.js:1850`): the personal-level path reads `[]` as "load nothing", the
> project-level path reads it as an empty delta, which means "no change".
>
> Measured on pi 1.1.0 against this package's own `dist/index.js`: a `packages` entry whose
> `extensions` is `[]` or `["!dist/index.js"]` is not loaded at all, while `["+dist/index.js"]`
> and an omitted key are. pi does this **without loading the extension**, which no value of a
> key this package reads could achieve.

**If you had `surfaceMode` in `ptc.json`, it is no longer read** — including `"off"`, so
upgrading brings this package back. At session start you get one `warning` naming the file and
pointing here. Delete the key to silence it. The values that key ever took are `off`,
`subagents` and `full`; they are history, and none of them is a surface value today.

## The notices

A detection you cannot see is the failure this design has, so the result is reported. The
outcome is issued through the TUI notification channel at session start — how the probe came
out and which surface therefore is — but only when the probe could not answer. A pi that ships
`codemode`, loads it, and has it in the tool list is the expected case and says nothing. A
second notice is issued when the probe and pi's own tool registry disagree, which is the case
the probe structurally cannot see: it walks the filesystem, so under `--exclude-tools codemode`
it answers `present` for a tool this session does not have (and the mirror: a restructured
`dist` answers `not-found` for one pi plainly registers). A third notice covers ADR-0027: a
settings file that could not be read. **A fourth notice was removed one commit after the change that
made `agent` optional** — issue #187, which that change blocked on, and not the same commit (ADR-0039
records the interval). It warned that a `codemode_ptc` session had no agent definitions, on
the reasoning that a registered-but-uncallable tool is indistinguishable from a working one. That
reasoning expired with the default it was written against: a dispatch that names nothing runs a
generalist child, so an install with an empty registry is a **working** install rather than a
degraded one, and the warning was a false alarm about a tool that worked. The `ptc-mode` status no
longer carries the marker either, for the same reason.

What is **not** established is that any of the remaining notices actually
paints in a real pi TUI: a pty capture at review time showed neither a notice nor a control
marker, and a TUI quits on stdin EOF before a toast renders, so that is an unmeasured end to
end rather than a broken one. No test in this repository observes a notice through a real TUI.

**On a `--print` session, none of it prints.** `ui.notify` is the TUI channel; measured across
three `--print` runs that each emit one of these notices, stdout and stderr received **0 bytes**
each. That makes this page the only channel on which a `--print` user learns why they got the
surface they got.

## What `/ptc off` truncates on each surface

`/ptc off` is a **truncation** of this package's place in the chain, not a switch that leaves a
door in place to refuse ([ADR-0058](../adr/0058-ptc-off-truncates-the-chain.md)). The cut lands
at the start of the segment this package controls, and **the two surfaces cut at different
places for exactly one reason: pi's `codemode` is not ours to withdraw.**

- **`full_ptc`** — the orchestrator is this package's own PTC, so the whole orchestration layer
  (`ptc_run_code` / `ptc_workflow`) is withdrawn and the model is back to calling the built-in
  tools directly. The task door (`pi_task_ptc`) lives inside a program, so withdrawing the
  program makes the door unreachable — there is no separate registration to take away.
- **`codemode_ptc`** — the orchestrator is pi's `codemode`, and it **stays**: `codemode` keeps
  orchestrating and can still call the built-in tools. What goes is this package's segment
  _underneath_ it — the execution layer (`ptc_run_code` / `ptc_workflow`) and the task door
  (`pi_task_codemode`).

The withdrawal itself is a same-name re-registration with `exposure: "hidden"`: pi cannot
unregister a tool, but `registerTool` is a `Map.set` on the tool name, so re-registering the same
name replaces the entry — and a hidden tool is in neither the set declared to the model nor the
set a `codemode` script may call.

**The model sees it from the next turn.** pi recomputes the declared set per model request, so the
request a model already sent still carries the old declaration; a call made in that window is
**refused** rather than silently accepted. The switch is session-scoped, and a resumed session
that carries the "off" record is truncated too.

## Where it does not run

Print / JSON / RPC sessions are left exactly as launched, and so is a session started with an
explicit tool restriction (`--tools`, `--exclude-tools`, `--no-builtin-tools`,
`--no-extensions`) — the extension does not override what you asked for. `--no-extensions`
does, however, change the **detected surface**: pi's own `codemode` is a built-in extension, so
turning extensions off means it will not load, and the table resolves to `full_ptc` — you keep
`ptc_run_code` / `ptc_workflow` rather than a codemode door with nothing to compose with. If
another extension changes the tool set while the mode is on, the mode yields and tells you.

**The important consequence:** in a TUI session, bindings come from the loadout recorded
_before_ the mode narrowed it. That is what keeps `tools.read(…)` working — and it is why a
`--tools` restriction still holds: the snapshot is read from `pi.getActiveTools()`, so it can
never contain tools your session was not launched with.
