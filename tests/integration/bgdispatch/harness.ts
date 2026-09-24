/**
 * Shared harness for the BG-10 background-dispatch e2e suite (ADR-0022).
 *
 * Every scenario runs against the REAL modules:
 *   - `DefaultTaskRegistry` (BG-02) over a real `InMemoryTaskStorage` (BG-01),
 *   - the real `DefaultNotificationPipeline` (BG-05),
 *   - the real `dispatch({ background: true })` branch (BG-04) with a
 *     `MockChildProcessLifecycle` (BG-03),
 *   - a fake clock for every TaskRecord / Subscription / TaskEvent timestamp,
 *   - an `InMemoryOutputStorage` (BG-07).
 *
 * No real `pi` process, no real task/output filesystem and no real timers. The one fs touch
 * the dispatch branch makes is the agent-markdown lookup and the prompt tmpfile; both are
 * intercepted by the `node:fs` mock at the top of this module, so the suite is hermetic.
 * Completion is driven with `setImmediate` flushes (a macrotask, not a timer).
 */
import { vi } from "vitest";
import {
  DispatchSlotCounter,
  dispatch,
  type DispatchDeps,
} from "../../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
  type ParsedAgentEvent,
} from "../../../src/runtime/child-process-lifecycle.ts";
import {
  DefaultTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../../src/runtime/task-registry.ts";
import { DefaultNotificationPipeline } from "../../../src/runtime/notification-pipeline.ts";
import { InMemoryOutputStorage } from "../../../src/runtime/output-storage.ts";
import {
  InMemoryTaskStorage,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
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
  agentName: "e2e-bg-agent",
  agentMd: "---\nname: e2e-bg-agent\n---\nYou are the background e2e agent.\n",
  tempDir: "/tmp/pi-e2e-bgdispatch",
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
export const CWD: string = "/e2e/work";

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
  storage: InMemoryTaskStorage;
  registry: TaskRegistry;
  pipeline: DefaultNotificationPipeline;
  lifecycle: RecordingLifecycle;
  outputStorage: InMemoryOutputStorage;
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
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const clock = createFakeClock(options.start ?? 1_000);
  const registry = new DefaultTaskRegistry(storage, { clock: clock.clock });
  const pipeline = new DefaultNotificationPipeline(storage, { now: clock.clock });
  const lifecycle = new RecordingLifecycle();
  const outputStorage = new InMemoryOutputStorage();
  const slots = new DispatchSlotCounter(options.concurrency ?? 8);
  const callerId = options.callerId ?? "e2e-run";
  const deps: DispatchDeps = {
    taskRegistry: registry,
    lifecycle,
    slots,
    clock: clock.clock,
    outputStorage,
  };
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
    sessionDir: "/e2e/sessions",
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
}

export async function spawnTask(h: Harness, options: SpawnOptions = {}): Promise<SpawnedTask> {
  // ADR-0022 §5: the subscriber is the task's owner. The suite gives each dispatch call its
  // own subscriber (the documented `dispatch:<callId>` default) because the in-memory adapter
  // keeps one event log per subscriber; a single run-level log would make delivering N tasks
  // O(N^2). Run-level subscriber threading is covered by tests/unit/dispatch-wiring.test.ts.
  const callId = h.nextCallId;
  h.nextCallId += 1;
  const callerId = h.callerId + "-" + String(callId);
  const result = await dispatch(
    {
      agent: AGENT_NAME,
      task: options.task ?? "e2e task",
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
  output?: string,
): Promise<TaskRecord> {
  if (output !== undefined) {
    h.lifecycle.pushEvent(spawned.child, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: output }] },
    });
  }
  h.clock.advance(5);
  h.lifecycle.resolveExit(spawned.child, exitCode, null);
  return await waitForTerminal(h, spawned.handle.taskId);
}

/** Drive the real `ptc_task_stop` tool (ADR-0022 §8) against one live task. */
export async function stopTask(
  h: Harness,
  spawned: SpawnedTask,
  reason = "e2e stop",
): Promise<PtcTaskStopDetails> {
  const tool: AnyTool = createPtcTaskStopTool(h.registry, h.lifecycle, { clock: h.clock.clock });
  const result = (await tool.execute(
    "e2e-stop",
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
export async function spawnWave(h: Harness, count: number): Promise<SpawnedTask[]> {
  const out: SpawnedTask[] = [];
  while (out.length < count) {
    const size = Math.min(h.slots.limit, count - out.length);
    const offset = out.length;
    // The background branch acquires its slot before its first await, so a whole wave can
    // be admitted at once; Promise.all overlaps the per-spawn IO instead of serializing it.
    const wave = await Promise.all(
      Array.from({ length: size }, (_unused, index) =>
        spawnTask(h, { task: "wave-" + String(offset + index) }),
      ),
    );
    out.push(...wave);
  }
  return out;
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
): Promise<SpawnedTask[]> {
  const done: SpawnedTask[] = [];
  while (done.length < count) {
    const size = Math.min(h.slots.limit, count - done.length);
    const offset = done.length;
    const wave = await Promise.all(
      Array.from({ length: size }, (_unused, index) =>
        spawnTask(h, { task: "run-" + String(offset + index) }),
      ),
    );
    for (const spawned of wave) {
      h.clock.advance(5);
      h.lifecycle.resolveExit(spawned.child, exitCodeFor(done.length), null);
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
  const subscriberId = callerFor(h, taskId);
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
