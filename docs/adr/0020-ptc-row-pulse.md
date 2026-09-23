# PTC partial-state render: DSH TextShimmer (moving highlight band)

While a PTC program is in flight, the parent row's description carries a single bright accent
character that sweeps left-to-right across an otherwise dim description. Same glyphs, same content;
only the colour band moves. Cadence 150ms; settled state has no bright character.

Status: accepted (2026-09-23). Behaviour change on the TUI only (the model sees nothing extra; ADR-0012
governs the model's copy). No protocol, dispatcher, binding or model-facing-text changes.

## Why

A "running PTC row" needs a partial-state visual that distinguishes it from settled rows in a
transcript column without competing with the description text. The two extremes are:

- **Spin / glyph** (pi-tui `Loader`, Codex, Claude Code, lazygit). Adds a moving glyph at the row's
  start. Universal "loading" affordance, but the glyph competes with the description for attention in
  a column of 30 PTC rows.
- **Text shimmer / dim cycle** (DSH `TextShimmer`). Glyphs stay put; a brighter gradient highlight
  sweeps across the description. Subtle; the user can keep scanning the column without distraction.

DSH ships the shimmer on both its parent process header (`ChatGroupSeat.tsx:117`) and its tool-row
title + summary (`ToolRow.tsx:212,222,226`), in lockstep. Documented as one of the three "subtle
single-row status" picks in `docs/research/prototype-pulse-tui-variants/industry-findings.md` along
with Codex's animated OSC title and Aider's Knight-Rider scanner. Visual selection record:
`docs/research/prototype-pulse-tui-variants/README.md` (variant A, picked by the user after running
the prototype and seeing all 10 variants side-by-side).

## What DSH does

DSH implements the highlight as a CSS keyframe with `background-clip: text`: the description text is
rendered at low alpha, and a brighter band sweeps left-to-right across it. We approximate the same
visual in plain ANSI by highlighting one character at a time while the rest are dim — see the
prototype (`comparison.html`) for an animated side-by-side comparison of the approximation against
nine alternatives (braille spinner, dots spinner, ASCII spinner, trailing dots, underline pulse,
colour shift, Knight-Rider, hybrid, etc.).

The truncation test in `prototype-pulse-tui-variants/comparison.html` confirmed the trade-off: DSH's
shimmer is **subtle** — the bright character's position is hard to read at a glance, especially in a
column. We accept that cost because the user picked the design on the basis that polished matters
more than obvious, and on the precedent of DSH itself.

## Decision

**1. Same content, different colour band.** The description's glyphs do not change between running
and settled states; only the colour assignment does. Running: the description's characters are
`theme.fg("dim", c)` except one (the "band"), which is `theme.fg("accent", c)`. At the sweep-off
step — position equal to the description's length — every character rests at `dim`, so a uniformly
`accent` description is the _only_ thing a settled row looks like. The bright band's position
advances one character at a time, wrapping back to the start after the description's length.

**2. Cadence: 150ms.** Band position advances every 150ms. This matches DSH's
`PROCESS_TITLE_MINIMUM_MS` and was empirically the right pace in the prototype: 80ms (pi-tui
`Loader` default) is fast enough to feel anxious on a long description; 500ms is slow enough that
short runs finish before the band crosses the description.

**3. Mechanism: pi-native, state in pi's per-call bag.** Borrow bash's elapsed-time pattern
(`@earendil-works/pi-coding-agent/dist/core/tools/renderers/bash.js:121–130`). Three
`ToolRenderContext` fields drive it (all from
`.../modes/interactive/components/tool-execution.js`):

- `state` (line 80, `rendererState`) — the per-call bag the lifecycle lives in. **It cannot
  live on the row**: pi rebuilds the `ToolExecutionComponent`'s children on every
  `updateDisplay()` (lines 224–248), and the shimmer's own interval triggers one through
  `requestInvalidate`. Instance state would therefore restart `startedAt` on every tick — the
  band frozen at position 0, never sweeping — and leak the previous instance's interval.
  `state` is the one bag that outlives those rebuilds.
- `isPartial` (line 84) — true while the run is in flight. The settle path is the flip to
  false: the decorator clears the interval and drops `startedAt`, and the row renders plainly.
- `invalidate` (lines 75–78, `this.invalidate() + this.ui.requestRender()`) — the re-render
  trigger the interval fires on every tick. The decorator never reaches for the inner's
  `invalidate` itself: it is a no-op on `PtcRow`, so an unconditional `inner.invalidate()`
  inside the interval reaches nothing.

The actual logic lives in the shared `ShimmerDecorator` module (§7); the row composes it.
Both lifecycle branches are idempotent (a partial render after a partial render reuses the
same `startedAt` and the same interval), so the tick that caused a render cannot spawn a
second interval.

**4. Render-time computation, no accumulated phase.** The band position is computed in `render(width)`
as `pos = floor((Date.now() - state.startedAt) / 150) % (desc.length + 1)`, mirroring bash's
`formatDuration(endTime - startedAt)`. The only lifecycle state is `startedAt` plus the interval
handle, both in the `state` bag (§3); no phase counter, no last-rendered position. Multiple renders
at the same wall-clock instant produce the same output, which is the property that makes the
animation deterministic under TUI re-renders.

**5. Settle is `isPartial`-driven.** The call row's lifecycle follows pi's own flag: while
`ToolRenderContext.isPartial` is true the decorator keeps `startedAt` and the interval; the first
render with it false clears the interval and drops `startedAt`. Cleared `startedAt` is the
"no band" state — `render()` then passes the lines through untouched, so the settled row is
byte-identical to ADR-0013's, with every character reading as `accent` and no bright character
frozen mid-sweep. `withShimmer` additionally attaches a `dispose()` that clears the interval:
the hook for a caller replacing a still-partial row, or for a framework tearing one down mid-run.
It is belt-and-braces — the `isPartial` flip is the path production actually takes.

**6. Sub-call rows do NOT shimmer (US16).** Each sub-call row reads as a colour-coded status
(`running` muted, `ok` accent, `error` error, `cancelled` muted, `rejected` warning per
ADR-0021 §6) but the band animation lives only on the parent call row. US16 in the spec
asks for the args preview to stay readable, so the parent row's pulse is the single
partial-state signal; sub-row liveness is structural, not animated. Each row's status colour
already tells the reader what it is doing without competing with the parent's band, and the
parent row's settled-state behaviour is unchanged.

## Implementation shape

**7. §7 · ShimmerDecorator — shared component.** Position: `src/tools/shimmer.ts` (new). The
shimmer logic from §3 / §4 / §5 lives in a single module with this interface:

```ts
function withShimmer<T extends Component>(
  inner: T,
  options: {
    state: ShimmerState; // pi's ToolRenderContext.state — outlives row recreation
    isPartial: boolean;
    theme: Theme;
    requestInvalidate: () => void;
    intervalMs?: number;
  },
): T; // same T, plus a `dispose()` hook that clears the interval
```

The returned component satisfies pi-tui's `Component` contract: `render(width)` returns the inner
component's lines with the band-coloured character swapped to `accent` (off-band → `dim`; at the
sweep-off step every character is off-band), and the
supplied `requestInvalidate` callback is the re-render trigger the interval calls on every tick.
`ShimmerState` is `{ startedAt?, interval? }`; it is passed **in**, not owned, so it survives the
row recreation pi performs — see §3 for why instance state cannot work.

