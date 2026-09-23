import type { SubCallRecord, SubCallStatus } from "./protocol.ts";

export interface SubCallTracker {
  recordStart(callId: number, name: string, args: unknown): void;
  recordEnd(
    callId: number,
    status: SubCallStatus,
    summary?: { errorMessage?: string; resultSummary?: string },
  ): SubCallRecord | undefined;
  /**
   * A point-in-time copy of the records so far, in dispatch order.
   *
   * Called repeatedly: the dispatcher reads it on every start/end so the tool can push a live
   * partial result (ADR-0021 §4 — the tree is visible while the run is in flight, not only at
   * settle), and once more at settle for the terminal result. Each call copies the records,
   * not just the array: a caller that keeps one (the tool's throttled push, a test's captured
   * update) must see the state as of that call, not the state the records were later mutated
   * into. A live view re-reads on the next call, which is the snapshot it wants.
   */
  snapshot(): readonly SubCallRecord[];
}

export function createSubCallTracker(): SubCallTracker {
  const records = new Map<number, SubCallRecord>();
  return {
    recordStart(callId, name, args) {
      if (records.has(callId)) {
        throw new Error(`duplicate sub-call callId ${callId}`);
      }
      records.set(callId, {
        callId,
        name,
        args,
        status: "running",
        startMs: Date.now(),
      });
    },
    recordEnd(callId, status, summary) {
      const r = records.get(callId);
      if (r === undefined) {
        throw new Error(`recordEnd on unknown callId ${callId}`);
      }
      r.status = status;
      r.endMs = Date.now();
      r.durationMs = r.endMs - r.startMs;
      if (status === "rejected") r.durationMs = 0;
      if (summary?.errorMessage !== undefined) r.errorMessage = summary.errorMessage;
      if (summary?.resultSummary !== undefined) r.resultSummary = summary.resultSummary;
      return r;
    },
    snapshot() {
      return [...records.values()].map((record) => ({ ...record }));
    },
  };
}
