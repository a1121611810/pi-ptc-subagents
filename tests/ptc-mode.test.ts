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
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  bindingSource,
  buildModeInstruction,
  decideModeEntry,
  DEFAULT_HIDE_STRATEGY,
  detectExternalLoadoutChange,
  detectSurfaceMode,
  detectedSurfaceMode,
  initialModeState,
  MODE_REQUIRED_TOOL_NAMES,
  modeLoadout,
  probeCodemodePresence,
  PTC_MODE_CONFIG_FILE,
  PTC_MODE_ENTRY_TYPE,
  readDefaultModeConfig,
  readLegacySurfaceKey,
  resolveBaseOnStart,
  sameToolSet,
  SURFACE_MODES,
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

/**
 * ADR-0027: the two probe answers, pinned as constants so a test states the pi it is reasoning
 * about instead of inheriting the machine's. `ABSENT` is what pi's own default implies — the
 * built-in extensions "load by default" — so it is the switch a settings file that says nothing
 * resolves to.
 */
const PRESENT_CODEMODE = { present: true, how: "found" } as const;
const ABSENT_SWITCH = { switch: "absent", source: "default" } as const;
/**
 * ADR-0029's third axis, stated explicitly wherever a test is reasoning about the PRESENCE or the
 * SWITCH rather than about activation.
 *
 * These tests predate the activation probe and are about the first two columns of the table, so
 * they pass the column that keeps their subject visible. Leaving the argument out instead would
 * run the real probe against a temp agent dir with no settings in it — which resolves to
 * `inactive`, and silently retargets every one of them at the new default cell.
 */
const ACTIVE_CODEMODE = { activation: "active", source: "default" } as const;
/** The other half, for the tests that exist precisely to show the default cell. */
const INACTIVE_CODEMODE = { activation: "inactive", source: "default" } as const;
/** What a default session offers: pi's four defaults plus this package's two tools. */
const FULL = [...DEFAULT_SESSION_TOOLS, ...PTC_TOOLS];
/** Every name that could be bound, for tests that need a session with all of them enabled. */
const ALL_BINDABLE = [...BUILTIN_BINDING_NAMES, ...PTC_TOOLS];
/**
 * The two answers `detectSurfaceMode` has to give for a fixed pi, keyed to the presence it is
 * reasoning about (ADR-0026 decision 5).
 *
 * Stated as a pair rather than as one expectation so that neither a hardcoded `full` nor a
 * hardcoded `subagents` can satisfy the tests below.
 */
const DETECTED_SURFACE_CASES = [
  [PRESENT_CODEMODE, "subagents"],
  [{ present: false, how: "not-found" } as const, "full"],
] as const;

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

// --------------------------------------------------------------------------------------
// Surface mode config (ADR-0025)
// --------------------------------------------------------------------------------------

test("detectSurfaceMode answers from the three axes, and reports every probe it used", async () => {
  // The whole contract of the function in one expectation. It is a pure function of its arguments
  // and nothing else — no `ptc.json` is read, and there is no `source` / `detected` / `error`
  // field left to carry one. Both directions are stated so that neither a hardcoded `full` nor a
  // hardcoded `subagents` can satisfy it.
  await withAgentDir(async (dir) => {
    expect(
      detectSurfaceMode(dir, { present: false, how: "not-found" }, ABSENT_SWITCH, ACTIVE_CODEMODE),
    ).toEqual({
      surfaceMode: "full",
      codemode: { present: false, how: "not-found" },
      codemodeSwitch: ABSENT_SWITCH,
      codemodeActivation: ACTIVE_CODEMODE,
    });
    expect(detectSurfaceMode(dir, PRESENT_CODEMODE, ABSENT_SWITCH, ACTIVE_CODEMODE)).toEqual({
      surfaceMode: "subagents",
      codemode: PRESENT_CODEMODE,
      codemodeSwitch: ABSENT_SWITCH,
      codemodeActivation: ACTIVE_CODEMODE,
    });
  });
});

test("a present, loadable codemode that the model cannot call resolves to full (ADR-0029)", async () => {
  // The cell the previous table did not have, and the DEFAULT on a real 1.0.0 install: pi ships
  // codemode, loads it, registers it with `defaultActive: false`, and the model still cannot call
  // it. Delegating here is what produced a session with `ptc_subagent` and no orchestrator.
  //
  // The activation argument is the ONLY difference from the `subagents` expectation above, so
  // dropping the third check from `detectedSurfaceMode` turns both of these red.
  await withAgentDir(async (dir) => {
    const detected = detectSurfaceMode(dir, PRESENT_CODEMODE, ABSENT_SWITCH, INACTIVE_CODEMODE);
    expect(detected.surfaceMode).toBe("full");
    expect(detected.codemodeActivation).toEqual(INACTIVE_CODEMODE);
  });
});

