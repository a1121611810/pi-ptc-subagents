/**
 * The compat matrix's 0.86.1 leg: the bash binding's THROW path honors the failure-message cap.
 *
 * pi 0.86.x has no `AgentToolResult.isError` channel (it arrived in 0.99.0), so a non-zero bash
 * exit THROWS with its full output — the binding wrapper's catch is the only thing between pi's
 * raw failure text and the program, and this file measures that it applies.
 *
 * On pi 1.0.0+ bash itself resolves through `isError`, so THIS file has nothing to measure there:
 * `test.skipIf` reports SKIPPED rather than passing silently (same convention as
 * `codemode-switch-differential.test.ts` for an absent oracle).
 *
 * Scope note, because it reads narrower than the truth: on pi 1.0.0+ the catch is NOT dead code.
 * `bash` is the only builtin that moved onto `isError` — `ls`/`read`/`grep`/`find` still reject
 * there, and the cap covers them on every supported version. That is pinned in
 * `tests/bindings.test.ts` ("the real binding table caps a builtin that REJECTS"), which runs in
 * the DEFAULT gate on every version; this file is the pi-version-specific leg for bash alone.
 *
 * Run as part of the compat matrix's version-sensitive subset (`pnpm run compat:pi`), where the
 * installed pi IS the version under test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createBuiltinBindings } from "../../src/runtime/bindings.ts";
import { installedPiDir } from "../helpers/pi-compat-probe.ts";

/**
 * The installed pi's package root, or `undefined` when no pi is installed.
 *
 * Asked of the one module that answers it for every version-sensitive file in this repo
 * (`tests/helpers/pi-compat-probe.ts`), rather than walked a third time here. This file's whole
 * subject is a property of a PARTICULAR pi's bash, and a local walk is a second opinion about which
 * pi that is — the disagreement this repository is paid to avoid. Same root the differential oracle
 * and the capability probes read, so `skipIf` cannot be reached here while those run.
 */
const PKG_DIR = installedPiDir(import.meta.dirname);

/**
 * Whether the installed bash uses the `isError` channel (pi >= 1.0.0). Decided by reading the
 * INSTALLED artifact, not by comparing version strings: the behavior is what the guard cares
 * about, and a future pi that removes the channel again re-arms this test without an edit here.
 */
function bashUsesIsError(): boolean {
  if (PKG_DIR === undefined) return true; // nothing to measure: skip
  const src = readFileSync(join(PKG_DIR, "dist", "core", "tools", "bash.js"), "utf8");
  return src.includes("isError: true");
}

const THROW_PATH_REACHABLE = PKG_DIR !== undefined && !bashUsesIsError();
const SKIP_REASON =
  "the installed pi's bash resolves failures through the isError channel (pi >= 1.0.0), so the " +
  "throw path this guard measures is unreachable; run via the compat matrix on pi 0.86.x";

test.skipIf(!THROW_PATH_REACHABLE)(
  "a thrown bash failure's rejection is capped: head dropped, exit code kept",
  async () => {
    const HEAD_MARKER = "PTCHEAD0000";
    const TAIL_MARKER = "PTCTAIL9999";
    // 5 KB: under pi's own 50KB output truncation, so what reaches the binding is pi's raw text.
    const payload = HEAD_MARKER + "x".repeat(5000) + TAIL_MARKER;

    const bindings = createBuiltinBindings({ cwd: process.cwd(), optIns: ["bash"] });
    let message = "";
    let rejected = false;
    try {
      await bindings
        .get("bash")
        ?.execute(
          { command: `printf '%s\\n' '${payload}'; exit 3` },
          { callId: 1, depth: 0, maxDispatchDepth: 3 },
        );
    } catch (error) {
      rejected = true;
      message = String((error as Error).message);
    }

    expect(rejected, "pi 0.86.x bash throws on a non-zero exit").toBe(true);
    expect(message.length, "the rejection is capped at the documented length").toBe(
      "bash failed: ".length + 1 + 2000,
    );
    expect(message, "the head is dropped, not the diagnostic").not.toContain(HEAD_MARKER);
    expect(message, "the tail marker survives").toContain(TAIL_MARKER);
    expect(message, "pi's exit-code sentence survives").toContain("Command exited with code 3");
  },
  60_000,
);

test.skipIf(THROW_PATH_REACHABLE)("the guard's oracle is stated when it skips", () => {
  // F4 discipline: a skipped guard must say which pi it measured and why it is inert there, so a
  // reader of green output cannot mistake skip for pass.
  expect(SKIP_REASON).toContain("isError");
  expect(PKG_DIR === undefined || bashUsesIsError()).toBe(true);
});
