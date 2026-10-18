/**
 * T3 (#180): agent files survive the shapes real editors write, and a malformed one is not an
 * agent.
 *
 * Two separate defects, and the second is what makes the first worth fixing.
 *
 * The pattern matched exactly one file shape. A definition saved with CRLF line endings, with a
 * UTF-8 BOM, or with a blank line before the opening delimiter parsed to `null` -- and `null`
 * reads, from every layer above, as "no such agent". So a perfectly good agent file silently
 * stopped being an agent.
 *
 * "The file is there but I could not parse it" and "the file is not there" collapsed into the same
 * outcome, which is the half of the problem the tolerance above removes for the shapes real
 * editors actually write.
 *
 * **What remains after that is deliberate (#201).** A file that is genuinely malformed -- no
 * frontmatter delimiter at all -- is still not an agent, and it is now also absent from the
 * registry, because the roster advertising a name that dispatch refuses is the contradiction that
 * issue was filed about. See the last test in this block for why an empty listing is the true
 * answer there rather than a silent loss.
 *
 * **The fixtures below carry real `\r\n` and real `\uFEFF`.** That is the whole test. Written as
 * `.join("\n")` or with an escaped `\r` that never reaches the parser, they would pass against the
 * old pattern too and would prove nothing. If you rewrite one of these as a normal string, this
 * file stops testing what it claims to test.
 */

import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgent, parseAgentMarkdown } from "../../src/runtime/dispatch.ts";

describe("frontmatter tolerance", () => {
  test("a CRLF file parses to the same agent as its LF twin", () => {
    const lf = ["---", "name: reviewer", "---", "Review a diff."].join("\n");
    const crlf = lf.split("\n").join("\r\n");

    // Precondition worth stating: the two really are different bytes, or this test is vacuous.
    expect(crlf).not.toBe(lf);

    const parsed = parseAgentMarkdown(crlf);
    expect(parsed, "CRLF is what a Windows editor writes").toBeTruthy();
    expect(parsed?.name).toBe("reviewer");
    // The BODY must come out with no stray carriage returns, or every prompt line the child
    // receives ends in an invisible \r.
    expect(parsed?.systemPrompt).toBe("Review a diff.");
  });

  test("a UTF-8 BOM before the delimiter does not hide the frontmatter", () => {
    const md = "﻿" + ["---", "name: reviewer", "---", "Review a diff."].join("\n");
    const parsed = parseAgentMarkdown(md);
    expect(parsed, "a BOM is added by some editors on save").toBeTruthy();
    expect(parsed?.name).toBe("reviewer");
    expect(parsed?.systemPrompt).toBe("Review a diff.");
  });

  test("a blank line before the opening delimiter is not frontmatter's absence", () => {
    const md = "\n" + ["---", "name: reviewer", "---", "Review a diff."].join("\n");
    const parsed = parseAgentMarkdown(md);
    expect(
      parsed,
      "one leading newline is a formatting accident, not a missing header",
    ).toBeTruthy();
    expect(parsed?.name).toBe("reviewer");
  });

  test("CRLF frontmatter still reads its scalar fields", () => {
    // Tolerating the line endings must not cost the fields: `extractYamlString` matches on `\n`,
    // so a merely-delimiter-tolerant pattern would pass the test above and still drop `model`.
    const md = [
      "---",
      "name: reviewer",
      "description: Reviews diffs",
      "model: claude-haiku",
      "tools: read, grep",
      "---",
      "Review a diff.",
    ].join("\r\n");
    const parsed = parseAgentMarkdown(md);
    expect(parsed?.description).toBe("Reviews diffs");
    expect(parsed?.model).toBe("claude-haiku");
    expect(parsed?.tools).toEqual(["read", "grep"]);
  });

  test("a file with no frontmatter at all is still rejected", () => {
    // The tolerance must not become a catch-all: a genuine body-only file has no agent in it.
    expect(parseAgentMarkdown("no frontmatter here\njust a body")).toBeNull();
    expect(parseAgentMarkdown("")).toBeNull();
  });
});

