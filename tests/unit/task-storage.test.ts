/**
 * Tests for the TaskStorage interface + InMemoryTaskStorage adapter (BG-01 ticket).
 *
 * These are SPECIFICATION tests, not characterization — see docs/testing-constraints.md
 * constraint #6 ("防错误 ≠ 防回归"). Each fixture below is a literal copy of the corresponding
 * section of ADR-0022 (cited inline); we do not derive fixtures from the implementation, and
 * we do not use `toMatchSnapshot`. The "obvious-broken" counterfactual (constraint #5) is the
 * `describe("counterfactual")` block at the bottom: if `InMemoryTaskStorage` were rewritten
 * to always return `null` / throw on save, those tests must fail.
 *
 * Coverage map (8 methods × IO success + IO failure = 16 paths minimum):
 *
 *   TaskStorage interface (8 methods, BG-01 brief):
 *     loadTask        — happy: present record; error: unknown id → null (not a throw).
 *     saveTask        — happy: insert then re-load; error: missing record → assert throws.
 *     deleteTask      — happy: insert+delete; error: unknown id → assert throws.
 *     listTasks       — happy: all + filter-by-status + filter-by-label + filter combined.
 *                       error: AsyncIterable is iterable (no error path; verified structurally).
 *     loadSubscription — happy: present sub; error: unknown sub-key → null.
 *     saveSubscription — happy: insert then re-load; error: missing sub → assert throws.
 *     appendEvents    — happy: append N then load back; error: unknown subscriptionId → throws.
 *     loadEvents      — happy: since cursor; since undefined → all; error: unknown sub → throws.
 *
 *   Plus the counterfactual block (constraint #5) and a few structural checks for the type
 *   brand, so a regression that loosens the ULID brand is caught.
 */

import { describe, expect, test } from "vitest";
import {
  InMemoryTaskStorage,
  type Subscription,
  type TaskEvent,
  type TaskRecord,
  type TaskStorage,
  type ULID,
} from "../../src/runtime/task-storage.ts";

// --- Test fixtures (copy-pasted from ADR-0022 §3 + §5 + §7) -------------------------------

/**
 * Minimal TaskRecord: the 19 fields of ADR-0022 §3, every one present even when
 * the value is empty / zero, so the round-trip assertion (`expect(loaded).toEqual(record)`)
 * catches accidental field drops. (19 §3 fields + the 2 ADR-0023 owner fields = 21 in the
 * interface; this fixture does not set the owner ones.) The labels / ULIDs are recognisable
 * monospaced strings; tests never compute them from the implementation.
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

/** Fixture for Subscription (ADR-0022 §5). */
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

/**
 * Fixture for a TaskEvent (ADR-0022 §2 + §8 emit-key pattern). The `type` field is a literal
 * copy of the §2 emit-key column: `task:<id>:running`, `task:<id>:->canceled`, etc. We do
 * NOT derive it via ``task:${record.id}:running`` in the test — that would couple the test
 * to the implementation's id format and miss regressions where the format silently changes.
 */
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

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

// --- Tests -----------------------------------------------------------------------------------

