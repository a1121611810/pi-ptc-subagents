/**
 * BackgroundTaskRuntime: the session-scoped holder for everything a `ptc_task_*` tool and the
 * background branch of `pi.dispatch` need (BG-14, ADR-0022 §3/§5/§6/§8/§9).
 *
 * ## Why a holder
 *
 * The two model-facing background surfaces are built ONCE, at extension-factory time, before any
 * session exists:
 *
 *   - the three `ptc_task_*` tools take a `TaskRegistry` / `OutputStorage` in their constructors;
 *   - the two PTC tools forward a `DispatchDeps` bag to `runPtcProgram` so a program's
 *     `pi.dispatch({ background: true })` writes into the real session registry instead of the
 *     process-global in-memory fallback in `dispatch.ts`.
 *
 * A pi session, however, starts later (`session_start`) and can be re-bound (resume / fork). This
 * holder closes that gap: `registry` / `outputStorage` / `pipeline` are STABLE delegating objects
 * the tools capture, and `bindSession` swaps the per-session delegate underneath them. Before the
 * first bind they delegate to an in-memory pair, so a session-less context (direct library use,
 * unit tests) is fully usable.
 *
 * ## One slot counter for the whole session
 *
 * `slots` is ONE `DispatchSlotCounter(concurrency)` for the holder, not a per-run counter. The
 * dispatcher's background branch acquires from `dispatchDeps.slots` and the pump releases at the
 * terminal transition, so a long-lived child keeps counting against `dispatchConcurrency`
 * (ADR-0022 §9) across program boundaries.
 *
 * ## Delivery is metadata-only
 *
 * `drainNotifications` joins each pending `TaskEvent` to its `TaskRecord` and returns
 * `TaskNotificationItem[]` for the (pure) BG-15 renderer. It advances the subscription cursor only
 * after the caller has the items, so an at-least-once drain is possible but a delivered batch is
 * not re-delivered forever. The actual pi send lives in `src/index.ts` (the only place that may
 * call `pi.*`), reached through the pipeline's registered idle-wake handler.
 *
 * ## Known limitation: reconcile is not per-record tolerant
 *
 * `TaskRegistry.reconcileLostTasks()` drives its sweep through `TaskStorage.listTasks()`. The BG-13
 * file adapter deliberately THROWS on a record file that exists but does not parse (a missing file
 * is "absent"; a corrupt one is an explicit error). One corrupt `tasks/<id>.json` therefore
 * aborts the whole reconcile, so no other stale `running` record is marked `lost` on that
 * startup. `bindSession` treats that as best-effort-but-visible: it warns, reports through the
 * caller's notifier, and still returns a usable session. The real fix — skip + warn per record
 * inside the storage adapter — is deferred to a deliberate BG-13 follow-up.
 */

import {
  RealChildProcessLifecycle,
  type ChildExitValue,
  type ChildHandle,
  type ChildProcessLifecycle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "./child-process-lifecycle.ts";
import { DispatchSlotCounter, killWithEscalation, type DispatchDeps } from "./dispatch.ts";
import { DEFAULT_CONFIG } from "./limits.ts";
import {
  DefaultNotificationPipeline,
  type IdleWakeHandler,
  type NotificationPipeline,
} from "./notification-pipeline.ts";
import { FileOutputStorage, InMemoryOutputStorage, type OutputStorage } from "./output-storage.ts";
import {
  createTaskRegistry,
  type LostReason,
  type RegistryLogger,
  type TaskCommand,
  type TaskQuery,
  type TaskRegistry,
  type TaskTransitionObserver,
  type TransitionContext,
  type TransitionResult,
} from "./task-registry.ts";
import { createFileTaskStorage } from "./task-storage-file.ts";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskRecord,
  type TaskStorage,
  type TaskStatus,
  type ULID,
} from "./task-storage.ts";
import type { TaskNotificationItem } from "./task-notification.ts";

/** Records that can no longer transition; a terminal transition is a completion notification. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

/** The two non-terminal states the shutdown sweep reclaims (ADR-0022 §2 recovery edge). */
const NON_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["running", "stopping"]);

/** A query cap large enough to see every record in one session. */
const ALL_TASKS_LIMIT = Number.MAX_SAFE_INTEGER;

