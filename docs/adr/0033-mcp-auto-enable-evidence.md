---
status: accepted (2026-10-08)
---

# The detected surface reads MCP auto-enable evidence, because pi's MCP extension activates codemode at runtime

## Context

ADR-0029 gave the detected surface a third axis — whether `codemode` will be **ACTIVE** — and bounded
its own weak guarantee in the direction that matters:

> **Under-reporting activation** — we say `inactive`, pi would have activated it. The surface is
> `full` when `subagents` was available. Nothing breaks: the session has `ptc_run_code`, and it
> simply was not delegated. The user loses the delegation, not the capability.

That bound is correct, and it is what made the five-cell table safe to ship. What it assumed is
narrower than it looks: that the sources the probe mirrors — the `--tools` allowlist and the merged
`defaultTools` — are the ways `codemode` becomes active. pi 1.0.0 has a fourth, and it records
itself nowhere the probe reads.

**MCP tools are not declared to the model; they are called from codemode scripts.** A server
registers its tools as `mcp__<server>__<tool>` and, by default, with exposure `codemode`
(`pi-coding-agent@1.0.0/dist/extensions/mcp/index.d.ts:9-12`), which keeps them out of the
model's tool declarations and out of the codemode description — a script finds them with
`searchTools()` and reads the server's instructions with `describeNamespace()`.

That leaves `codemode` as the only way to reach them, so **the MCP extension activates it**:

```
const needsCodemode = exposures.has("codemode");                 // index.js:361
...
if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
    activate.push(CODEMODE_TOOL_NAME);                            // index.js:371-372
}
if (activate.length > 0) pi.setActiveTools([...active, ...activate]);   // index.js:377-378
```

Three properties of that call decide this ADR:

1. **It is a `setActiveTools` call, not a setting.** Nothing in `settings.json` changes, so no
   settings mirror can see it. `defaultActive: false` on the codemode extension
   (`dist/extensions/codemode/index.js:26`) is bypassed, not obeyed.
2. **It is computed from config, before the servers connect** — `ensureDiscoveryActive` says so at
   `index.js:353-354`, and the exposures it iterates are `configuredExposures(server.entry)`
   (`index.js:64-66`), not the tools a connection later reports. Whether a server CONNECTS is not
   an input, so the decision is a pure function of `mcp.json`.
3. **It overrides the loadout, including a CLI allowlist that excluded codemode**, because it
   appends to whatever the loadout resolved.

So the session that ADR-0029 called its default cell is, for anyone with an MCP server, not the
default cell: the probe resolves `inactive`, the surface defaults to `full`, pi activates `codemode`
anyway, and the model is offered **two orchestration surfaces** — the measured defect ADR-0025
exists to remove, reappearing for the population pi 1.0 is built around.

## What we add

### 1. MCP auto-enable evidence, resolved as a pure mirror of pi's inputs

`resolveMcpAutoEnableEvidence` (`src/mode/ptc-mode.ts`) takes the two files pi's `loadMcpConfig`
reads — `<agentDir>/mcp.json`, then `<cwd>/.pi/mcp.json` (`config.js:77-87`) — and answers pi's
question from them:

> `autoEnableCodemode` iff `autoEnableCodemode !== false` and some **enabled** server's
> configuredExposures contains `"codemode"`.

The fold is pi's: `enabled !== false` (`index.js:57-59`), server exposure defaulting to
`codemode` (`index.js:60-62`), the union with per-tool `toolExposure` values (`index.js:64-66`),
project entries replacing global ones by name and the project `autoEnableCodemode` replacing the
global one (`config.js:54-71`, `:79-81`), and the namespace clash rule dropping the later of two
names that would share `mcp__<server>` (`config.js:60-64`, `mcpNamespace` at
`mcp-servers.js:20-22`). The remaining pi condition — the tool being registered at all
(`hasCodemode`, `index.js:367`) — is the presence and switch probes this package already runs.

