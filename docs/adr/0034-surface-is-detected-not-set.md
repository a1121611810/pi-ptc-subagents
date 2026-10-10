---

status: accepted (2026-10-10)

# The surface is detected only: the `surfaceMode` key and its `off` value are removed

## Context

[ADR-0025](./0025-extension-surface-is-a-setting.md) made the extension surface a **setting**: a
`surfaceMode` key in `ptc.json` with three values, of which `off` meant "this package registers
nothing at all". [ADR-0030](./0030-surface-switch-reloads.md) then gave it a `/ptc surface`
subcommand. Four records downstream of that (0026, 0027, 0029, 0033) each had to carry the
weight of an override that did not exist in the common case, and each spent a decision on it:

- "an explicit key always wins" (0026 decision 4),
- "the pinned value **wins** — that is what an override is for" (0027),
- the pinned-disagreement notice and the `source === "file"` exemption (0029, 0033 §6).

The setting was never needed for the case it was built for. What it was actually for — _not
registering this package's tools_ — is something pi already does, and does better, because pi does
not have to load the extension in order to honour it.

## What we remove

1. **The `surfaceMode` key** in `ptc.json`. No value pins a surface, so the surface is what
   `detectSurfaceMode()` says it is.
2. **The `off` value.** The list is now `subagents` / `full`. The factory no longer has an early
   return to make, because there is no "do nothing" to return from.
3. **`/ptc surface [off|subagents|full]`.** `/ptc off` is untouched and unrelated — it turns PTC
   _mode_ off, which is a different thing from the extension surface, and the two were never
   conflated in behaviour, only in proximity.
4. **`PtcSubagentsOptions.surfaceMode`**, the test seam that pinned a surface outright. The
   replacement is the `codemodeActivation` seam (0029), which pins one of the three probes rather
   than the answer — necessary rather than optional, because the activation probe reads
   `defaultTools` out of the developer's own `~/.pi/agent/settings.json` and a stub that pins
   nothing would otherwise decide its own surface by however the machine running it is configured.
5. **`surfaceModeConflict`** and the pinned-value-disagrees notice. `off` returned from the factory
   before any `session_start` handler existed, so the `off` case could never have been reported
   there; with the key gone the remaining case is gone with it.

## Why: pi's own channel, measured

The user's decision was that pi can already disable an extension cleanly, so this package should not
carry a second way to do it. That premise was verified rather than assumed, on **pi 1.1.0**,
against this package's own built `dist/index.js`, by changing one `packages` entry's `extensions`
and observing whether the extension loaded:

| `packages[].extensions` | extension loaded |
| ----------------------- | ---------------- |
| `["+dist/index.js"]`    | yes              |
| `[]`                    | **no**           |
| key omitted             | yes              |
| `["!dist/index.js"]`    | **no**           |

Two independent sources say the same thing. `docs/packages.md` documents the filter syntax
(absent = all load, `[]` = none load, `!pattern` = exclude, `+path` = force-include, `-path` =
exclude), and `pi --help` documents the command that writes it: `pi config [-l]` — "Open TUI to
enable/disable package resources (Tab switches scope)". In the source, `handleConfigCommand` writes
exactly the `packages[].extensions` array that `settingsManager` manages.

**The decisive property is that pi honours this without loading the extension.** Every value of a
key this package reads is read by code that has already run. A session that wants none of this
package's tools gets a pi that never evaluated a single line of it — no handlers registered, no
system-prompt section, no background runtime constructed, no `session_start` line. There is no
`ptc.json` value that achieves that, because reading it is the thing that would have to happen
first. That is not a better escape hatch; it is a different kind of one.

### The asymmetry worth knowing

In the **project-level** `.pi/settings.json` delta form, `"extensions": []` does **not** disable the
package; it must be written as `["!dist/index.js"]`. The reason is in pi, in
`collectPackageResources` (`package-manager.js:1848-1862`): the project-level path takes
`applyPackageDeltaFilter` at `:1854`, where an empty delta means "no change", while the personal-level
path takes `applyPackageFilter` at `:1857`, where `[]` means "load nothing". The two settings files are resolved by two different functions, which is
the same trap ADR-0027 records for `defaultTools` and had to reproduce rather than assume.

## Migration, and it is a behaviour change

