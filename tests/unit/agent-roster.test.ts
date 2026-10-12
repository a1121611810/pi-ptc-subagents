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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRegisteredAgentRoster,
  describeRegisteredAgents,
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
  });
});
