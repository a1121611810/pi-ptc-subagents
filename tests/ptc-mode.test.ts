/**
 * PTC default mode: the pure decision logic, the config reader, and the extension's own wiring.
 *
 * The mode has one job that is easy to get wrong — narrowing a session's tool loadout without
 * emptying the binding table — so the tests below are organized around that:
 *
 *  - pure functions: entry policy, loadout shape, binding source, external-change detection
 *  - config: `~/.pi/agent/ptc.json` semantics (absent / off / malformed)
 *  - wiring: driven through the extension stub, i.e. the same entry points pi calls
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  bindingSource,
  buildModeInstruction,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
  initialModeState,
  MODE_REQUIRED_TOOL_NAMES,
  modeLoadout,
  PTC_MODE_CONFIG_FILE,
  PTC_MODE_ENTRY_TYPE,
  readDefaultModeConfig,
  resolveBaseOnStart,
  sameToolSet,
} from "../src/mode/ptc-mode.ts";
import { PTC_SKILL_LOAD_INSTRUCTION } from "../src/mode/skills-section.ts";
import { BUILTIN_BINDING_NAMES } from "../src/runtime/bindings.ts";
import { resolveBindingNames } from "../src/tools/common.ts";
import {
  DEFAULT_SESSION_TOOLS,
  makeExtensionStub,
  makeTempDir,
  modeContext,
  removeTempDir,
  stubContext,
} from "./helpers/ptc.ts";

const PTC_TOOLS = ["ptc_run_code", "ptc_workflow"];
/** What a default session offers: pi's four defaults plus this package's two tools. */
const FULL = [...DEFAULT_SESSION_TOOLS, ...PTC_TOOLS];
/** Every name that could be bound, for tests that need a session with all of them enabled. */
const ALL_BINDABLE = [...BUILTIN_BINDING_NAMES, ...PTC_TOOLS];

/**
 * Run `fn` with `~/.pi/agent` redirected to a temp dir. `getAgentDir()` re-reads the env var on
 * every call, so this is enough to isolate config tests from the developer's real setup; the
 * assertion inside makes a future env-var rename fail loudly instead of silently reading the
 * wrong directory.
 */
async function withAgentDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir("pi-ptc-agentdir-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
}

// --------------------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------------------

test("config defaults to on when no file exists, and reports where the value came from", async () => {
  await withAgentDir(async (dir) => {
    const config = readDefaultModeConfig(dir);
    expect(config).toEqual({ defaultMode: true, source: "default" });
  });
});

test("config honours an explicit defaultMode and reports the file as the source", async () => {
  await withAgentDir(async (dir) => {
    await writeFile(
      join(dir, PTC_MODE_CONFIG_FILE),
      JSON.stringify({ defaultMode: false }),
      "utf8",
    );
    // Proves the redirect is effective before the assertion that depends on it.
    expect(readDefaultModeConfig(getAgentDir())).toEqual({ defaultMode: false, source: "file" });
  });
});

test("a broken config file is reported as invalid and still defaults to on", async () => {
  await withAgentDir(async (dir) => {
    await writeFile(join(dir, PTC_MODE_CONFIG_FILE), "{ not json", "utf8");
    const broken = readDefaultModeConfig(dir);
    expect(broken.defaultMode).toBe(true);
    expect(broken.source).toBe("invalid");
    expect(broken.error).toContain("not valid JSON");

    await writeFile(join(dir, PTC_MODE_CONFIG_FILE), JSON.stringify({ defaultMode: "no" }), "utf8");
    const wrongType = readDefaultModeConfig(dir);
    expect(wrongType.defaultMode).toBe(true);
    expect(wrongType.source).toBe("invalid");
    expect(wrongType.error).toContain("must be a boolean");

    await writeFile(join(dir, PTC_MODE_CONFIG_FILE), JSON.stringify(["nope"]), "utf8");
    expect(readDefaultModeConfig(dir).error).toContain("must contain a JSON object");
  });
});

test("a file without defaultMode is equivalent to an absent file", async () => {
  await withAgentDir(async (dir) => {
    await writeFile(join(dir, PTC_MODE_CONFIG_FILE), JSON.stringify({ other: 1 }), "utf8");
    expect(readDefaultModeConfig(dir)).toEqual({ defaultMode: true, source: "default" });
  });
});

// --------------------------------------------------------------------------------------
// Pure decision logic
// --------------------------------------------------------------------------------------

