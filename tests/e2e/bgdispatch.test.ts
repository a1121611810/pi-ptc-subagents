import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RealChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import {
  DispatchSlotCounter,
  dispatch,
  type DispatchDeps,
  type DispatchResult,
} from "../../src/runtime/dispatch.ts";
import { InMemoryOutputStorage } from "../../src/runtime/output-storage.ts";
import {
  DefaultTaskRegistry,
  type DispatchHandle,
  type TaskRegistry,
} from "../../src/runtime/task-registry.ts";
import {
  InMemoryTaskStorage,
  type TaskRecord,
  type TaskStatus,
  type ULID,
} from "../../src/runtime/task-storage.ts";
import {
  createPtcTaskStopTool,
  type AnyTool,
  type PtcTaskStopDetails,
} from "../../src/tools/ptc-task.ts";

// REAL end-to-end coverage for background dispatch (ADR-0022). Unlike
// tests/integration/bgdispatch/** (a deterministic in-process suite), this file spawns the real
// `pi` binary and drives a real OS process, so it is opt-in on the same gate the existing
// tests/dispatch-e2e.test.ts uses: PT_DISPATCH_E2E=1 + PT_SMOKE_MODEL + `pi` on PATH. The
// meta-discipline fixture (tests/test-meta-discipline.test.ts) verifies the gate is a
// `test.skipIf(...)` and not an `if (...) { return; }` early return, so default CI runs show it as
// SKIPPED rather than falsely green. PT_SMOKE_MODEL must be a model `pi` can resolve — prefer the
// provider-qualified form, e.g. PT_SMOKE_MODEL=deepseek/deepseek-flash, because a bare id can
// fuzzy-match another provider that has no key.
//
// Assertions are SPECIFICATION (docs/testing-constraints.md #5): they fail unless a real child
// process reached a terminal TaskRecord, and unless ptc_task_stop actually delivered a signal to
// a live child (the OS pid is gone afterwards).
const AGENT = "bg-e2e-echo";
const gate = process.env.PT_DISPATCH_E2E === "1" && !!process.env.PT_SMOKE_MODEL;
const piOk = spawnSync("which", ["pi"]).status === 0;
const e2eEnabled = gate && piOk;

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
  "lost",
]);

function agentMarkdown(): string {
  return [
    "---",
    "name: " + AGENT,
    "model: " + String(process.env.PT_SMOKE_MODEL),
    "---",
    "You are an echo. Reply with the single word: PONG.",
  ].join("\n");
}

/** Narrow the background dispatch union without an inline `if (... result ...)` before an expect. */
function requireHandle(result: DispatchHandle | DispatchResult): DispatchHandle {
  if (!("taskId" in result)) {
    throw new Error("background dispatch refused: " + (result.errorMessage ?? "unknown reason"));
  }
  return result;
}

/**
 * Real lifecycle wrapper that records the spawned OS pid and every kill signal, so the e2e can
 * assert the process is gone and the signal was delivered (not just that the record moved).
 */
class PidRecordingLifecycle extends RealChildProcessLifecycle {
  /** Every handle this adapter spawned, in order (one per background dispatch here). */
  readonly spawned: ChildHandle[] = [];
  readonly #pids = new Map<string, number>();
  readonly #signals = new Map<string, Array<"SIGTERM" | "SIGKILL">>();

  override spawn(argv: readonly string[], opts: ChildSpawnOptions): ChildHandle {
    const handle = super.spawn(argv, opts);
    this.spawned.push(handle);
    // The real adapter owns its handle shape; an e2e test inspects `opaque` to reach the pid.
    const state = handle.opaque as { proc?: { pid?: number } };
    const pid = state.proc?.pid;
    if (typeof pid === "number") this.#pids.set(handle.id, pid);
    return handle;
  }

  childAt(index: number): ChildHandle {
    const handle = this.spawned[index];
    if (handle === undefined) {
      throw new Error("PidRecordingLifecycle: no spawned handle at index " + String(index));
    }
    return handle;
  }

  override kill(handle: ChildHandle, signal: "SIGTERM" | "SIGKILL"): void {
    super.kill(handle, signal);
    const recorded = this.#signals.get(handle.id) ?? [];
    recorded.push(signal);
    this.#signals.set(handle.id, recorded);
  }

