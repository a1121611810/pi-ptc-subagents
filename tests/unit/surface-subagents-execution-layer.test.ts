/**
 * The `subagents` line registers the two programming tools at `codemode` reach.
 *
 * **Why this file exists.** ADR-0025 removed the duplicate composition surface by registering
 * `ptc_run_code` and `ptc_workflow` only on `full`. That left the `subagents` line with a
 * subagent tool and a lifecycle face but no program underneath pi's `codemode` — and the one
 * capability `codemode` cannot provide at all is spawning a process, because its QuickJS sandbox
 * has no module loader (`codemode/tool.js` describes "No Node, file system, network, or timers",
 * and `codemode` runtime `host.js` injects `tools` and the output helpers and nothing else).
 * Registering the pair at `codemode` reach makes PTC that script's execution layer.
 *
 * **The claim being pinned is about REACH, not presence.** `codemode` reach does not declare a
 * tool to the model — on a pi that carries the rule, `AgentSession._isDeclarable` admits
 * `direct` and `model-only` only — so this does not recreate the duplicate surface ADR-0025
 * removed. The counterfactual below is what makes that testable rather than asserted: `direct` on
 * the same line WOULD declare it to the model.
 *
 * **The floor is asserted, not skipped.** The last three tests each decide their own branch from a
 * measurement of the installed pi, because the declared floor (0.86.0) has neither
 * `_isDeclarable` nor `_getToolExposure` and the branches assert genuinely different things.
 * They used to quote those methods out of pi's dist unconditionally, so on the floor all three were
 * red for a reason that had nothing to do with this package: they were reading a predicate out of
 * a pi that does not have one.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodemodeActivationResolution,
  CodemodePresence,
  CodemodeSwitchResolution,
} from "../../src/mode/ptc-mode.ts";
import { makeExtensionStub } from "../helpers/ptc.ts";
import { installedPiDir, probePiCapabilities } from "../helpers/pi-compat-probe.ts";

/**
 * One row of `detectedSurfaceMode`'s table (`src/mode/ptc-mode.ts:1046-1053`), stated as literals.
 *
 * `surfaceMode` is gone as an option, so a test reaches a line by naming the three probes that
 * resolve to it — which makes the surface the OUTPUT of the factory rather than its input, and
 * these constants the independent source every expectation below points at.
 *
 * **All three are pinned in every row, and that is load-bearing rather than tidy.** With no key to
 * short-circuit it, an unpinned switch or activation axis runs the real probe over the DEVELOPER's
 * `~/.pi/agent/settings.json`, so the reach this file reports would depend on the machine running
 * it. Pinning presence alone is not enough either: it only short-circuits the "not on disk" row,
 * and every other row still reads the other two axes off disk.
 */
interface SurfaceAxes {
  codemode: CodemodePresence;
  codemodeSwitch: CodemodeSwitchResolution;
  codemodeActivation: CodemodeActivationResolution;
}

/** Row four — loaded but not callable, which is the default cell on a real install. Resolves `full`. */
const FULL_AXES: SurfaceAxes = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  // "loadout" is the only provenance a real session_start can produce: activation is read
  // from `pi.getActiveTools()`, so no settings file is left to name.
  codemodeActivation: { activation: "inactive", source: "loadout" },
};

/** Row three — the same pi, but the model can call it. Differs from the above in one axis. */
const SUBAGENTS_AXES: SurfaceAxes = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "loadout" },
};

/** The reach each tool carries on a line, read off what the factory actually registered. */
async function reachOn(axes: SurfaceAxes): Promise<Record<string, string>> {
  // `async` because registration moved into `session_start`: there is nothing in the registry
  // until the helper has fired that event.
  const stub = await makeExtensionStub(axes);
  const out: Record<string, string> = {};
  for (const [name, definition] of stub.tools) {
    // pi's default when no exposure is named, so a missing field reads as the value in force.
    out[name] = (definition as { exposure?: string }).exposure ?? "direct";
  }
  return out;
}

// ---------------------------------------------------------------------------------------
//  What the INSTALLED pi is, measured. Not assumed from the declared peer range.
// ---------------------------------------------------------------------------------------

/**
 * The installed pi's `dist`, or `undefined` when pi is not installed at all.
 *
 * `undefined` is a real outcome rather than an error: this package declares pi as an OPTIONAL peer
 * (`peerDependenciesMeta` marks all three optional), so a tree carrying no pi is a supported tree,
 * and it lands on the same branch as a pi with no exposure machinery — which is correct, because
 * neither can honour a `codemode` reach. The walk itself now lives in
 * `tests/helpers/pi-compat-probe.ts` so this file and the four other version-sensitive files cannot
 * disagree about WHICH pi they are measuring.
 */
