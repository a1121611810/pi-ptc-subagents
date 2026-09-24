/**
 * TaskRegistry: the session-level TaskRecord state machine for background dispatch
 * (ADR-0022, BG-02).
 *
 * This module is the *only* legal writer of a TaskRecord's lifecycle. Every producer
 * (the background branch of `pi.dispatch`, the `ptc_task_stop` tool, the restart
 * reconciler) routes through {@link TaskRegistry.transition}; the single-terminal-writer
 * rule — this file's own invariant that exactly one writer applies the terminal state — is
 * enforced by the explicit transition table in this file, not by convention.
 *
 * Layer: 2 (core) — depends only on the Layer-1 `TaskStorage` seam (BG-01). It owns *state*
 * (TaskRecord progression) and deliberately does not own *delivery*, the *subscription cursor*
 * (the BG-05 NotificationPipeline is the single production cursor writer, via its
 * `acknowledgeEvents`), or *IO* (TaskStorage adapters). The types `TaskRecord`, `TaskStatus`,
 * `Subscription`, `TaskEvent`, `ULID` and the `TaskStorage` interface are imported from
 * `./task-storage.ts`; this file must
 * never redefine them (BG-01 owns the persisted schema).
 *
 * Design notes:
 *
 * - **Clock is injected twice.** `TransitionContext.clock` is required by the brief and is
 *   used for the transition being requested; the constructor's `options.clock` is the
 *   registry-level clock used by {@link TaskRegistry.reconcileLostTasks}, which the brief
 *   gives no `TransitionContext` parameter for. Tests pass the *same* fake clock to both so
 *   timestamps stay deterministic. No path in this file calls `Date.now()`.
 *
 * - **ULIDs are registry-generated and monotonic.** IDs must sort lexically in emission
 *   order (ADR-0022 §5: "The cursor is a monotonic ULID that advances on every event
 *   delivered"; TaskStorage orders the event log by `eventId`). {@link DefaultTaskRegistry}
 *   holds a private {@link UlidMinter} (from `ulid.ts`, WS-ULID / R-M2) bound to the injected
 *   clock, so two event IDs minted in the same millisecond compare strictly increasing and a
 *   non-monotonic clock cannot invert order — with no module-global minting state.
 *
 * - **The spawn id comes from the handle.** The brief's spawn `record` is
 *   `Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">`, i.e. it deliberately
 *   has no id, while the command carries a `DispatchHandle` whose `taskId` is the fresh ULID
 *   the dispatch layer minted (ADR-0022 §4: the handle is the spawn-time projection the program
 *   carries). The registry therefore *adopts* `handle.taskId` as the record id so the handle
 *   and the record agree at creation. A placeholder/empty handle id makes the registry mint a
 *   fresh ULID and write it back onto the handle.
 *
 * - **Event buffer key.** `TaskStorage.appendEvents` / `loadEvents` are keyed by subscriber id
 *   (BG-01 comment: "the brief's `subscriptionId` parameter is the subscriber's id, since the
 *   event buffer is per-subscriber"), and `ctx.callerId` is the subscriber (ADR-0022 §5:
 *   "Subscriber == owner"). `TaskEvent.subscriptionId` is therefore written as the
 *   subscriberId.
 *
 * - **Reconcile is a recovery edge.** ADR-0022 §2 lists `lost` from `running`
 *   ("session restart; or restart-reconcile"); the brief additionally requires
 *   {@link TaskRegistry.reconcileLostTasks} to sweep *both* `running` and `stopping` records.
 *   A record caught mid-`stopping` at shutdown must still be reclaimed, so the
 *   `reconcile-lost` command (and only it) accepts the recovery source set
 *   {running, stopping}. The ordinary `transition` command remains strict and rejects
 *   `stopping -> lost`.
 *
 * References: ADR-0022 §2 (state machine), §3 (TaskRecord), §4 (DispatchHandle),
 * §5 (Subscription cursor), §7 (event payload), §8 (signal layering).
 */

import type { TaskEvent, TaskFilter, TaskRecord, TaskStorage, TaskStatus } from "./task-storage.ts";
import type { ULID } from "./task-storage.ts";
import { createUlidMinter, type UlidMinter } from "./ulid.ts";

