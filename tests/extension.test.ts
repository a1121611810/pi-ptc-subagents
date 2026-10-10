import { expect, test } from "vitest";
import type { ExtensionStub } from "./helpers/ptc.ts";
import ptcSubagents, {
  createBuiltinBindings,
  createWorkerEnv,
  DEFAULT_CONFIG,
  HOST_FRAME_KIND,
  PTC_ERROR_KIND,
  runPtcProgram,
  WORKER_FRAME_KIND,
} from "../src/index.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureRegisteredTools,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  writeAgentSettings,
} from "./helpers/ptc.ts";

/**
 * The factory's contract with pi is "register the PTC tools and the mode hooks against the
 * ExtensionAPI it is handed" — which the parameter type checks against pi's real declaration at
 * compile time. `makeExtensionStub` supplies the same surface pi does, and fires the
 * `session_start` the registration now hangs off.
 */

test("the default export is the extension factory and runs without touching pi", async () => {
  expect(typeof ptcSubagents).toBe("function");
  expect(ptcSubagents.length).toBe(1);
  expect(ptcSubagents((await makeExtensionStub()).api)).toBe(undefined);
});

test("session_start registers the two PTC tools, the three background-task tools and the report tool", async () => {
  const tools = await captureRegisteredTools();
  // BG-14: the three ptc_task_* tools are always-on, registered at session_start outside /ptc mode.
  // ADR-0032 / #101 adds `ptc_child_report` to the always-on group: it is registered in every
  // surface that reaches this line, and activated only in a dispatched child.
  expect([...tools.keys()]).toEqual([
    "ptc_run_code",
    "ptc_workflow",
    "ptc_task_list",
    "ptc_task_output",
    "ptc_task_stop",
    "ptc_child_report",
  ]);
  for (const tool of tools.values()) {
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.parameters).toBe("object");
  }
});

test("the factory module re-exports the machinery T4/T5 build on", () => {
  expect(typeof runPtcProgram).toBe("function");
  expect(typeof createBuiltinBindings).toBe("function");
  expect(typeof createWorkerEnv).toBe("function");
  expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
  expect(HOST_FRAME_KIND.init).toBe("init");
  expect(WORKER_FRAME_KIND.result).toBe("result");
  expect(PTC_ERROR_KIND.workerExit).toBe("worker-exit");
});

// --------------------------------------------------------------------------------------
// Surface mode (ADR-0025)
// --------------------------------------------------------------------------------------

const PTC_TOOLS = ["ptc_run_code", "ptc_workflow"] as const;
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;
// ADR-0032 / #101: registered in every surface that gets as far as the lifecycle face, because a
// dispatched CHILD is the only thing that ever calls it. It is registered inactive in a parent
// (`defaultActive: false`), so it belongs to neither the orchestration group nor the task group --
// it is here as its own constant so a reader can see that distinction rather than infer it.
const REPORT_TOOL = "ptc_child_report" as const;

/** What `full` registers, in registration order. */
const FULL_SURFACE_TOOLS = [...PTC_TOOLS, ...TASK_TOOLS, REPORT_TOOL] as const;

/**
 * What the `subagents` line registers, in registration order.
 *
 * The program pair is here at `codemode` reach — registered, callable from a pi `codemode` script,
 * and NOT declared to the model — so this list is the same length as `full`'s minus `ptc_subagent`,
 * and what tells the two lines apart is exposure rather than presence. Asserted literally, in order,
 * because a tool dropped from one group has to turn these red.
 */
const SUBAGENT_SURFACE_TOOLS = [...PTC_TOOLS, "ptc_subagent", ...TASK_TOOLS, REPORT_TOOL] as const;

/**
 * The pi this file reasons about when it wants `full` and the pi it reasons about when it wants
 * `subagents`. The surface is DETECTED (ADR-0026/0027/0029), so a test states three axes rather
 * than a surface: a tool this package cannot see, a tool pi will not load, and a tool the model
 * cannot call each resolve `full` on their own, and `subagents` needs all three to say yes.
 *
 * Left out of a stub, the activation axis would resolve against the DEVELOPER'S OWN
 * `~/.pi/agent/settings.json` and the switch against the repo — which is why every surface-bearing
 * stub in this file names them.
 */