test("with no settings at all, activation is inactive and the surface is full", async () => {
  // The end-to-end version of the cell above, through the real reader rather than a stated
  // argument: a temp agent dir with no `settings.json` in either scope is what every default
  // session looks like, and it must land on `full`.
  //
  // `cwd` is the temp dir as well as `agentDir`, because the activation probe reads BOTH the
  // project and the user file. Leaving it at `process.cwd()` would put this repo (and any
  // `.pi/settings.json` a developer keeps there) into the answer.
  await withAgentDir(async (dir) => {
    const detected = detectSurfaceMode(dir, PRESENT_CODEMODE, ABSENT_SWITCH, undefined, dir);
    expect(detected.surfaceMode).toBe("full");
    expect(detected.codemodeActivation).toEqual({ activation: "inactive", source: "default" });
  });
});

test("SURFACE_MODES is exactly the two surfaces, and `off` is not one of them", () => {
  // The literal, not a length. `"off"` shipped in v1.6.0 and a value that came back would put a
  // surface in the type that nothing can produce, so the constant is pinned against the name.
  expect([...SURFACE_MODES]).toEqual(["subagents", "full"]);
});

test("a ptc.json holding a stale surfaceMode does not reach the surface, whatever the axes say", async () => {
  // The inverse of the tests this replaces. Those existed because a `surfaceMode` key COULD decide
  // the answer, so a reader that ignored it had to be pinned. Nothing reads it now — the only
  // thing the package does with the key is report it (`readLegacySurfaceKey`, below) — so the
  // claim needing a test is the refusal.
  //
  // Both directions are stated: a factory that hardcoded `full` passes the first pair and fails
  // the second, and one that hardcoded `subagents` does the reverse.
  for (const stale of [
    { surfaceMode: "off" },
    { surfaceMode: "subagents" },
    { surfaceMode: "full" },
  ]) {
    await withAgentDir(async (dir) => {
      await writeFile(join(dir, PTC_MODE_CONFIG_FILE), JSON.stringify(stale), "utf8");
      for (const [presence, expected] of DETECTED_SURFACE_CASES) {
        const detected = detectSurfaceMode(dir, presence, ABSENT_SWITCH, ACTIVE_CODEMODE);
        expect(detected.surfaceMode, `${JSON.stringify(stale)} with codemode ${presence.how}`).toBe(
          expected,
        );
      }
    });
  }
});

test("readLegacySurfaceKey reports a stale key and its value, and nothing else does", async () => {
  // The reader behind the migration notice. Every value the key ever took, because a reader that
  // filtered to `"off"` — the one that disables the package — would pass a single-case test and
  // leave a user who pinned `"subagents"` unannounced.
  await withAgentDir(async (dir) => {
    for (const value of ["off", "subagents", "full"]) {
      await writeFile(
        join(dir, PTC_MODE_CONFIG_FILE),
        JSON.stringify({ surfaceMode: value }),
        "utf8",
      );
      expect(readLegacySurfaceKey(dir), value).toEqual({
        path: join(dir, PTC_MODE_CONFIG_FILE),
        value,
      });
    }
    // A non-string is still a key the user wrote, and it is reported AS WRITTEN rather than
    // rendered: a notice quoting `"7"` for `7` would misreport the file the user can open.
    await writeFile(join(dir, PTC_MODE_CONFIG_FILE), JSON.stringify({ surfaceMode: 7 }), "utf8");
    expect(readLegacySurfaceKey(dir)?.value, "the value, not a rendering of it").toBe(7);
  });
});

test("readLegacySurfaceKey stays silent for an absent key, a broken file and a non-object", async () => {
  // The three ways a `ptc.json` can fail to carry one. All three must be silence rather than a
  // reported error, and each for a different reason: the key was never set; the file is broken
  // and `readDefaultModeConfig` owns that report; the file is not an object at all.
  //
  // The broken-file case is asserted with a TRUNCATED object whose text literally contains
  // `"surfaceMode": "off"` — a reader that searched the raw text, or that reported on a failed
  // parse, would announce a key in a file pi never managed to read.
  await withAgentDir(async (dir) => {
    for (const body of [
      JSON.stringify({ defaultMode: false }),
      JSON.stringify({ defaultMode: false, surfaceMode: undefined }),
      "{ not json",
      '{ "surfaceMode": "off"',
      "[]",
      "null",
      "3",
    ]) {
      await writeFile(join(dir, PTC_MODE_CONFIG_FILE), body, "utf8");
      expect(readLegacySurfaceKey(dir), body).toBeUndefined();
    }
  });
  // An agent dir with no file at all, which is the common case.
  await withAgentDir(async (dir) => {
    expect(readLegacySurfaceKey(dir), "no ptc.json at all").toBeUndefined();
  });
});

