# The PTC row summarizes the run: one call line, one right-aligned meta line

A collapsed PTC row shipped the run's completion value through `JSON.stringify`. The escaping is
what made it unreadable: a program that returned a shell transcript put `\n` between every line,
so a two-key object rendered as five wrapped rows of quoted escape sequences — the "PTC 输出很丑"
report that opened this decision. The row is now two lines that a reader can scan, and the payload
is one `ctrl+e` away.

Status: accepted (2026-09-22). Presentation only: no protocol, dispatcher, binding or
model-facing-text changes (ADR-0012 governs the model's copy; this ADR governs the human's).

Amended by §5 (2026-09-22): a container completion value expands as a tree rather than
degrading to a bare key list. The one-line invariant of §1 holds for scalars, not for containers.

Amended by §6 (2026-09-29): the eight per-block caps of the expanded view are registered
with their values. §3 decided the discipline (bounded, labelled, reports what it withheld) and
named no number; §6 supplies the numbers and nothing else — no Decision above is changed, and the
three value-tree caps in §5 keep their own source and their own table.

Amended by §6 (2026-09-29, second pass): §6 now states the two bounds of the expanded failure-text
block — line count and viewport width, not a `MAX_*` line cap — and records that
`MAX_ERROR_CHARS` applies to the collapsed `failed: …` row alone. Completeness only: no Decision
above is changed and no value in §6's table is revised.

## Decision

**1. The collapsed row is a heading plus a summary, never a payload.**

```
PTC  Verify inserted temp image file integrity
  → {file, clipNow}                    • 6 output lines · 536ms
```

`renderCall` is the label and the model's description only. It used to append the first meaningful
code line as well, which turned the heading into a paragraph; the code now appears in the expanded
view alone.

`renderResult` collapsed is one line: the completion value as a hint on the left (`→ …`, or
`done` when the program returned nothing, or `failed: <reason>` in the error colour), and the
run's countable facts pinned to the right edge — output lines, workflow phases, warnings, duration.
The hint goes through the same inline logic as ADR-0012 and degrades to a _shape_ (`{file, clipNow}`,
`Array(3)`, `line one (+2 lines)`) instead of ever escaping a payload.

**2. The meta is right-aligned, so it needs a custom component.** `@earendil-works/pi-tui`'s `Text`
never sees the viewport width, so it cannot align anything. `render.ts` returns a `PtcRow`: a
stateless `Component` that pads each line to the width pi hands it. When the line does not fit, the
left side gives up room first — a count truncated to `• 19 outpu…` tells the reader nothing, while a
shortened value hint still reads.

**3. The expanded view stays bounded and labelled.** Each block opens with a label in a fixed gutter
(`code`, `phases`, `log`, `out`, `warn`, `value`) and reports what it withheld (`8…`), so
"expanded" never means "unbounded". A failed run shows its error text there in full, in the error
colour, because that is the reason the reader expanded the row at all.

**4. `renderShell` stays at pi's default box.** PTC rows are boxed like every other tool row, so a
mixed transcript keeps one visual rhythm; going borderless for two tools only would make them look
like a different harness's output. (The reference transcript that motivated this change is
borderless precisely because _all_ of its rows are.)

## Consequences

- **Summarising is lossy by construction.** The collapsed row answers "what happened and how much",
  not "what came back"; the answer to the second question is `ctrl+e`, and it is lossless there.
- The right-aligned meta makes row width meaningful: a reader scanning a column of PTC rows reads
  output volume and duration straight down the right edge.
- `renderPtcToolResultCollapsed` now takes the whole tool result rather than just `details`, so a
  failed run can name its error on the collapsed row (`failed: code run failed (exception): boom`).
- Tests pin the new contract in `tests/render-ptc.test.ts`: one line when collapsed, meta pinned to
  the viewport width, and no `\n`-escaped payload anywhere. `scripts/verify-dist-render.mjs` renders
  both surfaces out of the built `dist` and prints them, so the layout can be reviewed without a TUI.

## 5. A container completion value expands as a tree

§1's shape fallback (`{file, clipNow}`, `Array(3)`) is honest but useless at scale. A run whose value
carried `{totalLines: 47, instantiations: [...], file: "x.ts"}` rendered as `→ {totalLines, instantiations,
file}` — every key present, every fact gone, so a reader scanning a column of PTC rows could see _that_
something came back and nothing about _what_. The row is the only thing a reader sees without pressing
`ctrl+e`; a summary that cannot be understood at a glance is not a summary.

**1. A non-empty object or array renders as a tree, not a one-liner.** Each property (or index) gets its
own row, with the same `├─` / `└─` / `│` connectors the rest of the row already uses, so the value reads
as part of the transcript tree rather than a payload dropped underneath it:

