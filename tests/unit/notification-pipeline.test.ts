/**
 * Tests for NotificationPipeline (BG-05 ticket): subscribe / drainPending /
 * acknowledgeEvents / onIdleWake / pendingCount, the dispatcher-facing notifyIdle wake
 * trigger, and the pure splitBatch helper.
 *
 * SPECIFICATION tests, not characterization (docs/testing-constraints.md #4 + #6).
 * Every expected value is pinned to an independent source:
 *   - ADR-0022 section 5: Subscription cursor is monotonic and per-subscriber; a
 *     re-subscribe must not reset delivery state; the fork cursor is max(parent, child).
 *   - ADR-0022 section 6: cursor-based delivery; the buffer drains in one idle wake;
 *     cursor replay survives restart, so an unacknowledged drain re-delivers.
 *   - ADR-0022 section 7: a single batch carries N events; split along event boundaries
 *     into N batches; never drop an event.
 *   - the BG-05 ticket text: ZERO_CURSOR sentinel; idempotent subscribe /
 *     acknowledgeEvents; an unknown subscription is an explicit error.
 *
 * Failure paths (testing-constraints #1): every persistence-touching method rejects for
 * an unknown subscription rather than silently draining zero events (#3, no silent
 * failure). The idempotence tests double as the #5 counterfactual: an implementation that
 * reset the cursor on re-subscribe, or moved it backwards on an old ack, would go red.
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_MAX_BATCH_BYTES,
  DefaultNotificationPipeline,
  ZERO_CURSOR,
  estimateEventBytes,
  splitBatch,
} from "../../src/runtime/notification-pipeline.ts";
import {
  InMemoryTaskStorage,
  type Subscription,
  type TaskEvent,
  type ULID,
} from "../../src/runtime/task-storage.ts";

// --- Fixtures (identifiers are literal strings; no value is derived from the impl) ---------

const SUBSCRIBER: ULID = "01JBZ00000000000000000010S" as ULID;
const TASK_A: ULID = "01JBZ00000000000000000000A" as ULID;
const TASK_B: ULID = "01JBZ00000000000000000000B" as ULID;
const E1: ULID = "01JBZ00000000000000000001E" as ULID;
const E2: ULID = "01JBZ00000000000000000002E" as ULID;
const E3: ULID = "01JBZ00000000000000000003E" as ULID;
const UNKNOWN_SUBSCRIBER: ULID = "01JBZ000000000000000NOSUB1" as ULID;
/** Fixed ms epoch injected as the clock seam; ADR-0022 section 5 createdAt is ms epoch. */
const FIXED_NOW = 1_700_000_000_500;

/**
 * One TaskEvent per the ADR-0022 section 5/7 schema. The storage layer treats type as an
 * opaque string (task-storage.ts), so this fixture keeps a single literal type and varies
 * only the fields the pipeline actually reads (eventId, taskId).
 */
function event(eventId: ULID, taskId: ULID, overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    eventId,
    subscriptionId: SUBSCRIBER,
    taskId,
    type: "task:running",
    status: "running",
    transitionAtMs: 1_700_000_001_000,
    outputBytes: undefined,
    outputPreview: undefined,
    ...overrides,
  };
}

function makePipeline(storage: InMemoryTaskStorage): DefaultNotificationPipeline {
  return new DefaultNotificationPipeline(storage, { now: () => FIXED_NOW });
}

/** Seed a subscription row directly through the storage seam (ticket test setup rule). */
async function seedSubscription(storage: InMemoryTaskStorage, sub: Subscription): Promise<void> {
  await storage.saveSubscription(sub);
}

async function seedEvents(
  storage: InMemoryTaskStorage,
  subscriberId: ULID,
  events: TaskEvent[],
): Promise<void> {
  await storage.appendEvents(subscriberId, events);
}

