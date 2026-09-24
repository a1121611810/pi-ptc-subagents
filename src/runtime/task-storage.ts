/**
 * TaskStorage: the persistence seam for background-dispatch task records (ADR-0022 §3 + §5 + §7).
 *
 * This module owns the *types* the TaskRegistry and the model-facing `ptc_task_*` tools read
 * (TaskRecord, TaskStatus, Subscription, TaskEvent, TaskFilter) and the *interface* TaskStorage
 * they read them through. Two adapters satisfy the interface: `InMemoryTaskStorage` (this file,
 * process-local) and `FileTaskStorage` (`./task-storage-file.ts`, the durable session backend
 * under `<sessionDir>/tasks/<id>.json` + `<sessionDir>/subscriptions/<subscriberId>-<taskId>.json`
 * + `<sessionDir>/events/<subscriberId>-<taskId>.jsonl`; see ADR-0022 and its BG-13 note).
 *
 * Design notes:
 *
 * - **Spec source of truth** for TaskRecord's 21 fields is ADR-0022 §3 (Decision §3); for
 *   Subscription it is §5. The field set is locked at the interface — adapters may add private
 *   indexing, but the persisted shape is exactly the schema in the ADR. This is what makes
 *   `tests/unit/task-storage.test.ts` a SPECIFICATION test (constraint #4 + #6 in
 *   `docs/testing-constraints.md`): the test fixtures are copy-pasted from the ADR, not
 *   derived from this file.
 *
 * - **ULID brand** — `type ULID = string & { __brand: "ULID" }` is owned by `ulid.ts`
 *   (WS-ULID / R-M2) and re-exported here. It is a compile-time-only distinction: runtime
 *   strings flow freely into the brand (no `new ULID(...)` constructor); the brand just keeps
 *   us honest at the type level when a plain `string` would otherwise hide a wrong-shape param
 *   (e.g. a taskId slipped into a cursor slot).
 *
 * - **`AsyncIterable` over arrays** for `listTasks(filter)` and `loadEvents(subscriptionId, since?)`
 *   is a deliberate seam. The interface lets future adapters stream results from disk without
 *   materialising the full list in memory; the InMemory adapter simply yields from an array.
 *   Callers use `for await (const x of storage.listTasks(...))`. This is the same shape pi's own
 *   extension API uses (`pi.getEntries()` is `AsyncIterable`).
 *
 * - **Filter shape**: `TaskFilter` carries only the indexable dimensions a future file-based
 *   adapter would scan cheaply (`status`, `label`). Compound predicates (label matches prefix,
 *   `transitionAt >= X`) belong on the TaskRegistry, not the storage layer.
 *
 * - **No IO error injection in this adapter**: `InMemoryTaskStorage` cannot fail by construction
 *   (Map operations do not throw on missing keys; we return `null` for load misses and throw on
 *   save/delete of a non-existent taskId so the test for IO-failure paths exercises the same
 *   error surface a real backend would surface). The failure-path test for the adapter asserts
 *   `deleteTask` and `saveTask(missing-id)` reject; happy paths are direct returns.
 */

import { ok as assertPresent } from "node:assert/strict";

import type { ULID } from "./ulid.ts";

/**
 * Lexically-sortable identifier (26-char Crockford base32). Re-exported from `ulid.ts`
 * (WS-ULID / R-M2), the single source of truth, so every existing
 * `import type { ULID } from "./task-storage.ts"` keeps compiling. The dependency is one-way:
 * `ulid.ts` must never import this file.
 */
export type { ULID };

/**
 * The 6-state TaskRecord status (ADR-0022 §2). `queued` is deliberately absent in v1
 * (spawn-or-reject, no in-task queue; cap=8 rejects above the limit immediately).
 */
export type TaskStatus = "running" | "stopping" | "succeeded" | "failed" | "canceled" | "lost";

/** Origin of the spawn — `ptc-program` from a PTC run, `ptc-batch` from a future batch entry. */
export interface TaskSpawnSource {
  kind: "ptc-program" | "ptc-batch";
  /** Caller id (PTC run id for `ptc-program`; batch id for `ptc-batch`). */
  callerId: string;
}

