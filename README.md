# pi-ptc-subagents

Programmable tool calling and subagent dispatch for [pi](https://pi.dev).

pi calls tools one at a time. This package lets the model write a program that calls them
in one go — and lets that program spawn pi subagents. Two capabilities. One package.

```
full_ptc      model ──▶ ptc_run_code ──▶ program ──┬──▶ tools.read · grep · edit · …   (session tools)
                                                   └──▶ pi_task_ptc ──▶ pi child ──▶ report

codemode_ptc  model ──▶ codemode script ───────────┬──▶ tools.read · grep · edit · …   (session tools)
                                                   └──▶ pi_task_codemode ──▶ pi child ──▶ report

                                        one call in, one result back — never the calls in between.
```

Both surfaces are detected from the session. There is no setting.

## What you get

- **One program, many tool calls.** `ptc_run_code` and `ptc_workflow` run TypeScript in a
  worker. The program uses the session's tools as `tools.read(...)`, `tools.grep(...)`.
  Only the result, the logs, and truncated output come back. On a codemode session, pi's
  own codemode runs the script; this package supplies the task door underneath it.
- **Real subagents.** `pi_task_ptc` inside a program, `pi_task_codemode` inside a codemode
  script. Every task gets its own pi process and its own report. Busy means wait, not reject.
- **Visibility.** `ptc_task_list`, `ptc_task_output`, `ptc_task_stop` appear when there is
  a task to look at.
- **Search, where it belongs.** `web_ds_search` registers only inside dispatched children.
  Off by default.

A call looks like this — the same shape on both surfaces:

```ts
// full_ptc, inside ptc_run_code
const r = await tools.pi_task_ptc({ task: "audit the auth code", wait: true });

// codemode_ptc, inside a codemode script
const r = await tools.pi_task_codemode({ task: "audit the auth code", wait: true });

return r.report?.summary ?? r.text;
```

## Install

```bash
pi install npm:pi-ptc-subagents
```

From a local checkout:

```bash
pnpm install && pnpm run build && pi install /abs/path/to/this/repo
```

To run one build without touching your settings:

```bash
pi -ne -e packages/entry/dist/index.js
```

## Surfaces

- **`full_ptc`** — the PTC pair is model-facing. Programs reach tasks with `pi_task_ptc`.
- **`codemode_ptc`** — pi's codemode orchestrates. Scripts reach tasks with
  `pi_task_codemode`; the PTC pair is not registered at all.

Which one you get depends on whether `codemode` is loaded and callable. Nothing to configure.

## PTC mode

On a `full_ptc` session, PTC mode adds a routing lead to the system prompt: batch your
tool calls into one program. `/ptc mode off` drops the lead.

It does not hide the built-in tools from the model. pi keeps a tool callable from a
program only while it is active, so narrowing the loadout would take `tools.read` away
from the program too — the two cannot both hold on pi 1.4.0.

## Configuration

`~/.pi/agent/ptc.json` — all optional:

- `defaultMode` — enter PTC mode on `full_ptc` sessions. Default `true`.
- `whyEnabled` — carry the caller's reason into the child. Default `true`.
- `webDsSearch` / `searchMaxCalls` — web search in children; off by default, 30 calls per
  child when on (`0` means unlimited).
- `taskTraceKeep` / `archiveEnabled` / `archiveTtlDays` — task trace retention (decision 29):
  terminal records kept in the hot store (default 500); evicted traces go to a compressed
  archive unless `archiveEnabled: false` (immediate delete); archive lives `archiveTtlDays`
  days (default 30) and stays retrievable by exact id via `ptc_task_output`.

## Trust posture

Programs run as you. There is no OS sandbox, and a program's tool calls bypass pi's
`tool_call` hooks. `bash` is not bound by default.

## Compatibility

pi `>= 0.86.0`. Real-machine smoke tests cover 0.86.0 through 1.4, including a program that
dispatches a real child process. Details:
[docs/pi-version-matrix.md](./docs/pi-version-matrix.md).

## Documentation

- [AGENTS.md](./AGENTS.md) — how this repository is built and guarded
- [docs/adr/](./docs/adr/) — decisions, 0001–0015
- [docs/prototypes/](./docs/prototypes/) — spec and status pages
- [docs/research/](./docs/research/) — evidence notes

## License

Apache-2.0. See [LICENSE](./LICENSE).