function subscriberFixture(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscriberId: SUBSCRIBER,
    taskId: TASK_A,
    cursor: ZERO_CURSOR,
    status: "active",
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

// --- subscribe (ADR-0022 section 5) ---------------------------------------------------------

describe("NotificationPipeline.subscribe", () => {
  test("creates an active subscription from ZERO_CURSOR and persists it", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    const sub = await pipeline.subscribe(SUBSCRIBER, TASK_A);

    // ADR-0022 section 5: cursor starts before the first event; status active; createdAt ms.
    expect(sub).toEqual(subscriberFixture());
    // Persistence is the contract: the row must be readable back through storage.
    expect(await storage.loadSubscription(SUBSCRIBER, TASK_A)).toEqual(sub);
  });

  test("honours an explicit since cursor on first creation (fork max(parent, child))", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    // ADR-0022 section 5 default fork cursor: the child observes from the fork point, so
    // the since argument must become the initial cursor rather than being ignored.
    const sub = await pipeline.subscribe(SUBSCRIBER, TASK_A, E2);

    expect(sub.cursor).toBe(E2);
    expect((await storage.loadSubscription(SUBSCRIBER, TASK_A))?.cursor).toBe(E2);
  });

  test("is idempotent: re-subscribe returns the persisted row and does NOT reset the cursor", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A), event(E2, TASK_A)]);
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E1);

    // Counterfactual (#5): pass a since value that a naive implementation would apply on
    // every call. The persisted cursor must survive; a reset would re-deliver E1.
    const again = await pipeline.subscribe(SUBSCRIBER, TASK_A, ZERO_CURSOR);

    expect(again.cursor).toBe(E1);
    expect(again).toEqual(subscriberFixture({ cursor: E1 }));
  });

  test("same subscriber may hold independent subscriptions for two tasks", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    const a = await pipeline.subscribe(SUBSCRIBER, TASK_A);
    const b = await pipeline.subscribe(SUBSCRIBER, TASK_B);

    expect(a.taskId).toBe(TASK_A);
    expect(b.taskId).toBe(TASK_B);
    expect(a.cursor).toBe(ZERO_CURSOR);
    expect(b.cursor).toBe(ZERO_CURSOR);
  });
});

// --- drainPending (ADR-0022 section 6) ------------------------------------------------------

describe("NotificationPipeline.drainPending", () => {
  test("returns every pending event in eventId order and does not advance the cursor", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_A),
      event(E3, TASK_A),
    ]);

    const first = await pipeline.drainPending(SUBSCRIBER, TASK_A);
    expect(first.map((e) => e.eventId)).toEqual([E1, E2, E3]);

    // ADR-0022 section 6: the cursor advances on delivery, not on read. A second drain
    // before an ack must return the same events (at-least-once).
    const second = await pipeline.drainPending(SUBSCRIBER, TASK_A);
    expect(second.map((e) => e.eventId)).toEqual([E1, E2, E3]);
    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(3);
  });

  test("returns an empty array when the cursor is already at the log head", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A)]);
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E1);

    expect(await pipeline.drainPending(SUBSCRIBER, TASK_A)).toEqual([]);
  });

  test("yields only the subscription's own task when one subscriber watches two tasks", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await pipeline.subscribe(SUBSCRIBER, TASK_B);
    // BG-01 stores one event log per subscriber, so the pipeline must filter by taskId;
    // interleave A/B events to prove the boundary is respected.
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_B),
      event(E3, TASK_A),
    ]);

    const a = await pipeline.drainPending(SUBSCRIBER, TASK_A);
    const b = await pipeline.drainPending(SUBSCRIBER, TASK_B);

    expect(a.map((e) => e.eventId)).toEqual([E1, E3]);
    expect(b.map((e) => e.eventId)).toEqual([E2]);
  });

  test("rejects for an unknown subscription instead of silently draining nothing", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    // Constraint #3: a missing subscription is a programmer error, not an empty result.
    await expect(pipeline.drainPending(UNKNOWN_SUBSCRIBER, TASK_A)).rejects.toThrow(
      /drainPending: unknown subscription/,
    );
  });
});

// --- acknowledgeEvents (ADR-0022 section 5) ------------------------------------------------