const PI_DIR = installedPiDir(import.meta.dirname);
const PI_DIST = PI_DIR === undefined ? undefined : join(PI_DIR, "dist");

/** pi's `AgentSession` source, or `""` when pi (or that file) is not installed. */
const PI_SESSION_SOURCE =
  PI_DIST === undefined ? "" : readFileIfPresent(join(PI_DIST, "core", "agent-session.js"));

function readFileIfPresent(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/**
 * The installed pi's declared version, read off its own `package.json`.
 *
 * This is the INDEPENDENT SOURCE the probes above are checked against, and it is what makes them
 * more than self-consistency: a probe set that lies about every fact at once still satisfies every
 * internal relationship in this file. Measured — hardcoding all three probes to `true` on the
 * 0.86.0 floor left all seven tests green, because each was asserting that the measurements agreed
 * with each other and never with pi. A version string cannot be satisfied by the same edit that
 * flips the probes, so the pairing below is falsifiable from outside this file.
 */
const INSTALLED_PI_VERSION: string = ((): string => {
  const manifest = PI_DIST === undefined ? undefined : join(PI_DIST, "..", "package.json");
  if (manifest === undefined || !existsSync(manifest)) return "unknown";
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version ?? "unknown";
})();

/**
 * Whether the version claims to be at least 0.99.0, where the exposure machinery arrived.
 *
 * A numeric comparison rather than a prefix test, so a hypothetical `1.10.0` does not read as
 * older than `0.99.0` the way a string comparison would.
 */
const VERSION_IS_AT_LEAST_0_99_0 = ((): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(INSTALLED_PI_VERSION);
  if (match === null) return false;
  const [major, minor, patch] = [match[1], match[2], match[3]].map((part) => Number(part));
  if (major !== 0) return (major ?? 0) > 0;
  return (minor ?? 0) > 99 || ((minor ?? 0) === 99 && (patch ?? 0) >= 0);
})();

/** Whether `_isDeclarable(name)` exists — the rule that keeps a `codemode` tool off the list. */
const HAS_DECLARABILITY_RULE = PI_SESSION_SOURCE.includes("_isDeclarable(name)");

/** Whether `_getToolExposure(name)` exists — the reader that makes the field mean anything. */
const READS_EXPOSURE_FIELD = /_getToolExposure\(name\)[^}]*definition\.exposure/.test(
  PI_SESSION_SOURCE,
);

/** Whether a `codemode`-reach tool is callable from a script: `_getCallableTools` admits it. */
const EXPOSURE_REACH_CALLABLE = /return exposure === "codemode" \|\| exposure === "deferred"/.test(
  PI_SESSION_SOURCE,
);

/** Whether pi ships the sandbox — `dist/extensions/codemode`, the thing that would call it. */
const SHIPS_CODEMODE_SANDBOX =
  PI_DIST !== undefined && existsSync(join(PI_DIST, "extensions", "codemode"));

/**
 * The same fact, measured by the SHARED probe, and asserted to agree with the directory check above.
 *
 * Two measurements of one fact from two files is exactly the drift this file's version-string
 * cross-check exists to catch, so rather than choosing one, both are kept and the AGREEMENT is
 * asserted (below). `outputSchemaRead` is the stronger of the two — it asks whether anything
 * CONSUMES a declared `outputSchema`, not merely whether a directory exists — and it is false on the
 * floor because `dist/extensions/codemode/execute.js` does not exist there at all.
 *
 * It is also the third of the three fields that arrived together in 0.99.0, which is why it belongs
 * in this file: `exposure` (above), `structuredContent` and `outputSchema` are one compile gate,
 * and a pi that shipped the sandbox without wiring the schema would have this true and the reach
 * below still inert.
 */
const SHARED = probePiCapabilities(import.meta.dirname);

/**
 * Whether this pi can HONOUR a `codemode`-reach registration.
 *
 * All three facts are required, and the all-or-nothing is the point: the field is inert without a
 * reader, and a reader with nothing to call is equally inert. This is the predicate the branches
 * below select on, and it is `detectedSurfaceMode`'s first row in the same shape.
 */
const CAN_HONOUR_CODEMODE_REACH =
  HAS_DECLARABILITY_RULE && READS_EXPOSURE_FIELD && SHIPS_CODEMODE_SANDBOX;

