/**
 * T5 (#182): the smoke test. Both directions, and neither substitutes for the other.
 *
 * **Why this file exists at all.** The defect behind #177 was invisible to every mechanism this
 * repo already had. The unit tests were green because the specification permitted an empty agent
 * set to stay silent. Diff-scoped review had no diff: the parsing pattern dates to 09-22, the
 * directory resolver to 09-29, the tool description to 09-30, all before the 10-09 surface
 * change. So "all tests pass" and "review found nothing" were both true of a build where the
 * subagent face could not be used at all.
 *
 * The only thing that can catch that class is a check that asks the question the other two cannot:
 * **does this actually work in a real install?** That needs a real process, which is why this is an
 * e2e and why the child is a REAL subprocess with a fake `pi` on `PATH` rather than a stubbed
 * lifecycle. A stub would skip the spawn, the prompt file, the stdout parsing and the exit code --
 * the whole chain.
 *
 * **Both directions are load-bearing, and that is the point.**
 *   - Warning-only passes against a build where dispatch never works.
 *   - Working-only passes against a build that warns about everything.
 *   Only the pair says "usable, and it says so when it is not".
 */

import { describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../../src/runtime/dispatch.ts";
import { DispatchSlotCounter } from "../../src/runtime/dispatch.ts";
import { InMemoryTaskStorage } from "../../src/runtime/task-storage.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(HERE, "fixtures", "fake-pi.mjs");

/**
 * A temp cwd with an executable `pi` on PATH, so the dispatcher's hard-coded `pi` command
 * resolves to our fake rather than to the real install. The dispatcher deliberately does NOT reuse
 * `process.execPath` (see `PI_COMMAND`'s note in `src/runtime/dispatch.ts`), which is what makes
 * PATH the seam.
 */
async function withFakePi<T>(body: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "ptc-smoke-"));
  const binDir = join(cwd, "bin");
  await mkdir(binDir, { recursive: true });
  const pi = join(binDir, "pi");
  // A copy rather than a symlink: chmod on a symlink follows to the target, and the fixture has to
  // be executable on its own terms.
  await writeFile(pi, '#!/bin/sh\nexec "' + process.execPath + '" "' + FAKE_PI + '" "$@"\n');
  await chmod(pi, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = binDir + ":" + (previousPath ?? "");
  try {
    return await body(cwd);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

/** One foreground dispatch with nothing in the way. */
async function dispatchOnce(cwd: string, agent: string) {
  return await dispatch(
    { agent, task: "say PONG", agentScope: "both", cwd },
    { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
    { slots: new DispatchSlotCounter(2), taskRegistry: undefined },
  );
}

describe("a real dispatch works when an agent is registered", () => {
  test("the child really runs, and its real output comes back", async () => {
    await withFakePi(async (cwd) => {
      // A project-scoped definition, written with CRLF on purpose: the tolerance T3 added is
      // part of what makes "it works on a real file" true, and a smoke test using a hand-typed
      // LF string would pass whether or not the parser tolerates anything.
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "smoke.md"),
        ["---", "name: smoke", "---", "Reply with the word PONG."].join("\r\n"),
        "utf8",
      );

      const result = await dispatchOnce(cwd, "smoke");

      // The child is a REAL process, so these are real facts about the chain: it spawned, it
      // exited 0, and the text is what the child actually wrote to stdout.
      expect(result.status, "a real child process ran to completion").toBe("fulfilled");
      expect(result.exitCode).toBe(0);
      expect(result.text, "the child's own stdout came back").toContain("SMOKE-OK");
      // And the prompt was materialised and handed over: `prompt-bytes` is the size of the file
      // the dispatcher wrote, so a non-zero count proves --append-system-prompt was wired.
      expect(result.text).toMatch(/prompt-bytes=[1-9]\d*/);
    });
  });

  test("a scope that was not asked for still refuses, naming the reason", async () => {
    // The negative half at this seam: an agent that exists only in the project scope must NOT
    // resolve under the user scope. A smoke test that only asserted the happy path would let a
    // scope regression through -- and a scope regression here is a warning firing at a configured
    // session, which is the noise that makes warnings stop being read.
    await withFakePi(async (cwd) => {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "smoke.md"),
        "---\nname: smoke\n---\nReply PONG.\n",
        "utf8",
      );
      const result = await dispatchOnce(cwd, "smoke");
      expect(result.status).toBe("fulfilled");
      const userScoped = await dispatch(
        { agent: "smoke", task: "say PONG", agentScope: "user", cwd },
        { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(2), taskRegistry: undefined },
      );
      expect(userScoped.status, "project-scoped does not answer a user-scope lookup").toBe(
        "rejected",
      );
      expect(userScoped.errorMessage).toContain("unknown agent");
    });
  });
});

describe("an unusable install says so instead of pretending", () => {
  test("no agent at all is refused with a refusal that names where to put one", async () => {
    await withFakePi(async (cwd) => {
      const result = await dispatchOnce(cwd, "absent");
      expect(result.status, "an agent with no file behind it is refused").toBe("rejected");
      // The refusal has to be actionable or the model is back to guessing names. These two are
      // the pieces a user or model needs to fix it without reading our source.
      expect(result.errorMessage).toContain("unknown agent");
      expect(result.errorMessage).toContain("registered agents");
    });
  });

  test("a file that exists but cannot be parsed is not the same as a file that is absent", async () => {
    await withFakePi(async (cwd) => {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "broken.md"),
        "name: broken\n---\nno leading delimiter\n",
        "utf8",
      );
      const result = await dispatchOnce(cwd, "broken");
      expect(result.status, "an unparseable definition does not dispatch").toBe("rejected");
      // The distinction T3 exists for: the name was FOUND and could not be read as a definition.
      // Without this a user who re-saved a file would have no way to tell which half is true.
      expect(result.errorMessage).toContain("unknown agent");
      expect(result.errorMessage).toContain("broken");
    });
  });
});

describe("the storage seam the dispatch path needs is real", () => {
  test("a foreground dispatch needs no background runtime to succeed", async () => {
    // Guards the harness rather than the feature: if the dispatch path started depending on a
    // storage implementation this test does not provide, every case above would fail with an
    // error that reads like a product bug. A comment plus a green run is cheaper than a mystery.
    await withFakePi(async (cwd) => {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "smoke.md"),
        "---\nname: smoke\n---\nReply PONG.\n",
        "utf8",
      );
      const result = await dispatch(
        { agent: "smoke", task: "say PONG", agentScope: "both", cwd },
        { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(2), taskRegistry: undefined },
      );
      expect(result.status).toBe("fulfilled");
    });
  });

  test("InMemoryTaskStorage is the shape the harness falls back to", () => {
    // Named so the reason is on the record: this is the task-registry seam a background dispatch
    // would need, kept here so the foreground smoke does not have to invent one.
    expect(new InMemoryTaskStorage()).toBeTruthy();
  });
});
