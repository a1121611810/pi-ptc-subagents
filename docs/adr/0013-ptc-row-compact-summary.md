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
