// Kimi 面散文：工具描述的唯一出处是册子（routes 的 KIMI_MCP_TOOLS）——server 逐字照抄，事实不许丢。
// 探针直接打产物（packages/routes/dist/index.js 与 packages/kimi-mcp/dist/server.js）。
// 门禁两向：① server ↔ 册子逐字一致 ② 册子自身完整（描述非空、在预算内、字段有描述、名字钉死）。
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { KIMI_MCP_TOOLS } from "../../packages/routes/dist/index.js";
import { startMcpClient, type McpClient } from "../helpers/mcp-client.ts";

const SERVER = fileURLToPath(new URL("../../packages/kimi-mcp/dist/server.js", import.meta.url));
const SKILL = fileURLToPath(
  new URL("../../packages/routes/docs/kimi-ptc/SKILL.md", import.meta.url),
);
// 单工具描述的启发式预算（中英混排 2 字符/token）——详情挪进 SKILL.md
const DESCRIPTION_TOKEN_BUDGET = 400;

interface RegistryEntry {
  name: string;
  description: (opts?: { noSkimp?: boolean }) => string;
  inputSchemaDescriptions: Record<string, string>;
}

const entries = Object.values(KIMI_MCP_TOOLS) as unknown as RegistryEntry[];
const entryOf = (name: string) => entries.find((entry) => entry.name === name)!;

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { description?: string }>; required: string[] };
}

// 起一个隔离配置的 server（KIMI_CODE_HOME 指向空目录：用户真开着 noSkimpPtc 时描述会多一段）
async function withServer(fn: (client: McpClient) => Promise<void>, home?: string): Promise<void> {
  const saved = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home ?? mkdtempSync(join(tmpdir(), "ptc-kimi-home-"));
  const client = startMcpClient(SERVER);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "0" },
    });
    client.notify("notifications/initialized");
    await fn(client);
  } finally {
    client.stop();
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
  }
}

const listTools = async (client: McpClient) =>
  (await client.request("tools/list")) as { tools: ListedTool[] };

it("册子自检：每条 Kimi 工具描述非空且在 token 预算内", () => {
  for (const entry of entries) {
    const description = entry.description();
    expect(description.length).toBeGreaterThan(20);
    expect(Math.ceil(description.length / 2)).toBeLessThanOrEqual(DESCRIPTION_TOKEN_BUDGET);
    for (const [field, text] of Object.entries(entry.inputSchemaDescriptions)) {
      expect(text.length, `${entry.name}.${field} 缺描述`).toBeGreaterThan(4);
    }
  }
});

it("server 工具描述逐字等于册子渲染", async () => {
  await withServer(async (client) => {
    const { tools } = await listTools(client);
    for (const tool of tools) {
      expect(tool.description).toBe(entryOf(tool.name).description());
    }
  });
});

it("schema 字段描述逐字等于册子", async () => {
  await withServer(async (client) => {
    const { tools } = await listTools(client);
    for (const tool of tools) {
      const entry = entryOf(tool.name);
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(schema.description).toBe(entry.inputSchemaDescriptions[field]);
      }
      for (const field of tool.inputSchema.required) {
        expect(tool.inputSchema.properties[field]?.description).toBeTruthy();
      }
    }
  });
});

it("双向覆盖：server 工具名与册子逐名相等", async () => {
  await withServer(async (client) => {
    const { tools } = await listTools(client);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      entries.map((entry) => entry.name).sort(),
    );
  });
});

it("工具名显式列举：三个 Kimi 工具名钉死", () => {
  expect(entries.map((entry) => entry.name).sort()).toEqual([
    "doc_ds_ocr",
    "ptc_run_code",
    "web_ds_search",
  ]);
});

it("上传事实：doc_ds_ocr 描述写明文件会上传到 DeepSeek 侧", () => {
  expect(entryOf("doc_ds_ocr").description()).toMatch(/上传到 DeepSeek 侧/);
});

it("二选一提示：web_ds_search 与 doc_ds_ocr 都写明重复计费", () => {
  expect(entryOf("web_ds_search").description()).toMatch(/重复计费/);
  expect(entryOf("doc_ds_ocr").description()).toMatch(/重复计费/);
});

it("别省真跑开关：noSkimpPtc=true ⇒ ptc_run_code 描述多一段（仍在预算内）", async () => {
  const home = mkdtempSync(join(tmpdir(), "ptc-kimi-token-home-"));
  writeFileSync(join(home, "ptc.json"), JSON.stringify({ noSkimpPtc: true }));
  await withServer(async (client) => {
    const { tools } = await listTools(client);
    const runCode = tools.find((tool) => tool.name === "ptc_run_code")!;
    expect(runCode.description).toContain("Do not skimp on the real run");
    expect(runCode.description).toBe(entryOf("ptc_run_code").description({ noSkimp: true }));
    expect(Math.ceil(runCode.description.length / 2)).toBeLessThanOrEqual(DESCRIPTION_TOKEN_BUDGET);
  }, home);
});

it("SKILL.md 按名字引用三个工具（名字漂移就对不上）", () => {
  const skill = readFileSync(SKILL, "utf8");
  // 名字钉死在这里（不取册子的当前值）：册子改名时这条要绿，红的是「工具名显式列举」那条
  for (const name of ["doc_ds_ocr", "ptc_run_code", "web_ds_search"]) {
    expect(skill).toContain(name);
  }
});
