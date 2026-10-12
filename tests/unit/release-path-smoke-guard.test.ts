/**
 * Guard: the smoke test is on the release path, and this file is what makes that a FACT rather
 * than an assumption.
 *
 * Spec axis, round 1, blocking finding: `grep "subagent-smoke"` outside the file itself returned
 * zero hits, `doc-integrity` pins no test-file list, and narrowing `vitest.config.ts` to
 * `tests/unit/**` left 615 tests passing with 0 failures. So the guardrail that was supposed to
 * make "unusable in a real install" undeletable was itself deletable — silently, and with a green
 * suite. That is the same shape as the defect it was written for: a check that is declared and
 * cannot fail.
 *
 * This is the inverse assertion. It does not check that the smoke test works (the smoke test
 * checks that); it checks that the smoke test is still RUN, which is the one thing about it that
 * a reviewer cannot see by reading it.
 */

import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), "utf8");
}

describe("the smoke test is on the release path", () => {
  test("vitest collects tests/e2e", async () => {
    const config = await read("vitest.config.ts");
    // A glob that still reaches e2e. Narrowing it to `tests/unit/**` is the mutation this
    // exists to catch: with that, the smoke test stops running and nothing goes red.
    expect(config, "e2e is collected").toMatch(/tests\/\*\*|tests\/\*\*/);
    expect(config, "and not narrowed away").not.toMatch(/tests\/unit\/\*\*/);
  });

  test("the release script runs the test suite", async () => {
    const pkg = JSON.parse(await read("package.json")) as {
      scripts?: Record<string, string>;
    };
    const release = pkg.scripts?.["prepublishOnly"] ?? "";
    // The publish gate has to invoke the suite for any of this to mean anything. Asserted on the
    // script NAME rather than the whole chain so reordering the gates does not make this red.
    expect(release, "publishing runs the tests").toMatch(/\btest\b/);
  });

  test("the smoke test file exists at the path this guard names", async () => {
    // If someone renames or deletes it, this goes red rather than leaving the guards above
    // cheerfully asserting properties of a file that is no longer run.
    const smoke = await read("tests/e2e/subagent-smoke.test.ts");
    expect(smoke, "it is the real-subprocess smoke test, not a stub").toContain("withFakePi");
    expect(smoke, "and it exercises a real child").toContain("DispatchSlotCounter");
  });
});
