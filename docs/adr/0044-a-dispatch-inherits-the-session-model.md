---

status: accepted (2026-10-19)

# A dispatch inherits the session model

> **Amended by [ADR-0045](./0045-observed-model-field-names.md) (2026-10-19): the result/record fields are named `observedProvider` / `observedModel`. This record's Decision 2 keeps the semantics; only the names change.**

## Context

A dispatched child is a fresh `pi` subprocess: it has its own session, its own context, and its
own model resolution. Before this record, that resolution had three tiers — the dispatch's
`model` argument, then the named agent definition's frontmatter `model:`, then pi's configured
global default. The calling session's model was never consulted.

The three tiers describe a caller who states a model, or an operator who configures one globally.
They do not describe a caller whose **session is running a particular model**. After a mid-session
switch, that caller's next dispatch resolved against a default the caller did not choose, and no
surface said so. Two properties were missing at once:

- **The child did not inherit the ambient intent.** A model switch happens for a reason — a rate
  limit, cost, a capability one model has and another lacks. The switch describes the session; a
  dispatch spawned from that session should describe it too, unless the call or the definition
  deliberately says otherwise.
- **The child did not say which model it ran.** `DispatchResult` carried text, status, usage and
  a failure message, and none of them named the provider or model that served the child. The
  caller could not observe the mismatch on the result it already awaited, and an operator reading
  a task record could not attribute a failure to the model that produced it.

The two gaps compound: a dispatch that silently falls back to a default is exactly the dispatch
whose failure the caller cannot interpret. This record fixes the behaviour (**inherit**) and the
observation (**report the observed model**) together, because an inheritance the caller cannot
verify would be a different version of the same silent mismatch. The failure-reporting half is
recorded here too, for the same reason: a child that fails before writing text must still say what
happened, or "the model produced nothing" is the only thing the caller can read.

Why this belongs in the dispatcher rather than in the caller: the session model is pi state, not
package state, and every dispatch front — `pi.dispatch` from a program, `ptc_subagent` from the
model — already goes through the same `dispatch()`. Resolution and observation can therefore have
one home. [ADR-0039](./0039-an-omitted-agent-dispatches-a-generalist.md) settled the analogous
question for the agent name: an omitted input means "the ambient child", not "refuse". An omitted
`model` now means "the ambient model" rather than "a global default".

## Decision 1 — precedence: call site, definition, session, pi default

First match wins:

1. the dispatch's `model` argument — the caller is explicit;
2. the named agent definition's frontmatter `model:` — a deliberate narrowing that belongs to the
   role;
3. the **caller session's current model**, read from pi's tool-execution context for the turn
   that issues the dispatch;
4. pi's configured default — no `--model` flag is passed at all.

The session tier is spelled exactly like the other two: one `--model <provider>/<id>` argument.
The pair is `{ provider, id }`; `provider/id` is pi's own qualified spelling, so no second
`--provider` flag is added and no tier can be spelled differently from another.

The context is read structurally, never through a pi type: the reader accepts `unknown`, validates
each field, and any value that is not two non-empty, whitespace-free, non-dash-leading strings of
bounded length resolves to `undefined`. That `undefined` is the
fallback, not an error — the dispatch keeps pi's default exactly as every call did before this
record. This is also the floor story: the package declares support back to pi 0.86.0, whose type
surface may not carry the field, so the read adds no compile-time dependency on it. Where the
context has no usable model — an old pi, a direct library caller, a session started without one —
nothing changes.

The model is read once for the turn that issues the dispatch and resolved into the child's argv
at spawn — a **snapshot**. Three consequences, stated once and relied on
elsewhere: a model switched after the spawn does not retro-change a child already running; a
nested dispatch inherits the child's own session model, which is the model the child is actually
running rather than the originating session's; and re-running the dispatch is how a caller picks up
a new model.

## Decision 2 — the model a child actually ran is reported

One observation, folded from the child's assistant turns by one accumulator (last turn wins, per
field), is stated on every surface that already carries the child's facts:

- `DispatchResult.observedProvider?` / `DispatchResult.observedModel?` — the foreground result.
- `TaskRecord.provider?` / `TaskRecord.model?` — the background record, written at the same
  terminal close that writes `usage`, so a failed or canceled close still states the pair when a
  turn named it.
