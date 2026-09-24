/**
 * BG-10 anomaly suite: the 6 exception scenarios from the G2 prototype, against the real
 * modules (ADR-0022 §5/§6/§7). This is a deterministic IN-PROCESS INTEGRATION suite (see
 * ./harness.ts); it never spawns `pi`. Each test pins the recovery contract rather than a
 * happy path: cursor replay after a dropped ack, a zombie subscriber that never acks, a fork
 * during delivery, a large cursor replay, malformed child events, and a payload above the
 * 2048-byte preview ceiling.
 */
import { describe, expect, test } from "vitest";
import { parseAgentEvent } from "../../../src/runtime/child-process-lifecycle.ts";
import { DefaultNotificationPipeline } from "../../../src/runtime/notification-pipeline.ts";
import type { OutputStorage } from "../../../src/runtime/output-storage.ts";
import type { RegistryLogger } from "../../../src/runtime/task-registry.ts";
import type { TaskEvent, ULID } from "../../../src/runtime/task-storage.ts";
import { createPtcTaskOutputTool, type PtcTaskOutputDetails } from "../../../src/tools/ptc-task.ts";
import {
  callerFor,
  completeTask,
  createHarness,
  deliverTask,
  pushEvent,
  spawnTask,
  stopTask,
} from "./harness.ts";

