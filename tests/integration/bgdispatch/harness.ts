/**
 * Shared harness for the BG-10 background-dispatch INTEGRATION suite (ADR-0022).
 *
 * This is a deterministic IN-PROCESS integration suite, NOT an end-to-end suite: it wires the
 * real BG modules together but never spawns a `pi` subprocess. The real end-to-end coverage
 * (an actual `pi` child, a real SIGTERM to a live OS process) lives in
 * `tests/e2e/bgdispatch.test.ts` and is opt-in via `PT_DISPATCH_E2E=1`.
 *
 * Every scenario runs against the REAL modules:
 *   - `DefaultTaskRegistry` (BG-02) over a real `TaskStorage` (BG-01; `InMemoryTaskStorage`
 *     by default, a `FileTaskStorage` for the restart simulation),
 *   - the real `DefaultNotificationPipeline` (BG-05),
 *   - the real `dispatch({ background: true })` branch (BG-04) with a
 *     `MockChildProcessLifecycle` (BG-03),
 *   - a fake clock for every TaskRecord / Subscription / TaskEvent timestamp,
 *   - an `InMemoryOutputStorage` (BG-07).
 *
 * No real `pi` process and no real timers. The one fs touch the dispatch branch makes is the
 * agent-markdown lookup and the prompt tmpfile; both are intercepted by the `node:fs` mock at
 * the top of this module, so the suite is hermetic. (The restart simulation additionally uses a
 * `FileTaskStorage`, which reaches `node:fs/promises` directly under a temp dir it owns — that
 * is deliberate: a fresh process must read real persisted files.) Completion is driven with
 * `setImmediate` flushes (a macrotask, not a timer).
 */
import { vi } from "vitest";
import { DispatchSlotCounter, dispatch, type DispatchDeps } from "../../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../../src/runtime/child-process-lifecycle.ts";
import {
  DefaultTaskRegistry,
  type DispatchHandle,
  type RegistryLogger,
  type TaskRegistry,
} from "../../../src/runtime/task-registry.ts";
import { DefaultNotificationPipeline } from "../../../src/runtime/notification-pipeline.ts";
import { InMemoryOutputStorage, type OutputStorage } from "../../../src/runtime/output-storage.ts";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
  type TaskStorage,
  type ULID,
} from "../../../src/runtime/task-storage.ts";
import {
  createPtcTaskStopTool,
  type AnyTool,
  type PtcTaskStopDetails,
} from "../../../src/tools/ptc-task.ts";

// ---------------------------------------------------------------------------
//  node:fs mock: agent markdown + prompt tmpfile stay in memory
// ---------------------------------------------------------------------------

const fsMock = vi.hoisted(() => ({
  agentName: "integration-bg-agent",
  agentMd: "---\nname: integration-bg-agent\n---\nYou are the background integration agent.\n",
  tempDir: "/tmp/pi-integration-bgdispatch",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, options?: unknown): unknown => {
    if (String(path).endsWith(fsMock.agentName + ".md")) return fsMock.agentMd;
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options);
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    readFileSync,
    unlinkSync: (() => undefined) as unknown as typeof actual.unlinkSync,
    rmdirSync: (() => undefined) as unknown as typeof actual.rmdirSync,
    promises: {
      ...actual.promises,
      mkdtemp: (async () => fsMock.tempDir) as unknown as typeof actual.promises.mkdtemp,
      writeFile: (async () => undefined) as unknown as typeof actual.promises.writeFile,
    },
  };
});

export const AGENT_NAME: string = fsMock.agentName;
export const CWD: string = "/integration/work";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

// ---------------------------------------------------------------------------
//  fake clock
// ---------------------------------------------------------------------------

export interface FakeClock {
  clock: () => number;
  set: (ms: number) => void;
  advance: (ms: number) => void;
}

export function createFakeClock(start: number): FakeClock {
  let current = start;
  return {
    clock: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
//  recording lifecycle
// ---------------------------------------------------------------------------

export class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  /** Handles keyed by the R1 `session-id` the background branch stamps (= the task id). */
  readonly byTask: Map<string, ChildHandle> = new Map();

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    if (typeof opts.sessionId === "string" && opts.sessionId.length > 0) {
      this.byTask.set(opts.sessionId, handle);
    }
    return handle;
  }

  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }

  /**
   * The child handle for one task. Keyed by task id (not spawn order) so a wave of
   * concurrently-spawning tasks still resolves each child to its own record.
   */
  handleForTask(taskId: string): ChildHandle {
    const handle = this.byTask.get(taskId);
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle for task " + taskId);
    }
    return handle;
  }
}

