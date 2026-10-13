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
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPT_IN_BINDING_NAMES } from "../src/runtime/bindings.ts";
import {
  captureRegisteredTools,
  makeExtensionStub,
  makeTempDir,
  removeTempDir,
  writeAgentSettings,
} from "./helpers/ptc.ts";
import { maskSource } from "./helpers/source-mask.ts";

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

/** Repo root's `src/`, for the one source scan below. */
const SRC_DIR = join(import.meta.dirname, "..", "src");
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
 *
 * Pass `raw` to write the body VERBATIM instead of serialising `ptc`. Without it there is no way to
 * produce an unparseable file at all: JSON-stringifying the text `not json` yields a quoted string,
 * which is a perfectly valid JSON value — so a test asking for an unparseable file silently got a
 * parseable one. Round 2 had three "broken file" bodies collapse into that single non-object path,
 * and the unparseable branch was never reached end to end while the test claimed to cover it.
 *
 * Returns the temp dir it used alongside the stub, because `readDefaultModeConfig` names that path
 * in its error sentence. A caller comparing two of those sentences has to erase the path first, and
 * it cannot do that without being told which path it was.
 */
async function emitSessionStartInAgentDir(
  ptc: unknown,
  options: Parameters<typeof makeExtensionStub>[0],
  raw?: string,
): Promise<{ stub: ExtensionStub; agentDir: string }> {
  const dir = await makeTempDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (raw !== undefined) {
      await writeFile(join(dir, "ptc.json"), raw, "utf8");
    } else if (ptc !== null) {
      await writeFile(join(dir, "ptc.json"), JSON.stringify(ptc), "utf8");
    }
    const stub = await makeExtensionStub(options);
    return { stub, agentDir: dir };
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
    const { stub } = await emitSessionStartInAgentDir(
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

/**
 * ADR-0040: what `session_start` says about the `optInBindings` grant.
 *
 * Two failure classes with opposite requirements. A key that is PRESENT AND WRONG must be
 * reported — the user wrote `"optInBindings": ["bash"]` and silently got no shell, which is a
 * support question with no other answer. A file that is merely absent, valid, or grantable must
 * be SILENT — a notice on every ordinary session is how users learn to ignore the notice that
 * matters.
 *
 * The single-notice assertion is the load-bearing one. Two readers parse this file
 * (`readDefaultModeConfig` for `defaultMode`, `readOptInBindingsConfig` for the grant), and the
 * boundary that keeps one broken file from producing two identical sentences is a code comment —
 * so it is pinned here, where a comment cannot be the only evidence.
 */
const optInNotice = (stub: ExtensionStub) =>
  stub.notifications.filter((n) => n.message.includes("opt-in binding"));

test("a wrong `optInBindings` key is reported once, and grants nothing", async () => {
  for (const bad of [["teleport"], ["read"], ["bash", "nope"], "bash", [7]]) {
    const { stub } = await emitSessionStartInAgentDir(
      { optInBindings: bad },
      { codemode: NO_CODEMODE },
    );
    const notices = optInNotice(stub);
    expect(notices.length, `one notice for ${JSON.stringify(bad)}, not a stream`).toBe(1);
    expect(notices[0]?.type, "the grant was refused, so it is a warning").toBe("warning");
    // It names the valid names, because the notice is the only place the user learns what to type.
    // And it names no particular binding: the message used to hard-write `bash`, which goes wrong
    // the moment a second opt-in exists. Everything it says now comes from the constant.
    expect(notices[0]?.message).toContain(OPT_IN_BINDING_NAMES.join(", "));
    expect(notices[0]?.message).toMatch(/No opt-in binding was granted.*stays narrowed/);
  }
});

test("a broken ptc.json is reported once, never once per reader", async () => {
  // The shapes `readOptInBindingsConfig` deliberately does NOT report — the file-level parse
  // failures belong to `readDefaultModeConfig`. If either reader starts reporting them again, one
  // broken file prints the same sentence twice and this turns red.
  //
  // **Four bodies, two failure sentences, and the split is deliberate.** Round 2 passed all its
  // bodies through `JSON.stringify`, which turned the unparseable one into a valid JSON string, so
  // every case took the same non-object path while the test claimed to cover the unparseable one.
  //
  // Round 3's version of the fix asserted the three sentences were all DIFFERENT. Earning the path
  // out of the comparison is what showed that claim to be false: with the temp dir erased, the array
  // and the scalar produce byte-identical sentences, because `readDefaultModeConfig` handles
  // `null`, a non-object and an array in ONE conditional and one message. That is the right product
  // behaviour — the user's remedy is identical in all three cases — so the test now asserts the real
  // shape: exactly two sentences, one of which is the unparseable one, and the array / scalar / null
  // trio is asserted to SHARE a sentence rather than merely to differ from its neighbours.
  //
  // Which matters for the reason the original comment gave, only now it is true: collapse the
  // unparseable path into the non-object one and the distinct count drops to 1 and this reds.
  //
  // `JSON null` is the fourth body and the reason it is here: `JSON.parse("null")` yields `null`,
  // the first disjunct of `parsed === null || typeof parsed !== "object" || Array.isArray(parsed)`,
  // and no other body reaches it. `ptc: null` alone would not — in this helper that means "write no
  // file at all" — hence the `raw`.
  const bodies: ReadonlyArray<{ label: string; ptc: unknown; raw?: string }> = [
    { label: "unparseable", ptc: null, raw: "{ not json" },
    { label: "non-object array", ptc: ["bash"] },
    { label: "JSON scalar", ptc: "nope" },
    { label: "JSON null", ptc: null, raw: "null" },
  ];
  const byLabel = new Map<string, string>();
  for (const body of bodies) {
    const { stub, agentDir } = await emitSessionStartInAgentDir(
      body.ptc,
      { codemode: NO_CODEMODE },
      body.raw,
    );
    expect(optInNotice(stub).length, `no opt-in notice for ${body.label}`).toBe(0);
    const ptcNotices = stub.notifications.filter((n) => /ptc\.json/.test(n.message));
    expect(ptcNotices.length, `exactly one notice for ${body.label}, not one per reader`).toBe(1);
    byLabel.set(body.label, (ptcNotices[0]?.message ?? "").replaceAll(agentDir, "<agent-dir>"));
  }
  const distinct = new Set(byLabel.values());
  expect(
    distinct.size,
    `two failure modes, once the temp path is erased: ${JSON.stringify([...byLabel])}`,
  ).toBe(2);
  const shared = byLabel.get("non-object array");
  expect(
    shared === byLabel.get("JSON scalar") && shared === byLabel.get("JSON null"),
    `array / scalar / null are one message by design, got: ${JSON.stringify([...byLabel])}`,
  ).toBe(true);
  expect(
    distinct.has(byLabel.get("unparseable") ?? ""),
    "the unparseable branch must keep its own sentence — that is what proves it was reached",
  ).toBe(true);
});

test("a working `optInBindings` grant is silent", async () => {
  // The other half, and the one that would catch a nag on every opted-in session.
  for (const good of [
    {},
    { defaultMode: true },
    { optInBindings: [] },
    { optInBindings: ["bash"] },
  ]) {
    const { stub } = await emitSessionStartInAgentDir(good, { codemode: NO_CODEMODE });
    expect(optInNotice(stub).length, `silent for ${JSON.stringify(good)}`).toBe(0);
  }
});

/**
 * Source-scan helpers, shared by the wiring tests below.
 *
 * Comments are masked by `maskSource`, not by a regex, and that detail is load-bearing twice over.
 * Round 2's version of this stripper used `/^[ \t]*\/\/.*$/gm`, which requires `//` to sit at the
 * start of a line — so a TRAILING `// TODO: getOptInBindings` inside the options object survived
 * untouched and satisfied a guard whose whole job is to prove the option was passed. Measured, not
 * assumed: that edit left the suite identical to baseline. `tests/config-read-points.test.ts` already
 * carried a correct four-state scanner for exactly this; it now lives in
 * `tests/helpers/source-mask.ts` and both fixtures share the one implementation, because two
 * hand-rolled strippers drift apart and the weaker one ends up being the one under test.
 */
function codeOf(path: string): string {
  return maskSource(readFileSync(path, "utf8")).code;
}

/**
 * Every call of `name(` in `source`, as the slice from the identifier to its matching close paren.
 *
 * Balanced rather than windowed. Round 2 used a fixed 400-character window, which is arbitrary:
 * measured on this file the option sat 67 characters in, the window reached 15 characters into the
 * NEXT registration, and that registration's own copy of the option fell 52 characters outside — so
 * the scan passed for the right reason by luck of the current formatting, and would have read the
 * wrong registration once the formatting changed. A wrong test that passes today is the same defect
 * as one that fails for the wrong reason.
 *
 * It runs on the `code` mask, comments blanked but string contents kept, and that is forced by the
 * data rather than chosen: one of the binding-list call sites lives inside a template interpolation
 * (`src/index.ts` builds the announcement with `` `${resolveBindingNames(base, optIns)...}` ``), and
 * the `structural` mask blanks template bodies, so scanning it would have dropped that site without
 * a word. Known limitation, same family as the one `maskSource` documents: a bracket inside a string
 * *argument* can still end a slice early. `BINDING_LIST_SITE_FLOOR` below is what catches that —
 * a truncated scan loses sites, and a floor is the repo's own idiom for exactly this
 * (`tests/config-read-points.test.ts` uses floors, not exact values, so that the guard does not go
 * red merely because the promise surface grew).
 *
 * A declaration is skipped — `function describeEntry(` has no arguments to check.
 */
function callSlices(source: string, name: string): string[] {
  const found: string[] = [];
  for (let i = source.indexOf(name); i !== -1; i = source.indexOf(name, i + name.length)) {
    if (/function\s+$/.test(source.slice(Math.max(0, i - 12), i))) continue;
    const open = source.indexOf("(", i);
    if (open === -1) continue;
    let depth = 0;
    for (let k = open; k < source.length; k++) {
      if (source[k] === "(") depth++;
      else if (source[k] === ")" && --depth === 0) {
        found.push(source.slice(i, k + 1));
        break;
      }
    }
  }
  return found;
}

/**
 * Top-level arguments of a call slice, split on commas that are not nested in brackets.
 *
 * String-aware, and by construction rather than by a comment claiming so: the slice is re-masked
 * with `maskSource(...).structural` first, which blanks string contents. Round 2's `argCount` had a
 * docstring promising it ignored "commas nested in brackets **or strings**" while its loop tracked
 * brackets only. Measured on that version: `f(a, "x, y")` counted 3 arguments instead of 2, so a
 * call that passed one real argument and a comma-bearing string satisfied a `> 1` check that exists
 * to catch a missing argument — the guard passed for the wrong reason, which is the same defect as
 * failing for the wrong reason.
 */
function topLevelArgs(call: string): string[] {
  const inner = maskSource(call).structural;
  const body = inner.slice(inner.indexOf("(") + 1, inner.lastIndexOf(")"));
  if (body.trim() === "") return [];
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) {
      args.push(body.slice(start, i));
      start = i + 1;
    }
  }
  args.push(body.slice(start));
  return args;
}

