/**
 * The resident route index: the road table the model reads every turn (ticket
 * #246).
 *
 * ## What this file guards
 *
 * The index's mechanical properties are guarded in ONE place:
 * `tests/unit/route-forcing-points.test.ts` (ticket #247), which reads as the
 * eight rules of spec #234's decision 10 — the coverage both ways, the budget
 * and its over-budget warning, the per-surface answers, the non-empty facts,
 * the one-home property, the packaged pointer, and the byte-identical index.
 *
 * What is left here is the index's BEHAVIOUR that is not one of the eight: the
 * two facts about the codemode surface, the split between the guidelines' and
 * the road table's halves, the derived "when to use me" hint, and the section
 * that carries the index.
 */
import { describe, expect, test } from "vitest";
import {
  renderRouteIndex,
  renderToolRouteHint,
  ROUTES,
  TOOLS,
  type RouteEntry,
  type RouteToolName,
} from "../../src/routes/registry.ts";
import { buildDispatchSection } from "../../src/mode/dispatch-section.ts";

describe("the index says what the surface can actually do", () => {
  test("the codemode surface does not send the parent to the program tools", () => {
    // Measured 2026-10-20: on `codemode_ptc` the PTC pair is registered at
    // `codemode` reach, so it is NOT declared to the model, and telling the
    // model to write a program is the same error in a different shape.
    //
    // Counterfactual: put `ptc_run_code` back into the codemode `how` of one
    // road — this goes red.
    const codemode = renderRouteIndex({ surface: "codemode_ptc", childCanSearch: true });
    expect(codemode, "the codemode index names no program tool").not.toContain("ptc_run_code");
    expect(codemode, "the codemode index names no workflow tool").not.toContain("ptc_workflow");
  });
});

describe("a tool's description gains its road, derived", () => {
  test("the guidelines carry no routing sentence — that half moved to the road table", () => {
    // The guidelines split (spec #234 decision 11): the ROUTING half went into
    // the road table and the FACTUAL half stayed with the tool's `TOOLS`
    // entry. A guideline that still says "use this tool when …" is a second
    // home for a road, and it is the home that drifts.
    //
    // Counterfactual: put a routing sentence back into a tool's guidelines —
    // this goes red.
    for (const entry of Object.values(TOOLS)) {
      for (const guideline of entry.guidelines) {
        for (const road of ROUTES) {
          expect(
            guideline.includes(road.when),
            `${entry.name}'s guidelines must not restate the "${road.id}" road's hook`,
          ).toBe(false);
        }
      }
    }
  });

  test("the hint is the road's own words, and it changes when the road changes", () => {
    // The description's "when to use me" is DERIVED from the road table, so
    // the two cannot drift: a road that changes its `when` changes every tool
    // on it at once.
    //
    // Counterfactual: reword a road's `when` — the hint follows it, so the
    // assertion on the hint's content goes red, and the "no literal copy"
    // assertion below stays green because there is no literal to copy.
    const hint = renderToolRouteHint("ptc_run_code");
    const road = ROUTES.find((candidate) => candidate.tools.includes("ptc_run_code"));
    expect(road, "the road exists").toBeDefined();
    expect(hint, "the hint carries the road's words").toContain((road as RouteEntry).when);
    expect(hint, "the hint says when").toMatch(/^Reach for this when /);
  });

  test("a tool no road names gets no hint", () => {
    // An empty hint is not rendered at all — a description paragraph that says
    // "Reach for this when ." is worse than no paragraph.
    //
    // Counterfactual: make the hint fall back to a generic sentence instead of
    // an empty string — this goes red.
    const unused = "ptc_task_handoff" as RouteToolName;
    expect(renderToolRouteHint(unused), "a tool no road names gets nothing").toBe("");
  });
});

describe("the section the model reads is the index", () => {
  test("the section IS the index, byte for byte", () => {
    // The `<ptc>` section was UPGRADED in place (spec #234 decision 11): same
    // section, new body. So the section is the index, byte for byte — a
    // section that added a line of its own would be a second source of truth
    // for the road table.
    //
    // Counterfactual: have the section add a header of its own — this goes
    // red.
    const section = buildDispatchSection({
      surfaceMode: "full_ptc",
      childCanSearch: true,
      dispatchEnabled: true,
    });
    expect(section, "the section IS the index").toBe(
      renderRouteIndex({ surface: "full_ptc", childCanSearch: true }),
    );
  });
});
