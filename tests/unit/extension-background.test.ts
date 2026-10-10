/**
 * BG-14 acceptance tests: the extension factory wires a session-scoped background runtime and
 * registers the three `ptc_task_*` tools always-on.
 *
 * These drive the REAL factory (`ptcSubagents`) through the recording ExtensionAPI stub — the
 * same entry points pi calls — and assert on observables only:
 *   - the five registered tool names (registration happens at factory time, before any session);
 *   - `pi.setActiveTools` after /ptc on + /ptc off (the three tools must survive the mode);
 *   - the registered `ptc_task_list.execute` output against a task the dispatch path wrote;
 *   - the notification strings actually handed to `sendUserMessage` / `sendMessage`;
 *   - the warning delivered through `ctx.ui.notify` when a bind fails.
 *
 * The runtime is injected through `PtcSubagentsOptions.backgroundRuntime` so the child lifecycle
 * is the mock adapter and no real `pi` subprocess is spawned; production omits the option.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ptcSubagents from "../../src/index.ts";
import {
  createBackgroundTaskRuntime,
  type BackgroundTaskRuntime,
} from "../../src/runtime/background-runtime.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import { dispatch, type DispatchResult } from "../../src/runtime/dispatch.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskRecord,
} from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage, type ULID } from "../../src/runtime/task-storage.ts";
import {
  DEFAULT_SESSION_TOOLS,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  stubContext,
  type ExtensionStub,
} from "../helpers/ptc.ts";
import type { PtcTaskListDetails } from "../../src/tools/ptc-task.ts";

const TASK_RUNNING = "01JBZ000000000000000000001" as ULID;
const OWNER = "run-prev";
const AGENT = "bg-extension-probe";
const AGENT_MD = "---\nname: " + AGENT + "\n---\nYou probe.\n";

/** The three always-on tools (ADR-0022 "What we deliver" #6). */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;
/** The two PTC surfaces; the helper appends these itself. */
const PTC_TOOLS = ["ptc_run_code", "ptc_workflow"] as const;
/** What a real session has active: pi's four defaults plus all five extension tools. */
const ACTIVE = [...DEFAULT_SESSION_TOOLS, ...TASK_TOOLS, ...PTC_TOOLS];
/** ADR-0032 / #101: the report tool. Registered in every surface; active only in a child. */
const REPORT_TOOL = "ptc_child_report" as const;
/** The full registration set. */
const REGISTERED = [...PTC_TOOLS, ...TASK_TOOLS, REPORT_TOOL];
/** The active list passed to the stub; the helper appends the two PTC surfaces itself. */
const STUB_ACTIVE = [...DEFAULT_SESSION_TOOLS, ...TASK_TOOLS];

class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];
  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }
}

function spawnRecord(
  callerId: string,
): Omit<TaskRecord, "id" | "status" | "createdAt" | "transitionAt"> {
  return {
    label: "seeded task",
    agentName: "researcher",
    depth: 0,
    startedAt: 1_000,
    finishedAt: undefined,
    durationMs: undefined,
    outputRef: undefined,
    outputBytes: undefined,
    outputPreview: undefined,
    stopReason: undefined,
    errorMessage: undefined,
    exitCode: undefined,
    spawnSource: { kind: "ptc-program", callerId },
    parentTaskId: undefined,
    sessionFile: undefined,
  };
}

async function seedRunningTask(
  storage: InMemoryTaskStorage,
  taskId: ULID,
  owner: string,
): Promise<void> {
  const registry = createTaskRegistry(storage, { clock: () => 1_000 });
  await registry.transition(
    {
      kind: "spawn",
      handle: { taskId, label: "seeded task", status: "running" },
      record: spawnRecord(owner),
    },
    { clock: () => 1_000, callerId: owner },
  );
}

/**
 * ADR-0023: seed a record owned by a DIFFERENT runtime instance (foreign-owned), as a sibling
 * pi process sharing this session dir would have written it.
 */