### 2. Union with the loadout mirror, not a fourth precedence step

pi appends `codemode` to whatever the loadout resolved, so either source being positive means the
model can call it: `resolveCodemodeActivation`'s answer is unioned with the evidence
(`applyMcpAutoEnableEvidence`). A `--tools read,write` command line does not veto it, because pi
does not treat that flag as a veto either. When both sources agree the loadout's provenance wins
(`"cli" | "project" | "user"`), since it names the file the user edited; `"mcp"` appears only when
the loadout said `inactive` and the evidence said otherwise.

### 3. The server mirror is a strict subset of pi's validator, and the asymmetry is the design

`validateMcpServerConfig` is ~60 lines of URL, OAuth and credential rules and is not exported, so
copying it whole is neither short nor stable. What the mirror takes is the structural part:
the name charset (`mcp-servers.js:18`), the object shape, `exposure` / `toolExposure` validity
after alias resolution (`mcp-servers.js:9`, `:66-68`), the `enabled` / `description` / `timeout`
types, the `sse` rejection, and the transport requirements (`:136-168`). What it does not take is
the `oauth` object and `auth.provider` rules (`:143-155`).

A subset can only be **laxer**, so every disagreement resolves one way: we count a server pi
drops for an omitted reason, predict `active`, and land in `subagents` with no orchestrator —
where the ADR-0025 decision-4 warning measures the real loadout and fires loudly. The direction
this ADR exists to close, under-reporting into a silent double surface, is unreachable _for this
subset_. ADR-0029 already established that this mirror has no differential oracle, so every case
is pinned as a literal against the cited lines and labelled as the weaker guarantee it is.

**Where under-reporting IS reachable, and what catches it.** pi's server list is not only
`loadMcpConfig`'s output: `ensureDiscoveryActive` iterates `loadMcpConfig`'s servers **plus** the
ones any extension registered through `pi.registerMcpServer()` (`index.js:853`, where the two lists are merged; the activation call
at `:857`; the registry at `:232-247`), and those entries go through the same `isEnabled` /
`configuredExposures` loop. A
server registered that way therefore activates `codemode` with no `mcp.json` anywhere, and a probe
that reads two files cannot see it: the answer is `inactive`, the surface defaults to `full`, and
the session carries both orchestration surfaces. That is the honest limit of config evidence, and
it is what the drift notice in §6 exists for — it compares the real loadout and reports exactly
this case, which is why the notice is part of this record and not a nicety.

### 4. The project `mcp.json` is read unconditionally

pi reads it only when the project is trusted (`config.js:80`); the probe cannot observe trust, so
it reads it anyway — the same over-prediction ADR-0029 records for project settings, with the same
bound. The hazard is not new in kind: it can only claim `active` when pi says `inactive`.

### 5. A `mcp.json` we could not read is reported, never swallowed

An unparseable file contributes nothing (pi pushes the error and skips the file,
`config.js:39-44`), and the error is carried on the activation resolution and notified once at
session start, beside the existing settings-file notice. An **absent** file is silent, exactly as
pi's `existsSync` guard is, and a file that exists but cannot be **read** is not: pi wraps the read
and the parse in one `try`, so the two are the same report, and the probe distinguishes them the
same way (`ENOENT` is absence; `EACCES`, `EISDIR` — a directory named `mcp.json` is real — and the
rest are failures). Without the carry, "codemode will stay inactive" is indistinguishable from "we
could not tell", and only one of those is a decision.

One place the carry is **narrower** than pi, and it is narrowing about our own type rather than
about what the user learns: pi keeps an `errors` ARRAY (`config.js:78`) and pushes one entry per
failing file (`config.js:40-53`), while the resolution carries one string, so two broken files are
reported as one notice with the two messages joined by `;`. Both paths are named, which is the
property that matters — a first version overwrote instead, and the global file's error was
silently erased by the project file's — but the notice is one line rather than two. Pinned at the
resolution layer (`tests/unit/codemode-mcp-evidence.test.ts`, "when BOTH files are broken"); the
factory's rendering of a two-message string is **not** pinned end to end, because a session's
project `mcp.json` is read from the process `cwd` and the test harness has no seam for it — a
regression that rendered only the first message would leave the suite green. Recorded rather than
closed, and closing it needs a `cwd` seam this record declines to add.

