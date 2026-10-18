/**
 * The roster: the outlet `description` never had.
 *
 * Until this, a model could not learn that a registered agent existed, or what it was for,
 * until it guessed a name, failed the dispatch, and read the refusal. `description` was parsed
 * out of every agent file and then dropped on the floor — `listRegisteredAgents` returned
 * `string[]`, and names alone are only actionable to someone who already suspects a name.
 *
 * These tests pin the pre-decision channel. Each one names the mutation that turns it red;
 * a roster that silently loses its descriptions, its scope labels, or its agreement with the
 * refusal is exactly the failure this file exists to prevent.
 *
 * Fixtures are real agent files, modelled on the shipped definitions rather than on the
 * minimal `name:`-only shape, because the description IS the thing under test.
 */

import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRegisteredAgentRoster,
  describeRegisteredAgents,
  discoverAgent,
  listRegisteredAgentEntries,
  listRegisteredAgents,
} from "../../src/runtime/dispatch.ts";
import { createPtcSubagentTool } from "../../src/tools/subagent.ts";
import { DISPATCH_PARAMETERS } from "../../src/runtime/bindings.ts";

/** A definition with the shape real ones have: name, a routing description, and a body. */
function agentFile(name: string, description: string | null): string {
  const front = ["---", `name: ${name}`];
  if (description !== null) front.push(`description: ${description}`);
  front.push("---");
  return [...front, "", `You are ${name}.`, ""].join("\n");
}

/**
 * HOME and a project dir, both empty, wired through the `homeDir` seam rather than by
 * mutating `process.env`: a test that can see the developer's real `~/.pi/agent/agents`
 * would pass or fail depending on whose machine it ran on.
 */
