import { expect, test } from "vitest";
import {
  createWorkerEnv,
  DEFAULT_CONFIG,
  effectiveTimeoutMs,
  resolveConfig,
  WORKER_ENV_ALLOW_LIST,
} from "../src/runtime/limits.ts";

test("DEFAULT_CONFIG is frozen and every limit is a positive finite number", () => {
  expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  for (const value of Object.values(DEFAULT_CONFIG)) {
    expect(typeof value).toBe("number");
    expect(Number.isFinite(value) && value > 0).toBeTruthy();
  }
});

test("resolveConfig returns the frozen defaults when nothing is overridden", () => {
  expect(resolveConfig()).toEqual({ ...DEFAULT_CONFIG });
  expect(resolveConfig()).not.toBe(DEFAULT_CONFIG);
});

test("resolveConfig applies overrides and rejects invalid ones", () => {
  expect(resolveConfig({ maxOutputBytes: 1024 }).maxOutputBytes).toBe(1024);
  expect(resolveConfig({ maxOutputBytes: 1024 }).maxPendingCalls).toBe(
    DEFAULT_CONFIG.maxPendingCalls,
  );

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => resolveConfig({ graceMs: invalid })).toThrow(TypeError);
  }
  expect(() => resolveConfig({ graceMs: "soon" as unknown as number })).toThrow(TypeError);
  // Unknown keys are ignored rather than silently merged.
  expect(resolveConfig({ nope: 1 } as never)).toEqual({ ...DEFAULT_CONFIG });
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
  expect(Object.keys(env).sort()).toEqual(["PATH", "PATHEXT", "TEMP"]);
  expect(env.PATH).toBe("/usr/bin");

  for (const name of Object.keys(env)) {
    expect(WORKER_ENV_ALLOW_LIST).toContain(name);
  }
  for (const name of Object.keys(source)) {
    if (WORKER_ENV_ALLOW_LIST.includes(name) && name !== "TMP") continue;
    expect(name in env).toBe(false);
  }
});

test("effectiveTimeoutMs falls back to the default and clamps to the ceiling", () => {
  expect(effectiveTimeoutMs(undefined)).toBe(DEFAULT_CONFIG.timeoutMs);
  expect(effectiveTimeoutMs(0)).toBe(DEFAULT_CONFIG.timeoutMs);
  expect(effectiveTimeoutMs(Number.NaN)).toBe(DEFAULT_CONFIG.timeoutMs);
  expect(effectiveTimeoutMs(1_000)).toBe(1_000);
  expect(effectiveTimeoutMs(DEFAULT_CONFIG.maxTimeoutMs * 10)).toBe(DEFAULT_CONFIG.maxTimeoutMs);
});
