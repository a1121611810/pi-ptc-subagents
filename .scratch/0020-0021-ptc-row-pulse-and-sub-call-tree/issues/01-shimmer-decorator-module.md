# 01: ShimmerDecorator module

**What to build:** the shared `withShimmer` component that wraps any pi-tui
`Component` and applies DSH's TextShimmer effect on top of it (one character
at a time bright `accent`, the rest dim; bright position advances every
150ms; settle drops the band entirely).

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `src/tools/shimmer.ts` exports `withShimmer<T extends Component>(inner,
options): T` with the documented interface (ADR-0020 §7).
- [ ] `tests/shimmer.test.ts` exists with suites passing: band position (mock
      `Date.now()`), the band surviving row recreation, settle turning it off,
      interval lifecycle (stub `setInterval` / `clearInterval`), and `dispose()`.
- [ ] Lifecycle state (`startedAt`, the interval handle) lives in the injected
      `state` bag (pi's `ToolRenderContext.state`), not on the decorated instance:
      pi rebuilds the row on every `updateDisplay()`, so instance state would reset
      per tick. The inner `Component` is returned unchanged in shape.
- [ ] Cadence defaults to 150ms; `options.intervalMs` overrides.
- [ ] Settle path clears the interval and drops `startedAt`, so the
      rendered row matches ADR-0013's settled state exactly.
- [ ] No imports outside `@earendil-works/pi-tui` and
      `@earendil-works/pi-coding-agent`.
- [ ] Type checks (`pnpm typecheck`) pass.
- [ ] Lint (`pnpm lint`) passes.