test("the two keys in ptc.json are read independently, and the stale one does not shadow the live one", async () => {
  // `defaultMode` still lives in this file and is still read; the removed key is read only to be
  // reported. A reader that returned early on seeing `surfaceMode` would silently opt every such
  // user out of PTC mode — a behaviour change nobody would notice, which is what this pins.
  await withAgentDir(async (dir) => {
    await writeFile(
      join(dir, PTC_MODE_CONFIG_FILE),
      JSON.stringify({ defaultMode: false, surfaceMode: "off" }),
      "utf8",
    );
    expect(readDefaultModeConfig(dir).defaultMode, "the live key still decides the mode").toBe(
      false,
    );
    expect(readLegacySurfaceKey(dir)?.value, "and the stale one is still reported").toBe("off");
  });
});

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
  // Pitfall #1: the briefing must surface the always-bound parallel binding in its
  // string-indexed form, plus the per-run manifest global (pitfall #5).
  expect(full).toContain('tools["pi.dispatch"](args)');
  expect(full).toContain("ptcBindings");

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
    // Scoped to the mode's own announcement. The total notification count used to be exactly 1,
    // and it stopped being when the surface stop stopped being pinnable: with no `surfaceMode` to
    // short-circuit detection, `surface.codemode` is always populated, so the probe-miss `info`
    // notice now fires on any session whose pi has no codemode beside it — which under vitest is
    // every session in this file. Counting all of them would make this test about the probe, and
    // the assertion below states the part that is about the mode.
    const modeNotices = stub.notifications.filter((n) => n.message.includes("PTC mode on"));
    expect(modeNotices.length, "announced once").toBe(1);
    expect(modeNotices[0]?.message).toContain("/ptc off");
    expect(modeNotices[0]?.message).toContain("read, bash");
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

describe("probeCodemodePresence", () => {
  test("finds codemode next to a real pi entry script, through a symlink", async () => {
    // The shape a package-manager install actually has: argv[1] is a shim, the real file is a
    // symlink target, and the extension sits one level above the bundle directory. A probe that
    // skipped realpath would report every one of these as absent and flip the default to full.
    const root = await makeTempDir();
    try {
      const bundle = join(root, "dist", "bundle");
      await mkdir(join(root, "dist", "extensions", "codemode"), { recursive: true });
      await mkdir(bundle, { recursive: true });
      const real = join(bundle, "cli.js");
      await writeFile(real, "", "utf8");
      const shim = join(root, "pi");
      await symlink(real, shim);
      expect(probeCodemodePresence(["node", shim])).toEqual({ present: true, how: "found" });
    } finally {
      await removeTempDir(root);
    }
  });

  test("finds codemode in a pi with no dist/bundle level", async () => {
    const root = await makeTempDir();
    try {
      await mkdir(join(root, "extensions", "codemode"), { recursive: true });
      const entry = join(root, "cli.js");
      await writeFile(entry, "", "utf8");
      expect(probeCodemodePresence(["node", entry])).toEqual({ present: true, how: "found" });
    } finally {
      await removeTempDir(root);
    }
  });

  test("a pi without codemode reports absent, not an error", async () => {
    const root = await makeTempDir();
    try {
      const entry = join(root, "cli.js");
      await writeFile(entry, "", "utf8");
      expect(probeCodemodePresence(["node", entry])).toEqual({ present: false, how: "not-found" });
    } finally {
      await removeTempDir(root);
    }
  });

  test("a FILE named codemode is not a pi that ships codemode", async () => {
    // isDirectory, not exists: a stray file at that path would otherwise flip the default.
    const root = await makeTempDir();
    try {
      await mkdir(join(root, "extensions"), { recursive: true });
      await writeFile(join(root, "extensions", "codemode"), "not a directory", "utf8");
      const entry = join(root, "cli.js");
      await writeFile(entry, "", "utf8");
      expect(probeCodemodePresence(["node", entry]).present).toBe(false);
    } finally {
      await removeTempDir(root);
    }
  });

  test("every unusable argv falls back to full rather than to a guess", async () => {
    // The fallback direction is the whole design: a probe that cannot answer must not be allowed
    // to answer yes. subagents as a failure mode takes away the session's orchestrator.
    for (const [argv, how] of [
      [["node"], "no-entry"],
      [["node", ""], "no-entry"],
      [["node", "/nonexistent/pi-shim"], "unresolvable-entry"],
    ] as const) {
      const presence = probeCodemodePresence(argv as readonly string[]);
      expect(presence, JSON.stringify(argv)).toEqual({ present: false, how });
      // ADR-0027: the switch is the second question now, and ADR-0029 added a third. An absent
      // switch means pi's default, which is to load codemode; an absent activation means it is
      // not callable. Passing both explicitly keeps the test honest about which input decided.
      expect(detectedSurfaceMode(presence, "absent", "active"), JSON.stringify(argv)).toBe("full");
    }
  });
});