/**
 * Session-level row tracking the lifecycle of one background child. 21 fields, exact shape from
 * ADR-0022 §3. Optional fields are absent on records still `running` (e.g. `finishedAt` /
 * `exitCode` / `outputRef` are written at transition time, not at spawn).
 */
export interface TaskRecord {
  id: ULID;
  label: string;
  agentName: string;
  /** 0 = parent's direct, 1 = grandchild, etc. (ADR-0016 recursive section). */
  depth: number;
  status: TaskStatus;
  /** ms epoch. */
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** Last state transition ms epoch; used for cursor ordering of events. */
  transitionAt: number;
  /** `<sessionDir>/tasks/<id>/output.log` once the child has flushed any output. */
  outputRef?: string;
  outputBytes?: number;
  /** ≤ 2 KB inline preview (Map+preview, ADR-0022 §3). */
  outputPreview?: string;
  stopReason?: string;
  errorMessage?: string;
  exitCode?: number;
  spawnSource: TaskSpawnSource;
  parentTaskId?: ULID;
  /** `<sessionDir>/tasks/<id>.pi-*` session file (R1). */
  sessionFile?: string;
}

/**
 * Per-subscriber cursor for one TaskRecord (ADR-0022 §5). Cursor is per-subscriber (not per-task)
 * because fork semantics differ from single-session semantics: a forked branch observes events
 * from `max(parent, child)` cursor onwards, not from task creation.
 */
export interface Subscription {
  subscriberId: ULID;
  taskId: ULID;
  /** Monotonic ULID; advances on every event delivered. */
  cursor: ULID;
  status: "active" | "closed";
  /** ms epoch. */
  createdAt: number;
}

/**
 * Append-only event in a subscription buffer. The `eventId` IS the cursor: monotonic ULID, the
 * `loadEvents(since)` filter slices `[strictly-after since, ...]`. Schema fields beyond the
 * cursor carry enough state for the renderer to emit `<bg-task-notification>` (ADR-0022 §7)
 * without re-reading the TaskRecord.
 */
export interface TaskEvent {
  /** Cursor / event id; the loadEvents(since) filter. */
  eventId: ULID;
  subscriptionId: ULID;
  taskId: ULID;
  /**
   * Emit key per ADR-0022 §2 + §8, e.g. `task:<id>:running`, `task:<id>:->canceled`,
   * `task:<id>:->lost`. Storage layer treats this as an opaque string.
   */
  type: string;
  status: TaskStatus;
  /** ms epoch; matches `TaskRecord.transitionAt` at the moment of emission. */
  transitionAtMs: number;
  outputBytes?: number;
  /** ≤ 2 KB inline preview (only present when `outputBytes <= 2048`). */
  outputPreview?: string;
}

/** Filter for `listTasks`. Only indexable dimensions; compound predicates live on the registry. */
export interface TaskFilter {
  status?: TaskStatus;
  label?: string;
}

/**
 * Persistence seam for TaskRecord, Subscription, and per-subscriber TaskEvent log.
 * Adapters:
 * - `InMemoryTaskStorage` (this file): `Map<ULID, TaskRecord>` for tasks +
 *   `Map<string, Subscription>` keyed by `${subscriberId}-${taskId}` for unique load +
 *   `Map<string, TaskEvent[]>` keyed by subscriberId for the event buffer. Used when no session
 *   directory is available (session-less/library callers and tests).
 * - `FileTaskStorage` (durable default, `./task-storage-file.ts`): `<sessionDir>/tasks/<id>.json`
 *   + `<sessionDir>/subscriptions/<subscriberId>-<taskId>.json` + `<sessionDir>/events/<subscriberId>-<taskId>.jsonl`,
 *   same interface; bonds the session's on-disk state across a restart.
 */
