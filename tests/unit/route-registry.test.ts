/**
 * The route registry: the ONE home for the model-facing prose (ticket #243).
 *
 * ## What this file guards
 *
 * The registry exists because a sentence that two surfaces need, written
 * twice, drifts. The inventory that motivated it found three such pairs
 * already drifting in this package. So this file pins the registry's own
 * BEHAVIOUR — the order of a description, the way an unfilled slot is
 * expressed, the roster's place in it.
 *
 * **The eight mechanical forcing points live in one place, and it is not
 * here.** They are in `tests/unit/route-forcing-points.test.ts` (ticket
 * #247), which reads as the eight rules: the coverage both ways, the budget,
 * the per-surface answers, the non-empty facts, the one-home property, the
 * packaged pointer, and the byte-identical index. The tests that used to
 * carry some of those rules here moved into that file rather than being
 * written twice — a rule with two versions is a rule with no version.
 *
 * ## The expectations come from where
 *
 * The expected values are the registry's own entries and the tool definitions
 * the factories build — two different code paths. The comparison is between
 * what the TOOL renders and what the REGISTRY says, so neither side can be
 * wrong alone.
 */
import { describe, expect, test } from "vitest";
import {
  renderDescription,
  ROUTES,
  TOOLS,
  type ToolEntry,
  type ToolName,
} from "../../src/routes/registry.ts";
import { BINDING_CONTRACT } from "../../src/tools/binding-contract.ts";
import { blocks, buildTools, ownParagraphs, type ToolProse } from "../helpers/route-prose.ts";

describe("the route registry holds the model-facing prose", () => {
  test("the registry's paragraphs are in the order the model reads them", async () => {
    // The order is part of the prose: the binding contract sits between "how
    // to call" and "what comes back", and a description whose paragraphs were
    // reordered reads differently.
    //
    // Counterfactual: swap two paragraphs in the registry — the indices stop
    // increasing and this goes red.
    const built = await buildTools();
    for (const [name, entry] of Object.entries(TOOLS) as [ToolName, ToolEntry][]) {
      const description = (built.prose.get(name) as ToolProse).description;
      let previous = -1;
      for (const paragraph of ownParagraphs(entry)) {
        const at = description.indexOf(paragraph, previous + 1);
        expect(at, `${name} keeps the registry's paragraph order`).toBeGreaterThan(previous);
        previous = at;
      }
    }
  });

  test("no description says sandbox", () => {
    // ADR-0007: this package ships no OS sandbox. A description that says
    // "sandbox" would promise a boundary that is not here — pi's `codemode`
    // sandbox is the host's, and the word for it is "`codemode` script".
    //
    // Counterfactual: write "the sandbox" into a description — this goes red.
    for (const entry of Object.values(TOOLS)) {
      for (const paragraph of ownParagraphs(entry)) {
        expect(paragraph, "a description never says sandbox").not.toMatch(/sandbox/i);
      }
      expect(entry.snippet, "a snippet never says sandbox").not.toMatch(/sandbox/i);
      for (const guideline of entry.guidelines) {
        expect(guideline, "a guideline never says sandbox").not.toMatch(/sandbox/i);
      }
    }
  });

  test("the registry renders a description from its paragraphs, and drops an unfilled slot", () => {
    // The division of labour the registry exists for: the registry owns the
    // ORDER and the TEXT, and a caller says which paragraphs this session
    // has. A slot with no entry is left out — "this session has no web tool"
    // is the absence of the sentence, not a sentence saying so.
    //
    // Counterfactual: a renderer that keeps an unfilled slot (as an empty
    // string) would leave a blank line in the middle of the description — the
    // block count goes up and this goes red.
    const entry = TOOLS.ptc_run_code;
    const base = renderDescription(entry, { bindingContract: BINDING_CONTRACT });
    const withNote = renderDescription(entry, {
      bindingContract: BINDING_CONTRACT,
      childSearchNote: "a note the session filled in",
    });
    expect(blocks(withNote).length, "the filled slot adds one block").toBe(blocks(base).length + 1);
    expect(withNote.endsWith("a note the session filled in"), "the note is the last block").toBe(
      true,
    );
    expect(base.includes("a note the session filled in"), "the unfilled slot carries nothing").toBe(
      false,
    );
  });

  test("the codemode door's roster is the session's own, appended after the registry's prose", async () => {
    // The roster is the one slot whose text is NOT in the registry: it is
    // rendered from the live agent files, so it is a fact about this install
    // rather than about the tool. The registry's static prose still comes
    // first, and the roster still reaches the model.
    //
    // Counterfactual: a registry entry that swallowed the roster (or the tool
    // that dropped it) changes the block count, and this goes red.
    const built = await buildTools();
    const description = (built.prose.get("pi_task_codemode") as ToolProse).description;
    const base = renderDescription(TOOLS.pi_task_codemode);
    expect(description.startsWith(base), "the registry's prose leads").toBe(true);
    const roster = (built.filled.get("pi_task_codemode") ?? {})["agentRoster"];
    expect(roster, "the roster was filled for this session").toBeDefined();
    expect(
      description.endsWith(roster as string),
      "the roster is the session's own last block",
    ).toBe(true);
  });

  test("the ROUTES zone is an array of roads, and the registry owns both zones", () => {
    // The zone and its type are ticket #243's; the entries are #246's, and
    // the eight forcing points (ticket #247) are what keep them honest. What
    // is left here is the shape of the two zones themselves.
    expect(Array.isArray(ROUTES), "the routes zone is an array").toBe(true);
    expect(Object.keys(TOOLS).length, "the tools zone has entries").toBeGreaterThan(0);
  });
});
