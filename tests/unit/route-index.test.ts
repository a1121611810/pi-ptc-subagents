/**
 * The resident route index: the road table the model reads every turn (ticket #246).
 *
 * ## What this file guards
 *
 * The index is the ONE piece of model-facing prose this package rebuilds on every turn, and it
 * has four properties that are each worth a red test:
 *
 * 1. **One line per road, and the details never in it.** The index is an index: a hook, the way
 *    to take the road on this surface, and a pointer to the file with the whole story. A road's
 *    `fact` belongs in that file, not in the line the model reads every turn.
 * 2. **Every road is answered on every surface** (spec #234 decision 10, forcing point 3). "Not
 *    applicable here" is an answer; a missing key is a hole.
 * 3. **Every road carries a fact** (forcing point 5). A road that is only a "when to use it" is
 *    prose, not a route.
 * 4. **It is byte-identical from turn to turn** (forcing point 8). The index is rebuilt on every
 *    model request, and a system prompt that changes mid-session invalidates the cached prefix —
 *    so nothing that varies inside a session may enter it.
 *
 * Plus the budget: the index has a ceiling and a floor of its own (the binding contract's are a
 * different question), and an index over its ceiling SAYS SO rather than dropping a road.
 *
 * ## Where the expectations come from
 *
 * The expected values are the registry's own entries and the files in the repository — two
 * different places. The route texts come from `ROUTES`; the "the pointer resolves" expectation
 * comes from the file system itself; the token estimate is the same characters-per-token rule the
 * binding contract's budget uses, reproduced here rather than imported, so the guard does not
 * depend on the module under test agreeing with itself about how to count.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  renderRouteIndex,
  renderToolRouteHint,
  ROUTES,
  ROUTE_INDEX_OVER_BUDGET_WARNING,
  ROUTE_INDEX_TOKEN_CEILING,
  ROUTE_INDEX_TOKEN_FLOOR,
  TOOLS,
  type RouteEntry,
  type RouteToolName,
} from "../../src/routes/registry.ts";
import { buildDispatchSection } from "../../src/mode/dispatch-section.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** The two surfaces, spelled out — the surface decides the road's `how`. */
const SURFACES = ["full_ptc", "codemode_ptc"] as const;

/**
 * pi's own estimator for the upstream declaration renderer, reproduced here rather than
 * imported, so the budget assertion does not depend on the module under test agreeing with
 * itself about how to count. The same rule the binding contract's budget uses.
 */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The index's lines, minus the header and the blank line under it. */
function roadLines(index: string): string[] {
  return index.split("\n").filter((line) => line.startsWith("- "));
}

/**
 * A route set that is deliberately over the ceiling: one road whose text is far longer than any
 * real road's.
 *
 * **The expected value is the ceiling itself**, not the length of this fixture — the fixture only
 * has to be over it, and the assertion says which side of the line it is on.
 */
const OVER_BUDGET_ROUTES: readonly RouteEntry[] = [
  ...ROUTES,
  {
    id: "an-absurdly-long-road",
    name: "An absurdly long road",
    when: "x".repeat(4_000),
    how: { full_ptc: "y".repeat(4_000), codemode_ptc: "y".repeat(4_000) },
    fact: "z".repeat(4_000),
    detail: "docs/routes/an-absurdly-long-road.md",
    tools: [],
  },
];

describe("the route index is one line per road", () => {
  test("every road gets exactly one line, and the details are not in it", () => {
    // The two-layer shape (spec #234 decision 9): the index carries the hook and the pointer, and
    // the road's facts live in the file.
    //
    // Counterfactual: render the `fact` into the line as well — the line count stays the same
    // but the index grows by the facts, and this goes red on the "the fact is not in the index"
    // half. A renderer that emitted two lines for one road goes red on the count.
    for (const surface of SURFACES) {
      const index = renderRouteIndex({ surface, childCanSearch: true });
      const lines = roadLines(index);
      expect(lines.length, "one line per road").toBe(ROUTES.length);
      for (const road of ROUTES) {
        const line = lines.find((candidate) => candidate.includes(road.detail));
        expect(line, `${road.id} has a line`).toBeDefined();
        expect(line, `${road.id}'s line names the road`).toContain(road.name);
        expect(line, `${road.id}'s line carries the hook`).toContain(road.when);
        expect(line, `${road.id}'s line carries the calling convention`).toContain(
          road.how[surface],
        );
        expect(line, `${road.id}'s line does NOT carry the fact`).not.toContain(road.fact);
      }
    }
  });

  test("the pointer on each line resolves to a file in the repository", () => {
    // The pointer is the model's way to the whole story, and the story ships with the package
    // (`package.json`'s `files`). A pointer that names a file nobody wrote is a dangling
    // pointer — the exact defect that shipped `docs/` outside the tarball.
    //
    // Counterfactual: point a road at `docs/routes/nope.md` — the file does not exist and this
    // goes red.
    for (const road of ROUTES) {
      expect(
        existsSync(join(REPO_ROOT, road.detail)),
        `${road.id} points at a file that exists`,
      ).toBe(true);
    }
  });

  test("the detail file carries the road's fact, so the two cannot drift", () => {
    // The fact lives in the registry; the file the pointer names has to carry it, or the model
    // reads a file that says something else. Whitespace-normalised, because the file wraps.
    //
    // Counterfactual: reword the registry's fact — the file no longer carries it, and this goes
    // red.
    const normalize = (text: string): string => text.replace(/\s+/g, " ");
    for (const road of ROUTES) {
      const file = normalize(readFileSync(join(REPO_ROOT, road.detail), "utf8"));
      expect(file, `${road.id}'s detail file carries the fact`).toContain(normalize(road.fact));
    }
  });
});