/**
 * Expressions that satisfy "an argument is syntactically present" while granting nothing.
 *
 * These are the substitution half of the defect. Round 2's guard caught a DELETED argument and
 * nothing else: `argCount(site) > 1` was still satisfied by `resolveBindingNames(base, [])`, which
 * is the same silent no-grant the deleted argument produces. The measured neutralisation for this
 * feature is exactly this shape — dropping the grant at the extension entry was tried as
 * `const optInBindings = []` — so a guard that misses it misses the known mutation.
 */
const EMPTY_GRANT = /^(?:\[\s*\]|new\s+Set\s*\(\s*\)|undefined|null|\{\s*\}|"")$/;

test("a comma inside a string is not an argument separator", () => {
  // The sentence the `topLevelArgs` docstring makes is this one, and without a test it is a claim
  // rather than a property — which is exactly how `argCount`'s identical claim survived a whole
  // round unverified. Round 4 measured it: changing `maskSource`'s `structural` branch back to
  // keeping string contents left every suite green, because nothing fed this helper a string.
  //
  // So it is fed one, here, and the expected values are literals about comma semantics rather than
  // anything read back out of `src/` — two arguments because there is one comma, and one argument
  // because the `(` in the string is not an opening paren.
  expect(
    topLevelArgs('resolveBindingNames(base, "read, bash")').length,
    "one comma, two args",
  ).toBe(2);
  expect(
    topLevelArgs('resolveBindingNames("a(b")').length,
    "a paren in a string is not a paren",
  ).toBe(1);
  // The negative direction, so the two cannot both be satisfied by a splitter that always answers
  // "one" or "two".
  expect(topLevelArgs("resolveBindingNames(base, optIns)").length).toBe(2);
  expect(topLevelArgs("resolveBindingNames(base)").length).toBe(1);
});

