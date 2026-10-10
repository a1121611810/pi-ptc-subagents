/**
 * ADR-0026 decision 6, at the one point where both answers are available: `session_start`.
 *
 * Two different questions get asked about pi's own `codemode`, from two different APIs, and the
 * difference is the whole point of this file:
 *
 *   - `getAllTools()`  -- does this pi KNOW the tool? That is what the filesystem probe
 *     cannot see (`--no-extensions`, `--exclude-tools codemode`), so the cross-check at
 *     session start compares the probe's answer against the registry's.
 *   - `getActiveTools()` -- can the model CALL it? ADR-0025 decision 4 warns when a
 *     `subagents` surface has no active codemode, because there is then no orchestrator.
 *
 * pi's `codemode` registers with `defaultActive: false`, so on a real install the shipped
 * state is `known && !active`. `makeExtensionStub` used to answer `getAllTools()` with the
 * active set plus what the factory registered -- the same list twice -- so it could not express
 * that state, and the only reachable version of "healthy means silent" was one where codemode
 * was active. The two cases were indistinguishable to every test: with the old stub, a pi that
 * knows codemode and a pi that has never heard of it both answered "no codemode" to
 * `getAllTools()`.
 *
 * **What changed, and what these cases now reach through.** The activation axis used to be a
 * mirror of the settings, so it could say `active` while pi's real loadout said otherwise — and
 * that disagreement was what the decision-4 warning was invented for. It is now READ from
 * `getActiveTools()`, so on that axis the two cannot disagree.
 *
 * The disagreement survives on the other axis, and it is not a hypothetical: pi's MCP extension
 * activates `codemode` from inside its own `session_start` handler, and extension order is not
 * ours to choose. Measured on pi 1.1.0 with a project `mcp.json` naming a codemode-exposed
 * server: a synchronous read here saw it inactive, a read one microtask later still did, and it
 * appeared roughly 250 ms afterwards. So the file-side evidence says `active`, the surface is
 * built as `subagents`, and the loadout genuinely does not have the tool yet — which is exactly
 * the case below, reached the way a real session reaches it.
 *
 * These three cases are the set, and each one is red against the others:
 *   - codemode KNOWN and inactive, evidence said active -> decision-4 only
 *   - codemode ABSENT entirely                        -> the registry cross-check
 *   - codemode KNOWN and active                       -> neither; the healthy session
 */
import { expect, test } from "vitest";
import { makeExtensionStub, makeTempDir, removeTempDir } from "../helpers/ptc.ts";

/** BG-14: the three always-on background-task tools, in registration order. */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;

/** The message of the ADR-0026 cross-check warning, i.e. the "pi does not register it" one. */
const REGISTRY_CROSSCHECK = "--no-extensions";
/** The message of the ADR-0025 decision-4 warning, i.e. the "not active" one. */
const NOT_ACTIVE = "codemode is not active";

/** The tool set on the `subagents` surface: the pair at codemode reach, plus the subagent face. */
const SUBAGENTS_TOOLS = ["ptc_run_code", "ptc_workflow", "ptc_subagent", ...TASK_TOOLS];

/**
 * Build the stub and return the notifications its `session_start` raised.
 *
 * `makeExtensionStub` drives `session_start` itself, because that is the event that registers. It
 * must not be fired a second time here: the session would register twice and every notice would
 * appear twice, which reads as "this package warns twice" rather than as a test error.
 */
async function sessionStartNotices(options: {
  active: readonly string[];
  /** Tools pi's registry knows about that the active loadout does not name. */
  registeredInactive?: readonly string[];
  /**
   * ADR-0025 (amended): what this session DECLARES to the model. These tests are all about the
   * `subagents` shape, where the pair is `codemode`-reach and absent from `getActiveTools()`; the
   * stub's default is `full`'s, which would make the decision-4 warning withhold itself for a
   * reason that has nothing to do with what is under test.
   */
  declaredProgrammingTools?: readonly string[];
  /** What the activation axis resolved to. Defaults to the live loadout's own answer. */
  activation?: { activation: "active" | "inactive"; source: "loadout" | "mcp" };
}): Promise<{ notices: { message: string; type?: string }[]; tools: string[] }> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const stub = await makeExtensionStub({
      // No ptc.json at all: the surface is DETECTED, and the probe is told pi has codemode on
      // disk. Both warnings under test are reachable only on that path.
      //
      // All three probes are pinned. The surface these tests are about is `subagents`, and leaving
      // any axis to run for real would make it depend on the machine running the suite.
      codemode: { present: true, how: "found" },
      codemodeSwitch: { switch: "enabled", source: "user" },
      codemodeActivation:
        options.activation ??
        (options.active.includes("codemode")
          ? { activation: "active", source: "loadout" }
          : { activation: "inactive", source: "loadout" }),
      active: options.active,
      ...(options.registeredInactive === undefined
        ? {}
        : { registeredInactive: options.registeredInactive }),
      ...(options.declaredProgrammingTools === undefined
        ? {}
        : { declaredProgrammingTools: options.declaredProgrammingTools }),
    });
    return { notices: [...stub.notifications], tools: [...stub.tools.keys()] };
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
}