async function withAgentDirs(
  seed: (dirs: { home: string; project: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ptc-roster-"));
  const home = join(root, "home");
  const project = join(root, "project");
  try {
    await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
    await mkdir(join(project, ".pi", "agents"), { recursive: true });
    await seed({ home, project });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAgent(project: string, name: string, description: string | null) {
  await writeFile(join(project, ".pi", "agents", `${name}.md`), agentFile(name, description));
}

async function writeUserAgent(home: string, name: string, description: string | null) {
  await writeFile(join(home, ".pi", "agent", "agents", `${name}.md`), agentFile(name, description));
}

describe("the roster a model reads before it decides to dispatch", () => {
  test("the agent's own description reaches the tool description", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "research", "Investigates a question against primary sources.");

      const tool = createPtcSubagentTool({
        cwd: project,
        depth: 0,
        maxDispatchDepth: 2,
        homeDir: home,
      });

      // Counterfactual: render the roster from names alone (what the lister used to return)
      // and this goes red — which is the defect, not a hypothetical.
      expect(tool.description).toContain("Investigates a question against primary sources.");
      expect(tool.description).toContain("research");
    });
  });

  test("each agent is labelled with the scope that reaches it", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "research", "Project-level investigation.");
      await writeUserAgent(home, "notetaker", "Machine-wide note taking.");

      const roster = describeRegisteredAgentRoster({
        cwd: project,
        agentScope: "both",
        homeDir: home,
      });

      // `agentScope` defaults to "user", so an unlabelled roster is a table of names that
      // mostly do not resolve. Counterfactual: hardcode the label to "user" -> red.
      expect(roster).toContain("research (project scope)");
      expect(roster).toContain("notetaker (user scope)");
    });
  });

  test("an agent that declares no description says so instead of rendering blank", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "silent", null);

      const roster = describeRegisteredAgentRoster({
        cwd: project,
        agentScope: "both",
        homeDir: home,
      });

      // Counterfactual: emit the description as-is ("" for an absent one) and the line reads
      // "silent (project scope): " — indistinguishable from a rendering bug.
      expect(roster).toContain("silent (project scope): (no description given)");
    });
  });

  test("the roster and the refusal never disagree about what is registered", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "research", "Project-level.");
      await writeUserAgent(home, "notetaker", "Machine-wide.");

      const input = { cwd: project, agentScope: "both" as const, homeDir: home };
      const names = listRegisteredAgents(input);
      const roster = describeRegisteredAgentRoster(input);
      const refusal = describeRegisteredAgents(input);

      expect(names).toEqual(["notetaker", "research"]);
      for (const name of names) {
        expect(roster, `${name} is advertised`).toContain(name);
        expect(refusal, `${name} is listed on refusal`).toContain(name);
      }
      // Counterfactual: give `listRegisteredAgents` its own traversal with the scopes in the
      // opposite order -> the roster and the refusal diverge -> red.
      expect(roster).toContain("notetaker (user scope)");
    });
  });

  test("a name defined twice resolves to the user copy, as a dispatch would", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeUserAgent(home, "shared", "The user-scope definition.");
      await writeAgent(project, "shared", "The project-scope definition.");

      const input = { cwd: project, agentScope: "both" as const, homeDir: home };
      const entries = listRegisteredAgentEntries(input);

      // Counterfactual: let the later directory overwrite the earlier one -> "The
      // project-scope definition." appears -> red. The precedence has to match the one
      // `discoverAgent` applies, or the roster advertises a copy that will not be dispatched.
      expect(entries).toHaveLength(1);
      expect(entries[0]?.description).toBe("The user-scope definition.");
      expect(entries[0]?.source).toBe("user");
    });
  });

  test("narrowing the scope hides the agents the narrowed scope cannot reach", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "research", "Project-level.");
      await writeUserAgent(home, "notetaker", "Machine-wide.");

      const userOnly = describeRegisteredAgentRoster({
        cwd: project,
        agentScope: "user",
        homeDir: home,
      });

      expect(userOnly).toContain("notetaker");
      // Counterfactual: ignore the scope argument and always list both -> red.
      expect(userOnly).not.toContain("research");
    });
  });

  test("with nothing registered the roster still explains the default", async () => {
    await withAgentDirs(async ({ home, project }) => {
      const roster = describeRegisteredAgentRoster({
        cwd: project,
        agentScope: "both",
        homeDir: home,
      });

      /*
       * The empty registry is the NORMAL state now (#185), so it must not read as a problem.
       * This branch's job is to say that dispatch still works and what it will do — a caller who
       * reads "nothing registered" and concludes "I cannot dispatch" is exactly the user the
       * required argument used to cost.
       *
       * Counterfactual: restore the old "nothing to dispatch" phrasing and both go red.
       */
      expect(roster).toContain("omit it for a fresh generalist pi");
      expect(roster).toContain("nothing to name");
    });
  });
});

describe("the scope default the model cannot see otherwise", () => {
  /**
   * Read the schema's own field, not `JSON.stringify` of it. Asserting on the serialized
   * form makes the test a function of quote-escaping rather than of the schema, and an
   * escaped-quote mismatch is a confusing failure for a correct implementation.
   */
  function fieldDescription(field: string): string | undefined {
    const properties = DISPATCH_PARAMETERS.properties as Record<string, { description?: string }>;
    return properties[field]?.description;
  }

  test("the agentScope parameter carries its default and what that default hides", () => {
    const description = fieldDescription("agentScope");

    // `agentScope` defaults to "user", which does not see `<cwd>/.pi/agents/`. The roster
    // labels each agent's scope; this is the schema-side half of the same fact.
    // Counterfactual: drop the description -> undefined -> red.
    expect(description).toContain('Defaults to "user"');
    expect(description).toContain("<cwd>/.pi/agents");
  });

  test("the agent parameter says it is optional, and what omitting it produces", () => {
    const description = fieldDescription("agent");

    // The three facts a model needs to skip the argument deliberately rather than by accident:
    // that it may, what it will get, and that a name narrows rather than enables.
    // Counterfactual: drop the description -> undefined -> red.
    expect(description).toContain("omit it entirely");
    expect(description).toContain("generalist pi");
    expect(description).toContain("full toolset");
    /*
     * The PROPERTY the other three only imply. All three survive a description that says the
     * opposite — "The `agent` argument is required — omit it entirely and you do not get a
     * generalist pi; pi's full toolset is what you lose" contains every phrase above. This field
     * is a model-visible channel, so the word carrying the permission has to be asserted.
     * Counterfactual: the rewrite above turns this pair red.
     */
    expect(description, "states that the argument is optional").toMatch(/optional/i);
    expect(description, "and does not call it required").not.toMatch(/required/i);
  });
});