// Re-export the BG-01-owned schema next to the registry so consumers of the lifecycle have
// one import site. These are re-exports, not redefinitions.
export type {
  Subscription,
  TaskEvent,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TaskStorage,
  ULID,
} from "./task-storage.ts";

/** Minimal structured logger seam (ADR-0022 implementation spec §12). */
export interface RegistryLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * Thin, frozen, spawn-time projection of a TaskRecord (ADR-0022 §4). The program carries
 * this; the registry stores the TaskRecord. The handle is *not* updated on transition.
 */
export interface DispatchHandle {
  taskId: ULID;
  label: string;
  status: "running";
}

/**
 * Per-call dependencies for one registry command. `callerId` is also the subscriber id
 * (ADR-0022 §5, "Subscriber == owner"); `clock` must be the injected time source.
 */
export interface TransitionContext {
  clock: () => number;
  logger?: RegistryLogger;
  callerId: string;
}

/**
 * The three `lost` reasons ADR-0022 §8 keeps distinct in the TaskRecord's
 * `errorMessage` field for auditability.
 */
export type LostReason =
  | "session_ended_while_running"
  | "user_killed_via_esc"
  | "lost_on_session_restart";

/**
 * ADR-0022 §3/§7: the largest output payload that is inlined as a record/event preview.
 * Above it the renderer must dereference `outputRef`; the literal 2048 is the Map+preview
 * rule from §3 ("≤2 KB inline preview") and §7 ("output-preview only when outputBytes <= 2048").
 */
export const OUTPUT_PREVIEW_MAX_BYTES = 2048;

/** All state mutations the TaskRegistry accepts (single-terminal-writer invariant, this file). */
export type TaskCommand =
  | {
      kind: "spawn";
      parentTaskId?: ULID;
      handle: DispatchHandle;
      record: Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt">;
    }
  | {
      kind: "transition";
      taskId: ULID;
      to: TaskStatus;
      reason?: string;
      stopReason?: string;
      errorMessage?: string;
      exitCode?: number;
      /**
       * ADR-0022 §3: the child's captured-output projection written on the terminal
       * transition. The BG-04 pump drains stdout, persists it through `OutputStorage`, and
       * passes these three so `ptc_task_output` can find it.
       */
      outputRef?: string;
      outputBytes?: number;
      outputPreview?: string;
    }
  | { kind: "stop"; taskId: ULID; reason: string }
  | { kind: "reconcile-lost"; taskId: ULID; reason: LostReason }
  /**
   * ADR-0022 §8 / R-M1: the terminal decision for a child close lives *inside* the registry so
   * the read-and-write is serialized against a concurrent `stop`. The registry resolves
   * `stopping -> canceled`, otherwise `running -> {succeeded | failed}` from `exitCode`; a
   * terminal record is rejected rather than overwritten.
   */
  | {
      kind: "resolve-exit";
      taskId: ULID;
      exitCode: number;
      outputRef?: string;
      outputBytes?: number;
      outputPreview?: string;
    };

/** Outcome of one successful command: the persisted record, emitted events, and cursor. */
export interface TransitionResult {
  record: TaskRecord;
  events: TaskEvent[];
  /** The event id of the last emitted event; equal to the subscription's new cursor. */
  cursor: ULID;
  /**
   * The status the record held *before* this command applied. Absent on `spawn` (there is no
   * prior state); present on every transition/stop/resolve so a caller can report the source
   * state without a second, racing read (ADR-0022 §8 late-arrival stop).
   */
  fromStatus?: TaskStatus;
}

/**
 * In-process transition observer (issue #68 §1). Fired synchronously by
 * {@link TaskRegistry.transition} **after** the new record and its event have been persisted,
 * with the post-transition record and the emitted event. Observers are best-effort: a throwing
 * observer is warned about and never corrupts the transition. Registration returns an
 * idempotent unsubscribe.
 */
export type TaskTransitionObserver = (record: TaskRecord, event: TaskEvent) => void;

/** Read-side filter (ADR-0022 §3). `limit` defaults to 100; `orderBy` defaults to desc. */
export interface TaskQuery {
  status?: TaskStatus[];
  label?: string;
  limit?: number;
  orderBy?: "createdAt-asc" | "createdAt-desc";
}

