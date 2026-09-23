# Spec — PTC row partial-state render (ADR-0020 + ADR-0021)

## Problem Statement

A user running a PTC program today sees a PTC row in the pi transcript with no
visible feedback while it is in flight. The row's right-aligned meta is absent,
the description sits statically, and binding calls that the program makes are
hidden inside the program's own `console.log`. Pressing `ctrl+e` shows the
program's labelled output (`code / phases / log / out / warn / image`) but no
per-binding state.

The user has to choose between two undesirable reads:

- Scan the column of PTC rows visually (impossible — settled and running rows
  are indistinguishable until the run settles and meta appears).
- Press `ctrl+e` on every running row and parse the `log` block by hand to find
  out which binding the program is currently calling.

DSH's PTC UX solves this differently: each binding call appears as a nested
sub-row under the parent PTC row from the moment the program makes it, with a
per-row status (running / ok / error); the parent row's description carries a
subtle shimmer while the run is in flight. Both signals live **outside** the
expanded view — they are the structural cue the user gets for free.

## Solution

Add two pieces of partial-state visibility to the PTC row:

1. **Shimmer on the parent row** (ADR-0020) — same text content as settled, one
   character at a time bright (`accent`), the rest dim. The bright character's
   position advances one step per 150ms. Settle clears the whole band off (a
   cleared `startedAt`, not a stored sentinel) so the visible difference between
   running and settled is exactly the band.