describe("InMemoryTaskStorage: task CRUD (loadTask / saveTask / deleteTask)", () => {
  test("saveTask + loadTask round-trip preserves every field of the 19-field ADR-0022 §3 schema", async () => {
    const storage: TaskStorage = new InMemoryTaskStorage();
    const record = fixtureTask();
    await storage.saveTask(record);

    const loaded = await storage.loadTask(record.id);
    // SPECIFICATION (constraint #4 + #6): exact field-for-field equality — this is the ADR-0022
    // schema, not an implementation-derived shape. A bug that drops `outputRef` or
    // `spawnSource.callerId` from the persisted shape is caught here.
    expect(loaded).toEqual(record);
  });

  test("saveTask + loadTask round-trip preserves the ADR-0023 owner fields when present", async () => {
    const storage: TaskStorage = new InMemoryTaskStorage();
    // The ADR-0023 ownership fields on top of the ADR-0022 schema; values are literals from the
    // ownership model (pid + runtime-start bootMs).
    const record = fixtureTask({ ownerPid: 7_001, ownerBootMs: 100_000 });
    await storage.saveTask(record);

    expect(await storage.loadTask(record.id)).toEqual(record);
  });

  /**
   * ADR-0032: a background child's report is part of the record, so it is persisted with the
   * same discipline as every other field — deep equality, not a shallow field check. The fixture
   * is the same literal report shape `dispatch-child-report.test.ts` drives the pump with, so a
   * drop of `files_touched` or a flattened `findings` is caught here.
   */
  test("saveTask + loadTask round-trip preserves a persisted child report (ADR-0032)", async () => {
    const storage: TaskStorage = new InMemoryTaskStorage();
    const record = fixtureTask({
      status: "succeeded",
      report: {
        summary: "the concurrency gate precedes agent discovery",
        findings: [
          { what: "the gate runs first", evidence: "slot acquire returns before discoverAgent" },
        ],
        files_touched: ["src/runtime/dispatch.ts"],
        usage: { input: 900, output: 260, cost: 0.0123, turns: 1 },
      },
      reportChannel: "prompt-json",
    });
    await storage.saveTask(record);

    const loaded = await storage.loadTask(record.id);
    expect(loaded).toEqual(record);
    // The storage clone must not alias the caller's object: a later mutation of the report the
    // caller still holds must not rewrite what was persisted.
    (record.report as { summary: string }).summary = "mutated after save";
    const reread = await storage.loadTask(record.id);
    expect(reread?.report?.summary).toBe("the concurrency gate precedes agent discovery");
  });

  test("a record whose child never reported persists with both report fields absent", async () => {
    const storage: TaskStorage = new InMemoryTaskStorage();
    await storage.saveTask(fixtureTask({ status: "running" }));

    const loaded = await storage.loadTask("01JBZ00000000000000000000A" as ULID);
    // "Not yet" and "reported nothing" are different claims, so the absent form is asserted as
    // ABSENT — `toBeUndefined()` would also pass for `{report: undefined}`.
    expect(Object.hasOwn(loaded as object, "report")).toBe(false);
    expect(Object.hasOwn(loaded as object, "reportChannel")).toBe(false);
  });

  test("a legacy record without owner fields round-trips with the fields absent", async () => {
    const storage: TaskStorage = new InMemoryTaskStorage();
    const record = fixtureTask();
    await storage.saveTask(record);

    const loaded = await storage.loadTask(record.id);
    expect(loaded?.ownerPid).toBeUndefined();
    expect(loaded?.ownerBootMs).toBeUndefined();
  });

  test("loadTask returns null for an unknown id (not a throw)", async () => {
    const storage = new InMemoryTaskStorage();
    // SPECIFICATION (constraint #1 IO-failure path): load miss is `null`, not `throw`. This
    // matters because the TaskRegistry calls loadTask on every event delivery to hydrate the
    // notification payload; a throw would crash the registry.
    expect(await storage.loadTask("01JBZ000000000000000ZZZZZZ" as ULID)).toBeNull();
  });

  test("saveTask twice replaces (insert-or-replace semantics) and preserves the second write", async () => {
    const storage = new InMemoryTaskStorage();
    const first = fixtureTask({ status: "running" });
    const second = fixtureTask({ status: "succeeded", finishedAt: 1_700_000_005_000 });
    await storage.saveTask(first);
    await storage.saveTask(second);

    expect(await storage.loadTask(first.id)).toEqual(second);
  });

  test("saveTask rejects on a nullish record (no silent swallow — constraint #3)", async () => {
    const storage = new InMemoryTaskStorage();
    // `null as unknown as TaskRecord` exercises the assert that catches a programmer error
    // (e.g. `saveTask(undefined)`). Without it, the storage would silently insert a malformed
    // row and a later `loadTask` would return `null` for the spurious id.
    await expect(storage.saveTask(null as unknown as TaskRecord)).rejects.toThrow(
      /saveTask: record is required/,
    );
  });

  test("deleteTask removes a known record; subsequent loadTask returns null", async () => {
    const storage = new InMemoryTaskStorage();
    const record = fixtureTask();
    await storage.saveTask(record);

    await storage.deleteTask(record.id);
    expect(await storage.loadTask(record.id)).toBeNull();
  });

  test("deleteTask rejects for an unknown id (constraint #3 — no silent swallow)", async () => {
    const storage = new InMemoryTaskStorage();
    // SPECIFICATION (constraint #1 IO-failure path): a delete miss is a programmer error
    // (the TaskRegistry is the only caller, and it always checks loadTask first). Throwing
    // surfaces the bug; silently succeeding would let the registry "delete" tasks it never owned.
    await expect(storage.deleteTask("01JBZ000000000000000DELETEME" as ULID)).rejects.toThrow(
      /deleteTask: unknown taskId/,
    );
  });

  test("saveTask deep-clones on insert: caller-side mutation does not poison storage", async () => {
    const storage = new InMemoryTaskStorage();
    const record = fixtureTask();
    await storage.saveTask(record);

    // Mutate the caller's reference after save. If storage kept the same object, the mutation
    // would leak through `loadTask`. We require deep-clone on insert — see the implementation
    // header comment "Deep-clone on insert so a later mutation of the caller's reference does
    // not poison storage state."
    record.label = "MUTATED";
    record.outputBytes = 99999;

    const loaded = await storage.loadTask(record.id);
    expect(loaded?.label).toBe("research X");
    expect(loaded?.outputBytes).toBeUndefined();
  });
});

