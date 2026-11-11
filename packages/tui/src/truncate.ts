import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 旧 ADR-0015：pi 的截断契约值（pi 扩展指南「Tools MUST truncate their output」；floor 版本 pi 无此导出，本地持有）
export const TRUNCATION_MAX_BYTES = 50 * 1024;
export const TRUNCATION_MAX_LINES = 2000;
// ADR-0027：行预算拆头/尾两窗，标记行报省略行范围；字节不足时交替对半缩——先动尾窗前沿、再动头窗后沿，
// 尾窗尾部锚定不动（程序返回值拼在文本末尾，最后几行必须活到最后）
export const TRUNCATION_HEAD_LINES = Math.floor(TRUNCATION_MAX_LINES / 4);
export const TRUNCATION_TAIL_LINES = TRUNCATION_MAX_LINES - TRUNCATION_HEAD_LINES;
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

// 不切半个字符：切点落在 UTF-8 多字节序列中间就整体让进省略区（风格同 text.ts 的代理对检查）
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return cut;
}
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
  while (pos < buf.length && ((buf[pos] ?? 0) & 0xc0) === 0x80) pos++;
  return pos;
}

// 先写全文临时文件再裁窗——指针永不指向半个文件；超限保留头尾、中间省略（ADR-0027，标记行照 omp 口径）
export function applyAdr0015Truncation(text: string): TruncationResult {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TRUNCATION_MAX_BYTES && lines.length <= TRUNCATION_MAX_LINES) {
    return { text, truncated: false };
  }
  const fullOutputPath = join(tmpdir(), `${TMP_FILE_PREFIX}${randomUUID()}.txt`);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(fullOutputPath, text, "utf8");
  if (!sweptTmp) sweepExpiredTmp(); // 首次截断时一次性清扫，之后本进程不再扫

  let keptBody = text;
  if (lines.length > TRUNCATION_MAX_LINES) {
    const head = lines.slice(0, TRUNCATION_HEAD_LINES);
    const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);
    const joined = (h: string[], t: string[]) => h.concat(t).join("\n");
    let keptHead = head;
    let keptTail = tail;
    // 字节预算吃紧时交替砍半：尾窗从前沿砍（尾部锚定），头窗从后沿砍
    while (
      Buffer.byteLength(joined(keptHead, keptTail), "utf8") > TRUNCATION_MAX_BYTES &&
      (keptTail.length > 1 || keptHead.length > 1)
    ) {
      if (keptTail.length > 1) keptTail = keptTail.slice(Math.ceil(keptTail.length / 2));
      if (Buffer.byteLength(joined(keptHead, keptTail), "utf8") <= TRUNCATION_MAX_BYTES) break;
      if (keptHead.length > 1) keptHead = keptHead.slice(0, Math.floor(keptHead.length / 2));
    }
    const keptBytes = Buffer.byteLength(joined(keptHead, keptTail), "utf8");
    if (keptBytes <= TRUNCATION_MAX_BYTES) {
      const elidedStart = keptHead.length + 1; // 1-based 起止行号，模型按它 Read 精准回读
      const elidedEnd = lines.length - keptTail.length;
      const marker = `…（已截断：省略第 ${elidedStart}–${elidedEnd} 行 / ${bytes - keptBytes} 字节，全文在 ${fullOutputPath}）`;
      return {
        text: [...keptHead, marker, ...keptTail].join("\n"),
        truncated: true,
        fullOutputPath,
      };
    }
    keptBody = joined(keptHead, keptTail); // 两窗各剩 1 行仍超预算：落入字节兜底
  }

  // 字节兜底（巨行 / 极端输入）：按字节头 25% 尾 75% 切，切点对齐 UTF-8 字符边界
  const keptBuffer = Buffer.from(keptBody, "utf8");
  if (keptBuffer.length > TRUNCATION_MAX_BYTES) {
    const headBudget = Math.floor(TRUNCATION_MAX_BYTES / 4);
    const headEnd = findUtf8BoundaryBackward(keptBuffer, headBudget);
    const tailStart = findUtf8BoundaryForward(
      keptBuffer,
      keptBuffer.length - (TRUNCATION_MAX_BYTES - headBudget),
    );
    const marker = `…（已截断：省略中间 ${keptBuffer.length - headEnd - (keptBuffer.length - tailStart)} 字节，全文在 ${fullOutputPath}）`;
    return {
      text: `${keptBuffer.subarray(0, headEnd).toString("utf8")}${marker}${keptBuffer.subarray(tailStart).toString("utf8")}`,
      truncated: true,
      fullOutputPath,
    };
  }
  // keptBody 未超行数上限但超了字节预算的输入不存在（首行已 early-return），这里不可达
  return { text: keptBody, truncated: true, fullOutputPath };
}
