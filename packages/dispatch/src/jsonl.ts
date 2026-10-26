import type { ChildReport } from "./report.ts";

// pi --mode json 的事件流（v3，2026-10-26 实测）：message_end 带最终文本与 usage；toolResult 消息带 toolName/details
export interface ParsedChildStream {
  /** 最后一条 assistant 消息的文本部分（「最后一段胜出」） */
  text: string;
  /** 工具通道读到的报告（ptc_child_report 的 toolResult） */
  toolReport: ChildReport | null;
  /** 宿主侧 message_end 上报的 usage（ADR-0044 的 observed 一半） */
  observedUsage: { input?: number; output?: number; cost?: number; turns?: number } | null;
  /** ADR-0045：流里实测到的孩子模型/provider */
  observedModel: string | null;
  observedProvider: string | null;
}

interface JsonlMessage {
  role?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input?: number; output?: number; cost?: { total?: number } | number };
  details?: unknown;
  structuredContent?: unknown;
}

export function parseChildStream(stdout: string): ParsedChildStream {
  let text = "";
  let toolReport: ChildReport | null = null;
  let observedUsage: ParsedChildStream["observedUsage"] = null;
  let observedModel: string | null = null;
  let observedProvider: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: { type?: string; message?: JsonlMessage };
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || !event.message) continue;
    const message = event.message;
    if (message.role === "assistant") {
      if (typeof message.model === "string") observedModel = message.model;
      if (typeof message.provider === "string") observedProvider = message.provider;
      // content 形状随 pi 版本变：非数组按「没有文本」跳过，不让单个畸形事件毒化整次解析
      const parts = Array.isArray(message.content) ? message.content : [];
      text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("\n");
      if (message.usage) {
        const cost =
          typeof message.usage.cost === "number" ? message.usage.cost : message.usage.cost?.total;
        observedUsage = {
          input: message.usage.input,
          output: message.usage.output,
          ...(cost !== undefined ? { cost } : {}),
        };
      }
    }
    if (message.role === "toolResult" && message.toolName === "ptc_child_report") {
      // 字段优先级：显式 structuredContent > details.report > details 本体带 summary 时
      const candidate = (message.structuredContent ??
        (message.details as { report?: unknown })?.report ??
        message.details) as ChildReport | undefined;
      if (candidate && typeof candidate.summary === "string") toolReport = candidate;
    }
  }
  return { text, toolReport, observedUsage, observedModel, observedProvider };
}
