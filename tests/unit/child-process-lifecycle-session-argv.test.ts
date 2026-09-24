/**
 * Gap 1 (BG-12) tests: the R1 session flags (ADR-0022 §1 / R1) reach the child's argv.
 *
 * These are SPECIFICATION tests (docs/testing-constraints.md #4/#6): the expected argv is
 * spelled out with the flag literals from ADR-0022 R1 — `--session-dir`, `--session-id`,
 * `--name bgdispatch:<taskId>` — and the ADR-0016 foreground flag `--no-session`. The
 * adapter test drives the real `RealChildProcessLifecycle` against a mocked
 * `node:child_process.spawn`, so it proves the translation happens on the production path,
 * not just in the pure helper.
 */
import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

/** Captures every `spawn(command, args, options)` the Real adapter issues. */
const spawnCalls = vi.hoisted(() => ({
  entries: [] as Array<{ command: string; args: readonly string[]; options: unknown }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fakeSpawn = (command: string, args: readonly string[], options: unknown): EventEmitter => {
    spawnCalls.entries.push({ command, args, options });
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4242;
    proc.kill = () => true;
    return proc;
  };
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn };
});

import {
  NO_SESSION_FLAG,
  RealChildProcessLifecycle,
  buildSpawnArgv,
  type ChildSpawnOptions,
} from "../../src/runtime/child-process-lifecycle.ts";

// A canonical ULID from the ULID spec's own examples; an independent literal, not read back
// from the implementation.
const TASK_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const PROMPT_FILE = "/tmp/pi-dispatch/prompt.md";
const CWD = "/work";

function baseOpts(overrides: Partial<ChildSpawnOptions> = {}): ChildSpawnOptions {
  return { cwd: CWD, promptFile: PROMPT_FILE, ...overrides };
}

/** The argv `buildArgv` emits today (dispatch.ts): mode json, print, no session. */
const FOREGROUND_ARGV = ["pi", "--mode", "json", "-p", NO_SESSION_FLAG];

describe("buildSpawnArgv — foreground branch (ADR-0016)", () => {
  test("keeps --no-session and adds no session flags when there is no session dir", () => {
    const argv = buildSpawnArgv(FOREGROUND_ARGV, baseOpts());
    // Exact list: the foreground argv is returned byte-for-byte, no additions.
    expect(argv).toEqual(["pi", "--mode", "json", "-p", "--no-session"]);
    expect(argv).not.toContain("--session-dir");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--name");
  });
});

describe("buildSpawnArgv — background branch (ADR-0022 §1 / R1)", () => {
  test("drops --no-session and appends the R1 triple when a session dir is present", () => {
    const argv = buildSpawnArgv(
      FOREGROUND_ARGV,
      baseOpts({
        sessionDir: "/sessions/s1",
        sessionId: TASK_ID,
        sessionName: "bgdispatch:" + TASK_ID,
      }),
    );
    // Literal flags from ADR-0022 R1: --session-dir <dir>, --session-id <taskId>,
    // --name bgdispatch:<taskId>. --no-session MUST be gone.
    expect(argv).toEqual([
      "pi",
      "--mode",
      "json",
      "-p",
      "--session-dir",
      "/sessions/s1",
      "--session-id",
      TASK_ID,
      "--name",
      "bgdispatch:" + TASK_ID,
    ]);
    expect(argv).not.toContain("--no-session");
  });
});

describe("RealChildProcessLifecycle.spawn translates the opts into argv", () => {
  test("the production adapter passes the R1 argv to node:child_process.spawn", () => {
    spawnCalls.entries.length = 0;
    const lifecycle = new RealChildProcessLifecycle();
    lifecycle.spawn(FOREGROUND_ARGV, {
      cwd: CWD,
      promptFile: PROMPT_FILE,
      sessionDir: "/sessions/s1",
      sessionId: TASK_ID,
      sessionName: "bgdispatch:" + TASK_ID,
    });
    expect(spawnCalls.entries).toHaveLength(1);
    const call = spawnCalls.entries[0];
    expect(call?.command).toBe("pi");
    expect(call?.args).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-dir",
      "/sessions/s1",
      "--session-id",
      TASK_ID,
      "--name",
      "bgdispatch:" + TASK_ID,
    ]);
  });

  test("the production adapter keeps --no-session when no session dir is given", () => {
    spawnCalls.entries.length = 0;
    const lifecycle = new RealChildProcessLifecycle();
    lifecycle.spawn(FOREGROUND_ARGV, { cwd: CWD, promptFile: PROMPT_FILE });
    expect(spawnCalls.entries).toHaveLength(1);
    const call = spawnCalls.entries[0];
    expect(call?.command).toBe("pi");
    expect(call?.args).toEqual(["--mode", "json", "-p", "--no-session"]);
  });
});