describe("InMemoryTaskStorage: listTasks(filter)", () => {
  test("without filter, yields every saved record in insertion order", async () => {
    const storage = new InMemoryTaskStorage();
    const a = fixtureTask({ id: "01JBZ00000000000000000001A" as ULID, label: "alpha" });
    const b = fixtureTask({ id: "01JBZ00000000000000000002B" as ULID, label: "beta" });
    const c = fixtureTask({ id: "01JBZ00000000000000000003C" as ULID, label: "gamma" });
    await storage.saveTask(a);
    await storage.saveTask(b);
    await storage.saveTask(c);

    const got = await collect(storage.listTasks());
    // SPECIFICATION: insertion order is part of the Map-backed public contract (constraint #4:
    // "可执行验收样例" — the implementation header pins stable insertion-order iteration).
    expect(got.map((r) => r.id)).toEqual([a.id, b.id, c.id]);
  });

  test("filter by status narrows the result to records matching exactly that status", async () => {
    const storage = new InMemoryTaskStorage();
    const running = fixtureTask({ id: "01JBZ00000000000000000001A" as ULID, status: "running" });
    const succeeded = fixtureTask({
      id: "01JBZ00000000000000000002B" as ULID,
      status: "succeeded",
    });
    const failed = fixtureTask({ id: "01JBZ00000000000000000003C" as ULID, status: "failed" });
    await storage.saveTask(running);
    await storage.saveTask(succeeded);
    await storage.saveTask(failed);

    const got = await collect(storage.listTasks({ status: "succeeded" }));
    // SPECIFICATION: filter is exact-match (not "contains" / prefix). The label/scan test below
    // relies on this — a regression that switched to substring match would let `{label:"a"}`
    // accidentally match `alpha` AND `gamma`.
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe(succeeded.id);
  });

  test("filter by label is exact-match (no substring / prefix)", async () => {
    const storage = new InMemoryTaskStorage();
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
  });

  test("filter combining status + label applies both (AND, not OR)", async () => {
    const storage = new InMemoryTaskStorage();
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
  });

  test("listTasks yields an empty async iterable when nothing matches (no throw)", async () => {
    const storage = new InMemoryTaskStorage();
    await storage.saveTask(fixtureTask({ status: "running" }));
    // Constraint #1 IO success path: empty-result must be a normal completion, not a throw.
    const got = await collect(storage.listTasks({ status: "lost" }));
    expect(got).toEqual([]);
  });
});

describe("InMemoryTaskStorage: subscription CRUD (loadSubscription / saveSubscription)", () => {
  test("saveSubscription + loadSubscription round-trip preserves every field", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    const loaded = await storage.loadSubscription(sub.subscriberId, sub.taskId);
    // SPECIFICATION: every field on the Subscription shape (ADR-0022 §5) is preserved.
    expect(loaded).toEqual(sub);
  });

  test("loadSubscription returns null for an unknown (subscriberId, taskId) pair", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    // Same taskId, different subscriberId → null (the storage key is the pair, not just taskId).
    expect(
      await storage.loadSubscription("01JBZ000000000000000OTHER1" as ULID, sub.taskId),
    ).toBeNull();
    // Same subscriberId, different taskId → null.
    expect(
      await storage.loadSubscription(sub.subscriberId, "01JBZ000000000000000OTH2R" as ULID),
    ).toBeNull();
  });

  test("saveSubscription rejects on a nullish sub (constraint #3)", async () => {
    const storage = new InMemoryTaskStorage();
    await expect(storage.saveSubscription(null as unknown as Subscription)).rejects.toThrow(
      /saveSubscription: sub is required/,
    );
  });

  test("saveSubscription on the same (subscriberId, taskId) replaces the prior row", async () => {
    const storage = new InMemoryTaskStorage();
    const sub1 = fixtureSub({ cursor: "01JBZ00000000000000000020C" as ULID });
    const sub2 = fixtureSub({ cursor: "01JBZ00000000000000000099N" as ULID, status: "closed" });
    await storage.saveSubscription(sub1);
    await storage.saveSubscription(sub2);

    expect(await storage.loadSubscription(sub1.subscriberId, sub1.taskId)).toEqual(sub2);
  });
});

