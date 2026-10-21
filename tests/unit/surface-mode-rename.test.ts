/**
 * ADR-0051: the surface values are renamed, and the rename IS the new definition.
 *
 * Before this record the surface was `full` / `subagents`. That pair named the INVENTORY — which
 * tools this package registers — and an inventory is not the question the model faces. `full` also
 * read as "everything is available", which was false: on that surface the PTC pair IS registered
 * and is NOT model-facing, so the name promised something the surface did not deliver.
 *
 * The new pair names the ORCHESTRATOR that is responsible to the model: `full_ptc` (this
 * package's own PTC) and `codemode_ptc` (pi's `codemode`). The detection is unchanged — the same
 * pi still lands on the same surface; only the NAME of that surface changed.
 *
 * What this file pins, and why each piece is here rather than folded into an existing file:
 *
 * 1. **The declaration point.** `SURFACE_MODES` is the one place the pair is written down, so a
 *    test on it is a test on the type itself: the old names cannot survive as a second spelling
 *    of the same two surfaces without this turning red.
 * 2. **The decision.** Over every combination of the three probe answers, the decision must answer
 *    with a DECLARED surface and never with one of the old names — that is "the same pi still
 *    gets the same surface" plus "no alias", in one place.
 * 3. **The `<ptc>` section.** It selects what the model reads BY surface, so it has to branch on
 *    the new values: the program form under `full_ptc`, the top-level face under `codemode_ptc`.
 * 4. **The startup notices.** A notice is the only channel a `--print` user has (ADR-0025's known
 *    limitation), so a notice that still says "subagents" tells a user about a surface that no
 *    longer exists.
 * 5. **The source.** The last clause of the acceptance criterion: NO place may still branch on
 *    the old value. A behavioural test cannot see a branch that happens to be unreachable, so this
 *    one is a scan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { buildDispatchSection } from "../../src/mode/dispatch-section.ts";
import {
  FALLBACK_SURFACE_MODE,
  SURFACE_MODES,
  detectedSurfaceMode,
  type CodemodePresence,
  type SurfaceMode,
} from "../../src/mode/ptc-mode.ts";
import { makeExtensionStub } from "../helpers/ptc.ts";

/** The two old names, as a list, so an assertion can reject both in one call. */
const OLD_SURFACE_VALUES: readonly string[] = ["full", "subagents"];

/**
 * The codemode probe's two answers. `found` and `not-found` are the two shapes ADR-0026's table
 * is written in; the other two `how` values are probe failures that resolve the same way.
 */
const PRESENT: CodemodePresence = { present: true, how: "found" };
const ABSENT: CodemodePresence = { present: false, how: "not-found" };

/**
 * The two surface values, as the ticket words them: "`full_ptc` and `codemode_ptc`".
 *
 * The expected value is the acceptance criterion itself, not a value read back out of the
 * implementation — a test that asserted `SURFACE_MODES` against itself would pass for any pair at
 * all. The ORDER is the criterion's order too.
 */
const RENAMED_SURFACE_VALUES: readonly string[] = ["full_ptc", "codemode_ptc"];

test("the surface type is the renamed pair, and neither old name is left as an alias", () => {
  // The declaration point: one place, both values, exactly.
  expect([...SURFACE_MODES]).toEqual(RENAMED_SURFACE_VALUES);
  // "No alias" stated as its own assertion, because the list above would also be satisfied by a
  // pair that KEPT the old names alongside the new ones. A third entry named `full` would be
  // exactly the alias the criterion forbids, and this is the assertion that catches it.
  expect(SURFACE_MODES).not.toContain("full");
  expect(SURFACE_MODES).not.toContain("subagents");
});

test("the fallback is the package's own PTC orchestrator", () => {
  // ADR-0026 decision 3: every way the probe can come back wrong resolves to the package's own
  // orchestration. Renamed by ADR-0051, the DIRECTION is what this pins: the fallback must not
  // become `codemode_ptc`, which would silently take away the orchestration tool a session was
  // relying on.
  expect(FALLBACK_SURFACE_MODE).toBe("full_ptc");
});

test("the decision answers with a declared surface on every input, and never with an old name", () => {
  // The three questions are unchanged (ADR-0026 / ADR-0027 / ADR-0029): all twelve combinations
  // of their answers are walked here, so a change to WHICH input selects which surface turns red
  // and only the NAME of the answer is allowed to have moved.
  for (const presence of [PRESENT, ABSENT]) {
    for (const switchState of ["absent", "enabled", "disabled"] as const) {
      for (const activation of ["active", "inactive"] as const) {
        const label = `${presence.how}/${switchState}/${activation}`;
        const got = detectedSurfaceMode(presence, switchState, activation);
        // Never an old name: the alias case, on the seam that produces the value.
        expect(OLD_SURFACE_VALUES, label).not.toContain(got);
        // Always a DECLARED one: the totality the decision has always had, asserted against the
        // declaration point rather than against a second copy of the list.
        expect(SURFACE_MODES.includes(got), `${label} => ${got}`).toBe(true);
      }
    }
  }
});

test("the `<ptc>` section selects what the model reads by the NEW value", () => {
  // `full_ptc`: the model writes a program, and the parallel binding lives inside that program.
  const full = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(full).toContain("ptc_run_code");
  expect(full).toContain('await tools["pi.dispatch"]({ task })');

  // `codemode_ptc`: the model calls the top-level face, and the binding is NOT in a `codemode`
  // script's tool table. That sentence is the whole point of the section.
  const codemode = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(codemode).toContain("ptc_subagent");
  expect(codemode).toContain("does not contain `pi.dispatch`");
});

