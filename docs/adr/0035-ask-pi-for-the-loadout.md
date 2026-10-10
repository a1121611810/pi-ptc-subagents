# Surface detection asks pi; only the MCP axis stays a file-side read

status: accepted (2026-10-10)

## Context

ADR-0029 added a third question to **surface mode**: will `codemode` be **active**, i.e. callable
by the model. "pi ships the directory" and "pi loads the extension" were both already answered, and
neither says the model can call it — pi registers `codemode` with `defaultActive: false`.

There was nowhere to ask that question. ADR-0026 had established that registration happens in the
extension factory, and that during extension load `getActiveTools()` and `getAllTools()` are
`notInitialized` stubs which **throw** if called. So the answer had to exist before the factory
returned, and the only way to have it was to build it: parse `--tools`, `--exclude-tools`,
`--no-tools` and `--no-builtin-tools` out of `process.argv`, merge `defaultTools` across the
user-scope and project-scope settings files, and replay pi's precedence over the result. That was
the **loadout mirror**.

The mirror was careful. Its command-line reader reproduced pi's value-consuming grammar and
`--` terminator, and a 294-case differential against pi's own `parseArgs` was added to hold it to
that. Every divergence found beforehand had been argued away with a claim that turned out to be
false — that the errors "only point in the safe direction". They did not, and the 294 cases found
four.

The deeper problem was not accuracy. It was that a mirror is a second implementation of a rule the
host owns, and #131 is what that costs: this package read `<cwd>/.pi/settings.json` off disk with
no trust check, while pi drops project settings for any project it has not been told to trust. So a
project pi declined to read could still put the session on the `subagents` surface, whose
`ptc_run_code` and `ptc_workflow` are registered at `codemode` reach and are therefore reachable
from nowhere when no `codemode` is running.

## The measurement that decided it

A throwaway probe across pi 0.86.1 / 0.87.1 / 0.99.0 / 0.99.1 / 0.99.2 / 1.0.0 / 1.0.4 / 1.1.0,
under both trust decisions, with real provider requests. Branch
`prototype/f2-live-registry-probe`, commit `d63f5a0` — throwaway, not merged, kept as evidence.

| gate                                                          | result                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.getActiveTools()` exists and is usable at `session_start` | **pass**, all eight. Unusable in the factory on all eight — the throw ADR-0026 measured.                                                           |
| `pi.getSettings()` exists                                     | 0.99.0 and later only; absent on 0.86.1 and 0.87.1                                                                                                 |
| `ctx.isProjectTrusted()` exists                               | **pass**, all eight                                                                                                                                |
| the loadout pi hands over already has trust applied           | **pass** — under a declined project the `defaultTools` key is _absent_, not reported-untrusted, and `codemode` is out of the active set            |
| `pi.registerTool()` from an event handler                     | **pass**, all eight — joins the registry, joins the active set, reaches the provider payload, leaves the existing set alone                        |
| `exposure` is not snapshotted at load time                    | **pass** — a `codemode`-reach tool registered late and the same tool registered in the factory give identical declaration results on every version |
| the live read catches MCP auto-enable                         | **fail**                                                                                                                                           |

That last row is the one that shaped the decision. pi activates `codemode` from inside **its own**
`session_start` handler (`extensions/mcp/index.js:840` calls `ensureDiscoveryActive`, which calls
`setActiveTools` at `:378`). Extension order is not ours to choose, and ours loses that race:
a synchronous read here, one microtask later, and one on a zero-delay timer all saw it inactive,
and it appeared roughly 250 ms afterwards.

A control was needed to read the exposure gate honestly. On 0.86.1 and 0.87.1 a late-registered
`codemode`-reach tool **is** declared to the model — but so is a factory-registered one, on those
same versions, because those pis predate the `codemode` exposure value. Without the control that
gate reads as a failure it is not.

## Decision

**Registration moves from the factory to `session_start`, and the loadout axis is read from pi.**

At `session_start` the runtime is bound, the loadout is readable, and pi has already applied both
the command line and its project-trust decision. The mirror — its command-line reader, its
`defaultTools` merge, its precedence replay, and the differential test that held them honest — is
deleted rather than corrected.

**The MCP axis keeps ADR-0033's file-side evidence.** That is not leftover and not redundancy.
pi's MCP activation happens inside a `session_start` handler, so a live read from ours is too
early to have an answer to that question. The file-side evidence answers a question the live read
cannot yet ask; the existing cross-check is what catches the activation when it lands late.

The accepted cost of the alternative is gone: a trusted project that configures `codemode` in its
project-scope `defaultTools` keeps the `subagents` surface, because there is nothing left to
exclude it from anything.

## What this does not decide

- **The codemode switch axis** stays a filesystem-and-settings probe. It may also be collapsible
  into the live registry — a tool absent from `getAllTools()` is either not shipped or not loaded —
  but collapsing it loses the distinction between those two, which is the reason that probe exists.
  Measured and decided separately.
- **ADR-0029's table, its fifth cell, and the two cross-check warnings** are unchanged. Only how
  the activation column is filled changed.
- The failure asymmetry ADR-0029 rests on — over-reporting is caught by measurement, under-reporting
  only costs the delegation — is unchanged, and is now enforced by fewer moving parts.

## Why not just register late and keep everything else

Because the mirror is not only wrong, it is _load-bearing for being wrong early_. Keeping it while
moving registration would mean two answers to one question, with no way to say which one is in
force. Deleting it is what makes the move safe.

## What would retire this

If pi exposed the effective loadout during extension load — a bound runtime earlier in the
sequence — the factory could register without either this indirection or a mirror, and this ADR
would be a historical note rather than a live design. Nothing in pi's current shape offers that.