describe("NotificationPipeline.acknowledgeEvents", () => {
  test("advances the cursor to untilCursor and persists it", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_A),
      event(E3, TASK_A),
    ]);

    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E2);

    expect((await storage.loadSubscription(SUBSCRIBER, TASK_A))?.cursor).toBe(E2);
    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(1);
    expect((await pipeline.drainPending(SUBSCRIBER, TASK_A)).map((e) => e.eventId)).toEqual([E3]);
  });

  test("never moves backwards: an older cursor is a no-op", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_A),
      event(E3, TASK_A),
    ]);
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E3);

    // Counterfactual (#5): an implementation that assigned untilCursor unconditionally
    // would rewind to E1 here and fail both assertions.
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E1);

    expect((await storage.loadSubscription(SUBSCRIBER, TASK_A))?.cursor).toBe(E3);
    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(0);
  });

  test("an equal cursor is a no-op (idempotent duplicate ack)", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A), event(E2, TASK_A)]);
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E2);

    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E2);

    expect((await storage.loadSubscription(SUBSCRIBER, TASK_A))?.cursor).toBe(E2);
  });

  test("rejects for an unknown subscription", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    await expect(pipeline.acknowledgeEvents(UNKNOWN_SUBSCRIBER, TASK_A, E1)).rejects.toThrow(
      /acknowledgeEvents: unknown subscription/,
    );
  });
});

// --- pendingCount ---------------------------------------------------------------------------

describe("NotificationPipeline.pendingCount", () => {
  test("counts events strictly newer than the cursor", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_A),
      event(E3, TASK_A),
    ]);

    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(3);
    // Strictly newer (task-storage loadEvents): the cursor event itself is already delivered.
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E2);
    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(1);
  });

  test("is zero once the cursor has advanced to the last event", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A)]);
    await pipeline.acknowledgeEvents(SUBSCRIBER, TASK_A, E1);

    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(0);
  });

  test("rejects for an unknown subscription", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);

    await expect(pipeline.pendingCount(UNKNOWN_SUBSCRIBER, TASK_A)).rejects.toThrow(
      /pendingCount: unknown subscription/,
    );
  });
});

// --- onIdleWake + notifyIdle (ADR-0022 section 6) -------------------------------------------

describe("NotificationPipeline.onIdleWake / notifyIdle", () => {
  test("invokes every handler in registration order with the drained events and returns them", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A), event(E2, TASK_A)]);

    const calls: string[] = [];
    pipeline.onIdleWake((subscriberId, events) => {
      calls.push("first:" + subscriberId + ":" + events.length);
    });
    pipeline.onIdleWake((subscriberId, events) => {
      calls.push("second:" + subscriberId + ":" + events.length);
    });

    const woken = await pipeline.notifyIdle(SUBSCRIBER, TASK_A);

    expect(woken.map((e) => e.eventId)).toEqual([E1, E2]);
    expect(calls).toEqual(["first:" + SUBSCRIBER + ":2", "second:" + SUBSCRIBER + ":2"]);
  });

  test("does not acknowledge: a later notifyIdle re-delivers the same events", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);
    await seedEvents(storage, SUBSCRIBER, [event(E1, TASK_A)]);

    await pipeline.notifyIdle(SUBSCRIBER, TASK_A);

    // ADR-0022 section 6: the dispatcher wakes, then acknowledges once delivered. The
    // pipeline itself must leave the cursor untouched.
    expect(await pipeline.pendingCount(SUBSCRIBER, TASK_A)).toBe(1);
    const second = await pipeline.notifyIdle(SUBSCRIBER, TASK_A);
    expect(second.map((e) => e.eventId)).toEqual([E1]);
  });

  test("does not invoke handlers when nothing is pending", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await pipeline.subscribe(SUBSCRIBER, TASK_A);

    let calls = 0;
    pipeline.onIdleWake(() => {
      calls += 1;
    });

    const woken = await pipeline.notifyIdle(SUBSCRIBER, TASK_A);

    expect(woken).toEqual([]);
    expect(calls).toBe(0);
  });

  test("rejects for an unknown subscription and leaves handlers untouched", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    let calls = 0;
    pipeline.onIdleWake(() => {
      calls += 1;
    });

    await expect(pipeline.notifyIdle(UNKNOWN_SUBSCRIBER, TASK_A)).rejects.toThrow(
      /drainPending: unknown subscription/,
    );
    expect(calls).toBe(0);
  });
});

// --- ZERO_CURSOR sentinel -------------------------------------------------------------------

