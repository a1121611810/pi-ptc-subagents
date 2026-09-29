import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DEFAULT_BINDING_NAMES,
  DISPATCH_BINDING_NAME,
} from "../src/runtime/bindings.ts";
import { resolveBindingNames } from "../src/tools/common.ts";
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

test("createBuiltinBindings mirrors the production shape: resolved names plus includeDispatch expose pi.dispatch", () => {
  // Production never passes `names: undefined`: both tools resolve the binding source through
  // `resolveBindingNames()` (a .filter() that always returns a fresh array), and ADR-0016
  // requires pi.dispatch in every shipped surface, so both tools pass `includeDispatch: true`.
  // This test pins that full chain so a reference-equality regression cannot ship green again.
  const names = resolveBindingNames([...BUILTIN_BINDING_NAMES]);
  const table = createBuiltinBindings({ cwd: process.cwd(), names, includeDispatch: true });
  expect(table.has(DISPATCH_BINDING_NAME)).toBe(true);
});

test("an explicit full name set without includeDispatch opts out of pi.dispatch", () => {
  // R3's read-only PTC surface pattern: an explicit `names` list is a caller-curated surface,
  // so the parallel binding stays out unless the caller asks for it explicitly.
  const table = createBuiltinBindings({ cwd: process.cwd(), names: [...BUILTIN_BINDING_NAMES] });
  expect([...table.keys()]).toEqual([...BUILTIN_BINDING_NAMES]);
  expect(table.has(DISPATCH_BINDING_NAME)).toBe(false);
});

test("includeDispatch: true mixes pi.dispatch into an explicit subset", () => {
  const table = createBuiltinBindings({
    cwd: process.cwd(),
    names: ["read"],
    includeDispatch: true,
  });
  expect([...table.keys()]).toEqual(["read", DISPATCH_BINDING_NAME]);
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

test(
  "the pi.dispatch binding validates arguments and refuses bad calls without throwing",
  async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "probe.md"),
        "---\nname: probe\n---\nYou probe.\n",
      );
      const bindings = createBuiltinBindings({
        cwd: dir,
        names: ["read"],
        includeDispatch: true,
      });
      const binding = bindings.get(DISPATCH_BINDING_NAME);
      if (binding === undefined) throw new Error("pi.dispatch binding is missing");

      // Missing agent (the field-report case): actionable refusal, same shape dispatch()
      // itself returns — and no throw, because the binding never throws (ADR-0016 §3).
      // agentScope "project" puts the temp agent dir in the listing.
      const missing = (await binding.execute({ task: "t", agentScope: "project" }, call)) as {
        status: string;
        started: boolean;
        errorMessage?: string;
      };
      expect(missing.status).toBe("rejected");
      expect(missing.started).toBe(false);
      expect(missing.errorMessage ?? "").toContain("agent is required (there is no default agent)");
      expect(missing.errorMessage ?? "").toContain("registered agents: [probe]");
      // Whitespace-only counts as missing.
      const blank = (await binding.execute({ agent: "  ", task: "t" }, call)) as {
        status: string;
        errorMessage?: string;
      };
      expect(blank.status).toBe("rejected");
      expect(blank.errorMessage ?? "").toContain("agent is required");

      // A typed-but-invalid field is refused with pi's own validator message.
      const badScope = (await binding.execute(
        { agent: "probe", task: "t", agentScope: "everywhere" },
        call,
      )) as { status: string; errorMessage?: string };
      expect(badScope.status).toBe("rejected");
      expect(badScope.errorMessage ?? "").toContain('Validation failed for tool "pi.dispatch"');
      expect(badScope.errorMessage ?? "").toContain("agentScope");

      // The happy path through validation still reaches dispatch(): unknown agent here, so
      // the refusal is the unknown-agent shape — and no child is ever spawned for it.
      const unknown = (await binding.execute(
        { agent: "ghost", task: "t", agentScope: "project" },
        call,
      )) as { status: string; errorMessage?: string };
      expect(unknown.status).toBe("rejected");
      expect(unknown.errorMessage ?? "").toContain("unknown agent: ghost");
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);
