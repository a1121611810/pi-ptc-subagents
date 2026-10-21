/**
 * T4 (#181): the tool description says where agent definitions load from.
 *
 * The model that wants to dispatch a subagent cannot learn where agent definitions come from
 * without going to look. In the session where this was measured it spent twenty-plus tool calls
 * inspecting the install and guessing at argument values before abandoning fan-out — every one of
 * those calls spent on something one sentence could have answered.
 *
 * This is the same one-home discipline the child-report work already established, applied to the
 * registry rather than to the report shape: the description SAYS WHERE the definitions live, and
 * the actionable detail of a refusal stays where it already is — at the refusal. Duplicating the
 * refusal text here would create a second copy that can drift from the one a user actually hits.
 */

import { expect, test } from "vitest";
import { createPtcSubagentTool, SUBAGENT_TOOL_NAME } from "../../src/tools/subagent.ts";

function description(): string {
  const tool = createPtcSubagentTool({ cwd: "/repo", depth: 0, maxDispatchDepth: 3 });
  return tool.description;
}

test("the description names both places an agent definition can load from", () => {
  const text = description();

  // Both scopes, because the fix is one of two files in one of two directories. A description
  // naming only the user scope would send a project-scoped user to the wrong place — and the
  // project scope is the one a checked-in definition lives in.
  expect(text, "names the user-scope directory").toContain(".pi/agent/agents");
  expect(text, "names the project-scope directory").toContain(".pi/agents");
});

test("the description says an omitted model inherits the session's current model (ADR-0044)", () => {
  const text = description();
  // ADR-0044 Decision 1's last tier: a dispatch whose call site and agent definition name no model
  // runs the model the CALLER'S SESSION is currently running. A model that never learns this keeps
  // pinning a model it did not need to pin, or assumes a global default it will not get — the same
  // pre-decision problem #181/#185 solved for the agent name.
  expect(text, "names the inherited tier").toMatch(/session's current model/i);
  expect(text, "says the omission is what inherits it").toMatch(/omit[^.]*model[^.]*inherit/i);
  expect(text, "still names the agent definition as an override").toMatch(/agent definition/i);
  // COUNTERFACTUAL: the pre-ADR-0044 description promised the child "its own model", i.e. the
  // opposite claim. Restoring that sentence must turn this pair red.
  expect(text, "does not claim the child gets its own model").not.toMatch(/its own model/i);
  // ADR-0052: the door creates a TASK, and the description opens with that word — "dispatch" is
  // the task side's internal word and the model never reads it.
  expect(text, "still opens with the tool's job").toContain(
    "Create a task: start a fresh pi agent as a child process",
  );
  expect(text, "does not use the internal word").not.toMatch(/dispatch/i);
});

test("the description says an unregistered name is refused, and names the real default", () => {
  const text = description();
  // An unknown name is refused rather than quietly falling back to the generalist. That
  // distinction -- "you named nothing" versus "you named something that is not there" -- is the
  // whole of #185, and a description that blurred it would invite exactly the guessing this file
  // was written to stop.
  expect(text, "states the consequence of an unknown name").toMatch(/refus|reject|not found/i);
  // The default that DOES exist is the omission, and the description has to name it: a model that
  // never learns the argument is optional keeps guessing names, which is what the twenty-call
  // hunt looked like.
  expect(text, "names the omission as the default").toMatch(/omit it/i);
  expect(text, "and says what the omission produces").toMatch(/generalist pi/i);
  /*
   * The PROPERTY, not just the phrases around it. The three assertions above are all satisfied by
   * a description that says the opposite — measured: rewriting the sentence to "The `agent`
   * argument is **required** — omit it and you do not get a generalist pi; pi's full toolset is
   * what you lose" keeps every one of them green, because it still contains "omit it" and
   * "generalist pi". A model reads this text to decide whether it may skip the argument, so the
   * word that carries that fact has to be the thing under test.
   *
   * Counterfactual: the rewrite above turns this pair red (no "optional", and it says "required").
   */
  expect(text, "states that the argument is optional").toMatch(/optional/i);
  expect(text, "and does not call it required").not.toMatch(/required/i);
});

test("the description points outward rather than repeating the refusal", () => {
  const text = description();
  // The actionable detail -- the registered names, both lookup paths, the file shape -- is
  // rendered by `describeRegisteredAgents` at refusal time. Restating it here would be the second
  // copy, and it is the copy that goes stale: the renderer is the one wired to the same resolver
  // a dispatch uses.
  //
  // Case-insensitive, and deliberately so. This was `not.toContain("registered agents:")` and it
  // was inert: appending `"Registered agents: name, other."` — exactly the duplication the test
  // exists to prevent — left every test in this file green. Matching the RENDERED SHAPE rather
  // than one casing of it is what makes the guard mean what it says.
  expect(text, "does not inline the registered-agents listing").not.toMatch(/registered agents/i);
  expect(text, "nor the bracketed name list the renderer produces").not.toMatch(/\[[a-z_]+, /i);
  expect(text, "does not inline the file-shape guidance").not.toMatch(/frontmatter/i);
});

test("the description still describes the tool, and the guidance survives", () => {
  const tool = createPtcSubagentTool({ cwd: "/repo", depth: 0, maxDispatchDepth: 3 });
  // The original description earned its place: it explains what a subagent IS and when to reach
  // for one. Adding the registry location must not crowd that out.
  expect(tool.description).toContain("Create a task: start a fresh pi agent as a child process");
  // ADR-0061: the ROUTING half of the guidelines moved into the route registry, and the
  // description gained the "when to use me" back FROM it. So the guidance is gone from the
  // guidelines and present in the description — the same sentence, one home.
  //
  // Counterfactual: drop the road paragraph from the description (or leave the routing sentence
  // in the guidelines as well) — one of the two assertions goes red.
  expect(tool.promptGuidelines?.join(" ") ?? "").not.toMatch(/prefer one subagent/i);
  expect(tool.description).toMatch(/Reach for this when the work is a question with an answer/);
});

test("the registered name is one constant, not a string repeated per file", () => {
  // `session_start` asks "does this surface register the codemode door?" and this tool answers
  // it. Two copies of the name is how a rename leaves a session being warned about a tool it no
  // longer has. ADR-0052 renamed it to `pi_task_codemode`.
  expect(SUBAGENT_TOOL_NAME).toBe("pi_task_codemode");
  expect(description()).not.toContain("no registered agent");
});