test("every place src/index.ts builds a binding list passes the grant through", () => {
  // **Self-extending on purpose.** Round 1 fixed "the two registrations"; round 2 measured that the
  // grant has six hops in `src/index.ts` and only two were held, leaving the mode-entry
  // announcement, the `/ptc` status line and the PTC-mode briefing able to lose the grant behind a
  // green suite. Enumerating sites fixes the ones you already know about and goes stale the moment
  // someone adds another, which is how the gap survived one round. So the assertion is a property of
  // EVERY call site: a new binding-list call that drops the grant turns this red with no further
  // review round needed.
  //
  // The property is "the opt-ins argument is present", NOT "the identifier `optInBindings` appears":
  // `describeEntry` forwards its own `optIns` parameter, which is the correct forwarding and would
  // fail an identifier check. Missing the argument is the defect; which variable carries it is not.
  //
  // The announcement also has a behavioural test (`tests/ptc-mode.test.ts > a granted opt-in reaches
  // the mode-entry announcement`). This scan covers what that cannot reach — the briefing, emitted
  // from `before_agent_start`, which the stub cannot drive — and keeps the property true for call
  // sites that do not exist yet.
  const source = codeOf(join(SRC_DIR, "index.ts"));
  const sites = BINDING_LIST_CALLEES.flatMap((callee) =>
    callSlices(source, callee.name).map((slice) => ({ callee, slice })),
  );
  expect(
    sites.length,
    "the scan found every binding-list site; a truncated scan is the failure this floor catches",
  ).toBeGreaterThanOrEqual(BINDING_LIST_SITE_FLOOR);
  for (const { callee, slice } of sites) {
    const args = topLevelArgs(slice);
    expect(
      args.length,
      `${callee.name} takes its opt-ins at position ${callee.grantAt}: ${slice}`,
    ).toBeGreaterThanOrEqual(callee.grantAt);
    expect(
      args[callee.grantAt - 1]?.trim(),
      `${callee.name} is handed an empty grant, which is the no-grant defect wearing a disguise`,
    ).not.toMatch(EMPTY_GRANT);
  }
});