  getKillSignals(handle: ChildHandle): Array<"SIGTERM" | "SIGKILL"> {
    return [...(this.#signals.get(handle.id) ?? [])];
  }

  /** True while the OS still accepts signal 0 for the spawned pid (i.e. the process is alive). */
  isAlive(handle: ChildHandle): boolean {
    const pid = this.#pids.get(handle.id);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForTerminal(registry: TaskRegistry, taskId: ULID): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const record = await registry.get(taskId);
    if (record !== null && TERMINAL.has(record.status)) return record;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("task " + taskId + " did not reach a terminal state");
}

async function waitGone(lifecycle: PidRecordingLifecycle, handle: ChildHandle): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (!lifecycle.isAlive(handle)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("child process is still alive after ptc_task_stop");
}

interface BgE2eContext {
  dir: string;
  registry: TaskRegistry;
  lifecycle: PidRecordingLifecycle;
  deps: DispatchDeps;
}

async function withBgE2e<T>(body: (ctx: BgE2eContext) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-e2e-"));
  try {
    // T2: the fixture matches discoverAgent's scope — a project agent under <cwd>/.pi/agents.
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), agentMarkdown(), {
      encoding: "utf-8",
    });
    await mkdir(join(dir, "sessions"), { recursive: true });
    const clock = (): number => Date.now();
    const registry = new DefaultTaskRegistry(new InMemoryTaskStorage(), { clock });
    const lifecycle = new PidRecordingLifecycle();
    const deps: DispatchDeps = {
      taskRegistry: registry,
      lifecycle,
      slots: new DispatchSlotCounter(4),
      clock,
      outputStorage: new InMemoryOutputStorage(),
    };
    return await body({ dir, registry, lifecycle, deps });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("background dispatch end-to-end", () => {
  test.skipIf(!e2eEnabled)(
    "a real background pi.dispatch reaches a terminal TaskRecord",
    async () => {
      await withBgE2e(async ({ dir, registry, deps }) => {
        const handle = requireHandle(
          await dispatch(
            { agent: AGENT, task: "ping", background: true, agentScope: "project" },
            {
              callId: 1,
              cwd: dir,
              depth: 0,
              maxDispatchDepth: 3,
              sessionDir: join(dir, "sessions"),
              callerId: "e2e-run",
            },
            deps,
          ),
        );
        // The spawn-time handle carries the persisted task id the pump will drive to a terminal.
        expect(handle.taskId.length).toBeGreaterThan(0);

        const record = await waitForTerminal(registry, handle.taskId);
        // SPECIFICATION: a real child answered, so the record is succeeded with captured PONG.
        expect(record.status).toBe("succeeded");
        expect(record.agentName).toBe(AGENT);
        expect(record.outputBytes).toBeGreaterThan(0);
        expect(record.outputPreview).toMatch(/PONG/);
        // Persisted, not just returned from the pump.
        expect((await registry.get(handle.taskId))?.status).toBe("succeeded");
      });
    },
    300_000,
  );

  test.skipIf(!e2eEnabled)(
    "ptc_task_stop delivers a signal to a live child and the process is gone",
    async () => {
      await withBgE2e(async ({ dir, registry, lifecycle, deps }) => {
        const handle = requireHandle(
          await dispatch(
            {
              agent: AGENT,
              task: "wait for the stop signal",
              background: true,
              agentScope: "project",
            },
            {
              callId: 1,
              cwd: dir,
              depth: 0,
              maxDispatchDepth: 3,
              sessionDir: join(dir, "sessions"),
              callerId: "e2e-run",
            },
            deps,
          ),
        );
        // The child is a live OS process when the stop is issued.
        const child = lifecycle.childAt(0);
        expect(lifecycle.isAlive(child)).toBe(true);

        const tool: AnyTool = createPtcTaskStopTool(registry, lifecycle, {
          clock: () => Date.now(),
        });
        const result = (await tool.execute(
          "e2e-stop",
          { taskId: handle.taskId, reason: "e2e stop" },
          undefined,
          undefined,
          undefined as never,
        )) as { details: PtcTaskStopDetails };
        expect(result.details.fromStatus).toBe("running");
        expect(result.details.task.status).toBe("stopping");

        // The signal was actually delivered to the live child ...
        expect(lifecycle.getKillSignals(child)).toContain("SIGTERM");
        // ... and the OS process is gone, so the record is not merely relabelled.
        await waitGone(lifecycle, child);
        expect(lifecycle.isAlive(child)).toBe(false);

        const record = await waitForTerminal(registry, handle.taskId);
        expect(record.status).toBe("canceled");
        expect(record.stopReason).toBe("e2e stop");
      });
    },
    300_000,
  );
});
