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
  PTC_TRUNCATED_NO_NEW_TASK,
  PTC_TRUNCATION_SECTION_LINES,
} from "../src/mode/dispatch-section.ts";
import { PTC_CHILD_SEARCH_NOTE } from "../src/search/contract.ts";
import { WEB_ROUTE_HOW } from "../src/routes/registry.ts";
import { buildModeInstruction } from "../src/mode/ptc-mode.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import { createPtcWorkflowTool } from "../src/tools/workflow.ts";

test("each surface says how to create a task THERE, in the call form that surface has", () => {
  // The `full_ptc` surface offers the program tools to the model directly, so the calling convention
  // it needs is the one inside a program.
  const full = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(full).toContain("ptc_run_code");
  // ADR-0052: the door is a plain JavaScript identifier, so the program reaches it with a dot.
  expect(full).toContain("await tools.pi_task_ptc({ task })");

  // The `codemode_ptc` surface reaches the codemode door from a `codemode` script, and the PTC door
  // is NOT in a script's tool table. That sentence is the whole point of the section: without it
  // the model reaches for the PTC door and gets a TypeError.
  const codemode = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(codemode).toContain("pi_task_codemode");
  expect(codemode).toContain("codemode");
  expect(codemode).toContain("does not contain `pi_task_ptc`");
});

test("the codemode section does not send the parent to the program tools", () => {
  // The two surfaces are not interchangeable: on `codemode_ptc` the program tools are NOT
  // model-facing, so telling the model to write a program is the same error in a different shape.
  const codemode = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(codemode).not.toContain("ptc_run_code");
  expect(codemode).not.toContain("ptc_workflow");
});

test("the model-facing word is task, never dispatch", () => {
  // ADR-0052: the door creates a task; dispatching is what the task side does with it afterwards,
  // and that is not the model's word. Every surface's text is checked, and so is the shared
  // search sentence and the "PTC is off" line — a copy of the old wording anywhere in the
  // model-facing prose puts the internal word back in front of the model.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    for (const dispatchEnabled of [true, false]) {
      const section = buildDispatchSection({
        surfaceMode,
        childCanSearch: true,
        dispatchEnabled,
      });
      expect(section, `${surfaceMode} (dispatchEnabled=${dispatchEnabled})`).not.toMatch(
        /dispatch/i,
      );
    }
  }
  expect(PTC_CHILD_SEARCH_NOTE, "the shared search sentence").not.toMatch(/dispatch/i);
  expect(PTC_TRUNCATED_NO_NEW_TASK, "the shared truncated sentence").not.toMatch(/dispatch/i);
  for (const line of Object.values(PTC_TRUNCATION_SECTION_LINES)) {
    expect(line, "a per-surface truncated line").not.toMatch(/dispatch/i);
  }
});

test("the web route is one phrase, and the road and the shared sentence are built from it", () => {
  // One sentence in one place — the same rule the binding contract follows for the sentence it
  // puts in both descriptions. The assertion is on the CONSTANT, so a copy of it in either
  // surface's text turns red.
  //
  // ADR-0061: the section is the ROAD INDEX now, and the web road's line carries the route
  // ("create a task and let the child search") while the tool descriptions and the briefing
  // carry the shared sentence. Both are built from the SAME constant, so the two cannot drift
  // into saying different things about how to reach the web.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    const section = buildDispatchSection({
      surfaceMode,
      childCanSearch: true,
      dispatchEnabled: true,
    });
    expect(section, `${surfaceMode} carries the route phrase`).toContain(WEB_ROUTE_HOW);
    expect(PTC_CHILD_SEARCH_NOTE, "the shared sentence carries the same phrase").toContain(
      WEB_ROUTE_HOW,
    );
  }
});

