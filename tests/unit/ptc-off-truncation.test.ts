/**
 * ADR-0058: `/ptc off` is a TRUNCATION of this package's place in the chain, not a switch that
 * leaves a door in place to refuse.
 *
 * The ticket's acceptance criteria, one test each:
 *
 *   1. on `full_ptc` the whole orchestration layer is withdrawn, and the model is back to the
 *      built-in tools;
 *   2. on `codemode_ptc` this package's segment UNDER pi's `codemode` is withdrawn, and
 *      `codemode` keeps orchestrating;
 *   3. the task door is withdrawable on both surfaces;
 *   4. `/ptc off` still means "stop accepting new + pull the queued ones out + the running ones
 *      go on" (ADR-0057) — the gate that refuses a call in the flip window is checked here;
 *   5. a session that has task records keeps the lifecycle face (ADR-0053) — pinned by
 *      `tests/unit/extension-background.test.ts`, and VERIFIED here rather than reimplemented;
 *   6. the switch is idempotent: no duplicate registration, no leftover.
 *
 * SPECIFICATION tests (docs/testing-constraints.md #4/#6): every expected value is a literal
 * from the ticket, from ADR-0058, or from ADR-0051/0052's own vocabulary — never a value read
 * back out of the implementation. `hidden` is pi's own exposure literal for "registered but
 * unreachable" (ADR-0058 decision 2), and the tool names are the ones the two doors are named by
 * (ADR-0052: `pi_task_ptc` inside a program, `pi_task_codemode` as a registered tool).
 *
 * The seam is the extension itself, driven through the same entry points pi uses: the tool
 * definition the session hands pi is the observable, because THAT is the withdrawal — pi
 * recomputes the declared set and the codemode-callable set from the current exposure every time
 * it needs either.
 */
import { describe, expect, test } from "vitest";

import { dispatch } from "../../src/runtime/dispatch.ts";
import {
  createBackgroundTaskRuntime,
  type BackgroundTaskRuntime,
} from "../../src/runtime/background-runtime.ts";
import { MockChildProcessLifecycle } from "../../src/runtime/child-process-lifecycle.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";
import { PTC_TRUNCATED_NO_NEW_TASK } from "../../src/mode/dispatch-section.ts";
import { makeExtensionStub, stubContext, type ExtensionStub } from "../helpers/ptc.ts";

/**
 * The three probes that resolve `full_ptc`.
 *
 * Pinned because nothing short-circuits the detection any more: with the `surfaceMode` key gone,
 * an unpinned switch or activation axis runs the real probe over the developer's own
 * `~/.pi/agent/settings.json`, and this file's surface would depend on the machine running it.
 */
const FULL_SURFACE_AXES = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "inactive", source: "loadout" },
} as const;

/**
 * The three probes that resolve `codemode_ptc`.
 *
 * `activation: "active"` is what the loadout says, and the loadout is what the probe reads
 * (ADR-0035): `codemode` has to be IN the model's tool list for this surface to be the answer.
 */
const CODEMODE_SURFACE_AXES = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;

/**
 * pi's default session surface (`agent-session.js`: `["read", "bash", "edit", "write"]`), plus
 * pi's own `codemode` on the `codemode_ptc` surface.
 *
 * A literal rather than the helper's constant: the claim under test is about what the MODEL is
 * offered, and the value has to be readable off pi's own documented default.
 */
const DEFAULT_SESSION_LOADOUT = ["read", "bash", "edit", "write"] as const;

/** The exposure the session handed pi for `name`, or `undefined` when it never registered it. */
function exposureOf(stub: ExtensionStub, name: string): string | undefined {
  const tool = stub.tools.get(name) as { exposure?: string } | undefined;
  return tool?.exposure;
}

/** Run `/ptc off` through the command pi registers. */
async function runOff(stub: ExtensionStub): Promise<string> {
  const command = stub.commands.get("ptc");
  if (command === undefined) throw new Error("the ptc command was not registered");
  const ctx = stubContext(stub);
  await command.handler("off", ctx);
  return stub.notifications.at(-1)?.message ?? "";
}

/** Run `/ptc on` through the command pi registers. */
async function runOn(stub: ExtensionStub): Promise<void> {
  const command = stub.commands.get("ptc");
  if (command === undefined) throw new Error("the ptc command was not registered");
  await command.handler("on", stubContext(stub));
}

// ---------------------------------------------------------------------------
//  1. full_ptc: the whole orchestration layer goes
// ---------------------------------------------------------------------------

