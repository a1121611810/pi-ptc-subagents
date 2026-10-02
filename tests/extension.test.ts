import { expect, test } from "vitest";
import type { ExtensionStub } from "./helpers/ptc.ts";
import type { CodemodePresence } from "../src/mode/ptc-mode.ts";
import ptcSubagents, {
  createBuiltinBindings,
  createWorkerEnv,
  DEFAULT_CONFIG,
  HOST_FRAME_KIND,
  PTC_ERROR_KIND,
  runPtcProgram,
  WORKER_FRAME_KIND,
} from "../src/index.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTIVE_CODEMODE_SETTINGS,
  captureRegisteredTools,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  stubContext,
  writeAgentSettings,
} from "./helpers/ptc.ts";

/**
 * The factory's contract with pi is "register the PTC tools and the mode hooks against the
 * ExtensionAPI it is handed" — which the parameter type checks against pi's real declaration at
 * compile time. `makeExtensionStub` supplies the same surface pi does.
 */

test("the default export is the extension factory and runs without touching pi", () => {
  expect(typeof ptcSubagents).toBe("function");
  expect(ptcSubagents.length).toBe(1);
  expect(ptcSubagents(makeExtensionStub().api)).toBe(undefined);
});

test("the factory registers the two PTC tools and the three background-task tools", () => {
  const tools = captureRegisteredTools();
  // BG-14: the three ptc_task_* tools are always-on, registered at factory time outside /ptc mode.
  expect([...tools.keys()]).toEqual([
    "ptc_run_code",
    "ptc_workflow",
    "ptc_task_list",
    "ptc_task_output",
    "ptc_task_stop",
  ]);
  for (const tool of tools.values()) {
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.parameters).toBe("object");
  }
});

test("the factory module re-exports the machinery T4/T5 build on", () => {
  expect(typeof runPtcProgram).toBe("function");
  expect(typeof createBuiltinBindings).toBe("function");
  expect(typeof createWorkerEnv).toBe("function");
  expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  expect(HOST_FRAME_KIND.init).toBe("init");
  expect(WORKER_FRAME_KIND.result).toBe("result");
  expect(PTC_ERROR_KIND.workerExit).toBe("worker-exit");
});

// --------------------------------------------------------------------------------------
// Surface mode (ADR-0025)
// --------------------------------------------------------------------------------------

const PTC_TOOLS = ["ptc_run_code", "ptc_workflow"] as const;
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;

test("full mode registers the orchestration tools and the lifecycle face", () => {
  // The literal set, not a length: a tool dropped from one group has to turn this red.
  const tools = makeExtensionStub({ surfaceMode: "full" }).tools;
  expect([...tools.keys()]).toEqual([...PTC_TOOLS, ...TASK_TOOLS]);
});

test("subagents mode drops the orchestration tools and keeps the lifecycle face", () => {
  const tools = makeExtensionStub({ surfaceMode: "subagents" }).tools;
  expect([...tools.keys()], "pi codemode does the orchestrating here").toEqual([
    "ptc_subagent",
    ...TASK_TOOLS,
  ]);
  for (const name of PTC_TOOLS) {
    expect(tools.has(name), name + " must not exist in this mode").toBe(false);
  }
});

test("off mode registers no tool, no command and no handler at all", () => {
  // "No injection" has to mean no handler, not a handler that returns nothing. Asserting on
  // output would pass for an off mode that still wired itself into the agent loop.
  const stub = makeExtensionStub({ surfaceMode: "off" });
  expect([...stub.tools.keys()], "stock pi: not one of our tools").toEqual([]);
  expect([...stub.commands.keys()], "no /ptc command either").toEqual([]);
  expect([...stub.handlers.keys()], "no agent-loop wiring at all").toEqual([]);
  expect(stub.statuses, "no status footer").toEqual([]);
  expect(stub.activeWrites, "the loadout is never touched").toEqual([]);
});