- a `model: provider/id` line on the `ptc_subagent` result text, after the child-report block and
  before the child's prose, and on `ptc_task_output`, after the report/usage block and before the
  prose. Neither line enters the child-report XML: this is a host measurement, not a child claim.
- the `model=` fact inside a refused `ptc_subagent` call's diagnostic, so a refusal says what
  served the call when something did.

The rendering is `provider/id` when both were observed and `id` alone when only the model was. A
half-observation is still an observation; dropping it because the pair is incomplete would lose
the only fact available. The absence of both fields is a claim about the **transcript**, not about
the child: **no observed assistant turn named a provider or a model**. Three cases produce it — no
assistant turn ever reached the host (a dispatch that never started, or a close that resolved
before a turn landed); a pi within the declared support range whose assistant turns do not carry
the pair, which the structural read deliberately tolerates; and a record written before the fields
existed. It never means the child "ran on an unknown model": the child may well have run a model
the host was not given a name for.

The rendering is defensive, because the pair is untrusted child wire data being interpolated into
model-facing text: ANSI escape sequences and control characters are stripped before the value is
used, and the rendered value is head-capped at **200 characters** so a `model:` line stays one
bounded line. The cap keeps the front — a provider/model name is recognisable at its start, and a
tail cut can only make it less identifiable — and it applies to the rendered value including the
provider prefix.

Why report a model the caller chose, or can now infer: resolution can land one tier below the call
site (the definition's or the session's), and in the background case the caller is not present when
the child runs. The result and the record are where the caller learns what its delegation actually
ran on — and they are what make the inheritance checkable rather than merely implemented.

## Decision 3 — a rejected child states the child's own failure

The failure half of the same property. This is not new semantics: it is
[ADR-0022](./0022-background-dispatch.md) §2's rule for a child that failed silently (2026-09-30
amendment) reaching the foreground path, where it had been missing.

A child that hits a rate limit or a model error can exit 0 after writing `stopReason: "error"`
plus an error message on its assistant turn — the exit code carries no signal. The close decision
now returns that child-reported error **verbatim** as the result's `errorMessage`. The full order:

1. the run was cancelled — `dispatch cancelled`;
2. exit 0 and the child produced text — fulfilled (an answer is an answer, even if an earlier
   retry reported an error);
3. a non-empty child-reported error — rejected with that error, unwrapped, so the caller reads the
   provider's own diagnosis rather than a paraphrase of it;
4. exit 0 with no text and no child error — `dispatch produced no final text`;
5. otherwise — the existing truncation inference, absent when stderr says nothing.

The order mirrors the background registry on purpose: one transcript must not resolve one way on
the foreground front and another way on the background front. Only a rejected close that carries a
child-reported error logs a warning (`foreground dispatch failed: <child error>`); a pure abort
with no child error, and the depth, concurrency and spawn refusals, stay as quiet as they were. A
cancel that raced a child-reported error still warns, because the warning states the child's
diagnosis rather than a reaction to the cancellation.

**No stderr promise.** ADR-0016 §Decision 3's "stderr and errorMessage populated" was never
guaranteed and is now stated correctly: `stderr` is best-effort, while `errorMessage` is the
structured channel and is absent when no diagnostic exists. A `ptc_subagent` refusal renders a
bounded single-line diagnostic from the result's own fields — the cause, then `child ran` /
`harness declined to start`, `exit=`, `turns=`, `reportChannel=`, and `model=` when observed —
instead of the `refused the call: undefined` the absence used to produce. The bound is 800
characters, keeping the tail where a provider's actionable status code usually is; a diagnostic
that fits is unchanged.

## Consequences

- **Behaviour change: omission no longer means pi's global default.** A dispatch whose call and
  definition name no model now passes `--model <provider>/<id>` from the caller's session. A
  session that switched provider or model mid-conversation now carries the switch into its next
  dispatched child — the pointer a user would expect, and the opposite of what the
  background-dispatch guide said before this record.
- A caller who wants the previous behaviour pins the model explicitly at the call site or in the
  agent definition. Those two tiers are unchanged.
