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

/**
 * A stub is enough here: T3 ships no tool registration, so the factory's contract with pi
 * is just "be a function pi can call with an ExtensionAPI" — which the parameter type
 * checks against pi's real declaration at compile time.
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

test("the factory module re-exports the machinery T4/T5 build on", () => {
  assert.equal(typeof runPtcProgram, "function");
  assert.equal(typeof createBuiltinBindings, "function");
  assert.equal(typeof createWorkerEnv, "function");
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(HOST_FRAME_KIND.init, "init");
  assert.equal(WORKER_FRAME_KIND.result, "result");
  assert.equal(PTC_ERROR_KIND.workerExit, "worker-exit");
});
