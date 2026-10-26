// ADR-0012：模型面文本卫生——pi 内建工具同款三步（pi 不导出 helper，本地复现），加可读排版
// oxlint-disable no-control-regex -- 清洗控制符正是本函数的职责
const ANSI_PATTERN =
  /\x1B\[[0-9;:]*[A-Za-z]|\x1B\]8;;[^\x1B]*\x1B\\|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function sanitizeText(text: string): string {
  return stripAnsi(text.replace(/\r/g, ""));
}

const MAX_LINE_CHARS = 200; // ADR-0015 §3：行内上限保留本地字符级实现

export function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

// 完成值的可读排版（ADR-0012）：字符串逐字、紧凑值单行、容器按界缩进——拒绝 JSON.stringify 整值转义
export function renderModelValue(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (typeof value === "string") return depth === 0 ? value : JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (undefinedValue(value)) return "（无完成值）";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => primitive(v)))
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    return `[\n${value.map((v) => `${pad}  ${truncateLine(renderModelValue(v, depth + 1))}`).join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (entries.every(([, v]) => primitive(v))) {
      return `{ ${entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;
    }
    return `{\n${entries.map(([k, v]) => `${pad}  ${k}: ${truncateLine(renderModelValue(v, depth + 1))}`).join(",\n")}\n${pad}}`;
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
