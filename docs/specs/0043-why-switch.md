# Spec — Rename the dispatch `goal` to `why`, and give the block a switch

Issues: [#219](https://github.com/a1121611810/pi-ptc-subagents/issues/219) (rename),
[#220](https://github.com/a1121611810/pi-ptc-subagents/issues/220) (switch),
[#221](https://github.com/a1121611810/pi-ptc-subagents/issues/221) (`/ptc why`).
Status: **shipped** — this spec describes what is implemented; ADR-0043 records why.

> One term is deliberately inconsistent across the two documents. ADR-0042 and
> `docs/specs/0042-goal-on-dispatch.md` say `goal`, and the child's block prose still says
> "This goal is context for doing it well" — that sentence was held constant across the 180 measured
> runs, so retiring the word from it is new evidence, not a rename. Everything that describes
> **current** behaviour says `why`; everything that names a thing from the E3 run says `goal`.

## Problem Statement

The argument ADR-0042 added works, and it has two defects that only show up once it ships into a
session.

The first is the name. `pi.dispatch`'s new optional argument is called `goal`, and in an agent
ecosystem `goal` is spent on an objective or a loop — a thing worked toward across many steps. This
argument is narrower than that: the reason one slice was cut out of the parent's work right now. A
caller that meets the word already has a meaning for it and has to discard that meaning to read the
field, and every description of the field has to fight the same prior. The cost lands on a reader
meeting it fresh, which is every model, every session, and every human who opens the schema.

The second is that the block cannot be turned off. ADR-0042 shipped a feature that is _always_
delivered: every dispatch that passes a `why` puts that text into a child process's prompt. That is
the right default for a measured feature, and it leaves an operator with no way to say that a caller's
reason — which may name a customer's project, an unmerged branch, or a subtree under evaluation —
must not leave the parent process. "It is only context and not authority" is a statement about how the
child uses the text, not about whether it should see it.

The two defects have opposite sizes. The name is wrong by one word and costs comprehension on every
read; the switch is missing entirely and costs a capability that cannot be added later without being
visible to every existing caller.

## Solution

Two independent changes, one record.

1. **`goal` becomes `why`**, on `pi.dispatch`, on `ptc_subagent`, and in the child's block tag
   (`<pi-ptc-goal>` → `<pi-ptc-why>`). Breaking, with no compatibility alias. The block's prose is
   untouched, and §Why the prose is unchanged below says why that is a constraint rather than an
   oversight.

2. **`whyEnabled` in `~/.pi/agent/ptc.json`**, default **on**, plus **`/ptc why on|off`** for one
   session. When the switch is off a `why` is dropped rather than delivered, and both the foreground
   result and the background record say that a drop happened.

The switch never rejects the call and never removes the argument from the schema: a program that
passes `why` under a session with the switch off gets a normal result that reports its reason was not
delivered.

## User Stories

1. As a caller meeting the dispatch schema, I want the argument named for what it holds, so that I
   read the reason one slice was cut out rather than an objective or a loop.
2. As an operator, I want to turn the block off for reasons I do not have to justify to a model, so
   that caller's reasons do not leave the parent process.
3. As an operator, I want a **mistyped** value to leave the feature on, so that a typo cannot remove a
   feature by accident.
4. As an operator, I want a mistyped value to **tell me**, so that the symptom I see — a child that
   received no reason — has a cause I can find.
5. As a caller, I want the call to succeed when the switch is off, so that a running program is never
   rejected for an argument whose value the host chose to drop.
6. As a caller, I want to learn that my reason was dropped, so that I do not read a child's silence as
   the child having used it.
7. As a background caller, I want the same information on the handle's record, so that the one front
   that returns no result is not the one front that cannot say anything.
8. As an operator, I want the transcript to record _that_ a reason was dropped and never _what it
   was_, so that turning the feature off does not persist the content it exists to withhold.
9. As an operator, I want `/ptc why off` to last exactly one conversation, so that testing the switch
   does not silently rewrite the setting every future session reads.
10. As an operator, I want `/ptc why` with no argument to report the value **and** where it came from,
    so that a session behaving differently from `ptc.json` is explainable from the session alone.
11. As a maintainer, I want the report opt-out and this switch to stay independent, so that turning
    one off does not turn the other off too.

## Implementation Decisions

### D1 — `why` replaces `goal` on both surfaces, and the tag with it

`why?: string` on `DISPATCH_PARAMETERS` (`src/runtime/bindings.ts`), which `ptc_subagent` imports, so
a test pinning the two key sets equal covers both. `whyBlock` (`src/runtime/dispatch.ts`) emits
`<pi-ptc-why>`. `TaskRecord`, the child report and the tool descriptions follow the rename.

`background` was the other candidate and was never available: the same schema already carries a
`background` argument meaning "detach the child". No alias is kept, because the only consumer is a
model reading the live schema each session — there is no integration to keep alive, and two names for
one value would permanently carry the cost this change exists to remove.

### D2 — Why the block's prose is unchanged

ADR-0042 varied the block's **presence and content** across 180 runs on five model configurations
while holding its **wording** constant. The rename moved a constant — the tag — and all three arms
moved together, so no comparison was re-made and none needed to be. Rewriting "This goal is context
for doing it well" would have changed the input the 180 runs produced, and a claim resting on new
wording needs new evidence rather than a new name.

What is true and is not papered over: the child's prompt is not byte-identical to the measured one,
and whether the tag mattered is unmeasured.

### D3 — `readWhyEnabledConfig` reads one key and fails on

`readWhyEnabledConfig(agentDir)` (`src/mode/ptc-mode.ts`) returns `{ whyEnabled, source, error? }`
and resolves the failure direction to **on**: no file, a missing key, an explicit `true`, a
non-boolean value, unparseable JSON, a non-object payload.

Two of those are silent on purpose. An unparseable file or a file that is not an object belongs to
`readDefaultModeConfig`, which owns that key and already reports it; this reader reports only what is
wrong with the `whyEnabled` **key**. One typo produces one notice, because two identical warnings
teach a user to ignore warnings.

A non-boolean **is** reported — with the path, the key and the type that arrived — and resolves to on.
The contrast with `optInBindings` is the whole argument for the direction: that key hands out a shell
and its broken value grants nothing; this one takes something away, so its broken value must restore
what the feature is by default.

### D4 — The argument stays on the schema

`why` is declared on `pi.dispatch` and `ptc_subagent` regardless of the switch, and the tool
description is unchanged by the switch. A running program is never rejected for passing an argument
whose value the host later drops; the drop is reported, not enforced at the boundary.

### D5 — `resolveWhy` is resolved once per dispatch, above every gate

`resolveWhy(why, enabled)` returns `{ why, suppressed }` — blank and not-suppressed is a different
answer from present and suppressed, and one function is what keeps the two from disagreeing. It
takes the `why` VALUE rather than the whole `DispatchInput`, because the binding front reaches its
two pre-`dispatch()` refusals holding raw, unvalidated arguments and has no `DispatchInput` to hand
over; fabricating one would be a second spelling of the rule. For the same reason the function is
TOTAL: a value that is not a string is treated as no value rather than trimmed, since a wrong-typed
`why` reaches it before any schema has approved it, and a throw there would replace the rejected
result both fronts promise with an exception.

Both `dispatch()` and `dispatchBackground()` resolve it before the background branch and before any
gate, then fold it through a single `finish` wrapper alongside `withReadOnlyTier`. A refusal that
never reached a child therefore still says the caller's reason was dropped, because the refusal
consumed it.

`DispatchDeps.whyEnabled` is read as `deps.whyEnabled !== false`, so a caller that injects no deps
gets the default rather than the absence.

### D6 — The record carries the event, never the content

`DispatchResult.whySuppressed` and `TaskRecord.whySuppressed` are `?: true`. This **amends ADR-0042's**
"not persisted on the `TaskRecord`", narrowly: ADR-0042's reason — `why` is a caller-held fact, not a
host-measured one — reaches the content and stops at the event. The host did measure one thing about
it: that it withheld what the caller handed over.

A background caller is the reason this is not optional. A foreground caller reads the flag off its
own result; a background dispatch returns a handle, so without the field on the record there is no
path from "I passed a why" to "it was withheld".

### D7 — `renderWhySuppressedText` says who suppressed it, and what it did not change

The model-facing line has to name the switch: a caller reading only that line cannot otherwise tell a
session that dropped the block on purpose from one that dropped it by a bug, and the first is a
configuration while the second is a defect. It also has to say the child's **prompt** is what changed
and not its behaviour, or a reader concludes the child ignored an instruction it never received.

`renderWhySuppressedText` returns `""` unless something was actually suppressed, and lives in its own
module because `tools/render.ts` reaches `bindings.ts`, which imports `dispatch.ts` back as a value —
the same reason `read-only-tier-text.ts` exists, and the cycle it avoids has already cost seven
integration tests.

### D8 — `/ptc why` is session-scoped and reports its own provenance

`/ptc why [on|off]` (`src/index.ts`) accepts `on`, `off`, or nothing. It writes one custom session
entry (`PTC_WHY_ENTRY_TYPE`) and mutates `background.dispatchDeps.whyEnabled`, so the change reaches
the next dispatch without an extension reload. It never opens `ptc.json`.

- **Bare `/ptc why`** reports the value _and_ the source, because after a session toggle the file
  still says what it always said and a user who opens it is reading the wrong file.
- **A repeated value** reports the same sentence and writes no second entry: the command doubles as
  the query, so every branch answers the question.
- **An argument that is not a value** warns, names `on`/`off`, and changes nothing — including not
  undoing a decision already made.
- **`readPersistedWhy` skips a record whose payload is not a boolean** rather than reading it as off.
  A record that cannot be read is not a weaker version of an instruction, it is the absence of one,
  and the file's value stands. The scan runs backwards, so the last record in the session wins.
- **A restore is not re-reported** as a `session_start` notice: it is a decision the user already saw
  made.

### D9 — `/ptc why` is not PTC mode

`/ptc off` narrows the tool set; `/ptc why off` drops one prompt block. They share the `/ptc` prefix
and nothing else, and the command dispatcher routes on the first word so that neither can reach the
other's handler.

## Testing Decisions

All tests satisfy the six constraints in `docs/testing-constraints.md`. Every seam below was opened
against prior art rather than written fresh, and the prior art is named because it is what made each
test's shape obvious.

| #   | Seam                      | Prior art                                                                                                                                                                                             | Counterfactual that must turn it red                                    |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S1  | The config reader         | `readOptInBindingsConfig`'s test (`tests/unit/opt-in-bindings-config.test.ts`)                                                                                                                        | Report a broken file here as well as in `defaultMode`                   |
| S2  | The `DispatchResult` flag | `dispatch-child-report`'s test (`tests/unit/dispatch-child-report.test.ts`) — `withReadOnlyTier`, a host-observed fact on the result                                                                  | Drop the flag from a refusal that consumed the `why`                    |
| S3  | The `TaskRecord` flag     | `dispatch-background`'s test (`tests/unit/dispatch-background.test.ts`)                                                                                                                               | Write the key when no `why` was passed                                  |
| S4  | The `/ptc` subcommand     | `surface-command`'s test (`tests/unit/surface-command.test.ts`) — which already carries both "a file too broken to parse raises no notice here" and "the argument changes nothing and writes nothing" | Let `/ptc why maybe` change state, or let `/ptc why off` reach the mode |

- **S1** — `tests/unit/why-enabled-config.test.ts`. Three groups: the block is on unless a file says
  otherwise (no file, no key, explicit `false`, explicit `true` treated as a value and not as absence);
  every broken **key** leaves it on and says why (string, number, explicit `null` reported rather than
  read as absent); every broken **file** leaves it on and says nothing.
- **S2** — in `dispatch-child-report.test.ts`. Switch off: the prompt is the one a blank `why`
  produces, and the caller is told. Switch on and explicit: the block is delivered and nothing is
  recorded. No `why` and switch off: nothing recorded. A **refusal** still states the suppression.
- **S3** — in `dispatch-background.test.ts`: the background record carries the suppression the handle
  cannot, and a background dispatch with no `why` persists no suppression key at all. Absence has to
  be asserted separately because a key that is always present would satisfy the first test.
- **S4** — `tests/unit/ptc-why-command.test.ts`. Off is effective for the next dispatch and durable
  for the session; `on` puts it back, so the switch is not one-way; a resumed session restores the
  decision and a new session starts from the file again; the last record wins; the file is
  byte-identical afterwards and no file appears in the agent dir; a malformed record falls back to the
  shipped default rather than to off; and `/ptc why off` leaves PTC mode, its record and its loadout
  alone.
- **Render** — `tests/unit/ptc-task-tools.test.ts` asserts the line on all three surfaces and that
  nothing is rendered when the record carries no suppression; `tests/unit/ptc-subagent.test.ts`
  asserts the structured `why_suppressed` key beside the existing report fields.

S2 and S4 are the two that fail **silently** if wrong — a flag that is simply absent reads as a
feature that does not exist, and a subcommand that accepts anything reads as one that works — so both
assert on content, not on a count.

## Out of Scope

- **Rewriting the block's prose** to say `why` throughout. It is the constant the 180 measured runs
  held still; changing it is new evidence (D2).
- **Re-running ADR-0042's experiment.** Nothing in this change re-tests a contrast (D2).
- **A compatibility alias for `goal`.** No consumer would read it (D1).
- **An agent-definition opt-out, a per-dispatch override, project-scoped config, storing the value,
  or a sub-row state for the switch.** Recorded with reasons in ADR-0043 §Rejected.
- **Removing the switch, or defaulting it off.** The measurement argues for delivering by default;
  the reason to ship a switch at all is that an operator needs one, not that the default is wrong.
- **Making the suppression a `DispatchResult.status`.** It is not a failure. A refusal is a refusal;
  a delivered result with a dropped `why` is a success that also reports what it did not carry.

## Further Notes

### Documents this change amends

- `docs/adr/0042-goal-on-dispatch.md` — a pointer to ADR-0043, and nothing else. Its body is the
  record of the experiment, whose arms were called G0 / G1 / G2 under the name `goal`, so renaming its
  prose would make it describe an experiment nobody ran.
- `docs/specs/0042-goal-on-dispatch.md` — carries the same note in its header.
- `GLOSSARY.md` — the `why` glossary entry (rewritten in #219) gains the `whyEnabled` entry beside it.
- ADR-0040 — cited for `optInBindings`, not amended: its opt-in is a grant, and a grant failing closed
  is still correct there.

### What a later change would have to measure

Whether the tag mattered. A model that has read `<pi-ptc-goal>` in training and sees `<pi-ptc-why>`
may weight the block differently, and nothing here would detect it. The honest form of that statement
is a new experiment with the tag as the varied factor, not a claim carried forward from ADR-0042.

## Source documents

- ADR-0043 — the decision record for both changes.
- ADR-0042 — the decision being renamed; its Evidence table is what D2 is about.
- ADR-0040 — `bash` as an opt-in binding.
- ADR-0032 — the child report, whose result-side field is the model for S2.
- `docs/specs/0042-goal-on-dispatch.md` — the experiment's specification.
- `docs/testing-constraints.md` — the six constraints every test above satisfies.
