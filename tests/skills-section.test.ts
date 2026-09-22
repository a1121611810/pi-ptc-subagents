/**
 * The skills section PTC mode has to hand back (ADR-0011).
 *
 * pi withholds `<available_skills>` whenever `read`/`bash` are not directly callable, which is
 * exactly the loadout this mode creates — so the list body stays pi's own and only the loading
 * sentence changes.
 */
import { expect, test } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  buildPtcSkillsSection,
  PTC_SKILL_LOAD_INSTRUCTION,
  skillsSectionDropped,
} from "../src/mode/skills-section.ts";

function skill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    name,
    description: `${name} does things`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { type: "user" },
    disableModelInvocation: false,
    ...overrides,
  } as Skill;
}

test("the gate is mirrored, not guessed: hidden only when neither read nor bash is callable", () => {
  expect(skillsSectionDropped(["edit", "write"])).toBe(true);
  expect(skillsSectionDropped(["edit", "read"])).toBe(false);
  expect(skillsSectionDropped(["bash"])).toBe(false);
  expect(skillsSectionDropped([])).toBe(true);
});

test("the list body is pi's, and the loading sentence is PTC's", () => {
  const section = buildPtcSkillsSection([skill("code-review"), skill("tdd")]);
  expect(section).toContain("<available_skills>");
  expect(section).toContain("<name>code-review</name>");
  expect(section).toContain("<description>tdd does things</description>");
  expect(section).toContain("<location>/skills/tdd/SKILL.md</location>");
  expect(section).toContain(PTC_SKILL_LOAD_INSTRUCTION);
  expect(section).not.toContain("Use the read tool");
});

test("skills marked /skill:-only stay out of the section", () => {
  expect(buildPtcSkillsSection([skill("grill-with-docs", { disableModelInvocation: true })])).toBe(
    "",
  );
  expect(buildPtcSkillsSection([])).toBe("");
});

test("a reworded pi header never ships a sentence naming a hidden tool", () => {
  const reworded = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the skill file somehow.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>tdd</name>",
    "  </skill>",
    "</available_skills>",
  ].join("\n");
  const section = buildPtcSkillsSection([skill("tdd")], () => reworded);
  expect(section.startsWith(PTC_SKILL_LOAD_INSTRUCTION)).toBe(true);
  expect(section).toContain("<name>tdd</name>");
});