test("the web road is absent when the search module is off", () => {
  // The claim is about a capability that only exists when the operator turned it on. Saying it
  // otherwise sends a parent looking for a tool the child does not have — so the whole ROAD goes,
  // not just the sentence about it.
  const section = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  expect(section).not.toContain("web_ds_search");
  expect(section).not.toContain(PTC_CHILD_SEARCH_NOTE);
  expect(section).not.toContain("Reach the web");
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

test("a truncated session is told the shared fact, and what THIS surface lost", () => {
  // ADR-0058: the two surfaces truncate at different places — on `full_ptc` the whole
  // orchestration layer goes, on `codemode_ptc` only this package's segment under pi's
  // `codemode` does — so the section says different things. The one fact they SHARE is one
  // constant, and the assertion is on that constant, so a reword on one side without the other
  // turns this red.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    const section = buildDispatchSection({
      surfaceMode,
      childCanSearch: true,
      dispatchEnabled: false,
    });
    expect(section, `${surfaceMode} carries the shared sentence`).toContain(
      PTC_TRUNCATED_NO_NEW_TASK,
    );
    expect(section, `${surfaceMode} carries its own line`).toContain(
      PTC_TRUNCATION_SECTION_LINES[surfaceMode],
    );
    // The calling convention is NOT given: a model cannot create a task here, and handing it
    // the call form is handing it an instruction it cannot follow (ADR-0050 decision 6).
    // The check is on the CALL FORM, not on the name: ADR-0058 wants the withdrawn doors NAMED
    // ("a model that saw them a turn ago needs to know they are gone"), so a name-absence
    // assertion would turn red on a correct rewording. These are the same three shapes the
    // end-to-end script looks for (scripts/verify-ptc-off-e2e.ts).
    const callingConvention: readonly RegExp[] = [
      /\bpi_task_codemode\s*\(/,
      /\bpi_task_ptc\s*\(/,
      /\btools\s*(?:\.|\[)\s*["'`]?\s*pi_task_/,
    ];
    for (const pattern of callingConvention) {
      expect(section, `${surfaceMode} gives no call form (${pattern})`).not.toMatch(pattern);
    }
    // And the search sentence goes with it: "create a task and let the child search" is exactly
    // the thing that cannot happen right now.
    expect(section, `${surfaceMode} withholds the search sentence`).not.toContain(
      PTC_CHILD_SEARCH_NOTE,
    );
  }
});

test("the two surfaces say different things about what was lost, and the difference is the point", () => {
  // ADR-0058: the reason the two surfaces truncate at different places is that pi's `codemode`
  // is not this package's to withdraw. A section that said the same thing on both would be
  // claiming the model lost its orchestrator on `codemode_ptc` too — which is false.
  const full = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: false,
  });
  const codemode = buildDispatchSection({
    surfaceMode: "codemode_ptc",
    childCanSearch: false,
    dispatchEnabled: false,
  });
  expect(full, "full_ptc has no orchestrator left").toContain("no orchestrator left");
  expect(codemode, "codemode_ptc keeps its orchestrator").toContain(
    "`codemode` still orchestrates",
  );
  expect(full, "and the two lines are not the same line").not.toBe(codemode);
});

test('the section never says "sandbox"', () => {
  // This package has no OS sandbox (ADR-0007), and the wording is model-facing: a model that
  // reads "sandbox" may believe it is contained when it is not.
  for (const surfaceMode of ["full_ptc", "codemode_ptc"] as const) {
    for (const childCanSearch of [true, false]) {
      for (const dispatchEnabled of [true, false]) {
        expect(buildDispatchSection({ surfaceMode, childCanSearch, dispatchEnabled })).not.toMatch(
          /sandbox/i,
        );
      }
    }
  }
});

/**
 * ADR-0052: the web fact is ONE sentence on THREE model-facing surfaces.
 *
 * The parent's model reads this fact in three places when it decides what to write: the two PTC
 * tool descriptions, the `<ptc>` section, and the mode briefing. They used to be three
 * wordings — the section's had been rewritten to the task vocabulary while the briefing's had
 * not, and the two tool descriptions carried a third copy — and the word that drifted was the
 * one the model must not read: "dispatch" for the thing the model calls a task.
 *
 * The assertion is on the CONSTANT, so a copy on any surface turns red.
 */
test("the two tool descriptions and the briefing all carry the same constant", () => {
  const runCode = createPtcRunCodeTool({ childCanSearch: true });
  const workflow = createPtcWorkflowTool({ childCanSearch: true });
  const briefing = buildModeInstruction(["read"], "builtins-only", { childCanSearch: true });

  expect(runCode.description, "ptc_run_code carries the shared sentence").toContain(
    PTC_CHILD_SEARCH_NOTE,
  );
  expect(workflow.description, "ptc_workflow carries the shared sentence").toContain(
    PTC_CHILD_SEARCH_NOTE,
  );
  expect(briefing, "the briefing carries the shared sentence").toContain(PTC_CHILD_SEARCH_NOTE);
});

test("the shared sentence is in the task vocabulary, and never says dispatch", () => {
  // ADR-0052: the model-facing word is TASK. "Dispatch" is what the task side does with a task
  // afterwards, and it is not the model's word.
  expect(PTC_CHILD_SEARCH_NOTE, "the sentence never says dispatch").not.toMatch(/dispatch/i);
  expect(PTC_CHILD_SEARCH_NOTE, "it says what to create").toContain("create a task");
  expect(PTC_CHILD_SEARCH_NOTE, "it says who searches").toContain("let the child search");
});

test("the search module is off and the sentence is nowhere", () => {
  // The claim is about a capability that only exists when the operator turned it on, so it is
  // withheld everywhere it is not true — not just in the section.
  const runCode = createPtcRunCodeTool({ childCanSearch: false });
  const section = buildDispatchSection({
    surfaceMode: "full_ptc",
    childCanSearch: false,
    dispatchEnabled: true,
  });
  const briefing = buildModeInstruction(["read"], "builtins-only", { childCanSearch: false });
  expect(runCode.description).not.toContain(PTC_CHILD_SEARCH_NOTE);
  expect(section).not.toContain(PTC_CHILD_SEARCH_NOTE);
  expect(briefing).not.toContain(PTC_CHILD_SEARCH_NOTE);
});
