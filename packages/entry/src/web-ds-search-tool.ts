// pi 面形状的 web_ds_search 包装（P2 过河：宿主中立搜索核住 search 包，pi 形状住 entry——kimi-mcp 在自家侧另包 MCP 形态）
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { SearchRunContext } from "@pi-ptc/search";
import { runWebSearch } from "@pi-ptc/search";

export const WEB_DS_SEARCH_PARAMETERS = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("open"), Type.Literal("find")]),
  query: Type.Optional(Type.String({ description: "search：搜索词" })),
  url: Type.Optional(Type.String({ description: "open/find：目标页面 url" })),
  pattern: Type.Optional(Type.String({ description: "find：页内行匹配（正则）" })),
  count: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "search：条数 1–50，默认 10" }),
  ),
});

export type WebDsSearchParams = Static<typeof WEB_DS_SEARCH_PARAMETERS>;

// ADR-0003：web_ds_search——只在子代理进程注册（entry 的子代理进程模式），父会话不存在
export function createWebDsSearchTool(context: SearchRunContext) {
  return {
    name: "web_ds_search",
    label: "联网搜索",
    description:
      "联网能力（三动作）：search 概览（title/url/snippet）· open 抓整页 · find 页内行匹配。open/find 命中最近记忆则免费。配额按每进程计。",
    parameters: WEB_DS_SEARCH_PARAMETERS,
    execute: async (_id: string, args: WebDsSearchParams): Promise<AgentToolResult> => {
      const action =
        args.action === "search"
          ? ({ kind: "search", query: args.query ?? "", count: args.count } as const)
          : args.action === "open"
            ? ({ kind: "open", url: args.url ?? "" } as const)
            : ({ kind: "find", url: args.url ?? "", pattern: args.pattern ?? "" } as const);
      if (action.kind === "search" && action.query === "") {
        return {
          content: [{ type: "text", text: "search 动作需要 query" }],
          details: undefined,
          isError: true,
        };
      }
      if (action.kind !== "search" && action.url === "") {
        return {
          content: [{ type: "text", text: `${action.kind} 动作需要 url` }],
          details: undefined,
          isError: true,
        };
      }
      const result = await runWebSearch(action, context);
      return {
        content: [{ type: "text", text: result.ok ? result.text : result.error }],
        details: undefined,
        isError: !result.ok,
      };
    },
  };
}
