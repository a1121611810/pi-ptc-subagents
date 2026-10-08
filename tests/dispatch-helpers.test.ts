import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendDepthHint,
  buildArgv,
  decideCloseOutcome,
  discoverAgent,
  dispatch,
  dispatchConcurrencyLimitReached,
  listRegisteredAgents,
  parseAgentEvent,
  parseAgentMarkdown,
  safeKill,
  type AgentConfigLike,
  type DispatchInput,
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
  /** Set before a call to make the fake child fail to spawn instead of closing cleanly. */
  spawnError: undefined as Error | undefined,
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
    // Node reports an async spawn failure (ENOENT and friends) as `error` *before* `close`.
    const failure = spawnRecorder.spawnError;
    queueMicrotask(() => {
      if (failure !== undefined) {
        proc.emit("error", failure);
        proc.emit("close", -2);
        return;
      }
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

  test("agent.tools is passed via --tools, with the report tool merged in", () => {
    // ADR-0032 "Activation is load-bearing": pi reads `--tools` as an ALLOWLIST, so an agent
    // that restricts its child must have the report tool NAMED there or the child filters it
    // straight back out and the tool sits inactive with no error anywhere.
    const argv = buildArgv({ agent: "scout", task: "t" }, sampleAgent, "/tmp/p.md");
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(argv[toolsIdx + 1]).toBe("read,grep,ptc_child_report");
  });
});

describe("discoverAgent", () => {
  // discovery reads from the real fs; tests use a name that surely does not exist.
  test("returns null for an unknown agent name", () => {
    const result = discoverAgent("__pi_dispatch_test_unknown__", "/tmp", "user");
    expect(result).toBeNull();
  });
});

describe("discoverAgent / listRegisteredAgents share one set of lookup paths", () => {
  // Anti-drift SPECIFICATION (the `resolveAgentDirs` docstring's invariant): ONE fixture under a
  // custom homeDir, read through BOTH APIs, same answer. The counterfactual is a discoverAgent
  // that re-derives `os.homedir()` on its own — it finds nothing here while the listing does,
  // and this test goes red.
  test("one fixture under a custom homeDir is found by discoverAgent AND listed by listRegisteredAgents", async () => {
    const home = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await writeFile(
        join(home, ".pi", "agent", "agents", "fixer.md"),
        "---\nname: fixer\nmodel: claude-haiku\n---\nYou fix.\n",
      );

      const found = discoverAgent("fixer", cwd, "user", { homeDir: home });
      expect(found?.name).toBe("fixer");
      expect(found?.source).toBe("user");
      expect(found?.model).toBe("claude-haiku");
      expect(found?.systemPrompt).toBe("You fix.");
      // The listing is derived from the same fixture, so the refusal message the model reads
      // names an agent discovery can actually load.
      expect(listRegisteredAgents({ cwd, agentScope: "user", homeDir: home })).toEqual(["fixer"]);
    } finally {
      await removeTempDir(home);
      await removeTempDir(cwd);
    }
  });
});

