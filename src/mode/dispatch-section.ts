/**
 * The task section: how to create a task, written where the model reads it.
 *
 * ## Why a section and not a tool description
 *
 * Everything this package tells the model about creating a task used to live in the tool
 * descriptions — `ptc_run_code`'s, `ptc_workflow`'s, and the codemode door's. That works only
 * while the tool carrying the text is itself offered to the model, and on the `codemode_ptc`
 * surface it is not: `ptc_run_code` and `ptc_workflow` are registered at `codemode` reach there,
 * so pi does not declare them to the model, and pi's prompt builder collects a tool's guidelines
 * from the DECLARED tools only. Measured 2026-10-20 on that surface: the model's `rules` section
 * carried the guidance for the codemode door and the three task tools, and carried NOTHING for
 * the pair — so a parent that needed a child had no way to learn the calling convention, wrote
 * `await tools["pi.dispatch"]` into a `codemode` script, and got
 * `TypeError: tools.pi.dispatch does not exist`.
 *
 * A section does not have that dependency. pi merges every custom section into the system prompt
 * unconditionally (`dist/core/system-prompt.js`: the custom sections are copied over the built-in
 * ones after they are built), so the text reaches the model on every surface and in every run mode.
 * The same seam already carries the skills section back for PTC mode.
 *
 * ## What it says, and why it is not a summary of the tool descriptions
 *
 * One fact per surface, phrased as the CALL the model makes, not as a description of a tool:
 *
 * - `full_ptc` — the model writes a program, and the PTC door lives inside that program.
 * - `codemode_ptc` — the model calls the codemode door from its script, and the PTC door is NOT
 *   in a `codemode` script's tool table. That last sentence is the whole point of this section:
 *   it is the one thing the model gets wrong without it, and the error costs three wasted tool
 *   calls.
 *
 * The search sentence is shared by both surfaces, so it is one constant (the same rule the binding
 * contract follows for the two surfaces' copy of one sentence).
 *
 * ## The truncated session
 *
 * ADR-0058: `/ptc off` is a truncation of this package's place in the chain, not a switch that
 * leaves a door in place to refuse. The two surfaces lose different things, so this section says
 * two different things — but the one fact they share (no task can be created any more) is ONE
 * constant, carried by this section and by the user's notice alike.
 */
import type { SurfaceMode } from "./ptc-mode.ts";
import { PTC_CHILD_SEARCH_NOTE } from "../search/contract.ts";

/**
 * The section name pi renders as `<ptc>…</ptc>`.
 *
 * pi validates section names against a lowercase pattern and refuses `preamble`; this one is
 * inside the package's own namespace and collides with none of pi's sections.
 */
export const DISPATCH_SECTION_NAME = "ptc";

/**
 * The sentence both surfaces share: the parent has no web tool of this package's own, and the
 * child is where the web is.
 *
 * **It is the search module's own constant, not a copy of it** (`PTC_CHILD_SEARCH_NOTE`), and
 * that is the point: the same fact reaches the model through three surfaces — the two PTC tool
 * descriptions, this section, and the mode briefing — and a copy here would be a fourth wording
 * of a sentence that has to mean one thing.
 *
 * The wording is the search module's because the module owns the claim: it is stated as what
 * this package PROVIDES, not as what the model can reach by any means (a session that still has
 * `bash` can always curl).
 */

/**
 * How to create a task, per surface.
 *
 * `full_ptc` names the program form because that is the only form the model has: the two PTC
 * tools are offered to it directly. `codemode_ptc` names the codemode door, and says the one
 * thing that is false everywhere else — a `codemode` script's tool table has no `pi_task_ptc`
 * in it.
 *
 * ADR-0052: the model-facing word is TASK, never "dispatch" — the door creates a task, and
 * dispatching is what the task side does with it afterwards. Both names are plain JavaScript
 * identifiers, so both planes call them with a dot.
 */
const DISPATCH_LINES: Record<SurfaceMode, string> = {
  full_ptc:
    "To create a task, write a program and run it with `ptc_run_code`; inside that program the " +
    "binding is `await tools.pi_task_ptc({ task })`.",
  codemode_ptc:
    "To create a task, call `tools.pi_task_codemode` from your `codemode` script. A `codemode` " +
    "script's tool table does not contain `pi_task_ptc` — that name is not a tool there, and " +
    "calling it from a script fails.",
};

/**
 * The one sentence a truncated session says, whichever surface it is (ADR-0058).
 *
 * One constant, because it is ONE sentence in one place — and it is carried by BOTH the model's
 * section and the user's notice, so the two cannot drift into telling the model one thing and the
 * user another.
 *
 * It states the fact and nothing about how it happened: the switch withdraws this package's
 * segment of the chain, and what that means for the model is the same on both surfaces — no task
 * can be created any more.
 */
export const PTC_TRUNCATED_NO_NEW_TASK: string = "No new task can be created from here on.";

/**
 * What each surface lost, and what is left (ADR-0058).
 *
 * The two lines differ because the two surfaces truncate at different places, and the difference
 * is not cosmetic: on `full_ptc` there is no orchestrator left at all, while on `codemode_ptc`
 * pi's `codemode` keeps orchestrating and only this package's segment under it is gone.
 *
 * The withdrawn tools are NAMED, because a model that saw them a turn ago needs to know they are
 * gone rather than keep calling into a tool that is no longer there. What is not given is the
 * calling convention — telling a model HOW to create a task in a session where it cannot is an
 * instruction it cannot follow (ADR-0050 decision 6).
 */
export const PTC_TRUNCATION_SECTION_LINES: Record<SurfaceMode, string> = {
  full_ptc:
    "The PTC program tools (`ptc_run_code`, `ptc_workflow`) are withdrawn — there is no " +
    "orchestrator left, so the built-in tools are what the model calls now.",
  codemode_ptc:
    "The PTC execution layer (`ptc_run_code`, `ptc_workflow`) and the task door " +
    "(`pi_task_codemode`) are withdrawn — `codemode` still orchestrates, but it can no longer " +
    "create a task.",
};

/**
 * Build the dispatch section body (pi wraps it in `<ptc>…</ptc>` itself).
 *
 * Returns `""` when there is nothing to say, which is the caller's cue to remove the section
 * rather than leave an empty one behind.
 */
export function buildDispatchSection(input: {
  surfaceMode: SurfaceMode;
  childCanSearch: boolean;
  dispatchEnabled: boolean;
}): string {
  // ADR-0058: a truncated session gets the shared fact and what THIS surface lost. The calling
  // convention is NOT given — a model cannot create a task here, so there is nothing to teach it
  // — and the search sentence goes with it: "create a task and let the child search" is exactly
  // the thing that cannot happen right now.
  if (!input.dispatchEnabled) {
    return [
      "PTC is off in this session. " + PTC_TRUNCATED_NO_NEW_TASK + " Do not try to create one.",
      PTC_TRUNCATION_SECTION_LINES[input.surfaceMode],
    ].join("\n");
  }
  const lines: string[] = [DISPATCH_LINES[input.surfaceMode]];
  if (input.childCanSearch) lines.push(PTC_CHILD_SEARCH_NOTE);
  return lines.join("\n");
}