// ---------------------------------------------------------------------------
//  harness
// ---------------------------------------------------------------------------

export interface Harness {
  storage: TaskStorage;
  registry: TaskRegistry;
  pipeline: DefaultNotificationPipeline;
  lifecycle: RecordingLifecycle;
  outputStorage: OutputStorage;
  slots: DispatchSlotCounter;
  clock: FakeClock;
  deps: DispatchDeps;
  callerId: string;
  /** Per-dispatch subscriber id keyed by task id (see spawnTask). */
  subscribers: Map<ULID, string>;
  /** Monotonic dispatch-call counter backing the per-call subscriber id. */
  nextCallId: number;
  sessionDir: string;
  /** Every event handed to the idle-wake handler, in delivery order. */
  delivered: { subscriberId: string; event: TaskEvent }[];
  /** Events per non-empty idle wake, so a test can assert "drains in one wake" (ADR-0022 §6). */
  wakeBatches: number[];
}

export interface HarnessOptions {
  concurrency?: number;
  callerId?: string;
  start?: number;
  /**
   * Inject a pre-existing storage. The restart scenario passes a second `FileTaskStorage`
   * over the same directory so the fresh registry/pipeline read the persisted records — the
   * same shape a new process sees.
   */
  storage?: TaskStorage;
  /** Share a clock across a simulated restart so persisted timestamps stay deterministic. */
  clock?: FakeClock;
  /** Inject a capturing/failing logger so a test can assert the failure path is surfaced. */
  logger?: RegistryLogger;
  /** Override the output store (e.g. one whose write fails) to exercise the persistence path. */
  outputStorage?: OutputStorage;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const storage = options.storage ?? new InMemoryTaskStorage();
  const clock = options.clock ?? createFakeClock(options.start ?? 1_000);
  const registry = new DefaultTaskRegistry(storage, { clock: clock.clock });
  const pipeline = new DefaultNotificationPipeline(storage, { now: clock.clock });
  const lifecycle = new RecordingLifecycle();
  const outputStorage = options.outputStorage ?? new InMemoryOutputStorage();
  const slots = new DispatchSlotCounter(options.concurrency ?? 8);
  const callerId = options.callerId ?? "integration-run";
  const deps: DispatchDeps = {
    taskRegistry: registry,
    lifecycle,
    slots,
    clock: clock.clock,
    outputStorage,
  };
  if (options.logger !== undefined) deps.logger = options.logger;
  const h: Harness = {
    storage,
    registry,
    pipeline,
    lifecycle,
    outputStorage,
    slots,
    clock,
    deps,
    callerId,
    subscribers: new Map(),
    nextCallId: 1,
    sessionDir: "/integration/sessions",
    delivered: [],
    wakeBatches: [],
  };
  pipeline.onIdleWake((subscriberId, events) => {
    h.wakeBatches.push(events.length);
    for (const event of events) h.delivered.push({ subscriberId, event });
  });
  return h;
}

// ---------------------------------------------------------------------------
//  spawn / complete / stop / reconcile
// ---------------------------------------------------------------------------

export interface SpawnedTask {
  handle: DispatchHandle;
  child: ChildHandle;
}

export interface SpawnOptions {
  task?: string;
  label?: string;
  depth?: number;
  /**
   * Override the subscriber id for this dispatch. Production uses ONE run-level subscriber
   * (`callerId: runId`) for every task in a run; the default here gives each dispatch its own
   * subscriber so the in-memory adapter's per-subscriber event log stays small.
   */
  callerId?: string;
}

