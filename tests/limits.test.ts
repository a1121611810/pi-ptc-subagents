import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkerEnv,
  DEFAULT_CONFIG,
  effectiveTimeoutMs,
  resolveConfig,
  WORKER_ENV_ALLOW_LIST,
} from "../src/runtime/limits.ts";

test("DEFAULT_CONFIG is frozen and every limit is a positive finite number", () => {
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(typeof value, "number", `${key} must be a number`);
    assert.ok(Number.isFinite(value) && value > 0, `${key} must be positive and finite`);
  }
});

test("resolveConfig returns the frozen defaults when nothing is overridden", () => {
  assert.deepEqual(resolveConfig(), { ...DEFAULT_CONFIG });
  assert.notEqual(resolveConfig(), DEFAULT_CONFIG, "callers must get their own copy");
});

test("resolveConfig applies overrides and rejects invalid ones", () => {
  assert.equal(resolveConfig({ maxOutputBytes: 1024 }).maxOutputBytes, 1024);
  assert.equal(
    resolveConfig({ maxOutputBytes: 1024 }).maxPendingCalls,
    DEFAULT_CONFIG.maxPendingCalls,
  );

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveConfig({ graceMs: invalid }),
      TypeError,
      `graceMs=${String(invalid)} must be rejected`,
    );
  }
  assert.throws(() => resolveConfig({ graceMs: "soon" as unknown as number }), TypeError);
  // Unknown keys are ignored rather than silently merged.
  assert.deepEqual(resolveConfig({ nope: 1 } as never), { ...DEFAULT_CONFIG });
});

test("createWorkerEnv keeps only allow-listed names (F1)", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    DEEPSEEK_API_KEY: "secret",
    TEMP: "/tmp",
    TMP: "",
    PATHEXT: ".EXE",
  };
  const env = createWorkerEnv(source);
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "PATHEXT", "TEMP"]);
  assert.equal(env.PATH, "/usr/bin");

  for (const name of Object.keys(env)) {
    assert.ok(WORKER_ENV_ALLOW_LIST.includes(name), `${name} is not on the allow-list`);
  }
  for (const name of Object.keys(source)) {
    if (WORKER_ENV_ALLOW_LIST.includes(name) && name !== "TMP") continue;
    assert.equal(name in env, false, `${name} must not reach the worker`);
  }
});

test("effectiveTimeoutMs falls back to the default and clamps to the ceiling", () => {
  assert.equal(effectiveTimeoutMs(undefined), DEFAULT_CONFIG.timeoutMs);
  assert.equal(
    effectiveTimeoutMs(0),
    DEFAULT_CONFIG.timeoutMs,
    "0 does not disable the deadline (DSH behaviour)",
  );
  assert.equal(effectiveTimeoutMs(Number.NaN), DEFAULT_CONFIG.timeoutMs);
  assert.equal(effectiveTimeoutMs(1_000), 1_000);
  assert.equal(effectiveTimeoutMs(DEFAULT_CONFIG.maxTimeoutMs * 10), DEFAULT_CONFIG.maxTimeoutMs);
});