describe("ADR-0058: on full_ptc the truncation takes the whole orchestration layer", () => {
  test("the program tools are withdrawn, and the model is back to the built-in tools", async () => {
    const stub = await makeExtensionStub(FULL_SURFACE_AXES);

    // Before the switch: the pair is model-facing, because on this surface the orchestrator
    // responsible to the model IS this package's own PTC (ADR-0051).
    expect(exposureOf(stub, "ptc_run_code"), "the run-code surface is model-facing").toBe("direct");
    expect(exposureOf(stub, "ptc_workflow"), "the workflow surface is model-facing").toBe("direct");

    await runOff(stub);

    // ADR-0058 decision 2: the withdrawal is a same-name re-registration as `hidden`, and pi
    // filters the registry by the CURRENT exposure — so a hidden tool is in neither the set
    // declared to the model nor the set a `codemode` script may call.
    expect(exposureOf(stub, "ptc_run_code"), "the run-code surface is withdrawn").toBe("hidden");
    expect(exposureOf(stub, "ptc_workflow"), "the workflow surface is withdrawn").toBe("hidden");

    // And the narrowing went with it: the built-in tools are what the model calls now.
    expect(stub.active, "the built-in tools are directly callable again").toEqual([
      ...DEFAULT_SESSION_LOADOUT,
      "ptc_run_code",
      "ptc_workflow",
    ]);
  });

  test("the notice says the layer was withdrawn, and does not say the running tasks stopped", async () => {
    const stub = await makeExtensionStub(FULL_SURFACE_AXES);
    const said = await runOff(stub);

    // The terms are the NEW model's: a truncation, not "stopped new children".
    expect(said, "the notice names the withdrawal").toContain("orchestration layer is withdrawn");
    expect(said, "and names what is gone").toContain("ptc_run_code");
    expect(said, "and what is left").toContain("built-in tools are directly callable");
    // The one fact both surfaces share, from the one constant.
    expect(said, "and the shared sentence").toContain(PTC_TRUNCATED_NO_NEW_TASK);
    // It must NOT claim the running tasks were stopped: they were not (ADR-0057 decision 6).
    expect(said, "it does not claim the running tasks were stopped").not.toMatch(/stopped/i);
  });
});

// ---------------------------------------------------------------------------
//  2 + 3. codemode_ptc: this package's segment under pi's codemode goes
// ---------------------------------------------------------------------------