describe("InMemoryTaskStorage: appendEvents / loadEvents", () => {
  test("appendEvents + loadEvents yields every appended event in eventId order", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    // Three events with monotonic ULIDs; transitionAtMs mirrors transitionAt on the TaskRecord
    // (the implementation does not check, but the contract is documented).
    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({
      eventId: "01JBZ00000000000000000002E" as ULID,
      status: "stopping",
      type: "task:01JBZ00000000000000000000A:stopping",
      transitionAtMs: 1_700_000_002_000,
    });
    const e3 = fixtureEvent({
      eventId: "01JBZ00000000000000000003E" as ULID,
      status: "canceled",
      type: "task:01JBZ00000000000000000000A:->canceled",
      transitionAtMs: 1_700_000_003_000,
    });
    await storage.appendEvents(sub.subscriberId, [e3, e1, e2]); // intentionally out of order

    const got = await collect(storage.loadEvents(sub.subscriberId));
    // SPECIFICATION: order is by eventId ascending — ULIDs sort lexically the same as
    // chronologically when generated correctly (constraint #4 + #5). The input order is
    // shuffled above so a regression that preserved insertion order would fail this.
    expect(got.map((e) => e.eventId)).toEqual([e1.eventId, e2.eventId, e3.eventId]);
  });

  test("loadEvents(since) yields strictly-newer events than the cursor", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });
    await storage.appendEvents(sub.subscriberId, [e1, e2, e3]);

    // `since` semantics per ADR-0022 §5: the cursor advances past the delivered event. An event
    // whose eventId === since has already been delivered, so it is excluded.
    const sinceE1 = await collect(storage.loadEvents(sub.subscriberId, e1.eventId));
    expect(sinceE1.map((e) => e.eventId)).toEqual([e2.eventId, e3.eventId]);

    const sinceE2 = await collect(storage.loadEvents(sub.subscriberId, e2.eventId));
    expect(sinceE2.map((e) => e.eventId)).toEqual([e3.eventId]);
  });

  test("loadEvents with since=undefined yields the full log", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    await storage.appendEvents(sub.subscriberId, [e1, e2]);

    const got = await collect(storage.loadEvents(sub.subscriberId));
    expect(got.map((e) => e.eventId)).toEqual([e1.eventId, e2.eventId]);
  });

  test("loadEvents on an unknown subscriptionId rejects (constraint #3)", async () => {
    const storage = new InMemoryTaskStorage();
    // SPECIFICATION (constraint #1 IO-failure path): the subscriptionId must exist; otherwise
    // the registry would silently receive zero events from a typo'd id and never notify the model.
    await expect(async () => {
      for await (const _ of storage.loadEvents("01JBZ000000000000000NOSUB1" as ULID)) {
        // drain — we want the rejection, not the loop body
        void _;
      }
    }).rejects.toThrow(/loadEvents: unknown subscriptionId/);
  });

  test("appendEvents rejects for an unknown subscriptionId (constraint #3)", async () => {
    const storage = new InMemoryTaskStorage();
    const ev = fixtureEvent();
    // SPECIFICATION (constraint #1 IO-failure path): a write to a non-existent subscription is
    // a programmer error; silently appending to a phantom log would let the registry write
    // events no one will ever read.
    await expect(storage.appendEvents(ev.subscriptionId, [ev])).rejects.toThrow(
      /appendEvents: unknown subscriptionId/,
    );
  });

  test("appendEvents with an empty events array is a no-op (no throw, no phantom entry)", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);
    await storage.appendEvents(sub.subscriberId, []);
    expect(await collect(storage.loadEvents(sub.subscriberId))).toEqual([]);
  });

  test("appendEvents deep-clones: caller-side mutation does not leak into the log", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);

    const ev = fixtureEvent({ outputPreview: "preview-v1" });
    await storage.appendEvents(sub.subscriberId, [ev]);

    // Mutate after append; the persisted copy must still hold "preview-v1".
    ev.outputPreview = "MUTATED";
    const got = await collect(storage.loadEvents(sub.subscriberId));
    expect(got[0]?.outputPreview).toBe("preview-v1");
  });
});

