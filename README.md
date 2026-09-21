# pi-ptc-subagents

DSH-style **PTC mode** (Programmable Tool Calling) for [pi](https://pi.dev):
the model writes a JS/TS program that calls pi's tools from inside a worker,
and only the program's return value plus its logs come back to the model.

## Status

Pre-1.0 baseline. The implementation is written clean-room from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) PTC
behaviour (tracked as a wayfinder map in this repo's issues); the tools land
progressively — `ptc_run_code` / `ptc_workflow` are not functional yet.

## Install

```bash
pi install npm:pi-ptc-subagents
```

From a local checkout: `npm install && npm run build && pi install /abs/path/to/this/repo`.

pi reads the `pi.extensions` manifest field, so no extra setup steps are
required — install it and the extension is on for the next pi startup.

## Tools (landing progressively)

- `ptc_run_code` — run a JS/TS program that composes tool calls; the program
  reaches tools as `tools.read(...)`, `tools.write(...)`, etc.; its return value
  and `console.log` output are reported back.
- `ptc_workflow` — structured variant with `meta` + `args`, plus the workflow
  helpers (`log`, `phase`, `parallel`, `pipeline`).

## Trust posture (read me)

- Installing this package grants it the same machine access as any pi
  extension: PTC programs run as **you**, with no OS-level sandbox (ADR-0007).
- Tool calls made from inside a PTC program execute directly and **bypass**
  pi's `tool_call` hooks (permission gates, path guards) — see ADR-0005. Do not
  rely on those guards to constrain tool use while this extension is enabled.

## License

Apache-2.0
