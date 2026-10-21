/**
 * The dispatch section: how to reach a child agent, written where the model reads it.
 *
 * ## Why a section and not a tool description
 *
 * Everything this package tells the model about dispatching used to live in the tool
 * descriptions — `ptc_run_code`'s, `ptc_workflow`'s, `ptc_subagent`'s. That works only while the
 * tool carrying the text is itself offered to the model, and on the `subagents` surface it is not:
 * `ptc_run_code` and `ptc_workflow` are registered at `codemode` reach there, so pi does not declare
 * them to the model, and pi's prompt builder collects a tool's guidelines from the DECLARED tools
 * only. Measured 2026-10-20 on that surface: the model's `rules` section carried the guidance for
 * `ptc_subagent` and the three task tools, and carried NOTHING for the pair — so a parent that
 * needed a child had no way to learn the calling convention, wrote `await tools["pi.dispatch"]`
 * into a `codemode` script, and got `TypeError: tools.pi.dispatch does not exist`.
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
 * - `full` — the model writes a program, and the parallel binding lives inside that program.
 * - `subagents` — the model calls the top-level face, and the parallel binding is NOT in a
 *   `codemode` script's tool table. That last sentence is the whole point of this section: it is
 *   the one thing the model gets wrong without it, and the error costs three wasted tool calls.
 *
 * The search sentence is shared by both surfaces, so it is one constant (the same rule the binding
 * contract follows for the two surfaces' copy of one sentence).
 */
import type { SurfaceMode } from "./ptc-mode.ts";

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
 * One constant for both surfaces, because it is ONE sentence in one place — the same rule the
 * binding contract follows for the sentence it puts in both descriptions. It is stated as what this
 * package provides, not as what the model can reach by any means: a session that still has `bash`
 * can always curl, and a sentence claiming the model has no way to the web would be false there.
 */
export const PTC_CHILD_SEARCH_SECTION_LINE: string =
  "This package gives you no web tool of your own: to look something up on the web, dispatch a child " +
  "and let it search — the child has the `web_ds_search` tool.";

/**
 * How to dispatch a child, per surface.
 *
 * `full` names the program form because that is the only form the model has: the two PTC tools are
 * offered to it directly. `subagents` names the top-level face, and says the one thing that is
 * false everywhere else — a `codemode` script's tool table has no `pi.dispatch` in it.
 */
const DISPATCH_LINES: Record<SurfaceMode, string> = {
  full:
    "To dispatch a child, write a program and run it with `ptc_run_code`; inside that program the " +
    'parallel binding is `await tools["pi.dispatch"]({ task })`.',
  subagents:
    "To dispatch a child, call the `ptc_subagent` tool. A `codemode` script's tool table does not " +
    "contain `pi.dispatch` — that name is not a tool there, and calling it from a script fails.",
};

/**
 * The sentence for a session that may not start a new child (ADR-0050).
 *
 * One constant, because it is one sentence in one place. It exists so the model does not spend
 * calls discovering the switch by failing: the refusal carries the same fact, but a model that
 * was told up front does not try.
 */
export const PTC_DISPATCH_DISABLED_SECTION_LINE: string =
  "PTC is off in this session: you cannot start a new child, so do not try to dispatch one.";

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
  // ADR-0050: a session that may not start a child gets the one line that matters, and NOT the
  // calling convention — telling a model how to dispatch when dispatching is refused is an
  // instruction it cannot follow.
  if (!input.dispatchEnabled) return PTC_DISPATCH_DISABLED_SECTION_LINE;
  const lines: string[] = [DISPATCH_LINES[input.surfaceMode]];
  if (input.childCanSearch) lines.push(PTC_CHILD_SEARCH_SECTION_LINE);
  return lines.join("\n");
}