describe("InMemoryTaskStorage: append fast path vs slow path (differential oracle, constraint #5)", () => {
  /**
   * The production append is monotonic: each call carries an already-ordered batch whose first
   * eventId continues the log's tail. The old shape re-copied and re-sorted the whole log on
   * every append (O(N^2)); the new one appends in place and binary-searches on load. This
   * differential oracle pins that the fast path and the still-supported out-of-order slow path
   * agree on the exact eventId order the TaskStorage doc promises.
   */
  test("monotonic per-event appends equal one shuffled batch (fast path == slow path)", async () => {
    const monotonic = new InMemoryTaskStorage();
    const shuffled = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await monotonic.saveSubscription(sub);
    await shuffled.saveSubscription(sub);
    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });
    const e4 = fixtureEvent({ eventId: "01JBZ00000000000000000004E" as ULID });

    // Fast path: four continuing single-event appends (ordered, tail continues).
    await monotonic.appendEvents(sub.subscriberId, [e1]);
    await monotonic.appendEvents(sub.subscriberId, [e2]);
    await monotonic.appendEvents(sub.subscriberId, [e3]);
    await monotonic.appendEvents(sub.subscriberId, [e4]);
    // Slow path: one batch with the same events shuffled; the adapter must sort it.
    await shuffled.appendEvents(sub.subscriberId, [e3, e1, e4, e2]);

    const fast = (await collect(monotonic.loadEvents(sub.subscriberId))).map((e) => e.eventId);
    const slow = (await collect(shuffled.loadEvents(sub.subscriberId))).map((e) => e.eventId);
    // Independent oracle: eventIds sort lexically (TaskStorage.appendEvents doc). Counterfactual:
    // a fast path that skipped a needed sort, or a merge that dropped/duplicated an event, diverges.
    expect(fast).toEqual([e1.eventId, e2.eventId, e3.eventId, e4.eventId]);
    expect(slow).toEqual(fast);
  });

  test("first append of an unordered batch sorts before storing", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);
    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });

    await storage.appendEvents(sub.subscriberId, [e2, e3, e1]);

    // SPECIFICATION: the interface stores events in eventId order. Counterfactual: skipping the
    // sort whenever the log is empty would yield [e2, e3, e1].
    expect((await collect(storage.loadEvents(sub.subscriberId))).map((e) => e.eventId)).toEqual([
      e1.eventId,
      e2.eventId,
      e3.eventId,
    ]);
  });

  test("subscriber-level ownership: a second task's subscription still accepts the append", async () => {
    const storage = new InMemoryTaskStorage();
    const subscriberId = "01JBZ00000000000000000010S" as ULID;
    const taskA = "01JBZ00000000000000000000A" as ULID;
    const taskB = "01JBZ00000000000000000000B" as ULID;
    // Only taskA is subscribed. The in-memory check is subscriber-level (ADR-0022 §5 "Subscriber
    // == owner"), so an event for taskB must still be accepted. This pins the O(1) subscriber
    // index that replaced the old full-scan check: a regression that keyed on one task fails.
    await storage.saveSubscription({
      subscriberId,
      taskId: taskA,
      cursor: "01JBZ00000000000000000020C" as ULID,
      status: "active",
      createdAt: 1_700_000_000_500,
    });
    const eB = fixtureEvent({
      eventId: "01JBZ00000000000000000002E" as ULID,
      subscriptionId: subscriberId,
      taskId: taskB,
    });

    await expect(storage.appendEvents(subscriberId, [eB])).resolves.toBeUndefined();
    expect((await collect(storage.loadEvents(subscriberId))).map((e) => e.eventId)).toEqual([
      eB.eventId,
    ]);
  });

  test("a later out-of-order batch is merged to keep the log in eventId order", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);
    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });

    await storage.appendEvents(sub.subscriberId, [e3]);
    await storage.appendEvents(sub.subscriberId, [e1, e2]);

    // Interface contract: events are stored in eventId order. The binary-search loadEvents
    // depends on that invariant, so the merge branch must restore it. Counterfactual: the old
    // append-batch-only shape would leave [e3, e1, e2] and fail this.
    expect((await collect(storage.loadEvents(sub.subscriberId))).map((e) => e.eventId)).toEqual([
      e1.eventId,
      e2.eventId,
      e3.eventId,
    ]);
  });

  test("loadEvents(since) binary-search boundaries: before-first, gap, between, after-last", async () => {
    const storage = new InMemoryTaskStorage();
    const sub = fixtureSub();
    await storage.saveSubscription(sub);
    const e1 = fixtureEvent({ eventId: "01JBZ00000000000000000001E" as ULID });
    const e2 = fixtureEvent({ eventId: "01JBZ00000000000000000002E" as ULID });
    const e3 = fixtureEvent({ eventId: "01JBZ00000000000000000003E" as ULID });
    await storage.appendEvents(sub.subscriberId, [e1, e2, e3]);

    // gap cursor: strictly greater than e1, strictly less than e2.
    expect(
      (await collect(storage.loadEvents(sub.subscriberId, "00000000000000000000" as ULID))).map(
        (e) => e.eventId,
      ),
    ).toEqual([e1.eventId, e2.eventId, e3.eventId]);
    expect(
      (
        await collect(storage.loadEvents(sub.subscriberId, "01JBZ00000000000000000001F" as ULID))
      ).map((e) => e.eventId),
    ).toEqual([e2.eventId, e3.eventId]);
    expect(
      (await collect(storage.loadEvents(sub.subscriberId, e2.eventId))).map((e) => e.eventId),
    ).toEqual([e3.eventId]);
    expect(
      (await collect(storage.loadEvents(sub.subscriberId, e3.eventId))).map((e) => e.eventId),
    ).toEqual([]);
  });
});

