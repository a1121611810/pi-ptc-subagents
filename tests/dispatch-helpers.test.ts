import { describe, expect, test } from "vitest";
import {
  appendDepthHint,
  buildArgv,
  discoverAgent,
  parseAgentEvent,
  parseAgentMarkdown,
  type AgentConfigLike,
} from "../src/runtime/dispatch.ts";

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
