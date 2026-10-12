import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  BUILTIN_BINDING_NAMES,
  createBuiltinBindings,
  DEFAULT_BINDING_NAMES,
  DISPATCH_BINDING_NAME,
  DISPATCH_PARAMETERS,
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

test("the schema itself accepts an omitted agent, and refuses an unusable one", () => {
  /*
   * The OPTIONALITY, asserted through pi's own validator rather than through prose about it.
   *
   * Nothing held this before. Measured 2026-10-12: reverting the field to the pre-#185
   * `Type.String({ minLength: 1 })` — keeping the description and both runtime guards — left
   * `tsc` green and the whole suite green. The three tests that read `DISPATCH_PARAMETERS` look at
   * key sets (`tests/unit/ptc-subagent.test.ts`) or at description text
   * (`tests/unit/agent-roster.test.ts`), so a one-line revert that would turn every omitted
   * dispatch into a validation failure had nothing standing in its way.
   *
   * `validateToolArguments` is the same helper `bindings.ts` uses, imported from the same module,
   * so this measures the real contract rather than a paraphrase of it.
   *
   * Counterfactual: the revert above fails the first assertion. The other three fail if the
   * requirement moves onto `agent`, or if the `minLength: 1` goes away.
   */
  const tool = {
    name: DISPATCH_BINDING_NAME,
    description: "probe",
    parameters: DISPATCH_PARAMETERS,
  };
  const accepts = (args: unknown): boolean => {
    try {
      validateToolArguments(
        tool as never,
        {
          type: "toolCall",
          id: "probe",
          name: DISPATCH_BINDING_NAME,
          arguments: args,
        } as never,
      );
      return true;
    } catch {
      return false;
    }
  };

  expect(accepts({ task: "t" }), "an omitted agent is a valid call").toBe(true);
  expect(accepts({}), "task is still required").toBe(false);
  expect(accepts({ task: "t", agent: "" }), "an empty name is not").toBe(false);
  expect(accepts({ task: "t", agent: "x" }), "a name is").toBe(true);
});

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

      /*
       * An unusable agent: actionable refusal, same shape dispatch() itself returns — and no
       * throw, because the binding never throws (ADR-0016 section 3). `agentScope: "project"`
       * puts the temp agent dir in the listing.
       *
       * Note WHICH case this is, because it changed. An absent agent is no longer a refusal at
       * all (issue #185) — it dispatches the generalist child — so asserting that here would
       * spawn a real `pi`, since this file does not stub child_process. The omission is covered
       * where the spawn IS stubbed (`dispatch-helpers`, `dispatch-background`) and against a real
       * process in the e2e smoke.
       */
      const blank = (await binding.execute(
        { agent: "  ", task: "t", agentScope: "project" },
        call,
      )) as {
        status: string;
        started: boolean;
        errorMessage?: string;
      };
      expect(blank.status).toBe("rejected");
      expect(blank.started).toBe(false);
      expect(blank.errorMessage ?? "").toContain("agent, when given, must be a non-empty string");
      expect(blank.errorMessage ?? "").toContain("registered agents: [probe]");

      // An empty string takes the same branch: given, and unusable.
      const empty = (await binding.execute({ agent: "", task: "t" }, call)) as {
        status: string;
        errorMessage?: string;
      };
      expect(empty.status).toBe("rejected");
      expect(empty.errorMessage ?? "").toContain("agent, when given");

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