test("the startup notice about a missing orchestrator names the new surface value", async () => {
  // ADR-0025 decision 4: a session whose surface is `codemode_ptc` but which has no `codemode`
  // active is holding a subagent tool and no way to compose anything. The notice is the fix, and
  // it names the surface the user is ON.
  const stub = await makeExtensionStub({
    codemode: PRESENT,
    codemodeSwitch: { switch: "enabled", source: "user" },
    codemodeActivation: { activation: "active", source: "loadout" },
    // The `codemode_ptc` shape: the program pair is at `codemode` reach, so the model is not
    // offered it, and `codemode` itself is not in the loadout either.
    declaredProgrammingTools: [],
  });
  const notice = stub.notifications.find((n) => n.message.includes("the detected surface is"));
  expect(notice, "the session is told which surface it got").toBeDefined();
  expect(notice?.message).toContain("the detected surface is codemode_ptc");
  expect(notice?.message).not.toContain("the detected surface is subagents");
});

/**
 * The source scan: the old values must not survive anywhere in the files that decide the surface.
 *
 * A behavioural test cannot see a branch that happens to be unreachable, and the acceptance
 * criterion says more than "the reachable behaviour changed" — it says no place may still judge
 * by the old value. So this reads the three files that own the decision, the registration branch
 * and the `<ptc>` section, and rejects the old names as standalone words.
 *
 * Two details that make it a real check rather than a rubber stamp:
 *
 * - **The package's own name is blanked first.** Every notice is prefixed `pi-ptc-subagents:`,
 *   and that is a package name, not a surface value. Blanking it is what lets the scan say
 *   "subagents" at all.
 * - **Comments are included.** The criterion covers the prose too: a comment that still says
 *   `full` describes a surface that no longer exists.
 *
 * Known limitation, stated rather than hidden: the scan is limited to the three files this
 * change owns. `src/tools/**` and `src/runtime/**` carry mentions of the old names in comments
 * only, and they belong to other tickets.
 */
const SURFACE_FILES: readonly string[] = [
  join(import.meta.dirname, "..", "..", "src", "mode", "ptc-mode.ts"),
  join(import.meta.dirname, "..", "..", "src", "mode", "dispatch-section.ts"),
  join(import.meta.dirname, "..", "..", "src", "index.ts"),
];

test("no file that decides the surface still mentions the old values", () => {
  for (const file of SURFACE_FILES) {
    const text = readFileSync(file, "utf8").replaceAll("pi-ptc-subagents", "pi-ptc-<package>");
    for (const old of OLD_SURFACE_VALUES) {
      const pattern = new RegExp(`\\b${old}\\b`);
      expect(pattern.test(text), `${file} still mentions the old value "${old}"`).toBe(false);
    }
  }
});

/**
 * The registration branch, on the new values: the program pair is offered to the model under
 * `full_ptc` and held at `codemode` reach under `codemode_ptc`.
 *
 * This is the branch the criterion calls "the registration branch", and it is the one place a
 * rename could leave the tools registered but the surface the model is told about wrong.
 */
test("the registration branch keys off the new value", async () => {
  const full = await makeExtensionStub({ codemode: ABSENT });
  const pair = full.tools.get("ptc_run_code") as { exposure?: string } | undefined;
  expect(pair?.exposure ?? "direct", "the program pair is model-facing under full_ptc").toBe(
    "direct",
  );
  expect(full.tools.has("ptc_subagent"), "no top-level face under full_ptc").toBe(false);

  const codemode = await makeExtensionStub({
    codemode: PRESENT,
    codemodeSwitch: { switch: "enabled", source: "user" },
    codemodeActivation: { activation: "active", source: "loadout" },
    declaredProgrammingTools: [],
  });
  const held = codemode.tools.get("ptc_run_code") as { exposure?: string } | undefined;
  expect(
    held?.exposure ?? "direct",
    "the program pair is at codemode reach under codemode_ptc",
  ).toBe("codemode");
  expect(codemode.tools.has("ptc_subagent"), "the top-level face is there under codemode_ptc").toBe(
    true,
  );
});

/**
 * The TYPE refuses the old names — checked by the compiler, not by vitest.
 *
 * `SurfaceMode` is derived from `SURFACE_MODES`, so pinning the list pins the type by
 * construction, and every runtime assertion above is therefore about the list. What no runtime
 * assertion can reach is the type itself: if `SurfaceMode` ever admits an old name again — an
 * alias, a widened union, a hand-written literal — the two `@ts-expect-error` directives below
 * become UNUSED, and `pnpm run typecheck` fails the build. The directive is the assertion; the
 * body carries the runtime counterpart so the case is not an assertion-free body.
 *
 * The counterfactual: widen the union to `["full_ptc", "codemode_ptc", "full"]` and this file
 * stops compiling — the directive on the `full` line has nothing left to suppress.
 */
test("the surface type does not admit an old name", () => {
  // @ts-expect-error "full" is not a surface value any more
  const legacyFull: SurfaceMode = "full";
  // @ts-expect-error "subagents" is not a surface value any more
  const legacySubagents: SurfaceMode = "subagents";
  // The runtime half: the two rejected literals are still ordinary strings, and neither of them
  // is one of the surfaces this package declares.
  expect([legacyFull, legacySubagents]).not.toContain(SURFACE_MODES[0]);
  expect([legacyFull, legacySubagents]).not.toContain(SURFACE_MODES[1]);
});