export interface TaskStorage {
  /** Load one TaskRecord by id; returns `null` if the id is unknown. */
  loadTask(taskId: ULID): Promise<TaskRecord | null>;
  /** Persist (insert-or-replace) one TaskRecord. Rejects on nullish `record`. */
  saveTask(record: TaskRecord): Promise<void>;
  /** Remove one TaskRecord. Rejects when the id is unknown (no silent swallow). */
  deleteTask(taskId: ULID): Promise<void>;
  /**
   * Iterate TaskRecords matching `filter` (or all records when `filter` is omitted). Order is
   * stable but unspecified — callers that need a particular order apply it after iteration.
   */
  listTasks(filter?: TaskFilter): AsyncIterable<TaskRecord>;

  /** Load the subscription one subscriber holds for one task; `null` if absent. */
  loadSubscription(subscriberId: ULID, taskId: ULID): Promise<Subscription | null>;
  /** Persist (insert-or-replace) one Subscription. Rejects on nullish `sub`. */
  saveSubscription(sub: Subscription): Promise<void>;

  /**
   * Append N events to one subscription's log. Events are stored in `events[i].eventId` order
   * (lexical = chronological for ULIDs). Rejects when the subscriptionId is unknown.
   */
  appendEvents(subscriptionId: ULID, events: TaskEvent[]): Promise<void>;
  /**
   * Yield events for one subscription, strictly newer than `since`. `since === undefined` means
   * "from the beginning". Yields in `eventId` ascending order.
   */
  loadEvents(subscriptionId: ULID, since?: ULID): AsyncIterable<TaskEvent>;
}

