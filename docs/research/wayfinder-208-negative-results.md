# Two candidate features that did not survive measurement

Map #208 produced three candidates. One shipped; two were built, measured, and removed. This page
is the searchable record of the two, so the next person does not rebuild them.

The implementation and every experiment artefact — twelve conflict fixtures, the dead-contract
trap, three runners, and the raw JSONL results — are preserved on the **`e3-experiments`** branch.

## 1. The summary arms — dropped

**What was built.** `summary` became a caller-facing interpretation, with two interchangeable
shapes behind `PI_PTC_SUMMARY_ARM`: arm A kept it a string and changed only the prompt contract;
arm B made it `{ conclusion, implication }`.

**How it was measured.** Two stages: a child ran a conflict fixture under one arm, then a fresh
parent read the rendered report and judged whether the child had satisfied the caller's contract.
Ground truth was the probe, which the parent never saw. 120 pairs over twelve fixtures and five
model configurations.

**Result.** Balanced accuracy (sensitivity and specificity averaged), which removes the bias a
constant answer would otherwise collect:

| config         | A   | B   |
| -------------- | --- | --- |
| deepseek-flash | 56% | 44% |
| MiniMax-M3     | 8%  | 25% |
| M3.1 low       | 31% | 50% |
| M3.1 medium    | 19% | 50% |
| M3.1 high      | 24% | 44% |

Every cell is at or below chance. The structured shape did not make a parent better at judging the
child; it made it more likely to reject. B's sensitivity — correctly recognising a child that
succeeded — was 0% in four of five configurations.

**Method note.** The first run of this experiment was degenerate: the child never received a goal,
so the probe failed in every fixture, truth was constant `false`, and a parent that always answered
FAIL scored 12/12 without reading anything. The defence is to balance the truth distribution before
reading any accuracy number.

## 2. The provenance fields — dropped

**What was built.** 旧 ADR-0042 (proposed): `findings[].falsifier` (what would make the claim false),
`findings[].seen` (`verified` / `read` / `assumed`), and a top-level `assumptions[]` risk list. The
motivation was Pictelio's dead-artefact audit: 15 contracts whose evidence could not contradict
them.

**How it was measured.** A dead-contract trap: `docs/format.md` claims three decimals, the code
returns two, and the task points at the doc. The child's own classification of that claim was read
structurally from the report.

**Result.** Without enforcement the child never emitted `seen` at all. With enforcement it labelled
**every** claim `assumed`, including the ones it verified by running code. The field collapsed to a
single value and carried no information. Two of three runs initially lost the whole report to one
malformed finding; degrading instead of dropping fixed that, but not the collapse.

**The diagnosis that survived.** `seen: "read"` covers reading source code and reading a document
equally. Documentation is the one source that rots, and the enum does not say so. If this is ever
revisited, split `read` into `source` and `documented` first, and score the label distribution
before scoring anything else.

## The transferable lessons

1. **A treatment that cannot be seen is not necessarily absent.** Six pilots on non-conflict tasks
   concluded "no effect" for `goal`; the seventh, with conflict fixtures, cleared the threshold on
   every configuration. The task family, not the parameter, was the limit.
2. **A prompt request is not a contract.** Both dropped features failed first because a model
   ignored a written instruction. Enforcement (a thrown tool error) or acceptance is the choice;
   assuming compliance is not.
3. **A check that cannot fail is not a check.** The degenerate E1, the tautological flow-check, and
   Pictelio's 15 dead contracts are the same defect. If the negative case cannot occur, the number
   means nothing.