test("the surface mode is read once, before anything is registered", () => {
  // If the read were lazy the tools would already exist and honouring off would need an
  // unregister call, which pi does not have. The off test above is the evidence; this one
  // states the ordering as its own claim so a future refactor cannot quietly move it.
  const off = makeExtensionStub({ surfaceMode: "off" });
  const sub = makeExtensionStub({ surfaceMode: "subagents" });
  expect(off.tools.size).toBe(0);
  expect(sub.tools.size, "the subagent tool plus the lifecycle face").toBe(TASK_TOOLS.length + 1);
  expect(makeExtensionStub({ surfaceMode: "full" }).tools.size).toBe(5);
});

test("each surface registers a distinct set, and no mode keeps both orchestrators", () => {
  const sets = (["off", "subagents", "full"] as const).map((surfaceMode) =>
    [...makeExtensionStub({ surfaceMode }).tools.keys()].join(","),
  );
  expect(new Set(sets).size, "three modes, three distinct surfaces: " + sets.join(" | ")).toBe(3);
  for (const surfaceMode of ["off", "subagents"] as const) {
    const keys = [...makeExtensionStub({ surfaceMode }).tools.keys()];
    expect(keys.includes("ptc_run_code"), surfaceMode).toBe(false);
    expect(keys.includes("ptc_workflow"), surfaceMode).toBe(false);
  }
});

test("subagents mode without codemode warns once, and says what to do about it", async () => {
  // Constraint 3: the failure path is visible. A mode that quietly leaves the model with a
  // subagent tool and no orchestrator is the bug this warning exists to prevent.
  const stub = makeExtensionStub({ surfaceMode: "subagents" });
  await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
  const warnings = stub.notifications.filter((n) => n.type === "warning");
  expect(warnings.length, "one warning, not a stream of them").toBe(1);
  expect(warnings[0]?.message).toContain("codemode");
  expect(warnings[0]?.message, "names the setting the user has to change").toContain("surfaceMode");
});

test("the warning does not fire when codemode is active", async () => {
  const stub = makeExtensionStub({
    surfaceMode: "subagents",
    active: ["read", "bash", "edit", "write", "codemode", "ptc_subagent"],
  });
  await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
  expect(
    stub.notifications.filter((n) => n.type === "warning"),
    "no false alarm",
  ).toEqual([]);
});

test("full mode never warns about codemode, present or not", async () => {
  // `full` brings its own orchestrator, so a missing codemode is not this package's problem.
  for (const active of [
    ["read", "bash", "edit", "write"],
    ["read", "bash", "edit", "write", "codemode"],
  ]) {
    const stub = makeExtensionStub({ surfaceMode: "full", active });
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    expect(
      stub.notifications.filter((n) => n.message.includes("codemode")),
      "full mode must stay quiet about codemode",
    ).toEqual([]);
  }
});

test("off mode registers nothing, so it has nothing to warn about", async () => {
  const stub = makeExtensionStub({ surfaceMode: "off" });
  expect(stub.handlers.size, "no session_start handler exists to warn from").toBe(0);
  expect(stub.notifications).toEqual([]);
});

/**
 * Build a stub whose factory call really reads the agent dir, for a given file body. The
 * `codemode` argument is the probe result the factory is told to believe (ADR-0026); without it the
 * real probe runs against the test runner's argv, which is not a pi.
 *
 * `settings` is the user-scope `settings.json` body, which is what the activation probe reads
 * (ADR-0029). Omitted means the default session: no `defaultTools`, so codemode is not active and
 * the surface is `full`.
 */
