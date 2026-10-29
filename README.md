# pi-ptc-subagents

Programmable tool calling and subagent dispatch for [pi](https://pi.dev) — and a
[Kimi Code](https://www.kimi.com/code) plugin (`ptc-tools`, MCP) that brings the same
"write one program, batch-call your tools" to Kimi sessions. The npm package covers pi;
the Kimi Code plugin ships from this repo's GitHub Releases.

pi calls tools one at a time. On pi, the model writes a program that calls them in one
go — and can spawn pi subagents from inside it. On Kimi Code, the plugin gives the model
one program tool over a fixed file-tool set.

```
on pi
  full_ptc      model ──▶ ptc_run_code ──▶ program ──┬──▶ tools.read · grep · edit · …   (session tools)
                                                     └──▶ pi_task_ptc ──▶ pi child ──▶ report

  codemode_ptc  model ──▶ codemode script ───────────┬──▶ tools.read · grep · edit · …   (session tools)
                                                     └──▶ pi_task_codemode ──▶ pi child ──▶ report

on kimi (MCP)
                model ──▶ ptc_run_code ──▶ program ──────▶ tools.read · grep · glob · edit   (fs 四件套, workdir-locked)

                                          one call in, one result back — never the calls in between.
```

## On pi

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

```ts
// full_ptc, inside ptc_run_code
const r = await tools.pi_task_ptc({ task: "audit the auth code", wait: true });

// codemode_ptc, inside a codemode script
const r = await tools.pi_task_codemode({ task: "audit the auth code", wait: true });

return r.report?.summary ?? r.text;
```

### Surfaces

- **`full_ptc`** — the PTC pair is model-facing. Programs reach tasks with `pi_task_ptc`.
- **`codemode_ptc`** — pi's codemode orchestrates. Scripts reach tasks with
  `pi_task_codemode`; the PTC pair is not registered at all.

Which one you get depends on whether `codemode` is loaded and callable. Nothing to configure.

### PTC mode

On a `full_ptc` session, PTC mode adds a routing lead to the system prompt: batch your
tool calls into one program. `/ptc off` drops the lead.

It does not hide the built-in tools from the model. pi keeps a tool callable from a
program only while it is active, so narrowing the loadout would take `tools.read` away
from the program too — the two cannot both hold on pi 1.4.0.

## The Kimi Code plugin (`ptc-tools`)

Two MCP tools; the host's own tools remain the orchestrator (no subagent door here —
Kimi Code ships its own Agent tool, so this plugin doesn't duplicate one):

- **`ptc_run_code({ code, description, workdir, timeoutMs? })`** — a TypeScript program in
  the same vm cell as on pi, over a fixed tool set: `read` / `grep` / `glob` / `edit`.
  Every path is realpath-checked and confined to `workdir`; `edit` lands atomically and
  requires a unique `old_string`. No `bash`, no task dispatch inside the program.
- **`web_ds_search`** — search / open / find, callable directly (no child process needed).
  Quota is per MCP server process (default 30 calls, `0` = unlimited); the DeepSeek key
  resolves from env, then Kimi Code's `config.toml`.

Install with `/plugins install https://github.com/a1121611810/pi-ptc-subagents` — the bare repo
URL tracks the latest GitHub Release (pinned URLs get no update checks); run `/reload` to
activate. A bundled `ptc` skill teaches the model when to write a program instead of
fanning out tool calls one by one.

## Install (pi)

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

Requires Node ≥ 22.19.

## Configuration (pi)

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

Programs run in a vm cell on both editions (ADR-0019, v7.0.0): the only door out is
`tools.*`, which goes through the same tool pipeline as a direct call. Programs do not
see `process`, `fetch`, or dynamic `import` — code that used them broke in v7.0.0.

That is an alignment of power paths, not a security boundary. There is still no OS
sandbox: whatever the bound tools can do, a program can do, and a dispatched child is a
full pi process running as you. `bash` is not in the program binding table on either edition.

## Compatibility

pi `>= 0.86.0`, tracked against latest (currently 1.4.0). Two version facts matter:

- **In-program `tools.*` needs pi ≥ 0.99.** On 0.86/0.87 a program still evaluates and can
  still dispatch a task, but session-tool calls fail with a clear version error. The
  codemode surface itself also only exists from 0.99.
- Everything else in the 0.86–1.4 range is covered by real-machine smoke tests, including
  a program that dispatches a real child process. Per-version details:
  [docs/pi-version-matrix.md](./docs/pi-version-matrix.md).

## Documentation

- [AGENTS.md](./AGENTS.md) — how this repository is built and guarded
- [docs/adr/](./docs/adr/) — decisions, 0001–0020
- [docs/prototypes/](./docs/prototypes/) — spec and status pages
- [docs/research/](./docs/research/) — evidence notes

## License

Apache-2.0. See [LICENSE](./LICENSE).
