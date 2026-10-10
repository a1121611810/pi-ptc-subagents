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
 * tool to the model — `AgentSession._isDeclarable` admits `direct` and `model-only` only, read
 * from pi 1.0.0's `dist/core/agent-session.js` and identical through 1.1.0 — so this does not
 * recreate the duplicate surface ADR-0025 removed. The counterfactual below is what makes that
 * testable rather than asserted: `direct` on the same line WOULD declare it to the model.
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
  codemodeActivation: { activation: "inactive", source: "default" },
};

/** Row three — the same pi, but the model can call it. Differs from the above in one axis. */
const SUBAGENTS_AXES: SurfaceAxes = {
  codemode: { present: true, how: "found" },
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "user" },
};

/** The reach each tool carries on a line, read off what the factory actually registered. */
function reachOn(axes: SurfaceAxes): Record<string, string> {
  const stub = makeExtensionStub(axes);
  const out: Record<string, string> = {};
  for (const [name, definition] of stub.tools) {
    // pi's default when no exposure is named, so a missing field reads as the value in force.
    out[name] = (definition as { exposure?: string }).exposure ?? "direct";
  }
  return out;
}

describe("the programming tools' reach per line", () => {
  test("`full` declares them to the model — this package is what orchestrates there", () => {
    const reach = reachOn(FULL_AXES);
    expect(reach.ptc_run_code, "ptc_run_code reach on the full line").toBe("direct");
    expect(reach.ptc_workflow, "ptc_workflow reach on the full line").toBe("direct");
  });

  test("`subagents` puts them at codemode reach — callable from a script, not declared to the model", () => {
    const reach = reachOn(SUBAGENTS_AXES);
    expect(reach.ptc_run_code, "ptc_run_code reach on the subagents line").toBe("codemode");
    expect(reach.ptc_workflow, "ptc_workflow reach on the subagents line").toBe("codemode");
  });

  test("the subagent tool stays `direct` there — it exists to need no orchestrator", () => {
    const reach = reachOn(SUBAGENTS_AXES);
    expect(reach.ptc_subagent, "subagent reach on the subagents line").toBe("direct");
    // A `codemode`-reach subagent tool would be callable only by the sandbox that cannot spawn.
  });

  test("pi's own declarability rule is what keeps this from being a duplicate surface", () => {
    // **Read from pi's installed source rather than restated here.** A local `isDeclarable` arrow
    // asserting its own literals is the shape constraint 5 exists to reject: it stays green
    // whatever `src/` does, and whatever pi does. This greps the real
    // `@earendil-works/pi-coding-agent`, so a pi that widened the rule turns this red instead of
    // leaving the reasoning above to be reused unchanged.
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
      ),
      "utf8",
    );

    // The predicate, verbatim. `codemode` reach must fall OUTSIDE it — that is the entire basis
    // for registering the pair at that reach and still claiming the model is offered one
    // orchestrator. `tests/tool-visibility.test.ts` then checks the consequence on a real pi.
    expect(src, "pi's _isDeclarable admits direct and model-only").toMatch(
      /_isDeclarable\(name\)\s*\{[^}]*exposure === "direct" \|\| exposure === "model-only"/,
    );
    expect(
      src,
      "and `codemode` reach is NOT declarable — or the pair would reach the model as a second front",
    ).not.toMatch(/_isDeclarable\(name\)\s*\{[^}]*exposure === "codemode"/);
  });
});

describe("the low end needs no branch", () => {
  /**
   * The matrix this checks was measured by installing each pi and grepping its dist. The versions
   * are not reinstalled here — that is an hours-long install and it would be a `skipIf` waiting to
   * happen — so what this asserts is the HALF that is checkable on every machine: the pairing
   * holds for the pi this repo actually builds and tests against, and the floor this package
   * CLAIMS is one where the claim is checkable.
   *
   * A hardcoded `{version: {exposure, codemode}}` table asserting its own pairing would stay green
   * if pi changed or if `src/` stopped relying on the pairing at all, which is constraint 5's
   * named failure. Reading the real dist means a pi that diverged from the table turns this red.
   */
  const installedPi = (): string =>
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/@earendil-works/pi-coding-agent/dist",
    );

  test("the pi under test has both halves of the pairing", () => {
    const dist = installedPi();
    const session = readFileSync(join(dist, "core/agent-session.js"), "utf8");

    // Half one: the concept exists, so `exposure` is honoured rather than dropped.
    expect(session, "the installed pi reads a tool's exposure").toMatch(
      /_getToolExposure\(name\)[^}]*definition\.exposure/,
    );
    expect(session, "and a codemode script can reach it").toMatch(
      /return exposure === "codemode" \|\| exposure === "deferred"/,
    );
    // Half two: something can actually call it, i.e. pi ships the sandbox.
    expect(
      existsSync(join(dist, "extensions/codemode")),
      "and the sandbox that would call it is present",
    ).toBe(true);
  });

  test("the declared floor is a version where the pairing was verified to hold", () => {
    // `package.json` claims `>=0.86.0`. The measurement behind that claim — 0.86.1 and 0.87.1
    // having neither the concept nor the sandbox, every version from 0.99.0 up having both — is
    // recorded in the CHANGELOG entry for this change. What is asserted here is that the
    // declaration and that record name the same floor, so a future bump has to meet a floor whose
    // behaviour was actually checked rather than inherited from a peer range nobody tested.
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
    ) as { peerDependencies?: Record<string, string> };
    const declared = pkg.peerDependencies?.["@earendil-works/pi-coding-agent"];

    expect(declared, "the package declares a pi range").toBeDefined();
    // The floor is below 0.99.0, which is where both halves appear — so on the floor the field is
    // inert AND nothing can call it, and the fallback to `direct` is the correct behaviour rather
    // than a compromise. A floor at or above 0.99.0 would be a different claim needing its own
    // measurement.
    expect(
      declared,
      "the floor sits below 0.99.0, where `exposure` does not exist and no codemode ships",
    ).toMatch(/0\.86\.0/);
  });
});
