# 05: Wire SubCallTracker into the dispatcher

**What to build:** replace the implicit "subCalls are not tracked" state with a single
`SubCallTracker` instance per run. Touches only the dispatcher's `handleCall` / `dispatchCall`
paths (ADR-0021 §1, §9). Existing tests (`tests/dispatcher.test.ts`) keep passing.

**Blocked by:** 03, 04 (needs the tracker and the `subCalls` field on `PtcRunOutcome` /
`PtcToolDetails`).

**Status:** ready-for-agent

## Status mapping

Every terminal path in `dispatchCall` must record an end state:

| Path                                              | Status      | Notes                                                           |
| ------------------------------------------------- | ----------- | --------------------------------------------------------------- |
| resolved, run not aborted                         | `ok`        | `resultSummary` from the first line of the value                |
| the binding threw                                 | `error`     | `errorMessage` from the thrown error                            |
| `bindingAbort` fired before resolution            | `cancelled` | checked in both the resolve and the catch branch                |
| resolved with `DispatchResult.status: "rejected"` | `rejected`  | depth limit / spawn failure — the binding refused, it never ran |
| `pi.dispatch` capacity gate                       | `rejected`  | the binding never started; `durationMs: 0`                      |

## Acceptance criteria

- [ ] `handleCall(frame)` calls `tracker.recordStart(callId, frame.tool, frame.args)` before
      dispatching.
- [ ] Every terminal path in `dispatchCall` calls `tracker.recordEnd(...)` per the table above.
- [ ] `finish(outcome)` adds `outcome.subCalls = tracker.snapshot()`.
- [ ] Every `recordStart` / `recordEnd` also offers `options.onSubCallChange` the current
      snapshot (as a thunk), so the tool can push a live partial result (ADR-0021 §4).
- [ ] `PtcRunOutcome` gains `subCalls?: readonly SubCallRecord[]`, omitted when empty.
- [ ] Existing dispatcher tests still pass. Multi-call coverage (the rejected / cancelled paths)
      now lives at the tracker unit level (ticket 03).
- [ ] Type checks pass; lint passes.
