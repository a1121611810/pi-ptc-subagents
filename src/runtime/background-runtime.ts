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
 * dispatcher's background branch acquires from `dispatchDeps.slots`, keyed by the minted task id,
 * and releases at the terminal transition, so a long-lived child keeps counting against
 * `dispatchConcurrency` (ADR-0022 §9) across program boundaries.
 *
 * ## Slot release ownership
 *
 * The task id is the slot token. The detached pump owns the normal release (in its `finally`),
 * and `shutdown` also releases the same token when it reclaims a still-running task; the release
 * is idempotent per task, so exactly one slot is freed no matter which party runs first. A stale
 * pump release therefore cannot free a slot that a different live task now holds.
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
 *
 * ## Task ownership (ADR-0023)
 *
 * Every background child is spawned with `--session-dir <parentSessionDir>` (ADR-0022 §1/R1), so
 * the child's pi process SHARES the parent's `<sessionDir>/tasks/` storage, and any pi process
 * started in the same cwd reaps the same dir. Pre-ADR-0023 that was lethal: the child's startup
 * reconcile and its `session_shutdown` sweep were dir-wide, so a child flipped its parent's
 * records (and its own) to `lost` — field-report pitfall #3. This holder therefore mints ONE
 * {@link TaskOwner} identity (`pid` + runtime-start `bootMs`) and hands it to every registry it
 * binds: registered records are stamped with it, the startup reconcile reaps only records whose
 * owner pid is dead (legacy ownerless records count as pre-upgrade stale), and `shutdown` reaps
 * only records matching the full identity. Visibility is unchanged — `ptc_task_list` still lists
 * every record in the shared dir; only reaping is owner-scoped.
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
  isOwnRecord,
  isPidAlive,
  type LostReason,
  type RegistryLogger,
  type TaskCommand,
  type TaskOwner,
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

/** One cursor to advance after a drained batch has actually been delivered. */
export interface NotificationAck {
  subscriberId: ULID;
  taskId: ULID;
  cursor: ULID;
  /**
   * The concrete session pipeline this drain READ from, carried so the ack lands on the same
   * session even if a rebind happens between the drain and the send (P1). Without it the ack goes
   * through the stable proxy's *current* delegate and targets a session that never knew the
   * subscription, leaving the original cursor unadvanced and re-delivering the batch.
   */
  sink: NotificationPipeline;
}

/**
 * One drain: the events to render plus the cursors the caller acknowledges after a successful
 * send. The split is what lets a failed send leave the cursor unadvanced (ADR-0022 §5/§6).
 */
export interface NotificationDrain {
  items: TaskNotificationItem[];
  acks: readonly NotificationAck[];
}

/**
 * Construction seams. Production passes nothing; tests inject the clock, the storage factories
 * (to force IO failures) and the child lifecycle (to avoid spawning a real `pi`).
 */
