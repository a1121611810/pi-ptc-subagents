import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dispatch } from "../src/runtime/dispatch.ts";

describe("dispatch end-to-end smoke", () => {
  test("spawns pi and returns a structured result for a known agent", async () => {
    // Opt-in: this test spawns a real pi subprocess and a real provider call.
    // Run with PT_DISPATCH_E2E=1 PT_SMOKE_MODEL=provider/model to exercise it.
    if (process.env.PT_DISPATCH_E2E !== "1") {
      return;
    }
    const which = spawnSync("which", ["pi"]);
    if (which.status !== 0) {
      console.warn("skipping: pi not on PATH");
      return;
    }
    if (!process.env.PT_SMOKE_MODEL) {
      console.warn("skipping: PT_SMOKE_MODEL not set");
      return;
    }

    const tmp = await mkdtemp(join(tmpdir(), "pi-dispatch-smoke-"));
    const agentsDir = join(tmp, ".pi", "agents");
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
      const result = await dispatch(
        { agent: "smoke-echo", task: "ping" },
        { callId: 1, cwd: tmp, depth: 0, maxDepth: 3, signal: controller.signal },
      );
      expect(result.status).toMatch(/^(fulfilled|rejected)$/);
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.agentName).toBe("smoke-echo");
      if (result.status === "fulfilled") {
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.usage).toBeDefined();
      }
    } finally {
      clearTimeout(timeout);
      await rm(tmp, { recursive: true });
    }
  }, 300_000);
});