/** The five-method lifecycle surface from the BG-02 brief. */
export interface TaskRegistry {
  transition(command: TaskCommand, ctx: TransitionContext): Promise<TransitionResult>;
  query(view: TaskQuery): Promise<TaskRecord[]>;
  /**
   * Load one TaskRecord by id; `null` when the id is unknown. The O(1) complement of `query`,
   * used by the background pump to see whether a stop was requested before it writes the
   * terminal transition (ADR-0022 §8).
   */
  get(taskId: ULID): Promise<TaskRecord | null>;
  /**
   * Subscribe to every successfully persisted state write (spawn included). Returns an
   * idempotent unsubscribe. Observers run synchronously, in-process; see
   * {@link TaskTransitionObserver} for the best-effort contract and single-writer ordering.
   */
  onTransition(observer: TaskTransitionObserver): () => void;
  reconcileLostTasks(): Promise<TaskRecord[]>;
}

/** Registry-level dependencies (used by commands that have no TransitionContext). */
export interface TaskRegistryOptions {
  clock: () => number;
  logger?: RegistryLogger;
}

// ---------------------------------------------------------------------------
//  State machine (ADR-0022 §2)
// ---------------------------------------------------------------------------

/**
 * The explicit transition table copied from ADR-0022 §2. `running -> stopping` is the model
 * stop; `running -> {succeeded,failed,canceled,lost}` are the child-completion / session
 * signals; `stopping -> {succeeded,failed,canceled}` is the in-flight stop resolving.
 * `lost` is deliberately absent from `stopping` here — recovery owns that edge (see
 * `RECOVERY_SOURCES`).
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  running: ["stopping", "succeeded", "failed", "canceled", "lost"],
  stopping: ["succeeded", "failed", "canceled"],
  succeeded: [],
  failed: [],
  canceled: [],
  lost: [],
};

/** Terminal states get `finishedAt` / `durationMs` (ADR-0022 §3). */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

/**
 * Sources the restart reconciler may force to `lost`. This is the ADR-0022 §2
 * "restart-reconcile" trigger — it intentionally includes `stopping`, because a session
 * killed while a stop was in flight must still be reclaimed rather than left "stopping"
 * forever.
 */
const RECOVERY_SOURCES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "stopping"]);

/** Runtime narrowing for the runtime-untrusted `to` field of a transition command. */
function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    value === "running" ||
    value === "stopping" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled" ||
    value === "lost"
  );
}

/** A usable id is a non-empty string; the branded ULID is a compile-time-only distinction. */
function isUsableTaskId(value: unknown): value is ULID {
  return typeof value === "string" && value.length > 0;
}

/**
 * The three `lost` reasons ADR-0022 §8 keeps distinct in `errorMessage` for auditability. The
 * generic `transition({to:"lost"})` edge must carry one of these; `reconcile-lost` types its
 * `reason` as {@link LostReason} directly.
 */
const LOST_REASONS: ReadonlySet<string> = new Set<string>([
  "session_ended_while_running",
  "user_killed_via_esc",
  "lost_on_session_restart",
]);

/** Runtime narrowing for the lost-reason guard (R-M4). */
function isLostReason(value: unknown): value is LostReason {
  return typeof value === "string" && LOST_REASONS.has(value);
}

/**
 * Emit key per ADR-0022 §2 + §8. Entry states use `task:<id>:<status>`; state changes use
 * `task:<id>:-><status>` (the arrow form appears verbatim in the §8 signal-layering table).
 */
function emitKey(taskId: ULID, status: TaskStatus): string {
  const prefix = `task:${taskId}`;
  if (status === "running" || status === "stopping") {
    return `${prefix}:${status}`;
  }
  return `${prefix}:->${status}`;
}

// ---------------------------------------------------------------------------
//  DefaultTaskRegistry
// ---------------------------------------------------------------------------

