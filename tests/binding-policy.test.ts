/**
 * Enablement policy (T7, #21): PTC bindings mirror the session's active built-in tools.
 *
 * These cases drive the real worker through the real dispatcher — the policy is read at
 * execute time from `getBindingSourceNames`, so a restricted session must observe fewer
 * bindings (or none), and never more than it has enabled.
 */
import { expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BUILTIN_BINDING_NAMES } from "../src/runtime/bindings.ts";
import {
  resolveBindingNames,
  resolveDepthFromEnv,
  resolveParentTaskIdFromEnv,
} from "../src/tools/common.ts";
import type { PtcToolDetails } from "../src/tools/common.ts";
import { createPtcRunCodeTool } from "../src/tools/run-code.ts";
import { RUN_TIMEOUT_MS, makeTempDir, removeTempDir, toolContext } from "./helpers/ptc.ts";

test("resolveBindingNames intersects the active set with the built-in factories", () => {
  expect([...resolveBindingNames(undefined)]).toEqual([...BUILTIN_BINDING_NAMES]);
  expect([...resolveBindingNames([])]).toEqual([]);
  expect([...resolveBindingNames(["read", "grep"])]).toEqual(["read", "grep"]);
  expect([...resolveBindingNames(["read", "teleport", "bash"])]).toEqual(["read", "bash"]);
});

test("resolveDepthFromEnv parses PI_PTC_DEPTH (positive integer; invalid or absent → 0)", () => {
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "3" })).toBe(3);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "1" })).toBe(1);
  expect(resolveDepthFromEnv({})).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "x" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "2n" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "-2" })).toBe(0);
  expect(resolveDepthFromEnv({ PI_PTC_DEPTH: "0" })).toBe(0);
});

test("resolveParentTaskIdFromEnv parses PI_PTC_TASK_ID (26-char ULID; invalid or absent → undefined)", () => {
  // The ULID spec's own canonical example is an independent literal (Crockford base32, no I/L/O/U).
  const VALID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: VALID })).toBe(VALID);
  expect(resolveParentTaskIdFromEnv({})).toBeUndefined();
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "" })).toBeUndefined();
  expect(resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "not-a-ulid" })).toBeUndefined();
  // 25 chars (truncated).
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01ARZ3NDEKTSV4RRFFQ69G5FA" }),
  ).toBeUndefined();
  // Lowercase is not the canonical ULID encoding.
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01arz3ndektsv4rrffq69g5fav" }),
  ).toBeUndefined();
  // 'I' is outside the Crockford alphabet.
  expect(
    resolveParentTaskIdFromEnv({ PI_PTC_TASK_ID: "01ARZ3NDEKTSV4RRFFQ69G5FAI" }),
  ).toBeUndefined();
});

function executeTool(
  tool: ToolDefinition<any, any, any>,
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
  async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "data.txt"), "policy-marker\n", "utf8");
      const tool = createPtcRunCodeTool({ getBindingSourceNames: () => ["read"] });

      const allowed = await executeTool(
        tool,
        `const r = await tools.read({ path: "data.txt" }); return r.content.map((p) => p.text ?? "").join("").trim();`,
        dir,
      );
      expect(textOf(allowed)).toBe("policy-marker");

      // The shipped surface always binds pi.dispatch (ADR-0016), so the curated built-in
      // list is what the restriction removes from the error message.
      await expect(
        executeTool(tool, `return await tools.write({ path: "x.txt", content: "nope" });`, dir),
      ).rejects.toThrow(/no binding named "write".*available bindings: read, pi\.dispatch/);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);

test(
  "an empty active set still binds the dispatch surface, and Node and console still work",
  async () => {
    const dir = await makeTempDir();
    try {
      const tool = createPtcRunCodeTool({ getBindingSourceNames: () => [] });

      await expect(
        executeTool(tool, `return await tools.read({ path: "data.txt" });`, dir),
      ).rejects.toThrow(/available bindings: pi\.dispatch/);

      const bare = await executeTool(tool, `console.log("no-tools"); return 40 + 2;`, dir);
      expect(bare.details.result).toBe(42);
      expect(textOf(bare)).toMatch(/no-tools/);
    } finally {
      await removeTempDir(dir);
    }
  },
  RUN_TIMEOUT_MS,
);