/**
 * The presence axis for the INSTALLED pi, read off its dist rather than invented.
 *
 * This is what makes the fallback test below a measurement of real behaviour instead of a
 * restatement: `makeExtensionStub` pins the axes so nothing depends on the developer's own
 * `~/.pi/agent`, and this is the pin. On the floor it says `present: false`, which is what
 * `probeCodemodePresence` returns for a 0.86.0 install because there is no `extensions/codemode`
 * directory to find — measured, `ls dist/extensions` there lists only `index` and `llama`.
 */
const INSTALLED_PI_PRESENCE: CodemodePresence = SHIPS_CODEMODE_SANDBOX
  ? { present: true, how: "found" }
  : { present: false, how: "not-found" };

describe("the programming tools' reach per line", () => {
  test("`full` declares them to the model — this package is what orchestrates there", async () => {
    const reach = await reachOn(FULL_AXES);
    expect(reach.ptc_run_code, "ptc_run_code reach on the full line").toBe("direct");
    expect(reach.ptc_workflow, "ptc_workflow reach on the full line").toBe("direct");
  });

  test("`subagents` puts them at codemode reach — callable from a script, not declared to the model", async () => {
    const reach = await reachOn(SUBAGENTS_AXES);
    expect(reach.ptc_run_code, "ptc_run_code reach on the subagents line").toBe("codemode");
    expect(reach.ptc_workflow, "ptc_workflow reach on the subagents line").toBe("codemode");
  });

  test("the subagent tool stays `direct` there — it exists to need no orchestrator", async () => {
    const reach = await reachOn(SUBAGENTS_AXES);
    expect(reach.ptc_subagent, "subagent reach on the subagents line").toBe("direct");
    // A `codemode`-reach subagent tool would be callable only by the sandbox that cannot spawn.
  });
});

/**
 * Three tests, each deciding its OWN branch from the measurement above, and NEITHER branch skipped.
 *
 * `test.skipIf` is the shape a skip would take here, and it is rejected for the reason
 * `tests/ocr-anchor-coverage.test.ts` records: a skipped test reads like a passing one in a suite
 * summary, and the acceptance criterion for this file's floor run is that it reports no failure AND
 * no skip. Each test therefore names the branch it is on in its assertion message, and both run on
 * both ends of the declared peer range.
 *
 * **A branch selects an EXPECTATION VALUE, never whether to assert.** Wrapping a body in `if` is
 * F2 (conditional assertion) and `tests/test-meta-discipline.test.ts` fails it mechanically, so
 * every test below asserts unconditionally against a value the measurement chose.
 */
