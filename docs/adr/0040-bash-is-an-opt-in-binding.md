# `bash` is an opt-in binding, not part of the default PTC surface

status: accepted (2026-10-13). Ticket #73 (spec #72, sandbox posture). Not an amendment: the
binding surface had no governing record before this one.

**A correction this record makes about its own ticket.** #73's body reads "This is ADR-0023,
landed." That is false and was repeated in two review rounds before anyone checked it. On `main`,
`0023-background-task-ownership.md` is background task ownership; the bash-opt-in record was
drafted as `0023-bash-opt-in`, never merged, and survives only inside the dangling commit
`4fe107bf`. Its implementation `55f332cf` was reverted the same day by `3f5aeafa`, and the
released `v1.1.0` tag contains no opt-in code. So the decision was made, shipped, reverted by a
`git reset`, and re-attributed to the wrong document — which is why this record starts from the
behaviour rather than from the ticket's account of it. The earlier closure was otherwise honest:
the review was real and its counterfactual held; only the deliverable was gone from `main`.

## Context

A PTC program runs as the user, with the user's own machine identity. ADR-0005 records that
binding calls go straight to `tool.execute()` and therefore **bypass pi's `tool_call` pipeline** —
permission gates, path guards, `protected-paths` extensions all never run for them. ADR-0007
records that this package ships no OS sandbox.

Put those two together and `bash` is not like the other six bindings. It is the one binding that
runs arbitrary commands as the user, delivered to model-written code, past every guard pi would
otherwise apply, with nothing between it and the machine but an install.

That was not accidental. `src/runtime/bindings.ts` argued for it explicitly: DSH's PTC preset
mounts `tool-bash`/`tool-pwsh` (R1 §2 — PTC mode hides the built-ins from the wire list and
re-exposes the same registry as bindings), so removing `bash` would silently shrink the surface
relative to DSH and break programs written against it.

## Decision

**`bash` stays in the known set and leaves the default set.** `BUILTIN_BINDING_NAMES` remains the
full seven-name known set — `bash` is reachable, not deleted — and `DEFAULT_BINDING_NAMES` becomes
the known set minus `OPT_IN_BINDING_NAMES`, derived by filter rather than hand-listed. The
surface is narrowed, not amputated, so the DSH-parity concern is answered by a switch rather than
by a break.

Two grants, and they are deliberately not the same mechanism:

- **Programmatic** — `optIns` on `createBuiltinBindings` and on the `resolveBindingNames`
  chokepoint, for embedders.
- **User-facing** — `optInBindings` in `~/.pi/agent/ptc.json`:

  ```json
  { "optInBindings": ["bash"] }
  ```

The two gates are independent on purpose: one is a library seam, the other is a per-install
decision by a person. Neither implies the other.

**The gate has exactly one place it must live, and there are in fact two, and that is fine.** The
load-bearing one is `resolveBindingNames`, because it is the single read point feeding both the
binding table and the model-facing binding list (`src/index.ts`'s briefing, mode-entry and status
strings, plus both tool entrypoints). A gate that filtered only the table would hand the model a
tool it cannot call and hide the reason. `createBuiltinBindings` carries a second, independent gate
for callers that construct a table without going through the chokepoint; a caller-curated `names`
list bypasses both, because a caller that curates names has already decided its surface.

**Fail-closed, everywhere.** An absent file, an unparseable file, a key that is not an array, a
non-string entry, and a name that is not an opt-in all grant **nothing**. The list is read once at
extension load rather than per run: a program must not be able to see a different surface from the
prompt that described it. A broken _file_ is `readDefaultModeConfig`'s to report — one sentence
per broken file, not one per reader — and `readOptInBindingsConfig` reports only what is wrong with
the `optInBindings` key specifically.

**The opt-in is separate from the session's tool set.** pi having `bash` enabled says nothing
about whether this user agreed to hand a model-written program a shell. "Enabled" and "granted"
are different questions, and collapsing them is the defect this record removes.

## What this costs

- **A program that called `tools.bash` by default now fails** with
  `no binding named "bash" in this run; available bindings: …`. The refusal names what _is_
  available, so the fix is readable from the error. This is a breaking change; the migration is one
  line of config, or an explicit `names` list for embedders.
- **`BUILTIN_BINDING_NAMES` must stay at seven.** `dispatcher.ts` ships the full known set as the
  worker's `bindingCandidates`, and the worker installs a **throwing stub** per unbound candidate —
  that is what produces the actionable refusal above. Shrinking the known set would delete the very
  message that tells a user how to fix this, and would make the opt-in ungrantable.
- **A program can still enumerate an unbound name.** `Object.keys(tools)` in the worker lists every
  candidate, because that is how the stubs are installed. Verified on a real pi 1.1.0 session:
  `Object.keys(tools)` contained `bash` while `ptcBindings` — the frozen per-run manifest, and the
  model-facing truth — did not. Name disclosure, not capability; the error text names the available
  bindings anyway, so nothing is secret. Pre-existing shape, inherited from the stub mechanism.
- **Three model-facing surfaces exist, and all of them had to change with this one.** The PTC mode
  briefing / entry / status strings, _and_ the registered `description` of **both** `ptc_run_code`
  and `ptc_workflow`. (This record first wrote "two", naming only `ptc_run_code`, and stayed wrong
  through a review round: `ptc_workflow`'s description said the bound names "mirror the session's
  enabled tools" until the round after, which is this same defect on the sibling surface.)
  The descriptions are static and cannot know whether a run granted the opt-in, so they may offer
  only what is bound by default; `tests/binding-policy.test.ts` pins both, including the sentence
  that states the narrowing — the offer checks alone cannot tell the two wordings apart. A narrowed
  table with prose that still advertises `tools.bash` is the failure mode ADR-0005 §2 already warns
  about, one layer out from where anyone was looking.

## Scope

The PTC line only. Where the detected surface is `subagents`, there is no PTC program, no binding
table and no shell from this package, so the attack this record addresses is unreachable. That
line is still the default on an ordinary install, because pi registers its own orchestration tool
inactive (ADR-0026).

Does not change ADR-0005 (bindings still call `tool.execute()` directly and still bypass
`tool_call`; this record narrows _which_ bindings, not _how_ they are invoked), ADR-0007 (still no
OS sandbox — that plan was closed on 2026-10-13), ADR-0016 (`pi.dispatch` is still bound in every
shipped surface), or ADR-0026/ADR-0027 (surface detection unchanged).
