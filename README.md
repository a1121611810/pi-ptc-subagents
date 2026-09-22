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

Long output follows pi's own truncation contract ([ADR-0015](./docs/adr/0015-pi-truncation-contract.md)):
the text block keeps the tail (50 KB / 2000 lines) and the untruncated text is written to a temp file
the next program can `tools.read`; the collapsed row then shows `truncated` in its meta.

## TUI rendering

Both tools register custom `renderCall` / `renderResult` hooks, so a PTC run reads as a program
rather than as yet another file operation ([ADR-0013](./docs/adr/0013-ptc-row-compact-summary.md)):

```
PTC  Verify the inserted image file
  → {file, clipNow}                        • 6 output lines · 1 image · 536ms
```

The call row is the tool label plus the model's `description`. The result row is one line: the
completion value as a short hint (`→ …`, or `done`, or `failed: <reason>` in red) with the run's
countable facts — output lines, workflow phases, attached images, warnings, duration — pinned to the
right edge. The payload itself is never printed: a value that does not fit collapses to its shape
(`{file, clipNow}`) and a multi-line string to its first line plus `(+N lines)`. Expanding a row
(ctrl+e) adds the code head, phase roll-up, `console.log` output, plan-drift warnings and the full
completion value, each block labelled and capped. `renderShell` stays at pi's default, so these rows
keep the same box and colors as the built-in tools.

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

**Where it does not run.** Print / JSON / RPC sessions are left exactly as launched, and so is a
session started with an explicit tool restriction (`--tools`, `--exclude-tools`,
`--no-builtin-tools`) — the extension does not override what you asked for. If another extension
changes the tool set while the mode is on, the mode yields and tells you.

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