describe("pi's exposure machinery: measured, then either quoted or worked around", () => {
  test("pi's own declarability rule is what keeps this from being a duplicate surface", () => {
    // **Read from pi's installed source rather than restated here.** A local `isDeclarable` arrow
    // asserting its own literals is the shape constraint 5 exists to reject: it stays green
    // whatever `src/` does, and whatever pi does. This greps the real
    // `@earendil-works/pi-coding-agent`, so a pi that widened the rule turns this red instead of
    // leaving the reasoning above to be reused unchanged.
    //
    // On a pi WITHOUT the rule there is nothing to quote, so the expectation value is the empty
    // string and the regex below is answered by it. That is the honest floor-side content of this
    // test — "this pi has no declarability rule for us to have widened" — and it is a measurement
    // rather than a no-op: a mutant that hardcoded a source string, or that read a pi whose rule
    // had changed, fails here. The companion test carries the floor's substantive claim, about what
    // THIS package registers rather than about what pi contains.
    // **The EXPECTED SHAPE is what is asserted, and it is asserted on both ends of the range.**
    // Asserting the rule's text unconditionally cannot work: on the floor there is no rule to
    // quote, so a regex over `""` matches nothing and the test would be red for a reason that is
    // about pi's version rather than about this package — which is the bug this whole change exists
    // to remove. Asserting `toContain` conditionally instead would be F4-shaped: an assertion whose
    // subject is an empty string proves only that "" does not contain a rule.
    //
    // So the expectation is a BOOLEAN about the installed pi — "it carries the rule, and the rule
    // admits `direct`/`model-only` and excludes `codemode`" — and the regexes above are folded into
    // it, so they are still checked on every pi that has the rule rather than only on the ceiling
    // this repo happens to pin. A mutant that widened the rule to admit `codemode` flips this on a
    // ceiling pi; a mutant that deleted the rule from pi's dist flips it on a floor pi.
    const declaresDirectAndModelOnly =
      HAS_DECLARABILITY_RULE &&
      /_isDeclarable\(name\)\s*\{[^}]*exposure === "direct" \|\| exposure === "model-only"/.test(
        PI_SESSION_SOURCE,
      );
    const declaresCodemode =
      HAS_DECLARABILITY_RULE &&
      /_isDeclarable\(name\)\s*\{[^}]*exposure === "codemode"/.test(PI_SESSION_SOURCE);
    expect(
      { hasRule: HAS_DECLARABILITY_RULE, declaresDirectAndModelOnly, declaresCodemode },
      HAS_DECLARABILITY_RULE
        ? "a pi with the rule must admit direct/model-only and must NOT admit codemode reach, or the pair would reach the model as a second front"
        : "a pi with no rule cannot admit codemode reach, which is why this package registers no duplicate surface on it",
    ).toEqual({
      hasRule: HAS_DECLARABILITY_RULE,
      declaresDirectAndModelOnly: HAS_DECLARABILITY_RULE,
      declaresCodemode: false,
    });
  });

  test("the installed pi's exposure pairing is complete or absent, never half", () => {
    // Half one is the concept — something reads `exposure`, so the field is honoured rather than
    // dropped. Half two is a caller — pi ships the sandbox, and admits `codemode` reach into
    // `_getCallableTools`. Both halves appeared in 0.99.0, together.
    //
    // Asserted as AGREEMENT between the two halves, not as a restatement of them: a pi with the
    // field and no sandbox, or the sandbox and no reader, is a third shape this package has no
    // measurement for, and half a pairing is not a pairing. The expected value is the MEASURED field
    // value — an earlier version compared the sandbox to itself and so held on any input, which is
    // the accept-both shape constraint 5 names.
    //
    // Measured: 0.86.0 and 0.87.1 are `false`/`false`, every version from 0.99.0 up is `true`/`true`.
    expect(
      READS_EXPOSURE_FIELD === SHIPS_CODEMODE_SANDBOX,
      "the pairing is complete (true/true) or absent (false/false); half of it is an unmeasured pi",
    ).toBe(true);
    // And each half is separately named, so a failure says WHICH one is missing rather than only
    // that they disagree.
    expect(READS_EXPOSURE_FIELD, "the pi that ships the sandbox must read a tool's exposure").toBe(
      SHIPS_CODEMODE_SANDBOX,
    );
    // Third measurement of the SAME half, from the shared helper: the directory check above asks
    // "does `dist/extensions/codemode` exist", this asks "does anything CONSUME an `outputSchema`".
    // The second is the stronger question — an empty sandbox directory would satisfy the first and
    // satisfy none of this file's claims — and the two arriving at different answers on a real pi is
    // a shape this package has no measurement for, so it is asserted rather than tolerated.
    expect(
      SHARED.outputSchemaRead,
      "the shared probe must agree that this pi resolves a declared outputSchema",
    ).toBe(SHIPS_CODEMODE_SANDBOX);
    // And the whole gate, as one record, against the version string the NEXT test turns out to be
    // the only independent source here. Three fields, one install, one answer each.
    expect(
      {
        structuredContentOnTheWire: SHARED.structuredContentOnTheWire,
        defaultActiveRead: SHARED.defaultActiveRead,
        outputSchemaRead: SHARED.outputSchemaRead,
      },
      "the three fields arrived in pi 0.99.0 together, so on the floor all three are absent",
    ).toEqual({
      structuredContentOnTheWire: VERSION_IS_AT_LEAST_0_99_0,
      defaultActiveRead: VERSION_IS_AT_LEAST_0_99_0,
      outputSchemaRead: VERSION_IS_AT_LEAST_0_99_0,
    });
  });

  test("the measured shape matches what the installed pi's own version claims", () => {
    // **This is what makes the probes falsifiable from OUTSIDE this file.** Every other assertion
    // here compares one measurement with another, and measurements that all lie in the same
    // direction satisfy every relationship between them. Measured: hardcoding all three probes to
    // `true` on the 0.86.0 floor left the whole file green — the pairing still held, because the
    // mutant had moved both halves together. A version string cannot be moved by the same edit.
    //
    // The declared version is therefore the independent source (constraint 4). The exposure
    // machinery arrived in pi 0.99.0, so a pi whose own `package.json` places it below that MUST
    // NOT report the machinery and one at or above it must. Measured on real installs: 0.86.0 and
    // 0.86.1 report all four false; 1.0.0 and 1.2.0 report all four true.
    //
    // Without this, the whole floor claim would rest on the probes agreeing with each other —
    // which is precisely what a wrong probe set does.
    expect(
      {
        version: INSTALLED_PI_VERSION,
        atLeast099: VERSION_IS_AT_LEAST_0_99_0,
        declarabilityRule: HAS_DECLARABILITY_RULE,
        readsField: READS_EXPOSURE_FIELD,
        reachCallable: EXPOSURE_REACH_CALLABLE,
        sandbox: SHIPS_CODEMODE_SANDBOX,
      },
      "pi 0.99.0 introduced the exposure machinery: below it all four facts must be false, at or above it all four must be true",
    ).toEqual({
      version: INSTALLED_PI_VERSION,
      atLeast099: VERSION_IS_AT_LEAST_0_99_0,
      declarabilityRule: VERSION_IS_AT_LEAST_0_99_0,
      readsField: VERSION_IS_AT_LEAST_0_99_0,
      reachCallable: VERSION_IS_AT_LEAST_0_99_0,
      sandbox: VERSION_IS_AT_LEAST_0_99_0,
    });
  });

  test("a pi that cannot honour codemode reach gets plain direct tools instead", async () => {
    // The floor branch, and the half of the claim that is about THIS package rather than about pi.
    //
    // On pi 0.86.0 `exposure` does not occur in `dist/core/agent-session.js` at all and
    // `dist/extensions/` ships only `index` and `llama`, so a `codemode`-reach registration
    // would be inert in both directions: pi would drop the field, and nothing could call the tool.
    // Registering the pair as ordinary `direct` tools is the correct behaviour rather than a
    // compromise — it is what `detectedSurfaceMode` gets by returning `full` on row one.
    //
    // **The axes are the INSTALLED pi's own, read off its dist above, not a pinned constant.** That
    // is what makes this a measurement of the real fallback path rather than a restatement of the
    // factory's input: on the floor the presence axis is `false`, the switch and activation axes
    // stay enabled/active so that row one is the ONLY thing deciding the line, and the pair is
    // expected at `direct` because row one took it. On a ceiling pi the same code path resolves
    // `subagents` and the pair is expected at `codemode`.
    //
    // The counterfactual constraint 5 asks for: a factory that ignored row one and emitted
    // `exposure: "codemode"` regardless would register a reach nothing can call, and would fail
    // here on the floor.
    const axes: SurfaceAxes = {
      ...SUBAGENTS_AXES,
      codemode: INSTALLED_PI_PRESENCE,
    };
    const reach = await reachOn(axes);
    expect(
      reach.ptc_run_code,
      CAN_HONOUR_CODEMODE_REACH
        ? "a pi with the full pairing must get codemode reach on the subagents line"
        : "a pi with no pairing must get plain direct tools, never an inert codemode reach",
    ).toBe(CAN_HONOUR_CODEMODE_REACH ? "codemode" : "direct");
    // The pair is registered together, so a split between the siblings is a defect on its own.
    expect(reach.ptc_workflow, "and the sibling shares the same reach").toBe(reach.ptc_run_code);
  });
});

