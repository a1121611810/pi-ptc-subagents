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
  security documentation — `docs/security.md` (pi upstream, `packages/coding-agent/docs/`) —
  records that it runs with the permissions of the account that started it, that it does not ask
  for approval before each tool call, and that the absence of a built-in sandbox is outside its
  security boundary.

Put together: a strict child is genuinely unable to write, and calling that a security boundary
would be false.

## Decision

**One optional parameter on the dispatch call, in two tiers, decided by the caller.**
`readOnly?: "strict" | "lenient"` — strings only.

- **`"strict"`** — the child's tool list becomes the read set
  (`read`, `grep`, `find`, `ls`) plus the child report tool when the report contract is on for
  that agent. The write tools are not declared to the child at all, so it cannot call them.
- **`"lenient"`** — the tool list is left **byte-identical** to a dispatch with no tier. The only
  effect is one line in the `<pi-ptc-context>` block the child is already given, saying to work
  without modifying anything. The child can write; it has been told not to.

Absent and `null` both mean "no tier". There is no boolean short spelling, and that is the
single most consequential decision in this record: see the section below for the measured reason.

**Strings only, because pi coerces booleans and that coercion was not benign.** The parameter
started as `readOnly?: boolean | "strict" | "lenient"`, with `true` as the short spelling of
"strict". Measured against pi's `validateToolArguments`, that union was the exception to a rule
every mainstream validator follows:

| You write             | pi hands your code | Effect                      |
| --------------------- | ------------------ | --------------------------- |
| `1`, `"1"`, `"true"`  | `true`             | silently `strict`           |
| `0`, `"0"`, `"false"` | `false`            | silently **no tier at all** |

That last row is the failure `docs/testing-constraints.md` #3 exists to forbid: a caller who asked
to be read-only got a full-capability child, and nobody reported it. The coercion also defeated
every guard this repository can write, because pi hands `execute` the validated value — the
caller's own spelling is gone by then.

The schema's answer was a string enum. `Type.Literal("strict")` compares strictly and refuses
`1`, `0`, `true`, `"true"`, `[]` and `{}`, where `Type.Literal(true)` accepts the same four
boolean-ish forms. Under a union of string literals the hole closes at the schema — before the
coercion, not behind it — with no `prepareArguments` hook, no new pi contract, and no `compat:pi`
measurement. That a pure string enum is also the shape tool schemas carry most widely is a
benefit, not the reason.

The cost is one token: the model writes `"strict"` where it once wrote `true`. The spec's
original user story asked for the shortest _flat_ spelling rather than a nested object, and
`"strict"` is still flat; the boolean was an alias the story did not require.

**Call-site precedence is total for `strict`.** A strict tier set on the call decides the tool list
outright, and an agent definition's declared `tools:` is not consulted. The direction is the point:
the caller asked for a mode, and a role that quietly reinstates a tool they removed would make the
parameter a suggestion. `lenient` raises no precedence question, because it never reaches the tool
list: the definition still decides it, exactly as for a dispatch with no tier, which is what
byte-identical means.

**The tier that took effect is reported.** `DispatchResult` and `TaskRecord` both carry
`readOnlyTier`, and the background front projects it to the caller as `read_only_tier`. It is
present whenever a tier was requested and absent when none was, so an override is never silent.

The value cannot differ from the request — a valid tier is applied, an invalid one is refused at
the read point, and the report-contract interaction is visible in the definition the caller named
— so **the field is an echo, and it is recorded as one rather than dressed up as a negotiation.**
It earns its place on visibility, not on information: a caller who named a definition that
declares `tools:` and also asked for strict has to be able to say which of the two decided the
child's tools without re-deriving it from the agent roster. The cost is real — the field rides
the task record and the output projection so the background front is not the one front that stays
silent — and it was paid knowingly, after first deciding not to.

### The tier is reported TWICE, because the schema field has no reader

