import { applyAdr0015Truncation, renderModelValue, sanitizeText } from "@pi-ptc/tui";

// ptc 线协议 RunOutcome 的结构切片（protocol.ts 的宿主中立子集，省略 images/subCalls）。
// 结构兼容由 ptc tools.ts 的编译期检查钉住：传参不合即 type check 红
export type ResultTextOutcome =
  | { status: "fulfilled"; value: unknown; logs: string[] }
  | { status: "rejected"; error: string; logs: string[] }
  | { status: "canceled"; reason: string; logs: string[] };

// 运行结果 → 模型可见文本块（旧 ADR-0012 排版 + 旧 ADR-0015 截断）；details 带截断元信息
export function renderToolResult(outcome: ResultTextOutcome): {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
} {
  let body: string;
  if (outcome.status === "fulfilled") {
    const parts =
      outcome.logs.length > 0
        ? [...outcome.logs, renderModelValue(outcome.value)]
        : [renderModelValue(outcome.value)];
    body = parts.join("\n");
  } else if (outcome.status === "rejected") {
    body = [...outcome.logs, `[rejected] ${outcome.error}`].join("\n");
  } else {
    body = [...outcome.logs, `[canceled] ${outcome.reason}`].join("\n");
  }
  const { text, truncated, fullOutputPath } = applyAdr0015Truncation(sanitizeText(body));
  return { text, truncated, fullOutputPath };
}