/** ULID lexical comparator (lexical = chronological for correctly-generated ULIDs). */
function compareEventId(a: TaskEvent, b: TaskEvent): number {
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** True when the batch's eventIds are already non-decreasing, so sorting would be a no-op. */
function isOrdered(events: readonly TaskEvent[]): boolean {
  for (let index = 1; index < events.length; index++) {
    if (compareEventId(events[index - 1] as TaskEvent, events[index] as TaskEvent) > 0) {
      return false;
    }
  }
  return true;
}

/**
 * In-memory TaskStorage adapter. Pure data structures; no IO, no clock, no random. Stable
 * iteration order matches Map insertion order — that is part of the public contract tests pin
 * (`listTasks()` yields the records the test inserted).
 */
export class InMemoryTaskStorage implements TaskStorage {
  readonly #tasks: Map<ULID, TaskRecord>;
  readonly #subscriptions: Map<string, Subscription>;
  /** O(1) subscriber-existence index; the Map above is keyed by pair, not by subscriber. */
  readonly #subscriberIds: Set<ULID>;
  readonly #events: Map<string, TaskEvent[]>;

  constructor() {
    this.#tasks = new Map();
    this.#subscriptions = new Map();
    this.#subscriberIds = new Set();
    this.#events = new Map();
  }

  /** Subscription key: `${subscriberId}-${taskId}` per ADR-0022 §5 path. */
  static #subKey(subscriberId: ULID, taskId: ULID): string {
    return `${subscriberId}-${taskId}`;
  }

  /**
   * True when at least one saved Subscription belongs to `subscriberId` (ADR-0022 §5:
   * "Subscriber == owner"). Used by `appendEvents` / `loadEvents` — the brief's
   * `subscriptionId` parameter is the subscriber's id, since the event buffer is per-subscriber.
   */
  #hasSubscriber(subscriberId: ULID): boolean {
    // O(1) via the subscriber index. Scanning #subscriptions.values() here would be O(s) per
    // append; for a run-level subscriber with one subscription per task that is O(N^2) over a run.
    return this.#subscriberIds.has(subscriberId);
  }

  async loadTask(taskId: ULID): Promise<TaskRecord | null> {
    const found = this.#tasks.get(taskId);
    return found === undefined ? null : structuredClone(found);
  }

  async saveTask(record: TaskRecord): Promise<void> {
    assertPresent(record, "saveTask: record is required");
    // Deep-clone on insert so a later mutation of the caller's reference does not poison
    // storage state. Cheap for the 21-field schema.
    this.#tasks.set(record.id, structuredClone(record));
  }

  async deleteTask(taskId: ULID): Promise<void> {
    if (!this.#tasks.has(taskId)) {
      throw new Error(`deleteTask: unknown taskId ${taskId}`);
    }
    this.#tasks.delete(taskId);
  }

  async *listTasks(filter?: TaskFilter): AsyncIterable<TaskRecord> {
    for (const record of this.#tasks.values()) {
      if (filter?.status !== undefined && record.status !== filter.status) continue;
      if (filter?.label !== undefined && record.label !== filter.label) continue;
      yield structuredClone(record);
    }
  }

  async loadSubscription(subscriberId: ULID, taskId: ULID): Promise<Subscription | null> {
    const found = this.#subscriptions.get(InMemoryTaskStorage.#subKey(subscriberId, taskId));
    return found === undefined ? null : structuredClone(found);
  }

  async saveSubscription(sub: Subscription): Promise<void> {
    assertPresent(sub, "saveSubscription: sub is required");
    const key = InMemoryTaskStorage.#subKey(sub.subscriberId, sub.taskId);
    this.#subscriptions.set(key, structuredClone(sub));
    this.#subscriberIds.add(sub.subscriberId);
  }

  async appendEvents(subscriptionId: ULID, events: TaskEvent[]): Promise<void> {
    // Per ADR-0022 §5 ("Subscriber == owner"), the event buffer is per-subscriber — the brief's
    // `subscriptionId` parameter is the subscriberId. Verify the subscriber has at least one
    // saved Subscription before accepting the write (no phantom logs).
    if (!this.#hasSubscriber(subscriptionId)) {
      throw new Error(`appendEvents: unknown subscriptionId ${subscriptionId}`);
    }
    if (events.length === 0) return;
    const log = this.#events.get(subscriptionId) ?? [];
    // Event ids are monotonic ULIDs, so the common append is an already-ordered batch that
    // continues the log's tail. Sort only when the batch itself is unordered, and rebuild the
    // log only when the batch does not continue the tail. The old shape copied and re-sorted the
    // whole log (plus every prior event) on every append — O(N^2) for a run-level subscriber.
    const ordered = isOrdered(events) ? [...events] : [...events].sort(compareEventId);
    const lastExisting = log.length === 0 ? undefined : log[log.length - 1]?.eventId;
    const firstIncoming = ordered[0]?.eventId;
    if (
      lastExisting === undefined ||
      (firstIncoming !== undefined && lastExisting <= firstIncoming)
    ) {
      for (const ev of ordered) {
        log.push(structuredClone(ev));
      }
      this.#events.set(subscriptionId, log);
      return;
    }
    // Out-of-order relative to the existing log: rebuild once, preserving the interface's
    // "stored in events[i].eventId order" invariant. Array#sort is stable, so equal ids keep
    // existing-before-incoming order.
    const merged = [...log, ...ordered.map((ev) => structuredClone(ev))];
    merged.sort(compareEventId);
    this.#events.set(subscriptionId, merged);
  }

  async *loadEvents(subscriptionId: ULID, since?: ULID): AsyncIterable<TaskEvent> {
    if (!this.#hasSubscriber(subscriptionId)) {
      throw new Error(`loadEvents: unknown subscriptionId ${subscriptionId}`);
    }
    const log = this.#events.get(subscriptionId) ?? [];
    // Binary-search the first index whose eventId is strictly greater than `since` (ADR-0022 §5:
    // the cursor advances past the delivered event, so eventId === since is excluded). The log is
    // kept in eventId order by appendEvents, so this is O(log N) instead of a full filter scan.
    let start = 0;
    if (since !== undefined) {
      let low = 0;
      let high = log.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if ((log[mid]?.eventId ?? "") <= since) low = mid + 1;
        else high = mid;
      }
      start = low;
    }
    for (let index = start; index < log.length; index++) {
      yield structuredClone(log[index] as TaskEvent);
    }
  }
}