export interface BackgroundRuntimeOptions {
  clock?: () => number;
  logger?: RegistryLogger;
  /** Factory for the per-session storage root; defaults to the BG-13 file adapter. */
  createStorage?: (sessionDir: string | undefined) => TaskStorage;
  /**
   * Factory for the PRE-SESSION storage root; defaults to `new InMemoryTaskStorage()`.
   *
   * The pre-session registry, notification pipeline and output storage are all built from ONE
   * storage, and it used to be constructed in place, so a caller could not substitute it. That is
   * the seam behind round 7's finding: five `logger.warn` calls in cleanup paths (526 / 594 / 616 /
   * 663 / 683) could not be driven by any test -- not because the tests were missing, but because
   * the failure they report cannot be produced at all.
   *
   * An optional field on THIS options object, defaulting to today's behaviour, is the whole change;
   * a deps-less caller is unaffected. Deliberately a field and not a module-level global with an
   * exported setter: the setter shape (`setPromptFileWriter`) had to be defended as being tree-shaken
   * out of the bundle, an argument that has to be re-made on every release. A field needs no defence.
   */
  createInitialStorage?: () => TaskStorage;
  createOutputStorage?: (sessionDir: string | undefined) => OutputStorage;
  concurrency?: number;
  /** Child lifecycle factory; defaults to the real `node:child_process` adapter. */
  createLifecycle?: () => ChildProcessLifecycle;
  /**
   * ADR-0023: this runtime instance's owner identity, stamped on every record it registers.
   * Defaults to `{ pid: process.pid, bootMs: clock() }` — minted ONCE here, so every session
   * registry the runtime binds (initial, session, rebind) shares one identity and a rebind
   * cannot make the startup reconcile reap the runtime's own in-flight tasks.
   */
  owner?: TaskOwner;
  /**
   * ADR-0023: pid liveness probe for the startup reconcile; defaults to the real signal-0
   * {@link isPidAlive}. Tests inject a table-driven probe for the ownership matrix.
   */
  isPidAlive?: (pid: number) => boolean;
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
  drainNotifications(subscriberId: ULID): Promise<NotificationDrain>;
  /**
   * Advance the subscription cursor for a drained batch. The caller invokes this ONLY after the
   * batch's message was actually delivered (ADR-0022 §5/§6); a failed send leaves the cursor
   * where it was so the next drain re-delivers the event.
   */
  acknowledgeNotifications(acks: readonly NotificationAck[]): Promise<void>;
  /**
   * Mark every non-terminal task this runtime OWNS lost (given reason) and release resources.
   * ADR-0023: records owned by another runtime instance — e.g. a sibling pi process sharing
   * the session dir — are never reaped here, and their children are never signaled.
   */
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
  /**
   * Owning registry per task, captured at spawn. A task's later transitions (notably the detached
   * pump's resolve-exit) route to the registry that persisted it, so a session rebind cannot
   * re-route an in-flight terminal write to a registry that never knew the task (S9). Reads
   * (query/get) intentionally stay on the current session.
   *
   * Boundedness (review 3, P2): the map holds one small entry per spawned task for the process
   * lifetime. It is only consulted for non-spawn transitions, which end at the task's terminal
   * write, so a terminal transition could prune it -- but nothing observes that pruning, so it is
   * left as an accepted v1 bound rather than an untested change. A session that spawns N tasks
   * retains N tiny entries; that is deliberate, not an oversight.
   */
  readonly #owners = new Map<ULID, TaskRegistry>();

  constructor(initial: TaskRegistry) {
    this.#current = initial;
  }

  setCurrent(next: TaskRegistry): void {
    this.#current = next;
  }

