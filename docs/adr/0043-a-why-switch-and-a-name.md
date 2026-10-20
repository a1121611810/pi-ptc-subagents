***

status: accepted (2026-10-19)

# `goal` was the wrong name, and the switch that hides it fails on

## Context

Two things are corrected here, and both are corrections rather than extensions: the name ADR-0042
shipped under, and the fact that it shipped with no way to be turned off.

The name is cheap to change and expensive to keep. `goal` is not a neutral label inside an agent
system — it is the word the ecosystem already spends on an objective or a loop, a thing worked
toward over time. This argument holds something narrower than that: the reason one slice was cut out
of a parent's work. A caller meeting the word fresh has to discard its standing meaning before it can
read the field, and every later reader and every tool description pays the same tax.

The switch is the other half. ADR-0042 ships context that is _always_ delivered, which is the right
default for a measured feature and the wrong one for a feature an operator may have reasons to keep
off: reasons that name a customer's project, an air-gapped run, or an evaluation of someone else's
subtree. There was no way to say so.

## Decision 1 — `goal` is `why`, end to end, with no alias

`pi.dispatch` and `ptc_subagent` take `why`; the child's block is `<pi-ptc-why>`. Breaking, with no
compatibility alias.

- **Why `goal` was wrong.** The ecosystem spends `goal` on an objective or a loop. This argument
  holds the reason one slice was cut out — neither a destination nor the work itself. The name
  promised more than the field carries, and a model reads the name before it reads the description.
- **`background` was the other candidate, and it is unavailable.** The dispatch schema already
  carries a `background` argument meaning "detach the child", one field away on the same object. Two
  arguments about detachment and intent on one schema is a reader's problem, not a feature.
- **No alias.** The only consumer of this argument's name is a model reading the live schema at the
  start of each session: no hand-written integration to keep alive, no serialized argument to
  re-read, no version skew to bridge. An alias would buy no compatibility and would carry two names
  for one value for as long as the feature exists — the exact cost the rename is here to remove.

### What this does to ADR-0042's evidence

Stated plainly, because the two convenient readings are both wrong.

ADR-0042 measured this feature across 180 runs on five model configurations, varying the **presence
and content** of the block while holding its **wording** constant. This change moved the block's tag
(`<pi-ptc-goal>` → `<pi-ptc-why>`) and left the prose exactly as measured — the child still reads
"This goal is context for doing it well".

- **The measurement was not re-run.** Renaming a tag renames a constant; it does not re-test a
  contrast. G0, G1 and G2 all moved together, so no arm was compared against a changed other arm.
- **Rewriting the sentence was not available.** That sentence was held still _because_ it was held
  still: it is part of the input the 180 runs produced. Changing it changes what was constant, and a
  claim resting on new wording is a new measurement, not a rename.
- **The child's input did change.** A child under the new tag is not byte-identical to a child under
  the old one. What is unmeasured is whether the tag mattered. That is a named unknown, not a wash.

## Decision 2 — `whyEnabled`, default on, whose failures fail on

`whyEnabled` in `~/.pi/agent/ptc.json`, default **on**, read once at extension load by
`readWhyEnabledConfig` and consulted per dispatch through `DispatchDeps.whyEnabled`.

- **The failure direction is the design.** A broken value must never remove the feature. A
  non-boolean, an unparseable file, a file that is not a JSON object — all resolve to ON.
- **A broken value is reported, loudly, at `session_start`.** The symptom the user sees is a missing
  block on a _child's_ prompt, the least obvious place to go looking for a typo in their own config;
  without the notice there is no path from symptom to cause.
- **The reader owns the key, not the file.** An unparseable file, or a file of the wrong shape,
  belongs to `readDefaultModeConfig`, which already reports it, so this reader stays silent about
  both. One typo must produce one notice: two identical warnings train a user to ignore warnings, and
  the next real one is discarded with them.
- **The contrast with `optInBindings` is the reason for the direction, not an inconsistency with it.**
  That key's broken value grants nothing, which is safe because it _grants_ — a shell, outside the
  model-facing surface. This one takes something away, so its broken value must hand back what the
  feature is by default.
- **The argument stays on the schema either way.** `why` remains declared on `pi.dispatch` and
  `ptc_subagent` whatever the switch says, so a running program is never rejected for passing an
  argument whose value the switch then drops.
- **A suppression is recorded; the value never is.** `DispatchResult.whySuppressed` and
  `TaskRecord.whySuppressed` carry a boolean about an event the host observed. Nothing writes the
  text to disk. **This amends ADR-0042's "not persisted on the `TaskRecord`", and the amendment is
  narrow:** ADR-0042's reason — that `why` is a caller-held fact rather than a host-measured one —
  reaches the **content** and stops at the **event**. What the host did observe is that it withheld
  something the caller handed it, which is not the caller's fact to re-derive.
- **The event needed recording because a background caller cannot otherwise learn it.** A foreground
  caller reads the flag off its own result. A background dispatch returns a handle, not a result, so
  without the field on the record the caller has no way at all to find out that its reason was
  dropped — and silence there reads as "the child used it".
- **`/ptc why on|off` is session-scoped and never opens the file.** It records one custom session
  entry; `readPersistedWhy` restores the last one on resume, and a record whose payload is not a
  boolean is skipped rather than read as off. The two settings differ in lifetime only — "about this
  conversation" against "about every future one" — which is why the command writes nothing to disk: a
  session toggle that silently rewrote a standing configuration would be a worse surprise than the
  thing it turns off.

## Consequences

- The tag on a child's prompt is no longer the one that was measured; the wording still is. Re-running
  ADR-0042's harness means re-running it whole, not re-reading its table.
- One more boolean on every dispatch result, one more optional key on the background record, and one
  extra model-facing line under the child row when — and only when — a `why` was actually dropped.
- Two ways to set one thing with different lifetimes. `whyReport` names which is in force, because a
  user who opens `ptc.json` after `/ptc why off` is looking at the wrong file unless told.
- The feature is silenceable, which it was not. That is a real capability for an operator and a real
  hazard for a caller who never reads the notice, which is why the notice is not optional.

## Rejected

- **An agent-definition opt-out.** `isReportContractOn` already gates the report contract, and a
  second switch behind the same flag makes one flag mean two things — the failure ADR-0042 rejected
  when it decided `goal` orthogonal to `childReport`. The two answer different questions: what
  contract the child reports under, and whether the caller's reason reaches it at all.
- **A per-dispatch override.** The argument is model-facing and the switch is the user's. An override
  the model can pass hands the decision back to exactly the party it was taken from.
- **Project-scoped configuration.** `readWhyEnabledConfig` reads one fixed path in the agent dir,
  the same file and the same reader boundary as `optInBindings`. A second scope means a second file,
  a second resolution order, and a second question to answer at load.
- **Storing the value, or storing the switch's value alongside the record.** The record answers "was
  it withheld". It does not answer "what did it say" — ADR-0042's reason — and it does not answer
  "what was the switch", which is `whyReport`'s job and which the next session's reader re-reads
  from the file.
- **A sub-row state for the switch itself.** `renderWhySuppressedText` returns `""` unless a `why`
  was actually dropped. The switch does not vary per dispatch, so a row stating it would restate one
  constant on every dispatch to say nothing on the ones that matter.

## See also

- [ADR-0042](./0042-goal-on-dispatch.md) — the decision this amends. Its record keeps the historical
  name `goal`; the arguments above say which of its claims survive.
- `docs/specs/0043-why-switch.md` — the specification.
- ADR-0040 — `optInBindings`, the opt-in whose failure direction is the other way.