test("entry policy: TUI only, config-gated, and never against an explicit tool restriction", () => {
  const base = { mode: "tui", defaultMode: true, active: FULL, manual: false } as const;

  expect(decideModeEntry(base)).toEqual({
    enter: true,
    base: FULL,
    loadout: modeLoadout(FULL, DEFAULT_HIDE_STRATEGY),
  });

  for (const mode of ["print", "json", "rpc"]) {
    expect(decideModeEntry({ ...base, mode })).toEqual({ enter: false, reason: "not-tui" });
  }
  expect(decideModeEntry({ ...base, defaultMode: false })).toEqual({
    enter: false,
    reason: "config-off",
  });
  expect(decideModeEntry({ ...base, active: ["read", "ptc_run_code"] })).toEqual({
    enter: false,
    reason: "restricted-session",
  });
  expect(decideModeEntry({ ...base, active: ["read", "bash"] })).toEqual({
    enter: false,
    reason: "tools-unavailable",
  });
});

test("manual entry overrides config and restriction, keeping bindings inside the allowlist", () => {
  const restricted = ["read", "ptc_run_code"];
  const decision = decideModeEntry({
    mode: "tui",
    defaultMode: false,
    active: restricted,
    manual: true,
  });
  expect(decision.enter).toBe(true);
  if (!decision.enter) throw new Error("unreachable");
  // The point of the manual path: the mode may narrow, but bindings never widen past what the
  // session was launched with (T7).
  expect(resolveBindingNames(decision.base)).toEqual(["read"]);
  expect(decision.base).toEqual(restricted);
});

test("a default four-tool session enters the mode (the seven bindable names are not the default surface)", () => {
  // Regression guard: `BUILTIN_BINDING_NAMES` lists every name that *can* be bound, not what a
  // default session has. Requiring all seven made every ordinary session look restricted, so the
  // mode never turned on at all.
  const decision = decideModeEntry({ mode: "tui", defaultMode: true, active: FULL, manual: false });
  expect(MODE_REQUIRED_TOOL_NAMES).toEqual([...DEFAULT_SESSION_TOOLS]);
  expect(decision.enter).toBe(true);
  if (!decision.enter) throw new Error("unreachable");
  // Bindings follow the session, so a default session binds four tools — not seven.
  expect(resolveBindingNames(decision.base)).toEqual([...DEFAULT_SESSION_TOOLS]);

  // Dropping any one of them does read as a restriction.
  for (const dropped of DEFAULT_SESSION_TOOLS) {
    const narrowed = FULL.filter((name) => name !== dropped);
    expect(
      decideModeEntry({ mode: "tui", defaultMode: true, active: narrowed, manual: false }),
    ).toEqual({ enter: false, reason: "restricted-session" });
  }
});

test("modeLoadout keeps extension tools under the default strategy and drops them on all-but-ptc", () => {
  const active = [...ALL_BINDABLE, "web_search", "todo"];
  expect(modeLoadout(active, "builtins-only")).toEqual([...PTC_TOOLS, "web_search", "todo"]);
  expect(modeLoadout(active, "all-but-ptc")).toEqual([...PTC_TOOLS]);
});

test("bindings derive from the base snapshot while the mode is on, and from the live loadout otherwise", () => {
  const off = initialModeState();
  const active = [...BUILTIN_BINDING_NAMES, ...PTC_TOOLS];
  const narrowed = [...PTC_TOOLS, "web_search"];

  expect(bindingSource(off, active)).toEqual(active);

  const on = { enabled: true, base: active, ourLoadout: narrowed };
  // This is the trap the mode exists to survive: the live loadout no longer holds the built-ins,
  // but the binding table must still see them.
  expect(bindingSource(on, narrowed)).toEqual(active);
  expect(resolveBindingNames(bindingSource(on, narrowed))).toEqual([...BUILTIN_BINDING_NAMES]);
  // …and a restricted session stays restricted even when the mode is on.
  const restricted = { enabled: true, base: ["read"], ourLoadout: [...PTC_TOOLS] };
  expect(resolveBindingNames(bindingSource(restricted, narrowed))).toEqual(["read"]);
});

test("external loadout changes are detected only while the mode owns the loadout", () => {
  const narrowed = [...PTC_TOOLS, "web_search"];
  const on = { enabled: true, base: FULL, ourLoadout: narrowed };
  expect(detectExternalLoadoutChange(on, narrowed)).toBe(false);
  // Same members, different order: not a change.
  expect(detectExternalLoadoutChange(on, [...narrowed].reverse())).toBe(false);
  expect(detectExternalLoadoutChange(on, [...FULL])).toBe(true);
  expect(detectExternalLoadoutChange(on, [...PTC_TOOLS])).toBe(true);
  expect(detectExternalLoadoutChange(initialModeState(), FULL)).toBe(false);
});

