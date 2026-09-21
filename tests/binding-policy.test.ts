/**
 * Enablement policy (T7, #21): PTC bindings mirror the session's active built-in tools.
 *
 * These cases drive the real worker through the real dispatcher — the policy is read at
 * execute time from `getActiveToolNames`, so a restricted session must observe fewer
 * bindings (or none), and never more than it has enabled.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BUILTIN_BINDING_NAMES } from "../src/runtime/bindings.ts";
import { resolveBindingNames } from "../src/tools/common.ts";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import { RUN_TIMEOUT_MS, makeTempDir, removeTempDir, toolContext } from "./helpers/ptc.ts";

test("resolveBindingNames intersects the active set with the built-in factories", () => {
  assert.deepEqual([...resolveBindingNames(undefined)], [...BUILTIN_BINDING_NAMES]);
  assert.deepEqual([...resolveBindingNames([])], []);
  assert.deepEqual([...resolveBindingNames(["read", "grep"])], ["read", "grep"]);
  assert.deepEqual(
    [...resolveBindingNames(["read", "teleport", "bash"])],
    ["read", "bash"],
    "names outside the factory set are ignored",
  );
});

function executeTool(
  tool: ToolDefinition,
  code: string,
  cwd: string,
): Promise<AgentToolResult<PtcToolDetails>> {
  return tool.execute(
    "call-policy",
    { code, description: "binding policy test" },
    undefined,
    undefined,
    toolContext(cwd),
  ) as Promise<AgentToolResult<PtcToolDetails>>;
}

function textOf(result: AgentToolResult<PtcToolDetails>): string {
  return result.content
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

test(
  "a restricted session can only reach its active tools",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "data.txt"), "policy-marker\n", "utf8");
      const tool = createPtcRunCodeTool({ getActiveToolNames: () => ["read"] });

      const allowed = await executeTool(
        tool,
        `const r = await tools.read({ path: "data.txt" }); return r.content.map((p) => p.text ?? "").join("").trim();`,
        dir,
      );
      assert.equal(textOf(allowed), "policy-marker");

      await assert.rejects(
        executeTool(tool, `return await tools.write({ path: "x.txt", content: "nope" });`, dir),
        /no binding named "write".*available bindings: read/,
        "an unbound tool must reject with the available names",
      );
    } finally {
      await removeTempDir(dir);
    }
  },
);

test(
  "an empty active set yields no bindings, yet Node and console still work",
  { timeout: RUN_TIMEOUT_MS },
  async () => {
    const dir = await makeTempDir();
    try {
      const tool = createPtcRunCodeTool({ getActiveToolNames: () => [] });

      await assert.rejects(
        executeTool(tool, `return await tools.read({ path: "data.txt" });`, dir),
        /available bindings: \(none\)/,
      );

      const bare = await executeTool(tool, `console.log("no-tools"); return 40 + 2;`, dir);
      assert.equal(bare.details.result, 42, "the program still runs without bindings");
      assert.match(textOf(bare), /no-tools/);
    } finally {
      await removeTempDir(dir);
    }
  },
);