```
└─ PTC  Find AssistantMessageComponent instantiations
   ├─ file: "chat-viewport.ts"                    • 1 output line · 1.42s
   ├─ instantiations: Array(3)
   │  ├─ [0] {file: "chat-viewport.ts", line: 23}
   │  ├─ [1] {file: "chat-viewport.ts", line: 47}
   │  └─ [2] {file: "chat-viewport.ts", line: 91}
   └─ totalLines: 47
```

Scalars, empty containers, `null`, "no completion value" and failures keep §1's single line (`→ 47`,
`→ {}`, `done`, `failed: …`). The `→ ` marker therefore means "one-line hint"; a tree needs no marker,
because its first row already starts where every other child of the call row starts.

**2. Every level is bounded, and says what it withheld.** `maxDepth` (4) collapses deeper nesting to a
`…` row; `maxChildren` (6) caps keys and indices, with a `└─ …+N more keys` / `…+N more items` tail;
`maxLineChars` (120) truncates any single row on a visible-width boundary, so the tree prefix survives and
a CJK value does not overflow the column it was measured against. "Expanded" still never means
"unbounded" — the same rule §3 set for the labelled blocks.

**3. Small all-scalar containers collapse onto one row.** An object or array whose children are all
scalars, at most five of them, and which fits its budget renders inline (`[0] {file: "a", line: 12}`).
Without this, an array of records would spend three rows per record saying nothing a single row cannot.

**4. The value tree and the labelled blocks are one connector chain.** In the expanded view the tree is
followed by `code` / `phases` / `log` / `out` / `warn` / `image`. `renderValueTree` takes
`moreAfter`, which keeps its final row on `├─` while blocks follow and switches to `└─` when nothing
does; the caller passes `children.length > 0`. Two adjacent chains (`└─ node` immediately followed by
`├─ code`) read as a rendering bug even when each is individually correct.

**5. The `value` child block is gone.** It existed to carry `renderModelValue`'s block form, which the
tree now supersedes: for a scalar the result area already shows the hint, and for a container it shows
the whole tree. Two representations of one value, one of them lossy, was the redundancy §1 was meant to
remove rather than relocate.

## Consequences

- **§1's "the collapsed row is one line" holds for scalars only.** A container row is now one call line
  plus one row per property, bounded by `maxDepth` × `maxChildren`. The collapse/expand distinction is
  unchanged in kind: the area shows the `details.result` tree, and `ctrl+e` adds `code` / `out` / etc.
- **`JSON.stringify` remains banned.** The tree renders through `renderValueTree`, which quotes a string
  value rather than escaping a payload, and folds a multi-line string onto one capped row. ADR-0012's
  rule and its test (no `\n` escape anywhere in a rendered row) still hold.
- **Model-facing text is untouched.** The tree is presentation; `renderModelValue` still assembles what
  the model reads (ADR-0012), and `details` is still raw.
- Tests: `tests/render-ptc.test.ts` gains a `renderValueTree` suite (per-property rows, `[i]` indices,
  nesting, `maxDepth`, `maxChildren` tails, visible-width truncation, inline collapse, `moreAfter`) and
  the collapsed/expanded suites now assert the tree instead of the old `→ {keys}` hint and `value` block.
  `scripts/verify-dist-render.mjs` prints both shapes out of the built `dist`.

## 6. The eight block caps, and where their numbers come from

§3 decided the discipline and deliberately named no number: every block of the expanded view is
bounded, opens with a label in a fixed gutter, and reports what it withheld. At the time the caps
were whatever the renderer had grown into. §5 §2 did name its numbers — `maxDepth` 4,
`maxChildren` 6, `maxLineChars` 120, for the value tree. The eight caps below never got the same
treatment: they live in `src/tools/render.ts:83-90`, they have governed the row since they were
written, and until this section no document in the repository recorded any of them — not this ADR,
not the README (whose "each block labelled and capped" carries no number), not any other file under
`docs/`. The audit that found the gap (`docs/reviews/2026-09-29-ocr-rule-coverage-audit-2.md`)
asked for one of two closers: a table of values, or an explicit statement that the values have no
independent source. This section is the first.