async function seedForeignRunningTask(
  storage: InMemoryTaskStorage,
  taskId: ULID,
  owner: string,
  foreignOwner: { pid: number; bootMs: number },
): Promise<void> {
  const registry = createTaskRegistry(storage, { clock: () => 1_000, owner: foreignOwner });
  await registry.transition(
    {
      kind: "spawn",
      handle: { taskId, label: "seeded task", status: "running" },
      record: spawnRecord(owner),
    },
    { clock: () => 1_000, callerId: owner },
  );
}

async function withAgent<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTempDir();
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), AGENT_MD, { encoding: "utf-8" });
    return await body(dir);
  } finally {
    await removeTempDir(dir);
  }
}

function asHandle(value: DispatchHandle | DispatchResult): DispatchHandle {
  if (!("taskId" in value))
    throw new Error("expected a DispatchHandle, got " + JSON.stringify(value));
  return value;
}

/** Spawn one background child through the holder's dispatch deps (no real pi process). */
async function spawnBackground(
  runtime: BackgroundTaskRuntime,
  dir: string,
  callId: number,
): Promise<DispatchHandle> {
  return asHandle(
    await dispatch(
      { agent: AGENT, task: "background wiring", background: true, agentScope: "project" },
      { callId, cwd: dir, depth: 0, maxDispatchDepth: 3, callerId: "run-" + String(callId) },
      runtime.dispatchDeps,
    ),
  );
}

/** Flush microtasks until `predicate` holds (the delivery path is async by design). */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not met");
}

/** A stub with a controlled runtime, its storage and its mock child lifecycle. */
async function wiredStub(): Promise<{
  stub: ExtensionStub;
  runtime: BackgroundTaskRuntime;
  lifecycle: RecordingLifecycle;
  storage: InMemoryTaskStorage;
}> {
  const storage = new InMemoryTaskStorage();
  const lifecycle = new RecordingLifecycle();
  const runtime = createBackgroundTaskRuntime({
    createStorage: () => storage,
    createLifecycle: () => lifecycle,
    // The seeded "previous session" spawns at t=1000; this new session binds at t=2000. Real
    // time advances across a restart, and the registry mints event ids with a time prefix, so a
    // frozen equal clock would make the new lost event's ordering relative to the persisted
    // cursor depend on a random sequence — a flaky test, not the production shape.
    clock: () => 2_000,
  });
  // The helper fires `session_start` itself, which binds the runtime to the session dir and
  // runs the startup reconcile. The tests below seed their records AFTER this and emit their own
  // `session_start`, so the reconcile they are about is the one that follows the seed.
  const stub = await makeExtensionStub({
    active: STUB_ACTIVE,
    sessionDir: "/sessions/wired",
    backgroundRuntime: runtime,
  });
  return { stub, runtime, lifecycle, storage };
}

// ---------------------------------------------------------------------------
//  Registration + always-on
// ---------------------------------------------------------------------------

