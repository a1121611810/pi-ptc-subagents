---

status: accepted (2026-10-03). §Context and §Verification amended 2026-10-09: the pair registers on `subagents`, at `codemode` reach.

# The detected surface follows whether codemode will be ACTIVE, not only whether it ships or loads

## Context

ADR-0026 made the surface default DETECTED, ADR-0027 made that detection follow whether pi will
**load** `codemode`, and both are correct as far as they go. The table ADR-0027 settled on has two
axes — is the directory on disk, and will the extension load — and four cells. A real 1.0.0 install
sits in one of them, and the session it produces has **no orchestration tool at all**:

```
surfaceMode is subagents, but codemode is not active in this session, so there is no
orchestration tool. Add codemode to your pi tool list (the --tools flag or the default
tools setting), or set surfaceMode to "full" to use ptc_run_code instead.
```

That warning is not a misconfiguration, and it is not rare. On the machine this was found on,
nothing was misconfigured at all: `~/.pi/agent/ptc.json` absent, no `extensions` entry naming
`builtin:codemode` in the user settings, no `defaultTools`, no `--tools` on the command line. The
chain runs:

| step       | fact                                                           | source                                          |
| ---------- | -------------------------------------------------------------- | ----------------------------------------------- |
| presence   | `dist/extensions/codemode` exists                              | `probeCodemodePresence`                         |
| switch     | no entry anywhere ⇒ `"absent"` ⇒ pi loads built-ins by default | `resolveCodemodeSwitch`                         |
| ⇒ surface  | `subagents`                                                    | `detectedSurfaceMode` (`ptc-mode.ts:1160-1169`) |
| activation | `codemode` registers with **`defaultActive: false`**           | `dist/extensions/codemode/index.js:26`          |
| ⇒ loadout  | pi's default active names are `["read","bash","edit","write"]` | `settings-manager.js:35`                        |
| ⇒ warning  | `getActiveTools()` has no `codemode`                           | `src/index.ts:856`                              |

So `subagents` hands orchestration to a tool that is loaded, registered, and not callable, and the
session is left with nothing to orchestrate with ~~because `subagents` deliberately does not
register `ptc_run_code`~~ — **amended 2026-10-09**: by reach, not by absence (see below). **Every
default session on a 1.0.0 install hits this.** It is the default cell, and the table does not have it.

pi's own documentation is unambiguous that this is intended behaviour, not a bug on the user's
side (`dist/extensions/codemode/index.d.ts`):

> `codemode` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
> `setActiveTools()`.

ADR-0026's `probeCodemodePresence` docstring already said its answer is "does this pi ship
codemode", NOT "can this session call it", and ADR-0027 pushed the second question to
`session_start` — where a `pi` finally exists. **The second question was used to emit a warning and
nothing else.** That is the whole defect: a measurement was taken at the one moment it became
possible, and then not used in the decision that had to be made earlier.

## What we add

A third probe, kept as separate from the other two as the questions are, and a five-cell table
over all three.

| codemode on disk | switch   | activation | surface     | why                                                             |
| ---------------- | -------- | ---------- | ----------- | --------------------------------------------------------------- |
| no               | any      | any        | `full`      | nothing to hand it to                                           |
| yes              | disabled | any        | `full`      | the extension we would hand away to is not loading              |
| yes              | enabled  | `active`   | `subagents` | it is loaded AND the model can call it                          |
| yes              | absent   | `active`   | `subagents` | ditto                                                           |
| yes              | enabled  | `inactive` | `full`      | **it is loaded but the model cannot call it — do not delegate** |

The last row is the one this ADR adds, and it is the default.

### Absence of evidence is `inactive`

The activation probe resolves in the same order pi does, reading the same three places:

1. `--tools` / `-t <list>` on the command line (`dist/cli/args.js:110`) — an allowlist that
   **replaces** the default loadout, so codemode is active iff the comma-split list names it
2. `defaultTools` in `<cwd>/.pi/settings.json` merged over the same key in
   `<agentDir>/settings.json`, then resolved
3. otherwise pi's default — `["read","bash","edit","write"]`, none of them `codemode` — so
   **`inactive`**

Step 3 is the load-bearing one, and it is the whole design: `subagents` is chosen only on
**positive** evidence that codemode is callable. "Nobody said anything" resolves to `full`.

### The mirror, and why it does not have to be perfect

Both settings functions are reproduced against pi 1.0.0's source rather than approximated, and
both are short enough to copy whole:

- `isToolModifier` (`settings-manager.js:36`) — a string starting with `+` or `-`
- `mergeDefaultTools` (`:43`) — a project list of only modifiers **concatenates** onto the user
  list; a project list containing any plain name **replaces** it wholesale
