import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { KIMI_MCP_RUN_CODE } from "@pi-ptc/routes";
import { renderToolResult } from "@pi-ptc/output";
import { runPtcProgram } from "@pi-ptc/ptc";
import { createFsBindings } from "./fs-tools.ts";

// Kimi 面（MCP，ADR-0018）：单工具 ptc_run_code。stdout 是 JSON-RPC 通道——本文件不许 console.log
const INPUT_SCHEMA = {
  type: "object",
  required: ["code", "description", "workdir"],
  properties: {
    code: { type: "string", description: KIMI_MCP_RUN_CODE.inputSchemaDescriptions.code },
    description: {
      type: "string",
      description: KIMI_MCP_RUN_CODE.inputSchemaDescriptions.description,
    },
    workdir: { type: "string", description: KIMI_MCP_RUN_CODE.inputSchemaDescriptions.workdir },
    timeoutMs: { type: "number", description: KIMI_MCP_RUN_CODE.inputSchemaDescriptions.timeoutMs },
  },
} as const;

function strField(args: unknown, key: string): string {
  const value = (args as Record<string, unknown>)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

export function createKimiMcpServer(version: string): Server {
  const server = new Server({ name: "ptc-tools", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: KIMI_MCP_RUN_CODE.name,
        description: KIMI_MCP_RUN_CODE.description(),
        inputSchema: INPUT_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params;
    if (params.name !== KIMI_MCP_RUN_CODE.name) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${params.name}` }],
      };
    }
    const args = params.arguments;
    const code = strField(args, "code");
    const workdir = strField(args, "workdir");
    strField(args, "description"); // 只校验存在——pi 面同形，Kimi 面暂无 description 消费方
    const timeoutMs = (args as Record<string, unknown>)?.timeoutMs;
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
      return {
        isError: true,
        content: [{ type: "text", text: "timeoutMs 必须是数字" }],
      };
    }

    const outcome = await runPtcProgram({
      code,
      cwd: workdir,
      timeoutMs,
      bindings: createFsBindings(workdir),
    });
    const { text } = renderToolResult(outcome);
    return {
      content: [{ type: "text", text }],
      isError: outcome.status !== "fulfilled",
    };
  });

  return server;
}

async function main(): Promise<void> {
  const server = createKimiMcpServer("0.0.0");
  await server.connect(new StdioServerTransport());
}

void main();
