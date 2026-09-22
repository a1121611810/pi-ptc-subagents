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
pnpm test             # node --test over tests/**/*.test.ts
pnpm run build        # rolldown bundle + declaration emit
```

Tooling: [oxc](https://oxc.rs) — `oxlint` + `oxfmt` (official defaults) — alongside
`rolldown` (also oxc-powered) and TypeScript 7.

## License

Apache-2.0