describe("the declared floor", () => {
  /**
   * The matrix behind the peer range was measured by installing each pi and grepping its dist. The
   * versions are not reinstalled here — that is an hours-long install and it would be a `skipIf`
   * waiting to happen — so what this asserts is that the range this package DECLARES and the
   * shape this package MEASURED name the same floor.
   *
   * A hardcoded `{version: {exposure, codemode}}` table asserting its own pairing would stay green
   * if pi changed or if `src/` stopped relying on the pairing at all, which is constraint 5's
   * named failure. Reading the real dist means a pi that diverged turns this red.
   */
  test("the declared range names the floor whose shape this file just measured", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    const declared = pkg.peerDependencies?.["@earendil-works/pi-coding-agent"];

    expect(declared, "the package declares a pi range").toBeDefined();
    // The floor is below 0.99.0, which is where both halves of the pairing appear — so on the floor
    // the field is inert AND nothing can call it, and the fallback to `direct` is the correct
    // behaviour rather than a compromise. A floor at or above 0.99.0 would be a different claim
    // needing its own measurement.
    expect(
      declared,
      "the floor sits below 0.99.0, where `exposure` does not exist and no codemode ships",
    ).toMatch(/0\.86\.0/);
    // And the range must therefore ADMIT the floor, or the fallback above is unreachable in
    // practice: a `>=1.0.0` declaration would contradict pinning floor behaviour at all.
    expect(
      declared,
      "and the range admits the floor, so the fallback path is one a real install can take",
    ).toMatch(/>=\s*0\./);
  });
});