describe("bgdispatch anomalies", () => {
  test("network_failure: an unacknowledged drain redelivers, an acked one does not (§6)", async () => {
    const h = createHarness({ concurrency: 2 });
    const spawned = await spawnTask(h, { task: "net" });
    const taskId = spawned.handle.taskId;
    const caller = callerFor(h, taskId);
    await completeTask(h, spawned);

    // Simulate a network failure after drain but before delivery: no ack.
    const first = await h.pipeline.drainPending(caller, taskId);
    const second = await h.pipeline.drainPending(caller, taskId);
    expect(first.map((event) => event.eventId)).toEqual(second.map((event) => event.eventId));
    expect(first).toHaveLength(1);

    await h.pipeline.acknowledgeEvents(caller, taskId, first[0]?.eventId as ULID);
    expect(await h.pipeline.drainPending(caller, taskId)).toHaveLength(0);
  });

  test("subscriber_zombie: a subscriber that never acks loses nothing across a pipeline restart", async () => {
    const h = createHarness({ concurrency: 2 });
    const a = await spawnTask(h, { task: "acked" });
    const b = await spawnTask(h, { task: "zombie" });
    const callerA = callerFor(h, a.handle.taskId);
    const callerB = callerFor(h, b.handle.taskId);
    await completeTask(h, a);
    await completeTask(h, b);

    // Subscriber a drains and acks; subscriber b never does (a zombie).
    await deliverTask(h, a.handle.taskId);
    expect(await h.pipeline.pendingCount(callerA, a.handle.taskId)).toBe(0);
    expect(await h.pipeline.pendingCount(callerB, b.handle.taskId)).toBe(1);

    // A fresh pipeline over the same storage still holds b's event (no loss).
    const revived = new DefaultNotificationPipeline(h.storage, { now: h.clock.clock });
    const recovered = await revived.drainPending(callerB, b.handle.taskId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.type).toBe("task:" + String(b.handle.taskId) + ":->succeeded");
  });

  test("fork_during_delivery: the fork cursor is max(parent, child); the in-flight event stays with the parent", async () => {
    const h = createHarness({ concurrency: 1 });
    const spawned = await spawnTask(h, { task: "fork-delivery" });
    const taskId = spawned.handle.taskId;
    const caller = callerFor(h, taskId);

    await stopTask(h, spawned, "fork during delivery");
    // Drain the stopping event but do NOT ack: it is in flight when the fork happens.
    const inFlight = await h.pipeline.drainPending(caller, taskId);
    expect(inFlight).toHaveLength(1);
    const stoppingEvent = inFlight[0] as TaskEvent;

    await completeTask(h, spawned, 0);

    // The parent, still unacked, sees the in-flight stopping event plus the new canceled one.
    const parent = await h.pipeline.drainPending(caller, taskId);
    expect(parent.map((event) => event.type)).toEqual([
      "task:" + String(taskId) + ":stopping",
      "task:" + String(taskId) + ":->canceled",
    ]);

    // A forked branch starts at max(parent, child) = the in-flight cursor, so the pre-fork
    // stopping event is not redelivered; the post-fork canceled event is.
    const subscription = await h.storage.loadSubscription(caller, taskId);
    if (subscription === null) throw new Error("fork_during_delivery: no subscription");
    await h.storage.saveSubscription({ ...subscription, cursor: stoppingEvent.eventId });
    const forked = await h.pipeline.drainPending(caller, taskId);
    expect(forked).toHaveLength(1);
    expect(forked[0]?.type).toBe("task:" + String(taskId) + ":->canceled");
  });

  test("cursor_overflow: replaying a 1000-event backlog loses nothing and ends at the max cursor", async () => {
    const h = createHarness({ concurrency: 1 });
    const spawned = await spawnTask(h, { task: "overflow" });
    const taskId = spawned.handle.taskId;
    const caller = callerFor(h, taskId);
    await completeTask(h, spawned);

    const synthetic: TaskEvent[] = [];
    for (let index = 0; index < 1_000; index += 1) {
      synthetic.push({
        eventId: ("01JBZ" + String(index).padStart(21, "0")) as ULID,
        subscriptionId: caller,
        taskId,
        type: "task:" + String(taskId) + ":synthetic-" + String(index),
        status: "running",
        transitionAtMs: index,
      });
    }
    await h.storage.appendEvents(caller, synthetic);

    const drained = await h.pipeline.drainPending(caller, taskId);
    // The real terminal event precedes the synthetic backlog (ULID lexical order).
    expect(drained).toHaveLength(1_001);
    expect(drained[0]?.type).toBe("task:" + String(taskId) + ":->succeeded");
    expect(drained[drained.length - 1]?.type).toBe("task:" + String(taskId) + ":synthetic-999");

    await h.pipeline.acknowledgeEvents(
      caller,
      taskId,
      drained[drained.length - 1]?.eventId as ULID,
    );
    expect(await h.pipeline.drainPending(caller, taskId)).toHaveLength(0);
  });

  test("malformed_event: unparseable child events are explicitly dropped, never counted as output", async () => {
    // The adapter's parse boundary is the failure surface: an unparseable line yields an
    // explicit `null` (never a throw, never a fabricated event) and is dropped.
    expect(parseAgentEvent("not json")).toBeNull();
    expect(parseAgentEvent("   ")).toBeNull();
    expect(parseAgentEvent("{'type':'message_end'}")).toBeNull();
    expect(parseAgentEvent('{"type":"message_end"')).toBeNull();

    const h = createHarness({ concurrency: 1 });
    const spawned = await spawnTask(h, { task: "malformed" });
    pushEvent(h, spawned, { type: "not_a_message" });
    pushEvent(h, spawned, {
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "ignored" }] },
    });
    pushEvent(h, spawned, { type: "message_end" });

    const record = await completeTask(h, spawned, 0);
    expect(record.status).toBe("succeeded");
    // Only assistant message_end text is captured; the junk events contribute 0 bytes, so the
    // run's explicit outcome is an empty preview rather than a fabricated payload.
    expect(record.outputBytes).toBe(0);
    expect(record.outputPreview).toBe("");
  });

  test("huge_payload: a 3000-byte output has no inline preview but is fully readable (§3/§7)", async () => {
    const h = createHarness({ concurrency: 1 });
    const spawned = await spawnTask(h, { task: "huge" });
    const taskId = spawned.handle.taskId;
    const caller = callerFor(h, taskId);
    const huge = "H".repeat(3_000);

    const record = await completeTask(h, spawned, 0, huge);
    // 3000 > the 2048-byte Map+preview ceiling: no inline preview, but outputRef is set.
    expect(record.outputBytes).toBe(3_000);
    expect(record.outputPreview).toBeUndefined();
    expect(record.outputRef).toBe(h.outputStorage.outputRef(taskId));

    const pending = await h.pipeline.drainPending(caller, taskId);
    const terminal = pending.find((event) => event.type.endsWith(":->succeeded"));
    expect(terminal?.outputBytes).toBe(3_000);
    expect(terminal?.outputPreview).toBeUndefined();

    // ptc_task_output dereferences the stored bytes; 3000 bytes is under ADR-0015's limits.
    const tool = createPtcTaskOutputTool(h.registry, h.outputStorage);
    const result = (await tool.execute(
      "anomaly-huge",
      { taskId },
      undefined,
      undefined,
      undefined as never,
    )) as { details: PtcTaskOutputDetails };
    expect(result.details.output).toBe(huge);
    expect(result.details.outputBytes).toBe(3_000);
    expect(result.details.outputTruncated).toBe(false);
    expect(result.details.outputPreview).toBeUndefined();
  });

  test("huge_payload persistence failure: the failure is warned about, not swallowed (§3)", async () => {
    // The pump persists a task's drained stdout before the terminal transition. When that write
    // fails it must surface a warning and still write the record (testing-constraints #3).
    const warnings: string[] = [];
    const logger: RegistryLogger = {
      info: (_message: string): void => undefined,
      warn: (message: string): void => {
        warnings.push(message);
      },
    };
    const failingStorage: OutputStorage = {
      readOutput: async (): Promise<string | null> => null,
      writeOutput: async (): Promise<void> => {
        throw new Error("disk full (simulated)");
      },
      outputRef: (taskId): string => "memory:tasks/" + String(taskId) + "/output.log",
    };
    const h = createHarness({ concurrency: 1, outputStorage: failingStorage, logger });
    const spawned = await spawnTask(h, { task: "persist-fail" });
    const huge = "H".repeat(3_000);

    const record = await completeTask(h, spawned, 0, huge);
    // The terminal state is still written (the run is not lost to a storage failure) ...
    expect(record.status).toBe("succeeded");
    expect(record.outputBytes).toBe(3_000);
    expect(record.outputPreview).toBeUndefined();
    // ... but it must not claim an outputRef whose bytes were never persisted, and the failure
    // must be observable through the injected logger.
    expect(record.outputRef).toBeUndefined();
    expect(
      warnings.some(
        (message) =>
          message.includes("output persistence") && message.includes(spawned.handle.taskId),
      ),
    ).toBe(true);
  });
});