A user who set `surfaceMode: "off"` **gets this package back** on upgrade. That is deliberate and
it is not silent: at `session_start` the key is read by `readLegacySurfaceKey()` and, if present, a
`warning` names the file, quotes the value, and points at `pi config` — including that setting the
package's `extensions` entry to `[]` stops pi loading it at all. The notice is not an error
report: the key is being ignored and the behaviour it asked for is not in force, which is what a
`warning` is for. To silence it, delete the key.

The value is deliberately **not** honoured, including `off`. Honouring it forever as a compatibility
shim would keep the switch this change exists to delete, and would leave the package carrying two
ways to be disabled, one of which silently does nothing — worse than either alone.

## What this costs, stated plainly

**The escape hatch is gone.** There is no longer a way to keep this package installed and reduce it
to a subset of its surface. The two former middle positions are now unreachable:

- `off` — gone entirely.
- A pinned `subagents` on a session where `codemode` is not active used to be a way to _ask_ for it
  and be told at startup that the orchestrator was missing. It is no longer expressible, because
  the surface is not a thing the user names.

Why that is acceptable, in the order the reasons actually carry weight:

1. **The only user who wanted it was a user who wanted the package gone.** `off` was never a
   middle setting in practice — it was "stock pi", and pi's own config does stock pi better and
   without executing this package to do it. ADR-0025 §Reopen already framed the
   missing capability as "making the surface switchable mid-session, if pi grows an unregister call or
   a per-turn tool filter that would make it honest"; pi grew a better answer than either.
2. **The remaining two positions are both safe answers.** `subagents` is chosen only on positive
   evidence that `codemode` is loaded _and_ callable, and `full` is the fallback for every
   uncertainty (0026 decision 3). With the key removed there is no way to reach a surface that
   mismatches the pi — the failure a user could previously talk themselves into by hand-editing
   JSON is now simply not constructible.
3. **The cost is one warning, once, and it is a line the user can act on.** A user who wanted
   nothing from this package is told precisely what to do and where.

The honest counterweight: a user who _likes_ the package and wants, say, `subagents` on a pi where
detection cannot see `codemode` is active has no in-package recourse. That is a real loss and it is
not hedged here. It is bounded by the same fact that motivates the change — the answer is now
always "make the pi match", which is a thing the user can actually observe, rather than "write a
line of JSON and restart, and believe the result".

## Consequences

- The surface is a pure function of what pi is. One reader, no override, no `source` field to
  branch on, and the cross-check exemption in ADR-0026 decision 8 and ADR-0033 §6 ("the user
  decided, so their answer stands") has nothing to exempt.
- Four records lose a decision they each carried for the override. They are amended in place, each
  saying what changed, rather than edited silently.
- `ptc.json` now has one key this package reads: `defaultMode` (ADR-0010).
- A `pi config` user who disables this package produces **no** `session_start` line from this
  package, which is the point: the notice about being disabled is issued by the thing that is not
  running.

## Reopen triggers

Reinstating a key, if pi's package filtering turns out not to cover a case this package needs
covered — an SDK embedder that installs extensions outside the `packages` mechanism, say, where
`pi config` has nothing to write. That is the one shape of user this record does not serve, and it
is worth checking against real embedders before treating this as permanent.

## Related

- [ADR-0025](./0025-extension-surface-is-a-setting.md) — **withdrawn by this record.** The premise
  that the surface is a setting is false; the `off` value and the key are gone. What survives is
  its §3 amendment (the `codemode`-reach split), which this record does not touch.
- [ADR-0030](./0030-surface-switch-reloads.md) — **withdrawn by this record.** The command it
  documents no longer exists, so its whole reload-on-switch subject is moot.
- [ADR-0026](./0026-surface-default-is-detected.md) — the detection this record makes the only
  path; its decision 4 ("an explicit key always wins") is withdrawn.
- [ADR-0027](./0027-codemode-switch-decides-surface.md) — the second probe; its pinned-value notice
  is withdrawn, and the two-functions-trap it records is the same one `[]` vs `["!path"]` walks into.
- [ADR-0029](./0029-surface-follows-codemode-activation.md) — the third probe, and the reason
  detection needs three questions rather than one.
- [ADR-0033](./0033-mcp-auto-enable-evidence.md) — MCP auto-enable evidence; its pinned-surface
  exemption is withdrawn.
