import { expect, test } from "vitest";
import ptcSubagents, {
  createBuiltinBindings,
  createWorkerEnv,
  DEFAULT_CONFIG,
  HOST_FRAME_KIND,
  PTC_ERROR_KIND,
  runPtcProgram,
  WORKER_FRAME_KIND,
} from "../src/index.ts";
import { captureRegisteredTools, makeExtensionStub, stubContext } from "./helpers/ptc.ts";

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
