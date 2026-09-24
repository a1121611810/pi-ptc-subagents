/**
 * NotificationPipeline: the subscription buffer + cursor + idle-wake layer for background
 * dispatch (ADR-0022 §5 cursor, §6 delivery, §7 notification message).
 *
 * This module sits between the TaskStorage persistence seam (BG-01,
 * `src/runtime/task-storage.ts`) and the TaskRegistry (BG-02). It owns exactly one
 * responsibility: keeping a per-subscriber cursor honest so an event is delivered at
 * least once and never silently dropped.
 *
 * Design notes:
 *
 * - **Cursor advances on delivery, not on drain.** ADR-0022 §5 makes the subscription
 *   cursor monotonic per subscriber; §6 picks the cursor-replay scheme ("B. SUB + Map +
 *   preview") precisely because replay survives network / restart / fork. This module
 *   keeps that split explicit: `drainPending` reads, `acknowledgeEvents` advances. The
 *   caller (the registry / dispatcher) acknowledges only after the wake message is
 *   actually delivered, so a crash between drain and delivery re-delivers rather than
 *   loses.
 *
 * - **Idempotence is a contract, not an accident.** `subscribe` on an existing
 *   (subscriberId, taskId) pair returns the persisted subscription *unchanged* — resetting
 *   the cursor there would re-deliver the whole log (or worse, skip events if a
 *   `since` were applied naively). `acknowledgeEvents` never moves the cursor backwards,
 *   so a late ack (a duplicate wake, an out-of-order retry) is a no-op.
 *
 * - **The event buffer is per-subscriber in BG-01's adapter.** `TaskStorage.loadEvents`
 *   is keyed by the subscriber id (see the BG-01 implementation note: "the brief's
 *   `subscriptionId` parameter is the subscriber's id, since the event buffer is
 *   per-subscriber"). A Subscription is per (subscriberId, taskId), so this module filters
 *   the per-subscriber log down to events whose `taskId` matches the subscription. Without
 *   that filter a subscriber watching two tasks would drain one task's events through the
 *   other task's cursor.
 *
 * - **`ZERO_CURSOR`** is the sentinel "from the beginning". It is lexically smaller than
 *   every real ULID (all-zero string vs a timestamp-prefixed id), so the existing
 *   `loadEvents(since)` comparison `eventId <= since` yields the full log when the cursor
 *   is mapped back to `undefined`.
 *
 * - **`splitBatch`** is the ADR-0022 §7 boundary rule as a pure function: split along event
 *   boundaries, never drop. A single event larger than the budget still gets its own batch.
 *   The payload estimate is the UTF-8 byte length of the event's JSON encoding — a
 *   conservative, deterministic proxy the registry can also meter against.
 */

import type { Subscription, TaskEvent, TaskStorage, ULID } from "./task-storage.ts";

/**
 * Sentinel cursor meaning "from the beginning" (ADR-0022 §5): lexically smaller than any
 * real timestamp-prefixed ULID, so `loadEvents(since)` treats it as the start of the log.
 */
export const ZERO_CURSOR: ULID = "00000000000000000000" as ULID;

/**
 * Default per-batch payload budget for `splitBatch`, in bytes. Callers that have a
 * token-budget-derived ceiling override it (ADR-0022 §7); 100 KiB is the Ticket BG-05
 * default and is deliberately far below the 200 K-token split point so a batch rarely
 * needs to be re-split downstream.
 */
export const DEFAULT_MAX_BATCH_BYTES: number = 100 * 1024;

/** Idle-wake callback: one subscriber's pending events, delivered in cursor order. */
export type IdleWakeHandler = (subscriberId: ULID, events: TaskEvent[]) => void;

/**
 * Minimal warn seam for delivery failures. Kept structural (no dependency on the task
 * registry's logger type) so this module stays Layer-1 and testable with a capturing stub.
 */
export interface NotificationPipelineLogger {
  warn(msg: string): void;
}

