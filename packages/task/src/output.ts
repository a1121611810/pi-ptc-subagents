import { parseChildStream, type TaskRecord } from "@pi-ptc/dispatch";
import { renderLongOutputGuidance } from "@pi-ptc/routes";
import { applyAdr0015Truncation, TRUNCATION_MAX_BYTES } from "@pi-ptc/tui";

export type TaskOutputSource = {
  outputSize(taskId: string): Promise<number | undefined>;
  readOutput(taskId: string): Promise<string | undefined>;
  readOutputTail(taskId: string, maxBytes: number): Promise<string | undefined>;
};

export type TaskOutputView = {
  /** 孩子的散文答案（归约层）——报告是摘要，交付物是这段正文 */
  text?: string;
  /** 没有正文时的原始尾部（JSONL 事件流） */
  output?: string;
  /** 没有正文时的分层引导 */
  guidance?: string;
};

/**
 * 任务产出读法：先给归约后的孩子正文（从事件流现算，不另存一份），
 * 没有正文才退回原始尾部 + 分层引导（完整原文在 outputPath）。
 */
export async function readTaskOutput(
  source: TaskOutputSource,
  record: TaskRecord,
): Promise<TaskOutputView> {
  const taskId = record.id;
  const outputBytes = await source.outputSize(taskId);
  if (outputBytes === undefined) return {};
  // 程序型子代理（issue #293）：产出 = ptc CLI 信封 JSON，交付物是信封里的 value
  if (record.reportChannel === "program") {
    const envelopeText = (await source.readOutput(taskId)) ?? "";
    try {
      const parsed: unknown = JSON.parse(envelopeText);
      const value = (parsed as { value?: unknown }).value;
      const answer = JSON.stringify(value ?? null, null, 2);
      return { text: applyAdr0015Truncation(answer).text };
    } catch {
      // 信封坏/缺：退回原始尾部 + 引导（与无正文同一路径）
    }
  }
  const tail = (await source.readOutputTail(taskId, TRUNCATION_MAX_BYTES)) ?? "";
  let answer = parseChildStream(tail).text;
  if (!answer && outputBytes > TRUNCATION_MAX_BYTES) {
    // 答案太长被尾部切半 ⇒ 读全文再解析一次
    answer = parseChildStream((await source.readOutput(taskId)) ?? "").text;
  }
  if (answer) {
    // 正文进上下文；超 50KB 时截断尾注自带全文路径（pi 的截断契约）
    return { text: applyAdr0015Truncation(answer).text };
  }
  return {
    output: applyAdr0015Truncation(tail).text,
    guidance: renderLongOutputGuidance({
      bytes: outputBytes,
      report: record.report,
      reportChannel: record.reportChannel ?? "none",
    }),
  };
}
