# A read-only tier is a call-site decision, and it is a narrowing rather than a boundary

status: accepted (2026-10-15). Spec #198.

## Context

A caller who wants a child that cannot touch the workspace had exactly one route: write an agent
definition that declares `tools:`, and dispatch it by name. That route costs a file on disk for
what is a single decision about one call, and it picks the decision's shape — the caller chooses a
**role** when what they have is a **mode**.

The alternative route, saying "work read-only" in the task text, is indistinguishable from any
other instruction in that text: nothing marks it as binding, and nothing would tell a later reader
that this particular sentence was load-bearing.

Two facts about the host shape what is possible, and both were verified against the installed
pi rather than inferred:

- pi reads `--tools` as an **allowlist**, applied in the session constructor and enforced by a hard
  gate that `setActiveTools` cannot widen past. A name that is not on the list is not declared to
  the model. So a narrowed child is reachable with one flag and no guard process.
- pi has **no** permission mode, no read-only mode, no approval gate and no sandbox. Its own
  security documentation records that it runs with the permissions of the account that started it,
  that it does not ask for approval before each tool call, and that the absence of a built-in
  sandbox is outside its security boundary.

Put together: a strict child is genuinely unable to write, and calling that a security boundary
would be false.

## Decision

**One optional parameter on the dispatch call, in two tiers, decided by the caller.**
`readOnly?: boolean | "strict" | "lenient"`.

- **`"strict"`, and `true` as its short spelling** — the child's tool list becomes the read set
  (`read`, `grep`, `find`, `ls`) plus the child report tool when the report contract is on for
  that agent. The write tools are not declared to the child at all, so it cannot call them.
- **`"lenient"`** — the tool list is left **byte-identical** to a dispatch with no tier. The only
  effect is one line in the `<pi-ptc-context>` block the child is already given, saying to work
  without modifying anything. The child can write; it has been told not to.

Absent, `false` and any value outside the union behave as no tier. `true` is folded into
`"strict"` by one resolver before anything downstream sees it, so no second state is ever stored
or compared. An unrecognised value is refused at the argument boundary rather than reaching the
child as a tier nobody implements.

**Call-site precedence is total.** A tier set on the call decides the tool list outright, and an
agent definition's declared `tools:` is not consulted. The direction is the point: the caller asked
for a mode, and a role that quietly reinstates a tool they removed would make the parameter a
suggestion.

**No field reports which tier took effect.** Precedence being total, the requested tier and the
applied tier are the same value in every reachable case — a valid tier is applied, an invalid one
is refused at the boundary, and the report-contract interaction is visible in the definition the
caller named. A result field could therefore only echo the caller's own input, and the background
front would have had to carry that echo through the task record and the output tool to deliver it.

### The strict set is derived, not a constant

The read set plus the report tool is a computed list, because the report tool is conditional on
`childReport`, which `childToolList` already knows. An agent that opted out of the report contract
must not be handed the report tool: the flag would activate a tool the child's prompt never asked
it to call, which is the "registered, documented, never called" state ADR-0032's merge exists to
prevent.

### `bash` is absent from the strict set, and that is the whole caveat

A child holding `bash` could write through it. Including it would make the tier a label rather than
a narrowing, and nothing in this repository could tell the difference afterwards. The tier is
therefore honest about being narrow, which is the trade the caller is being offered: strict is
strict _because_ it also takes away running things.

### Not a security boundary, in those words

Nothing here contains a hostile child. A child is a model that may be wrong, not an attacker, and
the tier reduces what a wrong child can do rather than what an adversary can. `docs/security.md`
places the absence of a sandbox outside pi's boundary; this record extends the same statement to
the narrowing, and any future change that needs a real boundary has to bring one rather than
re-describe this.

### No guard extension, and no `--no-extensions`

The child keeps its extensions. Disabling them would remove the report tool the strict tier
depends on, and pi's tool-call handlers fail closed, so a guard extension's own bug would turn a
read-only child into a wedged one — a failure far harder to diagnose than the narrowing it was
meant to harden. pi ships a read-only plan-mode example built the other way; it is not copied here
because its cost model is different from ours.

### Discovery is one-sided, deliberately

The dispatch parameter schema is shared by the top-level subagent tool and by the parallel binding
inside a PTC program, so one edit gives both surfaces the parameter and both surfaces validate it.
Only the top-level tool's schema is **read by a model**; the parallel binding's arguments are not
enumerated anywhere in the model's prompt today, and this change does not make them so. The
binding contract states binding _result_ shapes and its second rule deliberately excludes
arguments, so advertising a parameter list there means overturning a rule that is not about this
parameter. Filed as follow-up work rather than smuggled in here.

## Consequences

- A caller can dispatch a read-only child without authoring a file, and can still name a
  definition to pair a role with a mode.
- The two tiers are distinguishable at a glance from the child's own argv and prompt, which is
  what makes "lenient" reviewable rather than a promise.
- The strict tier cannot run tests, cannot call `git`, and cannot install anything. That is the
  trade, and it is why lenient exists.
- One parameter's schema is declared twice by hand; a compile-time key-equality check holds the two
  against the input type, so a one-sided edit fails `typecheck` rather than the suite.
- The binding contract's token budget and its rule against arguments are untouched.

## Alternatives recorded

- **A guard extension vetoing tool calls in the child.** A real execution-time veto rather than a
  declaration-time narrowing, and it fails closed, so a guard bug wedges every read-only child.
  Rejected on diagnosability.
- **`--no-extensions` on the child.** Kills the report tool the tier needs. Rejected.
- **A standing policy in config.** The decision is per call; a session that asks a read-only survey
  and a writing fix in one turn should not need two sessions. Rejected.
- **The tier in agent-definition frontmatter.** Reinstates the wrong home this decision removes,
  and the parser's exact key set is pinned by an existing test. Rejected.
- **Reporting the applied tier in the result.** An echo of the caller's own input, at the cost of
  carrying it through the task record for the background front. Rejected.