### 6. The drift notice: probe answer versus real loadout

Even with the evidence, a codemode can be active that no file predicted — a server registered
through `pi.registerMcpServer()` (the under-report path named in §3), an extension calling
`setActiveTools`, or an `mcp.json` the probe could not read. When the probe answered `inactive`,
the surface defaulted to `full`, and `pi.getActiveTools()` contains `codemode`, the session start
notifies once (and once more only if it has not fired yet, on the first turn, because the MCP
extension's own `session_start` may run after ours). `warning`, not `info`: it is the same double
surface, with the same one-line fix, as the notices ADR-0026 and ADR-0027 already report.

~~One exemption, and it is the notice's third guard: a session whose surface was **pinned**
(`source: "file"`) is not reported, even when the pinned value is `full` and codemode really is
active. The user chose that surface, and ADR-0027's pinned-conflict notice already reports a pinned
value that disagrees with the detection; a second line saying the same thing would be noise on
every session. The cost is honest and stated: a user who pinned `full` on an MCP session is never
told that the double surface is live, and the notice does not reach them at all.~~

**Withdrawn 2026-10-10 by [ADR-0034](./0034-surface-is-detected-not-set.md)**: the `surfaceMode` key
is removed, so a session's surface is never pinned and there is no `source: "file"` to exempt. The
notice's third guard is now always true, so the exemption costs nothing and the notice is reported
on every MCP session where codemode really is active. The cost this paragraph used to state — "a
user who pinned `full` on an MCP session is never told" — cannot occur.

## What we deliberately don't do

1. **No full copy of `validateMcpServerConfig`.** The omitted rules can only over-predict, and the
   OAuth surface is where such a config is least likely to be. Re-mirroring it is a matter for the
   day a real `mcp.json` fails one of those checks and the probe is wrong about it.
2. **No connection-state reading.** pi's decision is deliberately config-pure ("from the config,
   so the tool is active before the servers connect"), so a mirror that consulted live
   connections would be _less_ faithful, not more.
3. **No `--exclude-tools` / `--no-tools` accounting.** Both can only remove tools; ADR-0029's
   reasoning for skipping them is unchanged.
4. ~~**No third extension-option seam.** `options.codemode` / `options.codemodeSwitch` exist so a
   test can state the pi it is reasoning about; the evidence is reached through
   `readSurfaceModeConfig` in the same way, and another seam is another place for the three to
   drift.~~ **Reversed 2026-10-10 by [ADR-0034](./0034-surface-is-detected-not-set.md)**: that
   function is gone with the key it read, and `codemodeActivation` is now a third seam — which this
   package needed anyway, because the activation probe reads the developer's own `settings.json`.
5. **No mid-session surface switch.** Registration happens in the factory and pi has no
   `unregisterTool` (ADR-0029), so the notice is visibility, not a remedy; the remedy was ADR-0030's
   `surfaceMode` + reload — **both withdrawn by ADR-0034**, which leaves neither.

## Consequences

- The session ADR-0029 could not resolve no longer happens by accident: an MCP user on pi 1.0.0
  gets `subagents` — codemode for orchestration, `ptc_subagent` plus the task lifecycle for
  fan-out — instead of two orchestration surfaces. The registered tool set for that session is
  asserted in `tests/unit/codemode-mcp-drift-notice.test.ts`, not the probe's own answer.
- A new over-prediction surface exists (untrusted project file, omitted validator rules, a
  disabled `builtin:mcp` extension with a codemode-exposure config). All three resolve to
  `subagents` with no orchestrator, which is loud by ADR-0025 decision 4 and was already
  reachable before this record.
- One under-report path is reachable and is **not** closed by the evidence: a server registered
  through `pi.registerMcpServer()` (see §3). The drift notice is what closes it for the user, and
  the notice itself is exempt on a pinned surface (§6), so a user who pinned `full` on such a
  session is never told the double surface is live — there the detection says `full` too, so
  ADR-0027's conflict notice has no disagreement to report either. (A pinned `full` on a session
  whose `mcp.json` IS readable is a different case: the detection then says `subagents` and the
  conflict notice does fire.) Recorded rather than solved: closing it would mean re-reading the
  live server registry, which is exactly the connection-state read this record declines.
