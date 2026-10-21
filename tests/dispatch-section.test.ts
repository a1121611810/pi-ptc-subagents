/**
 * The dispatch section: how to reach a child agent, on each surface.
 *
 * The defect this exists for was measured, not imagined. On the `codemode_ptc` surface the pair that
 * carries the calling convention (`ptc_run_code` / `ptc_workflow`) is registered at `codemode`
 * reach, so pi does not declare it to the model — and pi's prompt builder collects a tool's
 * guidelines from the DECLARED tools only. A parent on that surface therefore had no way to learn
 * that a `codemode` script's tool table has no `pi.dispatch` in it: it wrote
 * `await tools["pi.dispatch"]({ task })` into a script and got
 * `TypeError: tools.pi.dispatch does not exist`, three times over, before falling back to
 * `ptc_subagent`.
 *
 * A system-prompt section does not have that dependency: pi merges custom sections into the
 * prompt unconditionally, so the text reaches the model on every surface and in every run mode.
 */
import { expect, test } from "vitest";

import {
  buildDispatchSection,
  DISPATCH_SECTION_NAME,
  PTC_CHILD_SEARCH_SECTION_LINE,
  PTC_DISPATCH_DISABLED_SECTION_LINE,
} from "../src/mode/dispatch-section.ts";

test("each surface says how to dispatch THERE, in the call form that surface has", () => {
  // The `full_ptc` surface offers the program tools to the model directly, so the calling convention
  // it needs is the one inside a program.
  const full = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(full).toContain("ptc_run_code");
  expect(full).toContain('await tools["pi.dispatch"]({ task })');

  // The `codemode_ptc` surface offers `ptc_subagent` to the model, and the binding is NOT in a
  // `codemode` script's tool table. That sentence is the whole point of the section: without it
  // the model reaches for the binding and gets a TypeError.
  const subagents = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(subagents).toContain("ptc_subagent");
  expect(subagents).toContain("codemode");
  expect(subagents).toContain("does not contain `pi.dispatch`");
});

test("the subagents section does not send the parent to the program tools", () => {
  // The two surfaces are not interchangeable: on `codemode_ptc` the program tools are NOT
  // model-facing, so telling the model to write a program is the same error in a different shape.
  const subagents = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(subagents).not.toContain("ptc_run_code");
  expect(subagents).not.toContain("ptc_workflow");
});

test("the search sentence is shared by both surfaces, so it cannot drift between them", () => {
  // One sentence in one place — the same rule the binding contract follows for the sentence it
  // puts in both descriptions. The assertion is on the CONSTANT, so a copy of it in either
  // surface's text turns red.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    const section = buildDispatchSection({
      surfaceMode,
      childCanSearch: true,
      dispatchEnabled: true,
    });
    expect(section).toContain(PTC_CHILD_SEARCH_SECTION_LINE);
  }
});

test("the search sentence is absent when the search module is off", () => {
  // The claim is about a capability that only exists when the operator turned it on. Saying it
  // otherwise sends a parent looking for a tool the child does not have.
  const section = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(section).not.toContain("web_ds_search");
  expect(section).not.toContain(PTC_CHILD_SEARCH_SECTION_LINE);
});

test("the section name is one pi will accept, and it is not one of pi's own", () => {
  // pi validates section names against a lowercase pattern and refuses `preamble`; a name it
  // rejects throws while the prompt is being built, which would take the whole session down.
  expect(DISPATCH_SECTION_NAME).toMatch(/^[a-z][a-z0-9_-]*$/);
  expect(DISPATCH_SECTION_NAME).not.toBe("preamble");
  for (const piSection of ["tools", "rules", "docs", "skills", "cwd"]) {
    expect(DISPATCH_SECTION_NAME).not.toBe(piSection);
  }
});

test("a session that may not start a child is told so, and NOT how to dispatch", () => {
  // ADR-0050: when PTC is off, handing the model the calling convention is handing it an
  // instruction it cannot follow — the call it makes next would be refused. It gets the one fact
  // that matters instead, and the search sentence is withheld with it: "dispatch a child and let
  // it search" is exactly the thing that cannot happen right now.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    const section = buildDispatchSection({
      surfaceMode,
      childCanSearch: true,
      dispatchEnabled: false,
    });
    expect(section).toContain(PTC_DISPATCH_DISABLED_SECTION_LINE);
    expect(section).not.toContain("ptc_subagent");
    expect(section).not.toContain("ptc_run_code");
    expect(section).not.toContain(PTC_CHILD_SEARCH_SECTION_LINE);
  }
});

test('the section never says "sandbox"', () => {
  // This package has no OS sandbox (ADR-0007), and the wording is model-facing: a model that
  // reads "sandbox" may believe it is contained when it is not.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    for (const childCanSearch of [true, false]) {
      expect(
        buildDispatchSection({ surfaceMode, childCanSearch, dispatchEnabled: true }),
      ).not.toMatch(/sandbox/i);
    }
  }
});