describe("always-on registration", () => {
  test("session_start registers the two PTC tools, the three task tools and the report tool", async () => {
    const stub = await makeExtensionStub();
    expect([...stub.tools.keys()]).toEqual(REGISTERED);
    for (const name of TASK_TOOLS) {
      const tool = stub.tools.get(name);
      expect(tool).toBeDefined();
      expect(typeof tool?.execute).toBe("function");
    }
  });

  test("/ptc on and /ptc off cannot remove the three tools from the loadout", async () => {
    const { stub } = await wiredStub();
    const ctx = stubContext(stub);

    // Registered before any session exists.
    for (const name of TASK_TOOLS) expect(stub.tools.has(name)).toBe(true);

    await stub.emit("session_start", ctx);
    for (const name of TASK_TOOLS) expect(stub.active).toContain(name);

    const command = stub.commands.get("ptc");
    if (command === undefined) throw new Error("ptc command missing");
    await command.handler("off", ctx);
    // The spec: /ptc off only gates new spawn, it does not hide the lifecycle face.
    for (const name of TASK_TOOLS) expect(stub.active).toContain(name);
    expect(stub.active).toEqual(ACTIVE);

    await command.handler("on", ctx);
    for (const name of TASK_TOOLS) expect(stub.active).toContain(name);
    // The narrowed loadout is exactly the five PTC tools (built-ins hidden, extension tools kept).
    expect(stub.active).toEqual([...TASK_TOOLS, ...PTC_TOOLS]);
  });

  test("the factory body never calls pi.* (R2): it only subscribes handlers", () => {
    const registered: string[] = [];
    const calls: string[] = [];
    const subscribed: string[] = [];
    const api = {
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
      registerCommand: () => undefined,
      on: (event: string) => {
        subscribed.push(event);
        return () => undefined;
      },
      setActiveTools: () => calls.push("setActiveTools"),
      appendEntry: () => calls.push("appendEntry"),
      sendMessage: () => calls.push("sendMessage"),
      sendUserMessage: () => calls.push("sendUserMessage"),
      getActiveTools: () => [...ACTIVE],
    } as unknown as ExtensionAPI;

    // Pinned for the same reason every other factory-driven test is: this one builds the factory
    // directly, and with the `surfaceMode` key gone nothing short-circuits the detection any
    // more, so an unpinned axis reads the developer's real agent-dir settings. Found in review
    // round 2 -- a stale surface key in a temp agent dir made this test fail for a reason
    // unrelated to what it checks, and removing the key moved that failure onto the switch and
    // activation axes rather than removing it. All three are named, and they name `full`
    // (`REGISTERED` has no `ptc_subagent`, which only `subagents` registers).
    ptcSubagents(api, {
      codemode: { present: true, how: "found" },
      codemodeSwitch: { switch: "enabled", source: "user" },
      // "loadout" is the only provenance a real session_start produces: activation is read
      // from `pi.getActiveTools()`, so no user file, project file or argv is left to name.
      codemodeActivation: { activation: "inactive", source: "loadout" },
    });

    expect(calls).toEqual([]);
    // Registration moved into `session_start`, so the factory body registers NO tool — it only
    // subscribes. The old version of this test asserted `registered` equalled `REGISTERED`,
    // which pinned the factory-time registration that no longer exists; a body that went back to
    // registering at load time (which is what pi's own loading window forbids, since
    // `getActiveTools()` throws there) is what this now catches.
    expect(registered, "the factory body registers nothing; session_start does").toEqual([]);
    expect(subscribed, "and session_start is where it goes instead").toContain("session_start");
  });
});

// ---------------------------------------------------------------------------
//  Same registry as the dispatch path
// ---------------------------------------------------------------------------

describe("registered ptc_task_list reads the dispatch-path registry", () => {
  test("a task spawned through the holder is returned by the registered tool", async () => {
    await withAgent(async (dir) => {
      const { stub, runtime } = await wiredStub();
      const ctx = stubContext(stub);
      await stub.emit("session_start", ctx);
      const handle = await spawnBackground(runtime, dir, 11);

      const tool = stub.tools.get("ptc_task_list");
      if (tool === undefined) throw new Error("ptc_task_list was not registered");
      const result = (await tool.execute(
        "call-1",
        {},
        undefined,
        undefined,
        undefined as never,
      )) as {
        details: PtcTaskListDetails;
      };

      expect(result.details.count).toBe(1);
      expect(result.details.tasks.map((record) => record.id)).toEqual([handle.taskId]);
      expect(result.details.tasks[0]?.status).toBe("running");
    });
  });
});

// ---------------------------------------------------------------------------
//  Reconcile -> delivery
// ---------------------------------------------------------------------------