/** Best-effort reporter for a bind failure; the index notifies the user from it. */
export type BackgroundBindReporter = (message: string) => void;

/**
 * Construction seams. Production passes nothing; tests inject the clock, the storage factories
 * (to force IO failures) and the child lifecycle (to avoid spawning a real `pi`).
 */
export interface BackgroundRuntimeOptions {
  clock?: () => number;
  logger?: RegistryLogger;
  /** Factory for the per-session storage root; defaults to the BG-13 file adapter. */
  createStorage?: (sessionDir: string | undefined) => TaskStorage;
  createOutputStorage?: (sessionDir: string | undefined) => OutputStorage;
  concurrency?: number;
  /** Child lifecycle factory; defaults to the real `node:child_process` adapter. */
  createLifecycle?: () => ChildProcessLifecycle;
}

/**
 * The holder. `registry` / `outputStorage` / `pipeline` are stable objects safe to capture
 * before any session exists; `bindSession` swaps the session delegate underneath them.
 */
export interface BackgroundTaskRuntime {
  readonly registry: TaskRegistry;
  readonly outputStorage: OutputStorage;
  readonly pipeline: NotificationPipeline;
  readonly slots: DispatchSlotCounter;
  readonly lifecycle: ChildProcessLifecycle;
  /** Stable deps the two PTC tools hand to `runPtcProgram` (ADR-0022 §9). */
  readonly dispatchDeps: DispatchDeps;
  /** Session clock (`Date.now` unless injected); passed to `ptc_task_stop`. */
  readonly clock: () => number;
  /**
   * (Re)bind to a session: build the session storage/registry/pipeline, swap the delegates, then
   * reconcile. Returns the records marked `lost`. A bind failure (storage construction or the
   * reconcile sweep) is reported via `reporter` and the logger, and leaves the previous delegate
   * usable; it never rejects and never partially swaps.
   */
  bindSession(
    sessionDir: string | undefined,
    reporter?: BackgroundBindReporter,
  ): Promise<TaskRecord[]>;
  /** Drain undelivered events for a subscriber as `{event, record}` pairs ready for the renderer. */
  drainNotifications(subscriberId: ULID): Promise<TaskNotificationItem[]>;
  /** Mark every non-terminal task lost (given reason) and release resources. */
  shutdown(reason: LostReason): Promise<TaskRecord[]>;
}

