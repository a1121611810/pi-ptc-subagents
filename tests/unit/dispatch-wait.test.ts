/**
 * ADR-0055 / ticket #239: `wait` is ONE parameter on ONE path.
 *
 * The retired `background` flag was a MODE SWITCH: two dispatch paths, two sets of gates, two
 * refusal vocabularies, and a default that meant "wait for the answer". `wait` is neither a mode
 * nor a second door — it is one boolean on the one path, and its default is to NOT wait.
 *
 * SPECIFICATION tests, not characterization (docs/testing-constraints.md #4/#6): every expectation
 * traces to a literal in ticket #239 or to an invariant in ADR-0055, and every test states the
 * counterfactual that would turn it red.
 *
 * Dependencies are injected (docs/testing-constraints.md #1): the child is a
 * `MockChildProcessLifecycle`, the record store is an `InMemoryTaskStorage`, and the concurrency
 * counter is a `DispatchSlotCounter` with a limit the test chooses — so no real `pi` process is
 * spawned and no timing is left to the wall clock except where a test says so.
 */
import { describe, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DispatchSlotCounter,
  dispatch,
  isDispatchHandle,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import {
  MockChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  createTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import { makeTempDir, removeTempDir, waitFor } from "../helpers/ptc.ts";

const AGENT = "wait-probe";
const AGENT_MD = "---\nname: wait-probe\n---\nYou probe.\n";

/** Records every handle the dispatch spawns, so a test can drive its exit. */
class RecordingLifecycle extends MockChildProcessLifecycle {
  readonly spawned: ChildHandle[] = [];

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    return handle;
  }

  handleAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("RecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }
}

interface Harness {
  storage: InMemoryTaskStorage;
  registry: TaskRegistry;
  lifecycle: RecordingLifecycle;
  slots: DispatchSlotCounter;
  deps: DispatchDeps;
}

function createHarness(options: { limit?: number } = {}): Harness {
  const storage = new InMemoryTaskStorage();
  const registry = createTaskRegistry(storage, { clock: (): number => 1000 });
  const lifecycle = new RecordingLifecycle();
  const slots = new DispatchSlotCounter(options.limit ?? 8);
  return {
    storage,
    registry,
    lifecycle,
    slots,
    deps: { taskRegistry: registry, lifecycle, slots },
  };
}

/** Write a project-scope agent markdown into a fresh temp cwd and run `body`. */
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

/** Narrow an outcome to its handle, or fail loudly. */
function asHandle(value: DispatchHandle | DispatchResult): DispatchHandle {
  if (!isDispatchHandle(value)) {
    throw new Error("expected a DispatchHandle, got a DispatchResult");
  }
  return value;
}

/** Narrow an outcome to its result, or fail loudly. */
function asResult(value: DispatchHandle | DispatchResult): DispatchResult {
  if (isDispatchHandle(value)) {
    throw new Error("expected a DispatchResult, got a DispatchHandle");
  }
  return value;
}

/** The call context both modes share: depth 0, budget 3. */
const CTX = { callId: 1, depth: 0, maxDispatchDepth: 3 } as const;

describe("the wait parameter (ADR-0055, ticket #239)", () => {
  /**
   * Ticket #239: "省略则立刻返回句柄（含任务 id 与标签）" — omitted means the call does NOT wait,
   * and it hands back a handle carrying the task id and the label.
   *
   * The counterfactual is the default itself: an implementation that keeps "wait unless told
   * otherwise" resolves with a `DispatchResult`, and `isDispatchHandle` turns red on the very
   * first assertion.
   */
  test("omitting `wait` returns a handle at once — the default is to NOT wait", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const outcome = await dispatch(
        { agent: AGENT, task: "do the thing", agentScope: "project" },
        { ...CTX, cwd: dir },
        h.deps,
      );
      const handle = asHandle(outcome);
      // The id is a 26-char Crockford-base32 ULID, the same shape the record carries.
      expect(handle.taskId, "the handle names the task").toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(handle.label, "the handle names the task").toBe("do the thing");
      // It returned at once: the child is still running, so nothing waited for it.
      expect(handle.status).toBe("running");
      expect((await h.storage.loadTask(handle.taskId))?.status, "the record is there already").toBe(
        "running",
      );
    });
  });

  /**
   * Ticket #239: "`wait: true` 返回结果（含任务 id）" — the result carries the task id too, so the
   * caller can look the child up afterwards with the same id the handle would have carried.
   *
   * The counterfactual: a `wait: true` that returned a handle (or a result with no id) turns
   * this red on the `isDispatchHandle` / `taskId` assertions.
   */
  test("`wait: true` returns the result, and the result names the task", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const pending = dispatch(
        { agent: AGENT, task: "answer me", wait: true, agentScope: "project" },
        { ...CTX, cwd: dir },
        h.deps,
      );
      // The child is up but has not answered yet: a waiting call has NOT resolved.
      await waitFor(() => h.lifecycle.spawned.length > 0);
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      const outcome = await pending;
      const result = asResult(outcome);
      expect(result.status, "the child answered").toBe("fulfilled");
      expect(result.text, "and the answer came back").toBe("PONG");
      // ADR-0055: the result names the task the SAME way the handle does — one pair of names.
      expect(result.taskId, "the result names the task").toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(result.label, "the result names the task").toBe("answer me");
    });
  });

  /**
   * Ticket #239: "两种等法下失败结果的形状相同（被拒绝时不等也拿拒绝结果，不是句柄）" — a refusal is
   * a RESULT under both modes. A non-waiting call that was refused hands back the rejection, NOT
   * a handle: a handle would say "this task is running" about a task that never started.
   *
   * The counterfactual: a non-waiting refusal that returned a handle turns this red on
   * `isDispatchHandle` — the handle branch is the one that says "running".
   */
  test("a refusal is a result in both wait modes — never a handle", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      // Depth 3 with a budget of 3 is one level too deep: the depth gate refuses.
      const depthCtx = { ...CTX, depth: 3, maxDispatchDepth: 3 };
      const waiting = asResult(
        await dispatch(
          { agent: AGENT, task: "too deep", wait: true, agentScope: "project" },
          { ...depthCtx, cwd: dir },
          h.deps,
        ),
      );
      const notWaiting = asResult(
        await dispatch(
          { agent: AGENT, task: "too deep", agentScope: "project" },
          { ...depthCtx, cwd: dir },
          h.deps,
        ),
      );
      expect(waiting.status, "the waiting refusal").toBe("rejected");
      expect(notWaiting.status, "the non-waiting refusal").toBe("rejected");
      // ONE generator, ONE wording: the two modes used to teach two vocabularies for one
      // refusal, and the background copy broke the promise the child's own prompt makes.
      expect(notWaiting.errorMessage, "the same wording in both modes").toBe(waiting.errorMessage);
      expect(waiting.errorMessage, "and it is the wording the prompt promises").toBe(
        "dispatch depth limit reached",
      );
      // The SHAPE is the same too: the same keys, the same values, on both modes.
      expect({ ...notWaiting, errorMessage: undefined }).toEqual({
        ...waiting,
        errorMessage: undefined,
      });
    });
  });

  /**
   * Ticket #239: "不等的调用**不等槽**：立刻返回句柄，孩子等槽排到时才真的起" — a non-waiting call
   * does not wait for a concurrency slot. It returns its handle at once, and the child starts
   * when the queue reaches it.
   *
   * The counterfactual: a non-waiting call that awaited the slot would not resolve until the
   * running child finished — this test's `await` would hang instead of returning, which is the
   * failure the assertion below prevents (the handle says `queued`, not `running`).
   */
  test("a non-waiting call does not wait for a slot", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      // One child takes the only slot and stays alive.
      const first = asHandle(
        await dispatch(
          { agent: AGENT, task: "holder", agentScope: "project" },
          { ...CTX, cwd: dir },
          h.deps,
        ),
      );
      expect(first.status).toBe("running");

      // The second call is over the cap. A non-waiting call still returns at once — with a
      // handle that says the task is QUEUED, because the child has not started.
      const second = asHandle(
        await dispatch(
          { agent: AGENT, task: "queued", agentScope: "project" },
          { ...CTX, callId: 2, cwd: dir },
          h.deps,
        ),
      );
      expect(second.status, "the second task is queued, not running").toBe("queued");
      expect(h.lifecycle.spawned, "and no second child was started").toHaveLength(1);
      expect((await h.storage.loadTask(second.taskId))?.status).toBe("queued");
    });
  });

  /**
   * The other half of the same pair: a WAITING call does wait for the slot. Without this the
   * previous test would pass on an implementation that simply never queued anything.
   *
   * The counterfactual: a waiting call that returned before the slot arrived would resolve
   * here, and the `settled` flag below would be true too early — so the test asserts the call
   * is still pending while the only slot is taken.
   */
  test("a waiting call waits for the slot", async () => {
    await withAgent(async (dir) => {
      const h = createHarness({ limit: 1 });
      const holder = asHandle(
        await dispatch(
          { agent: AGENT, task: "holder", agentScope: "project" },
          { ...CTX, cwd: dir },
          h.deps,
        ),
      );
      expect(holder.status).toBe("running");

      let settled = false;
      const pending = dispatch(
        { agent: AGENT, task: "waiter", wait: true, agentScope: "project" },
        { ...CTX, callId: 2, cwd: dir },
        h.deps,
      ).then((value) => {
        settled = true;
        return value;
      });
      // Give the call a chance to settle — and to start a child — if it were going to. The
      // window is the one the repo's own concurrency test uses (50 ms): long enough for a spawn
      // that was going to happen, short enough not to be a timing race.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(settled, "the waiting call has not settled while the only slot is taken").toBe(false);
      expect(
        h.lifecycle.spawned,
        "and no second child was started: the slot was still taken",
      ).toHaveLength(1);

      // Free the slot: the waiter starts its child and the call settles.
      h.lifecycle.pushEvent(h.lifecycle.handleAt(0), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      h.lifecycle.resolveExit(h.lifecycle.handleAt(0), 0, null);
      for (let attempt = 0; attempt < 100 && h.lifecycle.spawned.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(h.lifecycle.spawned, "the waiting child started once the slot freed").toHaveLength(2);
      h.lifecycle.pushEvent(h.lifecycle.handleAt(1), {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      });
      h.lifecycle.resolveExit(h.lifecycle.handleAt(1), 0, null);
      const result = asResult(await pending);
      expect(result.status).toBe("fulfilled");
    });
  });

  /**
   * Ticket #239: "句柄里的标签默认取任务摘要的前缀" — the handle's label defaults to a PREFIX of the
   * task summary, not the whole task. The bound is 64 characters, the same one the record used.
   *
   * The counterfactual: a label that kept the whole task (or truncated at a different width)
   * turns this red on the length and the tail.
   */
  test("the handle's label defaults to the task's first 64 characters", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const longTask = "x".repeat(100);
      const handle = asHandle(
        await dispatch(
          { agent: AGENT, task: longTask, agentScope: "project" },
          { ...CTX, cwd: dir },
          h.deps,
        ),
      );
      expect(handle.label).toBe("x".repeat(64));
      expect(handle.label.length, "a prefix, not the whole task").toBe(64);
    });
  });

  /**
   * Ticket #239: "闸门顺序、铸 id、占槽、建记录完全相同" — the gate order is the same on both
   * modes. A malformed agent name is refused BEFORE a slot is taken, so a refused call leaves
   * the concurrency counter untouched on both fronts.
   *
   * The counterfactual: a gate that ran after the acquire would leave `slots.active === 1` and
   * turn this red.
   */
  test("the gates run before a slot is minted, in both wait modes", async () => {
    await withAgent(async (dir) => {
      const h = createHarness();
      const waiting = asResult(
        await dispatch(
          { agent: "   ", task: "x", wait: true, agentScope: "project" },
          { ...CTX, cwd: dir },
          h.deps,
        ),
      );
      const notWaiting = asResult(
        await dispatch(
          { agent: "   ", task: "x", agentScope: "project" },
          { ...CTX, callId: 2, cwd: dir },
          h.deps,
        ),
      );
      expect(waiting.status, "the waiting refusal").toBe("rejected");
      expect(notWaiting.status, "the non-waiting refusal").toBe("rejected");
      expect(notWaiting.errorMessage, "the same refusal on both modes").toBe(waiting.errorMessage);
      expect(h.slots.active, "no slot was taken by a refused call").toBe(0);
    });
  });
});
