import { describe, expect, it, vi } from "vitest";
import { createSubCallTracker } from "../src/runtime/sub-call-tracker.ts";

describe("SubCallTracker", () => {
  it("5-call sequence (mixed sequential and concurrent): records in dispatch order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const t = createSubCallTracker();

    t.recordStart(1, "read", { path: "/a" });
    vi.advanceTimersByTime(5);
    t.recordStart(2, "bash", { command: "ls" });
    vi.advanceTimersByTime(5);
    t.recordEnd(2, "ok", { resultSummary: "ok" });
    t.recordStart(3, "grep", { pattern: "x" });
    vi.advanceTimersByTime(5);
    t.recordEnd(3, "error", { errorMessage: "no match" });
    t.recordEnd(1, "ok");
    vi.advanceTimersByTime(5);
    t.recordStart(4, "read", { path: "/b" });
    t.recordEnd(4, "ok");
    t.recordStart(5, "bash", { command: "wc -l" });
    t.recordEnd(5, "ok");

    const frozen = t.snapshot();
    expect(frozen).toHaveLength(5);
    expect(frozen.map((r) => r.callId)).toEqual([1, 2, 3, 4, 5]);
    expect(frozen[0]?.status).toBe("ok");
    expect(frozen[1]?.status).toBe("ok");
    expect(frozen[2]?.status).toBe("error");
    expect(frozen[2]?.errorMessage).toBe("no match");
    expect(frozen[2]?.durationMs).toBe(5);
    expect(frozen[4]?.durationMs).toBe(0);
    vi.useRealTimers();
  });

  it("rejected at capacity: 9th record has status='rejected', durationMs=0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const t = createSubCallTracker();
    for (let i = 0; i < 8; i++) {
      t.recordStart(i + 1, "pi.dispatch", { agentName: "a" });
    }
    // handleCall always records start before the dispatcher's capacity-gate rejection,
    // so recordStart(9) lands before recordEnd(9, "rejected").
    t.recordStart(9, "pi.dispatch", { agentName: "i" });
    t.recordEnd(9, "rejected", { errorMessage: "dispatch concurrency limit reached" });

    const frozen = t.snapshot();
    expect(frozen).toHaveLength(9);
    expect(frozen[8]?.callId).toBe(9);
    expect(frozen[8]?.status).toBe("rejected");
    expect(frozen[8]?.durationMs).toBe(0);
    vi.useRealTimers();
  });

  it("mid-flight cancel: in-flight record finalises to 'cancelled', not 'error'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const t = createSubCallTracker();
    t.recordStart(1, "bash", { command: "sleep 100" });
    vi.advanceTimersByTime(50);
    t.recordEnd(1, "cancelled");
    const frozen = t.snapshot();
    expect(frozen[0]?.status).toBe("cancelled");
    expect(frozen[0]?.durationMs).toBe(50);
    vi.useRealTimers();
  });

  it("duplicate callId on recordStart throws", () => {
    const t = createSubCallTracker();
    t.recordStart(1, "read", { path: "/a" });
    expect(() => t.recordStart(1, "read", { path: "/b" })).toThrow(/duplicate/i);
  });

  it("recordEnd on an unknown callId throws (including the 'rejected' status)", () => {
    const t = createSubCallTracker();
    expect(() => t.recordEnd(99, "rejected", { errorMessage: "x" })).toThrow(/unknown callId/i);
  });

  it("snapshot() is a point-in-time copy: a later recordEnd does not rewrite it", () => {
    // The dispatcher snapshots on every start/end to feed the throttled live push. A push that
    // has already been sent must keep showing what it showed — if the snapshot shared the live
    // record, a captured `running` push would silently become `ok` once the binding resolved.
    const t = createSubCallTracker();
    t.recordStart(1, "bash", { command: "sleep 5" });
    const live = t.snapshot();

    t.recordEnd(1, "ok", { resultSummary: "done" });
    expect(live[0]?.status).toBe("running");
    expect(live[0]?.endMs).toBeUndefined();

    const settled = t.snapshot();
    expect(settled[0]?.status).toBe("ok");
    expect(live[0]).not.toBe(settled[0]);
  });
});