  async transition(command: TaskCommand, ctx: TransitionContext): Promise<TransitionResult> {
    const owner =
      command.kind === "spawn"
        ? this.#current
        : (this.#owners.get(command.taskId) ?? this.#current);
    const result = await owner.transition(command, ctx);
    if (command.kind === "spawn") this.#owners.set(result.record.id, owner);
    return result;
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

  /**
   * The concrete session pipeline. `drainNotifications` captures it so a drain and its later ack
   * are pinned to one session even across a rebind (P1); the proxy's other methods keep routing to
   * whatever session is current.
   */
  current(): NotificationPipeline {
    return this.#current;
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
  /**
   * Shutdown-owned SIGKILL escalations, keyed by the handle they would signal. exit() invokes
   * the matching cancel as soon as the child is known to have closed, so the timer cannot fire
   * against a reaped handle (A4).
   */
  readonly #reapCancels = new Map<ChildHandle, () => void>();

  constructor(delegate: ChildProcessLifecycle) {
    this.#delegate = delegate;
  }

  /** Whether the child is still live from this adapter's point of view. */
  isLive(handle: ChildHandle): boolean {
    return this.#live.has(handle);
  }

  /** Register shutdown's escalation cancel for one handle; exit() runs it once the child closes. */
  trackReapCancel(handle: ChildHandle, cancel: () => void): void {
    this.#reapCancels.set(handle, cancel);
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
      // The child has closed: clear any shutdown escalation before its timer can fire.
      const cancel = this.#reapCancels.get(handle);
      if (cancel !== undefined) {
        this.#reapCancels.delete(handle);
        cancel();
      }
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
  /** ADR-0023: this instance's owner identity, minted once and shared by every session registry. */
  readonly #owner: TaskOwner;
  /** ADR-0023: pid liveness probe backing the startup reconcile's owner-dead check. */
  readonly #isPidAlive: (pid: number) => boolean;
  /** True once `shutdown` has run; a second call is a no-op and the observer stops notifying. */
  #shutdown = false;

  constructor(options: BackgroundRuntimeOptions) {
    this.clock = options.clock ?? ((): number => Date.now());
    this.#logger = options.logger ?? DEFAULT_RUNTIME_LOGGER;
    this.#owner = options.owner ?? { pid: process.pid, bootMs: this.clock() };
    this.#isPidAlive = options.isPidAlive ?? isPidAlive;
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
    const initialStorage = (
      options.createInitialStorage ?? ((): TaskStorage => new InMemoryTaskStorage())
    )();
    const initialRegistry = createTaskRegistry(initialStorage, {
      clock: this.clock,
      logger: this.#logger,
      owner: this.#owner,
      isPidAlive: this.#isPidAlive,
    });
    const initialPipeline = new DefaultNotificationPipeline(initialStorage, {
      now: this.clock,
      logger: this.#logger,
    });
    this.registry = new StableTaskRegistry(initialRegistry);
    this.outputStorage = new StableOutputStorage(new InMemoryOutputStorage());
    this.pipeline = new StableNotificationPipeline(initialPipeline);
    // The session logger is threaded into the production lifecycle so a child that emits a
    // non-JSON stdout line warns through the same surface as every other background failure
    // (testing-constraints #3) instead of being silently dropped.
    this.lifecycle = new TrackingLifecycle(
      (
        options.createLifecycle ??
        ((): ChildProcessLifecycle => new RealChildProcessLifecycle({ logger: this.#logger }))
      )(),
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
      owner: this.#owner,
      isPidAlive: this.#isPidAlive,
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

  async drainNotifications(subscriberId: ULID): Promise<NotificationDrain> {
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
      return { items: [], acks: [] };
    }

    const items: TaskNotificationItem[] = [];
    const acks: NotificationAck[] = [];
    // Pin the whole drain to the session that is current NOW, so the caller's later ack cannot be
    // re-routed by a rebind between the read and the send (P1).
    const sink = this.pipeline.current();
    for (const record of records) {
      if (record.spawnSource.callerId !== subscriberId) continue;
      let events: TaskEvent[];
      try {
        events = await sink.drainPending(subscriberId, record.id);
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
      // Do NOT acknowledge here: the cursor advances only after the caller's send succeeds.
      acks.push({ subscriberId, taskId: record.id, cursor: last.eventId, sink });
    }
    return { items, acks };
  }

  /**
   * Advance the cursor for a delivered drain. Called by the delivery layer AFTER the batch was
   * sent; a send failure therefore leaves the cursor untouched and the next drain re-delivers.
   */
  async acknowledgeNotifications(acks: readonly NotificationAck[]): Promise<void> {
    for (const ack of acks) {
      try {
        // Use the sink the drain read from, not the proxy's current session (P1).
        await ack.sink.acknowledgeEvents(ack.subscriberId, ack.taskId, ack.cursor);
      } catch (error) {
        this.#logger.warn(
          "acknowledgeNotifications: could not acknowledge task " +
            ack.taskId +
            ": " +
            messageOf(error),
        );
      }
    }
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
      // ADR-0023 (task ownership): reap ONLY records this runtime instance owns. A record
      // owned by a sibling pi process sharing the session dir (every background dispatch child
      // shares it via --session-dir) survives this sweep — pre-fix, a child's exit sweep flipped
      // the parent's still-running siblings to `session_ended_while_running` (field-report
      // pitfall #3).
      if (!isOwnRecord(record, this.#owner)) continue;
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
    // number). Detached escalation is unref'd so teardown cannot hang the host. isDone is bound
    // to the handle's liveness and the cancel is registered so a child that closes clears the
    // SIGKILL timer instead of letting it fire against a reaped handle (A4, mirroring the pump).
    for (const handle of this.lifecycle.liveHandles()) {
      const cancel = killWithEscalation(this.lifecycle, handle, {
        isDone: () => !this.lifecycle.isLive(handle),
        unref: true,
      });
      this.lifecycle.trackReapCancel(handle, cancel);
    }
    // ADR-0022 §9 slot ownership: the background branch acquires the slot keyed by the task
    // id, and BOTH this shutdown sweep and the task's detached pump release that same token.
    // The release is idempotent PER TASK, so whichever runs second is a no-op; without the key
    // a stale pump release could free a slot now held by a different live task.
    for (const record of lost) this.slots.release(record.id);

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
