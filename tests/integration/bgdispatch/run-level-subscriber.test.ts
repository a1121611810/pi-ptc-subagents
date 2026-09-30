/**
 * Production subscription shape (R-m18): ONE run-level subscriber (`callerId: runId`) owns
 * every background task in a run, not one subscriber per dispatch. This is a deterministic
 * IN-PROCESS INTEGRATION test (see ./harness.ts); it never spawns `pi`.
 *
 * The in-memory event buffer is keyed by subscriber, so a run-level subscriber interleaves N
 * tasks' events in a single log. The cursor is per (subscriber, task), which is what keeps the
 * per-task delivery exactly-once; this test pins that the union of the delivered events is the
 * expected set, with no duplicates and cursor order preserved.
 */
import { describe, expect, test } from "vitest";
import type { TaskEvent, ULID } from "../../../src/runtime/task-storage.ts";
import {
  countTerminalEvents,
  createHarness,
  deliverTask,
  recordsOf,
  settleExit,
  spawnWave,
  stopTask,
} from "./harness.ts";

describe("bgdispatch run-level subscriber (production shape)", () => {
  test("N tasks under one run-level subscriber deliver every event exactly once, in cursor order", async () => {
    const RUN_ID = "run-level-1";
    const N = 16;
    const STOPPED = 6;
    // `spawnWave` admits at most `slots.limit` live tasks at a time, so size the cap for ONE
    // wave: all N tasks must be live together for the per-task cursor assertions below. The
    // concurrency cap itself is exercised by the wave/reconcile scenarios.
    const h = createHarness({ concurrency: N });
    const wave = await spawnWave(h, N, { callerId: RUN_ID });

    // Stop a subset so their subscriptions carry more than one delivered event, making the
    // "order by cursor" assertion meaningful. The rest complete cleanly.
    const stopped = wave.slice(0, STOPPED);
    for (const spawned of stopped) await stopTask(h, spawned, "run-level stop");
    for (const spawned of wave) {
      const wasStopped = stopped.includes(spawned);
      if (!wasStopped) {
        // The child answers before it closes: an exit-0 child with no assistant text resolves
        // `failed` (issue #70), and this test asserts the `succeeded` terminal events.
        h.lifecycle.pushEvent(spawned.child, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
        });
      }
      await settleExit(h, spawned, wasStopped ? null : 0, wasStopped ? "SIGTERM" : null);
    }

    const records = await recordsOf(h);
    expect(records).toHaveLength(N);

    // Every task is owned by the SAME subscriber (ADR-0022 §5): one subscription per task.
    for (const record of records) {
      const subscription = await h.storage.loadSubscription(RUN_ID as ULID, record.id);
      expect(subscription).not.toBeNull();
      expect(subscription?.subscriberId).toBe(RUN_ID);
    }

    // Expected delivery set, read from the persisted run-level event log (an oracle independent
    // of the pipeline's per-task filtering): every event except the spawn `running` event,
    // which sits behind each subscription's cursor.
    const log: TaskEvent[] = [];
    for await (const event of h.storage.loadEvents(RUN_ID as ULID)) log.push(event);
    const expected = log.filter((event) => !event.type.endsWith(":running"));
    expect(log).toHaveLength(N + expected.length);

    const delivered: TaskEvent[] = [];
    for (const record of records) delivered.push(...(await deliverTask(h, record.id)));

    // Exactly once: the union of delivered events equals the expected set, with no duplicates.
    const deliveredIds = delivered.map((event) => event.eventId);
    expect(delivered).toHaveLength(expected.length);
    expect(new Set(deliveredIds).size).toBe(delivered.length);
    expect(new Set(deliveredIds)).toEqual(new Set(expected.map((event) => event.eventId)));
    expect(countTerminalEvents(delivered, "succeeded")).toBe(N - STOPPED);
    expect(countTerminalEvents(delivered, "canceled")).toBe(STOPPED);

    // Cursor order within each per-task subscription.
    for (const record of records) {
      const ids = delivered
        .filter((event) => event.taskId === record.id)
        .map((event) => event.eventId);
      expect(ids).toEqual([...ids].sort());
    }
    // The stopped tasks each delivered stopping + canceled = 2 events.
    for (const spawned of stopped) {
      const taskEvents = delivered.filter((event) => event.taskId === spawned.handle.taskId);
      expect(taskEvents.map((event) => event.type.endsWith(":stopping"))).toEqual([true, false]);
    }

    // Every cursor advanced to the task's last event: nothing pending, no redelivery.
    for (const record of records) {
      expect(await h.pipeline.pendingCount(RUN_ID as ULID, record.id)).toBe(0);
    }
    const redelivered: TaskEvent[] = [];
    for (const record of records) redelivered.push(...(await deliverTask(h, record.id)));
    expect(redelivered).toHaveLength(0);
  });
});
