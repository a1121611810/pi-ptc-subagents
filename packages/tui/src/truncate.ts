import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ADR-0015：pi 的截断契约值（pi 扩展指南「Tools MUST truncate their output」；floor 版本 pi 无此导出，本地持有）
export const TRUNCATION_MAX_BYTES = 50 * 1024;
export const TRUNCATION_MAX_LINES = 2000;

export interface TruncationResult {
  text: string;
  truncated: boolean;
  fullOutputPath?: string;
}

// 先写全文临时文件再切尾——指针永不指向半个文件；尾注措辞照 pi 内建工具
export function applyAdr0015Truncation(text: string): TruncationResult {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TRUNCATION_MAX_BYTES && lines.length <= TRUNCATION_MAX_LINES) {
    return { text, truncated: false };
  }
  let keptLines = lines.slice(-TRUNCATION_MAX_LINES);
  let kept = keptLines.join("\n");
  while (Buffer.byteLength(kept, "utf8") > TRUNCATION_MAX_BYTES && keptLines.length > 1) {
    keptLines = keptLines.slice(Math.max(1, Math.floor(keptLines.length / 2)));
    kept = keptLines.join("\n");
  }
  const fullOutputPath = join(tmpdir(), `pi-ptc-output-${randomUUID()}.txt`);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(fullOutputPath, text, "utf8");
  const droppedLines = lines.length - keptLines.length;
  const droppedBytes = bytes - Buffer.byteLength(kept, "utf8");
  const textWithFooter = [
    `…（已截断：省略前 ${droppedLines} 行 / ${droppedBytes} 字节，全文在 ${fullOutputPath}）`,
    kept,
  ].join("\n");
  return { text: textWithFooter, truncated: true, fullOutputPath };
}
