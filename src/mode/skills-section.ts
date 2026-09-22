/**
 * The system-prompt skills section, restored for PTC mode.
 *
 * pi advertises skills only when the session can actually open one:
 *
 *   const skillFileReadTool = ["read", "bash"].find((tool) => selectedTools.includes(tool));
 *   if (skillFileReadTool && skills.length > 0) promptSections.skills = ...
 *                                      (pi-coding-agent: dist/core/system-prompt.js)
 *
 * PTC mode hides exactly those two tools, so that gate drops the section — and with it the model's
 * only way to learn that skills exist. Measured on real session files: sessions before
 * PTC-mode-by-default carried 43 skills in `SystemMessage.sections.skills`; PTC sessions carried
 * no `skills` section at all. See ADR-0011.
 *
 * The list body stays pi's own — `formatSkillsForPrompt` is a public export and its XML shape is
 * the agentskills.io spec, so re-deriving it here would only create drift. Only the loading
 * sentence changes: "Use the read tool" is false in a session where `read` is hidden, and the way
 * in is `tools.read` from inside a program.
 */
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";

/** The two tools pi accepts as "this session can read a skill file". */
export const SKILL_READING_TOOL_NAMES: readonly string[] = ["read", "bash"];

/** pi's sentence, which names a tool PTC mode hides. */
const PI_LOAD_INSTRUCTION =
  "Use the read tool to load a skill's file when the task matches its description.";

/** What replaces it: the same instruction, in the only call form this session has. */
export const PTC_SKILL_LOAD_INSTRUCTION =
  "Use tools.read({ path }) inside a ptc_run_code program to load a skill's file when the task matches its description.";

/**
 * Would pi withhold the skills section for this loadout?
 *
 * Mirrors the gate rather than guessing: it is true exactly when neither `read` nor `bash` is
 * directly callable, which is the state the mode deliberately puts an ordinary session in.
 */
export function skillsSectionDropped(visibleTools: readonly string[]): boolean {
  return !SKILL_READING_TOOL_NAMES.some((name) => visibleTools.includes(name));
}

/**
 * Build the `skills` section body (pi wraps it in `<skills>…</skills>` itself).
 *
 * Returns `""` when nothing is advertisable — pi's formatter filters out skills marked
 * `disable-model-invocation`, which is the correct behaviour to inherit: those are
 * `/skill:name`-only by design.
 *
 * `format` is injectable so a test can drive the reworded-header branch without patching pi.
 */
export function buildPtcSkillsSection(
  skills: readonly Skill[],
  format: (skills: Skill[], fileReadTool?: "read" | "bash") => string = formatSkillsForPrompt,
): string {
  const section = format([...skills], "read").trim();
  if (section.length === 0) return "";
  if (section.includes(PI_LOAD_INSTRUCTION)) {
    return section.replace(PI_LOAD_INSTRUCTION, PTC_SKILL_LOAD_INSTRUCTION);
  }
  // pi reworded its header. Keep the list, but never inherit a sentence that names a tool this
  // session cannot call — a wrong instruction is worse than a redundant one.
  return `${PTC_SKILL_LOAD_INSTRUCTION}\n\n${section}`;
}
