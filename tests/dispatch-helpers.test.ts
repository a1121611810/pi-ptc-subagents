import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendDepthHint,
  buildArgv,
  decideCloseOutcome,
  discoverAgent,
  dispatch,
  parseAgentEvent,
  parseAgentMarkdown,
  safeKill,
  type AgentConfigLike,
} from "../src/runtime/dispatch.ts";
import { makeTempDir, removeTempDir } from "./helpers/ptc.ts";

/**
 * Spawn observation seam: `dispatch()` spawns the `pi` binary through `node:child_process`,
 * so the mock wraps the real module and records every spawn while returning a fake child
 * that closes cleanly. Only this file observes dispatch's spawn path; every assertion reads
 * the recorded `options` (in particular the environment).
 */
const spawnRecorder = vi.hoisted(() => ({
  calls: [] as Array<{
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fakeSpawn = (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    spawnRecorder.calls.push({ command, args, options });
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      killed: boolean;
      kill: (signal: string) => boolean;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4242;
    proc.killed = false;
    proc.kill = () => true;
    // Close cleanly with no events: enough for dispatch() to resolve promptly.
    queueMicrotask(() => {
      proc.emit("close", 0);
    });
    return proc;
  };
  return { ...actual, spawn: fakeSpawn as unknown as typeof actual.spawn };
});

describe("parseAgentMarkdown", () => {
  test("parses a complete frontmatter", () => {
    const md = [
      "---",
      "name: scout",
      "description: Fast recon agent",
      "model: claude-haiku",
      "tools: read, grep, find, bash",
      "---",
      "You are a scout. Investigate quickly.",
    ].join("\n");
    const result = parseAgentMarkdown(md);
    expect(result).toBeTruthy();
    expect(result?.name).toBe("scout");
    expect(result?.description).toBe("Fast recon agent");
    expect(result?.model).toBe("claude-haiku");
    expect(result?.tools).toEqual(["read", "grep", "find", "bash"]);
    expect(result?.systemPrompt).toBe("You are a scout. Investigate quickly.");
  });

  test("parses a YAML list in inline bracket form", () => {
    const md = ["---", "name: planner", "tools: [read, grep, find]", "---", "Plan things."].join(
      "\n",
    );
    const result = parseAgentMarkdown(md);
    expect(result?.tools).toEqual(["read", "grep", "find"]);
  });

  test("returns null when frontmatter is missing name", () => {
    const md = "---\ndescription: missing name\n---\nbody";
    expect(parseAgentMarkdown(md)).toBeNull();
  });

  test("returns null when frontmatter is absent", () => {
    const md = "no frontmatter here\njust a body";
    expect(parseAgentMarkdown(md)).toBeNull();
  });

  test("tolerates an empty body", () => {
    const md = "---\nname: minimal\n---\n";
    const result = parseAgentMarkdown(md);
    expect(result?.name).toBe("minimal");
    expect(result?.systemPrompt).toBe("");
  });
});

describe("parseAgentEvent", () => {
  test("parses a valid message_end line", () => {
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    const ev = parseAgentEvent(line);
    expect(ev).toBeTruthy();
    expect(ev?.type).toBe("message_end");
    expect(ev?.message?.role).toBe("assistant");
  });

  test("returns null for empty line", () => {
    expect(parseAgentEvent("")).toBeNull();
    expect(parseAgentEvent("   ")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseAgentEvent("not json")).toBeNull();
  });
});

describe("appendDepthHint", () => {
  test("appends the hint after a non-empty prompt", () => {
    const out = appendDepthHint("You are a scout.", 1, 3);
    expect(out.startsWith("You are a scout.")).toBe(true);
    expect(out).toContain('<pi-ptc-context depth="1" max-depth="3">');
    expect(out).toContain("depth 1");
    expect(out).toContain("The remaining depth budget is 3 - 1");
    expect(out).toContain("</pi-ptc-context>");
  });

  test("returns just the hint when the prompt is empty", () => {
    const out = appendDepthHint("", 2, 3);
    expect(out.startsWith("<pi-ptc-context")).toBe(true);
  });
});

describe("buildArgv", () => {
  const sampleAgent: AgentConfigLike = {
    name: "scout",
    source: "user",
    systemPrompt: "ignored",
    tools: ["read", "grep"],
  };

  test("always includes mode/no-session/append-system-prompt and Task:", () => {
    const argv = buildArgv(
      { agent: "scout", task: "find auth code" },
      sampleAgent,
      "/tmp/prompt.md",
    );
    expect(argv).toContain("--mode");
    expect(argv).toContain("json");
    expect(argv).toContain("-p");
    expect(argv).toContain("--no-session");
    expect(argv).toContain("--append-system-prompt");
    expect(argv).toContain("/tmp/prompt.md");
    expect(argv[argv.length - 1]).toBe("Task: find auth code");
  });

  test("input.model overrides agent.model", () => {
    const argv = buildArgv(
      { agent: "scout", task: "t", model: "input-model" },
      { ...sampleAgent, model: "agent-model" },
      "/tmp/p.md",
    );
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("input-model");
  });

  test("agent.tools is passed via --tools", () => {
    const argv = buildArgv({ agent: "scout", task: "t" }, sampleAgent, "/tmp/p.md");
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(argv[toolsIdx + 1]).toBe("read,grep");
  });
});

describe("discoverAgent", () => {
  // discovery reads from the real fs; tests use a name that surely does not exist.
  test("returns null for an unknown agent name", () => {
    const result = discoverAgent("__pi_dispatch_test_unknown__", "/tmp", "user");
    expect(result).toBeNull();
  });
});

describe("decideCloseOutcome", () => {
  // ADR-0016 §4 promises a `rejected` outcome when the run is cancelled, with
  // an errorMessage that names the cause. The cancel path goes: ctx.signal aborts
  // → onAbort sends SIGTERM (or SIGKILL after 5 s) → proc closes with code=null
  // → exitCode = -1. The pre-fix close handler fell through to the catch-all
  // `rejected` branch with no errorMessage, breaking the §4 contract.
  test("aborted → rejected with 'dispatch cancelled'", () => {
    const out = decideCloseOutcome({ exitCode: -1, finalText: "", aborted: true });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe("dispatch cancelled");
  });

  test("aborted takes precedence even when finalText is non-empty", () => {
    // Signal-aborted runs never produce a useful finalText, but if one did, the
    // cancellation message still wins — the run was cancelled, not fulfilled.
    const out = decideCloseOutcome({ exitCode: -1, finalText: "PONG", aborted: true });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe("dispatch cancelled");
  });

  test("exit=0 with finalText → fulfilled", () => {
    const out = decideCloseOutcome({ exitCode: 0, finalText: "PONG", aborted: false });
    expect(out.status).toBe("fulfilled");
    expect(out.errorMessage).toBeUndefined();
  });

  test("exit=0 with empty finalText → rejected 'produced no final text'", () => {
    const out = decideCloseOutcome({ exitCode: 0, finalText: "", aborted: false });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe("dispatch produced no final text");
  });

  test("non-zero exit, not aborted → rejected with no errorMessage", () => {
    // The proc's `error` handler covers spawn failures; a non-zero exit without
    // our signal is an upstream failure we don't label.
    const out = decideCloseOutcome({ exitCode: 1, finalText: "", aborted: false });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBeUndefined();
  });

  test("signal-killed exit (-1) without our signal → rejected with no errorMessage", () => {
    // e.g. someone killed the child externally; the run still failed but we
    // don't know whose hand was on the kill switch.
    const out = decideCloseOutcome({ exitCode: -1, finalText: "", aborted: false });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBeUndefined();
  });
});

describe("safeKill", () => {
  // The kill calls in onAbort must guard against `pid === undefined` (TS strict)
  // and absorb "already gone" throws from a process that exited between the
  // guard check and the kill syscall.
  test("returns true and calls proc.kill when pid is defined", () => {
    const killed: string[] = [];
    const proc = {
      pid: 1234,
      kill: (s: string) => {
        killed.push(s);
        return true;
      },
    };
    expect(safeKill(proc, "SIGTERM")).toBe(true);
    expect(killed).toEqual(["SIGTERM"]);
  });

  test("returns false and skips kill when pid is undefined", () => {
    const killed: string[] = [];
    const proc = {
      pid: undefined,
      kill: (s: string) => {
        killed.push(s);
        return true;
      },
    };
    expect(safeKill(proc, "SIGTERM")).toBe(false);
    expect(killed).toEqual([]);
  });

  test("returns false when proc.kill throws (e.g. process already gone)", () => {
    const proc = {
      pid: 1234,
      kill: () => {
        throw new Error("ESRCH");
      },
    };
    expect(safeKill(proc, "SIGKILL")).toBe(false);
  });
});

describe("dispatch depth propagation (ADR-0016 Recursive section)", () => {
  test("spawn stamps PI_PTC_DEPTH=childDepth on the child environment", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "env-probe.md"),
        "---\nname: env-probe\n---\nYou probe.\n",
      );
      spawnRecorder.calls.length = 0;
      const result = await dispatch(
        { agent: "env-probe", task: "ping", agentScope: "project" },
        { callId: 7, cwd: dir, depth: 2, maxDispatchDepth: 3 },
      );
      expect(spawnRecorder.calls).toHaveLength(1);
      const env = spawnRecorder.calls[0]?.options.env as Record<string, string>;
      // depth 2 → childDepth 3 ≤ maxDispatchDepth 3: the spawn happened, and the child run's
      // depth baseline travels in the environment (the pi-ptc extension inside the child
      // reads it back). The rest of the environment is inherited from the host.
      expect(env.PI_PTC_DEPTH).toBe("3");
      expect(env.PATH).toBe(process.env.PATH);
      // The fake child closed cleanly with no assistant text.
      expect(result.exitCode).toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("a dispatch at the depth limit rejects with 'dispatch depth limit reached' and never spawns", async () => {
    spawnRecorder.calls.length = 0;
    const result = await dispatch(
      { agent: "anyone", task: "ping" },
      { callId: 8, cwd: process.cwd(), depth: 3, maxDispatchDepth: 3 },
    );
    expect(result.status).toBe("rejected");
    // Verbatim per the hint block appendDepthHint promises the child program.
    expect(result.errorMessage).toBe("dispatch depth limit reached");
    expect(spawnRecorder.calls).toHaveLength(0);
  });
});
