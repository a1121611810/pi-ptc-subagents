/**
 * Tests for the file-backed TaskStorage adapter (BG-13, issue #65).
 *
 * SPECIFICATION tests (docs/testing-constraints.md constraint #6), not characterization: the
 * path strings and record shape are copied from ADR-0022 (What we add §3: "persisted to
 * <sessionDir>/tasks/<taskId>.json"; §5: "persisted to
 * <sessionDir>/subscriptions/<subscriberId>-<taskId>.json") and from the TaskStorage interface
 * doc in src/runtime/task-storage.ts. Expected values are never read back out of
 * FileTaskStorage. The corrupt-record fixture is a real serialized TaskRecord truncated
 * mid-JSON — the shape a crash can leave behind (constraint #2: fixture from a real sample).
 *
 * Coverage map: all 8 TaskStorage methods have a temp-dir success path and at least one
 * explicit-error path (constraint #1). Failure paths assert the thrown Error and its message
 * pattern (constraint #3) — no silent empty read is accepted. Every important assertion is
 * checked against the counterfactual "would an obviously-broken implementation still pass?"
 * (constraint #5): see the inline counterfactual comments.
 *
 * IO is REAL: node:fs/promises + node:os.tmpdir() + mkdtemp + rm. Only the failure-injection
 * tests substitute a delegating TaskStorageFs facade (the DI seam required by the issue).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FileTaskStorage,
  type TaskStorageFs,
} from "../../src/runtime/task-storage-file.ts";
import type {
  Subscription,
  TaskEvent,
  TaskRecord,
  TaskStorage,
  ULID,
} from "../../src/runtime/task-storage.ts";

// --- Test fixtures (copy-pasted from ADR-0022 §3 + §5 + §2/§8 emit keys) -------------------

/**
 * 21-field TaskRecord matching ADR-0022 §3 verbatim. Every optional field is present as
 * undefined so the round-trip toEqual(record) catches a field drop.
 */
function fixtureTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "01JBZ00000000000000000000A" as ULID,
    label: "research X",
    agentName: "researcher",
    depth: 0,
    status: "running",
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    finishedAt: undefined,
    durationMs: undefined,
    transitionAt: 1_700_000_000_000,
    outputRef: undefined,
    outputBytes: undefined,
    outputPreview: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    exitCode: undefined,
    spawnSource: { kind: "ptc-program", callerId: "run-001" },
    parentTaskId: undefined,
    sessionFile: undefined,
    ...overrides,
  };
}

/** Subscription fixture (ADR-0022 §5). */
function fixtureSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscriberId: "01JBZ00000000000000000010S" as ULID,
    taskId: "01JBZ00000000000000000000A" as ULID,
    cursor: "01JBZ00000000000000000020C" as ULID,
    status: "active",
    createdAt: 1_700_000_000_500,
    ...overrides,
  };
}

/** TaskEvent fixture; the type field is the literal ADR-0022 §2 emit key, not derived in-test. */
function fixtureEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    eventId: "01JBZ00000000000000000030E" as ULID,
    subscriptionId: "01JBZ00000000000000000010S" as ULID,
    taskId: "01JBZ00000000000000000000A" as ULID,
    type: "task:01JBZ00000000000000000000A:running",
    status: "running",
    transitionAtMs: 1_700_000_001_000,
    outputBytes: undefined,
    outputPreview: undefined,
    ...overrides,
  };
}

// --- Test helpers ---------------------------------------------------------------------------

/** A delegating default fs facade, mirroring how the adapter wires node:fs/promises. */
function realFs(): TaskStorageFs {
  return {
    mkdir: (path, options) => mkdir(path, options),
    readFile: (path, options) => readFile(path, options),
    writeFile: (path, data, options) => writeFile(path, data, options),
    appendFile: (path, data, options) => appendFile(path, data, options),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: (path) => unlink(path),
    readdir: (path) => readdir(path),
  };
}

async function makeBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-ptc-task-storage-"));
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

/** Drain an async iterable while asserting it rejects (the iterator must be consumed). */
async function drainExpectingRejection(iter: AsyncIterable<unknown>): Promise<unknown> {
  let error: unknown;
  try {
    for await (const _ of iter) void _;
  } catch (caught) {
    error = caught;
  }
  return error;
}