The dependency is injected rather than created: `state` and `requestInvalidate` both arrive as
options, so a test drives the decorator with a plain object and a `vi.fn()` and never needs a live
TUI. `PtcRow.invalidate()` is a no-op (no cache to drop), which is the other half of why the
decorator takes the trigger rather than reaching for the inner's: the caller —
`renderPtcToolCall` via `run-code.ts` / `workflow.ts` — threads `ToolRenderContext.invalidate`
(which internally calls `this.invalidate() + this.ui.requestRender()`) through. Tests that do not
care about the band advancing can omit it; the default is a no-op (the interval still ticks, no
repaint happens).

The module is a **deep module** by codebase-design's deletion test: deleting it forces the
shimmered text surface (the parent call row is the single animated partial-state signal, §6)
to inline the band logic, and the state machinery (the interval, `startedAt`, and the
dispose-clears-interval lifecycle) is exactly the kind of thing that gets out of sync across
call sites. Two adapters justify the seam: the production instance and the test's mock
(stubbed `setInterval`, controllable `Date.now()`).

**8. §8 · PtcRow is the orchestrator, not the owner.** Position: `src/tools/render.ts`. The
collapsed and expanded renderers read `subCalls` (via `subRowsFor`) but never wrap a sub-row
with `withShimmer(...)` — per §6, sub-rows do not shimmer. Only `renderPtcToolCall` wraps the
parent call row. They do not own an interval, do not read `Date.now()` for band purposes, and
do not track `startedAt`. Their own state (per ADR-0013) stays as it was: right-aligned meta
padding, tree connector selection, value-tree depth caps. The shimmer's lifecycle is invisible
to them.

**9. §9 · Tests.** Position: `tests/shimmer.test.ts` (new). Suites, mirroring ADR-0020's
"Tests pin the contract" section:

- **band position**: mock `Date.now()`, render N times at controlled offsets; assert that the
  description's character at `floor(elapsed / intervalMs) % (desc.length + 1)` is wrapped in
  `t-accent` and the rest are `t-dim`.
- **band survives row recreation**: two separate inner components sharing one `state` bag; the
  second render must continue the sweep rather than restart it. This is the regression pin for
  §3's "state cannot live on the instance".