/**
 * #201 — the roster and discovery must name the same agents.
 *
 * The oracle here is the OTHER implementation, not a hand-written expectation: every candidate
 * name in the scope is put to `discoverAgent` and the roster is asked for its list, and the two
 * sets are compared. A disagreement is therefore measured rather than restated. Before the fix a
 * file whose frontmatter carried no `name:` was advertised under its file name AND refused by the
 * dispatch that renders that same roster — both answers in one message, which is what made the
 * original report read like a fixture problem.
 *
 * Identity is the frontmatter `name:` because that is pi's rule: its subagent loader skips a
 * definition with no string `name` and never derives identity from the file name. The roster now
 * applies the predicate `discoverAgent` applies, instead of a second and looser one.
 */

/** Frontmatter without a `name:` — the exact fixture shape #201 was filed against. */
const NAMELESS = "---\nchildReport: false\n---\nYou are nobody.\n";

/** No frontmatter delimiter at all: also unparseable, by the same rule. */
const BODY_ONLY = "just a body, no frontmatter at all\n";

async function writeRawProject(project: string, fileName: string, content: string) {
  await writeFile(join(project, ".pi", "agents", fileName), content);
}

async function writeRawUser(home: string, fileName: string, content: string) {
  await writeFile(join(home, ".pi", "agent", "agents", fileName), content);
}

/**
 * The candidate names in one agents directory, DISCOVERED rather than assumed — a fixture the
 * test forgot to create would otherwise silently drop out of the oracle instead of failing.
 */
function candidatesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .sort();
}

