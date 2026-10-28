// 旧 ADR-0032：child report 词汇与 prompt 通道——刻意零 import（工具通道落地前，这里是契约的唯一持有者）
export const CHILD_REPORT_TOOL_NAME = "ptc_child_report";

export type ChildFinding = {
  what: string;
  evidence?: string;
};

export type ChildUsage = {
  input?: number;
  output?: number;
  cost?: number;
  turns?: number;
  /** 宿主观测路径（jsonl 流）可能携带的缓存读/写——报告契约不要求孩子上报，可选仅类型级 */
  cacheRead?: number;
  cacheWrite?: number;
};

export type ChildReport = {
  summary: string;
  findings?: ChildFinding[];
  files_touched?: string[];
  usage?: ChildUsage;
};

// reportChannel 恒在（旧 ADR-0032 用户故事 4/6）：tool 通道缺席时 prompt 通道兜底，永不静默降级成散文
export type ReportChannel = "tool" | "prompt-json" | "none" | "opted-out";

export const REPORT_CONTRACT_BLOCK = [
  "<child-report-contract>",
  "Before finishing, you MUST deliver a child report as a fenced JSON block at the very end of your final message:",
  "```json",
  '{ "summary": "one sentence conclusion", "findings": [{ "what": "claim", "evidence": "where it comes from" }], "files_touched": ["relative/path"], "usage": { "input": 0, "output": 0, "cost": 0, "turns": 0 } }',
  "```",
  'Rules: "summary" is your deliverable — answer the task asked, in one sentence. "findings" carries load-bearing evidence only; never recap content you merely read. Do NOT write report/summary .md files — your final message is what the parent reads.',
  "findings/files_touched/usage may be omitted when empty. Your prose answer stays; the report is checked alongside it.",
  "</child-report-contract>",
].join("\n");

export interface ExtractedReport {
  report: ChildReport | null;
  channel: ReportChannel;
}

// prompt 通道：从最终文本抠最后一个 fenced JSON 块；解析失败或没有 = none（散文照交，但明说没报告）
export function extractReportFromText(text: string): ExtractedReport {
  const blocks = [...text.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const raw = blocks[i]![1]!.trim();
    if (!raw.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(raw) as ChildReport;
      if (typeof parsed.summary === "string" && parsed.summary.length > 0) {
        return { report: normalizeReport(parsed), channel: "prompt-json" };
      }
    } catch {
      // 不是合法 JSON 的报告块：继续往前找；都没有就是 none
    }
  }
  return { report: null, channel: "none" };
}

function normalizeReport(parsed: ChildReport): ChildReport {
  return {
    summary: parsed.summary,
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.filter((f) => typeof f?.what === "string")
      : undefined,
    files_touched: Array.isArray(parsed.files_touched)
      ? parsed.files_touched.filter((f): f is string => typeof f === "string")
      : undefined,
    usage: parsed.usage && typeof parsed.usage === "object" ? parsed.usage : undefined,
  };
}
