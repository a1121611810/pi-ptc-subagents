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
  bindingFailureMessage,
} from "../src/runtime/bindings.ts";
import {
  DispatchSlotCounter,
  dispatch,
  isDispatchHandle,
  isUsableReadOnlyRequest,
  resolveReadOnlyTier,
  type DispatchInput,
  type DispatchResult,
  type ReadOnlyTier,
} from "../src/runtime/dispatch.ts";
import type { DispatchHandle } from "../src/runtime/task-registry.ts";
import { resolveBindingNames } from "../src/tools/common.ts";
import { makeTempDir, removeTempDir, RUN_TIMEOUT_MS } from "./helpers/ptc.ts";

/**
 * The outcome of a call that must be a RESULT.
 *
 * ADR-0055: a call that does not wait can resolve with a HANDLE, so the union is real. A
 * refusal is a result on both modes, so narrowing is what says "this one was refused".
 */
function asResult(value: DispatchHandle | DispatchResult): DispatchResult {
  if (isDispatchHandle(value)) {
    throw new Error("expected a DispatchResult, got a DispatchHandle");
  }
  return value;
}

const options = RUN_TIMEOUT_MS;
const call = { callId: 1, depth: 0, maxDispatchDepth: 3 };

test("bash is opt-in, not in defaults", () => {
  // Closure criterion for #73. The obvious "fix" for a program that wanted `tools.bash` is to
  // revert `DEFAULT_BINDING_NAMES` to the full known set — that is what turns this red. The known
  // set is asserted in the same test so that DELETING `bash` from BUILTIN_BINDING_NAMES cannot
  // pass here: that would satisfy "not in defaults" while breaking every opt-in that asks for it.
  expect(DEFAULT_BINDING_NAMES).not.toContain("bash");
  expect(BUILTIN_BINDING_NAMES).toContain("bash");
  for (const name of ["read", "edit", "write", "grep", "find", "ls"]) {
    expect(DEFAULT_BINDING_NAMES).toContain(name as never);
  }
  // Exactly the known set minus the opt-in names — not a hand-written list that could drift.
  expect([...DEFAULT_BINDING_NAMES]).toEqual(
    BUILTIN_BINDING_NAMES.filter((name) => name !== "bash"),
  );
});

test("createBuiltinBindings builds the default set, and optIns re-adds bash in BUILTIN order", () => {
  const defaults = createBuiltinBindings({ cwd: process.cwd() });
  expect(new Set(defaults.keys())).toEqual(
    new Set([...DEFAULT_BINDING_NAMES, DISPATCH_BINDING_NAME]),
  );
  expect(defaults.has("bash")).toBe(false);
  for (const binding of defaults.values()) expect(typeof binding.execute).toBe("function");

  // Order, not set membership: the model-facing list renders this sequence, so `bash` belongs back
  // where pi's native order puts it rather than appended at the end.
  const optedIn = createBuiltinBindings({ cwd: process.cwd(), optIns: ["bash"] });
  expect([...optedIn.keys()]).toEqual([...BUILTIN_BINDING_NAMES, DISPATCH_BINDING_NAME]);
  expect(typeof optedIn.get("bash")?.execute).toBe("function");

  const readOnly = createBuiltinBindings({ cwd: process.cwd(), names: ["read", "grep"] });
  expect([...readOnly.keys()]).toEqual(["read", "grep"]);

  const none = createBuiltinBindings({ cwd: process.cwd(), names: [] });
  expect(none.size).toBe(0);
});