| constant                    | value | what it bounds                                                                  | block                                       |
| --------------------------- | ----- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| `MAX_RESULT_HINT_CHARS`     | 60    | the `→ …` completion-value hint on the summary row, and the inline-vs-shape cut | none — the summary row itself               |
| `MAX_ERROR_CHARS`           | 120   | the failure text's first line on the collapsed `failed: …` row                  | none — the failure row                      |
| `MAX_CODE_LINE_CHARS`       | 120   | one line of code, and the call row's no-description fallback                    | `code`                                      |
| `MAX_CODE_LINES_EXPANDED`   | 3     | how many code lines the block shows                                             | `code`                                      |
| `MAX_LOG_LINES_EXPANDED`    | 12    | how many lines a block shows                                                    | `log`, `out`, and the expanded failure text |
| `MAX_PHASES_EXPANDED`       | 8     | how many phases the roll-up row carries                                         | `phases`                                    |
| `MAX_WARNINGS_EXPANDED`     | 4     | how many plan-drift warnings are shown                                          | `warn`                                      |
| `MAX_SUBCALL_PREVIEW_CHARS` | 40    | one argument preview in a sub-call row                                          | none — the sub-call tree (ADR-0021)         |

**These eight numbers were chosen for TUI readability; they have no independent source.** They
were not derived from any specification, from third-party documentation, or from pi's defaults:
before this section, `src/tools/render.ts` was the only place any of these eight had been written
down, and no document in the repository recorded these eight. This section registers them as
frozen contract values — changing any one of them is a behaviour change and needs a new ADR, not a
number to edit in the implementation.

The claim is scoped to the eight constants in this table, not to the repository's render bounds as a
whole. Other render caps are registered elsewhere: the model-facing text block's `MAX_LINE_CHARS`
(200) and `INLINE_MAX_CHARS` (100) were already written down in this same ADR's sibling, ADR-0012,
and the background task panel's five caps are registered by ADR-0022. A reader auditing a bound must
check the table it belongs to — "no document recorded it" here means "no document recorded _these
eight_", never "this repository has no other unrecorded caps".

**The failure block is the one bound that is not a `MAX_*`.** `MAX_ERROR_CHARS` (120) is not
that bound. It reaches exactly one line: the collapsed `failed: …` row,
through `firstLine()` (`render.ts:146`) ← `errorText()` (`render.ts:902`) ← `render.ts:1047` — and,
expanded, only as the fallback source for a result that carries no text block at all
(`render.ts:1141`). Expanded, the failure block is bounded twice, and neither bound is a width
constant: the line count is cut at `MAX_LOG_LINES_EXPANDED` (12, `render.ts:1143`), and every line
that survives is cut to the viewport by `alignRow` (`render.ts:130`).

The absent per-line cap is intentional: the renderer says the failure text is "the reason the
reader expanded the row at all" and gives it the full width under the summary instead of a cap of
its own (`render.ts:1138-1139`). §3's "expanded is never unbounded" therefore holds for this block
as **lines + viewport**, not as a `MAX_*` constant — it is bounded, just not by the kind of bound
the other seven rows in the table carry, and a reader auditing that table should not go looking for
a width constant here. Writing the deviation down is the point: every other block's bound is a
nameable constant, and this one is not.

**What this section does and does not bind.** §3 remains the rule; §6 only attaches numbers to it,
and a number is not a licence to drop the "says what it withheld" half of §3 — every row above is
paired with a tail (`…+N more lines`, a trailing `…`) in the renderer, and that pairing is what
§3 bought. §3's block labels changed under §5 (the `value` block is gone, `image` arrived), so
the `block` column above names today's blocks, not §3's original list.

**These eight are not §5's three.** `TREE_VALUE_MAX_DEPTH` / `TREE_VALUE_MAX_CHILDREN` /
`TREE_VALUE_MAX_LINE_CHARS` bound the completion-value tree and are sourced by the README; the
eight above bound the labelled blocks, the summary row, the failure row and the sub-call tree, and
are sourced only here. The number 120 appears on both sides — `MAX_CODE_LINE_CHARS` and
`TREE_VALUE_MAX_LINE_CHARS` are two different constants that happen to agree — which is precisely
why they are two tables and not one. Likewise `MAX_ERROR_CHARS` here is `render.ts`'s, and the
same-named constant in `src/tools/task-panel-render.ts` is a third, separate one. None of these
numbers move together; changing any of them needs its own decision.

## Consequences

- **The values are now pinned to a document, not just to the code.** A silent edit in
  `src/tools/render.ts` is caught by `tests/render-bounds-registry.test.ts`, which re-reads the
  registry table in `.opencodereview/rules/ptc-render-bounds.md`; that table's source column now
  points here, so the chain implementation → registry → ADR is closed instead of dangling.
- **The tests that exercise these caps are not their source.** `tests/render-ptc.test.ts` pins
  the behaviour (a 20-line `out` block shows 12 lines and reports `…+8 more lines`; the sub-call
  preview caps at 40 characters), which is regression protection — it would catch a change, but it
  cannot tell you why 12 and not 10. Characterisation is not provenance.
- **A change to any of the eight is a new ADR, not a tuning commit.** There is no upstream
  default to re-derive them from, so "restore the pi default" is not available as an argument.
