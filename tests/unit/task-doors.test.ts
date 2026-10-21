/**
 * The two task doors (ADR-0052, ticket #236; their SHAPE settled by ADR-0054, ticket #238).
 *
 * There are two doors and one shared implementation: `pi_task_ptc` lives inside a PTC program as
 * a binding, `pi_task_codemode` is a registered tool a `codemode` script can call. The old names
 * were `pi.dispatch` and `ptc_subagent`, and both are retired with **no alias and no compatibility
 * shim** — a second name for the same thing is the drift this whole change exists to remove.
 *
 * The prefix is shared on purpose. `pi_task_ptc` and `pi_task_codemode` are both plain JavaScript
 * identifiers, so BOTH planes reach their door with a dot; the old `pi.dispatch` forced string
 * indexing on one plane and a different spelling on the other, which is the shape error a model
 * hit for real on 2026-10-20 (`TypeError: tools.pi.dispatch does not exist`) and burned three
 * calls on before it fell back.
 *
 * The expected values here are LITERALS, not the implementation's own constants: the literals are
 * what ADR-0052 and the ticket say, so a constant that drifted away from them turns this red
 * instead of quietly agreeing with itself.
 *
 * ## The shape half (ADR-0054)
 *
 * Two doors, one object. The PTC door resolves with the raw `DispatchResult` (or the raw
 * `DispatchHandle`); the codemode door hands the script that same raw value as its
 * `structuredContent` — no projection, no envelope, no renamed keys. And a refusal is a RESULT on
 * both doors: `status: "rejected"` plus an `errorMessage`, never a thrown exception.
 */
import { expect, test } from "vitest";