describe("registered-agent listing + actionable refusals (pitfall #2)", () => {
  // Agent markdown fixtures follow pi's subagent extension format (frontmatter `name:` +
  // system prompt body) — the same literal shape the existing discoverAgent tests use.
  const SCOUT_MD = "---\nname: scout\n---\nYou scout.\n";
  const REVIEWER_MD = "---\nname: reviewer\n---\nYou review.\n";

  test("listRegisteredAgents reads the scope's dirs, frontmatter name with filename fallback", async () => {
    const home = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await writeFile(join(home, ".pi", "agent", "agents", "scout.md"), SCOUT_MD);
      // No frontmatter at all: the file name is the fallback name.
      await writeFile(join(home, ".pi", "agent", "agents", "note-taker.md"), "just a body\n");
      // Not markdown: never an agent.
      await writeFile(join(home, ".pi", "agent", "agents", "README.txt"), "notes\n");
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(join(cwd, ".pi", "agents", "reviewer.md"), REVIEWER_MD);

      // Names are sorted so the refusal message is deterministic.
      expect(listRegisteredAgents({ cwd, agentScope: "user", homeDir: home })).toEqual([
        "note-taker",
        "scout",
      ]);
      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: home })).toEqual([
        "reviewer",
      ]);
      expect(listRegisteredAgents({ cwd, agentScope: "both", homeDir: home })).toEqual([
        "note-taker",
        "reviewer",
        "scout",
      ]);
    } finally {
      await removeTempDir(home);
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents treats absent lookup dirs as empty instead of failing", async () => {
    // The failure path of the fs boundary (constraint #1/#3): a session/project with no
    // agent dirs is the normal case, and the listing must quietly yield nothing. Absence
    // is the SPEC case, so it must stay silent — the warn assertion below pins the dual
    // path against the genuine-read-failure test that follows.
    const empty = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listRegisteredAgents({ cwd: empty, agentScope: "both", homeDir: empty })).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await removeTempDir(empty);
    }
  });

  test("listRegisteredAgents warns and falls back to the filename when one agent file cannot be read", async () => {
    // Genuine read failure (constraint #1/#3 dual to the absent-dir case above). The fixture
    // is a real DIRECTORY named `ghost.md`: readFileSync then fails with EISDIR on every
    // platform, whereas chmod-0 can still be readable by the owning user on some setups — so
    // the EISDIR trick is deliberate and no platform gate / silent skip is needed.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await mkdir(join(cwd, ".pi", "agents", "ghost.md"));

      // Behaviour preserved: the fallback filename still appears in the listing.
      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual(["ghost"]);
      // Constraint #3: the failure is observable. Counterfactual: deleting the console.warn
      // from the read failure path leaves the spy at zero calls and fails this assertion;
      // warning on the absent-dir path instead would fail the call count.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain("pi.dispatch: cannot read agent file");
      expect(warning).toContain(join(cwd, ".pi", "agents", "ghost.md"));
      expect(warning).toContain("falling back to the filename");
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns when the agents path is present but not a directory", async () => {
    // The present-but-broken twin of the absent-dir case above: a plain FILE sits where the
    // agents directory belongs, so readdirSync fails ENOTDIR on a path that EXISTS. Reporting
    // "no agents registered" silently would tell the model its agent is unregistered when the
    // real fault is a file in the way, so the failure is observable (constraint #3).
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi", "agents"), "not a directory\n");

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      // Exactly one warn: the project dir is present-but-not-a-dir, while the user dir
      // (<cwd>/.pi/agent/agents) is simply absent and stays silent.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(join(cwd, ".pi", "agents"));
      expect(warning).toContain("ENOTDIR");
      // Counterfactual: a silent catch fails the call count; warning on the absent user dir
      // instead would make it 2.
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents stays silent when a parent path component is a file", async () => {
    // The other ENOTDIR shape, and it is NOT the failure case: `<cwd>/.pi` is a file, so
    // `<cwd>/.pi/agents` cannot exist at all — that is the absent-dir case (the normal project
    // case) wearing an ENOTDIR code, and it must stay silent like ENOENT does.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(join(cwd, ".pi"), "not a directory\n");

      expect(listRegisteredAgents({ cwd, agentScope: "both", homeDir: cwd })).toEqual([]);
      // Both lookup paths (user + project) hit the parent-chain ENOTDIR and both stay quiet.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns when the agents path is a dangling symlink", async () => {
    // A symlink whose target was deleted is PRESENT but unusable: `.pi/agents -> <gone>`. Both
    // readdirSync and a *following* stat report ENOENT for it, exactly the code a never-configured
    // project produces — so a stat-based discriminator reads the dangling link as "no agents dir
    // here" and stays silent, telling the model its agent is unregistered when the real fault is
    // a broken link. Present-but-unusable must therefore be observable (constraint #3); only a
    // true absence stays silent.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      const agentsPath = join(cwd, ".pi", "agents");
      // Target is never created: the classic "checked-out branch, agents dir deleted" state.
      await symlink(join(cwd, "deleted-agents-dir"), agentsPath);

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      // Exactly one warn: the dangling project link; the absent user dir stays silent.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(agentsPath);
      expect(warning).toContain("ENOENT");
      // Counterfactual: classifying the dangling link as "absent" leaves the spy at zero calls
      // and this assertion fails; warning on the absent user dir too would make it 2.
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns with ELOOP on a self-referential agents symlink", async () => {
    // A symlink loop is the "any other errno" branch: readdir fails ELOOP, which is neither
    // ENOENT nor ENOTDIR, so the absence discriminator never runs and the failure is always
    // observable (the docstring promises exactly that). Without a test, mutating that guard to
    // return true (silent) leaves the whole suite green.
    // `symlinkSync(b, a); symlinkSync(a, b)` is the POSIX-portable ELOOP fixture: both readdir
    // and stat on `a` report ELOOP on macOS and Linux, constructible by any unprivileged user.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const agentsPath = join(cwd, ".pi", "agents");
      const loopPeer = join(cwd, ".pi", "agents-loop");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await symlink(loopPeer, agentsPath);
      await symlink(agentsPath, loopPeer);

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(agentsPath);
      expect(warning).toContain("ELOOP");
      // Counterfactual: `if (code !== "ENOENT" && code !== "ENOTDIR") return true;` — i.e.
      // classifying every other errno as an absence — drops the spy to zero calls and goes red.
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns when a PARENT component is a dangling symlink", async () => {
    // The same broken link one level up. `<cwd>/.pi` is a symlink to a target that was never
    // created, so readdirSync(`<cwd>/.pi/agents`) fails ENOENT *through* the link, and an
    // lstat of the final component fails too — the agents entry genuinely does not exist, so a
    // discriminator that only looks at the final component reads this exactly like a
    // never-configured project and stays silent, telling the model its agent is unregistered
    // while the real fault is a broken `.pi` link. Present-but-unusable must be observable
    // (constraint #3); only a true absence stays silent.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Target is never created: the "branch switched, config dir never came back" state.
      await symlink(join(cwd, "deleted-pi-dir"), join(cwd, ".pi"));

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      // Exactly one warn: the broken project parent. `homeDir: cwd` is inert here because
      // agentScope is "project" — only the project lookup axis is enumerated.
      expect(warn).toHaveBeenCalledTimes(1);
      // The literal path is pinned: the agents dir being unreadable is what the model must see.
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(join(cwd, ".pi", "agents"));
      expect(warning).toContain("ENOENT");
      // Counterfactual: dropping the ancestor walk from the silence discriminator leaves the
      // spy at zero calls and this assertion fails.
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns when a PARENT component is a symlink pointing at a file", async () => {
    // The ENOTDIR flavour of the same fault: `<cwd>/.pi` is a symlink to a regular file, so
    // `<cwd>/.pi/agents` is unreachable with ENOTDIR and the final component does not exist as
    // an entry. A plain FILE parent is the silent absent-dir case (pinned by its own test); a
    // symlink parent is a configured path that cannot resolve, so it is observable.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await writeFile(join(cwd, "pi-is-a-file"), "not a directory\n");
      await symlink(join(cwd, "pi-is-a-file"), join(cwd, ".pi"));

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(join(cwd, ".pi", "agents"));
      expect(warning).toContain("ENOTDIR");
      // Counterfactual: the same mutation that silences the dangling-parent test silences this
      // one; keeping the plain-file parent silent does not, because lstat reports a symlink.
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("a missing agent refuses with an actionable message and never spawns", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "helper.md"),
        "---\nname: helper\n---\nYou help.\n",
      );
      spawnRecorder.calls.length = 0;

      // The wire can deliver anything; `agent` absent is the field-report case. The project
      // scope puts the temp agent dir in the listing (the default "user" scope would not).
      const missing = await dispatch(
        { task: "ping", agentScope: "project" } as unknown as DispatchInput,
        { callId: 20, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(missing.status).toBe("rejected");
      expect(missing.started).toBe(false);
      // Counterfactual: the old "unknown agent: undefined" message fails this prefix, and a
      // build that skips the listing fails the registered-agents line.
      expect(missing.errorMessage ?? "").toContain("agent is required (there is no default agent)");
      expect(missing.errorMessage ?? "").toContain("registered agents: [helper]");
      expect(missing.errorMessage ?? "").toContain(join(dir, ".pi", "agents"));
      expect(missing.errorMessage ?? "").toContain("name: <agent-name>");
      expect(spawnRecorder.calls).toHaveLength(0);

      // Whitespace-only agent is missing too.
      const blank = await dispatch(
        { agent: "   ", task: "ping", agentScope: "project" },
        { callId: 21, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(blank.status).toBe("rejected");
      expect(blank.errorMessage ?? "").toContain("agent is required");
      expect(spawnRecorder.calls).toHaveLength(0);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("an unknown agent keeps the message prefix and appends the registered list", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(join(dir, ".pi", "agents", "reviewer.md"), REVIEWER_MD);
      spawnRecorder.calls.length = 0;

      const result = await dispatch(
        { agent: "ghost", task: "ping", agentScope: "project" },
        { callId: 22, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(result.status).toBe("rejected");
      expect(result.started).toBe(false);
      expect(result.errorMessage ?? "").toContain(
        "unknown agent: ghost (agentScope=project, cwd=" + dir + ")",
      );
      expect(result.errorMessage ?? "").toContain("registered agents: [reviewer]");
      // Both lookup paths and the minimal file shape are named, so the model can act on it.
      expect(result.errorMessage ?? "").toContain(join(dir, ".pi", "agents"));
      expect(result.errorMessage ?? "").toContain(join(os.homedir(), ".pi", "agent", "agents"));
      expect(result.errorMessage ?? "").toContain("name: <agent-name>");
      expect(spawnRecorder.calls).toHaveLength(0);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("an unknown agent with nothing registered says so explicitly", async () => {
    const dir = await makeTempDir();
    try {
      spawnRecorder.calls.length = 0;
      const result = await dispatch(
        { agent: "ghost", task: "ping", agentScope: "project" },
        { callId: 23, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(result.status).toBe("rejected");
      // "(none)", not an empty list — the model must not read an empty "[]" as a bug.
      expect(result.errorMessage ?? "").toContain("registered agents: (none)");
      expect(spawnRecorder.calls).toHaveLength(0);
    } finally {
      await removeTempDir(dir);
    }
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
    // The marker that tells a declined dispatch apart from one that ran and failed — the
    // sub-call tree colours the first `rejected` and the second `error` (ADR-0021 §6).
    expect(result.started).toBe(false);
  });

  test("the concurrency-gate refusal is marked 'not started' too", () => {
    expect(dispatchConcurrencyLimitReached().started).toBe(false);
  });

  test("a spawn that never happened is marked 'not started' (ENOENT arrives as `error`)", async () => {
    const dir = await makeTempDir();
    spawnRecorder.calls.length = 0;
    spawnRecorder.spawnError = Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "env-probe.md"),
        "---\nname: env-probe\n---\nProbe.\n",
      );
      const result = await dispatch(
        { agent: "env-probe", task: "ping", agentScope: "project" },
        { callId: 9, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toContain("failed to spawn pi");
      // No child ever came up, so this is a refusal like the depth and concurrency gates — the
      // sub-call tree colours it `rejected`, not the `error` bucket a ran-and-failed child gets.
      expect(result.started).toBe(false);
    } finally {
      spawnRecorder.spawnError = undefined;
      await removeTempDir(dir);
    }
  });
});