/**
 * Default failure surface: an idle-wake handler that throws must not vanish silently
 * (docs/testing-constraints.md #3), so the first line of defence is a console warning.
 */
const DEFAULT_PIPELINE_LOGGER: NotificationPipelineLogger = {
  warn: (msg: string): void => {
    console.warn("[pi-ptc.notifications] " + msg);
  },
};

/**
 * The five-method pipeline surface (Ticket BG-05). The concrete class adds the
 * dispatcher-facing `notifyIdle` wake trigger on top of this interface.
 */
export interface NotificationPipeline {
  /** Create (or return the existing) subscription for one (subscriberId, taskId) pair. */
  subscribe(subscriberId: ULID, taskId: ULID, since?: ULID): Promise<Subscription>;
  /** Read pending events strictly newer than the cursor, WITHOUT advancing the cursor. */
  drainPending(subscriberId: ULID, taskId: ULID): Promise<TaskEvent[]>;
  /** Advance the cursor to `untilCursor`; never moves backwards (idempotent). */
  acknowledgeEvents(subscriberId: ULID, taskId: ULID, untilCursor: ULID): Promise<void>;
  /** Register an idle-wake handler; handlers fire in registration order. */
  onIdleWake(handler: IdleWakeHandler): void;
  /** Count events strictly newer than the cursor. */
  pendingCount(subscriberId: ULID, taskId: ULID): Promise<number>;
}

/** Construction options for {@link DefaultNotificationPipeline}. */
export interface NotificationPipelineOptions {
  /**
   * Clock seam for `Subscription.createdAt`. Defaults to `Date.now`; tests inject a fixed
   * clock so the persisted subscription is byte-for-byte reproducible.
   */
  now?: () => number;
  /**
   * Failure seam for idle-wake handlers. Defaults to a `console.warn` logger; tests inject
   * a capturing stub. See {@link NotificationPipelineLogger}.
   */
  logger?: NotificationPipelineLogger;
}

/**
 * Concrete notification pipeline. Holds the idle-wake handler list in memory (one pipeline
 * per session) and delegates every persisted fact — subscription rows and the event log —
 * to the injected {@link TaskStorage}.
 */
export class DefaultNotificationPipeline implements NotificationPipeline {
  readonly #storage: TaskStorage;
  readonly #now: () => number;
  readonly #logger: NotificationPipelineLogger;
  readonly #handlers: IdleWakeHandler[];

  constructor(storage: TaskStorage, options: NotificationPipelineOptions = {}) {
    this.#storage = storage;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? DEFAULT_PIPELINE_LOGGER;
    this.#handlers = [];
  }

  /**
   * Subscribing twice for the same (subscriberId, taskId) returns the persisted
   * subscription unchanged: the cursor is delivery state and must survive a re-subscribe
   * (ADR-0022 §5). `since` is honoured only on first creation.
   */
  async subscribe(subscriberId: ULID, taskId: ULID, since?: ULID): Promise<Subscription> {
    const existing = await this.#storage.loadSubscription(subscriberId, taskId);
    if (existing !== null) return existing;

    const subscription: Subscription = {
      subscriberId,
      taskId,
      cursor: since ?? ZERO_CURSOR,
      status: "active",
      createdAt: this.#now(),
    };
    await this.#storage.saveSubscription(subscription);
    return subscription;
  }

  /**
   * Drain pending events without acknowledging them (ADR-0022 §6: the cursor advances on
   * delivery, and delivery has not happened yet). A second drain before an ack returns the
   * same events — at-least-once, not exactly-once.
   */
  async drainPending(subscriberId: ULID, taskId: ULID): Promise<TaskEvent[]> {
    const subscription = await this.#requireSubscription(subscriberId, taskId, "drainPending");
    return this.#pendingEvents(subscription);
  }

