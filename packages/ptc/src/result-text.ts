import type { RunOutcome } from "./protocol.ts";
import { applyAdr0015Truncation, renderModelValue, sanitizeText } from "@pi-ptc/tui";

// 运行结果 → 模型可见文本块（旧 ADR-0012 排版 + 旧 ADR-0015 截断）；details 带截断元信息
export function renderToolResult(outcome: RunOutcome): {
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
