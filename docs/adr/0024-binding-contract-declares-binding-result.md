# Binding contract: the PTC tool descriptions declare what a binding call resolves to

A PTC program that guesses wrong about the shape of a binding result does not
fail politely. It throws `TypeError: files is not iterable` or
`content.split is not a function`, the model reads the failure, and spends
another turn on the same task. We have the measurement: in a pty-driven run of the
real pi TUI with PTC mode on, 16 runs produced 31 program crashes, and the largest
single error class was the model assuming a binding call returns a bare string or
a `{ files: [...] }` object. Neither assumption is ever true. The model had no
way to know that, because the tool description documents how to _call_ a binding
and never says what a call _resolves to_.

Status: accepted (2026-09-30). Model-facing only: the runtime contract is
untouched, `{ content, details }` still crosses the wire exactly as it did, and
every existing program keeps working unchanged. Everything is additive -- text
the model did not previously receive.

## Context

The binding table re-wraps each pi tool's own result into `{ content, details }`
before it crosses to the worker, and the worker resolves the call with that value
verbatim. So the shape a program actually sees is a two-field object whose
`content` is an array of content blocks, never a string. The text of a
text-file result is `result.content[0].text`. `details` is the tool's own
detail object or `null`. There is no `files`, `output`, `matches` or
`entries` field on any binding result: `bash`, `grep`, `find` and `ls` hand back a single
text block of newline-separated rows, and the program splits it itself. A
_builtin binding_ that fails -- a `bash` non-zero exit, a missing path, a name
not bound this run -- rejects with `ToolCallError`. The `pi.dispatch`
parallel binding is the one exception: it resolves to a `DispatchResult` carrying
`text` and `status` with no `content` at all, and it never throws.

The benchmark separated the two ways this can go wrong. Runs that hit at least
one shape error averaged 8.6 turns and 49,598 context tokens; runs that did not
averaged 5.3 turns and 22,389. That is correlation, not proof -- a run that
struggled wrote a more ambitious program and so had more chances to guess wrong
-- but the mechanism is confirmed by the errors themselves, which are all
attempts to iterate or split a value that is neither a string nor an array.

Upstream solved this differently, and both prior answers are worth reading. DSH
generates a TypeScript SDK section into the _system prompt_, carrying a full
argument map, an output map and a `ToolCallError` declaration; its decisive
detail is that a tool's description is emitted exactly once, on the argument side,
while the output map is a bare name-to-type list. pi 0.99's codemode generates
per-tool declarations into the _tool description_; its decisive detail is that the
declaration and the runtime resolver branch on the _same_ predicate, so they
cannot drift. codemode pays about 152 estimated tokens for a single tool because
it re-emits every argument property with its description as a comment -- our
budget does not have room for that, and the arguments are already declared
natively by pi in the same request.

## What we add

1. **A binding contract** -- one model-facing block, owned by a single module
   and rendered into both the `ptc_run_code` and `ptc_workflow` tool
   descriptions, stating the binding result shape.
2. **Binding notes** -- a per-binding clause inside that block, written only for
   the bindings whose behaviour genuinely departs from the shared shape.
3. **Two coverage guards** -- one proving that every name the contract
   mentions in backticks is either a bindable binding or a listed piece of
   non-binding vocabulary, and one proving that every bound binding is either
   named or knowingly covered by the shared shape, so a binding added later
   cannot ship undocumented.

## What we deliberately don't add

1. **We do not change what a binding resolves to.** Flattening the result to a
   plain string, the way pi's codemode does, is a program-visible breaking change
   to every existing program, and the binding value is precisely what the
   host-side image-capture pass reads, so flattening it needs its own analysis.
   It is a reopen trigger below, not a deliverable.
2. **We do not re-declare arguments.** pi already declares every tool's
   arguments natively in the same request. Restating them per binding is pure
   token cost for a fact the model can already see.
3. **We do not generate the block from a schema.** The return shapes come from
   pi's tool definitions, not from anything this repository owns, so there is no
   schema to generate from. The block is written, and the drift guard is what
   keeps it honest.
4. **We do not render the contract into the PTC-mode briefing.** The briefing is
   a third model-facing surface that lists the same call forms, so the same
   omission exists there. The tool description is the measured surface, it is
   always sent, it has one owner, and it inherits the drift guard for free; the
   briefing would double the cost of every PTC-mode turn and need its own
   third-surface guard. Reopen if the briefing is ever found to be the surface
   the model reads first.

## Decision

### 1. One module owns the text

The contract is defined once and rendered into both tool descriptions. Two
descriptions that each spell out the shape is how the two surfaces would drift
apart the first time a binding changes.

### 2. Return types only

Each documented binding contributes a return type. The argument type stays out of
it: pi's native declarations already carry it in the same request, and a
duplicated argument list is the single largest cost in the upstream version.

### 3. Notes only where behaviour differs

The shared shape is stated once. A _binding note_ is added only for the cases a
program cannot infer from that shape: a binding that rejects instead of
resolving, a binding whose `details` is never absent, and the one binding that
resolves to a shape without `content` at all.

