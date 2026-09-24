/**
 * BG-10 scenario suite: the 12 G2 prototype scenarios against the real background-dispatch
 * modules (ADR-0022 §2/§3/§5/§6/§7/§9). This is a deterministic IN-PROCESS INTEGRATION suite
 * (see ./harness.ts); it never spawns `pi`. Real end-to-end coverage — an actual `pi` child and
 * a real signal to a live OS process — lives in `tests/e2e/bgdispatch.test.ts` and is opt-in.
 *
 * Delivery note (ADR-0022 §5 + BG-02 `#spawn`): the spawn opens the owner subscription with
 * its cursor already at the `task:<id>:running` event id, so that event is not pending — the
 * spawning program already holds the handle. Every later transition is delivered exactly once;
 * an explicit cursor reset to the start (the fork "initial" replay) surfaces the running event
 * again. The scenarios below therefore count terminal transitions, plus the `stopping`
 * transition for stopped tasks.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
// NOTE: ./harness.ts must be imported BEFORE any src module that imports node:fs: the harness
// installs the hermetic node:fs mock (agent markdown + prompt tmpfile) and that mock only
// applies to modules evaluated after it is registered.
import {
  callerFor,
  completeTask,
  countRunningEvents,
  countTerminalEvents,
  createHarness,
  deliverAll,
  deliverTask,
  recordsOf,
  reconcile,
  runWaves,
  settleExit,
  spawnTask,
  spawnWave,
  stopTask,
} from "./harness.ts";
import { DISPATCH_KILL_GRACE_MS } from "../../../src/runtime/dispatch.ts";
import { ZERO_CURSOR } from "../../../src/runtime/notification-pipeline.ts";
import { FileTaskStorage } from "../../../src/runtime/task-storage-file.ts";
import type { TaskEvent, ULID } from "../../../src/runtime/task-storage.ts";

describe("bgdispatch scenarios", () => {
  test("steady_60: 60 sequential tasks all succeed and deliver their terminal event", async () => {
    const h = createHarness({ concurrency: 8 });
    await runWaves(h, 60);

    const records = await recordsOf(h);
    expect(records).toHaveLength(60);
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(60);

    const events = await deliverAll(h);
    expect(events).toHaveLength(60);
    expect(countTerminalEvents(events, "succeeded")).toBe(60);
    // The spawn running event is behind the subscription cursor (BG-02 #spawn).
    expect(countRunningEvents(events)).toBe(0);
    // Acknowledged events are never redelivered (ADR-0022 §5).
    expect(await deliverAll(h)).toHaveLength(0);
    expect(h.slots.active).toBe(0);
  });

  test("burst_100: 100 tasks keep the cap satisfied and all deliver", async () => {
    const h = createHarness({ concurrency: 8 });
    await runWaves(h, 100);

    const records = await recordsOf(h);
    expect(records).toHaveLength(100);
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(100);

    const events = await deliverAll(h);
    expect(events).toHaveLength(100);
    expect(countTerminalEvents(events, "succeeded")).toBe(100);
    expect(h.slots.active).toBe(0);
  });

  test("super_burst_500: 500 tasks under the hard cap all deliver", async () => {
    const h = createHarness({ concurrency: 8 });
    await runWaves(h, 500);

    const records = await recordsOf(h);
    expect(records).toHaveLength(500);
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(500);

    const events = await deliverAll(h);
    expect(events).toHaveLength(500);
    expect(countTerminalEvents(events, "succeeded")).toBe(500);
  });

  test("ai_busy_5min: a 5-minute parent silence drains the backlog in one wake (§6)", async () => {
    const h = createHarness({ concurrency: 5 });
    const wave = await spawnWave(h, 5);
    for (const spawned of wave) {
      await completeTask(h, spawned, 0, "done");
    }
    // The model is busy for 5 minutes; nothing drains in that window.
    h.clock.advance(300_000);
    expect(h.delivered).toHaveLength(0);

    const first = await deliverTask(h, wave[0]?.handle.taskId as ULID);
    // ADR-0022 §6: one idle wake drains the whole per-task buffer (the terminal event).
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe("task:" + String(first[0]?.taskId) + ":->succeeded");
    expect(h.wakeBatches).toEqual([1]);
    expect(
      await h.pipeline.pendingCount(
        callerFor(h, first[0]?.taskId as ULID),
        first[0]?.taskId as ULID,
      ),
    ).toBe(0);
  });

  test("restart: a FRESH process over the same persisted storage reconciles running tasks to lost and delivers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bg-restart-"));
    try {
      const before = createHarness({ concurrency: 3, storage: new FileTaskStorage(dir) });
      await spawnWave(before, 3);
      before.clock.advance(60_000);
      expect((await recordsOf(before)).map((record) => record.status)).toEqual([
        "running",
        "running",
        "running",
      ]);

      // A NEW PROCESS: a second FileTaskStorage over the same directory, with a fresh registry
      // and pipeline. Nothing is shared with `before` except the files on disk — this is the
      // shape that catches a production session_start that forgets to reconcile (R-M7).
      const after = createHarness({ storage: new FileTaskStorage(dir), clock: before.clock });
      const reconciled = await after.registry.reconcileLostTasks();
      expect(reconciled).toHaveLength(3);
      expect(reconciled.map((record) => record.status)).toEqual(["lost", "lost", "lost"]);
      expect(reconciled.map((record) => record.errorMessage)).toEqual([
        "lost_on_session_restart",
        "lost_on_session_restart",
        "lost_on_session_restart",
      ]);
      // The loss is persisted, not just returned ...
      const persisted = await recordsOf(after);
      expect(persisted.filter((record) => record.status === "lost")).toHaveLength(3);
      // ... and a second reconcile finds nothing non-terminal (idempotent recovery).
      expect(await after.registry.reconcileLostTasks()).toHaveLength(0);

      // ... AND delivered through the fresh notification pipeline.
      const events = await deliverAll(after);
      expect(events).toHaveLength(3);
      expect(countTerminalEvents(events, "lost")).toBe(3);
      expect(after.delivered.map((entry) => entry.event.type.endsWith(":->lost"))).toEqual([
        true,
        true,
        true,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restart counterfactual: skipping the reconcile call leaves the persisted records running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-bg-restart-"));
    try {
      const before = createHarness({ concurrency: 3, storage: new FileTaskStorage(dir) });
      await spawnWave(before, 3);
      before.clock.advance(60_000);

      // Same fresh-process setup as the restart test, minus `reconcileLostTasks()`. The records
      // must therefore stay `running` and deliver nothing — proof the reconcile call is what
      // makes the sibling test green (testing-constraints #5, counterfactual).
      const forgetful = createHarness({ storage: new FileTaskStorage(dir), clock: before.clock });
      const persisted = await recordsOf(forgetful);
      expect(persisted).toHaveLength(3);
      expect(persisted.map((record) => record.status)).toEqual(["running", "running", "running"]);
      expect(await deliverAll(forgetful)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fork (v1): a caller-supplied cursor skips pre-cursor events; reset to initial replays all (§5)", async () => {
    const h = createHarness({ concurrency: 1 });
    const spawned = await spawnTask(h, { task: "fork" });
    const taskId = spawned.handle.taskId;
    const caller = callerFor(h, taskId);

    // The stopping transition is the pre-fork event; deliver it so the fork cursor is at it.
    await stopTask(h, spawned, "fork stop");
    const preFork = await deliverTask(h, taskId);
    expect(preFork).toHaveLength(1);
    const stoppingEvent = preFork[0] as TaskEvent;
    expect(stoppingEvent.type).toBe("task:" + String(taskId) + ":stopping");
    const forkCursor = (await h.storage.loadSubscription(caller, taskId))?.cursor;
    expect(forkCursor).toBe(stoppingEvent.eventId);

    await completeTask(h, spawned, 0);
    const postFork = await h.pipeline.drainPending(caller, taskId);
    // v1 fork: the caller supplies the branch cursor by saving the subscription cursor (there is
    // no shipped ptc_task_resubscribe helper — ADR-0022 §5 defers it to v2). Only the post-fork
    // canceled event is visible.
    expect(postFork).toHaveLength(1);
    expect(postFork[0]?.type).toBe("task:" + String(taskId) + ":->canceled");

    // Explicit reset to "initial": the caller rewinds the cursor and the whole log replays.
    const subscription = await h.storage.loadSubscription(caller, taskId);
    if (subscription === null) throw new Error("fork: owner subscription missing");
    await h.storage.saveSubscription({ ...subscription, cursor: ZERO_CURSOR });
    const replay = await h.pipeline.drainPending(caller, taskId);
    expect(replay.map((event) => event.type)).toEqual([
      "task:" + String(taskId) + ":running",
      "task:" + String(taskId) + ":stopping",
      "task:" + String(taskId) + ":->canceled",
    ]);
  });

  test("stop_spike: a stop really signals each live child, then resolves canceled (§8)", async () => {
    const h = createHarness({ concurrency: 3 });
    const wave = await spawnWave(h, 3);

    for (const spawned of wave) {
      const details = await stopTask(h, spawned, "spike");
      expect(details.fromStatus).toBe("running");
      expect(details.task.status).toBe("stopping");
      // R-M8: a "stop" that never signals is not a stop. The pump's `stopping` observer must
      // have SIGTERMed the live child; getKillSignals exposes what the adapter delivered.
      expect(h.lifecycle.getKillSignals(spawned.child)).toEqual(["SIGTERM"]);
    }
    // Late-arrival stop is idempotent (ADR-0022 §8): no second stopping transition, no re-signal.
    const firstStopped = wave[0] as (typeof wave)[number];
    const repeated = await stopTask(h, firstStopped, "again");
    expect(repeated.fromStatus).toBe("stopping");
    expect(repeated.task.status).toBe("stopping");
    expect(h.lifecycle.getKillSignals(firstStopped.child)).toEqual(["SIGTERM"]);

    // The child closes because of the signal; the record resolves canceled, not succeeded.
    for (const spawned of wave) {
      const record = await settleExit(h, spawned, null, "SIGTERM");
      expect(record.status).toBe("canceled");
    }
    const records = await recordsOf(h);
    expect(records.filter((record) => record.status === "canceled")).toHaveLength(3);

    const events = await deliverAll(h);
    // Each stopped task delivers stopping + canceled = 2 events (6 total).
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.type.endsWith(":stopping"))).toHaveLength(3);
    expect(countTerminalEvents(events, "canceled")).toBe(3);
  });

  test("stop escalation: SIGKILL is delivered only after DISPATCH_KILL_GRACE_MS (§8)", async () => {
    // The kill ladder schedules the SIGKILL with a real setTimeout; fake only the timers so the
    // setImmediate-driven completion flushes stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = createHarness({ concurrency: 1 });
      const spawned = await spawnTask(h, { task: "escalate" });
      await stopTask(h, spawned, "hang");
      expect(h.lifecycle.getKillSignals(spawned.child)).toEqual(["SIGTERM"]);

      // Inside the grace window the child is not force-killed.
      vi.advanceTimersByTime(DISPATCH_KILL_GRACE_MS - 1);
      expect(h.lifecycle.getKillSignals(spawned.child)).toEqual(["SIGTERM"]);

      // At the grace boundary the single escalation fires exactly once.
      vi.advanceTimersByTime(1);
      expect(h.lifecycle.getKillSignals(spawned.child)).toEqual(["SIGTERM", "SIGKILL"]);

      const record = await settleExit(h, spawned, null, "SIGKILL");
      expect(record.status).toBe("canceled");
    } finally {
      vi.useRealTimers();
    }
  });

  // The G2 `ptc_off` scenario is intentionally absent: /ptc off gates the PTC tool loadout
  // (src/mode/ptc-mode.ts — ptc_run_code / ptc_workflow), not `dispatch()` itself, so this
  // harness, which calls the background branch directly, cannot reach the gate. A placeholder
  // assertion here would exercise nothing; see the WS-TESTS report for the finding.

  test("mixed_500: 300 succeeded / 100 failed / 50 canceled / 50 lost all deliver", async () => {
    const h = createHarness({ concurrency: 512 });
    await runWaves(h, 300, () => 0);
    await runWaves(h, 100, () => 1);

    const stopped = await spawnWave(h, 50);
    for (const spawned of stopped) await stopTask(h, spawned);
    for (const spawned of stopped) await settleExit(h, spawned, null, "SIGTERM");

    await spawnWave(h, 50);
    h.clock.advance(1_000);
    const lost = await reconcile(h);
    expect(lost).toHaveLength(50);

    const records = await recordsOf(h);
    expect(records).toHaveLength(500);
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(300);
    expect(records.filter((record) => record.status === "failed")).toHaveLength(100);
    expect(records.filter((record) => record.status === "canceled")).toHaveLength(50);
    expect(records.filter((record) => record.status === "lost")).toHaveLength(50);

    const events = await deliverAll(h);
    // 500 terminal transitions + 50 stopping transitions = 550 delivered events.
    expect(events).toHaveLength(550);
    expect(countTerminalEvents(events, "succeeded")).toBe(300);
    expect(countTerminalEvents(events, "failed")).toBe(100);
    expect(countTerminalEvents(events, "canceled")).toBe(50);
    expect(countTerminalEvents(events, "lost")).toBe(50);
    expect(events.filter((event) => event.type.endsWith(":stopping"))).toHaveLength(50);
  });

  test("zombie_60: 60 never-exiting tasks hold their slots and reconcile to lost", async () => {
    const h = createHarness({ concurrency: 64 });
    await spawnWave(h, 60);

    const live = await recordsOf(h);
    expect(live).toHaveLength(60);
    expect(live.filter((record) => record.status === "running")).toHaveLength(60);
    expect(h.slots.active).toBe(60);

    // A running task has no pending terminal yet (the spawn event is behind the cursor).
    expect(await deliverAll(h)).toHaveLength(0);

    h.clock.advance(600_000);
    const lost = await reconcile(h);
    expect(lost).toHaveLength(60);
    const lostEvents = await deliverAll(h);
    expect(lostEvents).toHaveLength(60);
    expect(countTerminalEvents(lostEvents, "lost")).toBe(60);
    expect(h.delivered).toHaveLength(60);
  });

  test("slow_fast: fast tasks deliver before slow tasks, and every slot is released", async () => {
    const h = createHarness({ concurrency: 8 });
    const wave = await spawnWave(h, 8);
    const fast = wave.slice(0, 4);
    const slow = wave.slice(4);

    for (const spawned of fast) {
      await completeTask(h, spawned, 0);
      await deliverTask(h, spawned.handle.taskId);
    }
    for (const spawned of slow) {
      await completeTask(h, spawned, 0);
      await deliverTask(h, spawned.handle.taskId);
    }

    const terminalOrder = h.delivered
      .filter((entry) => entry.event.type.endsWith(":->succeeded"))
      .map((entry) => entry.event.taskId);
    expect(terminalOrder).toEqual([
      ...fast.map((spawned) => spawned.handle.taskId),
      ...slow.map((spawned) => spawned.handle.taskId),
    ]);
    expect(h.slots.active).toBe(0);
  });

  test("stress_1000: 1000 tasks complete with 100% delivery", async () => {
    const h = createHarness({ concurrency: 8 });
    await runWaves(h, 1_000);

    const records = await recordsOf(h);
    expect(records).toHaveLength(1_000);
    expect(records.filter((record) => record.status === "succeeded")).toHaveLength(1_000);

    const events = await deliverAll(h);
    expect(events).toHaveLength(1_000);
    expect(countTerminalEvents(events, "succeeded")).toBe(1_000);
    expect(h.slots.active).toBe(0);
  }, 20_000);
});