describe("startup reconcile is delivered through the notification path", () => {
  test("session_start marks a stale running task lost and sends the lost notification", async () => {
    const { stub, runtime, storage } = await wiredStub();
    await seedRunningTask(storage, TASK_RUNNING, OWNER);
    const ctx = stubContext(stub);

    await stub.emit("session_start", ctx);
    await waitFor(() => stub.sentUserMessages.length > 0);

    // Reconcile happened on the session registry the tools/dispatch now share.
    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("lost");
    // The lost record reached the model through the one notification path (ADR §8, no bespoke one).
    expect(stub.sentUserMessages).toHaveLength(1);
    const content = stub.sentUserMessages[0]?.content ?? "";
    expect(content).toContain("<bg-task-notifications");
    expect(content).toContain('task-id="' + TASK_RUNNING + '"');
    expect(content).toContain('status="lost"');
    expect(content).toContain('id="task:' + TASK_RUNNING + ':->lost"');
    // Nothing was sent through the mid-turn channel.
    expect(stub.sentMessages).toEqual([]);
  });

  test("a clean startup sends nothing (an empty batch is never rendered or sent)", async () => {
    const { stub } = await wiredStub();
    await stub.emit("session_start", stubContext(stub));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stub.sentUserMessages).toEqual([]);
    expect(stub.sentMessages).toEqual([]);
  });

  test("session_start leaves a foreign-owned record whose owner pid is alive running (ADR-0023)", async () => {
    const { stub, runtime, storage } = await wiredStub();
    // A sibling pi process (here: an older runtime instance in this same pid, bootMs 1) wrote
    // this record into the shared dir. Its owner is alive, so the startup reconcile must skip
    // it — pre-ADR-0023 the dir-wide sweep flipped it to lost and sent a spurious notification
    // (field-report pitfall #3, the child's boot killing the parent's records).
    await seedForeignRunningTask(storage, TASK_RUNNING, OWNER, { pid: process.pid, bootMs: 1 });
    const ctx = stubContext(stub);

    await stub.emit("session_start", ctx);
    // Flush the (async) delivery path so a stray lost notification would have landed.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("running");
    expect(stub.sentUserMessages).toEqual([]);
    expect(stub.sentMessages).toEqual([]);
  });

  test("a send failure leaves the cursor unadvanced so the next drain re-delivers", async () => {
    const { stub, storage } = await wiredStub();
    await seedRunningTask(storage, TASK_RUNNING, OWNER);
    const ctx = stubContext(stub);

    let failSend = true;
    const api = stub.api as unknown as {
      sendUserMessage: (content: string, options?: unknown) => void;
    };
    const originalSendUserMessage = api.sendUserMessage.bind(stub.api);
    api.sendUserMessage = (content: string, options?: unknown) => {
      if (failSend) throw new Error("simulated send failure");
      originalSendUserMessage(content, options);
    };

    await stub.emit("session_start", ctx);
    // The send threw, so nothing was delivered and the cursor must not have advanced (ADR §5/§6).
    expect(stub.sentUserMessages).toEqual([]);

    failSend = false;
    await stub.emit("agent_settled", ctx);
    // The unacknowledged lost event was re-drained and delivered on the retry.
    expect(stub.sentUserMessages).toHaveLength(1);
    expect(stub.sentUserMessages[0]?.content).toContain('task-id="' + TASK_RUNNING + '"');
  });
});

// ---------------------------------------------------------------------------
//  Delivery channel: idle vs mid-turn
// ---------------------------------------------------------------------------

