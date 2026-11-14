// pi 面形状的 doc_ds_ocr 包装（宿主中立 OCR 核住 search 包，pi 形状住 entry——kimi-mcp 在自家侧另包 MCP 形态）
// ADR-0003：只在子代理进程注册，父会话不存在
// 文件会离开本机上传到 DeepSeek 侧处理——工具描述必须写明这件事
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { OcrRunContext } from "@pi-ptc/search";
import { runOcr } from "@pi-ptc/search";

export const DOC_DS_OCR_PARAMETERS = Type.Object({
  path: Type.String({ description: "要识别的文件路径（工作区内的 PDF / Word / PPT / 图片）" }),
});

export const DOC_DS_OCR_OUTPUT = Type.Object({
  path: Type.String(),
  pageCount: Type.Integer(),
  pages: Type.Integer(),
  truncated: Type.Boolean(),
  cached: Type.Boolean(),
});

export type DocDsOcrParams = Static<typeof DOC_DS_OCR_PARAMETERS>;

export function createDocDsOcrTool(context: OcrRunContext) {
  return {
    name: "doc_ds_ocr",
    label: "文档识别",
    description:
      "把本地 PDF / Word / PPT / 图片转成文字（DeepSeek OCR，逐页返回；文件会上传到 DeepSeek 侧处理，本机不留副本）。只允许工作区内的文件；同一份文件重复识别不重复计费。模型自带联网搜索时别用它——那会重复检索并重复计费。",
    parameters: DOC_DS_OCR_PARAMETERS,
    outputSchema: DOC_DS_OCR_OUTPUT,
    execute: async (_id: string, args: DocDsOcrParams): Promise<AgentToolResult> => {
      const result = await runOcr(args.path, context);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          path: args.path,
          pageCount: result.pageCount,
          pages: result.pages,
          truncated: result.truncated,
          cached: result.cached,
        },
        isError: false,
      };
    },
  };
}