describe("InMemoryTaskStorage: structural type-shape checks", () => {
  test("ULID is a string-typed brand at runtime (no ULID constructor — constraint #2 fixture)", () => {
    // The brand is compile-time-only; at runtime a ULID is just a string. Pin this so a future
    // refactor that introduces a ULID class does not silently change the wire format.
    const id: ULID = "01JBZ00000000000000000000A" as ULID;
    expect(typeof id).toBe("string");
    expect(id.length).toBe(26);
  });

  test("TaskRecord carries all 19 ADR-0022 §3 fields at the type level", () => {
    // Compile-time check: this fixture would not typecheck if any of the 19 §3 fields was missing
    // from the TaskRecord interface. Each field is named in the assertion message so a future
    // reader can map the test to the ADR line. (The two ADR-0023 owner fields are optional and
    // deliberately NOT pinned here; they are covered by the owner-identity tests.)
    const requiredFields = {
      id: "ulid" as const,
      label: "string" as const,
      agentName: "string" as const,
      depth: 0 as number,
      status: "running" as const,
      createdAt: 0 as number,
      startedAt: 0 as number,
      finishedAt: undefined as number | undefined,
      durationMs: undefined as number | undefined,
      transitionAt: 0 as number,
      outputRef: undefined as string | undefined,
      outputBytes: undefined as number | undefined,
      outputPreview: undefined as string | undefined,
      stopReason: undefined as string | undefined,
      errorMessage: undefined as string | undefined,
      exitCode: undefined as number | undefined,
      spawnSource: { kind: "ptc-program" as const, callerId: "x" },
      parentTaskId: undefined as ULID | undefined,
      sessionFile: undefined as string | undefined,
    };
    const r: TaskRecord = {
      ...requiredFields,
      id: "01JBZ00000000000000000000A" as ULID,
      label: "x",
      agentName: "x",
      status: "running",
      createdAt: 0,
      startedAt: 0,
      transitionAt: 0,
    };
    // 19 interface fields: id, label, agentName, depth, status, createdAt, startedAt,
    // finishedAt, durationMs, transitionAt, outputRef, outputBytes, outputPreview,
    // stopReason, errorMessage, exitCode, spawnSource, parentTaskId, sessionFile.
    // Counting KEYS in the object graph instead gives 21, because `spawnSource` contributes 2 of
    // its own. That is the same total as the 21 TaskRecord fields (19 §3 + 2 ADR-0023 owner), but
    // reached a different way: the two extra keys come from the nested spawnSource object, not
    // from the owner fields, which are absent here. Hence the two counts are asserted separately.
    expect(Object.keys(r).length).toBe(19);
    expect(Object.keys(r.spawnSource).length).toBe(2);
  });
});

// NOTE (review 2 finding B5): a "counterfactual (constraint #5)" block used to live here. It
// built an obviously-broken TaskStorage *stub* and then asserted the stub's own behaviour, so
// replacing the production adapter with a wrong one left it green — it exercised nothing the
// package ships. The constraint-#5 obligation is discharged by the real failure-path tests
// above, which drive the PRODUCTION adapter and assert it rejects:
//   - deleteTask on an unknown id throws (`deleteTask: unknown taskId`),
//   - loadEvents / appendEvents on an unknown subscriptionId throw.
// A no-op or silently-succeeding implementation turns those red, which is the counterfactual
// this file needs.