describe("every road is answered on every surface", () => {
  test("no road leaves a surface unanswered, and no road carries an empty fact", () => {
    // Forcing points 3 and 5 (spec #234 decision 10). A surface with no answer is a hole the
    // model cannot see; a road with no fact is prose.
    //
    // Counterfactual: delete the `codemode_ptc` key of one road's `how` — the "answered on every
    // surface" half goes red. Blank out one road's `fact` — the other half goes red.
    for (const road of ROUTES) {
      expect(road.id, "a road has an id").not.toBe("");
      expect(road.name, `${road.id} has a name`).not.toBe("");
      expect(road.when, `${road.id} says when to take it`).not.toBe("");
      expect(road.fact, `${road.id} carries facts`).not.toBe("");
      expect(road.detail, `${road.id} points at its detail file`).not.toBe("");
      for (const surface of SURFACES) {
        expect(road.how[surface], `${road.id} on ${surface} is answered`).not.toBe("");
      }
    }
  });

  test("the codemode surface does not send the parent to the program tools", () => {
    // Measured 2026-10-20: on `codemode_ptc` the PTC pair is registered at `codemode` reach, so
    // it is NOT declared to the model, and telling the model to write a program is the same
    // error in a different shape.
    //
    // Counterfactual: put `ptc_run_code` back into the codemode `how` of one road — this goes
    // red.
    const codemode = renderRouteIndex({ surface: "codemode_ptc", childCanSearch: true });
    expect(codemode, "the codemode index names no program tool").not.toContain("ptc_run_code");
    expect(codemode, "the codemode index names no workflow tool").not.toContain("ptc_workflow");
  });

  test("every tool the package shows the model is on a road, and every road names a real tool", () => {
    // Forcing points 1 and 2. The road set is the package's coverage claim, and it is checked
    // from both sides because a one-sided check cannot see a road that names nothing.
    //
    // Counterfactual: add a tool to `TOOLS` and no road — the first half goes red. Name a tool
    // that does not exist on a road — the second half goes red.
    const named = new Set(ROUTES.flatMap((road) => road.tools));
    for (const tool of Object.keys(TOOLS)) {
      expect(named.has(tool as never), `${tool} is on a road`).toBe(true);
    }
    for (const road of ROUTES) {
      for (const tool of road.tools) {
        expect(
          tool === "pi_task_ptc" || Object.keys(TOOLS).includes(tool),
          `${road.id} names a tool that exists`,
        ).toBe(true);
      }
    }
  });
});

