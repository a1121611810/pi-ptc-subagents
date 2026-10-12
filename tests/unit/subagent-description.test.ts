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

test("the description says an unregistered name is refused, and does not invent a default", () => {
  const text = description();
  // ADR-0016 is no default agent, so a model that guesses "default" or "general" is guessing.
  // Saying so costs a clause and saves the twenty-call hunt.
  expect(text, "states the consequence of an unknown name").toMatch(/refus|reject|not found/i);
  expect(text, "and does not promise a default that does not exist").not.toMatch(
    /a default agent|defaults to/,
  );
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
  expect(tool.description).toContain("Start a fresh pi agent as a child process");
  expect(tool.promptGuidelines?.join(" ")).toMatch(/prefer one subagent/i);
});

test("the registered name is one constant, not a string repeated per file", () => {
  // `session_start` asks "does this surface register ptc_subagent?" and this tool answers it.
  // Two copies of the name is how a rename leaves a session being warned about a tool it no
  // longer has.
  expect(SUBAGENT_TOOL_NAME).toBe("ptc_subagent");
  expect(description()).not.toContain("no registered agent");
});
