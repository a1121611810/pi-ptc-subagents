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
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_CONTEXT } from "../helpers/ptc.ts";
import { dispatch } from "../../src/runtime/dispatch.ts";
import { DispatchSlotCounter } from "../../src/runtime/dispatch.ts";

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

  /*
   * HOME is redirected too, and that is load-bearing rather than tidiness. `resolveAgentDirs`
   * answers the USER axis from `os.homedir()`, and `discoverAgent` tries the user candidate
   * BEFORE the project one -- so without this a developer's own
   * `~/.pi/agent/agents/<name>.md` outranks the fixture and the suite's verdict is decided by
   * whoever happens to be running it. Measured: planting `smoke.md` under a temp HOME turns
   * "a scope that was not asked for still refuses" red on a machine that is otherwise fine.
   *
   * The sibling unit tests in this diff already do this (`withIsolatedAgentDirs`); this file is
   * where it had been dropped, which is exactly the kind of gap an e2e hides because it still
   * passes on the author's machine.
   */
  const home = await mkdtemp(join(tmpdir(), "ptc-smoke-home-"));
  await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.PATH = binDir + delimiter + (previousPath ?? "");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await body(cwd);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
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

/**
 * The same dispatch with NO agent named — the shape #185 makes legal.
 *
 * Kept beside `dispatchOnce` rather than folded into it with a default, because the difference
 * between "named a definition" and "named nothing" is the whole subject: a helper that quietly
 * supplied a default would make the two cases the same call and the test would stop being about
 * the omission.
 */