describe("ZERO_CURSOR", () => {
  test("is the all-zero sentinel and sorts before every real event id", () => {
    // BG-05 ticket: sentinel ULID meaning from the beginning.
    expect(ZERO_CURSOR).toBe("00000000000000000000");
    // Lexical ordering is what loadEvents(since) relies on (task-storage.ts).
    expect(ZERO_CURSOR < E1).toBe(true);
    expect(ZERO_CURSOR < E2).toBe(true);
    expect(ZERO_CURSOR < E3).toBe(true);
  });

  test("a subscription seeded at ZERO_CURSOR replays the full log", async () => {
    const storage = new InMemoryTaskStorage();
    const pipeline = makePipeline(storage);
    await seedSubscription(storage, subscriberFixture({ cursor: ZERO_CURSOR }));
    await seedEvents(storage, SUBSCRIBER, [
      event(E1, TASK_A),
      event(E2, TASK_A),
      event(E3, TASK_A),
    ]);

    expect((await pipeline.drainPending(SUBSCRIBER, TASK_A)).map((e) => e.eventId)).toEqual([
      E1,
      E2,
      E3,
    ]);
  });
});

// --- splitBatch (ADR-0022 section 7) --------------------------------------------------------

describe("splitBatch", () => {
  test("returns an empty array for an empty event list", () => {
    expect(splitBatch([], DEFAULT_MAX_BATCH_BYTES)).toEqual([]);
  });

  test("keeps events that fit inside one budget in a single order-preserving batch", () => {
    const events = [event(E1, TASK_A), event(E2, TASK_A), event(E3, TASK_A)];

    const batches = splitBatch(events, DEFAULT_MAX_BATCH_BYTES);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => e.eventId)).toEqual([E1, E2, E3]);
  });

  test("splits on an exact-fit boundary and on a budget below one event", () => {
    // Identical shapes => identical JSON byte size, so the boundaries are deterministic.
    const events = [event(E1, TASK_A), event(E2, TASK_A), event(E3, TASK_A)];
    const oneBytes = estimateEventBytes(events[0] as TaskEvent);

    // ADR-0022 section 7: split along event boundaries. Budget == two events => [2, 1].
    const twoBatches = splitBatch(events, oneBytes * 2);
    expect(twoBatches.map((b) => b.length)).toEqual([2, 1]);

    // Budget == one event => each event exactly fits its own batch.
    const singletonBatches = splitBatch(events, oneBytes);
    expect(singletonBatches.map((b) => b.length)).toEqual([1, 1, 1]);

    // Budget below one event => every event is oversized and still gets its own batch.
    const oversizedBatches = splitBatch(events, oneBytes - 1);
    expect(oversizedBatches.map((b) => b.length)).toEqual([1, 1, 1]);
    expect(oversizedBatches.flat().map((e) => e.eventId)).toEqual([E1, E2, E3]);
  });

  test("gives a single oversized event its own batch and never drops it", () => {
    const huge = event(E1, TASK_A, { outputPreview: "p".repeat(4096) });
    const small = event(E2, TASK_A);

    const batches = splitBatch([huge, small], estimateEventBytes(small));

    // ADR-0022 section 7: an event that alone exceeds maxBytes still gets its own batch.
    expect(batches.map((b) => b.map((e) => e.eventId))).toEqual([[E1], [E2]]);
    expect(estimateEventBytes(huge)).toBeGreaterThan(estimateEventBytes(small));
  });

  test("never exceeds the budget for multi-event batches and preserves every event once", () => {
    const events = [
      event(E1, TASK_A, { outputPreview: "a".repeat(300) }),
      event(E2, TASK_A, { outputPreview: "b".repeat(150) }),
      event(E3, TASK_A),
    ];

    for (const maxBytes of [1, 50, 200, DEFAULT_MAX_BATCH_BYTES]) {
      const batches = splitBatch(events, maxBytes);

      // Invariant (#4 source: structural property): order + multiset are preserved.
      expect(batches.flat().map((e) => e.eventId)).toEqual([E1, E2, E3]);

      // A multi-event batch is only legal when its summed estimate fits the budget; the
      // singleton exemption is the "never drop an oversized event" rule above.
      const multi = batches.filter((batch) => batch.length > 1);
      for (const batch of multi) {
        const bytes = batch.reduce((sum, e) => sum + estimateEventBytes(e), 0);
        expect(bytes).toBeLessThanOrEqual(maxBytes);
      }
    }
  });
});