// --- Tests -----------------------------------------------------------------------------------

describe("FileTaskStorage: paths (ADR-0022 §3 + §5 layout)", () => {
  test("saveTask writes <base>/tasks/<taskId>.json with the full serialized record", async () => {
    const base = await makeBase();
    try {
      const storage: TaskStorage = new FileTaskStorage(base);
      const record = fixtureTask();
      await storage.saveTask(record);

      // SPECIFICATION: the exact path string is ADR-0022's "persisted to
      // <sessionDir>/tasks/<taskId>.json" (What we add §3). Counterfactual: an adapter that
      // wrote tasks.json (one aggregate file) or a different name would fail this.
      const path = join(base, "tasks", record.id + ".json");
      expect(existsSync(path)).toBe(true);
      const onDisk: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk).toEqual(record);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveSubscription writes <base>/subscriptions/<subscriberId>-<taskId>.json", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);

      // SPECIFICATION: ADR-0022 §5 "persisted to
      // <sessionDir>/subscriptions/<subscriberId>-<taskId>.json".
      const path = join(base, "subscriptions", sub.subscriberId + "-" + sub.taskId + ".json");
      expect(existsSync(path)).toBe(true);
      const onDisk: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk).toEqual(sub);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("appendEvents writes newline-delimited JSON to <base>/events/<subscriberId>-<taskId>.jsonl", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
      const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
      await storage.appendEvents(sub.subscriberId, [e1, e2]);

      // SPECIFICATION: issue #65 layout events/<subscriberId>-<taskId>.jsonl, append-only
      // newline-delimited. Counterfactual: a single-JSON-array file would fail the split length.
      const path = join(base, "events", sub.subscriberId + "-" + sub.taskId + ".jsonl");
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed: unknown[] = lines.map((line) => JSON.parse(line));
      expect(parsed).toEqual([e1, e2]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: task CRUD (loadTask / saveTask / deleteTask)", () => {
  test("saveTask + loadTask round-trip preserves every field of the 21-field schema", async () => {
    const base = await makeBase();
    try {
      const storage: TaskStorage = new FileTaskStorage(base);
      const record = fixtureTask();
      await storage.saveTask(record);

      const loaded = await storage.loadTask(record.id);
      // SPECIFICATION (constraint #4): field-for-field ADR-0022 §3 schema equality.
      // Counterfactual: dropping spawnSource.callerId or an optional field fails toEqual.
      expect(loaded).toEqual(record);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadTask returns null for an unknown id (ENOENT = absent, not a throw)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      // SPECIFICATION: interface doc "returns null if the id is unknown". A read miss must be
      // null; only a corrupt/unreadable file is an error (constraint #1 boundary).
      expect(await storage.loadTask("01JBZ000000000000000ZZZZZZ" as ULID)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveTask twice replaces the record (insert-or-replace)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const first = fixtureTask({ status: "running" });
      const second = fixtureTask({ status: "succeeded", finishedAt: 1_700_000_005_000 });
      await storage.saveTask(first);
      await storage.saveTask(second);

      expect(await storage.loadTask(first.id)).toEqual(second);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveTask rejects on a nullish record (constraint #3)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await expect(storage.saveTask(null as unknown as TaskRecord)).rejects.toThrow(
        /saveTask: record is required/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("deleteTask removes a known record; subsequent loadTask returns null", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const record = fixtureTask();
      await storage.saveTask(record);

      await storage.deleteTask(record.id);
      expect(await storage.loadTask(record.id)).toBeNull();
      // Counterfactual: a delete that only cleared an in-memory cache but left the file would
      // be caught by this direct path check.
      expect(existsSync(join(base, "tasks", record.id + ".json"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("deleteTask rejects for an unknown id (constraint #3)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await expect(
        storage.deleteTask("01JBZ000000000000000DELETEME" as ULID),
      ).rejects.toThrow(/deleteTask: unknown taskId/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: listTasks(filter)", () => {
  test("without filter, yields every saved record", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const a = fixtureTask({ id: "01JBZ00000000000000000001A" as ULID, label: "alpha" });
      const b = fixtureTask({ id: "01JBZ00000000000000000002B" as ULID, label: "beta" });
      const c = fixtureTask({ id: "01JBZ00000000000000000003C" as ULID, label: "gamma" });
      await storage.saveTask(a);
      await storage.saveTask(b);
      await storage.saveTask(c);

      const got = await collect(storage.listTasks());
      // SPECIFICATION: the file adapter's iteration order is "stable but unspecified"
      // (TaskStorage.listTasks doc), so assert the set, not insertion order.
      expect(got.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("filter by status narrows to records matching exactly that status", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const running = fixtureTask({ id: "01JBZ00000000000000000001A" as ULID, status: "running" });
      const succeeded = fixtureTask({ id: "01JBZ00000000000000000002B" as ULID, status: "succeeded" });
      const failed = fixtureTask({ id: "01JBZ00000000000000000003C" as ULID, status: "failed" });
      await storage.saveTask(running);
      await storage.saveTask(succeeded);
      await storage.saveTask(failed);

      const got = await collect(storage.listTasks({ status: "succeeded" }));
      expect(got).toHaveLength(1);
      expect(got[0]?.id).toBe(succeeded.id);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("filter by label is exact-match (no substring / prefix)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await storage.saveTask(
        fixtureTask({ id: "01JBZ00000000000000000001A" as ULID, label: "research X" }),
      );
      await storage.saveTask(
        fixtureTask({ id: "01JBZ00000000000000000002B" as ULID, label: "research Y" }),
      );
      await storage.saveTask(
        fixtureTask({ id: "01JBZ00000000000000000003C" as ULID, label: "ship Z" }),
      );

      const got = await collect(storage.listTasks({ label: "research X" }));
      expect(got.map((r) => r.label)).toEqual(["research X"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("filter combining status + label applies AND", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await storage.saveTask(
        fixtureTask({
          id: "01JBZ00000000000000000001A" as ULID,
          label: "research X",
          status: "running",
        }),
      );
      await storage.saveTask(
        fixtureTask({
          id: "01JBZ00000000000000000002B" as ULID,
          label: "research X",
          status: "succeeded",
        }),
      );
      await storage.saveTask(
        fixtureTask({
          id: "01JBZ00000000000000000003C" as ULID,
          label: "ship Z",
          status: "succeeded",
        }),
      );

      const got = await collect(storage.listTasks({ status: "succeeded", label: "research X" }));
      expect(got).toHaveLength(1);
      expect(got[0]?.id).toBe("01JBZ00000000000000000002B");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("listTasks yields an empty async iterable when nothing matches (no throw)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await storage.saveTask(fixtureTask({ status: "running" }));
      expect(await collect(storage.listTasks({ status: "lost" }))).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("listTasks throws on a corrupt record file (never a silent skip)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const record = fixtureTask();
      await mkdir(join(base, "tasks"), { recursive: true });
      await writeFile(join(base, "tasks", record.id + ".json"), "{ not json", "utf8");

      // Counterfactual: an implementation that caught and skipped unreadable files would
      // resolve to [] and silently hide a whole task; assert the rejection instead.
      await expect(collect(storage.listTasks())).rejects.toThrow(/corrupt JSON/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: subscription CRUD", () => {
  test("saveSubscription + loadSubscription round-trip preserves every field", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);

      expect(await storage.loadSubscription(sub.subscriberId, sub.taskId)).toEqual(sub);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadSubscription returns null for an unknown (subscriberId, taskId) pair", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);

      expect(
        await storage.loadSubscription("01JBZ000000000000000OTHER1" as ULID, sub.taskId),
      ).toBeNull();
      expect(
        await storage.loadSubscription(sub.subscriberId, "01JBZ000000000000000OTH2R" as ULID),
      ).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveSubscription rejects on a nullish sub (constraint #3)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      await expect(storage.saveSubscription(null as unknown as Subscription)).rejects.toThrow(
        /saveSubscription: sub is required/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveSubscription for the same pair replaces the prior row", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub1 = fixtureSub({ cursor: "01JBZ00000000000000000020C" as ULID });
      const sub2 = fixtureSub({ cursor: "01JBZ00000000000000000099N" as ULID, status: "closed" });
      await storage.saveSubscription(sub1);
      await storage.saveSubscription(sub2);

      expect(await storage.loadSubscription(sub1.subscriberId, sub1.taskId)).toEqual(sub2);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadSubscription throws on a corrupt subscription file (never null)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await mkdir(join(base, "subscriptions"), { recursive: true });
      await writeFile(
        join(base, "subscriptions", sub.subscriberId + "-" + sub.taskId + ".json"),
        '{"subscriberId":',
        "utf8",
      );

      await expect(storage.loadSubscription(sub.subscriberId, sub.taskId)).rejects.toThrow(
        /corrupt JSON/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: appendEvents / loadEvents", () => {
  test("appendEvents + loadEvents yields every event in eventId (ULID) order", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
      const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
      const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });
      await storage.appendEvents(sub.subscriberId, [e3, e1, e2]);

      const got = await collect(storage.loadEvents(sub.subscriberId));
      // SPECIFICATION: loadEvents doc "Yields in eventId ascending order"; input is shuffled.
      expect(got.map((e) => e.eventId)).toEqual([e1.eventId, e2.eventId, e3.eventId]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadEvents(since) yields strictly-newer events than the cursor", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
      const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
      const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });
      await storage.appendEvents(sub.subscriberId, [e1, e2, e3]);

      // ADR-0022 §5: the cursor advances past the delivered event, so eventId === since is
      // excluded (strictly greater).
      const sinceE1 = await collect(storage.loadEvents(sub.subscriberId, e1.eventId));
      expect(sinceE1.map((e) => e.eventId)).toEqual([e2.eventId, e3.eventId]);
      const sinceE3 = await collect(storage.loadEvents(sub.subscriberId, e3.eventId));
      expect(sinceE3).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadEvents with since=undefined yields the full log", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
      const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
      await storage.appendEvents(sub.subscriberId, [e1, e2]);

      const got = await collect(storage.loadEvents(sub.subscriberId));
      expect(got.map((e) => e.eventId)).toEqual([e1.eventId, e2.eventId]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("the event log is keyed by SUBSCRIBER: one subscriber's events across two tasks merge", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const subscriberId = "01JBZ00000000000000000010S" as ULID;
      const taskA = "01JBZ00000000000000000000A" as ULID;
      const taskB = "01JBZ00000000000000000000B" as ULID;
      await storage.saveSubscription({
        subscriberId,
        taskId: taskA,
        cursor: "01JBZ00000000000000000020C" as ULID,
        status: "active",
        createdAt: 1_700_000_000_500,
      });
      await storage.saveSubscription({
        subscriberId,
        taskId: taskB,
        cursor: "01JBZ00000000000000000021D" as ULID,
        status: "active",
        createdAt: 1_700_000_000_501,
      });
      const eA = fixtureEvent({
        eventId: "01JBZ00000000000000000001E" as ULID,
        subscriptionId: subscriberId,
        taskId: taskA,
      });
      const eB = fixtureEvent({
        eventId: "01JBZ00000000000000000002E" as ULID,
        subscriptionId: subscriberId,
        taskId: taskB,
      });
      await storage.appendEvents(subscriberId, [eB]);
      await storage.appendEvents(subscriberId, [eA]);

      // SPECIFICATION (BG-01 fixed bug): the log key is the subscriber, not the task. A
      // task-keyed adapter would return only eA (or only eB), failing this exact list.
      const got = await collect(storage.loadEvents(subscriberId));
      expect(got.map((e) => e.eventId)).toEqual([eA.eventId, eB.eventId]);
      expect(existsSync(join(base, "events", subscriberId + "-" + taskA + ".jsonl"))).toBe(true);
      expect(existsSync(join(base, "events", subscriberId + "-" + taskB + ".jsonl"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadEvents on an unknown subscriptionId rejects (constraint #3)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      // SPECIFICATION (constraint #1 failure path): a typo'd subscriber must surface, not yield [].
      const error = await drainExpectingRejection(
        storage.loadEvents("01JBZ000000000000000NOSUB1" as ULID),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/loadEvents: unknown subscriptionId/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("appendEvents rejects for an unknown subscriptionId (constraint #3)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const ev = fixtureEvent();
      await expect(storage.appendEvents(ev.subscriptionId, [ev])).rejects.toThrow(
        /appendEvents: unknown subscriptionId/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("appendEvents rejects when the subscriber has no subscription for the event's task", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub(); // owns task ...00A only
      await storage.saveSubscription(sub);
      const foreign = fixtureEvent({
        subscriptionId: sub.subscriberId,
        taskId: "01JBZ00000000000000000000B" as ULID,
      });

      // DELIBERATE DEVIATION from the in-memory subscriber-level check: the file log is
      // partitioned by (subscriberId, taskId), so an event for a pair with no Subscription would
      // be undiscoverable by loadEvents. Reject explicitly rather than silently drop it.
      await expect(storage.appendEvents(sub.subscriberId, [foreign])).rejects.toThrow(
        /no subscription for/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("appendEvents with an empty events array is a no-op", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      await storage.appendEvents(sub.subscriberId, []);
      expect(await collect(storage.loadEvents(sub.subscriberId))).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadEvents throws on a corrupt event-log line (never a partial silent read)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      await mkdir(join(base, "events"), { recursive: true });
      await writeFile(
        join(base, "events", sub.subscriberId + "-" + sub.taskId + ".jsonl"),
        JSON.stringify(fixtureEvent()) + "\n{\"eventId\": \"broken\n",
        "utf8",
      );

      await expect(collect(storage.loadEvents(sub.subscriberId))).rejects.toThrow(
        /corrupt event JSON/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: explicit errors, not silent reads", () => {
  test("loadTask throws on a corrupt record file (a real serialized record truncated by a crash)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const record = fixtureTask();
      // Real sample: serialize a valid ADR-0022 record, then truncate it mid-object — the
      // half-written shape a crash without atomic rename would leave behind.
      const serialized = JSON.stringify(record);
      const truncated = serialized.slice(0, Math.floor(serialized.length / 2));
      await mkdir(join(base, "tasks"), { recursive: true });
      await writeFile(join(base, "tasks", record.id + ".json"), truncated, "utf8");

      // Counterfactual: an implementation that returned null on parse failure would satisfy a
      // toBeNull assertion but silently lose the task; assert the descriptive throw instead.
      await expect(storage.loadTask(record.id)).rejects.toThrow(/corrupt JSON/);
      await expect(storage.loadTask(record.id)).rejects.toThrow(/tasks/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("loadTask propagates a non-ENOENT IO failure instead of reporting null (injected facade)", async () => {
    const base = await makeBase();
    try {
      const failing: TaskStorageFs = {
        ...realFs(),
        readFile: async () => {
          const error = new Error("EACCES: permission denied, open tasks/x.json");
          (error as NodeJS.ErrnoException).code = "EACCES";
          throw error;
        },
      };
      const storage = new FileTaskStorage(base, { fs: failing });

      // Counterfactual: the only tolerated read error is ENOENT. If the adapter caught all
      // errors and returned null, this would resolve and the test would fail.
      await expect(storage.loadTask(fixtureTask().id)).rejects.toThrow(/EACCES/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveTask surfaces a real ENOTDIR IO failure (no injection)", async () => {
    const base = await makeBase();
    try {
      // A file where the tasks/ directory must go makes mkdir fail with ENOTDIR.
      await writeFile(join(base, "tasks"), "not a directory", "utf8");
      const storage = new FileTaskStorage(base);

      // The OS rejects the recursive mkdir over a file with EEXIST (or ENOTDIR on deeper
      // paths); either way the write must reject, not silently succeed.
      await expect(storage.saveTask(fixtureTask())).rejects.toThrow(
        /EEXIST|ENOTDIR|not a directory/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("appendEvents surfaces an injected write failure (no silent drop)", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      const sub = fixtureSub();
      await storage.saveSubscription(sub);
      const failing: TaskStorageFs = {
        ...realFs(),
        appendFile: async () => {
          throw new Error("ENOSPC: no space left on device");
        },
      };
      const broken = new FileTaskStorage(base, { fs: failing });

      await expect(broken.appendEvents(sub.subscriberId, [fixtureEvent()])).rejects.toThrow(
        /ENOSPC/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: append ownership check is O(1) (no per-append subscription scan)", () => {
  test("one append reads exactly one ownership file, not all N subscriptions", async () => {
    const base = await makeBase();
    try {
      const subscriberId = "01JBZ00000000000000000010S" as ULID;
      const taskIds: ULID[] = [];
      // Seed 50 real subscription files through the adapter, all owned by one run-level
      // subscriber (one per task). This is the production shape the O(N^2) concern is about.
      const seeder = new FileTaskStorage(base);
      for (let index = 0; index < 50; index += 1) {
        const taskId = ("01JBZ".padEnd(23, "0") + String(index).padStart(3, "0")) as ULID;
        taskIds.push(taskId);
        await seeder.saveSubscription({
          subscriberId,
          taskId,
          cursor: "01JBZ00000000000000000020C" as ULID,
          status: "active",
          createdAt: 1_700_000_000_500,
        });
      }
      let readFileCalls = 0;
      const counting: TaskStorageFs = {
        ...realFs(),
        readFile: (path, options) => {
          readFileCalls += 1;
          return readFile(path, options);
        },
      };
      const storage = new FileTaskStorage(base, { fs: counting });

      readFileCalls = 0;
      await storage.appendEvents(subscriberId, [
        fixtureEvent({
          eventId: "01JBZ00000000000000000009E" as ULID,
          subscriptionId: subscriberId,
          taskId: taskIds[0] as ULID,
        }),
      ]);

      // SPECIFICATION: the ownership check for one append is one direct read of
      // subscriptions/<subscriberId>-<taskId>.json. Counterfactual: an implementation that
      // scanned subscriptions/ (the pre-fix shape) would read all 50 files and fail this.
      expect(readFileCalls).toBe(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: atomic writes (constraint #1 + issue #65 requirement 3)", () => {
  test("saveTask writes a temp file then renames it onto the target", async () => {
    const base = await makeBase();
    try {
      const renames: { from: string; to: string }[] = [];
      const recording: TaskStorageFs = {
        ...realFs(),
        rename: async (from, to) => {
          renames.push({ from, to });
          await rename(from, to);
        },
      };
      const storage = new FileTaskStorage(base, { fs: recording });
      const record = fixtureTask();
      await storage.saveTask(record);

      const target = join(base, "tasks", record.id + ".json");
      // SPECIFICATION: issue #65 "write to a temp path then rename". Counterfactual: a
      // direct-write implementation would record zero renames and fail this.
      expect(renames.map((r) => r.to)).toEqual([target]);
      expect(renames[0]?.from).not.toBe(target);
      expect(renames[0]?.from.startsWith(target)).toBe(true);
      // No temp file is left behind after a successful rename.
      const leftovers = (await readdir(join(base, "tasks"))).filter((n) => n.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a failed rename rejects and leaves NO half-written record", async () => {
    const base = await makeBase();
    try {
      const failing: TaskStorageFs = {
        ...realFs(),
        rename: async () => {
          throw new Error("ENOSPC: rename failed before any fsync");
        },
      };
      const storage = new FileTaskStorage(base, { fs: failing });
      const record = fixtureTask();

      await expect(storage.saveTask(record)).rejects.toThrow(/ENOSPC/);
      // Counterfactual: an implementation that wrote straight to the target before failing
      // would leave a record here; atomicity demands the target never appears.
      expect(existsSync(join(base, "tasks", record.id + ".json"))).toBe(false);
      expect(await storage.loadTask(record.id)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("saveTask creates parent directories on demand under a fresh base", async () => {
    const base = await makeBase();
    try {
      const storage = new FileTaskStorage(base);
      // The base has no tasks/ dir yet; writeFile to the temp path is only possible after mkdir.
      const record = fixtureTask();
      await storage.saveTask(record);
      expect(existsSync(join(base, "tasks", record.id + ".json"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("FileTaskStorage: constructor contract", () => {
  test("empty baseDir is rejected", () => {
    expect(() => new FileTaskStorage("")).toThrow(/baseDir is required/);
  });
});
