import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIMI_MCP_TOOLS } from "@pi-ptc/routes";
import { renderToolResult } from "@pi-ptc/output";
import { runPtcProgram } from "@pi-ptc/ptc";
import {
  createDeepSeekProvider,
  createSearchMemory,
  createSearchQuota,
  runWebSearch,
  type SearchRunContext,
} from "@pi-ptc/search";
import { createFsBindings } from "./fs-tools.ts";

// Kimi 面（MCP，ADR-0020）：工具表唯一出处 = 册子 KIMI_MCP_TOOLS。stdout 是 JSON-RPC 通道——本文件不许 console.log
const RUN_CODE_SCHEMA = {
  type: "object",
  required: ["code", "description", "workdir"],
  properties: {
    code: { type: "string", description: KIMI_MCP_TOOLS.ptc_run_code.inputSchemaDescriptions.code },
    description: {
      type: "string",
      description: KIMI_MCP_TOOLS.ptc_run_code.inputSchemaDescriptions.description,
    },
    workdir: {
      type: "string",
      description: KIMI_MCP_TOOLS.ptc_run_code.inputSchemaDescriptions.workdir,
    },
    timeoutMs: {
      type: "number",
      description: KIMI_MCP_TOOLS.ptc_run_code.inputSchemaDescriptions.timeoutMs,
    },
  },
} as const;

const WEB_DS_SEARCH_SCHEMA = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["search", "open", "find"],
      description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.action,
    },
    query: {
      type: "string",
      description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.query,
    },
    url: { type: "string", description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.url },
    pattern: {
      type: "string",
      description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.pattern,
    },
    count: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: KIMI_MCP_TOOLS.web_ds_search.inputSchemaDescriptions.count,
    },
  },
} as const;

// 搜索上下文：每 server 进程一份（记忆/配额都是 per-process 语义，与 pi 面孩子进程同款）
// shortcut: 默认 30 次/进程沿用旧实现值，未实测校准；0 = 不限。缺 key 也注册——调用返回可读错误（fail-soft）

// key 三级解析的 Kimi 版（pi 面是 auth.json→models.json→env，这里是 env→宿主 config.toml）：
// 复用 Kimi Code 已配置的 DeepSeek provider，用户不用为插件再配一遍
function resolveDeepSeekApiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const home = process.env.KIMI_CODE_HOME ?? join(process.env.HOME ?? "", ".kimi-code");
    const config = readFileSync(join(home, "config.toml"), "utf8");
    const section = config.match(/\[providers\."?deepseek"?\][^\n]*\n([\s\S]*?)(?=\n\[|$)/i);
    // 锚行首：注释掉的 api_key（# 开头）不许被捡起来——「注释即停用」是用户的直觉
    const key = section?.[1]?.match(/^[ \t]*api_key\s*=\s*"([^"]+)"/m)?.[1];
    if (key) return key;
  } catch {
    // 配置不可读就落 missing-key，由 fail-soft 承接
  }
  return "missing-key";
}

function createSearchContext(): SearchRunContext {
  return {
    provider: createDeepSeekProvider(resolveDeepSeekApiKey()),
    memory: createSearchMemory(),
    quota: createSearchQuota(30),
  };
}

function strField(args: unknown, key: string): string {
  const value = (args as Record<string, unknown>)?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value;
}

async function runCodeTool(args: unknown) {
  const code = strField(args, "code");
  const workdir = strField(args, "workdir");
  strField(args, "description"); // 只校验存在——Kimi 面暂无 description 消费方
  const timeoutMs = (args as Record<string, unknown>)?.timeoutMs;
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    return { isError: true, content: [{ type: "text", text: "timeoutMs 必须是数字" }] };
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
}

async function webDsSearchTool(args: unknown, context: SearchRunContext) {
  const action = strField(args, "action");
  if (action !== "search" && action !== "open" && action !== "find") {
    return { isError: true, content: [{ type: "text", text: "action 必须是 search/open/find" }] };
  }
  if (action === "search" && typeof (args as Record<string, unknown>)?.query !== "string") {
    return { isError: true, content: [{ type: "text", text: "search 动作需要 query" }] };
  }
  if (action !== "search" && typeof (args as Record<string, unknown>)?.url !== "string") {
    return { isError: true, content: [{ type: "text", text: `${action} 动作需要 url` }] };
  }
  const count = (args as Record<string, unknown>)?.count;
  if (
    count !== undefined &&
    (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 50)
  ) {
    return { isError: true, content: [{ type: "text", text: "count 必须是 1–50 的整数" }] };
  }
  const result = await runWebSearch(
    action === "search"
      ? {
          kind: "search",
          query: String((args as Record<string, unknown>).query),
          count: count as number | undefined,
        }
      : action === "open"
        ? { kind: "open", url: String((args as Record<string, unknown>).url) }
        : {
            kind: "find",
            url: String((args as Record<string, unknown>).url),
            pattern: String((args as Record<string, unknown>).pattern ?? ""),
          },
    context,
  );
  return {
    content: [{ type: "text", text: result.ok ? result.text : result.error }],
    isError: !result.ok,
  };
}

export function createKimiMcpServer(version: string): Server {
  const server = new Server({ name: "ptc-tools", version }, { capabilities: { tools: {} } });
  const searchContext = createSearchContext();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: KIMI_MCP_TOOLS.ptc_run_code.name,
        description: KIMI_MCP_TOOLS.ptc_run_code.description(),
        inputSchema: RUN_CODE_SCHEMA,
      },
      {
        name: KIMI_MCP_TOOLS.web_ds_search.name,
        description: KIMI_MCP_TOOLS.web_ds_search.description(),
        inputSchema: WEB_DS_SEARCH_SCHEMA,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const params = request.params;
    try {
      if (params.name === KIMI_MCP_TOOLS.ptc_run_code.name) {
        return await runCodeTool(params.arguments);
      }
      if (params.name === KIMI_MCP_TOOLS.web_ds_search.name) {
        return await webDsSearchTool(params.arguments, searchContext);
      }
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${params.name}` }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createKimiMcpServer("0.0.0");
  await server.connect(new StdioServerTransport());
}

void main();
