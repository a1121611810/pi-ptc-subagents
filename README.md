# pi-ptc-subagents

Subagents and programmable tool calling for [pi](https://pi.dev).

One package, two capabilities:

- **Subagent fan-out** — dispatch a task to a fresh `pi` subprocess running a named agent
  (from `~/.pi/agent/agents/<name>.md` or `.pi/agents/<name>.md`), in isolation. Foreground
  await, or background with a lifecycle you can inspect and stop.
- **Programmable tool calling** — `ptc_run_code` / `ptc_workflow` run a JS/TS program in a
  worker; the program composes the session's tools as `tools.<name>(args)`, and only the
  program's return value plus its logs come back to the model.

pi ships its own programmable tool calling (`codemode` — a QuickJS sandbox that cannot spawn
processes). This package is the part that can spawn processes — subagents, background tasks,
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

- `ptc_subagent` — the top-level subagent face: dispatch a fresh `pi` subprocess for a task
  without writing a program. Registered only when the detected surface is `subagents`
  ([ADR-0025](./docs/adr/0025-extension-surface-is-a-setting.md)); on `full` the same
  capability is the `pi.dispatch` binding inside a program.
- `ptc_run_code` — run a JS/TS program that composes tool calls; the program reaches the
  session's enabled built-in tools as `tools.read(...)`, `tools.write(...)`, etc.
  (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), plus `tools["pi.dispatch"]`;
  its return value and `console.log` output are reported back.
- `ptc_workflow` — structured variant with `meta` + plain-JSON `args`, plus the workflow
  helpers (`log`, `phase`, `parallel`, `pipeline`). There is no `agent()` helper on either
  surface.
- `ptc_task_list` / `ptc_task_output` / `ptc_task_stop` — manage background dispatches
  (see [Background dispatch](#background-dispatch)). They stay available when PTC mode is off.

Long output follows pi's own truncation contract ([ADR-0015](./docs/adr/0015-pi-truncation-contract.md)):
the text block keeps the tail (50 KB / 2000 lines), the untruncated text is written to a temp
file the next program can `tools.read`, and the collapsed row shows `truncated` in its meta.

## Dispatch (fan-out to per-call pi subprocesses)

PTC programs can spawn a fresh `pi` subprocess per call via the **`pi.dispatch(...)`** binding
([ADR-0016](./docs/adr/0016-ptc-dispatch-binding.md)) — the child loads the named agent's
markdown, runs that agent's tool set and system prompt in isolation, and returns a structured
result. Bindings live in the one `tools` table — there is no `pi` global in the worker — so
the binding is called as `tools["pi.dispatch"]({ … })` with a single object argument.

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

**Fan out in parallel** with the rest of PTC's tools — dispatch is a binding, not a
model-visible lifecycle tool, so the dispatcher handles concurrency the same way it does for
any other tool call:

```ts
const [read, scoutA, scoutB] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools["pi.dispatch"]({ agent: "scout", task: "review auth" }),
  tools["pi.dispatch"]({ agent: "scout", task: "review db" }),
]);
```

**The child report.** A dispatched child returns more than prose: under the report contract
([ADR-0032](./docs/adr/0032-child-report.md)) it hands back a `summary`, `findings` each
carrying independent evidence, `files_touched`, and token usage the host measured. The
result names the channel that delivered it — `"tool"`, `"prompt-json"`, or `"none"` — and
`"none"` means the child ran but did not comply, which must not read as "returned nothing".
An agent opts out with one frontmatter line, `childReport: false`, and its channel reads
`"opted-out"`. `ptc_subagent` renders the same report into the text the model reads, bounded
at 20 findings with the withheld count stated in-band.

**Bounded.** Three knobs keep fan-out from running away:

- `PtcConfig.dispatchConcurrency` (default **8**) — one counter per pi session, spent by
  foreground dispatches, the `ptc_subagent` front, and live background children. A call over
  the cap resolves `{ status: "rejected", errorMessage: "dispatch concurrency limit reached" }`
  instead of queueing.
- `PtcConfig.maxDispatchDepth` (default **3**) — recursion bound; the child sees a
  `<pi-ptc-context depth="N" max-depth="M">` hint so it can budget its own recursion.
- `signal` — when the parent run is cancelled, every in-flight child gets `SIGTERM` then
  `SIGKILL` after a 5-second grace window.

### Background dispatch

Foreground `pi.dispatch` blocks the program until the child exits. Pass `background: true` to
spawn the child and return immediately with a `DispatchHandle`
([ADR-0022](./docs/adr/0022-background-dispatch.md)); the child outlives both the program and
the turn:

```ts
const handle = await tools["pi.dispatch"]({
  agent: "scout",
  task: "audit the auth code",
  background: true,
  label: "auth audit", // defaults to task.slice(0, 64)
});
// handle: { taskId: "01J…", label: "auth audit", status: "running" }
```

A detached pump drives the task's lifecycle (`running` -> `succeeded` / `failed` / `canceled`
/ `lost`). The model observes it with three always-on tools — they survive `/ptc off` and are
registered on every surface:

- `ptc_task_list({ status?, limit? })` — this session's tasks, newest first (default limit 100).
- `ptc_task_output({ taskId, sinceBytes? })` — a task's captured output, tail-truncated to the
  50 KB / 2000-line contract (ADR-0015).
- `ptc_task_stop({ taskId, reason? })` — ask a running task to stop.

Background tasks count against the same `dispatchConcurrency` for their whole lifetime and
share the `maxDispatchDepth` bound. A background task is owned by the dispatching pi process
(ADR-0023): it survives programs, turns, and `/ptc off`, and ends when that session ends. Full
guide: [`docs/usage/bgdispatch.md`](./docs/usage/bgdispatch.md).

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

## Images

An image read _inside_ a program — `await tools.read({ path: "shot.png" })` — is attached to
the PTC tool result as a real image block, so the model sees the picture instead of a marker
string or a wall of base64 ([ADR-0014](./docs/adr/0014-image-hoisting.md)). Nothing is capped
or deduped: every image the program's tool calls produced is attached, in call order; the
collapsed row's meta shows the count (`· 1 image`).

## PTC default mode

On a TUI start the session narrows its tool loadout so the built-in tools are reachable only
_from inside a program_: the model calls `ptc_run_code` / `ptc_workflow` (or `ptc_subagent`)
and reaches `read` / `bash` / `edit` / `write` / `grep` / `find` / `ls` through
`tools.<name>(args)` inside it. Tools contributed by _other_ extensions (`web_search`, `todo`,
…) stay directly callable. Turn it off for one session with `/ptc off` (also `/ptc on`, `/ptc`
for status), permanently with `{ "defaultMode": false }` in `~/.pi/agent/ptc.json`.

Which model-facing tools this package registers is **detected, not configured** — there is no
setting for it ([ADR-0034](./docs/adr/0034-surface-is-detected-not-set.md)). The short version:
a pi whose `codemode` is loaded _and_ callable by the model gets the `subagents` surface
(`ptc_subagent` on top; the program pair underneath at `codemode` reach); every other pi gets
`full` (`ptc_run_code` / `ptc_workflow` model-visible). To use the `subagents` surface, put
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
