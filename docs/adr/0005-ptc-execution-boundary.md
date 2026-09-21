# PTC execution boundary: keep `worker_threads`, harden it, and call tools directly

Two coupled facts forced this. (1) DSH now runs each PTC program in a fresh Node process under its OS sandbox (2026-09-11), but (2) pi's extension API exposes no tool-dispatch surface — `extensionsResult.runtime` is state plumbing only, `pi.on('tool_call')` fires only from the agent loop, and `pi.exec` lacks `execArgv`/`resourceLimits`/granular `stdio` (R5). So we keep `node:worker_threads`, lift the two cheap DSH properties that don't depend on a process boundary (env scrub + V8 caps), and accept the documented consequence that bindings call `tool.execute()` directly and therefore bypass pi's tool-call pipeline. A process boundary would not close the routing gap, and pi ships no sandbox service to hook — a `child_process` lift would be a half-boundary.

Status: accepted (2026-09-21). Map #7 / ticket #15. Sources: R3 on branch `research/R3-isolation-tradeoff`; R5 on branch `research/R5-binding-routing`; R1 change note 2026-09-11.

Decisions:

1. **Boundary**: `worker_threads`, hardened per F1–F4 below. Not `child_process`.
2. **Direct execution**: bindings invoke tool definitions directly. `pi.on('tool_call')`, `protected-paths`-style guards, `permission-gate`, sandbox overrides, and VM routing do **not** see worker-driven calls. This is inherited risk; nothing may silently represent it as resolved.

F1–F4 hardening (from R3):

- **F1** env scrub — spawn workers with an allow-list (`PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `TEMP`, `TMP`), never the host's full env.
- **F2** V8 cap — `resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 }`.
- **F3** frozen per-run env — env frozen into `workerData` at spawn; live `process.env` never consulted across the binding wire.
- **F4** `cwd` in `RunConfig` — per-run chdir approximation.

## Considered options

- **`child_process`** — half-boundary; doesn't close routing; no sandbox service to hook; rejected.
- **`node:vm` / `vm2`** — Node docs say `vm` is "not a security mechanism"; vm2 is unmaintained (CVE-2023-30547 family); rejected.

## Consequences

- Tool descriptions must not imply PTC writes are gated by pi's permission pipeline.
- **Reopen trigger**: pi ships `ExtensionAPI.dispatchTool` **and** `registerSubprocess(spec)` (argv / execArgv / env / cwd / stdio / resourceLimits) — then decisions 1 and 2 close together.

## Addendum (2026-09-22) — the enablement dimension

The bypass analysis above covered hooks and guards; it did not cover the session's
**tool-enablement policy**. T7 (#21) closed that hole on the fixable side: bindings are now
`BUILTIN_BINDING_NAMES ∩ pi.getActiveTools()`, so `--tools`, `--no-builtin-tools` and
`--exclude-tools` are respected from inside PTC programs. A restricted session simply has
fewer — possibly zero — bindings (a default session has `read`/`bash`/`edit`/`write`; enable
`grep`/`find`/`ls` to bind them).

The remaining bypass is unchanged: worker-driven tool calls still execute directly and are
invisible to `pi.on('tool_call')`, `protected-paths`-style guards, and `permission-gate`
until pi ships a dispatch surface (reopen trigger above).