import { createBuiltinBindings, DISPATCH_BINDING_NAME } from "../../src/runtime/bindings.ts";
import { DispatchSlotCounter, isDispatchHandle } from "../../src/runtime/dispatch.ts";
import type { DispatchResult } from "../../src/runtime/dispatch.ts";
import type { DispatchHandle } from "../../src/runtime/task-registry.ts";
import type { ULID } from "../../src/runtime/task-storage.ts";
import { createPtcSubagentTool, SUBAGENT_TOOL_NAME } from "../../src/tools/subagent.ts";
import { readStructuredContent } from "../helpers/pi-compat-probe.ts";
import { makeExtensionStub, makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/** The prefix ADR-0052 gives both doors. */
const SHARED_PREFIX = "pi_task_";

/**
 * A plain JavaScript identifier — the property that decides whether a plane can call the door
 * with a dot. `pi.dispatch` fails it (the dot is not an identifier character), which is exactly
 * why the old name could not be reached the same way from both planes.
 */
const JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const FOUND_CODEMODE = { present: true, how: "found" } as const;
const CODEMODE_AXES = {
  codemode: FOUND_CODEMODE,
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;

test("the two doors carry the names ADR-0052 gives them", () => {
  expect(DISPATCH_BINDING_NAME, "the PTC door's name").toBe("pi_task_ptc");
  expect(SUBAGENT_TOOL_NAME, "the codemode door's name").toBe("pi_task_codemode");
});

test("the two doors share one prefix, and the suffix is the only difference", () => {
  // The prefix is what makes the two names read as one family rather than as two unrelated
  // tools, and it is the only thing that has to be shared for the dot-access rule to hold on
  // both planes.
  expect(DISPATCH_BINDING_NAME.startsWith(SHARED_PREFIX), "the PTC door's prefix").toBe(true);
  expect(SUBAGENT_TOOL_NAME.startsWith(SHARED_PREFIX), "the codemode door's prefix").toBe(true);
  // Different suffixes: two doors, not one door wearing two names.
  expect(DISPATCH_BINDING_NAME.slice(SHARED_PREFIX.length)).not.toBe(
    SUBAGENT_TOOL_NAME.slice(SHARED_PREFIX.length),
  );
  // And the suffixes are the plane each door lives on, so the name says where it can be called.
  expect(DISPATCH_BINDING_NAME, "the PTC door says the PTC plane").toContain("ptc");
  expect(SUBAGENT_TOOL_NAME, "the codemode door says the codemode plane").toContain("codemode");
});

test("both door names are plain JavaScript identifiers, so BOTH planes call them with a dot", () => {
  // The counterfactual is the rule itself: the old name fails this shape, so an implementation
  // that put a dot back into either door's name turns this red.
  expect(DISPATCH_BINDING_NAME, "the PTC door is dot-addressable").toMatch(JS_IDENTIFIER);
  expect(SUBAGENT_TOOL_NAME, "the codemode door is dot-addressable").toMatch(JS_IDENTIFIER);
  // The old shape, stated as the thing this assertion exists to exclude.
  expect("pi.dispatch", "the retired name was NOT dot-addressable").not.toMatch(JS_IDENTIFIER);
});

test("the old names are gone: no alias, no compatibility shim", () => {
  // The binding table is what a PTC program sees. The retired name must not be in it — not under
  // its old spelling, and not under the new one either (that would be the alias).
  const bindings = createBuiltinBindings({ cwd: process.cwd() });
  expect(bindings.has("pi.dispatch"), "the retired binding name is gone").toBe(false);
  expect(bindings.has(DISPATCH_BINDING_NAME), "the new binding name is there").toBe(true);

  // Same for the codemode door: the tool's own name is the new one, and the old one is not
  // registered beside it.
  const door = createPtcSubagentTool({ cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 });
  expect(door.name, "the codemode door's registered name").toBe("pi_task_codemode");
  expect(door.name, "and not the retired one").not.toBe("ptc_subagent");
});

test("the PTC door is a binding only — it is never registered as a pi tool", async () => {
  // The PTC door lives inside a PTC program. Registering it as a pi tool would put a second,
  // different route to the same thing in front of the model, and the two would not be the same
  // call — the thing this change exists to remove.
  for (const surface of [
    await makeExtensionStub({ codemode: { present: false, how: "not-found" } }),
    await makeExtensionStub({ ...CODEMODE_AXES }),
  ]) {
    expect([...surface.tools.keys()], "no surface registers the PTC door as a tool").not.toContain(
      "pi_task_ptc",
    );
  }
});

test("the codemode door is at `codemode` reach — a script calls it, the model does not", async () => {
  // On the `codemode_ptc` surface the orchestrator responsible to the model is pi's own
  // `codemode`. The door sits UNDERNEATH it, so it is reachable from a script and NOT declared to
  // the model: `exposure: "codemode"` is what says that, and pi reads the field when it decides
  // what the model is offered.
  const surface = await makeExtensionStub({ ...CODEMODE_AXES });
  const door = surface.tools.get("pi_task_codemode") as { exposure?: string } | undefined;
  expect(door, "the codemode door is registered on that surface").toBeDefined();
  expect(door?.exposure, "and it is at codemode reach").toBe("codemode");
  // The counterfactual: the door declared to the model (`direct`) would give the model a second,
  // parallel way to create a task that is not the call the script makes.
  expect(door?.exposure).not.toBe("direct");
});

/**
 * The two doors, called the same way (ADR-0054).
 *
 * The PTC door is a binding a program calls; the codemode door is a tool a script calls. They are
 * the same door in two planes, so the same call has to produce the same OBJECT — and a refusal has
 * to arrive as a result on both, never as a thrown exception.
 */

/** The call context the binding table expects; the same shape the binding tests use. */
const CALL = { callId: 1, depth: 0, maxDispatchDepth: 3 };

/**
 * A counter with no free slot, so both doors hit the CONCURRENCY gate.
 *
 * That gate is the one refusal whose whole value is byte-stable: it is minted before any clock
 * reading, so two calls produce the same object field for field. The unknown-agent refusal is
 * NOT (`durationMs` is a measured elapsed time), which is why the equality below is asserted
 * against this gate and not against a call that happened to be refused.
 */
function saturatedSlots(): DispatchSlotCounter {
  const slots = new DispatchSlotCounter(1);
  slots.tryAcquire("someone-else");
  return slots;
}

/** The raw result of the PTC door, and the codemode door's `structuredContent`, for one call. */
async function callBothDoors(args: Record<string, unknown>): Promise<{
  fromBinding: DispatchResult | DispatchHandle;
  fromTool: unknown;
}> {
  const dir = await makeTempDir();
  try {
    const deps = { slots: saturatedSlots() };
    const bindings = createBuiltinBindings({ cwd: dir, names: [], includeDispatch: true });
    const binding = bindings.get(DISPATCH_BINDING_NAME);
    if (binding === undefined) throw new Error("pi_task_ptc binding is missing");
    const fromBinding = (await binding.execute(args, { ...CALL, dispatchDeps: deps })) as
      | DispatchResult
      | DispatchHandle;

    const tool = createPtcSubagentTool({
      cwd: dir,
      depth: 0,
      maxDispatchDepth: 3,
      getDispatchDeps: () => deps,
    });
    const fromTool = await tool.execute(
      "call" as never,
      args as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return { fromBinding, fromTool };
  } finally {
    await removeTempDir(dir);
  }
}

test("a refused call is the SAME object on both doors — not two shapes of one refusal", async () => {
  // The claim, in one assertion: the codemode door's `structuredContent` and the PTC door's
  // resolved value are the same object. Not "the same fields", not "the same status" — the same
  // value, so a script and a program read the same thing.
  //
  // The counterfactual: keep the codemode door's projection (snake_case, renamed, pruned) and
  // this goes red on the very first differing key.
  const { fromBinding, fromTool } = await callBothDoors({ task: "anything" });
  expect(readStructuredContent(fromTool), "the script gets the PTC door's object verbatim").toEqual(
    fromBinding,
  );
});

test("the refusal carries the shape the ticket states, on both doors", async () => {
  // A LITERAL, not the implementation's own factory output: the ticket's shape is the expectation,
  // so a factory that grew a field or lost one turns this red instead of agreeing with itself.
  const { fromBinding, fromTool } = await callBothDoors({ task: "anything" });
  const expected = {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    reportChannel: "none",
    errorMessage: "dispatch concurrency limit reached",
  };
  expect(fromBinding, "the PTC door's refusal").toEqual(expected);
  expect(readStructuredContent(fromTool), "and the codemode door's is the same one").toEqual(
    expected,
  );
});

test("neither door throws: a refusal is a result, in both wait modes", async () => {
  // The failure that made this a ticket: the codemode door threw on a refusal, so a refused call
  // looked like a broken call and took a sibling's `Promise.allSettled` row with it.
  //
  // COUNTERFACTUAL: restore the throw (`throw new Error(...)` in the codemode door's refusal
  // branch) and this test fails on the rejected promise, not on a shape.
  for (const args of [{ task: "anything" }, { task: "anything", background: true }]) {
    const { fromTool } = await callBothDoors(args);
    expect(fromTool, "the codemode door resolves, it does not reject").toBeDefined();
    const structured = readStructuredContent(fromTool) as { status?: string };
    expect(structured.status, "and what it resolves with is the refusal").toBe("rejected");
  }
});

test("the two wait modes differ in the wording, not in the shape", async () => {
  // The background refusal teaches the model where to look for the in-flight tasks, so its
  // `errorMessage` differs from the foreground one. The SHAPE does not: the same eight fields, the
  // same values, on both doors and in both modes.
  //
  // The wording split is #239's to unify (one generator instead of two parallel sets); what this
  // pins is that unifying it later cannot change the shape.
  const foreground = await callBothDoors({ task: "anything" });
  const background = await callBothDoors({ task: "anything", background: true });
  const shapeOf = (value: unknown): Record<string, unknown> => {
    const { errorMessage: _wording, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  expect(shapeOf(background.fromBinding)).toEqual(shapeOf(foreground.fromBinding));
  expect(
    (background.fromBinding as { errorMessage?: string }).errorMessage,
    "the background refusal names where to look",
  ).toContain("ptc_task_list");
});

test("a handle and a result are told apart by their status, never by an id field", async () => {
  // The discriminant, and it is the one ADR-0053 had to invent: a result carries the id of the
  // record it created, a handle carries the id of the task it is polling, so "does this outcome
  // have a task id" cannot tell the two apart. `status` can: a handle is always `"running"`.
  //
  // The guard is `isDispatchHandle`, and it is asserted against a VALUE rather than a type, so a
  // discriminator that went back to probing for an id field turns this red.
  const handle: DispatchHandle = {
    taskId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID,
    label: "l",
    status: "running",
  };
  const result: DispatchResult = {
    text: "",
    status: "rejected",
    started: false,
    agentName: "unknown",
    durationMs: 0,
    exitCode: -1,
    reportChannel: "none",
    recordId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as ULID,
  };
  expect(isDispatchHandle(handle), "a handle is a handle").toBe(true);
  expect(isDispatchHandle(result), "a result is not — even with an id of its own").toBe(false);
});