test("sameToolSet ignores order and duplicates but not membership", () => {
  expect(sameToolSet(["a", "b"], ["b", "a"])).toBe(true);
  expect(sameToolSet(["a", "b"], ["a", "b", "c"])).toBe(false);
  expect(sameToolSet(["a", "a"], ["a"])).toBe(false);
});

test("resolveBaseOnStart adopts the live loadout unless the session is still narrowed by us", () => {
  // A fresh process: the live loadout is what this launch asked for, so an older snapshot must not
  // override a new --tools choice.
  expect(resolveBaseOnStart({ enabled: true, base: FULL }, ["read"])).toEqual({
    base: ["read"],
    restoreFirst: false,
  });
  // A /reload or resumed session: the loadout is still ours, so restore the recorded base.
  expect(resolveBaseOnStart({ enabled: true, base: FULL }, [...PTC_TOOLS])).toEqual({
    base: FULL,
    restoreFirst: true,
  });
  // Persisted as off: nothing to restore.
  expect(resolveBaseOnStart({ enabled: false }, [...PTC_TOOLS])).toEqual({
    base: [...PTC_TOOLS],
    restoreFirst: false,
  });
  expect(resolveBaseOnStart(undefined, FULL)).toEqual({ base: FULL, restoreFirst: false });
});

test("the injected briefing lists the bindings of this session, not a hardcoded seven", () => {
  const full = buildModeInstruction([...BUILTIN_BINDING_NAMES], "builtins-only");
  for (const name of BUILTIN_BINDING_NAMES) expect(full).toContain(`tools.${name}(args)`);
  expect(full).toContain("[PTC MODE ACTIVE]");
  expect(full).toContain("/ptc off");

  const restricted = buildModeInstruction(["read"], "builtins-only");
  expect(restricted).toContain("tools.read(args)");
  expect(restricted).not.toContain("tools.bash(args)");
});

// --------------------------------------------------------------------------------------
// Wiring, driven through the extension stub
// --------------------------------------------------------------------------------------

test("session_start narrows the loadout, persists the record, paints the status and announces", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    await stub.emit("session_start", stubContext(stub));

    expect(stub.activeWrites).toHaveLength(1);
    expect(stub.activeWrites[0]).toEqual(modeLoadout(FULL, DEFAULT_HIDE_STRATEGY));
    expect(stub.entries).toEqual([
      { customType: PTC_MODE_ENTRY_TYPE, data: { enabled: true, base: FULL } },
    ]);
    expect(stub.statuses).toEqual([{ key: "ptc-mode", text: "PTC" }]);
    expect(stub.notifications).toHaveLength(1);
    expect(stub.notifications[0]?.message).toContain("PTC mode on");
    expect(stub.notifications[0]?.message).toContain("/ptc off");
    expect(stub.notifications[0]?.message).toContain("read, bash");
  });
});

test("print/json/rpc modes and opt-out leave the loadout alone", async () => {
  await withAgentDir(async () => {
    const printStub = makeExtensionStub();
    await printStub.emit("session_start", modeContext({ mode: "print" }));
    expect(printStub.activeWrites).toEqual([]);

    await writeFile(
      join(getAgentDir(), PTC_MODE_CONFIG_FILE),
      JSON.stringify({ defaultMode: false }),
      "utf8",
    );
    const optedOut = makeExtensionStub();
    await optedOut.emit("session_start", stubContext(optedOut));
    expect(optedOut.activeWrites).toEqual([]);
    expect(optedOut.statuses).toEqual([{ key: "ptc-mode", text: undefined }]);
  });
});

test("a session launched with an explicit tool restriction is left as launched", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub({ active: ["read", "bash", "ptc_run_code", "ptc_workflow"] });
    await stub.emit("session_start", stubContext(stub));

    expect(stub.activeWrites).toEqual([]);
    expect(stub.notifications.some((n) => n.message.includes("explicit tool restriction"))).toBe(
      true,
    );
  });
});

test("/ptc off restores the base loadout and /ptc on re-enters it", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = modeContext();
    await stub.emit("session_start", ctx);

    const command = stub.commands.get("ptc");
    expect(command).toBeDefined();
    if (command === undefined) return;

    await command.handler("off", ctx);
    expect(stub.active).toEqual(FULL);
    expect(stub.activeWrites.at(-1)).toEqual(FULL);
    expect(stub.entries.at(-1)).toEqual({
      customType: PTC_MODE_ENTRY_TYPE,
      data: { enabled: false },
    });

    await command.handler("on", ctx);
    expect(stub.active).toEqual(modeLoadout(FULL, DEFAULT_HIDE_STRATEGY));
  });
});

