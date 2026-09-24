/**
 * Differential test for the two ADR-0015 truncation call sites (R-m13 / R2-3).
 *
 * ADR-0015 §1/§2 define one truncation contract: keep the tail (50 KB / 2000 lines) and point at
 * the untruncated text, which must have been written to a real file first. Before R-m13 two copies
 * implemented it — `src/tools/common.ts`'s run-scale text block and
 * `src/runtime/output-storage.ts`'s task-scale dereference — with only the temp-file prefix
 * differing. This is the differential oracle (docs/testing-constraints.md #4/#5): for the same
 * input and the same cut, the two call sites must end in the *same* `[Showing …]` footer modulo
 * their own temp path, and each must name a file that reads back byte-for-byte as the input. Making
 * one writer diverge (or writing anything but the whole input) turns this red.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { applyAdr0015Truncation } from "../../src/runtime/output-storage.ts";
import { renderToolResult } from "../../src/tools/common.ts";

/** Temp full-output files written by these tests; unlinked after each test. */
const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined && existsSync(path)) unlinkSync(path);
  }
});

/**
 * The three text shapes that exercise truncateTail's three footer branches. Every char is ASCII
 * (`x`/`y`/`z` and `\n`), so `sanitizeText` is the identity and the run-scale file must
 * read back as the exact input — an independent literal, not an implementation read-back.
 */
const LINE_CUT_INPUT = Array.from({ length: 3000 }, (_, index) => `line-${index}`).join("\n");
const BYTE_CUT_INPUT = Array.from({ length: 40 }, () => "y".repeat(2000)).join("\n");
const OVERSIZED_LINE_INPUT = "z".repeat(DEFAULT_MAX_BYTES + 1);

/** The run-scale text block's model-facing text. */
function textBlockOf(rendered: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
  const block = rendered.content[0];
  if (block === undefined || block.type !== "text" || block.text === undefined) {
    throw new Error("expected a text content block");
  }
  return block.text;
}

/** The trailing `[Showing …]` footer, located by its literal prefix (the ADR-0015 wording). */
function footerOf(text: string): string {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("[Showing ");
  if (start < 0) {
    throw new Error("no [Showing …] footer in: " + trimmed.slice(-200));
  }
  return trimmed.slice(start);
}

/** Normalize the one intended difference (the temp path) out of a footer before comparing. */
function withoutTempPath(footer: string): string {
  return footer.replace(/Full output: .*\]$/, "Full output: <temp>]");
}

function assertSitesAgree(input: string): void {
  const rendered = renderToolResult({
    outcome: { logs: [input], narrations: [], phases: [] },
    surface: "run_code",
    durationMs: 1,
  });
  const task = applyAdr0015Truncation(input);

  expect(rendered.details.fullOutputPath).toBeDefined();
  expect(task.truncated).toBe(true);
  expect(task.fullPath).toBeDefined();

  const runPath = rendered.details.fullOutputPath as string;
  const taskPath = task.fullPath as string;
  tempPaths.push(runPath, taskPath);

  // Differential: identical footer wording for the identical cut, modulo the temp path.
  expect(withoutTempPath(footerOf(textBlockOf(rendered)))).toBe(
    withoutTempPath(footerOf(task.text)),
  );

  // Provenance: both pointers name a real file that round-trips the untruncated input.
  expect(readFileSync(runPath, "utf8")).toBe(input);
  expect(readFileSync(taskPath, "utf8")).toBe(input);

  // The only intended difference is the prefix: ADR-0015 §2 run-scale vs ADR-0022 §3 task-scale.
  expect(basename(runPath).startsWith("pi-ptc-output-")).toBe(true);
  expect(basename(taskPath).startsWith("pi-ptc-task-output-")).toBe(true);
}

describe("ADR-0015 truncation: run-scale and task-scale call sites agree (R-m13)", () => {
  test("line-cut branch: same footer, both files round-trip the input", () => {
    assertSitesAgree(LINE_CUT_INPUT);
  });

  test("byte-cut branch: same footer, both files round-trip the input", () => {
    assertSitesAgree(BYTE_CUT_INPUT);
  });

  test("single oversized-line branch: same footer, both files round-trip the input", () => {
    assertSitesAgree(OVERSIZED_LINE_INPUT);
  });
});