/** Default warn surface: a bind failure must never vanish silently (testing-constraints #3). */
const DEFAULT_RUNTIME_LOGGER: RegistryLogger = {
  info: (): void => undefined,
  warn: (message: string): void => {
    console.warn("[pi-ptc.background] " + message);
  },
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<in-memory>` in a warning when no session dir was available. */
function describeDir(sessionDir: string | undefined): string {
  return sessionDir === undefined || sessionDir.length === 0 ? "<in-memory>" : sessionDir;
}

/** The spawn owner (`spawnSource.callerId`), falling back to the task id for an ownerless record. */
function ownerOf(record: TaskRecord): ULID {
  const callerId = record.spawnSource.callerId;
  return (callerId.length > 0 ? callerId : record.id) as ULID;
}

// ---------------------------------------------------------------------------
//  Stable delegating adapters
// ---------------------------------------------------------------------------

/** `TaskRegistry` whose concrete delegate is swapped by `bindSession` (never re-created). */
class StableTaskRegistry implements TaskRegistry {
  #current: TaskRegistry;

  constructor(initial: TaskRegistry) {
    this.#current = initial;
  }

  setCurrent(next: TaskRegistry): void {
    this.#current = next;
  }

  transition(command: TaskCommand, ctx: TransitionContext): Promise<TransitionResult> {
    return this.#current.transition(command, ctx);
  }

  query(view: TaskQuery): Promise<TaskRecord[]> {
    return this.#current.query(view);
  }

  get(taskId: ULID): Promise<TaskRecord | null> {
    return this.#current.get(taskId);
  }

  onTransition(observer: TaskTransitionObserver): () => void {
    return this.#current.onTransition(observer);
  }

  advanceCursor(
    subscriberId: ULID,
    taskId: ULID,
    cursor: ULID,
    events: TaskEvent[],
  ): Promise<void> {
    return this.#current.advanceCursor(subscriberId, taskId, cursor, events);
  }

  loadEventLog(subscriptionId: ULID, since?: ULID): Promise<TaskEvent[]> {
    return this.#current.loadEventLog(subscriptionId, since);
  }

  reconcileLostTasks(): Promise<TaskRecord[]> {
    return this.#current.reconcileLostTasks();
  }
}

/** `OutputStorage` whose concrete delegate is swapped by `bindSession`. */
class StableOutputStorage implements OutputStorage {
  #current: OutputStorage;

  constructor(initial: OutputStorage) {
    this.#current = initial;
  }

  setCurrent(next: OutputStorage): void {
    this.#current = next;
  }

  readOutput(taskId: ULID): Promise<string | null> {
    return this.#current.readOutput(taskId);
  }

  writeOutput(taskId: ULID, content: string): Promise<void> {
    return this.#current.writeOutput(taskId, content);
  }

  outputRef(taskId: ULID): string {
    return this.#current.outputRef(taskId);
  }
}

/**
 * `NotificationPipeline` whose concrete delegate is swapped by `bindSession`. The registered
 * idle-wake handlers are held here (not on the delegate) so they survive a rebind; the concrete
 * `notifyIdle` trigger is exposed for the runtime's terminal observer.
 */
class StableNotificationPipeline implements NotificationPipeline {
  #current: DefaultNotificationPipeline;
  readonly #handlers: IdleWakeHandler[] = [];

  constructor(initial: DefaultNotificationPipeline) {
    this.#current = initial;
  }

  setCurrent(next: DefaultNotificationPipeline): void {
    this.#current = next;
    for (const handler of this.#handlers) next.onIdleWake(handler);
  }

  subscribe(subscriberId: ULID, taskId: ULID, since?: ULID) {
    return this.#current.subscribe(subscriberId, taskId, since);
  }

  drainPending(subscriberId: ULID, taskId: ULID): Promise<TaskEvent[]> {
    return this.#current.drainPending(subscriberId, taskId);
  }

  acknowledgeEvents(subscriberId: ULID, taskId: ULID, untilCursor: ULID): Promise<void> {
    return this.#current.acknowledgeEvents(subscriberId, taskId, untilCursor);
  }

  onIdleWake(handler: IdleWakeHandler): void {
    this.#handlers.push(handler);
    this.#current.onIdleWake(handler);
  }

  pendingCount(subscriberId: ULID, taskId: ULID): Promise<number> {
    return this.#current.pendingCount(subscriberId, taskId);
  }

  /** The dispatcher-facing wake trigger (delegates to the current session pipeline). */
  notifyIdle(subscriberId: ULID, taskId: ULID): Promise<TaskEvent[]> {
    return this.#current.notifyIdle(subscriberId, taskId);
  }
}

/**
 * `ChildProcessLifecycle` that records every spawned handle so `shutdown` can reap the session's
 * live children through the shared SIGTERM -> grace -> SIGKILL ladder. A handle is forgotten as
 * soon as its `exit()` resolves (the child has closed).
 */
class TrackingLifecycle implements ChildProcessLifecycle {
  readonly #delegate: ChildProcessLifecycle;
  readonly #live = new Set<ChildHandle>();

  constructor(delegate: ChildProcessLifecycle) {
    this.#delegate = delegate;
  }

  spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = this.#delegate.spawn(argv, opts);
    this.#live.add(handle);
    return handle;
  }

  kill(handle: ChildHandle, signal: "SIGTERM" | "SIGKILL"): void {
    this.#delegate.kill(handle, signal);
  }

  events(handle: ChildHandle): AsyncIterable<ParsedAgentEvent> {
    return this.#delegate.events(handle);
  }

  async exit(handle: ChildHandle): Promise<ChildExitValue> {
    try {
      return await this.#delegate.exit(handle);
    } finally {
      this.#live.delete(handle);
    }
  }

  stderr(handle: ChildHandle): Promise<string> {
    return this.#delegate.stderr(handle);
  }

  liveHandles(): readonly ChildHandle[] {
    return [...this.#live];
  }
}

// ---------------------------------------------------------------------------
//  Implementation
// ---------------------------------------------------------------------------

class DefaultBackgroundTaskRuntime implements BackgroundTaskRuntime {
  readonly registry: StableTaskRegistry;
  readonly outputStorage: StableOutputStorage;
  readonly pipeline: StableNotificationPipeline;
  readonly slots: DispatchSlotCounter;
  readonly lifecycle: TrackingLifecycle;
  readonly dispatchDeps: DispatchDeps;
  readonly clock: () => number;

  readonly #logger: RegistryLogger;
  readonly #createStorage: (sessionDir: string | undefined) => TaskStorage;
  readonly #createOutputStorage: (sessionDir: string | undefined) => OutputStorage;
  /** True once `shutdown` has run; a second call is a no-op and the observer stops notifying. */
  #shutdown = false;

  constructor(options: BackgroundRuntimeOptions) {
    this.clock = options.clock ?? ((): number => Date.now());
    this.#logger = options.logger ?? DEFAULT_RUNTIME_LOGGER;
    this.#createStorage =
      options.createStorage ??
      ((sessionDir) =>
        sessionDir === undefined || sessionDir.length === 0
          ? new InMemoryTaskStorage()
          : createFileTaskStorage(sessionDir));
    this.#createOutputStorage =
      options.createOutputStorage ??
      ((sessionDir) =>
        sessionDir === undefined || sessionDir.length === 0
          ? new InMemoryOutputStorage()
          : new FileOutputStorage(sessionDir));

    // The pre-session delegate is always in-memory, so the tools/dispatch path are usable before
    // any session exists and a session-less test never touches the filesystem.
    const initialStorage = new InMemoryTaskStorage();
    const initialRegistry = createTaskRegistry(initialStorage, {
      clock: this.clock,
      logger: this.#logger,
    });
    const initialPipeline = new DefaultNotificationPipeline(initialStorage, {
      now: this.clock,
      logger: this.#logger,
    });
    this.registry = new StableTaskRegistry(initialRegistry);
    this.outputStorage = new StableOutputStorage(new InMemoryOutputStorage());
    this.pipeline = new StableNotificationPipeline(initialPipeline);
    this.lifecycle = new TrackingLifecycle(
      (options.createLifecycle ?? ((): ChildProcessLifecycle => new RealChildProcessLifecycle()))(),
    );
    this.slots = new DispatchSlotCounter(options.concurrency ?? DEFAULT_CONFIG.dispatchConcurrency);
    this.dispatchDeps = {
      taskRegistry: this.registry,
      lifecycle: this.lifecycle,
      slots: this.slots,
      outputStorage: this.outputStorage,
      clock: this.clock,
      logger: this.#logger,
    };
    this.registry.onTransition(this.#handleTransition);
  }

  /**
   * Wake the delivery layer when a task reaches a terminal state (ADR-0022 §6/§8). The observer
   * fires synchronously inside `registry.transition` after the write is persisted; the drain is
   * async, so it is detached with an explicit catch rather than left as an unhandled rejection.
   */
  readonly #handleTransition: TaskTransitionObserver = (record, event) => {
    if (this.#shutdown) return;
    if (!TERMINAL_STATUSES.has(record.status)) return;
    void this.pipeline.notifyIdle(event.subscriptionId, record.id).catch((error: unknown) => {
      this.#logger.warn(
        "terminal notification wake for task " + record.id + " failed: " + messageOf(error),
      );
    });
  };

  async bindSession(
    sessionDir: string | undefined,
    reporter?: BackgroundBindReporter,
  ): Promise<TaskRecord[]> {
    let storage: TaskStorage;
    let outputStorage: OutputStorage;
    try {
      storage = this.#createStorage(sessionDir);
      outputStorage = this.#createOutputStorage(sessionDir);
    } catch (error) {
      this.#report(
        "background runtime: session storage for " +
          describeDir(sessionDir) +
          " is unavailable: " +
          messageOf(error),
        reporter,
      );
      return [];
    }

    const sessionRegistry = createTaskRegistry(storage, {
      clock: this.clock,
      logger: this.#logger,
    });
    const sessionPipeline = new DefaultNotificationPipeline(storage, {
      now: this.clock,
      logger: this.#logger,
    });
    // Commit the swap only after both session adapters were built, so a partial bind cannot leave
    // the holder pointing at a half-constructed session.
    this.registry.setCurrent(sessionRegistry);
    this.outputStorage.setCurrent(outputStorage);
    this.pipeline.setCurrent(sessionPipeline);
    this.#shutdown = false;

    try {
      // The terminal observer is attached only AFTER the sweep: the caller delivers the returned
      // lost records explicitly, and attaching it earlier would race that explicit delivery
      // (both would drain the same not-yet-acked lost event).
      return await sessionRegistry.reconcileLostTasks();
    } catch (error) {
      // Reconcile aborts on the first corrupt record (see the module note); surface it and keep
      // the session usable instead of failing the whole startup.
      this.#report(
        "background runtime: startup reconcile failed; stale running tasks were not all marked lost " +
          "(reconcile is not per-record tolerant yet): " +
          messageOf(error),
        reporter,
      );
      return [];
    } finally {
      this.registry.onTransition(this.#handleTransition);
    }
  }

  async drainNotifications(subscriberId: ULID): Promise<TaskNotificationItem[]> {
    let records: TaskRecord[];
    try {
      records = await this.registry.query({ limit: ALL_TASKS_LIMIT });
    } catch (error) {
      this.#logger.warn(
        "drainNotifications: could not list tasks for subscriber " +
          subscriberId +
          ": " +
          messageOf(error),
      );
      return [];
    }

    const items: TaskNotificationItem[] = [];
    for (const record of records) {
      if (record.spawnSource.callerId !== subscriberId) continue;
      let events: TaskEvent[];
      try {
        events = await this.pipeline.drainPending(subscriberId, record.id);
      } catch (error) {
        // A record without a subscription (or a storage read failure) must not swallow the rest
        // of the subscriber's events; report it and continue (testing-constraints #3).
        this.#logger.warn(
          "drainNotifications: task " +
            record.id +
            " for subscriber " +
            subscriberId +
            ": " +
            messageOf(error),
        );
        continue;
      }
      for (const event of events) items.push({ event, record });
      const last = events[events.length - 1];
      if (last === undefined) continue;
      try {
        await this.pipeline.acknowledgeEvents(subscriberId, record.id, last.eventId);
      } catch (error) {
        this.#logger.warn(
          "drainNotifications: could not acknowledge task " + record.id + ": " + messageOf(error),
        );
      }
    }
    return items;
  }

  async shutdown(reason: LostReason): Promise<TaskRecord[]> {
    if (this.#shutdown) return [];
    this.#shutdown = true;

    let records: TaskRecord[];
    try {
      records = await this.registry.query({ limit: ALL_TASKS_LIMIT });
    } catch (error) {
      this.#logger.warn("shutdown: could not list tasks: " + messageOf(error));
      records = [];
    }

    const lost: TaskRecord[] = [];
    for (const record of records) {
      if (!NON_TERMINAL_STATUSES.has(record.status)) continue;
      try {
        const result = await this.registry.transition(
          { kind: "reconcile-lost", taskId: record.id, reason },
          { clock: this.clock, callerId: ownerOf(record), logger: this.#logger },
        );
        lost.push(result.record);
      } catch (error) {
        this.#logger.warn(
          "shutdown: could not mark task " + record.id + " lost: " + messageOf(error),
        );
      }
    }

    // Reap every live child with the one shared ladder (ADR-0022 §8; dispatch.ts owns the grace
    // number). Detached escalation is unref'd so teardown cannot hang the host.
    for (const handle of this.lifecycle.liveHandles()) {
      killWithEscalation(this.lifecycle, handle, { unref: true });
    }
    // One held slot per reclaimed task (ADR-0022 §9); release is idempotent, so a later pump
    // release cannot underflow the counter.
    for (const _record of lost) this.slots.release();

    return lost;
  }

  /** Warn through the logger and the caller's notifier; a throwing notifier is never fatal. */
  #report(message: string, reporter?: BackgroundBindReporter): void {
    this.#logger.warn(message);
    if (reporter === undefined) return;
    try {
      reporter(message);
    } catch (error) {
      this.#logger.warn("bindSession reporter threw: " + messageOf(error));
    }
  }
}

/** Convenience factory for the default holder. */
export function createBackgroundTaskRuntime(
  options: BackgroundRuntimeOptions = {},
): BackgroundTaskRuntime {
  return new DefaultBackgroundTaskRuntime(options);
}