/** Each binding-list callee and the 1-based argument position its opt-ins parameter occupies. */
const BINDING_LIST_CALLEES = [
  { name: "resolveBindingNames(", grantAt: 2 },
  { name: "describeEntry(", grantAt: 3 },
] as const;

/**
 * Floor, not an exact count — same reasoning as `tests/config-read-points.test.ts`: adding a sixth
 * hop must not redden this guard, but a scan that silently stops finding the five must.
 */
const BINDING_LIST_SITE_FLOOR = 5;

test("the grant reaches BOTH registered PTC tools", () => {
  // Behavioural coverage stops at `createPtcRunCodeTool({ getOptInBindings })` /
  // `createPtcWorkflowTool({ getOptInBindings })`, which `tests/binding-policy.test.ts` drives for
  // `ptc_run_code` only. The two tools are the only consumers of the value the extension read.
  //
  // The earlier comment here claimed the removal "left the whole suite green — measured, not
  // assumed". **It did not, and round 2 caught the over-claim.** Round 3 then corrected the
  // correction: the replacement claimed FOUR tests go red, and measuring the four named files found
  // TWO — this one and a `doc-integrity` line pin. `tests/ptc-mode.test.ts` stays green because the
  // announcement reads the `optInBindings` closure, not this `getOptInBindings` option, and
  // `tests/ocr-anchor-coverage.test.ts` is green on its own. The guard itself was always genuine;
  // what kept going wrong is the number attached to it, twice, in the same comment — so the count
  // is now the count this author measured, over the files this author names, with the scope stated
  // rather than implied. A full-suite count is not claimed and was not measured.
  const source = codeOf(join(SRC_DIR, "index.ts"));
  for (const factory of ["createPtcRunCodeTool({", "createPtcWorkflowTool({"]) {
    const at = source.indexOf(factory);
    expect(at, `${factory} is still registered in src/index.ts`).toBeGreaterThan(-1);
    let depth = 0;
    let end = source.length;
    for (let k = at + factory.length - 1; k < source.length; k++) {
      if (source[k] === "{") depth++;
      else if (source[k] === "}" && --depth === 0) {
        end = k + 1;
        break;
      }
    }
    expect(source.slice(at, end), `${factory} does not pass getOptInBindings`).toMatch(
      /getOptInBindings/,
    );
  }
});

