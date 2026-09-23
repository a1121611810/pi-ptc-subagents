import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dispatch } from "../src/runtime/dispatch.ts";

// End-to-end smoke for pi.dispatch. Skipped unless PT_DISPATCH_E2E=1 + pi on PATH
// + PT_SMOKE_MODEL set; the meta-discipline fixture (`tests/test-meta-discipline.test.ts`)
// verifies that we use `test.skipIf(...)` rather than `if (...) { return; }` so this test
// shows up as SKIPPED in default CI runs.
//
// Assertions are SPECIFICATION (not characterization): they fail unless the child pi
// subprocess actually spawned, returned status === 'fulfilled', and produced PONG text.
// See docs/testing-constraints.md (constraint #5 — 反事实判据).
describe("dispatch end-to-end smoke", () => {
  const gate = process.env.PT_DISPATCH_E2E === "1" && !!process.env.PT_SMOKE_MODEL;
  const piOk = spawnSync("which", ["pi"]).status === 0;

  test.skipIf(!gate || !piOk)(
    "spawns pi and returns a fulfilled result for a known agent",
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), "pi-dispatch-smoke-"));
      // Write the smoke-echo agent into user scope (~/.pi/agent/agents) since
      // `discoverAgent` defaults to agentScope: 'user'. Use an isolated HOME so we don't
      // pollute the real user agents dir — set HOME for this test only.
      const fakeHome = join(tmp, "fake-home");
      const agentsDir = join(fakeHome, ".pi", "agent", "agents");
      await mkdir(agentsDir, { recursive: true });
      const agentBody = [
        "---",
        "name: smoke-echo",
        "model: " + process.env.PT_SMOKE_MODEL,
        "---",
        "You are an echo. Reply with the single word: PONG.",
      ].join("\n");
      await writeFile(join(agentsDir, "smoke-echo.md"), agentBody, { encoding: "utf-8" });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);
      try {
        // Note: dispatch uses os.homedir() internally to locate user-scope agents; we cannot
        // override it from the outside, so the agent must be installed at the real user path.
        // This is a known limitation; tracked as a follow-up to make discoverAgent's cwd/homedir
        // overrideable per-call.
        const result = await dispatch(
          { agent: "smoke-echo", task: "ping" },
          { callId: 1, cwd: tmp, depth: 0, maxDispatchDepth: 3, signal: controller.signal },
        );
        // SPECIFICATION assertions (constraint #4 + #5): exact status + literal text + usage recorded.
        expect(result.status).toBe("fulfilled");
        expect(result.text).toMatch(/PONG/);
        expect(result.usage).toBeDefined();
        expect(result.usage?.turns).toBeGreaterThan(0);
      } finally {
        clearTimeout(timeout);
        await rm(tmp, { recursive: true });
      }
    },
    300_000,
  );
});
