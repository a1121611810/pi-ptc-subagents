import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DEFAULT_BINDING_NAMES,
  DISPATCH_BINDING_NAME,
} from "../src/runtime/bindings.ts";
import { makeTempDir, removeTempDir, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

const options = RUN_TIMEOUT_MS;
const call = { callId: 1, depth: 0, maxDispatchDepth: 3 };

test("bash is part of the default binding set on purpose", () => {
  expect([...DEFAULT_BINDING_NAMES]).toEqual([...BUILTIN_BINDING_NAMES]);
  expect(DEFAULT_BINDING_NAMES).toContain("bash");
  for (const name of ["read", "edit", "write", "grep", "find", "ls"]) {
    expect(DEFAULT_BINDING_NAMES).toContain(name as never);
  }
});

test("createBuiltinBindings builds every built-in by default and honours an explicit subset", () => {
  const all = createBuiltinBindings({ cwd: process.cwd() });
  expect(new Set(all.keys())).toEqual(new Set([...BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME]));
  for (const binding of all.values()) expect(typeof binding.execute).toBe("function");

  const readOnly = createBuiltinBindings({ cwd: process.cwd(), names: ["read", "grep"] });
  expect([...readOnly.keys()]).toEqual(["read", "grep"]);

  const none = createBuiltinBindings({ cwd: process.cwd(), names: [] });
  expect(none.size).toBe(0);
});

test("createBuiltinBindings rejects unknown binding names", () => {
  let caught: unknown;
  try {
    createBuiltinBindings({ cwd: process.cwd(), names: ["read", "teleport"] });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).message).toMatch(/unknown PTC binding "teleport"/);
});

test(
  "the read binding resolves relative paths against the run cwd",
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "fixture.txt"), "line one\nline two\n");
      const bindings = createBuiltinBindings({ cwd: dir });
      const result = (await bindings.get("read")?.execute({ path: "fixture.txt" }, call)) as {
        content: Array<{ type: string; text: string }>;
        details: unknown;
      };
      expect(result.content[0]?.text).toBe("line one\nline two\n");
      expect(result.details).toBe(null);
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test(
  "the bash binding runs in the run cwd",
  async () => {
    const dir = await makeTempDir();
    try {
      const bindings = createBuiltinBindings({ cwd: dir, names: ["bash"] });
      const result = (await bindings.get("bash")?.execute({ command: "pwd" }, call)) as {
        content: Array<{ text: string }>;
      };
      expect(result.content[0]?.text.trim()).toBe(dir);
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test(
  "binding arguments are validated with pi's own tool validator",
  async () => {
    const bindings = createBuiltinBindings({ cwd: process.cwd(), names: ["read"] });
    await expect(
      () => bindings.get("read")?.execute({ offset: 2 }, call) as Promise<unknown>,
    ).rejects.toThrow(/Validation failed for tool "read"/);
  },
  options,
);

test(
  "a failing tool calls rejects with the tool's own error",
  async () => {
    const dir = await makeTempDir();
    try {
      const bindings = createBuiltinBindings({ cwd: dir, names: ["read"] });
      await expect(
        () =>
          bindings.get("read")?.execute({ path: "does-not-exist.txt" }, call) as Promise<unknown>,
      ).rejects.toThrow();
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);