test("no legacy notice when ptc.json carries no `surfaceMode` key", async () => {
  // The other half, and the one that would catch a notice on every ordinary session: `defaultMode`
  // still lives in this file, so most sessions have one and most sessions must hear nothing.
  for (const ptc of [null, { defaultMode: false }, { defaultMode: true }]) {
    const { stub } = await emitSessionStartInAgentDir(ptc, { codemode: NO_CODEMODE });
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
  /*
   * HOME is isolated because this file's stores and resolvers read it, and a test that lets the
   * developer's real `~/.pi` decide its outcome is not green, it is unmeasured.
   *
   * The redirect was added for a narrower reason, now history: this session registers
   * `ptc_subagent`, so `session_start` used to enumerate the agent registry, and
   * `resolveAgentDirs` answers the USER axis from `os.homedir()` — which `PI_CODING_AGENT_DIR`
   * does not touch. #187 removed that enumeration with the notice it fed, so the specific reason
   * is gone; the discipline stays.
   *
   * It was passing by accident before the redirect: this repository's own machine had one
   * `__smoke_echo.md` left over from a 2026-09-22 manual smoke run, so "no warning" happened to
   * hold. Deleting that file — which the T5 ticket asked for, since it is what the automated smoke
   * test replaced — turned it red, which is how the missing isolation surfaced at all.
   */
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = await makeTempDir();
  process.env.USERPROFILE = process.env.HOME;
  try {
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ["read", "bash", "edit", "write", "codemode", "ptc_subagent"],
    });
    /*
     * Scoped to THIS notice.
     *
     * The scoping was load-bearing when this test was written: the session registers
     * `ptc_subagent` against an isolated-but-empty agent registry, so the agent-availability
     * warning fired here — correctly, at the time — and a blanket "no warning of any kind" would
     * have been asserting a false thing about the product. That warning is gone (#187: an empty
     * registry stopped being a problem once an omitted `agent` began dispatching a generalist
     * child), so nothing else fires here now and the narrowing is no longer load-bearing. It is
     * kept anyway: this file asserts ONE notice per test, and that rule should not depend on which
     * notices happen to exist in a given week.
     */
    expect(
      stub.notifications.filter((n) => n.message.includes("no orchestration tool")),
      "the missing-orchestrator warning is the subject, and codemode is present",
    ).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
});

test("a subagents session with no agent definitions says nothing about it", async () => {
  /*
   * The inverse of the notice #178 added and #187 retires, asserted rather than merely deleted.
   *
   * That notice reported that no agent was registered, and therefore that `ptc_subagent` had
   * nothing to dispatch. That was true only while `agent` was required; an omitted `agent` now
   * dispatches a generalist child, so an empty registry is the normal state of a fresh install and
   * the notice was a false alarm about a tool that works.
   *
   * Deleting the tests that asserted it FIRES would leave this absence unheld — re-adding the
   * block in `session_start` would turn nothing red.
   */
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  const home = await makeTempDir();
  const cwd = await makeTempDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  /*
   * BOTH axes of the registry, not just the user one. `resolveAgentDirs` answers the project axis
   * from the session cwd and `session_start` reads `ctx.cwd ?? process.cwd()`, which the stub does
   * not set — so without this the project half is the REPOSITORY root. That is empty today and the
   * assertion bites; it stops biting the moment this repo ships its own `.pi/agents/*.md`, which
   * is not hypothetical: commit `1f133e8` exists because `dd8cda4` added one and three tests went
   * red on a machine whose verdict had been decided by the checkout it ran in. The directory is
   * created rather than left absent, so "there are no agents" is a state this test makes rather
   * than one it inherits.
   */
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  process.chdir(cwd);
  try {
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ["read", "bash", "edit", "write", "codemode", "ptc_subagent"],
    });
    expect(
      stub.notifications.filter((n) => /registered agent|nothing to dispatch/i.test(n.message)),
      "an empty registry is the normal state, not a problem to report",
    ).toEqual([]);
    /*
     * And the STATUS surface, which nothing else holds. Measured: a build whose marker paints
     * `"PTC  no registered agent"` while emitting no notification at all left the whole suite
     * green — the assertion above cannot see the status line, and `ptc-mode.test.ts` pins equality
     * only for a session the marker was never painted into.
     */
    expect(
      stub.statuses.filter((s) => /registered agent/i.test(s.text ?? "")),
      "and the status line does not carry it either",
    ).toEqual([]);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
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