test("a subagents surface built on evidence pi has not applied yet gets the not-active warning", async () => {
  // The recoverable wrong answer, reached the way a real MCP session reaches it: the evidence said
  // `active`, the surface is `subagents`, and pi's loadout does not have the tool YET. The package
  // cannot correct that — pi has no unregister — so reporting it is the whole of the design, and
  // this is the evidence for the bound ADR-0029 rests on.
  //
  // The probe found codemode and pi's registry agrees, so the two answers are consistent and
  // there is nothing to reconcile: the "--no-extensions" warning would be a lie here.
  const { notices, tools } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write"],
    registeredInactive: ["codemode"],
    activation: { activation: "active", source: "mcp" },
    // This session resolved `subagents`, where the pair is `codemode`-reach and pi declares
    // neither. Saying so is what makes the decision-4 warning's premise true — its gate asks what
    // the model is offered before telling it it has no orchestration tool.
    declaredProgrammingTools: [],
  });
  expect(
    notices.filter((n) => n.message.includes(REGISTRY_CROSSCHECK)),
    "pi registers codemode, so the probe and the registry agree and nothing is reported",
  ).toEqual([]);
  expect(
    notices.filter((n) => n.message.includes(NOT_ACTIVE)),
    "but the model cannot call it yet, which the decision-4 warning is for",
  ).toHaveLength(1);
  // The surface itself is the one the detection picked: ptc_subagent beside the task tools, and
  // the program pair reachable from pi's live codemode without being declared to the model.
  expect(tools).toEqual([...SUBAGENTS_TOOLS, "ptc_child_report"]);
});

test("the same pi with codemode ABSENT from the registry does get the cross-check warning", async () => {
  // The contrast, and the reason the first test is worth anything: identical in every other
  // respect — same probe answer, same active loadout, same surface — and the one difference
  // is what `getAllTools()` knows. With the old stub these two cases were the same case,
  // because `getAllTools()` was built out of the active list.
  const { notices } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write"],
    activation: { activation: "active", source: "mcp" },
    declaredProgrammingTools: [],
  });
  const crosschecks = notices.filter((n) => n.message.includes(REGISTRY_CROSSCHECK));
  expect(crosschecks, "a pi that does not register codemode is reported once").toHaveLength(1);
  expect(crosschecks[0]?.type, "and it is a warning, not a note").toBe("warning");
  // The surface NAMED is the one the three probes resolved to, not a hardcoded literal in the
  // notice. Asserting the literal would let a wrong resolution ship silently.
  expect(crosschecks[0]?.message, "and it names the surface actually in force").toContain(
    'the surface is "subagents"',
  );
});

test("a pi that knows AND activates codemode raises neither warning", async () => {
  // The "healthy means silent" case, kept here so the pair above has its third leg: active means
  // present AND callable, and the two questions collapse to one answer again.
  const { notices, tools } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write", "codemode"],
    registeredInactive: ["codemode"],
  });
  expect(
    notices.filter(
      (n) => n.message.includes(REGISTRY_CROSSCHECK) || n.message.includes(NOT_ACTIVE),
    ),
    "healthy means silent: known and active is the one state with nothing to report",
  ).toEqual([]);
  expect(tools).toEqual([...SUBAGENTS_TOOLS, "ptc_child_report"]);
});

test("a session that did not activate codemode resolves full and says neither warning", async () => {
  // The cell that used to need a settings file written on disk to reach. Activation is read from
  // the loadout now, so "pi did not activate it" is expressed by the loadout not naming it —
  // which is pi's own default, `defaultActive: false`, rather than something this package infers.
  //
  // No warning is correct and not merely quiet: both warnings describe a `subagents` surface with
  // a missing orchestrator, and this session has no such surface. A decision-4 warning here would
  // be crying wolf on the most ordinary pi there is.
  const { notices, tools } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write"],
    registeredInactive: ["codemode"],
  });
  expect(
    notices.filter(
      (n) => n.message.includes(REGISTRY_CROSSCHECK) || n.message.includes(NOT_ACTIVE),
    ),
    "full is the right answer for a session that activated nothing, so there is nothing to warn about",
  ).toEqual([]);
  expect(tools, "and the subagent face is absent, because that is what full means").not.toContain(
    "ptc_subagent",
  );
});