- Two more file reads per probe run, on **every** `detectSurfaceMode` call (formerly
  `readSurfaceModeConfig`, deleted by ADR-0034) — the probes run on every call, which is now the
  only call, because there is no key that could win. One detected surface therefore costs four
  settings reads over two files (each of the two probes reads both) plus these two, which is
  recorded in `detectSurfaceMode`'s docstring rather than optimised: the duplication is pre-existing
  and keeps each probe a whole copy of pi's.
- `--print` sessions get none of the new notices (`ctx.ui.notify` is TUI-only), as with every other
  notice in this package (ADR-0025's known limitation).

## Verification

The six reachable cells, each taken through the real factory on real files, so what is asserted is
the tool set a model would be offered rather than the probe's own answer:

| mcp.json                                               | activation               | surface     | this package registers                       | asserted by                                        |
| ------------------------------------------------------ | ------------------------ | ----------- | -------------------------------------------- | -------------------------------------------------- |
| absent                                                 | `inactive` (`"default"`) | `full`      | `ptc_run_code`, `ptc_workflow`, `ptc_task_*` | orchestrator present, `ptc_subagent` absent        |
| one stdio server, no `exposure` key                    | `active` (`"mcp"`)       | `subagents` | `ptc_subagent`, `ptc_task_*`                 | the full registered list, exactly                  |
| `autoEnableCodemode: false`, same server               | `inactive` (`"default"`) | `full`      | as row 1                                     | the full registered list, exactly                  |
| server present, `enabled: false`                       | `inactive` (`"default"`) | `full`      | as row 1                                     | the full registered list, exactly                  |
| a file that will not parse                             | `inactive` + `mcpError`  | `full`      | as row 1                                     | one warning naming the file, plus the drift notice |
| no evidence, yet codemode active in `getActiveTools()` | `inactive` (`"default"`) | `full`      | as row 1                                     | as row 1, plus the drift notice, raised once       |

Those six, and the `--print` cell beside them (a `ctx.ui.notify` notice is silent there — this
package's standing limitation, restated rather than fixed), are in
`tests/unit/codemode-mcp-drift-notice.test.ts`. The evidence matrix itself — nine server shapes pi
drops, the `codemode-deferred` alias, both project-override directions, the namespace-clash rule,
the project-scope `auth` rule, and the read / parse failure paths — is
`tests/unit/codemode-mcp-evidence.test.ts`, and it is a pure-function matrix: every case a literal
justified against a cited line. As ADR-0029 noted for its own mirror, the reader is expected to
re-check those lines when pi moves: there is no differential oracle, and that is the reason.

## Related

- ADR-0029 — the activation axis this record amends; its under-reporting bound assumed config was
  the only activation path.
- ADR-0025 — the surface setting whose decision-4 warning bounds this record's over-prediction, and
  whose double-surface measurement is the defect being closed.
- ADR-0026, ADR-0027 — the presence and switch probes that answer pi's remaining `hasCodemode`
  condition.
- ADR-0028 — the structured results that let a codemode script consume this package's tools, the
  other half of living on the same surface.
- `docs/research/codemode-vs-ptc-capability-20260930.md` — the measured capability comparison whose
  subagent-lifecycle row is untouched by any of this: codemode's sandbox still cannot spawn a
  process, MCP-oriented or not.
