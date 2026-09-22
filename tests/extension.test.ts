import { expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ptcSubagents, {
  createBuiltinBindings,
  createWorkerEnv,
  DEFAULT_CONFIG,
  HOST_FRAME_KIND,
  PTC_ERROR_KIND,
  runPtcProgram,
  WORKER_FRAME_KIND,
} from "../src/index.ts";
import { captureRegisteredTools } from "./helpers/ptc.ts";

/**
 * A stub is enough here: the factory's contract with pi is just "register the PTC tools with the
 * ExtensionAPI it is handed" — which the parameter type checks against pi's real declaration at
 * compile time.
 */
const stub = {
  registerTool: () => {},
  on: () => () => {},
} as unknown as ExtensionAPI;

test("the default export is the extension factory and runs without touching pi", () => {
  expect(typeof ptcSubagents).toBe("function");
  expect(ptcSubagents.length).toBe(1);
  expect(ptcSubagents(stub)).toBe(undefined);
});

test("the factory registers both PTC tools against the ExtensionAPI", () => {
  const tools = captureRegisteredTools();
  expect([...tools.keys()]).toEqual(["ptc_run_code", "ptc_workflow"]);
  for (const [name, tool] of tools) {
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