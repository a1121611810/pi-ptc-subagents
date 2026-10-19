/**
 * The suppressed-`why` line a model reads (ADR-0043).
 *
 * **This module exists for the same reason `read-only-tier-text.ts` does, and the shape is the
 * whole point.** `tools/render.ts` reaches `common.ts` → `bindings.ts` → `dispatch.ts`, and
 * `bindings.ts` imports `dispatch.ts` back as a VALUE, so `render.ts` cannot be imported from a
 * module `dispatch.ts` reaches — which is `tools/ptc-task.ts`. That cycle has already cost seven
 * integration tests once.
 *
 * So this module's imports are TYPE-ONLY and therefore erased, and `render.ts` / `ptc-task.ts` both
 * read the line from here. It deliberately takes a `boolean | undefined` rather than importing
 * `DispatchResult` for a field type: nothing here needs the result, and importing the interface
 * as a value would be the mistake that brings the cycle back.
 */

/** Header for the suppression line. */
export const WHY_SUPPRESSED_HEADER = "why suppressed";

/** Connector of last child, matching the shape the other model-facing rows use. */
export const TREE_LAST = "└─ ";

/**
 * Render "your `why` was not delivered", or `""` when nothing was suppressed.
 *
 * It has to say WHO suppressed it. A caller reading only this line cannot otherwise tell a session
 * that dropped the block on purpose from one that dropped it by a bug, and the first is a
 * configuration the user chose while the second is a defect — two different things to go looking
 * for. Naming the switch is what makes the difference visible from the transcript.
 *
 * It also has to say the child's PROMPT is what changed, not its behaviour: the child was never
 * asked for the caller's reason, so a suppressed `why` cannot have changed what it did. Without
 * that clause a reader could reasonably conclude the child failed to follow an instruction it
 * actually never received.
 */
export function renderWhySuppressedText(suppressed: boolean | undefined): string {
  if (suppressed !== true) return "";
  return (
    `${WHY_SUPPRESSED_HEADER}\n${TREE_LAST}you passed a \`why\` and this session's ` +
    `\`whyEnabled\` switch is off, so the child's prompt carried no <pi-ptc-why> block. ` +
    `The child was never told your reason — it was not ignoring it. The value itself is not ` +
    `recorded anywhere.`
  );
}
