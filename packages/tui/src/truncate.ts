import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 旧 ADR-0015：pi 的截断契约值（pi 扩展指南「Tools MUST truncate their output」；floor 版本 pi 无此导出，本地持有）
export const TRUNCATION_MAX_BYTES = 50 * 1024;
export const TRUNCATION_MAX_LINES = 2000;
const TMP_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 全文临时文件只增不减（压测实证）——截断顺手清扫过期件
const TMP_FILE_PREFIX = "pi-ptc-output-";

let sweptTmp = false;
function sweepExpiredTmp(): void {
  sweptTmp = true;
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_FILE_PREFIX)) continue;
    try {
      const file = join(tmpdir(), name);
      if (Date.now() - statSync(file).mtimeMs > TMP_FILE_TTL_MS) rmSync(file, { force: true });
    } catch {
      // 清扫是尽力而为：单个文件竞态失败不影响截断主流程
    }
  }
}

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
  // 单行超长（JSON.stringify 结果/base64）砍不动行：按字节留尾，别让 50KB 预算被常见形状绕过
  const keptBuffer = Buffer.from(kept, "utf8");
  if (keptBuffer.length > TRUNCATION_MAX_BYTES) {
    kept = keptBuffer.subarray(keptBuffer.length - TRUNCATION_MAX_BYTES).toString("utf8");
  }
  const fullOutputPath = join(tmpdir(), `${TMP_FILE_PREFIX}${randomUUID()}.txt`);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(fullOutputPath, text, "utf8");
  if (!sweptTmp) sweepExpiredTmp(); // 首次截断时一次性清扫，之后本进程不再扫
  const droppedLines = lines.length - keptLines.length;
  const droppedBytes = bytes - Buffer.byteLength(kept, "utf8");
  const textWithFooter = [
    `…（已截断：省略前 ${droppedLines} 行 / ${droppedBytes} 字节，全文在 ${fullOutputPath}）`,
    kept,
  ].join("\n");
  return { text: textWithFooter, truncated: true, fullOutputPath };
}
