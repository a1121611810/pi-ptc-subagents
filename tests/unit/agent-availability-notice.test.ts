/**
 * T1 (#178): the session tells you when `ptc_subagent` has no usable agent.
 *
 * The defect this pins is a **missing read point**, not a broken one. `listRegisteredAgents` was
 * fully unit-tested and had exactly one production caller -- inside `describeRegisteredAgents`,
 * which runs only AFTER a dispatch has already been refused. So on the success path nothing ever
 * asked whether the tool could do anything, and a registered-but-uncallable tool looked exactly
 * like a working one.
 *
 * The sibling notice it sits next to makes the asymmetry concrete: a session on `subagents` with
 * no `codemode` orchestrator WARNS (`tests/extension.test.ts` "subagents mode without codemode
 * warns once"), while a session with no agent definition at all said nothing -- and that second
 * case is the one that actually happens on a fresh install, because a fresh install has no agent
 * definitions either.
 *
 * Four cases, and the three negatives are the load-bearing half: a warning that fires when it
 * should not is noise a user learns to ignore, which is how the silence was survived for this long.
 */

import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeExtensionStub, makeTempDir, removeTempDir } from "../helpers/ptc.ts";
import type { CodemodePresence } from "../../src/index.ts";

/** A pi that ships and loads codemode, and has it active -- the `subagents` cell. */
const FOUND_CODEMODE = {
  present: true,
  how: "found",
  path: "/fake/codemode",
} as unknown as CodemodePresence;

/** The same two axes `tests/extension.test.ts` pins, which resolve the surface to `subagents`. */
const SUBAGENTS_AXES = {
  codemode: FOUND_CODEMODE,
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;

/** The active list a `subagents` session that DID get its orchestrator reports. */
const ACTIVE_WITH_ORCHESTRATOR = [
  "read",
  "bash",
  "edit",
  "write",
  "codemode",
  "ptc_subagent",
] as const;

/** Only this test's notice. Scoped so a sibling notice cannot make the count drift. */
function agentNotices(stub: { notifications: readonly { message: string }[] }): string[] {
  return stub.notifications
    .filter((n) => n.message.includes("no registered agent"))
    .map((n) => n.message);
}

/** Point HOME and cwd at fresh empty dirs, so `os.homedir()` cannot see a real agent file. */
async function withIsolatedAgentDirs<T>(body: () => Promise<T>): Promise<T> {
  const home = await makeTempDir();
  const cwd = await makeTempDir();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await body();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await removeTempDir(home);
    await removeTempDir(cwd);
  }
}

test("a subagents session with no registered agent says the tool has nothing to dispatch", async () => {
  // Constraint #3: the failure is observable. This is the whole ticket: the tool is registered
  // and described to the model, and the one thing that makes it useless goes unmentioned.
  //
  // Counterfactual: deleting the availability check leaves this at zero notices.
  const stub = await withIsolatedAgentDirs(() =>
    makeExtensionStub({ ...SUBAGENTS_AXES, active: ACTIVE_WITH_ORCHESTRATOR }),
  );
  const notices = agentNotices(stub);
  expect(notices.length, "one notice about the missing agents, not a stream of them").toBe(1);
  // It names BOTH scopes, because the fix is one of two files in one of two directories and a
  // notice naming only the user scope would send a project-scoped user to the wrong place.
  expect(notices[0], "names the user-scope directory").toContain(join(".pi", "agent", "agents"));
  expect(notices[0], "names the project-scope directory").toContain(join(".pi", "agents"));
});

test("a subagents session WITH an agent registered says nothing", async () => {
  // The negative that makes the notice worth having. If this ever fires, the notice has become
  // noise on every session of a correctly configured install -- which is how a user stops reading
  // it, and how the original silence got this far.
  const home = await makeTempDir();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "agents", "reviewer.md"),
      "---\nname: reviewer\n---\nReview a diff.\n",
      "utf8",
    );
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ACTIVE_WITH_ORCHESTRATOR,
    });
    expect(agentNotices(stub), "a configured install is not nagged").toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await removeTempDir(home);
  }
});

test("a session whose only agent is PROJECT-scoped is not nagged either", async () => {
  // Counterfactual: reading the user scope alone turns this red. This is the case that pins the
  // check to `both` rather than to the dispatch default of `user` -- a project-scoped agent is a
  // normal setup, and warning at a configured session is how a notice becomes noise.
  const cwd = await makeTempDir();
  const home = await makeTempDir();
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "reviewer.md"),
      "---\nname: reviewer\n---\nReview a diff.\n",
      "utf8",
    );
    // `session_start`'s ctx takes its cwd from `process.cwd()` (the `cwd` default documented at
    // the top of `src/index.ts`), so this is the process-scope half of the isolation the HOME
    // redirect above already does for the user scope.
    const previousCwd = process.cwd();
    process.chdir(cwd);
    let stub: Awaited<ReturnType<typeof makeExtensionStub>>;
    try {
      stub = await makeExtensionStub({
        ...SUBAGENTS_AXES,
        active: ACTIVE_WITH_ORCHESTRATOR,
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect(agentNotices(stub), "a project-scoped agent counts as configured").toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await removeTempDir(home);
    await removeTempDir(cwd);
  }
});

test("a full-surface session says nothing: it has no ptc_subagent to be unusable", async () => {
  // Telling a session about the precondition of a tool it was never given is the same defect in a
  // different costume. `full` registers `ptc_run_code`, and the pair is reachable without an agent.
  const stub = await withIsolatedAgentDirs(async () =>
    makeExtensionStub({
      codemode: { present: false, how: "not-found", path: "" } as unknown as CodemodePresence,
      active: ["read", "bash", "edit", "write", "ptc_run_code"],
    }),
  );
  expect(agentNotices(stub), "no tool, no notice").toEqual([]);
});

test("a print-mode session carries no notification, because notify is TUI-only", async () => {
  /*
   * The previous version of this test asserted the same `[]` while its comment claimed "matching
   * every other TUI-only notice here" — and there is no such product-side gate: `grep '"print"'`
   * in `src/` returns zero. TUI-only is a property of `ctx.ui.notify` itself, not of this
   * extension. So the old assertion was true for every possible product behaviour, including one
   * that emitted the notice in print mode: vacuous, and its comment described a gate that does not
   * exist.
   *
   * What is real and worth pinning is the STATUS marker: `paintStatus` is not a notify, so in
   * print mode the decision still ran and the degradation is still recorded. That is the honest
   * statement of what the mode does here, and it fails the moment the check stops firing.
   */
  const stub = await withIsolatedAgentDirs(() =>
    makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ACTIVE_WITH_ORCHESTRATOR,
      mode: "print",
    }),
  );
  // Counterfactual: gating on print mode, or removing the availability check, empties this.
  const status = stub.statuses
    .filter((s) => s.key === "ptc-mode" && s.text !== undefined)
    .map((s) => s.text)
    .join(" ");
  expect(status, "the decision still ran and is still recorded").toContain("no registered agent");
});