- **Cost and quota attribution moves to the caller's model.** Children now run the model the
  session runs, so their token spend lands on that model's quota rather than on the global
  default's. Where a caller relied on cheaper children, pinning is the explicit tool.
- No config key is added and no opt-out exists. A dispatch that must not inherit pins a model; that
  is the opt-out and it needs no key.
- Scenarios without inheritance are unchanged: a direct library caller with no context model, a pi
  too old to expose one, and a session started without a model all dispatch exactly as they did
  before. The observation fields are optional, so old records and old result shapes keep working;
  `TaskRecord` is 28 fields today (the last two are the optional pair), persisted as before.
- The nested-dispatch chain stays coherent: a grandchild inherits the child's session model — the
  model the child itself runs — not the originating session's.
- One more model-facing line per surfaced dispatch and per background output page, absent when no
  observed assistant turn named a provider or model.

## Rejected

- **Observability only — report the model, do not inherit it.** This makes the mismatch visible but
  still silently wrong: the caller reads that its child ran another model and must re-dispatch,
  paying for the first child. Reporting is what makes inheritance verifiable; it is not a
  substitute for it.
- **A config key to opt out of inheritance** (for example inheritSessionModel: false). It is a
  second place to state what the call site can already state, and a default that would have to be
  right for every caller. The failure direction of a typo in an opt-out is silent non-inheritance —
  the bug this record removes. Pinning at the call site is per-dispatch, explicit, and needs no key.
- **A `model: "inherit"` sentinel.** It spells out the default: every caller must learn a magic
  string to obtain the behaviour omitting the argument already gives, and one schema value would
  then mean three things (pin, inherit, absent). Absence _is_ inherit where possible, so the
  sentinel would be a second name for the same thing. It would also have to be documented as a
  reserved value that no provider may use as a model id.
- **Reading the session model from settings or config instead of the tool-execution context.** The
  settings default is the global tier that already exists; it cannot know about a mid-session
  switch, which is the case this record addresses.
- **Passing `--provider` separately from `--model`.** pi's own resolver prefers the provider
  prefix when it names a known provider; the single qualified `--model` is the spelling the other
  tiers already use, so one form serves all tiers and no second flag can disagree with it.
- **Putting the observed model in the child report.** The model is measured by the host from the
  wire. A report field would invite a child to declare its own model, which is exactly the authority
  the host does not delegate ([ADR-0032](./0032-child-report.md)).

## Relationship to ADR-0016 and ADR-0022

This ADR amends ADR-0016 and ADR-0022 by reference. Where the two ADRs read differently, this one
governs; the bullets below name the sections and what each record keeps.

- **ADR-0016** gains the model-precedence rule, the two optional result fields, and the corrected
  rejection semantics in its Decision §3. Its binding surface, concurrency cap, depth cap and
  untrusted-input boundary are untouched. The rationale for inheriting at all is this record's;
  ADR-0016 records the resulting field and argument contract.
- **ADR-0022** gains the two optional record fields in its §3. The state machine, subscription,
  notification and report decisions are untouched. The background pump and the foreground close
  fold the same observation with the same accumulator, which is the foreground/background parity
  that §2's 2026-09-30 amendment asked for.
- [ADR-0039](./0039-an-omitted-agent-dispatches-a-generalist.md) left an omitted `agent` meaning
  "the ambient child"; an omitted `model` now means "the ambient model", the same reading applied
  to the other resolution input.
- [ADR-0032](./0032-child-report.md)'s report and usage are unchanged; the observed model is
  host-measured and sits outside the report block.
- [ADR-0041](./0041-read-only-is-a-call-site-tier.md) is the other call-site narrowing on the
  dispatch schema; it is orthogonal — a tier changes the child's tools, never its model.

## See also

- [ADR-0016](./0016-ptc-dispatch-binding.md) — the binding and its result contract, amended here.
- [ADR-0022](./0022-background-dispatch.md) — the background lifecycle whose record gains the
  fields, and whose silent-failure rule the foreground now shares.
- [ADR-0032](./0032-child-report.md) — the child report, and why the model line is not in it.
- [ADR-0040](./0040-bash-is-an-opt-in-binding.md) — the other binding-surface decision, unchanged.
