# The PTC row summarizes the run: one call line, one right-aligned meta line

A collapsed PTC row shipped the run's completion value through `JSON.stringify`. The escaping is
what made it unreadable: a program that returned a shell transcript put `\n` between every line,
so a two-key object rendered as five wrapped rows of quoted escape sequences — the "PTC 输出很丑"
report that opened this decision. The row is now two lines that a reader can scan, and the payload
is one `ctrl+e` away.

Status: accepted (2026-09-22). Presentation only: no protocol, dispatcher, binding or
model-facing-text changes (ADR-0012 governs the model's copy; this ADR governs the human's).

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