async function stubFromAgentDir(
  contents: unknown,
  codemode?: CodemodePresence,
  settings?: unknown,
): Promise<{ stub: ExtensionStub; dir: string }> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (contents !== null) {
      await writeFile(join(dir, "ptc.json"), JSON.stringify(contents), "utf8");
    }
    if (settings !== undefined) {
      await writeAgentSettings(dir, settings);
    }
    return {
      stub: makeExtensionStub({
        surfaceMode: "from-file",
        ...(codemode === undefined ? {} : { codemode }),
      }),
      dir,
    };
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("the factory's own config read is what decides the surface, not the test seam", async () => {
  // Standards round 1 finding 1, and the reason the stub has a from-file escape hatch. The
  // per-mode tests all go through options.surfaceMode, so without this one the production
  // line readSurfaceModeConfig(getAgentDir()) had no test at all -- mutating it to a hardcoded
  // "full" left the entire suite green.
  for (const [contents, expected] of [
    [{ surfaceMode: "off" }, []],
    [{ surfaceMode: "subagents" }, ["ptc_subagent", ...TASK_TOOLS]],
    [{ surfaceMode: "full" }, [...PTC_TOOLS, ...TASK_TOOLS]],
  ] as const) {
    const { stub, dir } = await stubFromAgentDir(contents);
    try {
      expect([...stub.tools.keys()], JSON.stringify(contents)).toEqual([...expected]);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test("with no preference from the user, the surface is decided by the pi (ADR-0026, ADR-0029)", async () => {
  // This is the new default, and it is the one behaviour that changes for an existing install. The
  // previous version of this test asserted `full` and passed for the wrong reason: the factory ran
  // the real probe, the real probe looked at vitest's argv, and vitest has no pi next to it. Both
  // branches are stated here instead of inherited from the machine.
  //
  // ADR-0029 adds a column, and it is the column that decides the DEFAULT. pi ships codemode and
  // loads it by default while registering it `defaultActive: false`, so with no `defaultTools`
  // anywhere the answer is `full` -- the model cannot call the tool we would have handed
  // orchestration to. The `subagents` cell is now reachable only when a user configures codemode
  // into the loadout, and the last row pins that this cannot resurrect a pi without the tool.
  const cases = [
    {
      where: "codemode present, nothing configured",
      codemode: { present: true, how: "found" },
      settings: undefined,
      expected: [...PTC_TOOLS, ...TASK_TOOLS],
    },
    {
      where: "codemode present and configured active",
      codemode: { present: true, how: "found" },
      settings: ACTIVE_CODEMODE_SETTINGS,
      expected: ["ptc_subagent", ...TASK_TOOLS],
    },
    {
      where: "codemode absent, nothing configured",
      codemode: { present: false, how: "not-found" },
      settings: undefined,
      expected: [...PTC_TOOLS, ...TASK_TOOLS],
    },
    {
      where: "codemode absent even though a loadout names it",
      codemode: { present: false, how: "not-found" },
      settings: ACTIVE_CODEMODE_SETTINGS,
      expected: [...PTC_TOOLS, ...TASK_TOOLS],
    },
  ] as const;
  for (const contents of [null, { defaultMode: false }]) {
    for (const { where, codemode, settings, expected } of cases) {
      const { stub, dir } = await stubFromAgentDir(contents, codemode, settings);
      try {
        expect([...stub.tools.keys()], `${JSON.stringify(contents)} with ${where}`).toEqual([
          ...expected,
        ]);
      } finally {
        await removeTempDir(dir);
      }
    }
  }
});

test("an explicit surfaceMode wins over the probe, whichever way the probe came out", async () => {
  // The user's setting is the whole point: detection is a default, not an override.
  for (const codemode of [
    { present: true, how: "found" },
    { present: false, how: "not-found" },
  ] as const) {
    const { stub, dir } = await stubFromAgentDir({ surfaceMode: "full" }, codemode);
    try {
      expect([...stub.tools.keys()], `explicit full, codemode ${codemode.how}`).toEqual([
        ...PTC_TOOLS,
        ...TASK_TOOLS,
      ]);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test("a malformed file still gives the detected surface, and the problem is reported", async () => {
  // Spec decision 3: warns and falls back. The fallback alone is pinned in ptc-mode.test.ts;
  // what is new here is that the FACTORY surfaces the problem rather than swallowing it.
  //
  // ADR-0026 decision 5: the fallback is the DETECTED default, not a constant, so both
  // directions are stated and the presence is passed through the seam explicitly. Before, this
  // named no `codemode` at all, the real probe ran against vitest's argv, and `not-found` was
  // the only reason the full surface was expected -- the assertion would have passed just as
  // happily on a pi that does ship codemode.
  for (const [codemode, expected] of [
    [{ present: true, how: "found" }, ["ptc_subagent", ...TASK_TOOLS]],
    [{ present: false, how: "not-found" }, [...PTC_TOOLS, ...TASK_TOOLS]],
  ] as const) {
    const dir = await makeTempDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const where = "codemode " + codemode.how;
    try {
      await writeFile(join(dir, "ptc.json"), "{ not json", "utf8");
      // ADR-0029: the `subagents` expectation above needs codemode in the loadout, or the
      // factory resolves `full` and the assertion would hold for the wrong reason.
      await writeAgentSettings(dir, ACTIVE_CODEMODE_SETTINGS);
      const stub = makeExtensionStub({ surfaceMode: "from-file", codemode });
      await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
      expect([...stub.tools.keys()], "a broken file must not half-apply: " + where).toEqual([
        ...expected,
      ]);
      // Scoped to this file's own warning on purpose. `subagents` on a session without an
      // active `codemode` raises a second, unrelated warning (ADR-0025 decision 4), and counting
      // every warning would make this test depend on that. The count still catches a duplicate:
      // both readers parse the same file, so a second copy of this sentence carries the same
      // "ptc.json" and lands in this filter.
      const configWarnings = stub.notifications.filter(
        (n) => n.type === "warning" && n.message.includes("ptc.json"),
      );
      expect(configWarnings.length, "the parse failure is visible, once: " + where).toBe(1);
      expect(configWarnings[0]?.message).toContain("not valid JSON");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await removeTempDir(dir);
    }
  }
});
test("a detected subagents surface on a pi that does not register codemode says so", async () => {
  // The filesystem probe cannot see --no-extensions or --exclude-tools codemode, so it answers
  // "present" for a pi that has codemode on disk and registers no such tool. The session is
  // then handed to an orchestrator that is not there, and the decision-4 warning cannot catch
  // it: that one asks whether codemode is ACTIVE, and with the tool absent both questions are
  // false for the same reason. This is the only assertion standing between that hole and a
  // silent session.
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // No ptc.json at all: the surface is DETECTED, and the probe is told pi has codemode. The
    // `defaultTools` are what make it a `subagents` surface at all (ADR-0029) -- without them the
    // factory answers `full` and neither warning under test is reachable.
    await writeAgentSettings(dir, ACTIVE_CODEMODE_SETTINGS);
    const stub = makeExtensionStub({
      surfaceMode: "from-file",
      codemode: { present: true, how: "found" },
      active: ["read", "bash", "edit", "write"],
    });
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    // Scoped to this notice: the decision-4 warning fires too, and it SHOULD -- a detected
    // subagents surface with no active codemode is exactly the state it exists to report. Two
    // warnings for one root cause is noisy, so the fix is in the message, not the count.
    const notices = stub.notifications.filter((n) => n.message.includes("--no-extensions"));
    expect(notices.length, "the over-estimate is reported").toBe(1);
    expect(notices[0]?.type, "and it is a warning, not a note").toBe("warning");
    expect(notices[0]?.message, "and it names the fix").toContain('"full"');
    // The surface this warning is about. Without it the test also passes on a `full` session,
    // where the cross-check cannot fire at all -- the notice is then vacuously absent.
    expect([...stub.tools.keys()], "and the session really is holding a subagent face").toEqual([
      "ptc_subagent",
      ...TASK_TOOLS,
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
});

test("a detected subagents surface on a pi that DOES register codemode stays quiet", async () => {
  // The other half, and the one that would catch a warning that fires on every healthy session.
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    await writeAgentSettings(dir, ACTIVE_CODEMODE_SETTINGS);
    const stub = makeExtensionStub({
      surfaceMode: "from-file",
      codemode: { present: true, how: "found" },
      active: ["read", "bash", "edit", "write", "codemode"],
    });
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    // The surface, before the silence. Without this the test also passes on a `full` session --
    // where neither warning is reachable -- so "healthy" would be asserted about a session that
    // never had the problem. ADR-0029 made that reachable by default, which is why it is pinned.
    expect(
      [...stub.tools.keys()],
      "a healthy session is the subagents face beside an active codemode",
    ).toEqual(["ptc_subagent", ...TASK_TOOLS]);
    // Scoped the same way: the PTC-mode announcement is this file's pre-existing noise and says
    // nothing about detection.
    expect(
      stub.notifications.filter((n) => n.message.includes("--no-extensions")),
      "healthy means silent",
    ).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
});