test("a persisted off-state survives a resume even when the config still says default-on", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = modeContext({
      entries: [{ type: "custom", customType: PTC_MODE_ENTRY_TYPE, data: { enabled: false } }],
    });
    await stub.emit("session_start", ctx);
    expect(stub.activeWrites).toEqual([]);
  });
});

test("the briefing is injected once per mode entry, not once per turn", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = modeContext();
    await stub.emit("session_start", ctx);

    const first = await stub.emit("before_agent_start", ctx);
    const second = await stub.emit("before_agent_start", ctx);

    const briefing = (first[0] as { message?: { content?: string } } | undefined)?.message;
    expect(briefing?.content).toContain("[PTC MODE ACTIVE]");
    expect(second[0]).toBeUndefined();
  });
});

test("the mode yields the loadout when another extension changes it", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);

    // Simulate a peer extension (pi's own preset.ts / tools.ts do this).
    stub.api.setActiveTools([...FULL, "web_search"]);
    const writesBefore = stub.activeWrites.length;

    await stub.emit("before_agent_start", ctx);
    expect(stub.active).toEqual(FULL);
    expect(stub.activeWrites).toHaveLength(writesBefore + 1);
    expect(stub.activeWrites.at(-1)).toEqual(FULL);
    expect(stub.notifications.at(-1)).toEqual({
      message: "PTC mode off — another extension changed the active tool set.",
      type: "warning",
    });

    // …and a later turn does not re-enter, re-brief, or write the loadout again.
    const after = await stub.emit("before_agent_start", ctx);
    expect(after[0]).toBeUndefined();
    expect(stub.activeWrites).toHaveLength(writesBefore + 1);
  });
});

test("/ptc with no argument reports the current state without changing anything", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    await stub.emit("session_start", stubContext(stub));

    const command = stub.commands.get("ptc");
    if (command === undefined) throw new Error("command missing");
    const writes = stub.activeWrites.length;
    await command.handler("", stubContext(stub));

    expect(stub.activeWrites.length).toBe(writes);
    expect(stub.notifications.at(-1)?.message).toContain("PTC mode is ON");
    expect(stub.notifications.at(-1)?.message).toContain("read, bash");
  });
});

/**
 * The skills section pi withholds while `read`/`bash` are hidden (ADR-0011).
 *
 * These drive the real `before_agent_start` handler with the event shape pi sends, because the
 * bug they cover was invisible in this package's own tests: pi drops the section, not us.
 */
function promptOptions(skills: unknown[]): { sections: Record<string, string>; skills: unknown[] } {
  return { sections: {}, skills };
}

function fakeSkill(name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name,
    description: `${name} does things`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { type: "user" },
    disableModelInvocation: false,
    ...overrides,
  };
}

async function emitBeforeAgentStart(
  stub: ReturnType<typeof makeExtensionStub>,
  ctx: ReturnType<typeof modeContext>,
  options: unknown,
): Promise<void> {
  const handler = stub.handlers.get("before_agent_start")?.[0];
  if (handler === undefined) throw new Error("before_agent_start handler is not registered");
  await handler({ type: "before_agent_start", systemPromptOptions: options }, ctx);
}

test("the skills pi hides are restored, with the PTC call form as the instruction", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);
    expect(stub.active).not.toContain("read");

    const options = promptOptions([fakeSkill("code-review"), fakeSkill("tdd")]);
    await emitBeforeAgentStart(stub, ctx, options);

    const section = options.sections.skills ?? "";
    expect(section).toContain("<available_skills>");
    expect(section).toContain("<name>code-review</name>");
    expect(section).toContain(PTC_SKILL_LOAD_INSTRUCTION);
    expect(section).not.toContain("Use the read tool");
  });
});

test("leaving the mode removes the injected section so pi's own can take over", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);
    const options = promptOptions([fakeSkill("tdd")]);
    await emitBeforeAgentStart(stub, ctx, options);
    expect(options.sections.skills).toBeDefined();

    const command = stub.commands.get("ptc");
    if (command === undefined) throw new Error("command missing");
    await command.handler("off", ctx);
    await emitBeforeAgentStart(stub, ctx, options);

    expect("skills" in options.sections).toBe(false);
    expect(stub.active).toContain("read");
  });
});

test("a session with nothing advertisable gets no section at all", async () => {
  await withAgentDir(async () => {
    const stub = makeExtensionStub();
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);

    const options = promptOptions([fakeSkill("grill-with-docs", { disableModelInvocation: true })]);
    await emitBeforeAgentStart(stub, ctx, options);
    expect(options.sections.skills).toBeUndefined();
  });
});