/** Production/in-memory TaskRegistry implementation over an injected {@link TaskStorage}. */
export class DefaultTaskRegistry implements TaskRegistry {
  readonly #storage: TaskStorage;
  readonly #clock: () => number;
  readonly #logger: RegistryLogger | undefined;
  /** Per-instance monotonic id minter (ulid.ts); its state is not shared module-globally. */
  readonly #ulid: UlidMinter;
  /** Registered in-process transition observers (issue #68 §1). */
  readonly #observers = new Set<TaskTransitionObserver>();
  /**
   * Tail of the write queue. Every state write is chained here so a load-check-write cannot
   * interleave with a concurrent command (R-M1). Each task is cheap and this is a session-level
   * registry, so one queue is simpler than per-task locks and keeps the single-writer guarantee.
   */
  #writeTail: Promise<void> = Promise.resolve();

  constructor(storage: TaskStorage, options: TaskRegistryOptions) {
    this.#storage = storage;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#ulid = createUlidMinter({ now: () => this.#clock() });
  }

  // -- public interface ------------------------------------------------------

  /**
   * The single write path. Dispatches to the command-specific handler; unknown command kinds
   * (possible only through untrusted runtime data) throw rather than fall through.
   */
  async transition(command: TaskCommand, ctx: TransitionContext): Promise<TransitionResult> {
    const result = await this.#serialize(() => this.#run(command, ctx));
    const event = result.events[result.events.length - 1];
    if (event !== undefined) {
      // Fired after persistence and after the write lock releases, so an observer may call back
      // into the registry without deadlocking; see TaskTransitionObserver.
      this.#notifyObservers(result.record, event, ctx.logger);
    }
    return result;
  }

