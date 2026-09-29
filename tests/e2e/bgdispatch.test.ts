import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RealChildProcessLifecycle,
  type ChildHandle,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";
import { createFileTaskStorage } from "../../src/runtime/task-storage-file.ts";
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
// tests/integration/bgdispatch/ (a deterministic in-process suite), this file spawns the real
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
//
// Hermeticity: the spawned children resolve extensions from the pi agent dir, which by default
// is the user's REAL ~/.pi/agent — where a globally-installed `npm:pi-ptc-subagents` @ 1.0.0
// (pre-ADR-0023, no ownership) makes the child's startup reconcile dir-wide and flips the
// parent-owned records in the shared session storage to `lost`. So both wrappers below route
// every dispatch in the body through a temp PI_CODING_AGENT_DIR whose settings.json loads ONLY
// this working tree's dist/index.js (provider keys / auth / trust symlinked from the real dir).
// See withHermeticPiAgentDir.
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

/** Repo root derived from THIS test file's own location (tests/e2e/ → up two = the package root). */
function repoRootFromTestFile(testFileUrl: string): string {
  return join(dirname(fileURLToPath(testFileUrl)), "..", "..");
}

/**
 * The real pi agent dir, resolved the way the installed pi resolves it (pi dist/config.js
 * `getAgentDir()`): `process.env.PI_CODING_AGENT_DIR` when truthy, else `join(homedir(), ".pi",
 * "agent")`. Pure in (env, homeDir) so tests drive it with literals instead of touching the real
 * HOME or the real process env.
 */
function resolvePiAgentDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const envDir = env.PI_CODING_AGENT_DIR;
  if (typeof envDir === "string" && envDir.length > 0) return envDir;
  return join(homeDir, ".pi", "agent");
}

/**
 * settings.json content for the temp agent dir: ONE package entry pointing at this working
 * tree. The shape mirrors the real ~/.pi/agent/settings.json entry for pi-ptc-subagents
 * (`{"source": "npm:pi-ptc-subagents", "extensions": ["+dist/index.js"]}`); a plain absolute
 * `source` parses as a local package (pi dist/core/package-manager.js `parseSource` falls back
 * to `{type: "local", path}`), and `+dist/index.js` force-includes the working-tree build.
 * NOTHING else from the real settings — that is the point: the globally-installed stale npm
 * build must not leak in.
 */
function buildHermeticSettings(repoRoot: string): string {
  return JSON.stringify({ packages: [{ source: repoRoot, extensions: ["+dist/index.js"] }] });
}

/**
 * Staleness precheck for the gated e2e (fail loudly, never skip): the child pi must load THIS
 * working tree's `dist/index.js`, so the build must (a) exist, (b) post-date every `.ts` file
 * under `src/` (walked once), and (c) contain the ADR-0023 ownership field `ownerPid` — a dist
 * built before the ownership change would make the sibling-survival test fail for the wrong
 * reason (expected 'lost' to be 'succeeded'). Returns an error message, or `undefined` when
 * fresh. Pure in (distPath, srcRoot) so tests can drive it against a fixture tree — the real
 * counterfactual (touch a src file → stale) is asserted in the harness-helper tests below.
 */
async function distFreshnessError(distPath: string, srcRoot: string): Promise<string | undefined> {
  let distMtimeMs: number;
  let distText: string;
  try {
    distMtimeMs = (await stat(distPath)).mtimeMs;
    // Read inside the same try: a dist path that stats but cannot be read (a directory, a
    // permission error) is still a build problem, and the actionable message must survive it
    // rather than surfacing a raw EISDIR at the caller.
    distText = await readFile(distPath, "utf-8");
  } catch {
    return distPath + " is missing or unreadable — run `pnpm run build` before the gated e2e";
  }
  if (!distText.includes("ownerPid")) {
    return (
      distPath +
      " has no ADR-0023 ownership code (ownerPid) — run `pnpm run build` before the gated e2e"
    );
  }
  let newestSrcMs = 0;
  let newestSrcFile = "";
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const mtimeMs = (await stat(p)).mtimeMs;
        if (mtimeMs > newestSrcMs) {
          newestSrcMs = mtimeMs;
          newestSrcFile = p;
        }
      }
    }
  };
  await walk(srcRoot);
  if (newestSrcMs > distMtimeMs) {
    return (
      distPath + " is older than " + newestSrcFile + " — run `pnpm run build` before the gated e2e"
    );
  }
  return undefined;
}

