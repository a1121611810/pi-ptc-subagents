***

status: accepted (2026-10-19)

# The observed-model fields say "observed"

> **Amended by [ADR-0052](./0052-the-two-doors-share-one-prefix.md) (2026-10-21): the two task doors are renamed — `pi.dispatch` → `pi_task_ptc` (the PTC door, a binding inside a program) and `ptc_subagent` → `pi_task_codemode` (the codemode door, reachable from a `codemode` script) — with no alias and no compatibility shim. This record's decisions stand unchanged; read its `pi.dispatch` / `ptc_subagent` as those names.**

## Context

[ADR-0044](./0044-a-dispatch-inherits-the-session-model.md) Decision 2 made a dispatch report the
model its child actually ran: `DispatchResult` and `TaskRecord` gained a `provider` / `model` pair,
read by the host from the child's assistant turns. That solved observability and left a naming
problem. `model` is the **requested model** on the input side (the `pi.dispatch` / `ptc_subagent`
argument, the agent definition's frontmatter) and the **observed model** on the output side. Two
different facts, one property name. A program that compares `input.model` with `result.model`
compares a request with a measurement and can read agreement that does not hold.

Field-tested: #223. The glossary already separates the words (requested / session / configured
default / observed model); a glossary cannot fix a wire shape.

## Decision

Rename the **output side**:

- `DispatchResult.provider?` / `DispatchResult.model?` → **`observedProvider?` /
  `observedModel?`**
- `TaskRecord.provider?` / `TaskRecord.model?` → **`observedProvider?` / `observedModel?`**

The input keeps its name: `model` remains the **requested model**. Nothing about resolution
changes — this record renames fields, it does not revise ADR-0044.

### Scope boundaries

- **The child wire does not change.** An assistant `message_end` still carries `provider` /
  `model`; those are pi's fields, read by the host and mapped onto the renamed host-side fields.
- **Model-facing text does not change.** The `model: provider/id` line and the `model=` fact in a
  refusal diagnostic describe the observed model and keep their wording.
- **Persisted records are read one-way.** A record written before this record carries `provider`
  / `model`; the file adapter normalizes those to the observed names on load, so a pre-upgrade
  record keeps its observation. New writes emit only the new names.
- **No aliases.** Keeping `model` beside `observedModel` would recreate the drift under a second
  name; the old names survive only in the read-edge normalizer.
- **Breaking.** `DispatchResult` is program-visible and `TaskRecord` is persisted JSON; the rename
  is a breaking change and belongs to the next major release.

## Consequences

A caller reads two names for two facts without consulting prose. The input/output distinction
that ADR-0044's incident turned on becomes visible in the field name itself: the requested model
is what you asked for, the observed model is what the host saw run, and a result that reports the
second while you hold the first is legible.

The compatibility cost is one normalizer at the storage read edge plus a breaking note in
CHANGELOG. Old result shapes are not aliased, so an old program that reads `result.provider` fails
loudly at the next major rather than silently reading a different fact.

## Alternatives

- **Keep both names and rely on the glossary** (option 1 in #223). Zero cost, but the false
  equality stays reachable in code and in any tool-facing surface; rejected.
- **Add observed aliases while keeping `model`** (option 3). Additive, but one fact with two names
  is exactly the drift the repository avoids elsewhere; rejected.
- **Nest the pair as `observed: { provider?, model? }`.** One extra level; the half-observation
  semantics (provider absent, model present) become a nested partial object rather than optional
  flat fields; rejected as more shape for no new information.

## Relationship to ADR-0044, ADR-0016 and ADR-0022

This record amends ADR-0044 Decision 2, ADR-0016 Decision 1 and ADR-0022 §3 by reference: the
field names change, the decisions do not. Where the earlier records name `provider` / `model`,
read the observed names. Where they read differently about anything else, the earlier record
governs unchanged.