  /**
   * Advance the subscription cursor to `untilCursor` and persist it. An older-or-equal
   * cursor is a no-op, so duplicate / out-of-order acks cannot rewind delivery state
   * (ADR-0022 §5 cursor is monotonic).
   */
  async acknowledgeEvents(subscriberId: ULID, taskId: ULID, untilCursor: ULID): Promise<void> {
    const subscription = await this.#requireSubscription(subscriberId, taskId, "acknowledgeEvents");
    if (untilCursor <= subscription.cursor) return;
    await this.#storage.saveSubscription({ ...subscription, cursor: untilCursor });
  }

  /** Register an idle-wake handler; later registrations run after earlier ones. */
  onIdleWake(handler: IdleWakeHandler): void {
    this.#handlers.push(handler);
  }

  /** Count pending events strictly newer than the cursor (ADR-0022 §5). */
  async pendingCount(subscriberId: ULID, taskId: ULID): Promise<number> {
    const subscription = await this.#requireSubscription(subscriberId, taskId, "pendingCount");
    return (await this.#pendingEvents(subscription)).length;
  }

  /**
   * Dispatcher-facing wake trigger (ADR-0022 §6, "idle wake = drain in one wake"). Called on
   * `agent_settled`: drains pending events, invokes every registered handler in
   * registration order, and returns the events. It does NOT acknowledge — the caller
   * acknowledges once the wake message has actually been delivered.
   */
  async notifyIdle(subscriberId: ULID, taskId: ULID): Promise<TaskEvent[]> {
    const events = await this.drainPending(subscriberId, taskId);
    if (events.length === 0) return events;
    // Snapshot so a handler that registers another handler cannot extend this wake.
    const handlers = this.#handlers.slice();
    for (const handler of handlers) {
      try {
        handler(subscriberId, events);
      } catch (err) {
        // Per-handler isolation: one bad consumer must not starve the others. Report the
        // failure through the warn path instead of swallowing it (testing-constraints #3).
        const message = err instanceof Error ? err.message : String(err);
        this.#logger.warn(
          `notifyIdle: idle-wake handler for subscriber ${subscriberId} / task ${taskId} ` +
            `threw: ${message}`,
        );
      }
    }
    return events;
  }

  /** Load the subscription or fail loudly — a silent empty drain would lose events. */
  async #requireSubscription(
    subscriberId: ULID,
    taskId: ULID,
    operation: string,
  ): Promise<Subscription> {
    const subscription = await this.#storage.loadSubscription(subscriberId, taskId);
    if (subscription === null) {
      throw new Error(
        `${operation}: unknown subscription for subscriber ${subscriberId} / task ${taskId}`,
      );
    }
    return subscription;
  }

  /**
   * Collect the subscription's pending events, filtered to its own taskId. The BG-01
   * adapter stores one log per subscriber (not per (subscriber, task)), so the filter is
   * what keeps two subscriptions of the same subscriber from cross-delivering.
   */
  async #pendingEvents(subscription: Subscription): Promise<TaskEvent[]> {
    const events: TaskEvent[] = [];
    for await (const event of this.#storage.loadEvents(
      subscription.subscriberId,
      subscription.cursor === ZERO_CURSOR ? undefined : subscription.cursor,
    )) {
      if (event.taskId !== subscription.taskId) continue;
      events.push(event);
    }
    return events;
  }
}

/** Estimated UTF-8 payload size of one event, used by {@link splitBatch}. */
export function estimateEventBytes(event: TaskEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/**
 * Split a batch along event boundaries so no batch exceeds `maxBytes` of estimated payload
 * (ADR-0022 §7). Pure and order-preserving: flattening the result yields the input. An event
 * that alone exceeds `maxBytes` is still emitted as its own batch — the rule is "split, never
 * drop". An empty input yields an empty array.
 */
export function splitBatch(events: TaskEvent[], maxBytes: number): TaskEvent[][] {
  const batches: TaskEvent[][] = [];
  let current: TaskEvent[] = [];
  let currentBytes = 0;

  for (const event of events) {
    const eventBytes = estimateEventBytes(event);
    if (current.length > 0 && currentBytes + eventBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
