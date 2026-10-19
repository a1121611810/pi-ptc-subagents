---

status: accepted (2026-10-19)

# A dispatch may carry the caller's reason, as context rather than authority

## Context

A dispatched child receives one piece of task content: `task`. Everything else it is told is policy —
depth budget, read-only tier, report contract. The reason the task exists is not among them.

That gap has a measured cost. A child asked to "check whether the retry path is safe" cannot know
which aspect the caller cares about, so it either guesses or answers broadly. Six pilots tried to
measure whether supplying the reason helps and concluded "no measurable benefit" — because the tasks
they used could be satisfied under every interpretation, so a hint had nothing to prioritise.

## Decision

`pi.dispatch` and `ptc_subagent` gain one optional parameter, `goal`: the caller's intent for this
dispatch slice, in the caller's words.

- It is **context, not authority**. The child is told the task remains the deliverable and that a
  disagreement between goal and task is recorded as a finding, not acted on by widening the task.
- It reaches the child as its own `<pi-ptc-goal>` block, **after** `</pi-ptc-context>`. Everything in
  the policy block is the host speaking; the child must be able to tell the host's rules from the
  caller's content.
- Angle brackets in the value are escaped. The risk is not a hostile caller: a model writing prose
  that looks like markup would close the block early.
- An absent or blank goal emits no block. An empty block reads as "there was content and it was
  withheld".
- Not persisted on the `TaskRecord`: unlike `usage`, this is a caller-held fact, not a host-measured
  one.
- **Orthogonal to `childReport`.** That switch is the output contract; this is input context.
  Coupling them would make one switch mean two things, and the failure would be silent.

## Evidence

Twelve conflict fixtures — a visible test and a hidden probe asserting incompatible outcomes — with
three arms (no goal / real goal / equal-length placebo) across five model configurations, 180 runs,
scored on the probe:

| config             | G0   | G1    | G2   | discordant | p      |
| ------------------ | ---- | ----- | ---- | ---------- | ------ |
| deepseek-flash     | 0/12 | 6/12  | 1/12 | 6-0        | 0.0156 |
| MiniMax-M3, off    | 0/12 | 6/12  | 0/12 | 6-0        | 0.0156 |
| M3.1-Flash, low    | 0/12 | 6/12  | 1/12 | 6-0        | 0.0156 |
| M3.1-Flash, medium | 0/12 | 7/12  | 0/12 | 7-0        | 0.0078 |
| M3.1-Flash, high   | 0/12 | 10/12 | 0/12 | 10-0       | 0.0010 |

Every configuration clears the pre-registered threshold. All 35 discordant pairs favour the real
goal; the placebo passes 2 of 60 control runs, so the effect is the goal's content, not extra
context. Adoption, measured separately with no prompt instruction: **4 of 4 dispatches carried a
goal**.

## Consequences

- A parent can now say why a slice exists without writing it into the task text, where it would be
  confused with the deliverable.
- One more optional parameter on the dispatch surface, and one more block in every child's prompt
  when it is used.
- The effect is measured on small local fixtures with four models. Whether it holds on larger work
  is not measured, and the spec records that as a TBD.

## Rejected

- **Folding the goal into the task text.** It would erase the slice/intent distinction the whole
  decision rests on, and the child would have no way to tell which part is the deliverable.
- **Passing the parent's whole conversation.** Cost without bound, and most of it is unrelated to the
  slice.
- **Letting the goal override the task.** That reverses the no-judgment-authority decision and was
  measured to fail: children already follow the task, and a conflicting goal is reported, not
  silently preferred.

## See also

- Map #208 and its decision tickets.
- `docs/specs/0042-goal-on-dispatch.md` — the specification.
- [ADR-0043](./0043-a-why-switch-and-a-name.md) — amended 2026-10-19: the argument is now `why` and the block carries a default-on `whyEnabled` switch. The evidence above stands as recorded; ADR-0043 says what the rename did and did not do to it.
- ADR-0032 — the child report, whose `summary` arms were measured and dropped in the same effort.