describe("the index stays inside its budget", () => {
  test("the real index is above the floor and at or below the ceiling, on every surface", () => {
    // The budget is a decision (ADR-0061), and this is the guard that keeps it one: a road
    // added without a thought about its cost shows up here.
    //
    // Counterfactual: add a road with a very long `when` — the ceiling assertion goes red.
    for (const surface of SURFACES) {
      for (const childCanSearch of [true, false]) {
        const index = renderRouteIndex({ surface, childCanSearch });
        const cost = tokens(index);
        expect(
          cost,
          `${surface} (search=${childCanSearch}) is under the ceiling`,
        ).toBeLessThanOrEqual(ROUTE_INDEX_TOKEN_CEILING);
        expect(
          cost,
          `${surface} (search=${childCanSearch}) is over the floor`,
        ).toBeGreaterThanOrEqual(ROUTE_INDEX_TOKEN_FLOOR);
      }
    }
  });

  test("the bounds are the ones the record states", () => {
    // Without this, editing the constant to 5000 keeps the suite green and the record silently
    // stops describing the code — the same hole the binding contract's budget test closes for
    // its own pair.
    //
    // Counterfactual: raise the ceiling (or drop the floor) — this goes red.
    expect(ROUTE_INDEX_TOKEN_CEILING, "ADR-0061's ceiling").toBe(560);
    expect(ROUTE_INDEX_TOKEN_FLOOR, "ADR-0061's floor").toBe(380);
  });

  test("an over-budget index says so, and drops no road", () => {
    // The point of the warning: a road that silently disappeared from the index is a road the
    // model cannot take and cannot tell it is missing.
    //
    // Counterfactual: return the index untruncated and without the warning — this goes red. Drop
    // the last road to fit the budget — this goes red on the road count.
    const index = renderRouteIndex({
      surface: "full_ptc",
      childCanSearch: true,
      routes: OVER_BUDGET_ROUTES,
    });
    expect(index, "the index says it is over budget").toContain(ROUTE_INDEX_OVER_BUDGET_WARNING);
    expect(roadLines(index).length, "no road was dropped").toBe(OVER_BUDGET_ROUTES.length);
  });

  test("the real index does not carry the warning", () => {
    // The other direction: a warning on an index that is inside its budget is noise, and noise
    // in a section the model reads every turn is not free.
    expect(
      renderRouteIndex({ surface: "full_ptc", childCanSearch: true }),
      "a real index is not over budget",
    ).not.toContain(ROUTE_INDEX_OVER_BUDGET_WARNING);
  });
});

describe("the index is byte-identical from turn to turn", () => {
  test("two renders of the same session are the same bytes", () => {
    // Forcing point 8. The index is rebuilt on every model request, and a system prompt that
    // changes mid-session invalidates the cached prefix — so the same session must produce the
    // same bytes, every time.
    //
    // Counterfactual: put something that varies per call into the index (a counter, a clock, a
    // per-turn id) — the two renders differ and this goes red.
    for (const surface of SURFACES) {
      const first = renderRouteIndex({ surface, childCanSearch: true });
      const second = renderRouteIndex({ surface, childCanSearch: true });
      expect(second, `${surface} renders the same bytes`).toBe(first);
    }
  });

  test("the index carries nothing that varies with the session's bindings", () => {
    // The thing that DOES vary inside a session is the binding list: it is the session's, and it
    // is what the session injection is for. The index must not carry it.
    //
    // Counterfactual: render the bound names into the index — this goes red.
    const index = renderRouteIndex({ surface: "full_ptc", childCanSearch: true });
    for (const bound of ["ptcBindings", "tools.grep(args)", "tools.find(args)", "tools.ls(args)"]) {
      expect(index, `the index does not carry ${bound}`).not.toContain(bound);
    }
  });

  test("the section the model reads is the index, and only the index", () => {
    // The `<ptc>` section was UPGRADED in place (spec #234 decision 11): same section, new body.
    // So the section is the index, byte for byte — a section that added a line of its own would
    // be a second source of truth for the road table.
    //
    // Counterfactual: have the section add a header of its own — this goes red.
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

describe("a tool's description gains its road, derived", () => {
  test("the guidelines carry no routing sentence — that half moved to the road table", () => {
    // The guidelines split (spec #234 decision 11): the ROUTING half went into the road table and
    // the FACTUAL half stayed with the tool's `TOOLS` entry. A guideline that still says "use
    // this tool when …" is a second home for a road, and it is the home that drifts.
    //
    // Counterfactual: put a routing sentence back into a tool's guidelines — this goes red.
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
    // The description's "when to use me" is DERIVED from the road table, so the two cannot
    // drift: a road that changes its `when` changes every tool on it at once.
    //
    // Counterfactual: reword a road's `when` — the hint follows it, so the assertion on the
    // hint's content goes red, and the "no literal copy" assertion below stays green because
    // there is no literal to copy.
    const hint = renderToolRouteHint("ptc_run_code");
    const road = ROUTES.find((candidate) => candidate.tools.includes("ptc_run_code"));
    expect(road, "the road exists").toBeDefined();
    expect(hint, "the hint carries the road's words").toContain((road as RouteEntry).when);
    expect(hint, "the hint says when").toMatch(/^Reach for this when /);
  });

  test("a tool no road names gets no hint", () => {
    // An empty hint is not rendered at all — a description paragraph that says "Reach for this
    // when ." is worse than no paragraph.
    //
    // Counterfactual: make the hint fall back to a generic sentence instead of an empty string —
    // this goes red.
    const unused = "ptc_task_handoff" as RouteToolName;
    expect(renderToolRouteHint(unused), "a tool no road names gets nothing").toBe("");
  });
});
