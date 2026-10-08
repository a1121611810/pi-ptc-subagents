/**
 * ADR-0026 decision 6, at the one point where both answers are available: `session_start`.
 *
 * Two different questions get asked about pi's own `codemode`, from two different APIs, and
 * the difference is the whole point of this file:
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
 * ADR-0029 moved `known && !active` out of the surface decision entirely: it is now the default
 * cell and resolves to `full`, so the factory does not build the `subagents` surface these tests
 * are about. Every case below therefore configures `defaultTools: ["+codemode"]` to reach
 * `subagents` on purpose, which leaves the prediction and the real loadout free to disagree --
 * which is the remaining job of the two warnings.
 *
 * These two cases are the pair that fixes that, and each one is red against the other:
 *   - codemode KNOWN and active     -> neither warning; the healthy session
 *   - codemode KNOWN and inactive   -> not the `--no-extensions` warning (pi does register
 *                                      it), but the decision-4 one, because it really cannot
 *                                      be called
 *   - codemode ABSENT entirely       -> the `--no-extensions` warning
 */
import { expect, test } from "vitest";
import {
  ACTIVE_CODEMODE_SETTINGS,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  stubContext,
  writeAgentSettings,
} from "../helpers/ptc.ts";

/** BG-14: the three always-on background-task tools, in registration order. */
const TASK_TOOLS = ["ptc_task_list", "ptc_task_output", "ptc_task_stop"] as const;

/** The message of the ADR-0026 cross-check warning, i.e. the "pi does not register it" one. */
const REGISTRY_CROSSCHECK = "--no-extensions";
/** The message of the ADR-0025 decision-4 warning, i.e. the "not active" one. */
const NOT_ACTIVE = "codemode is not active";

/** Build the stub, emit `session_start` against it, and return the notifications it raised. */
async function sessionStartNotices(options: {
  active: readonly string[];
  /** Tools pi's registry knows about that the active loadout does not name. */
  registeredInactive?: readonly string[];
}): Promise<{ notices: { message: string; type?: string }[]; tools: string[] }> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // No ptc.json at all: the surface is DETECTED, and the probe is told pi has codemode on
    // disk. Both warnings under test are reachable only on that path.
    //
    // ADR-0029: `defaultTools: ["+codemode"]` is what puts codemode in the loadout at all. pi
    // registers it inactive, so without this the factory resolves `full` and none of these
    // warnings is reachable -- the `subagents` surface they are about would not be built.
    await writeAgentSettings(dir, ACTIVE_CODEMODE_SETTINGS);
    const stub = makeExtensionStub({
      surfaceMode: "from-file",
      codemode: { present: true, how: "found" },
      active: options.active,
      ...(options.registeredInactive === undefined
        ? {}
        : { registeredInactive: options.registeredInactive }),
    });
    await stub.emit("session_start", stubContext(stub, { mode: "tui" }));
    return { notices: [...stub.notifications], tools: [...stub.tools.keys()] };
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await removeTempDir(dir);
  }
}

test("a detected subagents surface on a pi that KNOWS codemode but did not activate it is not told the tool is missing", async () => {
  // ADR-0029 renamed what this case IS. It used to be the shipped state: pi registers codemode
  // with `defaultActive: false`, so the probe said present, the registry agreed, and the model
  // still could not call it. That is now the DEFAULT cell of the detected table, and the factory
  // answers `full` for it without building a `subagents` surface at all -- the session this file
  // exists to reason about no longer happens by accident.
  //
  // What remains here is the case the activation probe gets WRONG in the recoverable direction:
  // `defaultTools` names codemode, the probe therefore predicts `active`, and pi's real loadout
  // disagrees. The factory cannot correct that (registration is irreversible), so this is exactly
  // what the decision-4 warning is for -- and it is the evidence for the bound ADR-0029 rests on,
  // that an over-report is caught by measurement rather than shipped silently.
  //
  // The probe found codemode and pi's registry agrees, so the two answers are consistent and
  // there is nothing to reconcile: the "--no-extensions" warning would be a lie here, and it
  // would fire on every session whose prediction was wrong.
  const { notices, tools } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write"],
    registeredInactive: ["codemode"],
  });
  expect(
    notices.filter((n) => n.message.includes(REGISTRY_CROSSCHECK)),
    "pi registers codemode, so the probe and the registry agree and nothing is reported",
  ).toEqual([]);
  expect(
    notices.filter((n) => n.message.includes(NOT_ACTIVE)),
    "but the model still cannot call it, which the decision-4 warning is for",
  ).toHaveLength(1);
  // The surface itself is the one the detection picked: ptc_subagent beside the task tools, and
  // no run-code orchestrator beside a live codemode.
  expect(tools).toEqual(["ptc_subagent", ...TASK_TOOLS, "ptc_child_report"]);
});

test("the same pi with codemode ABSENT from the registry does get the cross-check warning", async () => {
  // The contrast, and the reason the first test is worth anything: identical in every other
  // respect -- same probe answer, same active loadout, same surface -- and the one difference
  // is what `getAllTools()` knows. With the old stub these two cases were the same case,
  // because `getAllTools()` was built out of the active list.
  const { notices } = await sessionStartNotices({
    active: ["read", "bash", "edit", "write"],
  });
  const crosschecks = notices.filter((n) => n.message.includes(REGISTRY_CROSSCHECK));
  expect(crosschecks, "a pi that does not register codemode is reported once").toHaveLength(1);
  expect(crosschecks[0]?.type, "and it is a warning, not a note").toBe("warning");
  expect(crosschecks[0]?.message, "and it names the fix").toContain('"full"');
});

test("a pi that knows AND activates codemode raises neither warning", async () => {
  // The "healthy means silent" case the old stub was the only way to reach, kept here so the
  // pair above has its third leg: active means present AND callable, and the two questions
  // collapse to one answer again.
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
  expect(tools).toEqual(["ptc_subagent", ...TASK_TOOLS, "ptc_child_report"]);
});