const SYMLINKED_AGENT_FILES = ["provider-keys.json", "auth.json", "trust.json"] as const;

/**
 * THROW (never skip) when `repoRoot`'s build cannot serve the gated e2e. Split out of the
 * wrapper so the throw path is testable against a fixture tree instead of only against whatever
 * state the real working tree happens to be in.
 */
async function assertFreshWorkingTreeBuild(repoRoot: string): Promise<void> {
  const stale = await distFreshnessError(join(repoRoot, "dist", "index.js"), join(repoRoot, "src"));
  if (stale !== undefined) {
    throw new Error("bgdispatch e2e harness: " + stale);
  }
}

/**
 * Build the temp pi agent dir the e2e children boot from, inside the caller's `dir`:
 *   1. `settings.json` loading ONLY the `repoRoot` working tree (buildHermeticSettings).
 *   2. provider-keys.json / auth.json / trust.json symlinked from `realAgentDir` when they
 *      exist there, so the child can authenticate.
 * Returns the agent dir path. `realAgentDir` defaults to the dir pi itself would resolve
 * (resolvePiAgentDir), and is a parameter so the harness's own tests drive a fixture tree.
 */
async function prepareHermeticAgentDir(
  dir: string,
  repoRoot: string,
  realAgentDir: string = resolvePiAgentDir(process.env, homedir()),
): Promise<string> {
  const agentDir = join(dir, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), buildHermeticSettings(repoRoot), {
    encoding: "utf-8",
  });
  for (const name of SYMLINKED_AGENT_FILES) {
    const realPath = join(realAgentDir, name);
    try {
      await stat(realPath);
    } catch {
      // Constraint #3: the missing link is a real gap in what the child needs, so say so.
      // The consequence is a VISIBLE child boot failure (its record never leaves `running`),
      // never a silently-passing test — a machine without provider keys must not look green.
      console.warn(
        "bgdispatch e2e harness: " +
          realPath +
          " is absent; the child pi cannot authenticate " +
          "and its dispatch will fail visibly instead of passing",
      );
      continue;
    }
    await symlink(realPath, join(agentDir, name));
  }
  return agentDir;
}

/**
 * Shared hermeticity wrapper for BOTH e2e wrappers below. Before the body runs it:
 *   1. Prechecks the working-tree build (assertFreshWorkingTreeBuild) and THROWS on a
 *      stale/missing dist — the gated test goes red, it is never silently skipped.
 *   2. Creates the temp pi agent dir (prepareHermeticAgentDir) with settings.json loading ONLY
 *      the working-tree build and the real provider files symlinked in.
 *   3. Points process.env.PI_CODING_AGENT_DIR at that dir for the body's duration and restores
 *      the previous value in `finally` (children inherit env at spawn time, so every dispatch in
 *      the body is covered; the restoration itself is asserted).
 *
 * `repoRoot` defaults to this working tree and is overridable only so the harness tests can
 * drive a fixture tree; the e2e wrappers always take the default.
 */