describe("terminal delivery channel follows turn activity", () => {
  test("an idle completion wakes through sendUserMessage", async () => {
    await withAgent(async (dir) => {
      const { stub, runtime, lifecycle } = await wiredStub();
      const ctx = stubContext(stub);
      await stub.emit("session_start", ctx);
      const handle = await spawnBackground(runtime, dir, 21);

      // The child answers before it closes: an exit-0 child with no assistant text is
      // `failed` (issue #70), and the notification would then say so.
      lifecycle.pushEvent(lifecycle.spawned[0] as ChildHandle, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      lifecycle.resolveExit(lifecycle.spawned[0] as ChildHandle, 0, null);
      await waitFor(() => stub.sentUserMessages.length > 0);

      expect(stub.sentMessages).toEqual([]);
      expect(stub.sentUserMessages).toHaveLength(1);
      const content = stub.sentUserMessages[0]?.content ?? "";
      expect(content).toContain('task-id="' + handle.taskId + '"');
      expect(content).toContain('status="succeeded"');
    });
  });

  test("a completion that lands mid-turn steers through sendMessage", async () => {
    await withAgent(async (dir) => {
      const { stub, runtime, lifecycle } = await wiredStub();
      const ctx = stubContext(stub);
      await stub.emit("session_start", ctx);
      await stub.emit("turn_start", ctx);
      const handle = await spawnBackground(runtime, dir, 31);

      lifecycle.resolveExit(lifecycle.spawned[0] as ChildHandle, 0, null);
      await waitFor(() => stub.sentMessages.length > 0);

      expect(stub.sentUserMessages).toEqual([]);
      expect(stub.sentMessages).toHaveLength(1);
      expect(stub.sentMessages[0]?.customType).toBe("bg-task-notification");
      expect(stub.sentMessages[0]?.options?.deliverAs).toBe("steer");
      expect(stub.sentMessages[0]?.content).toContain('task-id="' + handle.taskId + '"');
    });
  });

  test("agent_settled drains anything a mid-turn delivery deferred", async () => {
    await withAgent(async (dir) => {
      const { stub, runtime, lifecycle } = await wiredStub();
      const ctx = stubContext(stub);
      await stub.emit("session_start", ctx);
      // turn_start then turn_end without settling: a completion delivered mid-turn is acked
      // through the steer channel, so agent_settled must send nothing more.
      await stub.emit("turn_start", ctx);
      await spawnBackground(runtime, dir, 41);
      lifecycle.resolveExit(lifecycle.spawned[0] as ChildHandle, 0, null);
      await waitFor(() => stub.sentMessages.length > 0);
      await stub.emit("agent_settled", ctx);

      expect(stub.sentUserMessages).toEqual([]);
      expect(stub.sentMessages).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
//  IO failure surfacing (constraint #1/#3)
// ---------------------------------------------------------------------------

describe("bind failures are visible", () => {
  test("a storage-construction failure during session_start notifies the user and the session starts", async () => {
    const warnings: string[] = [];
    const runtime = createBackgroundTaskRuntime({
      logger: { info: () => undefined, warn: (message) => warnings.push(message) },
      createStorage: () => {
        throw new Error("session storage unavailable");
      },
      createLifecycle: () => new RecordingLifecycle(),
    });
    const stub = await makeExtensionStub({
      active: STUB_ACTIVE,
      sessionDir: "/sessions/bad",
      backgroundRuntime: runtime,
    });
    const ctx = stubContext(stub);

    await stub.emit("session_start", ctx);

    expect(warnings.some((message) => message.includes("session storage unavailable"))).toBe(true);
    const warning = stub.notifications.find((entry) => entry.type === "warning");
    expect(warning?.message).toContain("session storage unavailable");
    // The session is still usable: the tools are registered and the mode still entered.
    for (const name of TASK_TOOLS) expect(stub.tools.has(name)).toBe(true);
    expect(stub.notifications.some((entry) => entry.message.includes("PTC mode on"))).toBe(true);
  });

  test("a corrupt-record reconcile failure notifies the user and still registers the tools", async () => {
    class CorruptStorage extends InMemoryTaskStorage {
      override async *listTasks(): AsyncIterable<TaskRecord> {
        yield* [] as TaskRecord[];
        throw new Error("FileTaskStorage: corrupt JSON in tasks/bad.json");
      }
    }
    const runtime = createBackgroundTaskRuntime({
      // The warning is asserted through ctx.ui.notify below; keep the test output quiet.
      logger: { info: () => undefined, warn: () => undefined },
      createStorage: () => new CorruptStorage(),
      createLifecycle: () => new RecordingLifecycle(),
    });
    const stub = await makeExtensionStub({
      active: STUB_ACTIVE,
      sessionDir: "/sessions/corrupt",
      backgroundRuntime: runtime,
    });
    const ctx = stubContext(stub);

    await stub.emit("session_start", ctx);

    const warning = stub.notifications.find((entry) => entry.type === "warning");
    expect(warning?.message).toContain("corrupt JSON");
    for (const name of TASK_TOOLS) expect(stub.tools.has(name)).toBe(true);
    expect(stub.sentUserMessages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
//  session_shutdown
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
  test("shuts the runtime down (marks tasks lost) and tolerates a repeated event", async () => {
    const { stub, runtime, storage } = await wiredStub();
    await seedRunningTask(storage, TASK_RUNNING, OWNER);
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);

    await stub.emit("session_shutdown", ctx);

    expect((await runtime.registry.get(TASK_RUNNING))?.status).toBe("lost");
    // Repeat is a no-op, not a throw.
    await expect(stub.emit("session_shutdown", ctx)).resolves.toBeDefined();
  });
});
