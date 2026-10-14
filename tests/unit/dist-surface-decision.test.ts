/**
 * The surface DECISION must be reachable from the built artifact, not only from source.
 *
 * `tests/unit/codemode-switch.test.ts` drives `detectedSurfaceMode` against the source module,
 * which is why the decision is covered there. But until this file existed the decision was NOT
 * re-exported from `dist/index.js` - only the factory-level `detectSurfaceMode` was - so no
 * artifact-level probe or integration test could reach it. That gap is what made an earlier
 * prototype substitute a "does pi ship codemode" check for a "what does the decision say" check,
 * and report the subagents branch as nonexistent on the pre-codemode versions.
 *
 * These assertions therefore run against the BUILT dist: the export exists, and the four input
 * combinations decide what the package registers. The decision is a pure function of three probe
 * answers and none of them is "which pi is running", so this holds on every pi version.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const DIST = join(repoRoot, "dist", "index.js");
const distAvailable = existsSync(DIST);

const PRESENT = { present: true as const, how: "found" as const };
const ABSENT = { present: false as const, how: "not-found" as const };

test.skipIf(!distAvailable)("the built dist re-exports detectedSurfaceMode", async () => {
  const mod: Record<string, unknown> = await import(DIST);
  expect(typeof mod.detectedSurfaceMode, "the decision is reachable from the artifact").toBe(
    "function",
  );
  // The factory-level seam stays exported too - production reaches the decision through it.
  expect(typeof mod.detectSurfaceMode).toBe("function");
  expect(typeof mod.probeCodemodePresence).toBe("function");
});

test.skipIf(!distAvailable)(
  "the decision is a pure function of the three probe answers: four combinations",
  async () => {
    const mod: Record<string, unknown> = await import(DIST);
    const decide = mod.detectedSurfaceMode as (
      presence: { present: boolean; how: string },
      sw: string,
      act: string,
    ) => string;

    // The three gates are independent: each one can veto the branch on its own.
    const cases = [
      ["present + enabled + active", PRESENT, "enabled", "active", "subagents"],
      ["absent", ABSENT, "enabled", "active", "full"],
      ["switch disabled", PRESENT, "disabled", "active", "full"],
      ["not active", PRESENT, "enabled", "inactive", "full"],
    ] as const;

    for (const [label, presence, sw, act, expected] of cases) {
      expect(decide(presence, sw, act), label).toBe(expected);
    }

    // And it is total: no combination yields undefined or a third value.
    for (const presence of [PRESENT, ABSENT]) {
      for (const sw of ["absent", "enabled", "disabled"]) {
        for (const act of ["active", "inactive"]) {
          const got = decide(presence, sw, act);
          expect(["full", "subagents"], `${presence.present}/${sw}/${act}`).toContain(got);
        }
      }
    }
  },
);
