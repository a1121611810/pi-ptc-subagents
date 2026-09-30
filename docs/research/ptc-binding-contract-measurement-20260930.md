# Binding contract measurement (2026-09-30)

The field report that produced [ADR-0024](../adr/0024-binding-contract-declares-binding-result.md).
Research note: the harness lives outside this repository (it drives a real pi
process and reads a real credential file), so this note records the method and
the numbers rather than the code.

## Why a TUI harness

PTC mode is TUI-only by construction. The entry decision returns early unless the
session mode is the TUI, and the binding source falls back to the live loadout
when the mode is off, so a headless run cannot exercise the narrowed surface at
all: with only the PTC tools on the loadout, a program calling `tools.read`
reports that no such binding is bound and lists `pi.dispatch` as the only one
available. A headless comparison therefore measures "PTC available but optional",
which is the configuration where the model is least likely to reach for it.

The harness drives the real TUI through a pseudo-terminal, sends the mode
command, submits the task, and reads usage, tool calls and the final answer back
out of the session file.

## Arms

| arm      | tool surface                                              | PTC used   |
| -------- | --------------------------------------------------------- | ---------- |
| control  | pi built-ins only                                         | n/a        |
| narrowed | mode on; the PTC tools are the only model-visible surface | yes        |
| optional | built-ins plus the PTC tools, not narrowed                | not always |

## Method

- Corpus: a fixed read-only snapshot of this repository (153 files, ~47.9k lines).
- Tasks: eight read-only aggregation questions over that corpus, each with a
  ground truth computed independently by file reads rather than by a language
  model. Every task was checked against a counterfactual first: a perfect answer
  must score full marks and a deliberately wrong one must score zero.
- One model, one reasoning level, identical across arms; two repetitions per cell.
- Metric: the sum over turns of input plus cache-read tokens, plus tool-call
  count, plus answer correctness.

Two task definitions were found ambiguous on the first pass and were rewritten
and re-run before any conclusion was drawn: one counted occurrences where every
arm used the line-count convention that `grep -c` reports, and one did not say
whether an `async` export counted. Both were harness defects, not model errors,
and both were fixed rather than scored around.

## Result (narrowed arm, 16 runs)

| arm      | exact | mean F1 | ctx median | ctx max | wall median |
| -------- | ----- | ------- | ---------- | ------- | ----------- |
| control  | 94%   | 0.994   | 7,490      | 157,434 | 18s         |
| narrowed | 62%   | 0.886   | 36,670     | 207,944 | 35s         |

The narrowed arm's 16 runs produced 31 program crashes, median turns rose from 3
to 8.5, and the cost of the run rose by roughly 2x.

## Crash taxonomy

| count     | error                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| 5         | `files is not iterable`                                                            |
| 2         | `content.split is not a function`                                                  |
| 2         | `content.slice is not a function`                                                  |
| 2         | other array-method calls on a non-array (`allFiles`, `adrFiles`, `result.matches`) |
| remainder | argument-shape and path errors                                                     |

Every one of these is the same mistake: treating a binding result as a string or
as an object with a `files` field. The runtime returns a two-field object whose
`content` is an array of content blocks.

## Correlation, stated as correlation

| narrowed-arm group | n   | turns | ctx    | F1    |
| ------------------ | --- | ----- | ------ | ----- |
| hit a shape error  | 13  | 8.6   | 49,598 | 0.900 |
| did not            | 3   | 5.3   | 22,389 | 1.000 |

This is **not** causal. A run that struggled wrote a more ambitious program and
had more opportunities to guess wrong. The claim the evidence does support is
narrower and is the one the decision rests on: the errors have one shared
mechanism, and the mechanism is a shape the description never stated.

## A correction worth recording

An earlier headless comparison in this investigation labelled one arm as
`codemode.mode=only` and reported it as a narrowed arm. It was not. Reading the
tools actually declared to the model showed all eight tools declared under both
the `only` and `on` modes, and the model's own behaviour confirmed it: it
called the built-ins directly and got correct answers. Two columns of that
earlier comparison were therefore the same configuration sampled twice. The
lesson generalises: an arm's name is a claim about the harness, and only the
model-visible tool list settles it.