2. **Sub-call tree under the parent row** (ADR-0021) — one row per binding
   call the program made, visible both while the run is in flight (pushed
   live through pi's `onUpdate`) and at settle, and in both collapsed and
   expanded states, capped at 32 with a `+N more` tail. Each sub-row carries the
   binding name, its status text (which carries the duration once it settles),
   and an args preview; the status carries the same five states the dispatcher
   already knows (`running / ok / error / cancelled / rejected`). A run that
   _fails_ is the exception: the tool throws, and pi's error result carries no
   details, so the tree is not shown.

Both pieces share a single shared component: `ShimmerDecorator`
(`src/tools/shimmer.ts`), which only wraps the parent call row — per US16,
sub-call rows do not shimmer (see "Sub-row shimmer is OFF" under
Implementation Decisions); each sub-row's liveness signal is its five-state
status colour, not the band. The dispatcher tracks sub-call state in a
dedicated module: `SubCallTracker` (`src/runtime/sub-call-tracker.ts`);
snapshots reach `PtcToolDetails.subCalls` — live ones through the tool's
throttled `onUpdate` push while the run is in flight, and the terminal one
with the final result.

The 32-cap, the 5-state union, the visible-when-collapsed rule, the no-recursion
rule, and the cadence args (150ms; 500ms for the trailing-dots alternative) all
follow from the design decisions in ADR-0020 / ADR-0021 and are not optional.

## User Stories

1. As a PTC-mode user, I want to see at-a-glance which PTC rows are still
   running, so that I can decide whether to wait, scroll, or interrupt.
2. As a PTC-mode user, I want the partial-state row to be visually distinct
   from a settled row, so that I can scan a column of 30 PTC rows without
   reading each one.
3. As a PTC-mode user, I want to see which binding a running PTC program is
   currently calling, so that I can tell whether it has hung on a specific
   tool.
4. As a PTC-mode user, I want to see which binding calls already returned and
   what their outcomes were, so that I can spot a failed `read` or a
   timed-out `bash` without expanding the row.
5. As a PTC-mode user, I want to see a failing sub-call row in red even when
   the parent PTC row returns OK, so that I can trust the sub-row colours
   reflect the actual binding outcome, not a roll-up.
6. As a PTC-mode user, I want `pi.dispatch(...)` to show as a sub-row whose
   args preview is the dispatched agent's name, so that I can identify which
   sub-agent is being run without reading the args.
7. As a PTC-mode user, I want the sub-call tree to be visible even when the
   parent PTC row is collapsed, so that I can see binding activity without
   pressing `ctrl+e`.
8. As a PTC-mode user, I want the shimmer to be subtle (not a spinner
   competing with the text), so that I can keep reading the description while
   it pulses.
9. As a PTC-mode user, I want the shimmer to stop and the description to
   settle to its final colour the moment the run completes, so that there is
   no phantom bright character frozen mid-sweep.
10. As a PTC-mode user, I want each sub-call row's lifecycle to be independent
    of the others (one slow `bash` does not freeze the rest of the tree's
    state updates), so that I can watch progress in real time.
11. As a PTC-mode user, I want a sub-call that the `pi.dispatch` capacity gate
    rejected to show as `rejected` rather than as a generic error, so that I
    know the harness declined it, not that the child session failed.
12. As a PTC-mode user, I want a sub-call that the run was cancelled mid-flight
    to show as `cancelled` rather than as `error`, so that I know the binding
    never returned an error result — it was interrupted.
13. As a PTC-mode user, I want long PTC runs (more than 32 binding calls) to
    show the first 32 sub-rows with a `+N more` tail, so that the row never
    exceeds my terminal's height and stays readable.
14. As a PTC-mode user, I want the shimmer cadence to be slow enough (150ms)
    that I do not feel anxious, but visible enough that I do not think the
    program has hung.
15. As a PTC-mode user, I want the parent's right-aligned meta to remain absent
    while the run is in flight and to appear only at settle, so that the
    "duration" cell is honest (it is the run's duration, not a guess).
16. As a PTC-mode user, I want the shimmer to NOT extend to sub-call row
    descriptions (the args preview), so that the args preview stays readable.
17. As a PTC-mode user, I want the sub-call tree to NOT recursively expand
    into the child `pi.dispatch` PTC run's tree, so that a single sub-call
    cannot expand the visible row count by an unbounded factor.
18. As a PTC-mode user, I want the sub-call row's args preview to extract the
    one line that identifies the binding's intent (`read` → path, `bash` →
    command, etc.), so that I can see what the binding is doing without
    reading raw JSON.
19. As a PTC-mode user, I want the args preview to fall back to a JSON form
    only when the selector misses, so that hypothetical third-party bindings
    do not produce empty rows.
20. As a PTC-mode user, I want settled and running rows to differ only in
    exactly the things they should differ in (band position + sub-row
    states), so that pressing `ctrl+e` after settle still shows the same
    labelled blocks I expect today.
21. As a model that just emitted a PTC program, I want the binding call I made
    to be visible to the human user the moment I make it, so that the human
    can follow my work as it happens.
22. As a developer reading this code, I want the shimmer logic to live in a
    dedicated module (`ShimmerDecorator`) with its lifecycle state injected,
    so the band mechanism is testable without a live TUI and there is one
    implementation rather than N copies that drift.
23. As a developer reading this code, I want the sub-call lifecycle to live
    in a dedicated module (`SubCallTracker`) so that the dispatcher's
    `handleCall` / `dispatchCall` stay focused on routing, not on
    five-state mutate logic.
24. As a developer writing a test for the shimmer, I want to mock
    `Date.now()` and `setInterval` directly against the decorator, not
    indirectly through the renderer.
25. As a developer writing a test for sub-call tracking, I want to construct
    synthetic call sequences directly against the tracker, not by running
    real Worker round-trips.

## Implementation Decisions

- **Two new modules**:
  - `src/tools/shimmer.ts` — `ShimmerDecorator` exposed as `withShimmer<T extends
Component>(inner, options): T`. The interface follows pi-tui's
    `Component` contract; the wrapped component returns the inner's lines
    with the band-coloured character swapped to `accent`.
  - `src/runtime/sub-call-tracker.ts` — `SubCallTracker` class with
    `recordStart`, `recordEnd`, `snapshot()`. Internal `Map<number,
SubCallRecord>` plus order-preserving array.

- **Existing modules touched**:
  - `src/runtime/protocol.ts` — add `SubCallRecord` and `SubCallStatus` types.
    No wire-protocol change.
  - `src/tools/common.ts` — add `subCalls?: SubCallRecord[]` to
    `PtcToolDetails`. Optional; absent on older runs.
  - `src/runtime/dispatcher.ts` — replace inline sub-call array with a
    `SubCallTracker` instance. ~10 lines added: `tracker.recordStart(...)` /
    `tracker.recordEnd(...)` calls and a `snapshot()` at `finish()`.
  - `src/tools/render.ts` — wrap the call row with `withShimmer(...)` (the
    only wrapped surface; result-area renderers do not compose the
    decorator, and sub-call rows are not wrapped — they convey liveness
    via status colour per US16). Add private helpers `subRowsFor(subCalls,
theme)` and `previewArgs(name, args)`.

- **Render-time state**, not accumulated state. Band position computed in
  `render(width)` from `Date.now() - startedAt`. Deterministic under
  TUI re-renders. Multiple renders at the same wall-clock instant produce
  the same output. (ADR-0020 §4.)

- **Five-state pragma** — `running | ok | error | cancelled | rejected`,
  no other values. Status maps to existing theme slots
  (`accent` / `dim` / `error` / `warning` / `muted`) — no new colour slots.
  (ADR-0021 §6.)

- **32-cap** — `maxSubCalls = 32` constant in `common.ts`. Displayed rows are
  capped; the underlying `subCalls` array is full-fidelity. Tail row reads
  `└─ …+N more calls`. (ADR-0021 §5.)

- **No recursion** — a `pi.dispatch(...)` sub-row is a leaf; the child PTC
  run appears as its own row in the parent transcript. (ADR-0021 §7.)

- **Shimmer cadence** — 150ms per band step. Matches DSH's
  `PROCESS_TITLE_MINIMUM_MS`. (ADR-0020 §2.)

- **Sub-row shimmer is OFF (US16)** — sub-rows do not run the
  `ShimmerDecorator`. Each sub-row's liveness signal is its five-state
  status colour (running=muted / ok=accent / error=error / cancelled=muted /
  rejected=warning — ADR-0021 §6). The parent's call-row shimmer is the
  single animated partial-state signal. (ADR-0020 §6, ADR-0021 §8.)

- **Lifecycle state lives in pi's per-call bag** — `withShimmer` takes the
  `state` bag it manages and the `requestInvalidate` callback it fires on
  every tick, both injected rather than created. The bag is
  `ToolRenderContext.state`; pi rebuilds the row on every `updateDisplay()`
  (and the interval itself triggers one), so state held on the instance
  would restart `startedAt` each tick and leak the previous interval.
  Injecting both also makes the decorator testable with a plain object and
  a `vi.fn()` — no live TUI required. The decorator never reaches for the
  inner's `invalidate` (a no-op on `PtcRow`) and never touches `ui`
  directly. (ADR-0020 §3, §7.)

- **Settle contract** — the call row follows pi's own `isPartial`: while
  true, the decorator keeps `startedAt` and the interval; the first render
  with it false clears the interval and drops `startedAt`, so `render()`
  passes the lines through untouched and the row matches ADR-0013's settled
  state exactly. `withShimmer` also attaches a `dispose()` hook on the row
  for the case where a caller replaces a still-partial row; it is
  belt-and-braces, not the production settle path. (ADR-0020 §3, §5.)

## Testing Decisions

- **Test seams** (per codebase-design):
  1. `tests/shimmer.test.ts` (new) — `withShimmer` against stubbed
     `setInterval`, controllable `Date.now()`, and an injected state bag.
     Suites: band position, the band surviving row recreation, settle
     turning it off, the interval lifecycle, `dispose()`, and
     `requestInvalidate` firing on every tick.
  2. `tests/sub-call-tracker.test.ts` (new) — direct construction of
     synthetic sequences against `SubCallTracker`. Suites:
     5-call sequence (mixed `Promise.all` and sequential), rejected-at-cap
     (9 concurrent `pi.dispatch`), mid-flight cancel. Plus
     duplicate-`callId` and snapshot-isolation tests.
  3. `tests/render-ptc.test.ts` (existing) — composition tests:
     collapsed shows sub-tree, 32-cap tail, args-preview fallback,
     all-five-status sub-tree (covers `cancelled` and `rejected`),
     `renderPtcToolCall` invoking the supplied `requestInvalidate` on the
     150ms cadence, and the partial render (tree present, no `done` claim).
  4. `tests/run-code-tool.test.ts` (existing) — the production seams that
     are invisible from any single renderer: that `outcome.subCalls` reaches
     `details.subCalls`, that a binding call is pushed to `onUpdate` while
     the run is in flight, that `renderCall` threads `isPartial` and `state`,
     and that the live push coalesces and cancels.

- **What makes a good test** (per `tdd` skill) — tests verify behaviour at
  the public seam, not the internal `SubCallTracker` / `ShimmerDecorator`
  state. The tests at seams 2 and 3 construct synthetic inputs; the tests at
  seam 1 wrap a fake `Component` and assert line content; seam 4 runs a real
  worker through the real tool definition and asserts what pi would receive.

- **Existing tests adjusted** — `tests/dispatcher.test.ts` loses its
  multi-call coverage (now at the tracker unit level). Existing
  `tests/render-ptc.test.ts` keeps its collapsed / expanded /
  `renderValueTree` suites; gains the sub-tree suites, the partial-render
  suites and the `requestInvalidate` wiring test.

## Out of Scope

- Recursive sub-call tree (a `pi.dispatch` expanding into its child run's
  binding calls). Future ADR if user feedback shows the missing nested
  view as a problem.
- Spinner visualisations other than the shimmer. ADR-0020 §1 evaluates 10
  variants; only variant A (DSH TextShimmer) lands in this round.
- OSC-title indicator (Codex's pattern). pi has no process-header
  abstraction; out of scope.
- A `?` / inspect affordance that opens a Code tab showing the program source
  together with a JSON tree of the return value. pi-ptc already has
  `details.code` separately from the args envelope; an affordance is a future
  UI change.
- Per-binding result summary in the sub-row (today the resultSummary is
  recorded, but not rendered by any view yet).
- Configurable `maxSubCalls` (32 is the only constant). Future ADR if
  user feedback shows it should be a setting.

## Further Notes

- ADR-0020 §trade-off, restated, applies: the shimmer is subtle by design
  (DSH's choice). Variants D (braille spinner) and G (trailing dots)
  read as "running" faster. We picked A on the basis that DSH standing
  behind the design is enough reason to pay the visual-quiet cost.
- ADR-0021 §5 cap rationale: 32 is empirical — 3 code blocks × 5 phases +
  17 misc calls ≈ 32. A future ADR may adjust.
- ADR-0021 §7 recursion — cap also applies to children's context. A
  single sub-call cannot expand the visible row count by an unbounded
  factor.
- **US16 / sub-row shimmer — resolved.** The round-2 review caught an
  earlier-draft contradiction where the implementation ran the shimmer
  over sub-row args previews while US16 asked for the args preview to
  stay readable. The implementation now shimmers only the parent row;
  sub-rows convey liveness through status colour (ADR-0021 §6), not
  through animation. ADR-0020 §6 / ADR-0021 §8 are amended in-place to
  reflect this.
- This spec deliberately inlines no code paths. Code lives in ADRs and
  ADRs are the source of truth; the spec is the contract.

## Source documents

- ADR-0020 — PTC partial-state render: DSH TextShimmer
  (`docs/adr/0020-ptc-row-pulse.md`)
- ADR-0021 — PTC sub-call tree: always visible, dispatcher-tracked,
  capped at 32 (`docs/adr/0021-ptc-sub-call-tree.md`)
- Prototype — TUI pulse variants
  (`docs/research/prototype-pulse-tui-variants/`)
- Industry findings — terminal "running" indicators
  (`docs/research/prototype-pulse-tui-variants/industry-findings.md`)
- DSH parity target — what the page shows while a PTC program is running
  (`docs/research/dsh-ptc-page-rendering.md`)
- Existing project glossary — `CONTEXT.md` (terms added in this round:
  `partial-state render`, `settled-state render`, `shimmer`,
  `shimmer band`, `bandPos`, `ShimmerDecorator`, `sub-call tree`,
  `SubCallRecord`, `SubCallStatus`, `SubCallTracker`, `args preview`,
  `dispatch sub-row`)
