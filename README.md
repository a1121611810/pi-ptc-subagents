# pi-ptc-subagents

DSH-style **PTC mode** (Programmable Tool Calling) for [pi](https://pi.dev):
the model writes a JS/TS program that calls pi's tools from inside a worker,
and only the program's return value plus its logs come back to the model.

## Status

Pre-1.0, but functional: `ptc_run_code` and `ptc_workflow` are registered and run
programs through the same tested worker machinery (dispatcher, wire protocol,
budgets, built-in bindings). The implementation is written clean-room from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) PTC
behaviour (tracked as a wayfinder map in this repo's issues).

## Install

```bash
pi install npm:pi-ptc-subagents
```

From a local checkout: `pnpm install && pnpm run build && pi install /abs/path/to/this/repo` (or `npm install && npm run build && …` — the lockfile is `pnpm-lock.yaml`; with npm you'll need `npm i` to regenerate `package-lock.json`).

pi reads the `pi.extensions` manifest field, so no extra setup steps are
required — install it and the extension is on for the next pi startup.

## Tools

- `ptc_run_code` — run a JS/TS program that composes tool calls; the program
  reaches tools as `tools.read(...)`, `tools.write(...)`, etc. (all seven
  built-ins, `bash` included); its return value and `console.log` output are
  reported back.
- `ptc_workflow` — structured variant with `meta` + plain-JSON `args`, plus the
  workflow helpers (`log`, `phase`, `parallel`, `pipeline`). There is no
  `agent()` helper on either surface.
- `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` — manage background
  dispatches (see [Background dispatch](#background-dispatch)). They stay
  available when PTC mode is off.

Long output follows pi's own truncation contract ([ADR-0015](./docs/adr/0015-pi-truncation-contract.md)):

the text block keeps the tail (50 KB / 2000 lines) and the untruncated text is written to a temp file

the next program can `tools.read`; the collapsed row then shows `truncated` in its meta.

## Dispatch (fan-out to per-call pi subprocesses)

PTC programs can spawn a fresh `pi` subprocess per call via the **`pi.dispatch(...)`** binding ([ADR-0016](./docs/adr/0016-ptc-dispatch-binding.md)). Use it to fan out to a specialist agent — the child subprocess loads the named agent's markdown from `~/.pi/agent/agents/<name>.md` (or `.pi/agents/<name>.md` for project-scope agents), runs that agent's tool set and system prompt in isolation, and returns a structured result.

Bindings are reached through the one `tools` table — there is no `pi` global in the worker — so the binding named `pi.dispatch` is called as `tools["pi.dispatch"]({ … })` with a single object argument.

```ts
// inside a ptc_run_code program
const result = await tools["pi.dispatch"]({
  agent: "scout",
  task: "find all auth code in src/",
  cwd: process.cwd(),
});

// result.status: "fulfilled" | "rejected"  (the binding never throws)
// result.text:   final assistant text
// result.usage:  { input, output, cacheRead, cacheWrite, cost, turns }
// result.exitCode, result.durationMs, result.stderr?, result.errorMessage?
```

**Fan out in parallel** with the rest of PTC's tools — dispatch is a binding, not a model-visible lifecycle tool, so the dispatcher handles concurrency the same way it does for any other tool call:

```ts
const [read, scoutA, scoutB] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools["pi.dispatch"]({ agent: "scout", task: "review auth" }),
  tools["pi.dispatch"]({ agent: "scout", task: "review db" }),
]);
```

**Bounded.** Three knobs keep fan-out from running away:

- `PtcConfig.dispatchConcurrency` (default **8**) — hard cap on concurrently in-flight dispatch **in one pi session**. It is one counter, not one per run: foreground `pi.dispatch`, the top-level `ptc_subagent` front, and live background children all spend it, and a background child holds its slot for its whole lifetime. The N+1th concurrent call resolves immediately with `{ status: "rejected", errorMessage: "dispatch concurrency limit reached" }` instead of queuing or spawning — so a call over the cap is not made to wait for a slot to come back.
- `PtcConfig.maxDispatchDepth` (default **3**) — recursion bound. The child subprocess loads pi-ptc too, so it can write its own PTC programs and call `pi.dispatch` itself; the `childDepth = parentDepth + 1` is rejected when it would exceed `maxDispatchDepth`. The child sees a `<pi-ptc-context depth="N" max-depth="M">…</pi-ptc-context>` hint appended to its system prompt so it can budget its recursion.
- `signal` — when the parent run is cancelled (deadline, abort, user Esc), every in-flight child receives `SIGTERM` followed by `SIGKILL` after a 5-second grace window, the same shape as pi's `examples/extensions/subagent/index.ts` reference.

**What the concurrency cap now governs, and which knob is live.** The cap is **one counter per pi
session** ([ADR-0016](./docs/adr/0016-ptc-dispatch-binding.md) §2 as amended,
[ADR-0022](./docs/adr/0022-background-dispatch.md) §9), acquired inside `dispatch()` so a single
owner gates every front. Two consequences are worth stating plainly, because both were measured and
neither is a rounding difference: two programs running concurrently in one session now share 8
rather than 8 each, and a program sharing a session with eight live background children can be
refused **every** foreground slot. The live control is `createBackgroundTaskRuntime({ concurrency })`,
the call that builds that session counter, and the value it is given is `PtcConfig.dispatchConcurrency`.
It is not a background-only knob: changing it changes how many foreground children a whole session
can have in flight.

The `dispatchConcurrency` a caller passes to `runPtcProgram({ config })` sizes the
dispatcher's own per-run counter, and that counter is only reached when no session counter is
supplied (`dispatcher.ts` hands the binding `options.dispatchDeps?.slots ?? dispatchSlots`). In a
pi session a session counter always is, so the per-run one is not what enforces the cap you are
looking at.

**Opt out.** Pass an explicit binding subset to `createBuiltinBindings` to opt out — the parallel binding is mixed in only when the caller accepts the default set:

```ts
// in a hypothetical runner that wants to keep reads-only:
createBuiltinBindings({ cwd: "/abs/path", names: ["read", "grep"] });
// `pi.dispatch` is NOT in the resulting `tools` table.
```

**Not a subagent.** The term _subagent_ is overloaded in this field (DSH's `subagent` is a different thing; pi's `examples/extensions/subagent/` extension is also a different thing). pi-ptc uses _parallel binding_ and _concurrent tool call_ throughout; see `CONTEXT.md` for the canonical terms.

### Background dispatch

Foreground `pi.dispatch` blocks the program until the child exits. Pass `background: true` to spawn the child and return immediately with a `DispatchHandle` ([ADR-0022](./docs/adr/0022-background-dispatch.md)); the child outlives both the program and the turn:

```ts
// inside a ptc_run_code program — bindings are reached as tools["<name>"]
const handle = await tools["pi.dispatch"]({
  agent: "scout",
  task: "audit the auth code",
  background: true,
  label: "auth audit", // defaults to task.slice(0, 64)
});
// handle: { taskId: "01J…", label: "auth audit", status: "running" }
```

(The binding's name is `pi.dispatch`; a program reaches it as `tools["pi.dispatch"]`.)

A detached pump drives the task's lifecycle (`running` -> `succeeded` / `failed` / `canceled` / `lost`), and the model observes it with three always-on tools — they are not part of the PTC-mode loadout, so `/ptc off` (which only blocks new spawns) does not remove them. A background task is owned by the dispatching pi process (ADR-0023): it survives programs, turns, and `/ptc off`, ends when that session ends or the process dies, and no other pi process in the same directory can reap it (background dispatch children share the session's task storage, so pre-ADR-0023 any same-directory pi process — including a dispatch child itself — could reap every task on startup). Known edges: pre-upgrade ownerless records are still reaped by whichever process binds the directory first; a recycled pid can leave a record `running` after its owner died; and `ptc_task_stop` from another process can write a `stopping` state into your record even though the stop signal itself never crosses the process boundary:

- `ptc_task_list({ status?, limit? })` — list this session's tasks, newest first (default limit 100).
- `ptc_task_output({ taskId, sinceBytes? })` — read a task's captured output, tail-truncated to pi's 50 KB / 2000-line contract (ADR-0015).
- `ptc_task_stop({ taskId, reason? })` — ask a running task to stop.

Background tasks count against the same `dispatchConcurrency` (default 8) for their whole lifetime and share the `maxDispatchDepth` (default 3) recursion bound — and since the gate moved into `dispatch()` that cap is the **one session counter** the foreground path uses too, not a second one held beside it. A session running eight long background children therefore has no foreground dispatch headroom left, and a foreground call over the cap is refused outright rather than queued behind them. A pre-spawn refusal (depth or concurrency cap, unknown agent) still comes back as the familiar `DispatchResult` with `status: "rejected"`. Full guide: [`docs/usage/bgdispatch.md`](./docs/usage/bgdispatch.md).

## TUI rendering

Both tools register custom `renderCall` / `renderResult` hooks, so a PTC run reads as a program
rather than as yet another file operation ([ADR-0013](./docs/adr/0013-ptc-row-compact-summary.md)):

```
PTC  Find AssistantMessageComponent instantiations
  ├─ file: "chat-viewport.ts"                 • 1 output line · 1.42s
  ├─ instantiations: Array(3)
  │  ├─ [0] {file: "chat-viewport.ts", line: 23}
  │  ├─ [1] {file: "chat-viewport.ts", line: 47}
  │  └─ [2] {file: "chat-viewport.ts", line: 91}
  └─ totalLines: 47
```

The call row is the tool label plus the model's `description`. Under it, the completion value is
shown as a **tree**: an object or array with content gives one row per property (or index), nested
containers recurse behind `├─` / `└─` / `│` connectors, and a small all-scalar container collapses
onto one row (`{file: "a", line: 12}`). Depth caps at 4 levels, 6 children per container and 120
characters per row; whatever is withheld is reported (`…+N more keys`, a trailing `…`). A scalar
value is one line instead — `→ 47`, `→ {}`, `done` when the program returned nothing, or
`failed: <reason>` in red. The run's countable facts — output lines, workflow phases, attached
images, warnings, duration — stay pinned to the right edge of the area's first row. Nothing is ever
printed as escaped JSON. Expanding a row (ctrl+e) adds the code head, phase roll-up, `console.log`
output and plan-drift warnings, each block labelled and capped. `renderShell` stays at pi's default,
so these rows keep the same box and colors as the built-in tools.

The copy above is the human's. The text block the **model** reads is a separate contract with
separate bounds ([ADR-0012](./docs/adr/0012-model-facing-result-text.md)): a completion value whose
compact form fits in 100 characters stays on one line, and every line of the assembled block is
capped at 200 characters with a trailing `…`. Those are not the numbers above, and they are not
variants of them. **4 / 6 / 120** bound the on-screen tree — depth, children per container,
characters per row, aligned by visible width — because they serve the eye; **100 / 200** bound the
model's copy because they serve what the model has to read. Neither set derives from the other, so
moving 200 to 120 so they "match" is a behaviour change that needs its own ADR, not an edit to a
number on this page.

## Images

An image read _inside_ a program — `await tools.read({ path: "shot.png" })` — is attached to the PTC
tool result as a real image block, so the model sees the picture instead of a marker string or a wall
of base64. This is what DSH does by deferring a context message after the run
([ADR-0014](./docs/adr/0014-image-hoisting.md)). Nothing is capped or deduped: every image the program's
tool calls produced is attached, in call order, because how much context a run spends is the program's
call. The collapsed row's meta shows the count (`· 1 image`), so the volume is visible without being
policed. The program receives the image either way.

## PTC default mode

On a TUI start — install, restart, done — the session narrows its tool loadout so the built-in
tools are reachable only _from inside a program_:

```
PTC  Verify the inserted image file
  → {file, clipNow}                        • 6 output lines · 1 image · 536ms
```

The model calls `ptc_run_code` / `ptc_workflow`, and reaches `read` / `bash` / `edit` / `write` /
`grep` / `find` / `ls` through `tools.<name>(args)` inside the program. Tools contributed by _other_
extensions (`web_search`, `todo`, …) stay directly callable — they cannot become bindings
(`pi.getAllTools()` returns metadata, not `execute`), so hiding one would make it unreachable for
the session. The mode's rationale and rejected alternatives are in [ADR-0010](./docs/adr/0010-ptc-default-mode.md).

**Turning it off.** For one session: `/ptc off` (and `/ptc on`, `/ptc` for status). Permanently:

```jsonc
// ~/.pi/agent/ptc.json
{ "defaultMode": false }
```

**Choosing the surface.** `defaultMode` decides whether the session _enters_ PTC mode; `surfaceMode`
decides which model-facing tools this package registers at all. It is read once, at startup, so a
surface change needs a new session ([ADR-0025](./docs/adr/0025-extension-surface-is-a-setting.md)):

```jsonc
// ~/.pi/agent/ptc.json
{ "surfaceMode": "subagents" }
```

- `off` — a stock pi session: no tool, no `/ptc` command, no briefing.
- `subagents` — `ptc_subagent` plus the three `ptc_task_*` tools, with pi's own `codemode`
  doing the orchestration; warns at startup when `codemode` is not in the active tool set.
- `full` — today's set: `ptc_run_code` / `ptc_workflow` plus the three `ptc_task_*` tools.

**The default is detected, and it is not `full` everywhere.** With no `surfaceMode` key, the surface
follows two questions, not one ([ADR-0026](./docs/adr/0026-surface-default-is-detected.md),
[ADR-0027](./docs/adr/0027-codemode-switch-decides-surface.md)):

| does this pi ship `codemode`? | will pi load it?                               | surface     |
| ----------------------------- | ---------------------------------------------- | ----------- |
| yes                           | yes (default, or `+builtin:codemode`)          | `subagents` |
| yes                           | no (`-builtin:codemode`, or `--no-extensions`) | `full`      |
| no                            | —                                              | `full`      |

Setting the key always wins. A probe that cannot answer falls back to `full` — the safe direction,
since `subagents` as a failure mode would take away the orchestration tool the session was relying
on.

> Upgrading onto pi 0.99.1 or newer without setting the key moves you to `subagents`. `codemode`
> ships **inactive** (`defaultActive: false`), so until you add it to your tool list you get a
> subagent front with no orchestrator, and the startup warning says so. If you would rather keep
> today's tools, set `{ "surfaceMode": "full" }`.

> Turning pi's `codemode` **off** — `"extensions": ["-builtin:codemode"]`, or launching with
> `--no-extensions` — brings the PTC surfaces back on its own. Before ADR-0027 it did not: the
> detection asked only whether the extension directory exists, so a pi told not to load it still
> counted as an orchestrator and you got `ptc_subagent` with nothing to compose with. The switch is
> read from the same three places pi reads it — the command line, `<cwd>/.pi/settings.json`, and
> `<agentDir>/settings.json` — in the same order.

No file, or a value outside that set, falls back to the detected default and says so at startup
rather than half-applying: which tools exist is not something to change on a guess.

**A detection you cannot see is the failure this design has**, so the result is reported. With no
`surfaceMode` key, the outcome is issued through the TUI notification channel at session start —
how the probe came out and which surface the default therefore is — but only when the probe could
not answer. A pi that ships `codemode` and is detected as `subagents` is the expected case and says
nothing. A second notice is issued when the probe and pi's own tool registry disagree, which is the
case the probe structurally cannot see: it walks the filesystem, so under `--exclude-tools codemode`
it answers `present` for a tool this session does not have (and the mirror: a restructured `dist`
answers `not-found` for one pi plainly registers). A third notice covers ADR-0027: a settings file
that could not be read, and an explicit `surfaceMode` that disagrees with the table — the pinned
value still wins, and the notice only says so. What is **not**
established is that either line actually paints in a real pi TUI: a pty capture at review time
showed neither the notice nor a control marker, and a TUI quits on stdin EOF before a toast
renders, so that is an unmeasured end to end rather than a broken one. No test in this repository
observes a notice through a real TUI. If you are relying on the notice rather than on your own
`surfaceMode` key, verify it once.

**On a `--print` session, none of it prints.** `ui.notify` is the TUI channel; measured across
three `--print` runs that each emit one of these notices, stdout and stderr received **0 bytes**
each. That makes this page the only channel on which a `--print` user learns why they got the
surface they got — ADR-0025's decision-4 warning shares the gap, and there the answer is the same
one line of JSON: set `surfaceMode` yourself and the detection no longer matters.

**Where it does not run.** Print / JSON / RPC sessions are left exactly as launched, and so is a
session started with an explicit tool restriction (`--tools`, `--exclude-tools`,
`--no-builtin-tools`, `--no-extensions`) — the extension does not override what you asked for.
`--no-extensions` does, however, change the **detected surface**: pi's own `codemode` is a built-in
extension, so turning extensions off means it will not load, and ADR-0027's table resolves the
default to `full` — you keep `ptc_run_code` / `ptc_workflow` rather than a `ptc_subagent` with
nothing to compose with. If you would rather pin the surface regardless, set `"surfaceMode"` in
`ptc.json`. If another extension changes the tool set while the mode is on, the mode yields and
tells you.

**The important consequence:** in a TUI session, bindings come from the loadout recorded _before_
the mode narrowed it. That is what keeps `tools.read(…)` working — and it is why a `--tools`
restriction still holds: the snapshot is read from `pi.getActiveTools()`, so it can never contain
tools your session was not launched with.

## Trust posture (read me)

- Installing this package grants it the same machine access as any pi
  extension: PTC programs run as **you**, with no OS-level sandbox (ADR-0007).
- Bindings mirror the session's **enabled** built-in tools (`pi.getActiveTools()`):
  a session started with `--tools …` / `--no-builtin-tools` can only reach those
  tools from inside a PTC program (a default session has `read`, `bash`, `edit`,
  `write` — enable more to bind more).
- Tool calls made from inside a PTC program execute directly and **bypass**
  pi's `tool_call` hooks (permission gates, path guards) — see ADR-0005. Do not
  rely on those guards to constrain tool use while this extension is enabled.

## Development

```bash
pnpm install
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # oxlint          (`pnpm run lint:fix` applies fixes)
pnpm run fmt          # oxfmt (writes); `pnpm run fmt:check` verifies
pnpm test             # vp test --run --coverage (Vitest 4; coverage via @vitest/coverage-v8)
pnpm run test:watch   # vp test (interactive)
pnpm run test:ui      # vp test --ui (local browser UI; not for CI)
pnpm exec vp test --run tests/render-ptc.test.ts  # renderer unit tests only
pnpm run build        # vp pack + declaration emit
pnpm run verify:dist  # exercise renderCall/renderResult through the built dist (no LLM needed)
node scripts/preview-ptc-render.mjs   # print the rendered rows with real theme colors
```

Tooling: [oxc](https://oxc.rs) — `oxlint` + `oxfmt` (official defaults) — alongside
`rolldown` (also oxc-powered), `vite-plus` (bundles Vitest 4), and TypeScript 7.

See ADR-0009 for the Vitest adoption decision (reopens ADR-0008's earlier deferment).

## License

Apache-2.0
