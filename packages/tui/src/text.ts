// 旧 ADR-0012：模型面文本卫生——pi 内建工具同款三步（pi 不导出 helper，本地复现），加可读排版
import { RENDER_BOUNDS } from "./bounds.ts";

// oxlint-disable no-control-regex -- 清洗控制符正是本函数的职责
const ANSI_PATTERN =
  /\x1B\[[0-9:;<=>?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function sanitizeText(text: string): string {
  return stripAnsi(text.replace(/\r/g, ""));
}

// 行内上限引用冻结契约（ADR-0016）：改值走 ADR，不许再本地化
const MAX_LINE_CHARS = RENDER_BOUNDS.VALUE_TREE_MAX_LINE_CHARS;

export function truncateLine(line: string, maxChars: number = MAX_LINE_CHARS): string {
  if (line.length <= maxChars) return line;
  let cut = maxChars;
  while (cut > 0 && (line.charCodeAt(cut) & 0xfc00) === 0xdc00) cut--; // 不切半个代理对
  return `${line.slice(0, cut)}…`;
}

// 完成值的可读排版（旧 ADR-0012）：字符串逐字、紧凑值单行、容器按界缩进——拒绝 JSON.stringify 整值转义
export function renderModelValue(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  const pad = "  ".repeat(depth);
  if (depth >= RENDER_BOUNDS.VALUE_TREE_MAX_DEPTH) return "…";
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (undefinedValue(value)) return "（无完成值）";
  if (value !== null && typeof value === "object") {
    // 循环引用是 structured clone 的合法值：不判环会无限递归打爆栈
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
  }
  if (Array.isArray(value)) {
    // 审计 F7 / ADR-0016：每层子项上限——超大数组只渲染前 N 个，余量明说
    const shown = value.slice(0, RENDER_BOUNDS.VALUE_TREE_MAX_CHILDREN);
    const rest = value.length - shown.length;
    const oneLine = `[${shown.map((v) => JSON.stringify(v)).join(", ")}]`;
    const rendered =
      value.length === 0
        ? "[]"
        : rest === 0 && shown.every((v) => primitive(v)) && oneLine.length <= MAX_LINE_CHARS
          ? oneLine
          : `[\n${shown
              .map((v) => truncateLine(`${pad}  ${renderModelValue(v, depth + 1, seen)}`))
              .join(",\n")}${rest > 0 ? `,\n${pad}  …（余 ${rest} 项）` : ""}\n${pad}]`;
    seen.delete(value);
    return rendered;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, RENDER_BOUNDS.VALUE_TREE_MAX_CHILDREN);
    const rest = entries.length - shown.length;
    const oneLine = `{ ${shown.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
    const rendered =
      entries.length === 0
        ? "{}"
        : rest === 0 && shown.every(([, v]) => primitive(v)) && oneLine.length <= MAX_LINE_CHARS
          ? oneLine
          : `{\n${shown
              .map(([k, v]) =>
                truncateLine(`${pad}  ${k}: ${renderModelValue(v, depth + 1, seen)}`),
              )
              .join(",\n")}${rest > 0 ? `,\n${pad}  …（余 ${rest} 项）` : ""}\n${pad}}`;
    seen.delete(value);
    return rendered;
  }
  return String(value);
}

function primitive(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function undefinedValue(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as Record<string, unknown>).$void === true
  );
}
