# pi-ptc-subagents

Subagents and programmable tool calling for [pi](https://pi.dev).

One package, two capabilities:

- **Subagent fan-out** — dispatch a task to a fresh `pi` subprocess running a named agent
  (from `~/.pi/agent/agents/<name>.md` or `.pi/agents/<name>.md`), in isolation. Wait for the
  result, or take a handle and watch its lifecycle instead.
- **Programmable tool calling** — `ptc_run_code` / `ptc_workflow` run a JS/TS program in a
  worker; the program composes the session's tools as `tools.<name>(args)`, and only the
  program's return value plus its logs come back to the model.

pi ships its own programmable tool calling (`codemode` — a QuickJS sandbox that cannot spawn
processes). This package is the part that can spawn processes — subagents, task lifecycles,
a real Node runtime inside programs — and it composes with `codemode` instead of replacing
it. On a session where pi's `codemode` orchestrates, this package registers underneath it as
the execution layer ([ADR-0025](./docs/adr/0025-extension-surface-is-a-setting.md)); the deep
dive lives in [docs/usage/surface.md](./docs/usage/surface.md).

**Source is open.** This repository is public and the source is here — `dist/` on npm is the
compiled form of what you read below. Contributions go through pull requests: see
[CONTRIBUTING.md](./CONTRIBUTING.md) for the gate your PR has to pass, and
[SECURITY.md](./SECURITY.md) before reporting anything. Releases are cut from `main` by the
maintainer only; if you find something you think needs a release, open an issue and say so.

## Install

```bash
pi install npm:pi-ptc-subagents
```

From a local checkout: `pnpm install && pnpm run build && pi install /abs/path/to/this/repo`.

pi reads the `pi.extensions` manifest field — install it and the extension is on for the next
pi startup, no extra setup.

**What that command actually writes is in [docs/how-to-install.md](./docs/how-to-install.md)** — worth reading before you install, if you would rather know where the settings entry goes.

Documentation site: **[pi-ptc-subagents on GitHub Pages](https://a1121611810.github.io/pi-ptc-subagents/)**. Every page under its Documentation section is projected at build time from the files in `docs/`, so it never says anything this README does not.

## Tools

- `pi_task_codemode` — the dispatch door on the `codemode_ptc` surface: start a fresh `pi`
  subprocess for a task, called from inside a codemode script. Registered only when the
  detected surface is `codemode_ptc` ([ADR-0025](./docs/adr/0025-extension-surface-is-a-setting.md));
  on `full_ptc` the same capability is the `pi_task_ptc` binding inside a PTC program.
- `ptc_run_code` — run a JS/TS program that composes tool calls; the program reaches the
  session's enabled built-in tools as `tools.read(...)`, `tools.write(...)`, etc.
  (`read`, `edit`, `write`, `grep`, `find`, `ls`), plus `tools.pi_task_ptc`;
  its return value and `console.log` output are reported back. `tools.bash(...)` is an
  **opt-in** — see [Trust posture](#trust-posture-read-me).
- `ptc_workflow` — structured variant with `meta` + plain-JSON `args`, plus the workflow
  helpers (`log`, `phase`, `parallel`, `pipeline`). There is no `agent()` helper on either
  surface.
- `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` — the task face: list this session's
  tasks, read a task's output, stop a task (see [Waiting or not](#waiting-or-not)). They are
  there whenever the session has a task record, and they stay available when PTC mode is off.
- `web_ds_search` — searches the web (or fetches one page) through DeepSeek's Search API.
  **Off by default**, and it exists **only inside a dispatched child** — a parent session does
  not have it at all, and the child's own model calls it as a tool of its own. See
  [Web search](./docs/usage/web-ds-search.md).

Long output follows pi's own truncation contract ([ADR-0015](./docs/adr/0015-pi-truncation-contract.md)):
the text block keeps the tail (50 KB / 2000 lines), the untruncated text is written to a temp
file the next program can `tools.read`, and the collapsed row shows `truncated` in its meta.

## Dispatch (fan-out to per-call pi subprocesses)

An orchestrator can spawn a fresh `pi` subprocess per call through the **dispatch door** —
`tools.pi_task_ptc({ … })` inside a PTC program, `tools.pi_task_codemode({ … })` inside a
codemode script ([ADR-0016](./docs/adr/0016-ptc-dispatch-binding.md)). The child loads the named
agent's markdown, runs that agent's tool set and system prompt in isolation, and returns a
structured result. Bindings live in the one `tools` table — there is no `pi` global in the worker —
so the call takes a single object argument.

**There is no top-level "dispatch a subagent" tool.** The model always goes through its own
orchestrator: a program on `full_ptc`, a codemode script on `codemode_ptc`. One door, two planes,
the same behaviour on both. What the model sees is `pi_task_…` — it starts a **task**, and
dispatching is what the task side does behind the door.

```ts
// inside a ptc_run_code program
const result = await tools.pi_task_ptc({
  agent: "scout",
  task: "find all auth code in src/",
  cwd: process.cwd(),
  wait: true,
});

// result.status: "fulfilled" | "rejected"  (the binding never throws)
// result.text:   final assistant text
// result.taskId: "01J…"  — the task record this call created
// result.usage:  { input, output, cacheRead, cacheWrite, cost, turns }
// result.observedProvider?, result.observedModel?: the provider/model the child actually ran
// result.exitCode, result.durationMs, result.stderr?, result.errorMessage?
```

Every call creates a **task** — a record in this session's task registry — and `wait` decides
only whether the call waits for it (see [Waiting or not](#waiting-or-not)). Nothing throws: a
call that is turned down comes back as `status: "rejected"` with an `errorMessage`.

**Fan out in parallel** with the rest of the tools. Use `Promise.allSettled`: a child that fails
outright still reports through its own record, and one rejection must not swallow the siblings'
results.

```ts
const [read, scoutA, scoutB] = await Promise.allSettled([
  tools.read({ path: "package.json" }),
  tools.pi_task_ptc({ agent: "scout", task: "review auth", wait: true }),
  tools.pi_task_ptc({ agent: "scout", task: "review db", wait: true }),
]);
```

**The child report.** A dispatched child returns more than prose: under the report contract
([ADR-0032](./docs/adr/0032-child-report.md)) it hands back a `summary`, `findings` each
carrying independent evidence, `files_touched`, and token usage the host measured. That
measurement is written to the task record itself, on every terminal close for a child that
started — so a child that reported nothing, or failed, still shows what it cost, and a
foreground child's report is still readable after the call returned. The result names the channel
that delivered it — `"tool"`, `"prompt-json"`, or `"none"` — and `"none"` means the child ran but
did not comply, which must not read as "returned nothing". An agent opts out with one frontmatter
line, `childReport: false`, and its channel reads `"opted-out"`. The door renders the same report
into the text the model reads, bounded at 20 findings with the withheld count stated in-band.

**Concurrency and bounds.** Three knobs keep fan-out from running away:

- `PtcConfig.dispatchConcurrency` (default **8**) — how many children may run at once, counted
  per pi session and shared by every door. A call over the cap does **not** fail: it **queues**.
  The queue is FIFO and unbounded, and a queued call is admitted as soon as a slot frees — the
  shape libuv's thread pool uses, where fifty arrivals mean forty-six wait rather than six
  rejections. A queued call is already a task, so `ptc_task_list` shows it and `ptc_task_stop`
  can pull it out before it starts. The trade-off: the cap now bounds how many children run at
  once, not how many a session may have in flight.
- `PtcConfig.maxDispatchDepth` (default **3**) — recursion bound; the child sees a
  `<pi-ptc-context depth="N" max-depth="M">` hint so it can budget its own recursion.
- `signal` — when the parent run is cancelled, every in-flight child gets `SIGTERM` then
  `SIGKILL` after a 5-second grace window, and every call still waiting for a slot is dropped.

### The child's model

A dispatched child is a fresh `pi` subprocess and resolves its own model, first match wins:

1. the dispatch's `model` argument;
2. the named agent definition's frontmatter `model:`;
3. **the caller session's current model** — read from the pi session that spawns the child;
4. pi's configured default.

Tier 3 is the behaviour change of [ADR-0044](./docs/adr/0044-a-dispatch-inherits-the-session-model.md):
a session that switched provider or model mid-conversation carries that switch into the children it
dispatches, instead of silently running them on pi's global default. Resolution happens once, at
spawn — a model switched afterwards does not change a child that is already running, and a nested
dispatch inherits the child's own session model. Pin the model at the call site or in the agent
definition to opt out; there is no config key for it, and a direct library caller (or a pi that
exposes no session model) falls back to pi's default exactly as before.

The result says which model the child actually ran: `observedProvider` / `observedModel` on the
`DispatchResult` a waiting call returns, the same optional pair on a task record (which
`ptc_task_output` renders as a line), and a `model: provider/id` line in the dispatch row.
Absence means no
observed assistant turn named the pair — no turn, a supported pi that does not report it, or an
old record — never "unknown model". When the child reported its own failure, a
rejected dispatch now states that error verbatim as `errorMessage` instead of the generic
`dispatch produced no final text`, so the failure reads the same whether the call waited or not.
Full
guide: [`docs/usage/bgdispatch.md`](./docs/usage/bgdispatch.md#which-model-the-child-runs).

### Waiting or not

One door, one path. The call creates a task and the only question is whether the call waits for
it. Pass `wait: true` to wait:

```ts
const result = await tools.pi_task_ptc({
  agent: "scout",
  task: "audit the auth code",
  wait: true,
});
```

Leave `wait` out — the default is **not** to wait — and the call returns a handle at once, while
the child keeps running after both the program and the turn are gone
([ADR-0022](./docs/adr/0022-background-dispatch.md)):

```ts
const handle = await tools.pi_task_ptc({
  agent: "scout",
  task: "audit the auth code",
  label: "auth audit", // defaults to task.slice(0, 64)
});
// handle: { taskId: "01J…", label: "auth audit", status: "queued" }
```

The handle is a snapshot taken when the call returns: its `status` is the task's state at that
moment — `queued` while it waits for a slot, `running` once the child is up. The record moves on
from there, and `ptc_task_list` shows the live state. A call
that is turned down does not throw on either door: it returns the rejection result with
`status: "rejected"` and an `errorMessage`, so a not-waiting call cannot be assumed to return a
handle.

A detached pump drives the task's lifecycle (`queued` -> `running` -> `succeeded` / `failed` /
`canceled` / `lost`). The model observes it with three tools that are there whenever the session
has a task record — they survive `/ptc off` and are registered on every surface:

- `ptc_task_list({ status?, limit? })` — this session's tasks, newest first (default limit 100).
- `ptc_task_output({ taskId, sinceBytes? })` — a task's captured output, tail-truncated to the
  50 KB / 2000-line contract (ADR-0015).
- `ptc_task_stop({ taskId, reason? })` — ask a running task to stop, or pull a queued one out of
  the queue before it starts.

Tasks share the same `dispatchConcurrency` slots and the `maxDispatchDepth` bound. A task is
owned by the dispatching pi process (ADR-0023): it survives programs, turns, and `/ptc off`, and
ends when that session ends. Full guide:
[`docs/usage/bgdispatch.md`](./docs/usage/bgdispatch.md).

## Program semantics

A PTC program runs in **strict mode**. Assigning an undeclared variable is a `ReferenceError`
rather than a silent global, top-level `this` is `undefined`, and a duplicate parameter is a
compile-time `SyntaxError`. A program may still write `"use strict";` itself — that stays legal,
and is a no-op.

This is not a preference: upstream DSH materializes every program with a `'use strict'` prefix,
and the TypeScript a program is written in already implied it — TS emits `alwaysStrict` for
modules, and stripping the types was quietly dropping it. Two measured costs go away with it:

- **No implicit globals at all.** In sloppy mode, assigning to an undeclared name really does
  create one on the worker's global object (measured: an own enumerable property). The worker's
  warm-baseline restore deletes it before the next run, so today it does not reach the next
  program — but it exists, and its cleanup is a separate mechanism. Strict mode makes it never
  exist.
- **Typos are loud.** Reading an undeclared name already threw in sloppy mode — that was never
  the silent case. The silent one was the write side: assigning to a misspelled name quietly
  created a global. Strict mode turns that into a `ReferenceError` at the point of the mistake.

It is a breaking change, and there is no opt-out — JavaScript has no `"use sloppy"`.

## The route table the model reads

A session's system prompt carries a **routing index** from this package: one line per road —
when to take it, how to take it here, and where the whole story is.

```
Routes — one line each: when to take the road, how to take it here, and the file with the whole story.

- Use the built-in tools — one or two calls would do, and there is nothing to gather between them: not directly in PTC mode: the built-in tools are hidden from you and reached from inside a program (`tools.read({ path })` inside `ptc_run_code`). Details: docs/routes/use-the-built-in-tools.md.
```

There are seven roads today, and each has a file of its own under `docs/routes/` — how to call it,
what comes back, the pitfalls. Those files ship with the package, and the model opens them on
demand with pi's own `read` tool.

The index is the only part that is always resident, and it is **byte-identical every turn** —
rebuilding it mid-session would invalidate the prompt cache. It has a token budget (560; the
seven roads cost about 483 today), and when it grows past it the index says so (`> WARNING: …`)
instead of quietly dropping a road: a road that is missing is one the model can neither take nor
know it is missing.

Two things are worth knowing about it:

- **The prose has one source.** Every sentence the model reads about these tools — what one is,
  when to pick it, what it returns — is written once, in the package's route registry, and
  rendered from there into the index, the tool descriptions and the guidelines. A fact cannot
  drift between two channels, because it is only ever written in one.
- **A road is not a tool.** It is a way of doing something, and it says how to take it on each
  surface — including, on a surface that does not offer it, that it does not.

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

The completion value renders as a **value tree** — one row per property, nested containers
behind `├─` / `└─` / `│`, capped at 4 levels deep / 6 children per container / 120 characters
per row, with the withheld amount stated in-band. A scalar is one line (`→ 47`, `done`, or
`failed: <reason>` in red). The text block the model reads is a separate contract with its own
bounds ([ADR-0012](./docs/adr/0012-model-facing-result-text.md)): a compact value under 100
characters stays on one line, every line caps at 200. Nothing is ever printed as escaped JSON.

A dispatch call row follows the same rule: it reads as a heading — agent, state flags, and
a pinned model when the caller set one — plus one task preview line and a withheld count, and
`ctrl+e` expands the `label` / `why` rows and the task block (the first task line plus up to
`MAX_LOG_LINES_EXPANDED` continuation lines). A dispatch's long prose is never dumped as its
JSON-escaped argument string.

## Images

An image read _inside_ a program — `await tools.read({ path: "shot.png" })` — is attached to
the PTC tool result as a real image block, so the model sees the picture instead of a marker
string or a wall of base64 ([ADR-0014](./docs/adr/0014-image-hoisting.md)). Nothing is capped
or deduped: every image the program's tool calls produced is attached, in call order; the
collapsed row's meta shows the count (`· 1 image`).

## PTC default mode

On a TUI start the session narrows its tool loadout so the built-in tools are reachable only
_from inside a program_: the model calls `ptc_run_code` / `ptc_workflow`
and reaches `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` through
`tools.<name>(args)` inside it. Tools contributed by _other_ extensions (`web_search`, `todo`,
…) stay directly callable.

`/ptc off` **truncates** this package's place in the chain rather than flipping a switch: on
`full_ptc` the orchestration layer itself (`ptc_run_code` / `ptc_workflow`) is withdrawn and the
model is back to calling the built-ins directly; on `codemode_ptc` pi's `codemode` keeps
orchestrating, but the layer under it that belongs to this package — the program pair and the
task door — is withdrawn with it. Either way there is no way left to start a child. Tasks that
already exist stay inspectable and stoppable, and the ones already running keep running. Turn
it back on with `/ptc on` (`/ptc` reports the status), or make it the permanent shape with
`{ "defaultMode": false }` in `~/.pi/agent/ptc.json`.

A dispatch may also carry the caller's **reason** for the slice: an optional `why` on the
dispatch door, which reaches the child as its own `<pi-ptc-why>` block after the
host's policy block, and never widens the task. It is on by default. Turn it off for one session
with `/ptc why off` (`/ptc why` reports the current value and whether it came from the session or
the file), or permanently with `{ "whyEnabled": false }` in `~/.pi/agent/ptc.json`. A value that is
not a boolean leaves the block **on** and says so at startup — a default-on switch that could turn
itself off on a typo is the wrong direction. A `why` that was dropped is reported on the dispatch
result (`whySuppressed`), never silently ([ADR-0043](./docs/adr/0043-a-why-switch-and-a-name.md)).

Which model-facing tools this package registers is **detected, not configured** — there is no
setting for it ([ADR-0034](./docs/adr/0034-surface-is-detected-not-set.md)). The short version:
a pi whose `codemode` is loaded _and_ callable by the model gets the `codemode_ptc` surface
(the dispatch door `pi_task_codemode` at `codemode` reach; the program pair underneath, also at
`codemode` reach); every other pi gets `full_ptc` (`ptc_run_code` / `ptc_workflow` model-facing).
To use the `codemode_ptc` surface, put
`codemode` in your tool list (`pi --tools read,bash,edit,write,codemode`, or `"defaultTools":
["read", "bash", "edit", "write", "+codemode"]`). To keep this package out of your sessions
entirely, run `pi config` and disable its extensions there.

The full detection table, startup notices, and edge cases (`--print`, `--no-extensions`,
untrusted projects) live in [docs/usage/surface.md](./docs/usage/surface.md).

## Trust posture (read me)

- Installing this package grants it the same machine access as any pi
  extension: PTC programs run as **you**, with no OS-level sandbox (ADR-0007).
- Bindings mirror the session's **enabled** built-in tools (`pi.getActiveTools()`):
  a session started with `--tools …` / `--no-builtin-tools` can only reach those
  tools from inside a PTC program. pi's default session has `read`, `bash`,
  `edit`, `write` — of which the default surface binds `read`, `edit`, `write`
  (see the next bullet).
- **`tools.bash(...)` is not in that default.** A PTC program runs as you, so a
  default shell binding hands every model-written program a shell with your own
  identity. It is granted explicitly, per install, in `~/.pi/agent/ptc.json`:

  ```json
  { "optInBindings": ["bash"] }
  ```

  An absent or unreadable file grants nothing, and a name in that list that is not
  an opt-in binding is reported at session start rather than ignored. The opt-in is
  separate from the session's tool set on purpose: **enabled is not granted** — pi
  having `bash` enabled says nothing about whether you agreed to hand it to a program.

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
PI_ROOT=<global-node-modules>/@earendil-works/pi-coding-agent \
  node scripts/preview-ptc-render.mjs   # print the rendered rows with real theme colors
```

Tooling: [oxc](https://oxc.rs) — `oxlint` + `oxfmt` (official defaults) — alongside
`rolldown` (also oxc-powered), `vite-plus` (bundles Vitest 4), and TypeScript 7.

See ADR-0009 for the Vitest adoption decision (reopens ADR-0008's earlier deferment).

## Credits

Built clean-room from the PTC behaviour of
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT,
Copyright (c) 2026 DeepSeek), read at tag `dsh-v0.2.0-rc.2`, and hosted by
[pi](https://pi.dev) (`earendil-works/pi`, MIT). Full attribution, and what is
derived from what, is in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