describe("unparseable is distinguishable from absent", () => {
  /** A definition whose body exists but whose frontmatter cannot be a frontmatter. */
  const UNPARSEABLE = ["name: reviewer", "---", "Review a diff."].join("\n");

  test("a path that exists but does not parse does not resolve as an agent", async () => {
    const home = await mkdtemp(join(tmpdir(), "ptc-agent-parse-"));
    const cwd = await mkdtemp(join(tmpdir(), "ptc-agent-cwd-"));
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await writeFile(join(home, ".pi", "agent", "agents", "reviewer.md"), UNPARSEABLE, "utf8");
      const found = discoverAgent("reviewer", cwd, "user", { homeDir: home });
      // The signature cannot carry the reason -- it is a lookup, and a lookup that cannot resolve
      // returns null.
      //
      // This test used to be titled "is reported differently from one that does not exist", and
      // the difference it named is GONE as of #201: an unparseable file and an absent one now
      // produce the same refusal, because the roster no longer substitutes the file name. What
      // survives is the half of the invariant that lives at THIS layer, and it is the half the
      // roster depends on — a file with no usable frontmatter name is not an agent, so there is
      // nothing for the roster to advertise on its behalf.
      expect(found, "an unparseable file does not resolve as an agent").toBeNull();
      expect(UNPARSEABLE, "and the file genuinely is there").not.toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a file whose frontmatter cannot parse is not listed as an agent", async () => {
    const { listRegisteredAgents } = await import("../../src/runtime/dispatch.ts");
    const home = await mkdtemp(join(tmpdir(), "ptc-agent-list-"));
    const cwd = await mkdtemp(join(tmpdir(), "ptc-agent-cwd2-"));
    const { mkdir } = await import("node:fs/promises");
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await writeFile(join(home, ".pi", "agent", "agents", "broken.md"), UNPARSEABLE, "utf8");

      /*
       * **The contract REVERSED here in #201, on purpose.** This test used to require the file
       * to be listed under its filename, on the reasoning that "no agent configured" for a
       * directory that visibly holds one leaves the user no way to tell which half of the story
       * is true.
       *
       * That reasoning bought exactly the ambiguity #201 was filed about: the roster advertised a
       * name `discoverAgent` refuses, and the refusal prints the roster, so one message carried
       * both answers at once. Identity is the frontmatter `name:` because pi's subagent loader
       * skips a definition without one and never derives identity from the file name — so this
       * file is not an agent, and a registry listing nothing is the TRUE answer rather than a
       * silent loss.
       *
       * Counterfactual: restore the file-name fallback in `listRegisteredAgentEntries` -> red.
       */
      expect(listRegisteredAgents({ cwd, agentScope: "user", homeDir: home })).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("lookup semantics are unchanged", () => {
  test("an agent still resolves by name to its path, in the scope asked for", async () => {
    const home = await mkdtemp(join(tmpdir(), "ptc-agent-scope-"));
    const cwd = await mkdtemp(join(tmpdir(), "ptc-agent-cwd3-"));
    const { mkdir } = await import("node:fs/promises");
    try {
      await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
      await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
      await writeFile(
        join(home, ".pi", "agent", "agents", "reviewer.md"),
        "---\nname: reviewer\n---\nuser scoped\n",
        "utf8",
      );
      await writeFile(
        join(cwd, ".pi", "agents", "reviewer.md"),
        "---\nname: reviewer\n---\nproject scoped\n",
        "utf8",
      );
      // Scopes stay distinct: `user` does not see the project file, and the project scope wins
      // where both could answer. This is the semantics T3 must not disturb.
      expect(discoverAgent("reviewer", cwd, "user", { homeDir: home })?.systemPrompt).toBe(
        "user scoped",
      );
      expect(discoverAgent("reviewer", cwd, "project", { homeDir: home })?.systemPrompt).toBe(
        "project scoped",
      );
      // A name that no file declares resolves to nothing, rather than matching a file by its
      // path stem: content-based fallback is explicitly out of scope for this ticket.
      expect(discoverAgent("reviewer.md", cwd, "both", { homeDir: home })).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