describe("ADR-0058: on codemode_ptc the truncation lands after pi's codemode", () => {
  test("the execution layer and the task door are withdrawn, and codemode goes on", async () => {
    const stub = await makeExtensionStub({
      ...CODEMODE_SURFACE_AXES,
      // The `codemode_ptc` shape: the program pair is at `codemode` reach, so the model is not
      // offered it, and `codemode` itself IS in the loadout.
      active: [...DEFAULT_SESSION_LOADOUT, "codemode"],
      declaredProgrammingTools: [],
    });

    // Before the switch: the pair is at `codemode` reach and the door is a registered tool.
    expect(exposureOf(stub, "ptc_run_code"), "the pair is at codemode reach").toBe("codemode");
    expect(exposureOf(stub, "pi_task_codemode"), "the door is registered").toBe("codemode");

    await runOff(stub);

    // This package's segment under pi's `codemode` is what goes.
    expect(exposureOf(stub, "ptc_run_code"), "the execution layer is withdrawn").toBe("hidden");
    expect(exposureOf(stub, "ptc_workflow"), "the execution layer is withdrawn").toBe("hidden");
    expect(exposureOf(stub, "pi_task_codemode"), "the task door is withdrawn").toBe("hidden");

    // pi's own orchestrator is NOT this package's to withdraw, and the truncation did not
    // touch it: it stays in the loadout, and no definition of ours shadows its name.
    expect(stub.active, "codemode keeps orchestrating").toContain("codemode");
    expect(stub.tools.has("codemode"), "and this package never registered it").toBe(false);
  });

  test("the task door is withdrawn on BOTH surfaces — by different means", async () => {
    // `full_ptc`: the PTC door is a binding INSIDE a program, so there is no registration to
    // withdraw; withdrawing the program makes the door unreachable.
    const full = await makeExtensionStub(FULL_SURFACE_AXES);
    expect(full.tools.has("pi_task_ptc"), "the PTC door is not a registered tool").toBe(false);
    await runOff(full);
    expect(exposureOf(full, "ptc_run_code"), "and the program holding it is withdrawn").toBe(
      "hidden",
    );

    // `codemode_ptc`: the door IS a registered tool, and hiding it takes it out of the
    // codemode-callable set as well as the declared one.
    const codemode = await makeExtensionStub({
      ...CODEMODE_SURFACE_AXES,
      active: [...DEFAULT_SESSION_LOADOUT, "codemode"],
      declaredProgrammingTools: [],
    });
    expect(codemode.tools.has("pi_task_codemode"), "the codemode door is registered").toBe(true);
    await runOff(codemode);
    expect(exposureOf(codemode, "pi_task_codemode"), "and it is withdrawn").toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
//  4. the determinate semantics: stop new + withdraw queued + running goes on
// ---------------------------------------------------------------------------

describe("ADR-0058: the determinate meaning of the switch", () => {
  test("a call made in the turn where the switch was flipped is REFUSED, not accepted", async () => {
    // ADR-0058 decision 3: the withdrawal lands on the NEXT model request, so the request the
    // model already sent still carries the old declaration. A call in that window must be
    // refused — and the thing that refuses it is the gate in `dispatch()`, which the switch
    // writes. The gate itself is the sibling ticket's file and is NOT edited here.
    const storage = new InMemoryTaskStorage();
    const runtime: BackgroundTaskRuntime = createBackgroundTaskRuntime({
      createStorage: () => storage,
      createLifecycle: () => new MockChildProcessLifecycle(),
      clock: () => 2_000,
    });
    const stub = await makeExtensionStub({ backgroundRuntime: runtime });
    const ctx = stubContext(stub);
    await stub.emit("session_start", ctx);

    const command = stub.commands.get("ptc");
    if (command === undefined) throw new Error("the ptc command was not registered");
    await command.handler("off", ctx);

    // The gate is closed for every front that reads it.
    expect(runtime.dispatchDeps.dispatchEnabled, "the gate is closed").toBe(false);

    // And a call that slips through anyway — because the model's request predates the
    // withdrawal — is refused, with nothing started.
    const result = await dispatch(
      // ADR-0055: a call that does not wait can resolve with a HANDLE, so the union is real.
      // This one waits, so the outcome is a result and the refusal's fields are readable.
      { agent: "anyone", task: "ping", wait: true },
      { callId: 1, cwd: process.cwd(), depth: 0, maxDispatchDepth: 3 },
      runtime.dispatchDeps,
    );
    expect(result.status, "the in-window call is refused").toBe("rejected");
    expect(result.started, "and nothing was started").toBe(false);
  });

  test("the switch keeps its other two halves: the queued ones are withdrawn, the running ones are not", async () => {
    // ADR-0057 decision 6, VERIFIED here rather than reimplemented: the ticket's "the queued
    // ones are pulled out and the running ones continue" is the half of the switch that is not a
    // truncation, and it has to survive the change. The records themselves are seeded by
    // `tests/unit/extension-background.test.ts`; what is asserted here is the NOTICE, because
    // the notice is the part ADR-0058 rewrote — and it must not claim the running ones stopped.
    const stub = await makeExtensionStub(FULL_SURFACE_AXES);
    const said = await runOff(stub);
    expect(said, "the notice does not claim the running ones were stopped").not.toMatch(/stopped/i);
    expect(said, "and it does not claim the queued ones were stopped either").not.toMatch(
      /queued task.*stopped/i,
    );
  });
});

// ---------------------------------------------------------------------------
//  6. idempotency
// ---------------------------------------------------------------------------

describe("ADR-0058: the switch is idempotent", () => {
  test("repeated toggles leave no duplicate registration and no leftover", async () => {
    const stub = await makeExtensionStub({
      ...CODEMODE_SURFACE_AXES,
      active: [...DEFAULT_SESSION_LOADOUT, "codemode"],
      declaredProgrammingTools: [],
    });
    const before = [...stub.tools.keys()];

    await runOff(stub);
    expect([...stub.tools.keys()], "the tool set does not grow").toEqual(before);
    expect(exposureOf(stub, "pi_task_codemode"), "the door is withdrawn").toBe("hidden");

    // Off again: the switch is already off, so this is a no-op — and a no-op that does not
    // register a second copy of anything.
    const command = stub.commands.get("ptc");
    if (command === undefined) throw new Error("the ptc command was not registered");
    await command.handler("off", stubContext(stub));
    expect([...stub.tools.keys()], "still the same set").toEqual(before);
    expect(exposureOf(stub, "pi_task_codemode"), "and still withdrawn").toBe("hidden");

    // On: the ORIGINAL definitions come back, with the exposure this surface gives them.
    await runOn(stub);
    expect([...stub.tools.keys()], "still the same set").toEqual(before);
    expect(exposureOf(stub, "pi_task_codemode"), "the door is back at codemode reach").toBe(
      "codemode",
    );
    expect(exposureOf(stub, "ptc_run_code"), "the pair is back at codemode reach").toBe("codemode");
    expect(exposureOf(stub, "ptc_workflow"), "the pair is back at codemode reach").toBe("codemode");

    // And off again: the same withdrawal, not a second layer of it.
    await runOff(stub);
    expect([...stub.tools.keys()], "still the same set").toEqual(before);
    expect(exposureOf(stub, "pi_task_codemode"), "withdrawn again").toBe("hidden");
    expect(exposureOf(stub, "ptc_run_code"), "withdrawn again").toBe("hidden");
  });
});