async function withHermeticPiAgentDir<T>(
  dir: string,
  body: () => Promise<T>,
  repoRoot: string = repoRootFromTestFile(import.meta.url),
): Promise<T> {
  await assertFreshWorkingTreeBuild(repoRoot);
  const agentDir = await prepareHermeticAgentDir(dir, repoRoot);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await body();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    // Restoration is part of the contract: a leaked override would point every LATER spawn in
    // this process (other test files included) at a deleted temp dir.
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previousAgentDir);
  }
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
    return await withHermeticPiAgentDir(dir, () => body({ dir, registry, lifecycle, deps }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * ADR-0023 ownership layout: the parent registry is FILE-backed at the very session dir the
 * children are launched with (`--session-dir <dir>/sessions`), and its records are owned by
 * this (parent) process — the production shape in which a child's boot reconcile and exit sweep
 * share the storage with the records that spawned it.
 */
async function withBgE2eSharedDir<T>(body: (ctx: BgE2eContext) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bg-e2e-owned-"));
  try {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(join(dir, ".pi", "agents", AGENT + ".md"), agentMarkdown(), {
      encoding: "utf-8",
    });
    await mkdir(join(dir, "sessions"), { recursive: true });
    const clock = (): number => Date.now();
    const registry = new DefaultTaskRegistry(createFileTaskStorage(join(dir, "sessions")), {
      clock,
      owner: { pid: process.pid, bootMs: Date.now() },
    });
    const lifecycle = new PidRecordingLifecycle();
    const deps: DispatchDeps = {
      taskRegistry: registry,
      lifecycle,
      slots: new DispatchSlotCounter(4),
      clock,
      outputStorage: new InMemoryOutputStorage(),
    };
    return await withHermeticPiAgentDir(dir, () => body({ dir, registry, lifecycle, deps }));
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

  test.skipIf(!e2eEnabled)(
    "a sibling task survives a real child's startup reconcile and exit sweep (ADR-0023 ownership)",
    async () => {
      // Real-spawn counterfactual for field-report pitfall #3: the first child is launched with
      // `--session-dir <dir>/sessions`, the SAME dir this test's parent registry persists into —
      // so the child's own extension boot reconciles the shared storage, and its session_shutdown
      // sweep runs when it exits. Pre-ADR-0023 both sweeps were dir-wide: the child flipped the
      // parent's records (its own included) to lost. Post-ADR-0023 the records are owned by the
      // parent pid (alive), so only an owner-dead record may be reaped. Requires the child pi to
      // load this extension — the same precondition under which the original bug reproduced.
      await withBgE2eSharedDir(async ({ dir, registry, lifecycle, deps }) => {
        const first = requireHandle(
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
        // The record lands on disk before the child finishes booting; the child's reconcile
        // therefore sees it. Wait until the OS process is up (its startup reconcile has run or
        // is about to), then register the sibling.
        const child = lifecycle.childAt(0);
        for (let attempt = 0; attempt < 300 && !lifecycle.isAlive(child); attempt += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        expect(lifecycle.isAlive(child)).toBe(true);
        expect((await registry.get(first.taskId))?.status).toBe("running");

        const second = requireHandle(
          await dispatch(
            { agent: AGENT, task: "ping", background: true, agentScope: "project" },
            {
              callId: 2,
              cwd: dir,
              depth: 0,
              maxDispatchDepth: 3,
              sessionDir: join(dir, "sessions"),
              callerId: "e2e-run",
            },
            deps,
          ),
        );

        // The first child completes (its own record must NOT have been swept to lost by its
        // boot reconcile), and its exit must not reap the sibling. The sibling is an echo task
        // that answers in about a second, so "still running" at this instant would be a RACE,
        // not a specification: what must hold NOW is that the sibling carries no reaping trace
        // (no `lost` status, no lost-reason message) — pre-ADR-0023 the first child's boot
        // reconcile flipped it to `lost` right here. The exact-literal specification is at the
        // end: the sibling reaches `succeeded` on its own, never a lost reason.
        const record = await waitForTerminal(registry, first.taskId);
        expect(record.status).toBe("succeeded");
        const sibling = await registry.get(second.taskId);
        // Narrow BEFORE the expect, like requireHandle: a vanished record is a harness failure,
        // not a silently-passing optional chain. The old `expect(sibling?.status).not.toBe(
        // "lost")` was green whenever `sibling` was null — the exact case it should reject.
        if (sibling === null) {
          throw new Error("sibling record " + second.taskId + " vanished from the registry");
        }
        expect(sibling.status).not.toBe("lost");
        expect(sibling.errorMessage).toBeUndefined();
        expect(sibling.ownerPid).toBe(process.pid);
        // Teardown-race fix: the test must not return (and the finally block must not rm -rf the
        // tree) while the sibling's OS process is still alive. Waiting for the sibling's OWN
        // terminal record also proves the first child's exit sweep did not flip it to a lost
        // reason — a reaped record cannot succeed on its own.
        const siblingFinal = await waitForTerminal(registry, second.taskId);
        expect(siblingFinal.status).toBe("succeeded");
        expect(siblingFinal.errorMessage).toBeUndefined();
        // The sibling's OWN child produced the bytes: a `succeeded` status alone is also what a
        // record resolved from another child's output would carry, so the payload is pinned to
        // the echo agent's PONG exactly as the first e2e does.
        expect(siblingFinal.outputPreview).toMatch(/PONG/);
      });
    },
    300_000,
  );
});

/**
 * Unit coverage for the e2e harness itself (docs/testing-constraints.md: the harness is code with
 * IO edges, so its pure helpers get success AND failure path tests). These never spawn pi and are
 * NOT gated — default CI runs them. Expectations point at independent sources: pi's installed
 * dist (getAgentDir / parseSource semantics), the real settings.json entry shape, and literal
 * fixture trees whose counterfactual (a stale/missing/wrong dist) is constructed explicitly.
 */
describe("bgdispatch e2e harness helpers", () => {
  test("repoRootFromTestFile resolves to the package root", async () => {
    const root = repoRootFromTestFile(import.meta.url);
    // Independent anchor: the repo root is where package.json declares pi-ptc-subagents (a real
    // file, not something derived from the implementation). One ".." too few/many lands in
    // tests/ or tests/e2e/ where no such package.json exists, so this is a real counterfactual.
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
      name?: string;
    };
    expect(pkg.name).toBe("pi-ptc-subagents");
  });

  test("resolvePiAgentDir honours PI_CODING_AGENT_DIR and falls back like pi's getAgentDir", () => {
    // Verbatim pi dist/config.js getAgentDir(): truthy PI_CODING_AGENT_DIR wins, else
    // join(homedir(), ".pi", "agent").
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "/tmp/fake-agent" }, "/home/u")).toBe(
      "/tmp/fake-agent",
    );
    expect(resolvePiAgentDir({}, "/home/u")).toBe("/home/u/.pi/agent");
    // pi checks `if (envDir)` — an EMPTY string is falsy and must fall back.
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: "" }, "/home/u")).toBe("/home/u/.pi/agent");
  });

  test("buildHermeticSettings loads only the working-tree package", () => {
    // The exact shape of the real ~/.pi/agent/settings.json pi-ptc-subagents entry, with the
    // npm: source replaced by the local path (pi parseSource local fallback). toEqual — not
    // toMatch — so ANY second package (in particular the globally-installed stale
    // npm:pi-ptc-subagents@1.0.0 this harness exists to exclude) fails the test.
    expect(JSON.parse(buildHermeticSettings("/repo"))).toEqual({
      packages: [{ source: "/repo", extensions: ["+dist/index.js"] }],
    });
  });

  test("distFreshnessError passes a fresh working-tree-shaped dist", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-harness-fresh-"));
    try {
      await mkdir(join(root, "src", "runtime"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      const srcFile = join(root, "src", "runtime", "dispatch.ts");
      const distFile = join(root, "dist", "index.js");
      await writeFile(srcFile, "// source", { encoding: "utf-8" });
      await writeFile(distFile, "const ownerPid = 1;", { encoding: "utf-8" });
      const past = new Date(Date.now() - 60_000);
      await utimes(srcFile, past, past);
      expect(await distFreshnessError(distFile, join(root, "src"))).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distFreshnessError flags a dist older than a src file (the touch-src counterfactual)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-harness-stale-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      const srcFile = join(root, "src", "index.ts");
      const distFile = join(root, "dist", "index.js");
      await writeFile(srcFile, "// source", { encoding: "utf-8" });
      await writeFile(distFile, "const ownerPid = 1;", { encoding: "utf-8" });
      const past = new Date(Date.now() - 120_000);
      await utimes(distFile, past, past);
      // The counterfactual from the review: touch a src file (mtime now) -> the precheck throws.
      // An implementation without the mtime comparison would return undefined here and this
      // assertion would be red.
      const stale = await distFreshnessError(distFile, join(root, "src"));
      expect(stale).toBeDefined();
      expect(String(stale)).toContain("pnpm run build");
      expect(String(stale)).toContain(srcFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distFreshnessError flags a missing dist loudly, not silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-harness-missing-"));
    try {
      const missing = join(root, "dist", "index.js");
      const err = await distFreshnessError(missing, join(root, "src"));
      expect(err).toBeDefined();
      expect(String(err)).toContain(missing);
      expect(String(err)).toContain("pnpm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distFreshnessError flags an mtime-fresh dist without the ADR-0023 ownership code", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-harness-preownership-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "dist"), { recursive: true });
      const srcFile = join(root, "src", "index.ts");
      const distFile = join(root, "dist", "index.js");
      await writeFile(srcFile, "// source", { encoding: "utf-8" });
      // Mtime-fresh but PRE-ADR-0023 content: the counterfactual is a dist rebuilt only in
      // appearance — without the ownerPid grep this fixture would pass as fresh and the gated
      // sibling-survival test would fail with the misleading 'lost' again.
      await writeFile(distFile, "// pre-ownership build, no owner field", { encoding: "utf-8" });
      const past = new Date(Date.now() - 60_000);
      await utimes(srcFile, past, past);
      const err = await distFreshnessError(distFile, join(root, "src"));
      expect(err).toBeDefined();
      expect(String(err)).toContain("ownerPid");
      expect(String(err)).toContain("pnpm run build");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("distFreshnessError reports an unreadable dist as a build problem, not a raw EISDIR", async () => {
    // A DIRECTORY where dist/index.js belongs: stat succeeds, the read then fails EISDIR. The
    // actionable message must survive that — the counterfactual is a harness that throws a raw
    // EISDIR at the reader and never says what to do about it.
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-harness-eisdir-"));
    try {
      const distFile = join(root, "dist", "index.js");
      await mkdir(distFile, { recursive: true });
      const err = await distFreshnessError(distFile, join(root, "src"));
      expect(String(err)).toContain("pnpm run build");
      expect(String(err)).toContain(distFile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * A repoRoot-shaped fixture tree the freshness precheck accepts: a `dist/index.js` carrying the
 * ADR-0023 ownership marker, newer than every `.ts` under `src/`. The gated wrappers run against
 * the REAL working tree, so these fixtures are what make their env/throw contract testable
 * without a build.
 */
async function makeFreshFixtureRepoRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  const srcFile = join(root, "src", "index.ts");
  await writeFile(srcFile, "// source", { encoding: "utf-8" });
  await writeFile(join(root, "dist", "index.js"), "const ownerPid = 1;", { encoding: "utf-8" });
  const past = new Date(Date.now() - 60_000);
  await utimes(srcFile, past, past);
  return root;
}

describe("bgdispatch e2e hermetic agent dir", () => {
  test("prepareHermeticAgentDir returns the agent dir, writes the working-tree settings, and symlinks the real files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-agentdir-"));
    const repoRoot = await makeFreshFixtureRepoRoot("pi-bg-e2e-agentdir-fresh-");
    const realAgentDir = join(root, "real-agent");
    await mkdir(realAgentDir, { recursive: true });
    for (const name of SYMLINKED_AGENT_FILES) {
      await writeFile(join(realAgentDir, name), "{}\n", { encoding: "utf-8" });
    }
    try {
      const agentDir = await prepareHermeticAgentDir(root, repoRoot, realAgentDir);
      expect(agentDir).toBe(join(root, "pi-agent"));
      // Independent source: the exact settings.json entry shape (see buildHermeticSettings) —
      // a copy of the real dir's contents, or a second package, fails toEqual here.
      const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf-8")) as {
        packages?: Array<{ source: string; extensions: string[] }>;
      };
      expect(settings.packages).toEqual([{ source: repoRoot, extensions: ["+dist/index.js"] }]);
      for (const name of SYMLINKED_AGENT_FILES) {
        const link = join(agentDir, name);
        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(join(realAgentDir, name));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("prepareHermeticAgentDir warns for every missing real file instead of skipping the child silently", async () => {
    // Constraint #3 on the harness itself: the missing-symlink branch used to `continue` in
    // silence, so a machine without provider keys produced a temp dir the child cannot boot
    // from and no signal at all. The consequence is a VISIBLE child boot failure (the record
    // never leaves running), never a pass.
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-agentdir-nokeys-"));
    const repoRoot = await makeFreshFixtureRepoRoot("pi-bg-e2e-agentdir-nokeys-fresh-");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agentDir = await prepareHermeticAgentDir(root, repoRoot, join(root, "no-such-dir"));
      expect((await readdir(agentDir)).sort()).toEqual(["settings.json"]);
      const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
      for (const name of SYMLINKED_AGENT_FILES) {
        expect(warnings).toContain(name);
      }
      // Counterfactual: a silent catch leaves the spy at zero calls and fails this count.
      expect(warn).toHaveBeenCalledTimes(SYMLINKED_AGENT_FILES.length);
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("withHermeticPiAgentDir overrides the agent dir for the body and restores the prior value", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-env-"));
    const repoRoot = await makeFreshFixtureRepoRoot("pi-bg-e2e-env-fresh-");
    // A prior override that is a REAL agent dir (with the three symlinked files) so the wrapper
    // resolves the same source pi would, with no missing-link warnings polluting the log.
    const prior = join(root, "prior-agent-dir");
    await mkdir(prior, { recursive: true });
    for (const name of SYMLINKED_AGENT_FILES) {
      await writeFile(join(prior, name), "{}\n", { encoding: "utf-8" });
    }
    process.env.PI_CODING_AGENT_DIR = prior;
    try {
      const inside = await withHermeticPiAgentDir(
        root,
        async () => {
          return process.env.PI_CODING_AGENT_DIR;
        },
        repoRoot,
      );
      // The body sees the temp dir (this is what the real e2e depends on: children inherit
      // the env at spawn time), and the prior value is back afterwards.
      expect(inside).toBe(join(root, "pi-agent"));
      expect(process.env.PI_CODING_AGENT_DIR).toBe(prior);

      // Restoration must also happen when the body throws, or a failed e2e would leak the
      // override into every later spawn in this process. A fresh `dir` per call: the agent dir
      // is a fixed `<dir>/pi-agent`, so reusing one would collide on the symlinks.
      const throwDir = await mkdtemp(join(tmpdir(), "pi-bg-e2e-env-throw-"));
      await expect(
        withHermeticPiAgentDir(
          throwDir,
          async () => {
            throw new Error("body failure");
          },
          repoRoot,
        ),
      ).rejects.toThrow("body failure");
      expect(process.env.PI_CODING_AGENT_DIR).toBe(prior);
      await rm(throwDir, { recursive: true, force: true });
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
      await rm(root, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("withHermeticPiAgentDir THROWS on a stale dist and never runs the body (no silent skip)", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-throw-stale-"));
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-bg-e2e-throw-stale-repo-"));
    const bodyRan: string[] = [];
    try {
      await mkdir(join(repoRoot, "src"), { recursive: true });
      await mkdir(join(repoRoot, "dist"), { recursive: true });
      await writeFile(join(repoRoot, "src", "index.ts"), "// source", { encoding: "utf-8" });
      const distFile = join(repoRoot, "dist", "index.js");
      await writeFile(distFile, "const ownerPid = 1;", { encoding: "utf-8" });
      const past = new Date(Date.now() - 120_000);
      await utimes(distFile, past, past);

      await expect(
        withHermeticPiAgentDir(
          root,
          async () => {
            bodyRan.push("stale");
          },
          repoRoot,
        ),
      ).rejects.toThrow(/pnpm run build/);
      expect(bodyRan).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("withHermeticPiAgentDir THROWS on a missing dist and never runs the body", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-bg-e2e-throw-missing-"));
    const repoRoot = await makeFreshFixtureRepoRoot("pi-bg-e2e-throw-missing-repo-");
    const bodyRan: string[] = [];
    try {
      await rm(join(repoRoot, "dist", "index.js"), { force: true });
      await expect(
        withHermeticPiAgentDir(
          root,
          async () => {
            bodyRan.push("missing");
          },
          repoRoot,
        ),
      ).rejects.toThrow(/pnpm run build/);
      expect(bodyRan).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