  /** Register a best-effort observer; the returned unsubscribe is idempotent. */
  onTransition(observer: TaskTransitionObserver): () => void {
    this.#observers.add(observer);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#observers.delete(observer);
    };
  }

  /** Route one command (the body of {@link transition}, run under the write lock). */
  async #run(command: TaskCommand, ctx: TransitionContext): Promise<TransitionResult> {
    switch (command.kind) {
      case "spawn":
        return this.#spawn(command, ctx);
      case "transition":
        return this.#transitionTo(command, ctx);
      case "stop":
        return this.#stop(command, ctx);
      case "reconcile-lost":
        return this.#reconcileOne(command, ctx);
      case "resolve-exit":
        return this.#resolveExit(command, ctx);
    }
    throw new Error(
      `transition: unknown command kind ${String((command as { kind: unknown }).kind)}`,
    );
  }

  /** O(1) single-record read; the read side of the same storage seam `query` uses. */
  async get(taskId: ULID): Promise<TaskRecord | null> {
    if (!isUsableTaskId(taskId)) return null;
    return await this.#storage.loadTask(taskId);
  }

  /** Read-only query; storage iteration order is stabilized by an explicit createdAt sort. */
  async query(view: TaskQuery): Promise<TaskRecord[]> {
    const limit = view.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`query: limit must be a non-negative integer, got ${String(view.limit)}`);
    }
    const orderBy = view.orderBy ?? "createdAt-desc";
    const filter: TaskFilter | undefined =
      view.label === undefined ? undefined : { label: view.label };
    const matched: TaskRecord[] = [];
    for await (const record of this.#storage.listTasks(filter)) {
      if (view.status !== undefined && !view.status.includes(record.status)) {
        continue;
      }
      matched.push(record);
    }
    // Array#sort is stable, so equal createdAt values keep storage's insertion order.
    matched.sort((a, b) =>
      orderBy === "createdAt-asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt,
    );
    return matched.slice(0, limit);
  }

  /**
   * Restart-time reconcile (ADR-0022 §2/§8): every `running` or `stopping` record becomes
   * `lost` with reason `lost_on_session_restart`. Idempotent: a second call finds no
   * non-terminal records and returns an empty array.
   */
  async reconcileLostTasks(): Promise<TaskRecord[]> {
    const targets: TaskRecord[] = [];
    for await (const record of this.#storage.listTasks()) {
      if (RECOVERY_SOURCES.has(record.status)) {
        targets.push(record);
      }
    }
    const reconciled: TaskRecord[] = [];
    for (const target of targets) {
      const result = await this.transition(
        { kind: "reconcile-lost", taskId: target.id, reason: "lost_on_session_restart" },
        {
          clock: this.#clock,
          callerId: this.#ownerSubscriber(target),
          logger: this.#logger,
        },
      );
      reconciled.push(result.record);
    }
    this.#logger?.info(`reconcileLostTasks: marked ${reconciled.length} task(s) lost`);
    return reconciled;
  }

  // -- command handlers ------------------------------------------------------

  /** Spawn: mint/adopt the id, persist a `running` record, open the owner subscription. */
  async #spawn(
    command: Extract<TaskCommand, { kind: "spawn" }>,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    const now = Math.max(0, Math.floor(ctx.clock()));
    const handle = command.handle;
    if (handle === null || handle === undefined) {
      throw new Error("spawn: handle is required");
    }
    if (handle.status !== "running") {
      throw new Error(`spawn: handle.status must be "running", got ${String(handle.status)}`);
    }
    const adopted = isUsableTaskId(handle.taskId);
    const taskId: ULID = adopted ? handle.taskId : this.#ulid.next();
    const existing = await this.#storage.loadTask(taskId);
    if (existing !== null) {
      throw new Error(`spawn: task ${taskId} already exists (duplicate spawn)`);
    }
    const record: TaskRecord = {
      ...command.record,
      id: taskId,
      label: command.record.label.length > 0 ? command.record.label : handle.label,
      status: "running",
      createdAt: now,
      startedAt: now,
      finishedAt: undefined,
      durationMs: undefined,
      transitionAt: now,
      parentTaskId: command.parentTaskId ?? command.record.parentTaskId,
    };
    if (!adopted) {
      // Keep the caller's handle pointing at the canonical record id (ADR-0022 §4).
      handle.taskId = taskId;
    }
    const subscriberId = ctx.callerId as ULID;
    const event = this.#makeEvent(taskId, subscriberId, "running", now, record);
    // R-m7: subscription + event first, TaskRecord last. `appendEvents` requires the
    // subscription to exist, and writing the record last means a failed later write cannot
    // leave a persisted `running` orphan behind.
    await this.#storage.saveSubscription({
      subscriberId,
      taskId,
      cursor: event.eventId,
      status: "active",
      createdAt: now,
    });
    await this.#storage.appendEvents(subscriberId, [event]);
    await this.#storage.saveTask(record);
    const logger = ctx.logger ?? this.#logger;
    logger?.info(`spawn: task ${taskId} (${record.label}) running for subscriber ${subscriberId}`);
    return { record, events: [event], cursor: event.eventId };
  }

  /** Ordinary transition: validate the table, then apply. Illegal edges throw. */
  async #transitionTo(
    command: Extract<TaskCommand, { kind: "transition" }>,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    if (!isTaskStatus(command.to)) {
      throw new Error(`transition: unknown target state ${String(command.to)}`);
    }
    const record = await this.#loadOrThrow(command.taskId);
    this.#assertAllowed(record, command.to);
    if (command.to === "lost" && !isLostReason(command.reason)) {
      // R-M4 / ADR-0022 §8: after the edge is proven legal, the lost edge must name one of the
      // three auditable reasons (an illegal edge keeps its illegal-transition error).
      throw new Error(
        'transition: to "lost" requires a LostReason ' +
          "(session_ended_while_running | user_killed_via_esc | lost_on_session_restart)" +
          (command.reason === undefined ? "" : `, got ${String(command.reason)}`),
      );
    }
    return this.#apply(record, command.to, ctx, {
      reason: command.reason,
      stopReason: command.stopReason,
      errorMessage: command.errorMessage,
      exitCode: command.exitCode,
      outputRef: command.outputRef,
      outputBytes: command.outputBytes,
      outputPreview: command.outputPreview,
    });
  }

  /**
   * Shorthand for `running -> stopping`. It deliberately does not proceed to `canceled`:
   * ADR-0022 §8 makes the child's close event the writer of the terminal `canceled` state.
   */
  async #stop(
    command: Extract<TaskCommand, { kind: "stop" }>,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    const record = await this.#loadOrThrow(command.taskId);
    if (record.status === "stopping") {
      // ADR-0022 §8 late-arrival stop: idempotent, no second event. This runs under the write
      // lock, so two concurrent stop commands cannot both emit a stopping event (R-M1).
      const subscription = await this.#storage.loadSubscription(ctx.callerId as ULID, record.id);
      return {
        record,
        events: [],
        cursor: subscription?.cursor ?? record.id,
        fromStatus: record.status,
      };
    }
    this.#assertAllowed(record, "stopping");
    return this.#apply(record, "stopping", ctx, { stopReason: command.reason });
  }

  /**
   * ADR-0022 §8 / R-M1: resolve one child close to its terminal state inside the writer. A
   * `stopping` record always resolves `canceled` (the model stop wins over the exit code); a
   * `running` record resolves from `exitCode`; a terminal record is rejected, never overwritten.
   */
  async #resolveExit(
    command: Extract<TaskCommand, { kind: "resolve-exit" }>,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    const record = await this.#loadOrThrow(command.taskId);
    if (record.status !== "running" && record.status !== "stopping") {
      throw new Error(
        `resolve-exit: task ${record.id} is terminal (${record.status}); ` +
          "the single terminal writer refuses to overwrite it",
      );
    }
    const to: TaskStatus =
      record.status === "stopping" ? "canceled" : command.exitCode === 0 ? "succeeded" : "failed";
    this.#assertAllowed(record, to);
    return this.#apply(record, to, ctx, {
      exitCode: command.exitCode,
      outputRef: command.outputRef,
      outputBytes: command.outputBytes,
      outputPreview: command.outputPreview,
    });
  }

  /** Recovery edge: force a non-terminal record to `lost` with an auditable reason. */
  async #reconcileOne(
    command: Extract<TaskCommand, { kind: "reconcile-lost" }>,
    ctx: TransitionContext,
  ): Promise<TransitionResult> {
    const record = await this.#loadOrThrow(command.taskId);
    if (!RECOVERY_SOURCES.has(record.status)) {
      throw new Error(
        `reconcile-lost: task ${record.id} is terminal (${record.status}); ` +
          "only running/stopping tasks can be reconciled",
      );
    }
    return this.#apply(record, "lost", ctx, { errorMessage: command.reason });
  }

  // -- internals -------------------------------------------------------------

  /** Apply a validated transition: mutate, persist, emit, return. */
  async #apply(
    record: TaskRecord,
    to: TaskStatus,
    ctx: TransitionContext,
    fields: {
      reason?: string;
      stopReason?: string;
      errorMessage?: string;
      exitCode?: number;
      outputRef?: string;
      outputBytes?: number;
      outputPreview?: string;
    },
  ): Promise<TransitionResult> {
    const now = Math.max(0, Math.floor(ctx.clock()));
    const updated: TaskRecord = { ...record, status: to, transitionAt: now };
    if (TERMINAL_STATUSES.has(to)) {
      updated.finishedAt = now;
      updated.durationMs = now - record.startedAt;
    }
    if (fields.stopReason !== undefined) updated.stopReason = fields.stopReason;
    if (fields.errorMessage !== undefined) updated.errorMessage = fields.errorMessage;
    if (fields.exitCode !== undefined) updated.exitCode = fields.exitCode;
    if (fields.outputRef !== undefined) updated.outputRef = fields.outputRef;
    if (fields.outputBytes !== undefined) updated.outputBytes = fields.outputBytes;
    if (fields.outputPreview !== undefined) updated.outputPreview = fields.outputPreview;
    if (fields.reason !== undefined) {
      // The generic `reason` lands in the field ADR-0022 §8 gives that state: stopReason for
      // the stop states, errorMessage for the failure states. Explicit fields win.
      if ((to === "stopping" || to === "canceled") && updated.stopReason === undefined) {
        updated.stopReason = fields.reason;
      }
      if ((to === "failed" || to === "lost") && updated.errorMessage === undefined) {
        updated.errorMessage = fields.reason;
      }
    }

    const subscriberId = ctx.callerId as ULID;
    const event = this.#makeEvent(record.id, subscriberId, to, now, updated);
    await this.#storage.saveTask(updated);
    await this.#ensureSubscription(subscriberId, record.id, now, event.eventId);
    await this.#storage.appendEvents(subscriberId, [event]);
    const logger = ctx.logger ?? this.#logger;
    logger?.info(
      `transition: task ${record.id} ${record.status} -> ${to} (subscriber ${subscriberId})`,
    );
    return { record: updated, events: [event], cursor: event.eventId, fromStatus: record.status };
  }

  /**
   * Serialize one write. The next command waits for this one (success or failure) so the
   * registry's load-check-write is atomic with respect to other commands; the caller still sees
   * its own rejection. See {@link #writeTail}.
   */
  async #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writeTail.then(work, work);
    this.#writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  /**
   * Best-effort, synchronous observer fan-out. A throwing observer is warned about and never
   * corrupts the already-persisted transition (issue #68 §1); when no logger is injected the
   * warning goes to `console.warn` so it is never silently swallowed.
   */
  #notifyObservers(record: TaskRecord, event: TaskEvent, logger?: RegistryLogger): void {
    for (const observer of this.#observers) {
      try {
        observer(record, event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const warning = `transition observer threw for task ${record.id}: ${message}`;
        const activeLogger = logger ?? this.#logger;
        if (activeLogger !== undefined) activeLogger.warn(warning);
        else console.warn("[task-registry] " + warning);
      }
    }
  }

  #assertAllowed(record: TaskRecord, to: TaskStatus): void {
    const allowed = ALLOWED_TRANSITIONS[record.status];
    if (!allowed.includes(to)) {
      const from = allowed.length === 0 ? "<terminal>" : allowed.join(", ");
      throw new Error(
        `illegal transition for task ${record.id}: ${record.status} -> ${to} ` +
          `(allowed from ${record.status}: ${from})`,
      );
    }
  }

  async #loadOrThrow(taskId: ULID): Promise<TaskRecord> {
    if (!isUsableTaskId(taskId)) {
      throw new Error("transition: taskId is required");
    }
    const record = await this.#storage.loadTask(taskId);
    if (record === null) {
      throw new Error(`transition: unknown taskId ${taskId}`);
    }
    return record;
  }

  /**
   * A transition can be driven by a caller that never spawned the task (a child close event,
   * the stop tool). Reuse the caller's existing subscription when present; otherwise open one
   * at this event so the transition is observable instead of silently dropped.
   */
  async #ensureSubscription(
    subscriberId: ULID,
    taskId: ULID,
    now: number,
    cursor: ULID,
  ): Promise<void> {
    const existing = await this.#storage.loadSubscription(subscriberId, taskId);
    if (existing !== null) {
      return;
    }
    await this.#storage.saveSubscription({
      subscriberId,
      taskId,
      cursor,
      status: "active",
      createdAt: now,
    });
    this.#logger?.warn(
      `subscription: auto-created for subscriber ${subscriberId} on task ${taskId} at cursor ${cursor}`,
    );
  }

  /**
   * Build one TaskEvent. `outputPreview` is inlined only when the payload is <= 2048 bytes
   * (ADR-0022 §7); otherwise the renderer must dereference `outputRef`.
   */
  #makeEvent(
    taskId: ULID,
    subscriberId: ULID,
    status: TaskStatus,
    nowMs: number,
    record: TaskRecord,
  ): TaskEvent {
    const outputBytes = record.outputBytes;
    const outputPreview =
      outputBytes !== undefined && outputBytes <= OUTPUT_PREVIEW_MAX_BYTES
        ? record.outputPreview
        : undefined;
    return {
      eventId: this.#ulid.next(),
      subscriptionId: subscriberId,
      taskId,
      type: emitKey(taskId, status),
      status,
      transitionAtMs: nowMs,
      outputBytes,
      outputPreview,
    };
  }

  /** The spawn caller is the subscription owner; fall back to the task id if unrecorded. */
  #ownerSubscriber(record: TaskRecord): string {
    const callerId = record.spawnSource.callerId;
    return callerId.length > 0 ? callerId : record.id;
  }
}

/** Convenience factory for the default implementation. */
export function createTaskRegistry(
  storage: TaskStorage,
  options: TaskRegistryOptions,
): TaskRegistry {
  return new DefaultTaskRegistry(storage, options);
}
