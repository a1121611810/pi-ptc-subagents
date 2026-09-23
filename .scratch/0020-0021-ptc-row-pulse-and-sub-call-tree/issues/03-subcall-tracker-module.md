# 03: SubCallTracker module

**What to build:** the host-side state module that owns the `SubCallRecord`
lifecycle. Used by the dispatcher (ADR-0021 §9). Independent of `PtcRow` and
the dispatcher; pure data structure.

**Blocked by:** 02 (needs `SubCallRecord` and `SubCallStatus` types).

**Status:** ready-for-agent

- [ ] `src/runtime/sub-call-tracker.ts` exports `SubCallTracker` class with
      three methods: `recordStart(callId, name, args)`, `recordEnd(callId,
status, summary?)`, `snapshot(): readonly SubCallRecord[]`.
- [ ] Internal `Map<number, SubCallRecord>` for lookup by `callId` plus an
      order-preserving array (`snapshot()` returns records in insertion order).
- [ ] `recordEnd` mutates the matching record in place and returns it;
      mutating a non-existent `callId` throws.
- [ ] `recordStart` on a duplicate `callId` throws (defense in depth).
- [ ] `snapshot()` copies the records, so a captured snapshot is not changed by a
      later `recordEnd` on the same `callId`.
- [ ] `tests/sub-call-tracker.test.ts` exists with three suites passing:
      5-call sequence (mixed `Promise.all` and sequential), rejected-at-cap
      (saturate `dispatchConcurrency` with 9 concurrent `pi.dispatch`
      calls; 9th record is `status: "rejected"`, `durationMs: 0`),
      mid-flight cancel (in-flight record finalises to `cancelled`, not
      `error`). Plus a duplicate-`callId` throw test.
- [ ] No imports outside `node:...` built-ins.
- [ ] Type checks pass; lint passes.