### 4. Two guards, because the names are checked in both directions

The per-binding notes are typed against the binding-name set, so a misspelled or
renamed binding is a type error rather than an orphaned note. The _coverage_
check then runs both ways against the set the extension actually binds:

- nothing the contract names may be outside that set -- the guard reads the
  contract's own backticked tokens and compares them against a literal of the
  non-binding vocabulary, not against the bound names. Iterating the bound names
  instead would make an unbound name structurally invisible, and an earlier draft
  of this record's guard did exactly that.
- every bound binding must be either named or knowingly covered by the shared
  shape. `read` is the one covered-but-unnamed binding: it behaves exactly like
  the shared shape, so it needs no note, and the test states that as a literal so
  a new builtin turns the guard red until somebody decides.

Two limits of that first check are worth stating rather than leaving to be
discovered. It reads **backticked tokens inside the contract block**, not the
surrounding description, and it does not read bare prose. A name written in
either of those places is outside what the check sees. That is deliberate scope,
not an oversight: the block is the text this record owns, and the rest of the
description is prose this record did not add.

The hand-maintained literals here are test expectations, not a second copy of
the binding table. Nothing the resolver reads is written by hand on this side:
the notes are typed against the real binding-name set, so a rename is a type
error. The failure mode both upstream designs avoid -- a list beside the real one
that drifts from it -- is avoided here by keeping those literals on the test
side, where a drift is a red test rather than a wrong answer.

### 5. Budget: a 300-token ceiling with a 200-token floor

The block stays at or under 300 estimated tokens, using the same
characters-per-token estimate upstream uses. The ceiling is a decision, not a
target.

A 200-token floor sits under it. That is a deliberate widening beyond the
original ceiling-only scope: a ceiling-only check passes on an empty block, and
the floor is what makes a stubbed-out contract red. Both numbers are recorded
here so the record and the constants have one place that says them, and both are
pinned by a test that names this record.

Measured on the shipped text: **290** estimated tokens, leaving 10 under the
ceiling. The shortest note in the block is 41 characters, so that headroom no
longer covers a future genuine deviation -- the first cut of this record had 28
tokens free and claimed otherwise, and the catchability clause and the narrowed
`edit` note ate the difference. Treat the ceiling as close, and raise it here
with a reason rather than in a code comment.

For scale, the registered `ptc_run_code` description was 382 estimated tokens
before this change and is 672 after, so the block is roughly 76% of the
pre-existing description. Measured against the whole PTC request prefix the
addition is single-digit, but that denominator is not a thing the model sees on
its own, so the per-surface figure is the one to reason from.

## Consequences

- The model can write a correct first program instead of discovering the shape by
  throwing. Both measured error classes -- iterating a non-iterable, splitting a
  non-string -- become impossible to write against a declared shape.
- The token cost is paid on every request that sees the tool, which is the price
  of the whole mechanism, not of this decision.
- The drift guard converts a documentation omission into a red test, so the
  contract cannot silently fall behind the binding table.
- Existing programs are unaffected. Nothing about the wire or the worker changes.

## Known limitations

- The contract states the shape every builtin binding shares. A binding whose
  own tool deviates in a way this repository cannot see would still need a note.
- `details` is declared as opaque. Its per-tool shape is pi's, and restating it
  would import a contract we do not own.
- Nothing here measures whether the model _uses_ the declaration. Re-running the
  benchmark and comparing crash counts is the only way to close that loop, and
  the first measurement is the one that motivated this ADR. That re-measurement
  is owed and tracked as issue #87; until it lands, this record's claim is that
  the text is correct, not that it helped.
- The three per-binding notes are third-party facts about the installed pi, and a
  pi caret bump can falsify any of them with a green suite. The module cites the
  source for each, and the suite pins the `write` case by running a real binding.

## Reopen triggers

Flattening a binding result to its text, the way pi's codemode does, becomes the
better answer if the re-measurement shows crashes persist despite a correct
declaration, or if a program's ergonomics prove to be the bottleneck rather than
its correctness. That change is breaking, interacts with image hoisting, and
deserves its own record with a migration story.

## Cross-references

- [ADR-0012](./0012-model-facing-result-text.md): how a completion value is
  rendered for the model, and the four senses of "output".
- [ADR-0016](./0016-ptc-dispatch-binding.md): the `pi.dispatch` parallel
  binding and the `DispatchResult` it resolves to.
- [ADR-0007](./0007-no-os-sandbox.md): the execution boundary inside which these
  bindings run.
- docs/research/ptc-upstream-parity-audit-20260930.md: the parity audit.
  Its gap A4 asks for a generated TypeScript SDK section in the _system prompt_
  carrying an argument map and an output map. This record closes the return-shape
  half of that gap in a different place -- the tool description, return types
  only -- and leaves the system-prompt injection, the argument map and the BM25
  tool search open. A4 is narrowed, not closed.
- docs/research/ptc-binding-contract-measurement-20260930.md: the benchmark,
  the crash taxonomy, and the before numbers.
- Issue #87: the re-measurement, owed.