const NO_CODEMODE = { present: false, how: "not-found" } as const;
const FOUND_CODEMODE = { present: true, how: "found" } as const;
/**
 * The three axes that resolve `subagents`, for a stub that does NOT redirect the agent dir.
 *
 * The switch has to be pinned here rather than left to be read: `detectSurfaceMode` falls back to
 * `readCodemodeSwitch(getAgentDir(), …)` when the seam is absent, so an unredirected stub would
 * resolve against the developer's own `~/.pi/agent/settings.json` and answer differently on
 * different machines. `SUBAGENTS_AXES_FROM_DISK` below is the variant that deliberately does leave
 * it to the file.
 */
const SUBAGENTS_AXES = {
  codemode: FOUND_CODEMODE,
  codemodeSwitch: { switch: "enabled", source: "user" },
  // "loadout" is the only provenance a real session_start can produce: the surface is read from
  // `pi.getActiveTools()`, so there is no user file, project file or argv left to name.
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;
/** The same two axes with the switch left to `readCodemodeSwitch`, for the agent-dir tests. */
const SUBAGENTS_AXES_FROM_DISK = {
  codemode: FOUND_CODEMODE,
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;

/**
 * Build a stub and fire one `session_start` with `~/.pi/agent` pointed at a temp dir, so the
 * notices that read `ptc.json` are reachable.
 *
 * `makeStubInAgentDir` restores `PI_CODING_AGENT_DIR` before it returns, which is right for a test
 * that only cares about registration and wrong for this one: the legacy-key notice is raised from
 * `session_start`, so the redirect has to still hold when the event fires.
 *
 * `ptc` is the file body, or `null` for no file at all.
 */
async function emitSessionStartInAgentDir(
  ptc: unknown,
  options: Parameters<typeof makeExtensionStub>[0],
): Promise<ExtensionStub> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (ptc !== null) {
      await writeFile(join(dir, "ptc.json"), JSON.stringify(ptc), "utf8");
    }
    const stub = await makeExtensionStub(options);
    return stub;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
}

test("full mode registers the orchestration tools and the lifecycle face", async () => {
  // The literal set, not a length: a tool dropped from one group has to turn this red.
  const tools = (await makeExtensionStub({ codemode: NO_CODEMODE })).tools;
  expect([...tools.keys()]).toEqual([...FULL_SURFACE_TOOLS]);
});

test("subagents mode keeps the subagent face and the lifecycle face, and offers the program underneath codemode", async () => {
  const stub = await makeExtensionStub({ ...SUBAGENTS_AXES });
  const tools = stub.tools;
  // The literal set, not a length: a tool dropped from one group has to turn this red.
  expect([...tools.keys()], "pi codemode orchestrates here; PTC is its execution layer").toEqual([
    ...SUBAGENT_SURFACE_TOOLS,
  ]);
  // **Reach is what keeps this from being the duplicate surface ADR-0025 removed.** The pair is
  // registered, but at `codemode` reach, which does not declare a tool to the model — so the
  // model is still told about exactly one way to compose tool calls, and that one is pi's.
  for (const name of PTC_TOOLS) {
    const definition = tools.get(name) as { exposure?: string } | undefined;
    expect(definition?.exposure ?? "direct", `${name} reach on subagents`).toBe("codemode");
  }
  // `ptc_subagent` is the exception and stays `direct`: it exists to be callable with no
  // orchestrator at all, which is the reason this line exists.
  const subagent = tools.get("ptc_subagent") as { exposure?: string } | undefined;
  expect(subagent?.exposure ?? "direct", "subagent reach on subagents").toBe("direct");
});

test("a `surfaceMode` key left in ptc.json is reported as ignored, and the surface stays detected", async () => {
  // The `off` test this replaces asserted a state the package no longer has. What replaced it is
  // not "off is gone" — it is that a user who set `"off"` on an earlier release and upgrades
  // finds the package back in their session, so `session_start` says so rather than letting them
  // discover it. This is the ONLY thing the package does with the key: it never honours it.
  //
  // The literal values, because "every value the record used to take" is the whole set of inputs
  // this notice has to cover — a table driven off `SURFACE_MODES` would stop at two of the three
  // and silently drop the one a real user most likely wrote.
  for (const value of ["off", "subagents", "full"] as const) {
    const stub = await emitSessionStartInAgentDir(
      { surfaceMode: value },
      { codemode: NO_CODEMODE },
    );
    const notices = stub.notifications.filter((n) =>
      n.message.includes('still has a "surfaceMode"'),
    );
    expect(notices.length, `one notice for ${JSON.stringify(value)}, not a stream`).toBe(1);
    expect(notices[0]?.type, "the key is being ignored, so it is a warning").toBe("warning");
    // The value is echoed, so the user can recognise WHICH key they are being told about without
    // opening the file: an implementation that passed `undefined` here would still match the
    // line above and say nothing useful.
    expect(notices[0]?.message, "and it names the value that is being ignored").toContain(
      JSON.stringify(value),
    );
    // `pi config` is the replacement, not `ptc.json`: pi does not LOAD the extension to honour it,
    // which no value of a key this package reads could achieve.
    expect(notices[0]?.message, "and it names the switch that does replace it").toContain(
      "pi config",
    );
    // **And the key does not decide the surface.** `"off"` registered nothing before; it must not
    // become a silent no-op that registers the whole `full` face as if the user had asked for it.
    expect([...stub.tools.keys()], "an ignored key leaves detection in force").toEqual([
      ...FULL_SURFACE_TOOLS,
    ]);
  }
});

test("no legacy notice when ptc.json carries no `surfaceMode` key", async () => {
  // The other half, and the one that would catch a notice on every ordinary session: `defaultMode`
  // still lives in this file, so most sessions have one and most sessions must hear nothing.
  for (const ptc of [null, { defaultMode: false }, { defaultMode: true }]) {
    const stub = await emitSessionStartInAgentDir(ptc, { codemode: NO_CODEMODE });
    expect(
      stub.notifications.filter((n) => n.message.includes('"surfaceMode"')),
      `no legacy notice for ${JSON.stringify(ptc)}`,
    ).toEqual([]);
  }
});

test("the surface is resolved before anything is registered", async () => {
  // The claim the old "read once, before anything is registered" test made, restated for a
  // package with no setting to read: pi has no `unregisterTool`, so `session_start` has to know
  // the surface before its first `registerTool`. Both axes are stated here as the two possible
  // answers rather than as one expected set, because the invariant is that the registry reflects
  // a DECIDED surface — a session that registered `full` and could not correct itself would be
  // indistinguishable from a correct one at registration time, and only the pair of sets shows
  // that the decision actually happened.
  const subagents = (await makeExtensionStub({ ...SUBAGENTS_AXES })).tools;
  const full = (await makeExtensionStub({ codemode: NO_CODEMODE })).tools;
  expect([...subagents.keys()]).toEqual([...SUBAGENT_SURFACE_TOOLS]);
  expect([...full.keys()]).toEqual([...FULL_SURFACE_TOOLS]);
  // `subagents` adds exactly one name. If a future axis change moved a tool between the groups
  // this turns red, which is the point of the subtraction rather than a second literal list.
  const onlyOnSubagents = [...subagents.keys()].filter((name) => !full.has(name));
  expect(onlyOnSubagents).toEqual(["ptc_subagent"]);
});

test("each surface registers a distinct set, and `subagents` differs from `full` by REACH not by presence", async () => {
  const sets = [
    [...(await makeExtensionStub({ ...SUBAGENTS_AXES })).tools.keys()].join(","),
    [...(await makeExtensionStub({ codemode: NO_CODEMODE })).tools.keys()].join(","),
  ];
  expect(new Set(sets).size, "two name sets: " + sets.join(" | ")).toBe(2);

  // The rest of the old claim — "no mode keeps both orchestrators" — was about the model being
  // offered two ways to compose tool calls. That is now a claim about REACH, and it is stated
  // that way: the same two tools exist on both lines, and only their reach differs. A mutation
  // that put `direct` on `subagents` would leave every count above correct and would hand the
  // model a second orchestrator, which is why this asserts the exposure rather than the set.
  const reachOf = (tools: Map<string, unknown>, name: string): string => {
    const tool = tools.get(name) as { exposure?: string } | undefined;
    return tool?.exposure ?? "direct";
  };
  const full = (await makeExtensionStub({ codemode: NO_CODEMODE })).tools;
  const subagents = (await makeExtensionStub({ ...SUBAGENTS_AXES })).tools;
  expect(reachOf(full, "ptc_run_code"), "full: this package orchestrates").toBe("direct");
  expect(reachOf(subagents, "ptc_run_code"), "subagents: pi's codemode orchestrates").toBe(
    "codemode",
  );
  expect(reachOf(full, "ptc_workflow")).toBe("direct");
  expect(reachOf(subagents, "ptc_workflow")).toBe("codemode");
});

test("subagents mode without codemode warns once, and says what to do about it", async () => {
  // Constraint 3: the failure path is visible. A mode that quietly leaves the model with a
  // subagent tool and no orchestrator is the bug this warning exists to prevent.
  //
  // **The shape is named because it is the whole subject.** On `subagents` the pair is
  // `codemode`-reach and pi declares neither, so a session that named `codemode` but got no
  // orchestrator is exactly the state this notice exists for. The stub used to append the pair to
  // every session's active list — the `full` shape — which made this test describe a cell it was
  // not in.
  const stub = await makeExtensionStub({
    ...SUBAGENTS_AXES,
    active: ["read", "bash", "edit", "write", "ptc_subagent"],
    declaredProgrammingTools: [],
  });
  // Scoped to THIS notice. A second, unrelated warning fires here and SHOULD: this stub also
  // models a pi that does not register codemode at all, which is the `--no-extensions` branch, and
  // counting every warning would make this test depend on that sibling rather than on its subject.
  const notices = stub.notifications.filter((n) => n.message.includes("no orchestration tool"));
  expect(notices.length, "one notice about the missing orchestrator, not a stream of them").toBe(1);
  expect(notices[0]?.type, "and it is a warning").toBe("warning");
  // The two remedies a user can actually take. The second one changed with the surfaceMode
  // removal — there is no setting left to point them at, so it has to be pi's own switch — and
  // this asserts the pair so a future reword cannot quietly drop either half.
  expect(notices[0]?.message, "names the tool to activate").toContain("codemode");
  expect(notices[0]?.message, "and the pi-side switch that replaces the old setting").toContain(
    "pi config",
  );
});

test("the warning does not fire when codemode is active", async () => {
  const stub = await makeExtensionStub({
    ...SUBAGENTS_AXES,
    active: ["read", "bash", "edit", "write", "codemode", "ptc_subagent"],
  });
  expect(
    stub.notifications.filter((n) => n.type === "warning"),
    "no false alarm",
  ).toEqual([]);
});

test("the warning is withheld when the program tools ARE declared — the 0.86 cell", async () => {
  // A pi older than 0.99.0 has no `ToolExposure`, so the pair it registered is declared to the
  // model rather than held at `codemode` reach. This session therefore HAS an orchestration tool,
  // and the notice's two remedies are both wrong there: "add codemode" names a tool that pi does
  // not ship, and "use ptc_run_code instead" names the tool already in front of it. Simulated by
  // listing the pair as active, which is what pi does with a tool it has no exposure concept for.
  const stub = await makeExtensionStub({
    ...SUBAGENTS_AXES,
    active: ["read", "bash", "edit", "write", "ptc_subagent"],
    declaredProgrammingTools: ["ptc_run_code", "ptc_workflow"],
  });
  expect(
    stub.notifications.filter((n) => n.message.includes("no orchestration tool")),
    "a session that HAS an orchestration tool is not told it has none",
  ).toEqual([]);
});

test("full mode never warns that it has no orchestrator, present or not", async () => {
  // `full` brings its own orchestrator, so a missing codemode is not this package's problem.
  //
  // Scoped to THIS claim rather than to "any codemode warning", because one of the two loadouts
  // below legitimately raises a different one: the second reports a live `codemode` the probe
  // missed, and that contradiction is real and worth reporting whatever surface is in force. A
  // broad filter would have to delete a correct warning to pass, or would pass vacuously.
  for (const active of [
    ["read", "bash", "edit", "write"],
    ["read", "bash", "edit", "write", "codemode"],
  ]) {
    const stub = await makeExtensionStub({ codemode: NO_CODEMODE, active });
    expect(
      stub.notifications.filter((n) => n.message.includes("no orchestration tool")),
      "full mode orchestrates itself",
    ).toEqual([]);
    // …and the surface really is `full` for both, so the silence is not "this session never
    // reached the branch" wearing a pass.
    expect([...stub.tools.keys()], "and it is the full surface").toEqual([...FULL_SURFACE_TOOLS]);
  }
  // An `info` notice is expected and correct here: a pi with no codemode on disk is a perfectly
  // healthy `full` session, and the notice says so in those words. The old version of this test
  // could not have drawn that line — a pinned surface left `detected` undefined, so the notice
  // never fired and the test asserted silence over a session nobody had asked the question of.
  const absent = await makeExtensionStub({ codemode: NO_CODEMODE });
  const probeNotes = absent.notifications.filter((n) => n.message.includes("codemode probe"));
  expect(probeNotes.length, "one probe note, and it is not a warning").toBe(1);
  expect(probeNotes[0]?.type).toBe("info");
  expect(probeNotes[0]?.message).toContain("not-found");
  expect(probeNotes[0]?.message, "and it names the direction, not a setting").toContain(
    "safe direction",
  );
  expect(probeNotes[0]?.message, "and it points at no key, because there is none").not.toContain(
    "surfaceMode",
  );
});

/**
 * Build a stub whose factory call really reads the agent dir, for a given `ptc.json` body.
 *
 * Which probes are REAL here and which are PINNED is the thing a reader of this helper has to
 * know, because it is what each test below is and is not testing:
 *
 *  - **`settings.json` — real.** `codemodeSwitch` is only forwarded when the caller names it, so
 *    an `extensions` entry in this file is resolved by the production `readCodemodeSwitch`.
 *  - **`codemodeActivation` — pinned.** `makeExtensionStub` always supplies it (an unspecified
 *    activation is `inactive`), so a `defaultTools` entry written here resolves to nothing. It
 *    would anyway: the session reads activation from `pi.getActiveTools()`, not from this file, so
 *    the tests below state activation as an axis rather than as a settings body.
 *  - **presence — stated.** Without it the real filesystem probe runs against vitest's argv,
 *    which is not a pi.
 *
 * The redirect exists because `getAgentDir()` re-reads the env var on every call and this repo
 * has a real `~/.pi/agent` with real `settings.json` in it.
 */
async function stubFromAgentDir(
  contents: unknown,
  options: Parameters<typeof makeExtensionStub>[0] = {},
  settings?: unknown,
): Promise<{ stub: ExtensionStub; dir: string }> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (contents !== null) {
      await writeFile(join(dir, "ptc.json"), JSON.stringify(contents), "utf8");
    }
    if (settings !== undefined) {
      await writeAgentSettings(dir, settings);
    }
    return { stub: await makeExtensionStub(options), dir };
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("no ptc.json content decides the surface any more — the three axes do, whatever the file says", async () => {
  // The inverse of the test this replaces, and its direct counterfactual. That one existed because
  // the factory DID read a key, so mutating the reader to a hardcoded answer left the suite green.
  // Nothing in the file is consulted now, so the claim that needs a test is the refusal: for every
  // value the key used to take, the registered set is the one detection chose.
  //
  // Both directions are stated because either alone would pass for the wrong reason. A factory
  // hardcoded to `full` satisfies the first row and fails the second; one hardcoded to
  // `subagents` does the reverse.
  //
  // `defaultMode: false` rides along in one body on purpose: that key is still read from the same
  // file, so this also pins that a live key and a stale one coexist rather than one shadowing the
  // other.
  const legacy = [
    { surfaceMode: "off" },
    { surfaceMode: "subagents" },
    { surfaceMode: "full" },
    { defaultMode: false, surfaceMode: "subagents" },
  ] as const;
  for (const [label, options, expected] of [
    ["codemode on disk, nothing else configured", { codemode: FOUND_CODEMODE }, FULL_SURFACE_TOOLS],
    ["codemode on disk and callable", { ...SUBAGENTS_AXES }, SUBAGENT_SURFACE_TOOLS],
    [
      "codemode callable but not on disk",
      { ...SUBAGENTS_AXES, codemode: NO_CODEMODE },
      FULL_SURFACE_TOOLS,
    ],
    [
      "codemode on disk but pi will not load it",
      { ...SUBAGENTS_AXES, codemodeSwitch: { switch: "disabled", source: "user" } },
      FULL_SURFACE_TOOLS,
    ],
  ] as const) {
    for (const contents of legacy) {
      const { stub, dir } = await stubFromAgentDir(contents, options);
      try {
        expect([...stub.tools.keys()], `${JSON.stringify(contents)}, ${label}`).toEqual([
          ...expected,
        ]);
      } finally {
        await removeTempDir(dir);
      }
    }
  }
});

test("the surface is decided by the pi, in both directions, and neither is inherited from the machine", async () => {
  // This is the default, and the one behaviour that changes for an existing install. The previous
  // version of this test asserted `full` and passed for the wrong reason: the factory ran the real
  // probe, the probe looked at vitest's argv, and vitest has no pi next to it. Both branches are
  // stated here rather than inherited from the machine.
  //
  // ADR-0029 added a column, and it is the column that decides the DEFAULT. pi ships codemode and
  // loads it by default while registering it `defaultActive: false`, so with no `defaultTools`
  // anywhere the answer is `full` — the model cannot call the tool we would have handed
  // orchestration to. The `subagents` cell is reachable only when the loadout names codemode, and
  // the last row pins that naming it cannot resurrect a pi without the tool.
  for (const options of [
    { codemode: FOUND_CODEMODE },
    { ...SUBAGENTS_AXES },
    { codemode: NO_CODEMODE },
    { ...SUBAGENTS_AXES, codemode: NO_CODEMODE },
  ] as const) {
    const { stub, dir } = await stubFromAgentDir(null, options);
    try {
      const expected =
        "codemodeActivation" in options && options.codemode.present
          ? SUBAGENT_SURFACE_TOOLS
          : FULL_SURFACE_TOOLS;
      expect([...stub.tools.keys()], JSON.stringify(options)).toEqual([...expected]);
    } finally {
      await removeTempDir(dir);
    }
  }
});

test("the factory really reads the agent dir: a `settings.json` that disables codemode is honoured", async () => {
  // The counterfactual anchor for this whole file. Every other test states the pi it assumes
  // through a seam, so without this one a factory that ignored the agent dir entirely — or one
  // that dropped the switch axis from `detectedSurfaceMode` — would leave them all green while
  // resolving surfaces for a machine nobody is running.
  //
  // The switch is the only axis left that the stub does not pin: `makeExtensionStub` forwards
  // `codemodeSwitch` only when a caller names it, so leaving it out runs the production
  // `readCodemodeSwitch` over the temp agent dir. Presence and activation are named because they
  // ARE pinned (see `stubFromAgentDir`) — and named as "everything else says yes", so this cell's
  // answer is `full` for the switch's reason alone.
  const { stub, dir } = await stubFromAgentDir(null, SUBAGENTS_AXES_FROM_DISK, {
    extensions: ["-builtin:codemode"],
  });
  try {
    expect(
      [...stub.tools.keys()],
      "pi will not load codemode, so this session orchestrates itself",
    ).toEqual([...FULL_SURFACE_TOOLS]);
  } finally {
    await removeTempDir(dir);
  }
});

test("the same agent dir with codemode enabled resolves the `subagents` surface", async () => {
  // The other half of the pair above: same three axes, one line changed in the file on disk, and
  // `codemodeSwitch` still unnamed so the file is what decides. A factory that ignored
  // `settings.json` entirely would pass the first test only by accident; one that always resolved
  // `full` would fail this one.
  const { stub, dir } = await stubFromAgentDir(null, SUBAGENTS_AXES_FROM_DISK, {
    extensions: ["+builtin:codemode"],
  });
  try {
    expect([...stub.tools.keys()], "pi loads codemode and the model can call it").toEqual([
      ...SUBAGENT_SURFACE_TOOLS,
    ]);
  } finally {
    await removeTempDir(dir);
  }
});

test("a malformed ptc.json still gives the detected surface, and the problem is reported", async () => {
  // Spec decision 3: warns and falls back. The fallback alone is pinned in ptc-mode.test.ts;
  // what is new here is that the FACTORY surfaces the problem rather than swallowing it.
  //
  // ADR-0026 decision 5: the fallback is the DETECTED default, not a constant, so both directions
  // are stated and the presence is named as a seam. Before, this named no `codemode` at all, the
  // real probe ran against vitest's argv, and `not-found` was the only reason the full surface was
  // expected — the assertion would have passed just as happily on a pi that does ship codemode.
  for (const [options, expected] of [
    [{ ...SUBAGENTS_AXES }, SUBAGENT_SURFACE_TOOLS],
    [{ ...SUBAGENTS_AXES, codemode: NO_CODEMODE }, FULL_SURFACE_TOOLS],
  ] as const) {
    const dir = await makeTempDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const where = "codemode " + options.codemode.how;
    try {
      await writeFile(join(dir, "ptc.json"), "{ not json", "utf8");
      const stub = await makeExtensionStub(options);
      expect([...stub.tools.keys()], "a broken file must not half-apply: " + where).toEqual([
        ...expected,
      ]);
      // Scoped to THIS reader's warning by its own sentence, not by the file name. `ptc.json` is
      // named in several notices here (the legacy-key one among them), and a filter on the name
      // would silently absorb a change to any of them. The count still catches a duplicate.
      const parseWarnings = stub.notifications.filter(
        (n) => n.type === "warning" && n.message.includes("is not valid JSON"),
      );
      expect(parseWarnings.length, "the parse failure is visible, once: " + where).toBe(1);
      expect(parseWarnings[0]?.message, "and it names the file that failed").toContain(
        join(dir, "ptc.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await removeTempDir(dir);
    }
  }
});
test("a detected subagents surface on a pi that does not register codemode says so", async () => {
  // The filesystem probe cannot see --no-extensions or --exclude-tools codemode, so it answers
  // "present" for a pi that has codemode on disk and registers no such tool. The session is
  // then handed to an orchestrator that is not there, and the decision-4 warning cannot catch
  // it: that one asks whether codemode is ACTIVE, and with the tool absent both questions are
  // false for the same reason. This is the only assertion standing between that hole and a
  // silent session.
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // No ptc.json at all: the surface is DETECTED, and the probe is told pi has codemode. The
    // activation axis is what makes it a `subagents` surface at all (ADR-0029) — without it the
    // factory answers `full` and neither warning under test is reachable.
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ["read", "bash", "edit", "write"],
      // On `subagents` the pair is `codemode`-reach and pi declares NEITHER. Without this the stub
      // carries `full`'s default and reports both tools as declared, which makes the decision-4
      // warning withhold itself — so the comment below would describe a notice that is not in the
      // list.
      declaredProgrammingTools: [],
    });
    // Scoped to this notice: the decision-4 warning fires too, and it SHOULD -- a detected
    // subagents surface with no active codemode is exactly the state it exists to report. Two
    // warnings for one root cause is noisy, so the fix is in the message, not the count.
    const notices = stub.notifications.filter((n) => n.message.includes("--no-extensions"));
    expect(notices.length, "the over-estimate is reported").toBe(1);
    expect(notices[0]?.type, "and it is a warning, not a note").toBe("warning");
    // The advice no longer offers a setting, because there is none: the two ways this session can
    // get an orchestrator are both pi-side, so the message has to name them.
    expect(notices[0]?.message, "and it names a way to fix it").toContain("pi config");
    expect(notices[0]?.message, "and it names the other one too").toContain("codemode active");
    // The surface this warning is about. Without it the test also passes on a `full` session,
    // where the cross-check cannot fire at all -- the notice is then vacuously absent.
    expect([...stub.tools.keys()], "and the session really is holding a subagent face").toEqual([
      ...SUBAGENT_SURFACE_TOOLS,
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
});

test("a detected subagents surface on a pi that DOES register codemode stays quiet", async () => {
  // The other half, and the one that would catch a warning that fires on every healthy session.
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ["read", "bash", "edit", "write", "codemode"],
      // Same reason as the sibling above: `subagents` declares neither half of the pair, and this
      // test's silence has to come from `codemode` being ACTIVE, not from the stub reporting an
      // orchestrator the model already has.
      declaredProgrammingTools: [],
    });
    // The surface, before the silence. Without this the test also passes on a `full` session --
    // where neither warning is reachable -- so "healthy" would be asserted about a session that
    // never had the problem. ADR-0029 made that reachable by default, which is why it is pinned.
    expect(
      [...stub.tools.keys()],
      "a healthy session is the subagents face beside an active codemode",
    ).toEqual([...SUBAGENT_SURFACE_TOOLS]);
    // Scoped the same way: the PTC-mode announcement is this file's pre-existing noise and says
    // nothing about detection.
    expect(
      stub.notifications.filter((n) => n.message.includes("--no-extensions")),
      "healthy means silent",
    ).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
});
