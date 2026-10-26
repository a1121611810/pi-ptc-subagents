import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

// ADR-0007：前台也落盘——记录是派发的唯一痕迹，产出是记录的一部分
// 评审：taskId 会拼进路径；公开 API 的调用方不可控，先拒分隔符与 ..
function isSafeTaskId(taskId: string): boolean {
  return !taskId.includes("/") && !taskId.includes("\\") && !taskId.includes("..");
}
export interface OutputStorage {
  write(taskId: string, text: string): Promise<string>;
  read(taskId: string): Promise<string | undefined>;
  /** 产出字节数（不读全文——超长产出先探长度再决定读不读） */
  size(taskId: string): Promise<number | undefined>;
  /**
   * 只读尾部至多 maxBytes 字节（旧 ADR-0015 的截断本来就偏尾——读全文再切尾是双重浪费）。
   * 从行边界起读，峰值内存 = maxBytes 而非全文。
   */
  readTail(taskId: string, maxBytes: number): Promise<string | undefined>;
}

// 尾部切片共用：按 UTF-8 余量回退，对齐到第一个换行（半行丢弃）
function tailSlice(text: string, maxBytes: number): string {
  let start = 0;
  while (Buffer.byteLength(text.slice(start), "utf8") > maxBytes && start < text.length) {
    const half = text.slice(start);
    start += Math.max(1, Math.floor(half.length / 2));
    while (start < text.length && (text.charCodeAt(start) & 0xdc00) === 0xdc00) start++; // 不切代理对
  }
  const tail = text.slice(start);
  const newline = tail.indexOf("\n");
  return newline >= 0 ? tail.slice(newline + 1) : tail;
}

export class InMemoryOutputStorage implements OutputStorage {
  readonly #map = new Map<string, string>();
  async write(taskId: string, text: string): Promise<string> {
    this.#map.set(taskId, text);
    return `memory://${taskId}`;
  }
  async read(taskId: string): Promise<string | undefined> {
    return this.#map.get(taskId);
  }
  async size(taskId: string): Promise<number | undefined> {
    const text = this.#map.get(taskId);
    return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
  }

  async readTail(taskId: string, maxBytes: number): Promise<string | undefined> {
    const text = this.#map.get(taskId);
    return text === undefined ? undefined : tailSlice(text, maxBytes);
  }
}

export class FileOutputStorage implements OutputStorage {
  readonly #base: string;
  constructor(baseDir: string) {
    this.#base = baseDir;
  }

  async write(taskId: string, text: string): Promise<string> {
    if (!isSafeTaskId(taskId)) throw new Error(`invalid task id: ${taskId}`);
    const dir = join(this.#base, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "output.log");
    writeFileSync(path, text, "utf8");
    return path;
  }

  async read(taskId: string): Promise<string | undefined> {
    if (!isSafeTaskId(taskId)) return undefined;
    const path = join(this.#base, "tasks", taskId, "output.log");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  async size(taskId: string): Promise<number | undefined> {
    if (!isSafeTaskId(taskId)) return undefined;
    const path = join(this.#base, "tasks", taskId, "output.log");
    return existsSync(path) ? statSync(path).size : undefined;
  }

  async readTail(taskId: string, maxBytes: number): Promise<string | undefined> {
    if (!isSafeTaskId(taskId)) return undefined;
    const path = join(this.#base, "tasks", taskId, "output.log");
    if (!existsSync(path)) return undefined;
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      if (size <= maxBytes) return readFileSync(path, "utf8");
      // UTF-8 至多 4 字节/字符：按 maxBytes 起读至多截在半字符处，再用 TextDecoder 的 {fatal:false} 容错 + 行边界对齐
      const buf = Buffer.alloc(Math.min(size, maxBytes + 8));
      await file.read(buf, 0, buf.length, size - buf.length);
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
      return text;
    } finally {
      await file.close();
    }
  }
}
