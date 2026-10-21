/**
 * The two task doors (ADR-0052, ticket #236).
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
 */
import { expect, test } from "vitest";

import { createBuiltinBindings, DISPATCH_BINDING_NAME } from "../../src/runtime/bindings.ts";
import { createPtcSubagentTool, SUBAGENT_TOOL_NAME } from "../../src/tools/subagent.ts";
import { makeExtensionStub } from "../helpers/ptc.ts";

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
