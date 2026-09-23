# 06: Compose `withShimmer` in PtcRow (parent-row shimmer)

**What to build:** make the PTC call row shimmer while the run is in flight. `withShimmer` owns
the lifecycle; the row does not (ADR-0020 §3, §7, §8).

**Blocked by:** 01 (needs the `ShimmerDecorator` module).

**Status:** ready-for-agent

## Where the shimmer goes (settled during implementation)

It belongs on the **call row** (`renderPtcToolCall`), not the result area: the anchor the
decorator matches is the call row's `PTC` label plus description, and the result area carries no
such segment. The result-area renderers therefore stay plain.

## Acceptance criteria

- [ ] `renderPtcToolCall` composes `withShimmer(...)`, passing three things it reads off pi's
      `ToolRenderContext`: `requestInvalidate` (`context.invalidate`), `isPartial`
      (`context.isPartial`) and `state` (`context.state`).
- [ ] The shimmer's lifecycle state lives in the injected `state` bag, not on the row: pi rebuilds
      the row on every `updateDisplay()`, so instance state would restart `startedAt` per tick.
- [ ] While `isPartial` is true the band advances at 150ms; when it flips false the interval
      clears, `startedAt` is dropped, and the row renders as ADR-0013's settled row.
- [ ] Existing collapsed / expanded / `renderValueTree` suites keep passing.
- [ ] A test pins the production wiring end-to-end: that `renderCall` really threads `isPartial`
      and `state` through (the seam is invisible from the renderer alone). The decorator's own
      behaviour is covered by ticket 01.
- [ ] Type checks pass; lint passes.
