import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.equal(typeof ptcSubagents, "function");
  assert.equal(ptcSubagents.length, 1, "the factory takes the ExtensionAPI parameter");
  assert.equal(ptcSubagents(stub), undefined);
});

test("the factory registers both PTC tools against the ExtensionAPI", () => {
  const tools = captureRegisteredTools();
  assert.deepEqual([...tools.keys()], ["ptc_run_code", "ptc_workflow"]);
  for (const [name, tool] of tools) {
    assert.equal(typeof tool.execute, "function", `${name} must be executable`);
    assert.equal(typeof tool.description, "string", `${name} must carry a model-facing description`);
    assert.equal(typeof tool.parameters, "object", `${name} must carry a typebox schema`);
  }
});

test("the factory module re-exports the machinery T4/T5 build on", () => {
  assert.equal(typeof runPtcProgram, "function");
  assert.equal(typeof createBuiltinBindings, "function");
  assert.equal(typeof createWorkerEnv, "function");
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(HOST_FRAME_KIND.init, "init");
  assert.equal(WORKER_FRAME_KIND.result, "result");
  assert.equal(PTC_ERROR_KIND.workerExit, "worker-exit");
});
