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
import { captureRegisteredTools, makeExtensionStub } from "./helpers/ptc.ts";

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

test("the factory registers both PTC tools against the ExtensionAPI", () => {
  const tools = captureRegisteredTools();
  expect([...tools.keys()]).toEqual(["ptc_run_code", "ptc_workflow"]);
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
