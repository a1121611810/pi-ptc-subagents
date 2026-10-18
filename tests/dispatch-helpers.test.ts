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
  listRegisteredAgentEntries,
  listRegisteredAgents,
  parseAgentEvent,
  parseAgentMarkdown,
  safeKill,
  PI_TRUNCATION_WARNING,
  truncationFailureMessage,
  type AgentConfigLike,
  type DispatchInput,
} from "../src/runtime/dispatch.ts";
import { DISPATCH_CONTEXT, makeTempDir, removeTempDir } from "./helpers/ptc.ts";

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
  /**
   * How the NEXT fake child behaves: the bytes it writes to each pipe and the code it closes
   * with. Consumed (and cleared) by the next `spawn`, so a test sets it, dispatches once, and
   * every later test is back on the default close-0-no-output child.
   */
  nextChild: undefined as
    | {
        /** Written to `proc.stdout` as one chunk; parsed by the REAL adapter as JSONL. */
        stdout?: string;
        /** Written to `proc.stderr` as one chunk; accumulated by the REAL adapter. */
        stderr?: string;
        /** The `close` event's code. Defaults to 0. */
        exitCode?: number;
        /** The `close` event's signal. Omitted by default, matching the original mock. */
        exitSignal?: NodeJS.Signals;
      }
    | undefined,
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
    // Consumed here so the next spawn starts from the default child, not this one's script.
    const script = spawnRecorder.nextChild;
    spawnRecorder.nextChild = undefined;
    queueMicrotask(() => {
      if (failure !== undefined) {
        proc.emit("error", failure);
        proc.emit("close", -2);
        return;
      }
      // The order a real child produces: stdout data, then stderr data, then `close`. The REAL
      // `RealChildProcessLifecycle` listens on exactly these three, so a dispatch driven through
      // this seam exercises the production adapter and the production close handler rather than
      // a mock standing in for them.
      if (script?.stdout !== undefined) proc.stdout.emit("data", Buffer.from(script.stdout));
      if (script?.stderr !== undefined) proc.stderr.emit("data", Buffer.from(script.stderr));
      proc.emit("close", script?.exitCode ?? 0, script?.exitSignal ?? null);
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

  test("a dispatched child is told what it is, and what its output is for", () => {
    // Three facts a child cannot get from pi's own prompt (#186). Without them a child can ask a
    // question nobody will answer, or narrate its process where an answer was wanted.
    const out = appendDepthHint("You are a scout.", 1, 3);
    expect(out, "the dispatch context, verbatim").toContain(DISPATCH_CONTEXT);
    // Appended, never substituted: the definition's own body still leads.
    expect(out.startsWith("You are a scout.")).toBe(true);
  });

  test("the same context reaches a child that has no definition of its own", () => {
    // The generalist case (#185). The context block is the whole of what the prompt file adds
    // here, so a clause that only rendered alongside a definition's body would be missing for
    // every default dispatch — exactly the child that has nothing else to tell it what it is.
    const out = appendDepthHint("", 1, 3);
    expect(out, "the dispatch context, verbatim").toContain(DISPATCH_CONTEXT);
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

  test("listRegisteredAgents reads the scope's dirs and lists only definitions that name themselves", async () => {
    const home = await makeTempDir();
    const cwd = await makeTempDir();
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await writeFile(join(home, ".pi", "agent", "agents", "scout.md"), SCOUT_MD);
      // No frontmatter at all, so no `name:`, so not an agent (#201). The file name is NOT a
      // fallback: `discoverAgent("note-taker", ...)` returns null for this exact file, and
      // listing it put both answers in one refusal.
      await writeFile(join(home, ".pi", "agent", "agents", "note-taker.md"), "just a body\n");
      // Not markdown: never an agent.
      await writeFile(join(home, ".pi", "agent", "agents", "README.txt"), "notes\n");
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(join(cwd, ".pi", "agents", "reviewer.md"), REVIEWER_MD);

      // Names are sorted so the refusal message is deterministic.
      expect(listRegisteredAgents({ cwd, agentScope: "user", homeDir: home })).toEqual(["scout"]);
      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: home })).toEqual([
        "reviewer",
      ]);
      expect(listRegisteredAgents({ cwd, agentScope: "both", homeDir: home })).toEqual([
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
    //
    // **The silence is HERE and not further up, and what makes it safe changed (story 20 of #177,
    // re-decided by #187).** This test is the one that pins "an empty registry is not an error",
    // and on its own it reads like a green tick that means "quiet is correct" everywhere. It is
    // not: the listing is a lister, and a lister that failed on an empty directory would be wrong.
    //
    // For a while the reason the silence was safe was that `session_start` CONSUMED the empty list
    // and told the user about it — the silence was one half of a pair, and the comment here said
    // so. That consumer is gone, and the silence is still right, for a better reason: an empty
    // registry is not a degraded state. A dispatch that names nothing runs a generalist child
    // (ADR-0039), so there is nothing to report and nothing to compensate for. The pair is no
    // longer needed because the thing it guarded against — a quiet, unusable tool — is no longer
    // reachable: an install with no agent definitions is a working install.
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

  test("listRegisteredAgents warns and skips an agent file it cannot read", async () => {
    // Genuine read failure (constraint #1/#3 dual to the absent-dir case above). The fixture
    // is a real DIRECTORY named `ghost.md`: readFileSync then fails with EISDIR on every
    // platform, whereas chmod-0 can still be readable by the owning user on some setups — so
    // the EISDIR trick is deliberate and no platform gate / silent skip is needed.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await mkdir(join(cwd, ".pi", "agents", "ghost.md"));

      // Skipped, not listed under its file name (#201). `discoverAgent("ghost", ...)` reads
      // this same path, hits the same EISDIR, and returns null — so listing it advertised an
      // agent the refusal would deny. Counterfactual: restore the filename fallback -> red.
      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      // Constraint #3: the failure is observable, so skipping is not a silent failure.
      // Counterfactual: deleting the console.warn from the read failure path leaves the spy at
      // zero calls and fails this assertion; warning on the absent-dir path instead would fail
      // the call count.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain("pi.dispatch: cannot read agent file");
      expect(warning).toContain(join(cwd, ".pi", "agents", "ghost.md"));
      expect(warning).toContain("skipping it");
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns about a definition-shaped file it cannot parse", async () => {
    // Constraint #3, the dual the read-failure case above did not have: this file READS and then
    // fails to PARSE. The fixture is #204's real shape -- a definition whose opening `---` was
    // lost, so its first line is the `name:` key with a stray closing delimiter below it. The
    // same sample is pinned as UNPARSEABLE in tests/unit/agent-markdown-tolerance.test.ts.
    //
    // Before #204 the two cases were indistinguishable from outside: the roster said nothing
    // either way, so "the agent I wrote is missing" read the same as "no agents exist". Qwen
    // Code's own history is the cautionary case -- its comment records that silent skipping was
    // a bug they fixed for exactly this reason.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "broken.md"),
        ["name: reviewer", "---", "Review a diff."].join("\n"),
        "utf8",
      );

      // The ROSTER is unchanged by #204: a definition with no usable `name:` is not an agent,
      // so listing nothing is still the true answer (#201). Only the signal is new.
      // Counterfactual: restore the filename fallback -> red on this line.
      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      // Counterfactual: delete the parse-failure console.warn and the spy stays at zero calls,
      // which fails this line. Warning on an absent dir instead would make the count wrong too.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain(join(cwd, ".pi", "agents", "broken.md"));
      expect(warning).toContain("looks like an agent definition");
      expect(warning).toContain("not listed");
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents warns about a delimited file that declares no name", async () => {
    // The OTHER parse failure the discriminator has to catch, and it is #201's own case: both
    // delimiters are present and there is simply no `name:` to key the definition by.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "headless.md"),
        ["---", "description: a definition whose name key is gone", "---", "Review a diff."].join(
          "\n",
        ),
        "utf8",
      );

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0] ?? "").toContain(join(cwd, ".pi", "agents", "headless.md"));
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents stays silent about prose kept beside the agents", async () => {
    // The other half of #204's discriminator, and the test that makes its silence safe. A file
    // whose first non-blank line is neither `---` nor a `name:` key was never written as a
    // definition, so warning on it would make the warn meaningless -- every roster render in a
    // repo with a README in `.pi/agents/` would cry wolf.
    //
    // `guide.md` is the one that matters: its BODY contains both a `---` rule and a sentence
    // mentioning the `name:` key. Reading the whole file instead of its head would warn on it.
    // Counterfactual: widen the discriminator to scan the whole file -> red on the call count.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(join(cwd, ".pi", "agents", "README.md"), "# Agents\n\nHow to use these.\n");
      await writeFile(join(cwd, ".pi", "agents", "notes.txt"), "name: not a definition\n");
      await writeFile(
        join(cwd, ".pi", "agents", "guide.md"),
        [
          "# Guide",
          "",
          "Every definition sets a `name:` key in its frontmatter.",
          "",
          "---",
          "",
          "The rule above is a horizontal rule, not a frontmatter delimiter.",
        ].join("\n"),
        "utf8",
      );

      expect(listRegisteredAgents({ cwd, agentScope: "project", homeDir: cwd })).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents resolves a same-scope name collision deterministically and reports the loser", async () => {
    // Two files in ONE scope declaring one name is a user mistake, and the Agent Skills client
    // guide requires both halves of the answer: resolve it deterministically, and say which file
    // lost. Cross-scope shadowing is the opposite case and is deliberately NOT a diagnostic —
    // user-over-project is the documented rule (#207), not a fault.
    //
    // `zebra.md` sorts after `alpha.md`, so "first alphabetically" keeps `alpha.md`. That the
    // tie-break is alphabetical rather than filesystem order is the point: readdirSync's order
    // is undefined, and Claude Code documents its own behaviour here as "filesystem read order
    // rather than a documented precedence".
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      const definition = (body: string) =>
        ["---", "name: shared", `description: ${body}`, "---", body].join("\n");
      await writeFile(join(cwd, ".pi", "agents", "zebra.md"), definition("Z."), "utf8");
      await writeFile(join(cwd, ".pi", "agents", "alpha.md"), definition("A."), "utf8");

      const entries = listRegisteredAgentEntries({
        cwd,
        agentScope: "project",
        homeDir: cwd,
      });
      // ONE name survives, and it is the alphabetical first.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.description).toBe("A.");
      // And a dispatch agrees with the roster about WHICH copy — the #201 half that a
      // names-only comparison cannot see.
      expect(discoverAgent("shared", cwd, "project", { homeDir: cwd })?.systemPrompt).toBe("A.");
      // The loser is named. Counterfactual: drop the shadow diagnostic -> red on the count.
      expect(warn).toHaveBeenCalledTimes(1);
      const warning = warn.mock.calls[0]?.[0] ?? "";
      expect(warning).toContain('agent name "shared"');
      expect(warning).toContain("shadowing");
      expect(warning).toContain("zebra.md");
      expect(warning).toContain("alpha.md");
    } finally {
      warn.mockRestore();
      await removeTempDir(cwd);
    }
  });

  test("listRegisteredAgents does not warn when the same name is declared once per scope", async () => {
    // The other side of the rule above: user-over-project shadowing is the documented
    // precedence (#207), so listing it would be crying wolf on every `agentScope: "both"`
    // render for anyone who keeps a definition in both places.
    const cwd = await makeTempDir();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(join(cwd, ".pi", "agent", "agents"), { recursive: true });
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      const definition = (body: string) =>
        ["---", "name: shared", `description: ${body}`, "---", body].join("\n");
      await writeFile(
        join(cwd, ".pi", "agent", "agents", "shared.md"),
        definition("The user copy."),
        "utf8",
      );
      await writeFile(
        join(cwd, ".pi", "agents", "shared.md"),
        definition("The project copy."),
        "utf8",
      );

      const entries = listRegisteredAgentEntries({ cwd, agentScope: "both", homeDir: cwd });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe("user");
      expect(discoverAgent("shared", cwd, "both", { homeDir: cwd })?.source).toBe("user");
      expect(warn).not.toHaveBeenCalled();
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

  test("a GIVEN but unusable agent refuses, naming the way out that needs no file", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "helper.md"),
        "---\nname: helper\n---\nYou help.\n",
      );
      spawnRecorder.calls.length = 0;

      // The wire can deliver anything. A name that was GIVEN and is unusable is still a caller
      // bug — and it must never degrade to the unactionable "unknown agent: undefined" that
      // pitfall #2 was about. The project scope puts the temp agent dir in the listing (the
      // default "user" scope would not).
      const blank = await dispatch(
        { agent: "   ", task: "ping", agentScope: "project" },
        { callId: 21, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(blank.status).toBe("rejected");
      expect(blank.started).toBe(false);
      // Counterfactual: the old "unknown agent: undefined" message fails this prefix, and a
      // build that skips the listing fails the registered-agents line.
      expect(blank.errorMessage ?? "").toContain("agent, when given, must be a non-empty string");
      // The way OUT, not just the way it went wrong. Nothing pinned this clause before: deleting
      // "omit it entirely…" from the refusal left the suite green, so the half of the message that
      // tells a caller it never had to name anything could have been dropped unnoticed — and a
      // refusal that only describes the error teaches a model to keep guessing names.
      expect(blank.errorMessage ?? "").toContain("omit it entirely");
      expect(blank.errorMessage ?? "").toContain("generalist child");
      expect(blank.errorMessage ?? "").toContain("registered agents: [helper]");
      expect(blank.errorMessage ?? "").toContain(join(dir, ".pi", "agents"));
      expect(blank.errorMessage ?? "").toContain("name: <agent-name>");
      expect(spawnRecorder.calls).toHaveLength(0);

      // An empty string, a whitespace string and a non-string are one case, not three: given,
      // and unusable. Asserted separately because this is the side of the line the ABSENT case
      // is distinguished from, so losing any of them would blur the distinction rather than
      // simply drop a branch.
      const empty = await dispatch(
        { agent: "", task: "ping", agentScope: "project" },
        { callId: 22, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(empty.status).toBe("rejected");
      expect(empty.errorMessage ?? "").toContain("agent, when given");
      expect(spawnRecorder.calls).toHaveLength(0);

      const notAString = await dispatch(
        { agent: 42, task: "ping", agentScope: "project" } as unknown as DispatchInput,
        { callId: 23, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );
      expect(notAString.status).toBe("rejected");
      expect(notAString.errorMessage ?? "").toContain("agent, when given");
      expect(spawnRecorder.calls).toHaveLength(0);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("an ABSENT agent is no longer a refusal: it reaches a spawn that narrows nothing", async () => {
    const dir = await makeTempDir();
    try {
      spawnRecorder.calls.length = 0;

      /*
       * Issue #185, and the distinction this test exists to hold: absent means "I want no
       * narrowing", which is a legal request, while the cases above mean "the value you sent is
       * unusable". Collapsing the two is the defect, and it is a silent one — a caller's typo
       * would dispatch something it did not ask for.
       *
       * Counterfactual: put absent back through the malformed gate and this goes red while every
       * case in the test above stays green. That pair is the whole specification.
       */
      const result = await dispatch(
        { task: "ping", agentScope: "project" } as unknown as DispatchInput,
        { callId: 20, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );

      expect(
        result.errorMessage ?? "",
        "the generalist is not the malformed-name refusal",
      ).not.toContain("agent, when given");
      expect(spawnRecorder.calls.length, "it got all the way to a spawn").toBeGreaterThan(0);
      expect(
        spawnRecorder.calls[0]?.args.join(" "),
        "no tool allowlist reaches a generalist child",
      ).not.toContain("--tools");
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

  // --- pi 1.2.0's print-mode truncation close --------------------------------------
  //
  // pi 1.2.0 changed a truncated `-p` run from "exit 0 with partial text" to
  // "exit 1 + a stderr warning + the partial text". The literal below is copied
  // verbatim from `@earendil-works/pi-coding-agent@1.2.0`'s
  // `dist/modes/print-mode.js:126` — the independent source the expectation rests
  // on (testing-constraint #4), not a string this module invented.

  test("exit 1 + pi's truncation stderr line → rejected with the cause named", () => {
    const out = decideCloseOutcome({
      exitCode: 1,
      finalText: "partial answer",
      aborted: false,
      stderr: "Response was truncated: the model reached its output token limit.\n",
    });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBe(
      "child response was truncated at the model's output token limit (pi exited non-zero)",
    );
  });

  test("the truncation line is matched as a substring, not a whole-line equality", () => {
    // pi may prefix or suffix the sentence; the diagnostic value is the sentence itself.
    const out = decideCloseOutcome({
      exitCode: 1,
      finalText: "",
      aborted: false,
      stderr:
        "some banner\nResponse was truncated: the model reached its output token limit.\nmore",
    });
    expect(out.errorMessage).toBe(
      "child response was truncated at the model's output token limit (pi exited non-zero)",
    );
  });

  test("non-zero exit with OTHER stderr stays unlabelled (the counterfactual)", () => {
    // The counterfactual for the branch above: a predicate that reported truncation for
    // ANY non-zero close (or matched a looser word like "truncated" alone) would make
    // this pass a lie. A provider error, an auth failure, a rate limit — none of them
    // say this sentence, and none of them may be relabelled as one.
    const out = decideCloseOutcome({
      exitCode: 1,
      finalText: "",
      aborted: false,
      stderr: "Authentication failed for \"deepseek\". Run '/login deepseek' to re-authenticate.",
    });
    expect(out.status).toBe("rejected");
    expect(out.errorMessage).toBeUndefined();
  });

  test("undefined and empty stderr behave identically to the pre-1.2.0 shape", () => {
    // pi <= 1.1.x never writes the line, and a lifecycle adapter may not capture
    // stderr at all. Both must resolve exactly as before the field existed.
    for (const stderr of [undefined, ""] as const) {
      const out = decideCloseOutcome({ exitCode: 1, finalText: "", aborted: false, stderr });
      expect(out.errorMessage, "stderr: " + JSON.stringify(stderr)).toBeUndefined();
    }
  });

  test("the truncation branch cannot upgrade a rejected close to fulfilled", () => {
    // A truncated child still failed: pi exited 1. The branch only names the cause,
    // it never changes the status — that is what makes it safe to ignore for callers
    // that only branch on status.
    const out = decideCloseOutcome({
      exitCode: 1,
      finalText: "partial answer",
      aborted: false,
      stderr: "Response was truncated: the model reached its output token limit.",
    });
    expect(out.status).toBe("rejected");
  });

  test("the truncation line is inert on a fulfilled close (exit 0 wins)", () => {
    // On pi <= 1.1.x a truncated run exits 0 with partial text. If the stderr line ever
    // appeared there (it does not today), the exit-0 branch must still win: a close that
    // produced text is a fulfilment, not a failure to diagnose.
    const out = decideCloseOutcome({
      exitCode: 0,
      finalText: "partial answer",
      aborted: false,
      stderr: "Response was truncated: the model reached its output token limit.",
    });
    expect(out.status).toBe("fulfilled");
    expect(out.errorMessage).toBeUndefined();
  });
});

describe("truncationFailureMessage", () => {
  // The shared predicate both fronts read, tested on its own so the wording contract
  // is pinned where it lives rather than through decideCloseOutcome's copy of it.
  test("the exported constant IS pi's own line, byte for byte", () => {
    // The one assertion that keeps this from drifting into a paraphrase: if pi ever
    // rewords the sentence, this literal must be re-measured, and this test is where
    // that shows up (testing-constraint #4 — the expectation names its source).
    expect(PI_TRUNCATION_WARNING).toBe(
      "Response was truncated: the model reached its output token limit.",
    );
  });

  test("recognises the sentence anywhere in the buffer, returns the shared wording", () => {
    expect(truncationFailureMessage("noise\n" + PI_TRUNCATION_WARNING + "\n")).toBe(
      "child response was truncated at the model's output token limit (pi exited non-zero)",
    );
  });

  test("returns undefined for absent, empty, and unrelated stderr", () => {
    expect(truncationFailureMessage(undefined)).toBeUndefined();
    expect(truncationFailureMessage("")).toBeUndefined();
    // A near-miss that a word-level match would take: the full sentence is the claim.
    expect(truncationFailureMessage("Response was truncated.")).toBeUndefined();
    expect(truncationFailureMessage("the model reached its output token limit.")).toBeUndefined();
  });
});

/**
 * The FOREGROUND close handler's wiring, driven through the production adapter.
 *
 * `decideCloseOutcome` is heavily unit-tested above, and every one of those tests calls it
 * DIRECTLY. That left the seam between the real close handler and the function untested: deleting
 * `stderr: stderrText` from the `decideCloseOutcome({...})` call at dispatch.ts:2287 left all 52
 * tests in this file green, because the truncation sentence stops being forwarded only on the path
 * that reads a child's actual stderr.
 *
 * So these tests drive `dispatch()` itself. The fake child is spawned through the
 * `node:child_process` mock above, which means the REAL `RealChildProcessLifecycle` adapts it
 * (stdout -> JSONL events, stderr -> the buffer, close -> exit value) and the REAL close handler
 * decides the outcome. The truncation sentence asserted here is pi's own line, copied verbatim
 * from `@earendil-works/pi-coding-agent@1.2.0` `dist/modes/print-mode.js:126` — the independent
 * source (constraint #4).
 *
 * Counterfactual: replace `stderr: stderrText` with `stderr: undefined` in the close handler and
 * the first test goes red (`errorMessage` becomes `undefined`); nothing else here changes.
 */
describe("foreground close: the child's stderr reaches the outcome (production wiring)", () => {
  /** pi 1.2.0's print-mode truncation warning, byte for byte (print-mode.js:126). */
  const TRUNCATION_STDERR = "Response was truncated: the model reached its output token limit.\n";
  /** The wording `truncationFailureMessage` produces, written out so this file is not reading the
   * sentence back out of the function it is testing. */
  const TRUNCATED_ERROR =
    "child response was truncated at the model's output token limit (pi exited non-zero)";

  /** An agent whose markdown parses, so `dispatch()` reaches the spawn. */
  async function makeProject(dir: string, name: string): Promise<void> {
    await mkdir(join(dir, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "agents", name + ".md"),
      `---\nname: ${name}\n---\nYou probe.\n`,
    );
  }

  test("exit 1 + pi's truncation line -> rejected with the cause named on the DispatchResult", async () => {
    const dir = await makeTempDir();
    try {
      await makeProject(dir, "stderr-probe");
      spawnRecorder.calls.length = 0;
      // A partial answer, then the truncation warning on stderr, then exit 1 — pi 1.2.0's shape.
      spawnRecorder.nextChild = {
        stdout:
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
          }) + "\n",
        stderr: TRUNCATION_STDERR,
        exitCode: 1,
      };

      const result = await dispatch(
        { agent: "stderr-probe", task: "ping", agentScope: "project" },
        { callId: 31, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );

      // The whole point: this errorMessage exists ONLY because the close handler forwarded the
      // captured stderr into decideCloseOutcome. Cut that forwarding and it is undefined.
      expect(result.status).toBe("rejected");
      expect(result.errorMessage, "the truncation cause reaches the caller").toBe(TRUNCATED_ERROR);
      // The child's stderr is ALSO on the result, so the bytes themselves are not in doubt — the
      // claim under test is that they reached the DECISION.
      expect(result.stderr).toBe(TRUNCATION_STDERR);
      // pi exited 1, so the child ran and failed (not a refusal): `started` stays true.
      expect(result.started).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("the same close WITHOUT the truncation line stays unlabelled (the counterfactual)", async () => {
    const dir = await makeTempDir();
    try {
      await makeProject(dir, "stderr-probe");
      spawnRecorder.calls.length = 0;
      // A provider error on stderr instead: non-zero exit, real bytes, but a sentence that does
      // not name truncation. A predicate wired to ANY stderr would pass the test above as a lie.
      const authStderr =
        "Authentication failed for \"deepseek\". Run '/login deepseek' to re-authenticate.\n";
      spawnRecorder.nextChild = { stderr: authStderr, exitCode: 1 };

      const result = await dispatch(
        { agent: "stderr-probe", task: "ping", agentScope: "project" },
        { callId: 32, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );

      expect(result.status).toBe("rejected");
      // Unlabelled: the run failed, but nothing in the bytes says why, so the honest answer is no
      // errorMessage rather than a guess. This is the assertion that keeps the first test honest.
      expect(result.errorMessage).toBeUndefined();
      expect(result.stderr).toBe(authStderr);
    } finally {
      await removeTempDir(dir);
    }
  });

  test("the truncation line cannot upgrade the close to fulfilled, or the status at all", async () => {
    const dir = await makeTempDir();
    try {
      await makeProject(dir, "stderr-probe");
      spawnRecorder.calls.length = 0;
      // exit 0 wins over the warning, and the child produced no text: the answer is the
      // "produced no final text" rejection, NOT the truncation sentence. Guards a reordering of
      // the close handler's ladder, which the direct unit tests above cannot see.
      spawnRecorder.nextChild = { stderr: TRUNCATION_STDERR, exitCode: 0 };

      const result = await dispatch(
        { agent: "stderr-probe", task: "ping", agentScope: "project" },
        { callId: 33, cwd: dir, depth: 0, maxDispatchDepth: 3 },
      );

      expect(result.status).toBe("rejected");
      expect(result.errorMessage).toBe("dispatch produced no final text");
    } finally {
      await removeTempDir(dir);
    }
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