export async function spawnTask(h: Harness, options: SpawnOptions = {}): Promise<SpawnedTask> {
  // ADR-0022 §5: the subscriber is the task's owner. By default the suite gives each dispatch
  // call its own subscriber (the documented `dispatch:<callId>` default) because the in-memory
  // adapter keeps one event log per subscriber; the run-level scenario overrides callerId so a
  // single subscriber owns N tasks, which is the configuration production actually ships.
  const callId = h.nextCallId;
  h.nextCallId += 1;
  const callerId = options.callerId ?? h.callerId + "-" + String(callId);
  const result = await dispatch(
    {
      agent: AGENT_NAME,
      task: options.task ?? "integration task",
      background: true,
      agentScope: "project",
      ...(options.label === undefined ? {} : { label: options.label }),
    },
    {
      callId,
      cwd: CWD,
      depth: options.depth ?? 0,
      maxDispatchDepth: 3,
      sessionDir: h.sessionDir,
      callerId,
    },
    h.deps,
  );
  if (!("taskId" in result)) {
    throw new Error("spawn refused: " + (result.errorMessage ?? "unknown reason"));
  }
  h.subscribers.set(result.taskId, callerId);
  return { handle: result, child: h.lifecycle.handleForTask(result.taskId) };
}

/** The subscriber that owns one task (ADR-0022 §5, "Subscriber == owner"). */
export function callerFor(h: Harness, taskId: ULID): ULID {
  const subscriberId = h.subscribers.get(taskId);
  if (subscriberId === undefined) {
    throw new Error("callerFor: unknown task " + taskId);
  }
  return subscriberId as ULID;
}

/**
 * Resolve a task's owner across a simulated process restart: the in-memory map is empty in the
 * fresh process, so fall back to the owner persisted on the TaskRecord (`spawnSource.callerId`).
 */
async function ownerFor(h: Harness, taskId: ULID): Promise<ULID> {
  const fromMap = h.subscribers.get(taskId);
  if (fromMap !== undefined) return fromMap as ULID;
  const record = await h.storage.loadTask(taskId);
  if (record === null) {
    throw new Error("ownerFor: unknown task " + taskId);
  }
  return record.spawnSource.callerId as ULID;
}

export async function waitForTerminal(h: Harness, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await h.storage.loadTask(taskId);
    if (record !== null && TERMINAL.has(record.status)) return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

export async function completeTask(
  h: Harness,
  spawned: SpawnedTask,
  exitCode = 0,
  // A child that exits 0 in these scenarios is a child that answered: pi emits the assistant
  // text on `message_end` before a clean close, and that is the same `PONG` literal the
  // real-spawn e2e and the unit suite use. Since issue #70 an exit-0 child with *no* text
  // resolves `failed`, so leaving this undefined would silently turn every `completeTask(…, 0)`
  // caller — which means "succeeded" — into a failure fixture. Pass `""` deliberately to get a
  // silent child back.
  output = "PONG",
): Promise<TaskRecord> {
  if (output !== undefined) {
    h.lifecycle.pushEvent(spawned.child, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: output }] },
    });
  }
  return await settleExit(h, spawned, exitCode, null);
}

/**
 * Close a mock child with an explicit `(code, signal)`. The stopped-task scenarios pass a signal
 * (matching a real SIGTERM/SIGKILL close) so the terminal `canceled` is driven by a signal close,
 * not a clean exit that would resolve `succeeded`/`failed` from the code.
 */
export async function settleExit(
  h: Harness,
  spawned: SpawnedTask,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<TaskRecord> {
  h.clock.advance(5);
  h.lifecycle.resolveExit(spawned.child, code, signal);
  return await waitForTerminal(h, spawned.handle.taskId);
}

/** Drive the real `ptc_task_stop` tool (ADR-0022 §8) against one live task. */
export async function stopTask(
  h: Harness,
  spawned: SpawnedTask,
  reason = "integration stop",
): Promise<PtcTaskStopDetails> {
  const tool: AnyTool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });
  const result = (await tool.execute(
    "integration-stop",
    { taskId: spawned.handle.taskId, reason },
    undefined,
    undefined,
    undefined as never,
  )) as { details: PtcTaskStopDetails };
  return result.details;
}

/** Push a raw agent event onto a task's mock child (malformed-event scenarios). */
export function pushEvent(h: Harness, spawned: SpawnedTask, event: ParsedAgentEvent): void {
  h.lifecycle.pushEvent(spawned.child, event);
}

export async function reconcile(h: Harness): Promise<TaskRecord[]> {
  return await h.registry.reconcileLostTasks();
}

export async function recordsOf(h: Harness): Promise<TaskRecord[]> {
  return await h.registry.query({ limit: Number.MAX_SAFE_INTEGER });
}

