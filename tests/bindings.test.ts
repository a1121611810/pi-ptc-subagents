import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BUILTIN_BINDING_NAMES, createBuiltinBindings, DEFAULT_BINDING_NAMES } from "../src/runtime/bindings.ts";
import { makeTempDir, removeTempDir, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

const options = { timeout: RUN_TIMEOUT_MS };
const call = { callId: 1 };

test("bash is part of the default binding set on purpose", () => {
  assert.deepEqual([...DEFAULT_BINDING_NAMES], [...BUILTIN_BINDING_NAMES]);
  assert.ok(DEFAULT_BINDING_NAMES.includes("bash"), "DSH's PTC preset keeps its shell tool mounted as a binding");
  for (const name of ["read", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(DEFAULT_BINDING_NAMES.includes(name as never), `${name} must be bindable`);
  }
});

test("createBuiltinBindings builds every built-in by default and honours an explicit subset", () => {
  const all = createBuiltinBindings({ cwd: process.cwd() });
  assert.deepEqual([...all.keys()], [...BUILTIN_BINDING_NAMES]);
  for (const binding of all.values()) assert.equal(typeof binding.execute, "function");

  const readOnly = createBuiltinBindings({ cwd: process.cwd(), names: ["read", "grep"] });
  assert.deepEqual([...readOnly.keys()], ["read", "grep"]);

  const none = createBuiltinBindings({ cwd: process.cwd(), names: [] });
  assert.equal(none.size, 0);
});

test("createBuiltinBindings rejects unknown binding names", () => {
  assert.throws(
    () => createBuiltinBindings({ cwd: process.cwd(), names: ["read", "teleport"] }),
    (error: Error) => error instanceof TypeError && /unknown PTC binding "teleport"/.test(error.message),
  );
});

test("the read binding resolves relative paths against the run cwd", options, async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "fixture.txt"), "line one\nline two\n");
    const bindings = createBuiltinBindings({ cwd: dir });
    const result = (await bindings.get("read")?.execute({ path: "fixture.txt" }, call)) as {
      content: Array<{ type: string; text: string }>;
      details: unknown;
    };
    assert.equal(result.content[0]?.text, "line one\nline two\n");
    assert.equal(result.details, null, "an absent details payload is normalized to null");
  } finally {
    await removeTempDir(dir);
  }
});

test("the bash binding runs in the run cwd", options, async () => {
  const dir = await makeTempDir();
  try {
    const bindings = createBuiltinBindings({ cwd: dir, names: ["bash"] });
    const result = (await bindings.get("bash")?.execute({ command: "pwd" }, call)) as {
      content: Array<{ text: string }>;
    };
    assert.equal(result.content[0]?.text.trim(), dir);
  } finally {
    await removeTempDir(dir);
  }
});

test("binding arguments are validated with pi's own tool validator", options, async () => {
  const bindings = createBuiltinBindings({ cwd: process.cwd(), names: ["read"] });
  await assert.rejects(
    () => bindings.get("read")?.execute({ offset: 2 }, call) as Promise<unknown>,
    /Validation failed for tool "read"/,
  );
});

test("a failing tool calls rejects with the tool's own error", options, async () => {
  const dir = await makeTempDir();
  try {
    const bindings = createBuiltinBindings({ cwd: dir, names: ["read"] });
    await assert.rejects(
      () => bindings.get("read")?.execute({ path: "does-not-exist.txt" }, call) as Promise<unknown>,
      (error: Error) => error instanceof Error && error.message.length > 0,
    );
  } finally {
    await removeTempDir(dir);
  }
});