test("an unknown opt-in name throws the dedicated opt-in TypeError", () => {
  // Its own message, distinct from the `names` rejection: a typo in `ptc.json` and a typo in a
  // programmatic `names` list are different mistakes with different fixes, and a caller that
  // matched on `/unknown PTC binding/` would swallow this one.
  let caught: unknown;
  try {
    createBuiltinBindings({ cwd: process.cwd(), optIns: ["teleport"] });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).message).toMatch(/unknown PTC opt-in binding "teleport"/);
  expect((caught as Error).message).not.toMatch(/^unknown PTC binding/);

  // A known builtin that is not an opt-in is refused too. Accepting `["read"]` would make
  // `optIns` silently no-op for every name a caller already had by default, and the mistake would
  // read as "the opt-in does not work" rather than "that name was never opt-in".
  let alsoCaught: unknown;
  try {
    createBuiltinBindings({ cwd: process.cwd(), optIns: ["read"] });
  } catch (e) {
    alsoCaught = e;
  }
  expect(alsoCaught).toBeInstanceOf(TypeError);
  expect((alsoCaught as Error).message).toMatch(/unknown PTC opt-in binding "read"/);
});

test("a caller-curated names list is honoured verbatim, opt-in gate included", () => {
  // The gate applies to the DEFAULT surface. A caller that passes `names` has already decided its
  // surface, so `bash` in an explicit list is taken at face value — that is the documented escape
  // hatch for a program that genuinely needs a shell, and it must not need a second key to work.
  const curated = createBuiltinBindings({
    cwd: process.cwd(),
    names: ["read", "bash"],
    includeDispatch: true,
  });
  expect([...curated.keys()]).toEqual(["read", "bash", DISPATCH_BINDING_NAME]);
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

test("createBuiltinBindings mirrors the production shape: resolved names plus includeDispatch expose pi_task_ptc", () => {
  // Production never passes `names: undefined`: both tools resolve the binding source through
  // `resolveBindingNames()` (a .filter() that always returns a fresh array), and ADR-0016
  // requires pi_task_ptc in every shipped surface, so both tools pass `includeDispatch: true`.
  // This test pins that full chain so a reference-equality regression cannot ship green again.
  const names = resolveBindingNames([...BUILTIN_BINDING_NAMES]);
  const table = createBuiltinBindings({ cwd: process.cwd(), names, includeDispatch: true });
  expect(table.has(DISPATCH_BINDING_NAME)).toBe(true);
});

test("an explicit full name set without includeDispatch opts out of pi_task_ptc", () => {
  // R3's read-only PTC surface pattern: an explicit `names` list is a caller-curated surface,
  // so the parallel binding stays out unless the caller asks for it explicitly.
  const table = createBuiltinBindings({ cwd: process.cwd(), names: [...BUILTIN_BINDING_NAMES] });
  expect([...table.keys()]).toEqual([...BUILTIN_BINDING_NAMES]);
  expect(table.has(DISPATCH_BINDING_NAME)).toBe(false);
});

test("includeDispatch: true mixes pi_task_ptc into an explicit subset", () => {
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

test("the read-only schema is a string enum and refuses everything else, including booleans", () => {
  /*
   * ADR-0041's boundary row, and the row the whole string-enum decision exists for. It lives
   * here rather than in the e2e smoke file because that file calls `dispatch()` directly and
   * therefore never reaches argument validation at all — the rejection is invisible from that
   * seam, which is a fact about the seam rather than a gap in the coverage.
   *
   * The refusal is the point, and it is strictly harder than the earlier boolean-inclusive
   * union: pi's `validateToolArguments` COERCES a `Type.Boolean()` member, so under that union
   * an invalid value silently became a tier, or became no tier at all. Measured against a union
   * of string literals every one of them is REFUSED. Counterfactual: put `Type.Boolean()` back
   * into the union in `src/runtime/bindings.ts` and the boolean rows below flip from `false`
   * to `true`.
   */
  const tool = {
    name: DISPATCH_BINDING_NAME,
    description: "probe",
    parameters: DISPATCH_PARAMETERS,
  };
  const accepts = (readOnly: unknown): boolean => {
    try {
      validateToolArguments(
        tool as never,
        {
          type: "toolCall",
          id: "probe",
          name: DISPATCH_BINDING_NAME,
          arguments: { task: "t", readOnly },
        } as never,
      );
      return true;
    } catch {
      return false;
    }
  };

  expect(accepts("strict")).toBe(true);
  expect(accepts("lenient")).toBe(true);
  expect(accepts(null), "the schema maps null to absent, which means no tier").toBe(true);
  expect(accepts(undefined), "and so does an omitted key").toBe(true);
  expect(accepts("STRICT"), "the tiers are case-sensitive on purpose").toBe(false);
  expect(accepts("readonly"), "the parameter name is not a tier value").toBe(false);
  expect(accepts({ mode: "strict" }), "an object spelling was considered and not shipped").toBe(
    false,
  );

  /*
   * The rows the boolean-inclusive union could never have written, and the reason the schema
   * is a string enum. Under `Type.Optional(Type.Union([Type.Boolean(), ...]))` pi's validator
   * COERCED every one of these — measured: `1` and `"true"` arrived as `true`, `0` and
   * `"false"` arrived as `false` — so an invalid value silently became a tier, or became no
   * tier at all. Under a union of string literals, `Type.Literal("strict")` refuses them, and
   * so the schema refuses them.
   *
   * Counterfactual: restore `Type.Boolean()` to the union in `src/runtime/bindings.ts` and
   * these four flip to `true`. The schema's own contract is the oracle — not a copy of
   * `resolveReadOnlyTier` — so a schema regression turns this row red.
   */
  expect(accepts(true), "a boolean is not a tier spelling").toBe(false);
  expect(accepts(1), "the number pi coerced to `true` under the old union").toBe(false);
  expect(
    accepts(0),
    "and `0`, which coerced to `false` — silently no tier, the dangerous one",
  ).toBe(false);
  expect(accepts("true"), "the string pi coerced to `true`").toBe(false);
  expect(accepts("1")).toBe(false);
});

test(
  "dispatch() refuses a readOnly value that is not a tier instead of coercing it",
  async () => {
    /*
     * Defence in depth for the seam the schema does not govern (ADR-0041: `dispatch()` is a
     * module-level function, and direct callers build their own arguments).
     *
     * It is a `dispatch()` test and not a binding test on purpose. Through the binding or the
     * top-level tool, pi's validator already refused every value in this loop before `dispatch()`
     * runs — the schema is a string enum now — so the guard never fires there. What remains is
     * a caller that imports `dispatch()` and passes a wrong-typed `readOnly` directly, and for
     * that caller the guard is the only boundary.
     *
     * COUNTERFACTUAL — the exact edit: delete the `isUsableReadOnlyRequest` guard at the top of
     * `dispatch()`. Then `agent: "ghost"` is resolved instead of refused and the message below
     * names the AGENT rather than the parameter. `ghost` is deliberate: it never resolves, so a
     * build without the guard fails this row instead of launching a real `pi`, and the row stays a
     * unit test on a file that stubs no process.
     */
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(dir, ".pi", "agents", "probe.md"),
        "---\nname: probe\n---\nYou probe.\n",
      );
      for (const bad of [1, 0, "true", "1", { mode: "strict" }, ["strict"]] as unknown[]) {
        // Typed `as never` because the point of the test is a value the declared type forbids.
        // Cast to `DispatchInput` rather than to `never`: the point of the row is a VALUE the
        // declared type forbids, not a call the overload set cannot resolve. Casting the argument
        // to `never` would also hide the return type, and `started` / `errorMessage` are the whole
        // claim here.
        const result = asResult(
          await dispatch(
            {
              wait: true,
              agent: "ghost",
              task: "t",
              agentScope: "project",
              readOnly: bad,
            } as unknown as DispatchInput,
            { callId: 1, cwd: dir, depth: 0, maxDispatchDepth: 3 },
            { slots: new DispatchSlotCounter(8) },
          ),
        );
        // `JSON.stringify` for the object row and `String` for the primitives: the label has to
        // be the value the caller sent, and Object's default stringification would print
        // "[object Object]" for both object rows -- the same string twice, so the second row
        // could pass on the first row's failure.
        const label = typeof bad === "object" && bad !== null ? JSON.stringify(bad) : String(bad);

        expect(result.status, `${label} is refused, not coerced`).toBe("rejected");
        // ADR-0016 §3: the binding never throws, and this is the same seam.
        expect(result.started, `${label} never launched a child`).toBe(false);
        expect(result.errorMessage ?? "", "the refusal names the parameter").toContain("readOnly");
        expect(result.errorMessage ?? "", "and the value the caller sent").toContain(label);
        // The ordering claim, and the reason this assertion is here: the guard runs ABOVE agent
        // resolution, so a caller fixing `readOnly` is told about `readOnly`.
        expect(
          result.errorMessage ?? "",
          "and not about the agent, which was never looked up",
        ).not.toContain("unknown agent");
        // And the accepted values are named, so the refusal is actionable without reading our source.
        expect(result.errorMessage ?? "").toContain("strict");
        expect(result.errorMessage ?? "").toContain("lenient");
      }
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test(
  "the pi_task_ptc binding validates arguments and refuses bad calls without throwing",
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
      if (binding === undefined) throw new Error("pi_task_ptc binding is missing");

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
      expect(badScope.errorMessage ?? "").toContain('Validation failed for tool "pi_task_ptc"');
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

test(
  "a refusal on the binding front states the tier the caller asked for",
  async () => {
    /*
     * The two refusals this binding produces BEFORE `dispatch()` runs — a malformed agent name and
     * a raw schema failure — are the only `DispatchResult`s in the package that never pass through
     * `dispatch()`'s refusal factories, and `withReadOnlyTier` lives on those factories. So they
     * were the two places where a requested tier was dropped from the result: measured on the same
     * input, `dispatch({agent:"", readOnly:"strict"})` returned `readOnlyTier: "strict"` while
     * `binding.execute({agent:"", task:"t", readOnly:"strict"})` returned no such key at all.
     *
     * ADR-0041 §Reporting says the field "is present whenever a tier was requested". This row is
     * the production path for that claim on this front — a PTC programme dispatching through the
     * parallel binding, which is not the same as the `dispatch()` seam.
     *
     * COUNTERFACTUAL, measured: delete `withReadOnlyTier` from the two refusal literals in
     * `src/runtime/bindings.ts` and this row goes red twice over — the binding returns no tier,
     * and the `dispatch()` comparison beside it still does, which is the divergence itself.
     */
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
      if (binding === undefined) throw new Error("pi_task_ptc binding is missing");
      const call = { callId: 0 } as never;

      for (const [label, args] of [
        ["a malformed agent name", { agent: "  ", task: "t", agentScope: "project" }],
        ["a raw schema failure", { agent: "probe", task: "t", agentScope: "everywhere" }],
      ] as const) {
        const viaBinding = (await binding.execute({ ...args, readOnly: "strict" }, call)) as {
          status: string;
          readOnlyTier?: string;
        };
        expect(viaBinding.status, `${label} is refused`).toBe("rejected");
        expect(
          viaBinding.readOnlyTier,
          `${label}: the binding front must state the tier the caller asked for, exactly as ` +
            `dispatch() does for the same input`,
        ).toBe("strict");

        const viaDispatch = (await dispatch(
          { wait: true, agent: args.agent as string, task: "t", readOnly: "strict" } as never,
          { callId: 0, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(8) },
        )) as { status: string; readOnlyTier?: string };
        expect(viaDispatch.readOnlyTier, `${label}: and the two fronts must agree`).toBe(
          viaBinding.readOnlyTier,
        );
      }

      // And the absence half, so the field cannot simply be stamped on everything.
      const untiered = (await binding.execute({ agent: "  ", task: "t" }, call)) as {
        readOnlyTier?: string;
      };
      expect("readOnlyTier" in untiered, "no tier asked for, so no tier is claimed").toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test(
  "a refusal on the binding front states a suppressed why, and stays silent without one",
  async () => {
    /*
     * The same CLASS of refusal as the tier row above, for ADR-0043's field, and for the same
     * reason: these are the only `DispatchResult`s in the package that never pass through
     * `dispatch()`'s refusal factories, so a fact stamped by `withWhySuppressed` inside
     * `dispatch()` simply does not reach a caller who arrived through the binding. Without this row
     * the contract "every result a caller can observe states a suppression" holds on one front and
     * not the other, and the divergence is invisible — a refused call returns a result, so nothing
     * looks wrong.
     *
     * The first row is deliberately NOT the tier row's first row. That one uses `agent: "  "`,
     * which satisfies the schema's `minLength: 1` and is therefore refused FURTHER DOWN, by
     * `dispatch()`'s malformed-name check rather than by this `catch`. A row aimed at this catch has
     * to name a value that fails validation outright, so it uses `agent: ""`. Two rows that claim to
     * exercise one refusal while taking different paths is how a guard ends up covering neither.
     *
     * COUNTERFACTUAL, measured: drop the `withWhySuppressed(..., suppressed)` wrapper from both
     * refusal literals in `src/runtime/bindings.ts` and this row goes red on the `whySuppressed`
     * assertion while the tier row above stays green — which is the point: the two fields went to
     * different places, and one of them was left behind.
     */
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
      if (binding === undefined) throw new Error("pi_task_ptc binding is missing");
      const call = { callId: 0, dispatchDeps: { whyEnabled: false } } as never;

      for (const [label, args] of [
        ["a malformed agent name", { agent: "", task: "t", agentScope: "project" }],
        ["a raw schema failure", { agent: "probe", task: "t", agentScope: "everywhere" }],
      ] as const) {
        const viaBinding = (await binding.execute(
          { ...args, why: "we are preparing a release" },
          call,
        )) as { status: string; whySuppressed?: true };
        expect(viaBinding.status, `${label} is refused`).toBe("rejected");
        expect(
          viaBinding.whySuppressed,
          `${label}: the binding front must state that the caller's why was dropped, exactly as ` +
            `dispatch() does for the same input`,
        ).toBe(true);

        // The comparison must not read machine state. `args.agent` for the second row is "probe",
        // and `dispatch()` defaults `agentScope` to `"user"` — so on a machine that happens to have
        // a user-scope `probe`, this would resolve it and spawn a real child (no lifecycle is
        // injected here). `ghost` cannot exist on any machine, so the comparison stays a unit test
        // and the two fronts are still compared on the one input both refuse.
        const viaDispatch = (await dispatch(
          { wait: true, agent: "ghost", task: "t", why: "we are preparing a release" } as never,
          { callId: 0, cwd: dir, depth: 0, maxDispatchDepth: 3 },
          { slots: new DispatchSlotCounter(8), whyEnabled: false },
        )) as { status: string; whySuppressed?: true };
        expect(viaDispatch.status, `${label}: the foreground front refuses it too`).toBe(
          "rejected",
        );
        expect(viaDispatch.whySuppressed, `${label}: and the two fronts must agree`).toBe(
          viaBinding.whySuppressed,
        );
      }

      // The absence half, in both directions. Without a `why` there is nothing withheld; and with
      // the switch on there is no withholding either. Stamping unconditionally would pass the rows
      // above and destroy the one distinction the field exists for.
      const withoutWhy = (await binding.execute({ agent: "", task: "t" }, call)) as {
        whySuppressed?: true;
      };
      expect("whySuppressed" in withoutWhy, "no why passed, so no suppression is claimed").toBe(
        false,
      );
      const switchOn = (await binding.execute({ agent: "", task: "t", why: "release prep" }, {
        callId: 0,
        dispatchDeps: { whyEnabled: true },
      } as never)) as { whySuppressed?: true };
      expect(
        "whySuppressed" in switchOn,
        "the switch is on, so the why was not withheld by it",
      ).toBe(false);

      // A non-string `why` reaches this catch UNVALIDATED, so the suppression decision has to be
      // total. `resolveWhy` trims its argument, and `true.trim` is not a function — a throw here
      // would replace the rejected `DispatchResult` this binding promises with an exception, which
      // ADR-0016 §3 forbids. The schema refuses the value, so the call is refused either way; what
      // must not happen is the refusal turning into a throw on its way out.
      for (const bad of [true, 42, { text: "x" }, [1]] as const) {
        const refusedBadWhy = (await binding.execute({ agent: "", task: "t", why: bad }, call)) as {
          status: string;
          whySuppressed?: true;
        };
        expect(refusedBadWhy.status, `why: ${JSON.stringify(bad)} is refused, not thrown`).toBe(
          "rejected",
        );
        expect(
          Object.hasOwn(refusedBadWhy, "whySuppressed"),
          "a value that is not a string is not a why, so nothing is claimed about it",
        ).toBe(false);
      }
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

// ---------------------------------------------------------------------------
// The THROW channel of the binding failure cap.
//
// A builtin can fail by REJECTING or by RESOLVING with isError, and both must reach the program
// as the same shape. The rejection path is reachable on EVERY supported pi, not only the pre-1.0.0
// ones: measured on 0.86.1, 1.0.0 and 1.2.0, `ls`/`read`/`grep`/`find` reject for a bad path while
// only `bash` moved its non-zero exit onto `isError` (0.99.0). The first test below drives a REAL
// builtin through the REAL table, which is the only one of these that can see the catch.
// ---------------------------------------------------------------------------

test("bindingFailureMessage caps a thrown failure past the cap: head dropped, tail and exit code kept", () => {
  // Same fixture shape as binding-contract.test.ts's >5000-char case: chosen markers, so the
  // assertion is not read back out of the implementation. The counterfactual is the catch itself -
  // without it, pi 0.86.1's raw 5051-char error (head intact) reaches the program.
  const HEAD_MARKER = "PTCHEAD0000";
  const TAIL_MARKER = "PTCTAIL9999";
  const thrown = new Error(
    HEAD_MARKER + "x".repeat(5000) + TAIL_MARKER + "\n\nCommand exited with code 3",
  );

  const message = bindingFailureMessage("bash", thrown.message);

  expect(message.length, "the retained body is the documented 2000 characters plus prefix").toBe(
    "bash failed: ".length + 1 + 2000, // 1 = the ellipsis character, matching bindingFailureMessage
  );
  expect(message, "the head is dropped, not the diagnostic").not.toContain(HEAD_MARKER);
  expect(message, "the tail survives - pi puts the exit code there").toContain("PTCTAIL9999");
  expect(message, "the exit-code sentence survives").toContain("Command exited with code 3");
  expect(message.startsWith("bash failed: …"), "the shared failure shape").toBe(true);
});

test("bindingFailureMessage passes a short thrown message through untruncated", () => {
  // The other half of the boundary pair: under the cap, nothing is dropped. Without this, a cap
  // of ~50 chars would satisfy the over-cap test above.
  const thrown = new Error("no such file or directory");
  expect(bindingFailureMessage("read", thrown.message)).toBe(
    "read failed: no such file or directory",
  );
});

test("a thrown Error with an empty message still yields a sentence, never empty", () => {
  // Reachable only through the throw channel (the isError path's empty branch is unreachable -
  // see bindingFailureMessage's doc): a builtin rejecting with an empty Error on pi < 1.0.0.
  // The contract needs a sentence a program can read, not an empty rejection.
  expect(bindingFailureMessage("bash", "")).toBe("bash reported a failure with no message");
  expect(bindingFailureMessage("bash", "   ")).toBe("bash reported a failure with no message");
});

test(
  "the real binding table caps a builtin that REJECTS: the catch feeds bindingFailureMessage",
  async () => {
    /*
     * The one test in this block that can see the catch, and the reason it is not just another
     * bindingFailureMessage unit test.
     *
     * Every other test here calls the pure function, so they pass whether or not the wrapper
     * has a catch at all: replacing the catch with a bare `await tool.execute(...)` leaves them
     * all green. This one drives a REAL pi builtin through the REAL table, so it is red under
     * exactly that edit.
     *
     * The path is `ls` on a name that does not exist, which rejects with "Path not found:
     * <resolved>" (core/tools/ls.js:44) - an fs.exists check with no `rg`/`fd` binary in the
     * path, so it does not depend on what happens to be installed on the machine. Measured on
     * 0.86.1, 1.0.0 and 1.2.0: ls, read, grep and find all REJECT for a bad path, and only bash
     * moved its non-zero exit onto isError (which arrived in 0.99.0). The old header here
     * claimed the catch was only "reachable on the 0.86.1 leg" - that was wrong, and the compat
     * matrix could not have caught it, because the matrix runs this same file on every version
     * and this same path fires on all of them.
     *
     * Markers sit at both ends of the NAME so the assertion reads the cap shape (head dropped,
     * tail kept) rather than a number read back out of the implementation. The length assertion
     * is `<=` on purpose: the resolved absolute path contains the run temp dir, so the exact
     * total is a property of the fixture rather than a constant to freeze here.
     */
    const HEAD_MARKER = "PTCHEAD0000";
    const TAIL_MARKER = "PTCTAIL9999";
    // Over the 2000-char cap once resolved against the temp cwd, so this is the over-cap leg.
    const missingName = HEAD_MARKER + "-" + "-".repeat(2100) + "-" + TAIL_MARKER;

    const dir = await makeTempDir();
    try {
      const bindings = createBuiltinBindings({ cwd: dir, names: ["ls"] });
      const binding = bindings.get("ls");
      if (binding === undefined) throw new Error("ls binding is missing");

      let caught: unknown;
      try {
        await binding.execute({ path: missingName }, call);
      } catch (error) {
        caught = error;
      }

      expect(
        caught,
        "a rejecting builtin surfaces as a rejection, not a silent resolve",
      ).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // The leading ellipsis IS the cap announcing itself: a message without it was never
      // truncated, and a message keeping the head marker was not capped either.
      expect(
        message.startsWith("ls failed: \u2026"),
        "the retained body is announced as truncated",
      ).toBe(true);
      expect(message, "the head is dropped, not the diagnostic").not.toContain(HEAD_MARKER);
      expect(message, "the tail survives").toContain(TAIL_MARKER);
      expect(
        message.length,
        "capped at the documented 2000 characters plus prefix",
      ).toBeLessThanOrEqual("ls failed: ".length + 1 + 2000);

      // The same channel under the cap: nothing is dropped. Without this, a cap of ~50 chars,
      // which would satisfy every assertion above, would pass.
      let shortCaught: unknown;
      try {
        await binding.execute({ path: "does-not-exist.txt" }, call);
      } catch (error) {
        shortCaught = error;
      }
      expect(shortCaught).toBeInstanceOf(Error);
      expect((shortCaught as Error).message).toMatch(/^ls failed: Path not found: /);
      expect((shortCaught as Error).message).toContain("does-not-exist.txt");
      expect((shortCaught as Error).message, "under the cap nothing is dropped").not.toContain(
        "\u2026",
      );
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test(
  "a REJECTING builtin and an isError builtin produce one shape through the real table",
  async () => {
    /*
     * The replacement for the tautology this file used to assert: it called
     * bindingFailureMessage twice with the same two arguments and checked that the answers
     * matched, which is true of every function and so pinned nothing. These are two SEPARATE
     * real calls - one builtin that REJECTS (ls, the catch channel) and one that resolves with
     * isError (bash non-zero exit, the only builtin on pi >= 0.99.0 to use it). If either
     * channel stopped routing through bindingFailureMessage, or grew a prefix or cap of its own,
     * the two messages would diverge here.
     */
    const dir = await makeTempDir();
    try {
      // `bash` is opt-in, so the surface is curated to name both: a curated list is honoured
      // verbatim and takes the opt-in name at face value (the escape hatch #73 documents).
      const bindings = createBuiltinBindings({ cwd: dir, names: ["ls", "bash"] });
      const messageFor = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const binding = bindings.get(name);
        if (binding === undefined) throw new Error(name + " binding is missing");
        try {
          await binding.execute(args, call);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        throw new Error(name + " resolved, but this test asked for a failure");
      };

      const fromReject = await messageFor("ls", { path: "does-not-exist.txt" });
      const fromIsError = await messageFor("bash", { command: "echo out; exit 3" });

      // One wrapper, one wording, one cap - measured on the two real channels rather than by
      // calling one function twice with one input.
      expect(fromReject).toMatch(/^ls failed: Path not found: /);
      expect(fromIsError).toMatch(/^bash failed: out/);
      for (const message of [fromReject, fromIsError]) {
        expect(message.length, "one cap applies to both channels").toBeLessThanOrEqual(
          "failed: ".length + 1 + 2000,
        );
        expect(message, "these fixtures are short, so neither is truncated").not.toContain(
          "\u2026",
        );
      }
      // Each channel reports the text of its own tool, so the sentences genuinely differ. The
      // old test asserted the opposite by construction; this is the thing it never checked.
      expect(fromReject).not.toBe(fromIsError);
    } finally {
      await removeTempDir(dir);
    }
  },
  options,
);

test("the schema and the resolver name the SAME two tiers", () => {
  /*
   * The tier vocabulary is spelled out in five places: the `ReadOnlyTier` type, the resolver, the
   * guard, the hand-written schema type and the runtime schema object. Nothing NAMES the
   * invariant that they agree — which is different from nothing catching a violation of it.
   *
   * **`tsc` does catch both directions, and this record says so because the first draft of this
   * comment claimed it did not.** A mutation audit reported that adding a literal to the runtime
   * union leaves `tsc` green; measured, it does not: `DISPATCH_PARAMETERS: DispatchParameters`
   * makes the object literal non-assignable and TS2322 fires at the annotation (verified). The
   * other direction is covered because the resolver compares against `ReadOnlyTier` and stops
   * covering when the union grows.
   *
   * So the net is real but IMPLICIT — it exists only because somebody wrote the annotation and
   * the exhaustive comparison, and neither line says "this is where the tiers are decided". This
   * row makes the invariant explicit, names both sides, and fails with the schema's literal list
   * in the diff, which is a better error message than a 400-character TS2322.
   *
   * COUNTERFACTUAL: add `Type.Literal("advisory")` to the runtime union in
   * `src/runtime/bindings.ts` and this is the row that reds.
   */
  const schemaLiterals = (
    DISPATCH_PARAMETERS.properties as {
      readOnly?: { anyOf?: { const?: unknown }[] };
    }
  ).readOnly?.anyOf?.map((entry) => entry.const);
  expect(
    schemaLiterals,
    "the runtime schema's readOnly union is readable as a list of literals",
  ).toEqual(["strict", "lenient"]);

  // And the other direction: every literal the schema names, the resolver actually resolves —
  // and to itself, not to something wider or narrower.
  for (const literal of schemaLiterals ?? []) {
    expect(
      resolveReadOnlyTier(literal as ReadOnlyTier),
      `"${String(literal)}" is advertised by the schema, so the resolver must implement it`,
    ).toBe(literal);
    expect(
      isUsableReadOnlyRequest(literal),
      `"${String(literal)}" is a tier, so the guard must accept it`,
    ).toBe(true);
  }

  // The no-tier spellings, stated here rather than left to the rows above: exactly two, and
  // nothing else. A third ("no" / "off" / "none") would be a value the code silently treats as
  // no-tier without the schema saying so.
  expect(isUsableReadOnlyRequest(undefined)).toBe(true);
  expect(isUsableReadOnlyRequest(null)).toBe(true);
  expect(isUsableReadOnlyRequest("")).toBe(false);
  expect(isUsableReadOnlyRequest("off")).toBe(false);
});