describe("the roster advertises exactly what a dispatch can resolve (#201)", () => {
  test("the listed set equals the resolvable set for every way a file can lack a name", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "alpha", "Named in its own frontmatter.");
      await writeRawProject(project, "nameless.md", NAMELESS);
      await writeRawProject(project, "body-only.md", BODY_ONLY);
      await writeRawProject(project, "empty.md", "");
      // Not markdown: never an agent, and never a candidate.
      await writeRawProject(project, "README.txt", "notes\n");

      const candidates = candidatesIn(join(project, ".pi", "agents"));
      const resolvable = candidates.filter(
        (name) => discoverAgent(name, project, "both", { homeDir: home }) !== null,
      );

      // Only `alpha` names itself, so it is the only one a dispatch can resolve. Stated as a
      // literal rather than as a copy of the roster, so the two assertions can actually differ.
      expect(resolvable).toEqual(["alpha"]);
      // THE INVARIANT. Counterfactual: restore the filename fallback in
      // `listRegisteredAgentEntries` and this gains nameless / body-only / empty while
      // `resolvable` does not -> red.
      expect(listRegisteredAgents({ cwd: project, agentScope: "both", homeDir: home })).toEqual(
        resolvable,
      );
    });
  });

  test("a name defined in both scopes is advertised once and resolves to the same copy", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeUserAgent(home, "shared", "The user-scope definition.");
      await writeAgent(project, "shared", "The project-scope definition.");
      await writeRawUser(home, "nameless.md", NAMELESS);

      // De-duplicated: the same name in both scopes is ONE name, and asking about it twice would
      // double it in the oracle and make the comparison fail for the wrong reason.
      const candidates = [
        ...new Set([
          ...candidatesIn(join(home, ".pi", "agent", "agents")),
          ...candidatesIn(join(project, ".pi", "agents")),
        ]),
      ].sort();
      const resolvable = candidates.filter(
        (name) => discoverAgent(name, project, "both", { homeDir: home }) !== null,
      );

      expect(resolvable).toEqual(["shared"]);
      expect(listRegisteredAgents({ cwd: project, agentScope: "both", homeDir: home })).toEqual(
        resolvable,
      );
      /*
       * Precedence, cross-checked in BOTH directions rather than asserted once. The roster
       * carries a `source` per entry and discovery returns the same field, so a roster that
       * advertised the project copy while dispatch resolved the user copy would survive a
       * names-only comparison — this is the half that catches it.
       */
      const entries = listRegisteredAgentEntries({
        cwd: project,
        agentScope: "both",
        homeDir: home,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe("user");
      expect(discoverAgent("shared", project, "both", { homeDir: home })?.source).toBe("user");
    });
  });

  test("a definition with no frontmatter name is named by neither the roster nor the refusal", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "research", "Project-level investigation.");
      await writeRawProject(project, "nameless.md", NAMELESS);
      await writeRawProject(project, "body-only.md", BODY_ONLY);

      const input = { cwd: project, agentScope: "both" as const, homeDir: home };
      const roster = describeRegisteredAgentRoster(input);
      const refusal = describeRegisteredAgents(input);

      expect(roster).toContain("research (project scope)");
      // The original defect, in its reported shape: the refusal listed the very name it refused.
      // Counterfactual: restore the filename fallback -> both strings name them -> red.
      expect(roster).not.toContain("nameless");
      expect(roster).not.toContain("body-only");
      expect(refusal).toContain("registered agents: [research]");
      expect(refusal).not.toContain("nameless");
      expect(refusal).not.toContain("body-only");
    });
  });

  /**
   * The one case the invariant does NOT reach, recorded rather than left for the next reader to
   * re-derive.
   *
   * `discoverAgent` rebuilds the file path from the requested name, so it can only resolve an
   * agent whose FILE name equals its frontmatter `name:`. An agent whose two disagree is
   * advertised under the frontmatter name and is dispatchable under NEITHER name. That is the
   * roster/discovery mismatch again, from a different cause — but it behaves identically before
   * and after #201, which is scoped to the null parse, so this change neither introduced nor
   * fixed it. pi's own loader keys agents by the frontmatter name and has no such constraint;
   * this is a real divergence from pi, filed separately rather than folded in here.
   */
  test("an agent whose file name disagrees with its frontmatter name stays a separate mismatch", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeRawProject(
        project,
        "beta.md",
        "---\nname: gamma\ndescription: Renamed.\n---\nYou are gamma.\n",
      );

      // Advertised under the frontmatter name — pi's rule, the one #201 settled.
      expect(listRegisteredAgents({ cwd: project, agentScope: "both", homeDir: home })).toEqual([
        "gamma",
      ]);
      // ...and unresolvable under either name, because the path is rebuilt from the name.
      expect(discoverAgent("gamma", project, "both", { homeDir: home })).toBeNull();
      expect(discoverAgent("beta", project, "both", { homeDir: home })).toBeNull();
    });
  });

  /**
   * pi's loader also requires a string `description`; this package tolerates an absent one. That
   * divergence is not the #201 defect (the invariant is about NAMES) and is deliberately not
   * changed here — the answer is pinned so the next reader does not have to re-derive which rule
   * this package follows: an agent with a name and no description stays listed, stays
   * dispatchable, and says so in the roster rather than vanishing from it.
   */
  test("a name with no description stays listed and dispatchable, and the roster states it", async () => {
    await withAgentDirs(async ({ home, project }) => {
      await writeAgent(project, "silent", null);

      expect(listRegisteredAgents({ cwd: project, agentScope: "both", homeDir: home })).toEqual([
        "silent",
      ]);
      expect(discoverAgent("silent", project, "both", { homeDir: home })?.systemPrompt).toBe(
        "You are silent.",
      );
      expect(
        describeRegisteredAgentRoster({ cwd: project, agentScope: "both", homeDir: home }),
      ).toContain("silent (project scope): (no description given)");
    });
  });
});