- `resolveDefaultTools` (`:55`) — plain names form the base list, or `DEFAULT_TOOL_NAMES` when
  every entry is a modifier; then `+name` adds and `-name` removes, in list order

`deepMergeSettings(this.globalSettings, this.projectSettings)` (`:196`) fixes the direction: the
user file is the base, the project file the override. That is the same read order
`readCodemodeSwitch` already uses, which is why both probes walk the same two files.

None of this is exported from pi, so unlike ADR-0027's `minimatch` copy there is **no differential
oracle** for it. `tests/unit/codemode-activation.test.ts` therefore pins the rules as literals
against the cited line numbers, and that is a weaker guarantee than a differential and is labelled
as one.

**The bound that makes the weaker guarantee sufficient.** The two ways this mirror can be wrong
are not symmetric:

- **Over-reporting activation** — we say `active`, pi does not activate it. The surface is
  `subagents` with no orchestrator, which is the bug this ADR exists to remove. It is caught, and
  caught by measurement rather than by this probe: the decision-4 warning at `src/index.ts:856`
  asks `pi.getActiveTools()` at `session_start`, where the answer is the real one. The failure
  degrades to exactly the behaviour that exists today, loudly.
- **Under-reporting activation** — we say `inactive`, pi would have activated it. The surface is
  `full` when `subagents` was available. Nothing breaks: the session has `ptc_run_code`, and it
  simply was not delegated. The user loses the delegation, not the capability.

So the cost of a miss is bounded on both sides, and the safe direction is the default. This is the
same reasoning ADR-0026 decision 3 used to pick `full` as the probe-failure fallback, applied one
axis further out.

## What we deliberately do not do

**We do not read `--exclude-tools` or `--no-tools`.** Both can only _remove_ tools, so both can
only make the truth `inactive`; accounting for them could only move the probe toward
under-reporting, which the table above already handles. Adding them would grow the mirror for a
direction that is already safe and self-correcting.

**We do not make the `session_start` measurement authoritative.** It is the better answer — it is
the real loadout — and it arrives too late. Registration happens in the factory and pi has no
`unregisterTool` (only `unregisterProvider`), so a surface chosen
wrong cannot be corrected in place. Deciding later would mean registering both surfaces and
narrowing with `setActiveTools` at `session_start`, which changes which tools this package
_registers_ — a much larger change to the contract this package publishes, and one that would also
put a second writer on the loadout that `ptc-mode.ts:27-31` already documents as contested.

**We do not add a notice for the new default.** The default path now resolves to `full` and says
nothing, on the reasoning ADR-0026 already recorded: a notice on every ordinary session is crying
wolf. ~~The pinned-disagreement notice is untouched — a user who pins `surfaceMode: "subagents"`
without an active codemode still gets the decision-4 warning, and that is now the only way to
reach it, which is the correct shape.~~ **Withdrawn 2026-10-10 by
[ADR-0034](./0034-surface-is-detected-not-set.md)**: the key is gone, so there is no pinned value
and no pinned-disagreement notice. A session with no active `codemode` now reaches the decision-4
warning on the detected path, which is the only path.

**We did not make `activation` a third seam on the extension options — and then we did.**
`options.codemode` and `options.codemodeSwitch` exist so a test can state the pi it is reasoning
about; at the time of writing, the activation probe was reached only through
`readSurfaceModeConfig` (now `detectSurfaceMode`), and a third seam looked like a third place for
the three to drift apart.

**Reversed 2026-10-10 by [ADR-0034](./0034-surface-is-detected-not-set.md)**, which deleted that
function along with the `surfaceMode` key it read. With the key gone there is no "explicit" path to
keep the activation probe off the developer's machine, so `PtcSubagentsOptions.codemodeActivation`
now exists as a third seam. The drift risk this paragraph named is real and is handled where the
seam is defined rather than by withholding it: a stub that pins nothing resolves to
`{ activation: "inactive", source: "default" }`, which is what an unconfigured session does anyway,
so the unspecified case is the ordinary one rather than the dangerous one.

## Consequences

- **The false warning stops on a default install**, and the default session gains `ptc_run_code`
  instead of holding `ptc_subagent` with nothing to compose it.
- `detectedSurfaceMode` takes a third argument, and it is **required**: a default parameter would
  be evaluated on every call, including the ones an explicit `surfaceMode` short-circuits, and it
  would let every existing two-argument test keep passing without ever stating whether codemode
  was active — which is the mistake this file's parameter list was written to prevent.
- The switch adds up to two more settings reads on the path where no `surfaceMode` is pinned. They
  are paid on the explicit-key path too, for the same reason ADR-0027 pays its two: the
  disagreement notice needs the table's own answer.