- **settle turns the band off**: feed `isPartial: false` with the same bag; assert no character is
  `t-accent`-wrapped and the description is uniformly `t-accent` (matches ADR-0013 settled), and
  that `state.startedAt` is cleared.
- **interval lifecycle**: stub `setInterval`/`clearInterval`; assert that the first `isPartial`
  render schedules an interval, the first `!isPartial` render clears it. This is the suite that
  catches "interval leaked" regressions — currently impossible to catch in `render-ptc.test.ts`
  because the interval would be hidden inside the orchestrator.

`tests/render-ptc.test.ts` keeps its existing collapsed / expanded / `renderValueTree` suites
(per ADR-0013); they no longer need to mock `Date.now()` or intervals because the orchestrator
delegates them.

## Divergences from DSH, stated plainly

- **Per-character ANSI approximation, not CSS gradient.** DSH uses `background-clip: text` with a
  CSS keyframe. pi-tui's `theme.fg` is the colour interface; there is no `background-clip`. We
  approximate the effect by highlighting one character at a time. The DSH gradient is smoother (a
  band of width N characters, not a single char), but the prototype confirms that a single-char
  highlight is visually sufficient at 150ms cadence. The cost is exactly one extra `theme.fg`
  call per character in the description per render, and the gain is "still matches the DSH
  spirit". If pi-tui ever adds a gradient primitive, the implementation switches with no behaviour
  change.
- **Sub-call rows do not shimmer at all.** DSH shows each tool row with its own band; we show a
  single band on the parent PTC row and let sub-rows convey liveness through status colour
  (ADR-0021 §6). US16 in the spec is the constraint: the args preview must stay readable. This is
  also why the spec language from §6 of this ADR's earlier draft ("sub-call rows shimmer too") was
  reversed in the round-2 review.
- **Caller-supplied `requestInvalidate`, not a hard-coded `context.invalidate()`.** The decorator
  does not assume it lives inside a `ToolRenderContext` — it accepts a `() => void` callback and
  the caller wires it up. This is what makes the band actually move in production (F9 round-2
  review): `PtcRow.invalidate()` is a no-op, so an unconditional `inner.invalidate()` inside the
  interval reaches nothing; the callback the caller threads through is the production re-render
  trigger.

## Consequences

- **Running and settled rows differ by the description's whole colour assignment, not by any
  glyph.** Settled is uniformly `accent`; in flight it is `dim` with one `accent` character — so
  every non-band character differs, and at the sweep-off step all of them do. The glyphs, spacing
  and width are identical, which is what makes the signal quiet: the eye has to notice colour
  rather than motion or changed text. That is the cost. We accept it.
- **The interval and `startedAt` live in pi's `ToolRenderContext.state`, owned by the
  `ShimmerDecorator` (§7).** Not on the row (pi rebuilds it per render — §3) and not on the
  orchestrator. Only the parent call row is wrapped; sub-rows are not (per §6). The single
  interval is cleared when pi flips `isPartial` to false, and `dispose()` — attached by the
  decorator — is the explicit hook for a row replaced or torn down while still partial. The leak
  window is bounded by the lifetime of one tool call, exactly as bash's elapsed-time intervals
  are today.
- **The TUI re-renders at ≥6.6Hz for the duration of the run.** That is one extra `requestRender`
  per 150ms while `isPartial: true`. bash already does the same at 1Hz for elapsed time; this is
  a higher-frequency pattern, but the work per call is O(description.length) which is bounded by
  ADR-0013 §3's `maxLineChars` (120). Worst case: 120 theme.fg calls per 150ms — negligible.
- **Tests pin the contract.** Per §9, `tests/shimmer.test.ts` covers band position, the band
  surviving row recreation, settle turning it off, the interval lifecycle, `dispose()`, and
  `requestInvalidate` firing per tick. `tests/render-ptc.test.ts` keeps its collapsed / expanded /
  `renderValueTree` / sub-call-tree suites (per ADR-0013, ADR-0021) and adds the partial-render
  cases: the band advancing, settle, the band surviving the row recreation pi performs, one
  interval across repeated partial renders, and a partial render claiming no completion value.
  `tests/run-code-tool.test.ts` pins the production wiring end-to-end — that `renderCall` threads
  `isPartial` and `state` through — since that seam is invisible from the renderer alone.

## Trade-off, restated

The prototype (`docs/research/prototype-pulse-tui-variants/comparison.html`) shows all 10 variants
side-by-side at the same scale. Variants D (braille spinner) and G (trailing dots) read as "running"
faster than variant A; variants H, I (underline pulse, colour shift) are even more subtle than A.
The user picked A on the basis that DSH standing behind the design is enough reason to pay the
visual-quiet cost. A future ADR can revisit this if user feedback says otherwise.
