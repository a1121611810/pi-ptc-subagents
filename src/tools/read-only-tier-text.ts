import type { ReadOnlyTier } from "../runtime/dispatch.ts";

/**
 * The read-only tier, as the one line a model reads (ADR-0041).
 *
 * **This module exists because of a cycle, and its shape is the whole reason.**
 * `tools/render.ts` reaches `common.ts` → `bindings.ts` → `dispatch.ts`, and `bindings.ts`
 * imports `dispatch.ts` back as a VALUE, so `render.ts` cannot be imported from a module that
 * `dispatch.ts` reaches — which is `tools/ptc-task.ts`. That cycle has already cost this file
 * seven integration tests once; `src/tools/child-report-tool.ts` records the same lesson for the
 * same pair and hand-rolls its row rather than importing the renderer.
 *
 * So the tier line lives HERE, in a module whose only import is type-only and therefore erased.
 * `render.ts` and `ptc-task.ts` both read it from here, which keeps ONE implementation — the thing
 * the cycle was supposed to avoid duplicating — without either edge closing a loop. If this module
 * ever gains a value import, the cycle is back, and that is the signal to break
 * `common.ts` → `bindings.ts` rather than to inline a second copy.
 */

/** Header for the tier line. */
export const READ_ONLY_TIER_HEADER = "read-only tier";

/** Connector of last child, matching the shape the other model-facing rows use. */
export const TREE_LAST = "└─ ";

/**
 * Render the tier the child actually ran under, or `""` when none was requested.
 *
 * It says what lenient does NOT do. A model told only "lenient" would reasonably assume the write
 * tools were removed, and would then report a guarantee it does not have.
 *
 * The three promises the clause makes are the three a mutation audit showed were unpinned when
 * only its greeting was asserted — see `tests/unit/dispatch-background.test.ts`.
 */
export function renderReadOnlyTierText(tier: ReadOnlyTier | undefined): string {
  if (tier === undefined) return "";
  const row =
    tier === "strict"
      ? "the child's tool list was narrowed to the read set, so it was never offered a write tool"
      : "the child's tool list is UNCHANGED — it was told to work without modifying anything, and " +
        "nothing here prevents it from doing so";
  return `${READ_ONLY_TIER_HEADER} (${tier})\n${TREE_LAST}${row}`;
}
