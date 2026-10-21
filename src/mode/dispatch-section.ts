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
 * **It is the ROAD INDEX** (ADR-0061): one line per road — when to take it, how to take it on
 * THIS surface, and the file with the whole story. The details are never in the index, and the
 * index carries nothing that varies inside a session, so it is byte-identical from turn to turn
 * (a changed system prompt invalidates the cached prefix).
 *
 * The road for creating a task is the one this section was built for, and it says the one thing
 * the model gets wrong without it: on `codemode_ptc` the PTC door is not in a script's tool table,
 * and the codemode door is.
 *
 * ## The truncated session
 *
 * ADR-0058: `/ptc off` is a truncation of this package's place in the chain, not a switch that
 * leaves a door in place to refuse. The two surfaces lose different things, so this section says
 * two different things — but the one fact they share (no task can be created any more) is ONE
 * constant, carried by this section and by the user's notice alike.
 */
import type { SurfaceMode } from "./ptc-mode.ts";
import {
  PTC_TRUNCATED_SECTION_LINE,
  PTC_TRUNCATION_SECTION_LINES,
  renderRouteIndex,
} from "../routes/registry.ts";

/**
 * The section name pi renders as `<ptc>…</ptc>`.
 *
 * pi validates section names against a lowercase pattern and refuses `preamble`; this one is
 * inside the package's own namespace and collides with none of pi's sections.
 */
export const DISPATCH_SECTION_NAME = "ptc";

/**
 * The one sentence a truncated session says, whichever surface it is (ADR-0058).
 *
 * It lives in the route registry, together with every other piece of model-facing prose this
 * package writes; this module re-exports it for the readers that already import it from here —
 * the user's `/ptc off` notice carries the same sentence, and one sentence in one place is the
 * whole point.
 */
export { PTC_TRUNCATED_NO_NEW_TASK } from "../routes/registry.ts";

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
export { PTC_TRUNCATION_SECTION_LINES };

/**
 * Build the dispatch section body (pi wraps it in `<ptc>…</ptc>` itself).
 *
 * Returns `""` when there is nothing to say, which is the caller's cue to remove the section
 * rather than leave an empty one behind.
 *
 * **The body is the ROUTE INDEX** (ADR-0061): one line per road — when to take it, how to take
 * it on THIS surface, and the file with the whole story. The details are never in the index, and
 * the index carries nothing that varies inside a session, so it is byte-identical from turn to
 * turn (a changed system prompt invalidates the cached prefix).
 *
 * What this module owns is the ORDER and the decision about which of them this session has: the
 * truncated session gets the truncation lines instead of the index, because a model that cannot
 * create a task must not be handed the calling convention for creating one.
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
    return [PTC_TRUNCATED_SECTION_LINE, PTC_TRUNCATION_SECTION_LINES[input.surfaceMode]].join("\n");
  }
  return renderRouteIndex({
    surface: input.surfaceMode,
    childCanSearch: input.childCanSearch,
  });
}