- **A message that could now lie.** The `detected.present && !known` notice at
  `src/index.ts:807` hard-codes the string `"subagents"` as the detected surface. With a fifth
  cell, `detected` can be `full` while `present && !known` still holds (activation predicted
  `active` from a project `defaultTools`, and the project turned out to be untrusted —
  `settings-manager.js:327` drops project settings in that case, which this probe cannot observe).
  The message now reports `surface.detected` instead of a literal, for the same reason it is
  worth a line: a correct notice carrying a wrong value is the failure mode gates cannot see.

## Verification

The four reachable cells, each on a real 1.0.0 install, each confirmed by the tool set a model
would actually see rather than by the probe's own answer (**amended 2026-10-09**, see the note
below):

| scenario                                       | activation | surface     | this package registers                                       |
| ---------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------ |
| `no config at all (the default)`               | `inactive` | `full`      | `ptc_run_code`, `ptc_workflow`, `ptc_task_*`                 |
| user settings `defaultTools: ["+codemode"]`    | `active`   | `subagents` | `ptc_subagent`, `ptc_task_*`, `ptc_run_code`, `ptc_workflow` |
| `pi --tools read,write,codemode`               | `active`   | `subagents` | `ptc_subagent`, `ptc_task_*`, `ptc_run_code`, `ptc_workflow` |
| user settings `defaultTools: ["read","write"]` | `inactive` | `full`      | `ptc_run_code`, `ptc_workflow`, `ptc_task_*`                 |

**Amended 2026-10-09.** On the two `subagents` rows the last two tools are registered at `codemode`
reach: a script can call them, and the model is not told they exist (ADR-0025 §3 as amended). What
the table confirmed is unchanged — the surface each cell resolves to — and the model-facing set is
still one orchestration surface. Only the registered set grew.

The regression test asserts on the **registered tool set**, not on `detectedSurfaceMode`: the
latter would stay green if the factory stopped consulting the activation probe at all, which is
the same trap ADR-0027 recorded for its own test.

The fifth cell of the table — no codemode on disk — is not reachable on a machine that has 1.0
installed, and is covered by unit tests only. That asymmetry is stated rather than papered over.

## Amendment (2026-10-08, ADR-0033): the bound held; its premise did not

The "Under-reporting activation" bound above is unchanged — saying `inactive` when pi activates
afterwards still costs the delegation, not the capability, and nothing shipped breaks. What was
wrong is the premise underneath it. Every activation path this record mirrors is a **config
path** — the `--tools` allowlist, the merged `defaultTools`, pi's own default — and the bound's
safety argument reads as though that list were complete.

It is not. pi's MCP extension activates `codemode` with a `pi.setActiveTools` call
(`dist/extensions/mcp/index.js:352-389`), because MCP tools default to `codemode` exposure and are
therefore reachable only from scripts (`dist/extensions/mcp/index.d.ts:9-14`). No settings file
records that call. So on a pi 1.0.0 with an MCP server and no other configuration, this record's
default cell is not the default: the probe says `inactive`, the surface defaults to `full`, pi
activates `codemode` anyway, and the session carries two orchestration surfaces — the defect
ADR-0025 set out to remove, arriving by a door this record's mirror does not watch.

Two things follow for this record's design rather than its conclusion:

- **The absence-of-evidence default still points the safe way, and it is still what carries the
  weight.** `full` is not broken; it is just not delegated. ADR-0033 removes the common cause of
  that non-delegation rather than reclassifying the cell.
- **"Absence of evidence" now has two sources, and they are named differently.** The loadout
  mirror's default and the MCP evidence's default are both `inactive`, but for different reasons:
  nobody configured a loadout, versus no readable `mcp.json` asks for codemode. A probe input that
  vanished is a failure and is reported; a genuinely unconfigured session is a decision and is
  silent.

The repair and the new notice are in ADR-0033. Nothing in this record's table, its mirror, or its
over-report bound changes.

## Amendment (2026-10-09, ADR-0025 §3 as amended): the same outcome, by reach rather than by absence

Two claims in this record broke when `subagents` began registering `ptc_run_code` / `ptc_workflow`;
both are corrected in place above. The table, the mirror and the over-report bound are untouched,
and so is the cell: `codemode` inactive still resolves `full`.

- The Context's reason — "`subagents` deliberately does not register `ptc_run_code`" — is
  withdrawn. The outcome it explained is not: a `subagents` session with no active `codemode` still
  has nothing to orchestrate with, because the pair now registers at `codemode` reach and no script
  runs to reach it. Reach, not absence.
- The Verification table's "this package registers" column now lists the pair on both `subagents`
  rows. A `codemode` script can reach them and the model cannot see them, so the model-facing set
  those rows describe is unchanged.