`readOnlyTier` on the result and `read_only_tier` in `structuredContent` are the right shape for a
**program**. They are not enough for the thing user story 10 is actually about.

`ptc_subagent` is a `direct` tool, and pi never hands a `direct` tool's `structuredContent` to the
model — this repository already records that fact at `src/tools/subagent.ts`, where it is why
declaring `outputSchema` is free. So the projection reaches codemode scripts and reaches nothing
else. A parent model reading the tool result never sees the tier.

The second report is therefore a rendered line, above the child report block and above the
child's prose, because it is a fact about what the child was _allowed to do_ and the model should
read it before anything it might attribute to the child. It appears on the settled path and on the
background handle, and it is absent when no tier was requested — the spec's own rule, and the only
honest option on a surface the model reads.

The lenient line says its tools are **UNCHANGED**. That clause is not filler: a model told only
"lenient" would reasonably assume the write tools had been removed and would then report a
guarantee it does not have. Both halves of the tier are stated, including the half that is a
promise rather than a narrowing.

### The invalid-value guard is defence in depth, and the schema is the boundary

The guard in `dispatch()` exists because `dispatch()` is a module-level function, and callers
that build their own arguments — the test suite among them — reach it without going through any
schema. For them, a value that is neither a tier nor a no-tier spelling is a real input, and the
guard refuses it with the rejected `DispatchResult` the repo already uses rather than throwing,
because ADR-0016 §3 requires the binding never throws.

It is **not** the boundary on the production fronts, and this record does not claim it is. Both
production paths reach `dispatch()` only after pi's `validateToolArguments` has run, and the
schema is a string enum now, so `1`, `0`, `"true"`, `[]` and the rest are refused before any code
here sees them. The earlier iteration of this design had the guard defending a hole the guard
could not see — pi coerced the boolean union upstream — and that history is why the schema is the
way it is; the guard survived because it guards a seam the schema does not, not because it guards
the one it does.

`undefined` and `null` stay usable: they are the two spellings of "I asked for nothing", and the
schema maps `null` to an absent value. `false` does **not** stay usable — it used to mean "no
tier", and under a string enum it is a wrong-typed value, so it is refused rather than quietly
honoured. That is the improvement this decision bought: the value a caller is most likely to
reach for by mistake now gets an answer instead of a full-capability child.

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
the tier reduces what a wrong child can do rather than what an adversary can. Pi's security
documentation — `docs/security.md` (pi upstream, `packages/coding-agent/docs/`) — places the
absence of a sandbox outside pi's boundary; this record extends the same statement to the
narrowing, and any future change that needs a real boundary has to bring one rather than
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

### The refusal row is tested below the e2e seam

The e2e smoke harness calls `dispatch()` directly and so never reaches argument validation, which
leaves one row of the behaviour matrix invisible from it: an unrecognised tier refused at the
boundary. That row therefore lives in the boundary test (`tests/bindings.test.ts`) while every
other behaviour stays in the e2e file — a fact about the seam, not a gap in the coverage.

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
- **A boolean short spelling (`readOnly: true`).** Built, then reversed when measured: pi
  coerces the boolean union, so `readOnly: 0` silently became no tier — a full-capability child
  for a caller who asked to be read-only. Reversed on the measurement, not on taste, and before
  release: an earlier draft of this line said "shipped", which is false — **no published tag
  contains `readOnly` at all** (`git grep readOnly <tag> -- src` returns nothing on all 21).
- **Refusing upstream of the coercion** (`prepareArguments`, or the binding's pre-validation
  `raw` read). Recorded while the boolean union was the design and the schema could not close
  the hole. Moot once the union went string-only: the schema closes it before the coercion
  happens, so nothing upstream needs refusing.
- **Reporting the applied tier in the result.** Decided against at first, on the grounds that the
  value can only echo the caller's own input. Reversed: the field carries no information the
  caller lacks, but it carries the one thing they would otherwise have to re-derive — that their
  tier, not the definition, decided the child's tools.
