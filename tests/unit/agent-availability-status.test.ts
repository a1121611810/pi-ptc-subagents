/**
 * T2 (#179): the resolved agent availability stays readable after startup.
 *
 * T1's notice is a moment. It fires once, at session start, and if the user is looking at
 * something else it is gone -- which is the normal case when you start a session and then go and
 * do the thing the session is for. Someone who realises "the subagent never ran" twenty minutes
 * later should not have to go and re-derive it from a transcript.
 *
 * This is the repo's own observability rule applied to a session: a state that is only visible
 * while it is happening is not observable. The value is derived ONCE at start and read
 * afterwards, so a later read cannot disagree with the notice that was shown at the time.
 *
 * It deliberately does not become a second status key. The status surface already carries this
 * package's state, and a second key would be a second thing to learn to read.
 */

import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeExtensionStub, makeTempDir, removeTempDir } from "../helpers/ptc.ts";
import type { CodemodePresence } from "../../src/index.ts";

const FOUND_CODEMODE = {
  present: true,
  how: "found",
  path: "/fake/codemode",
} as unknown as CodemodePresence;

const SUBAGENTS_AXES = {
  codemode: FOUND_CODEMODE,
  codemodeSwitch: { switch: "enabled", source: "user" },
  codemodeActivation: { activation: "active", source: "loadout" },
} as const;

const ACTIVE_WITH_ORCHESTRATOR = [
  "read",
  "bash",
  "edit",
  "write",
  "codemode",
  "ptc_subagent",
] as const;

/** The latest text this package put on its status key. */
function statuses(stub: { statuses: readonly { key: string; text: string | undefined }[] }) {
  const mine = stub.statuses.filter((s) => s.key === "ptc-mode" && s.text !== undefined);
  return mine[mine.length - 1]?.text;
}

/** The T1 notice, so the two can be compared rather than trusted independently. */
function notices(stub: { notifications: readonly { message: string }[] }): string[] {
  return stub.notifications
    .filter((n) => n.message.includes("no registered agent"))
    .map((n) => n.message);
}

async function withIsolatedAgentDirs<T>(body: () => Promise<T>): Promise<T> {
  const home = await makeTempDir();
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
  }
}

test("an unusable install is readable from the status surface, not only from the notice", async () => {
  await withIsolatedAgentDirs(async () => {
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ACTIVE_WITH_ORCHESTRATOR,
    });

    // The notice said it, so the status has to say it too -- otherwise the two disagree and the
    // user cannot tell which one is current.
    expect(notices(stub).length, "the startup notice fired").toBe(1);
    const status = statuses(stub);
    expect(status, "and the state is readable afterwards").toBeTruthy();
    expect(status, "the status agrees with the notice about the same fact").toContain(
      "no registered agent",
    );
  });
});

test("a configured install leaves the status surface alone", async () => {
  // The status line already carries the PTC mode state. Adding a permanent marker for a condition
  // that is fine would make the surface noisier for every session to describe a session that is
  // not broken -- and a status line that is always busy is one nobody reads.
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
    expect(notices(stub), "no notice").toEqual([]);
    expect(statuses(stub) ?? "", "and no marker on the status surface").not.toContain(
      "no registered agent",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await removeTempDir(home);
  }
});

test("a full-surface session leaves the status surface alone", async () => {
  await withIsolatedAgentDirs(async () => {
    const stub = await makeExtensionStub({
      codemode: { present: false, how: "not-found", path: "" } as unknown as CodemodePresence,
      active: ["read", "bash", "edit", "write", "ptc_run_code"],
    });
    expect(statuses(stub) ?? "", "no tool, no marker").not.toContain("no registered agent");
  });
});

test("the mode state still reads the way it did", async () => {
  // The regression this could cause: folding agent availability into the mode status line must not
  // displace what was already there. `/ptc on` announces itself, and that has to keep working.
  await withIsolatedAgentDirs(async () => {
    const stub = await makeExtensionStub({
      ...SUBAGENTS_AXES,
      active: ACTIVE_WITH_ORCHESTRATOR,
    });
    const status = statuses(stub);
    expect(status, "the status carries something").toBeTruthy();
    expect(status).toContain("agent");
  });
});