// ---------------------------------------------------------------------------
//  wave drivers (respect the ADR-0022 §9 hard cap)
// ---------------------------------------------------------------------------

/** Spawn up to `count` tasks in waves of the run's concurrency limit. */
export async function spawnWave(
  h: Harness,
  count: number,
  options: SpawnOptions = {},
): Promise<SpawnedTask[]> {
  // One wave of LIVE tasks: every task keeps its slot until its own terminal transition, so a
  // second slice cannot be admitted under the same cap. Fail loudly instead of letting the
  // background branch refuse the overflow with a concurrency error; use `runWaves` to
  // spawn+complete across multiple waves.
  const free = h.slots.limit - h.slots.active;
  if (count > free) {
    throw new Error(
      "spawnWave admits live tasks only: " +
        String(count) +
        " requested but " +
        String(free) +
        " slot(s) free; use runWaves for multi-wave spawn/complete",
    );
  }
  // The background branch acquires its slot before its first await, so a whole wave can be
  // admitted at once; Promise.all overlaps the per-spawn IO instead of serializing it.
  return await Promise.all(
    Array.from({ length: count }, (_unused, index) =>
      spawnTask(h, { task: "wave-" + String(index), ...options }),
    ),
  );
}

/** Poll until every task in one wave has persisted a terminal status. */
async function waitForWaveTerminal(h: Harness, wave: readonly SpawnedTask[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let pending = 0;
    for (const spawned of wave) {
      const record = await h.storage.loadTask(spawned.handle.taskId);
      if (record === null || !TERMINAL.has(record.status)) pending += 1;
    }
    if (pending === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("runWaves: a wave did not reach terminal");
}

/**
 * Spawn `count` tasks in waves, completing each wave with `exitCodeFor`. The exits in a wave
 * are resolved together so the detached pumps settle concurrently — the sequential
 * per-task wait is the slow path the largest scenarios cannot afford.
 */
export async function runWaves(
  h: Harness,
  count: number,
  exitCodeFor: (index: number) => number = () => 0,
  options: SpawnOptions = {},
): Promise<SpawnedTask[]> {
  const done: SpawnedTask[] = [];
  while (done.length < count) {
    const size = Math.min(h.slots.limit, count - done.length);
    const offset = done.length;
    const wave = await Promise.all(
      Array.from({ length: size }, (_unused, index) =>
        spawnTask(h, { task: "run-" + String(offset + index), ...options }),
      ),
    );
    for (const spawned of wave) {
      const exitCode = exitCodeFor(done.length);
      // A child that exits 0 answers first, same as completeTask: pi emits the assistant
      // message_end before a clean close, and since issue #70 an exit-0 child with no text
      // resolves failed. A non-zero exit gets no text — that is what a killed child looks like.
      if (exitCode === 0) {
        h.lifecycle.pushEvent(spawned.child, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
        });
      }
      h.clock.advance(5);
      h.lifecycle.resolveExit(spawned.child, exitCode, null);
      done.push(spawned);
    }
    await waitForWaveTerminal(h, wave);
  }
  return done;
}

// ---------------------------------------------------------------------------
//  delivery
// ---------------------------------------------------------------------------

/** One idle wake for one task: drain, run the handler, then acknowledge (ADR-0022 §6). */
export async function deliverTask(h: Harness, taskId: ULID): Promise<TaskEvent[]> {
  const subscriberId = await ownerFor(h, taskId);
  const events = await h.pipeline.notifyIdle(subscriberId, taskId);
  const last = events[events.length - 1];
  if (last !== undefined) {
    await h.pipeline.acknowledgeEvents(subscriberId, taskId, last.eventId);
  }
  return events;
}

/** Deliver every task's pending events, newest record first. */
export async function deliverAll(h: Harness): Promise<TaskEvent[]> {
  const records = await recordsOf(h);
  const out: TaskEvent[] = [];
  for (const record of records) {
    out.push(...(await deliverTask(h, record.id)));
  }
  return out;
}

export function countTerminalEvents(events: readonly TaskEvent[], status: TaskStatus): number {
  return events.filter((event) => event.type.endsWith(":->" + status)).length;
}

export function countRunningEvents(events: readonly TaskEvent[]): number {
  return events.filter((event) => event.type.endsWith(":running")).length;
}