async function dispatchGeneralist(cwd: string) {
  return await dispatch(
    { task: "say PONG", agentScope: "both", cwd },
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

describe("an omitted agent dispatches a generalist child", () => {
  test("with no definition anywhere, the dispatch still runs a real child", async () => {
    await withFakePi(async (cwd) => {
      /*
       * Two things are absent here and both matter: no `.pi/agents/` in the cwd, and no agent in
       * the redirected HOME (which `withFakePi` guarantees). Under the contract this ticket
       * replaces, that combination refused before spawning anything -- so an install could not
       * dispatch at all until its user had first learned the markdown format and written a file.
       */
      const result = await dispatchGeneralist(cwd);

      expect(result.status, "a real child process ran to completion").toBe("fulfilled");
      expect(result.exitCode).toBe(0);
      expect(result.text, "the child's own stdout came back").toContain("SMOKE-OK");
      /*
       * No definition means nothing to narrow with, so no tool allowlist may reach the child --
       * that is precisely what leaves pi's own full toolset in place. Asserted against what a
       * REAL process reports it was handed, not against an argv array the test assembled itself.
       *
       * Counterfactual: drop the `undefined` branch in `childToolList` so the tool-list merge
       * always emits a value, and this goes red while every stub-spawn unit test stays green.
       */
      expect(result.text, "nothing narrowed the child").toContain("tools=none");
      expect(result.agentName, "no definition was resolved").toBe("");
      /*
       * #186 acceptance criterion 4: what the child received is observable in a REAL subprocess,
       * not only in a unit test. The fake `pi` echoes the prompt it was handed, so this is a fact
       * about the file the dispatcher wrote and passed, read back by a separate process — not an
       * assertion about a string this test assembled.
       *
       * The generalist is the case that matters: with no definition there is nothing else to tell
       * the child what it is, so the block is the whole of the prompt file.
       */
      expect(result.text, "the child received the dispatch context, verbatim").toContain(
        DISPATCH_CONTEXT,
      );
    });
  });
});

describe("a read-only tier is decided at the call site (ADR-0041)", () => {
  /**
   * The value the child was actually handed, read out of what the fake pi echoes back.
   *
   * It is parsed out of the child's own stdout rather than rebuilt from the dispatcher, because
   * the whole claim is about a real process receiving a real flag. A test that built the expected
   * string next to the implementation would be asserting the implementation twice.
   */
  function toolsTheChildWasHanded(text: string): string {
    const match = /\stools=(\S*)/.exec(text);
    expect(match, "the child echoed a tools value: " + text.slice(0, 200)).not.toBeNull();
    const tools = match?.[1];
    expect(tools, "the echo carried no value").toBeDefined();
    return tools ?? "";
  }

  async function dispatchReadOnly(
    cwd: string,
    readOnly: boolean | "strict" | "lenient",
    agent?: string,
  ) {
    return await dispatch(
      { task: "say PONG", agentScope: "both", cwd, readOnly, ...(agent ? { agent } : {}) },
      { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
      { slots: new DispatchSlotCounter(2), taskRegistry: undefined },
    );
  }

  /** A definition that declares its own tool list, so precedence has something to beat. */
  async function writeRestrictedAgent(cwd: string, frontmatter: string[]) {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "restricted.md"),
      ["---", "name: restricted", ...frontmatter, "---", "Reply PONG."].join("\n"),
      "utf8",
    );
  }

  test("no tier leaves the child's tool list exactly as it was", async () => {
    await withFakePi(async (cwd) => {
      const result = await dispatch(
        { task: "say PONG", cwd },
        { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(2) },
      );
      expect(result.status).toBe("fulfilled");
      // "none" is the fake pi's word for "no --tools flag reached me", which is the whole
      // non-regression claim: a tier that was never asked for must not narrow anything.
      expect(toolsTheChildWasHanded(result.text)).toBe("none");
    });
  });

  test("strict narrows the child to the read set plus the report tool", async () => {
    await withFakePi(async (cwd) => {
      const result = await dispatchReadOnly(cwd, "strict");
      expect(result.status).toBe("fulfilled");
      expect(toolsTheChildWasHanded(result.text)).toBe("read,grep,find,ls,ptc_child_report");
    });
  });

  test('true is the same request as "strict", not a second state', async () => {
    // Counterfactual: a build that stored `true` as its own tier, or that resolved it to
    // something narrower, fails HERE and nowhere else -- every other row passes either way.
    await withFakePi(async (cwd) => {
      const result = await dispatchReadOnly(cwd, true);
      expect(result.status).toBe("fulfilled");
      expect(toolsTheChildWasHanded(result.text)).toBe("read,grep,find,ls,ptc_child_report");
    });
  });

  test("strict beats the tool list a definition declared", async () => {
    // The precedence row, and the reason the parameter exists: the caller asked for a MODE,
    // not for a role. An implementation that merged the definition's `bash` in "so the child
    // keeps what it needs" reads as reasonable and is exactly what this row refuses.
    await withFakePi(async (cwd) => {
      await writeRestrictedAgent(cwd, ["tools: read, bash"]);
      const result = await dispatchReadOnly(cwd, "strict", "restricted");
      expect(result.status).toBe("fulfilled");
      const tools = toolsTheChildWasHanded(result.text);
      expect(tools).toBe("read,grep,find,ls,ptc_child_report");
      expect(tools, "the definition's bash did not survive the call site").not.toContain("bash");
    });
  });

  test("lenient leaves the tool list alone and says so in the child's prompt", async () => {
    /*
     * Two claims in one row because they are one claim: the tiers must differ in a way a reader
     * can SEE, rather than lenient being strict with an extra sentence bolted on.
     *
     * Counterfactual, and the mutation this exists to refuse: make `lenient` narrow the tool list
     * "a bit less strictly" and everything else in this file still passes. Asserting the tool
     * list is unchanged is the half that catches it.
     */
    await withFakePi(async (cwd) => {
      const untiered = await dispatch(
        { task: "say PONG", cwd },
        { callId: 0, cwd, depth: 0, maxDispatchDepth: 3 },
        { slots: new DispatchSlotCounter(2) },
      );
      const lenient = await dispatchReadOnly(cwd, "lenient");

      expect(untiered.status).toBe("fulfilled");
      expect(lenient.status).toBe("fulfilled");
      expect(
        toolsTheChildWasHanded(lenient.text),
        "lenient must not narrow anything — that is the strict tier's job",
      ).toBe(toolsTheChildWasHanded(untiered.text));
      expect(lenient.text, "the clause reaches the child verbatim").toContain(
        "You were dispatched read-only",
      );
      expect(untiered.text, "and it is absent when no tier was asked for").not.toContain(
        "You were dispatched read-only",
      );
    });
  });

  test("strict says nothing in the prompt, because the tool list already said it", async () => {
    // The other half of the same claim. A strict child that was ALSO told "do not write" is
    // being told to obey a rule it has no tool to break, which reads as a weaker guarantee than
    // the one it has.
    await withFakePi(async (cwd) => {
      const strict = await dispatchReadOnly(cwd, "strict");
      expect(strict.status).toBe("fulfilled");
      expect(strict.text).not.toContain("You were dispatched read-only");
      expect(strict.text).toContain("pi-ptc-context");
    });
  });

  test("a definition that opted out of the report contract is not handed the report tool", async () => {
    // Otherwise the flag activates a tool the child's prompt never asked it to call: registered,
    // documented, never called -- the state ADR-0032's merge exists to avoid.
    await withFakePi(async (cwd) => {
      await writeRestrictedAgent(cwd, ["childReport: false"]);
      const result = await dispatchReadOnly(cwd, "strict", "restricted");
      expect(result.status).toBe("fulfilled");
      expect(toolsTheChildWasHanded(result.text)).toBe("read,grep,find,ls");
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
      // The `(none)` branch. Its counterpart is the `[broken]` branch asserted below, and the pair
      // is what makes "the file is there but unparseable" distinguishable from "there is no
      // file" — either substring alone holds for both.
      expect(result.errorMessage, "an empty directory lists nothing").toContain("(none)");
    });
  });

  test("a file that exists but cannot be parsed shows up in the registry, unlike an absent one", async () => {
    await withFakePi(async (cwd) => {
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(cwd, ".pi", "agents", "broken.md"),
        "name: broken\n---\nno leading delimiter\n",
        "utf8",
      );

      const result = await dispatchOnce(cwd, "broken");
      expect(result.status, "an unparseable definition does not dispatch").toBe("rejected");
      expect(result.errorMessage).toContain("unknown agent");

      /*
       * The previous version of this test asserted `errorMessage` contains "broken" and called
       * that the distinction. It is not one: the refusal embeds the REQUESTED name, so an agent
       * called `broken` that does not exist anywhere produces the same substring. Measured:
       * making `listRegisteredAgents` skip unparseable files — which makes the two cases literally
       * identical — left this test green.
       *
       * What actually differs, and what a user needs: the refusal's registry listing. A file that
       * is there but unparseable is still a file the directory holds, so it appears in the list
       * the refusal prints. An absent one leaves the list empty. That is the line that has to be
       * asserted for the distinction to be observable at all, and it is what turns red when the
       * listing stops surfacing unparseable files.
       */
      expect(result.errorMessage, "the registry lists the file that is there").toContain(
        "[broken]",
      );
      expect(
        result.errorMessage,
        "and an absent agent is the other branch — verified by the case above",
      ).toContain("registered agents:");
    });
  });
});
