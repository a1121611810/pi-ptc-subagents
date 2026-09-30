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
detail object or `null`. There is no `files`, `output` or `matches` field
on any binding result: `bash`, `grep`, `find` and `ls` hand back a single
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
3. **A drift guard** -- a test proving the contract's documented names are
   exactly the bound names, so a binding added later cannot ship undocumented.

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

### 4. The contract is keyed to the bound-name set, not to a parallel literal

The documented names are checked against the set the extension actually binds.
A hand-maintained list beside the real one is precisely the failure mode both
upstream designs avoid -- DSH by requiring an output schema unconditionally, pi
by deriving the declaration from the same predicate the resolver uses.

### 5. Budget: about 300 estimated tokens

The whole added block stays inside roughly 300 estimated tokens, using the same
characters-per-token estimate upstream uses. Current fixed overhead is about 3k
tokens, so this is a single-digit percentage addition; the upstream equivalent
costs roughly 6.8k.

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
  the first measurement is the one that motivated this ADR.

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
- docs/research/ptc-upstream-parity-audit-20260930.md: the parity audit whose
  gap A4 is closed by this record.
- docs/research/ptc-binding-contract-measurement-20260930.md: the benchmark,
  the crash taxonomy, and the before numbers.
