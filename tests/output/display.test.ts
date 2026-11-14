// output 面（宿主中立输出核）：截断契约（ADR-0027）+ 文本卫生 + 渲染预算 + renderToolResult 三态。
// 探针直接打产物（packages/tui/dist/index.js、packages/output/dist/index.js）——仓规：验的是发布物形态。
// 断言内容与结构而非措辞：每个实现决策（窗口拆分/尾部锚定/UTF-8 边界/写盘）都有杀死对应变异的断言。
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderToolResult } from "../../packages/output/dist/index.js";
import {
  RENDER_BOUNDS,
  TRUNCATION_HEAD_LINES,
  TRUNCATION_MAX_BYTES,
  TRUNCATION_MAX_LINES,
  TRUNCATION_TAIL_LINES,
  applyAdr0015Truncation,
  renderModelValue,
  sanitizeText,
  stripAnsi,
  truncateLine,
} from "../../packages/tui/dist/index.js";

// 定长行：编号前缀 + 填充，行号唯一可寻，窗口断言靠逐字比对
const line20 = (i: number) => `L${String(i).padStart(4, "0")}|` + "x".repeat(14); // 6+14=20 B
const line100 = (i: number) => `L${String(i).padStart(4, "0")}|` + "y".repeat(114); // 6+114=120 B

it("fulfilled：无日志时只有渲染后的完成值", () => {
  const r = renderToolResult({ status: "fulfilled", value: 42, logs: [] });
  expect(r.truncated).toBe(false);
  expect(r.text).toBe("42");
  expect(r.fullOutputPath).toBeUndefined();
});

it("fulfilled：日志在值之前，空行连接", () => {
  const r = renderToolResult({ status: "fulfilled", value: "ok", logs: ["log-a", "log-b"] });
  expect(r.text).toBe("log-a\nlog-b\nok");
});

it("rejected：错误行带 [rejected] 前缀，日志保留", () => {
  const r = renderToolResult({ status: "rejected", error: "boom", logs: ["pre"] } as never);
  expect(r.text).toBe("pre\n[rejected] boom");
});

it("canceled：原因行带 [canceled] 前缀", () => {
  const r = renderToolResult({ status: "canceled", reason: "user", logs: [] });
  expect(r.text).toBe("[canceled] user");
});

it("临时文件清扫：首次截断删自家过期件、留新件、不碰别人家的", () => {
  const old = join(tmpdir(), "pi-ptc-output-old-stale.txt");
  const fresh = join(tmpdir(), "pi-ptc-output-fresh-keep.txt");
  const foreign = join(tmpdir(), "other-prefix-keep.txt");
  writeFileSync(old, "stale");
  writeFileSync(fresh, "fresh");
  writeFileSync(foreign, "foreign");
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(old, dayAgo, dayAgo);
  const huge = { status: "fulfilled", value: "y\n".repeat(TRUNCATION_MAX_LINES + 10), logs: [] };
  renderToolResult(huge as never); // 触发首次截断 → 顺带清扫（本文件第一个截断用例，清扫必定发生）
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  rmSync(old, { force: true });
  rmSync(fresh, { force: true });
  rmSync(foreign, { force: true });
});

it("截断·纯行溢出：头尾两窗逐字保留，全文写盘", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => line20(i));
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);
  expect(r.truncated).toBe(true);

  const head = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);
  const keptLines = r.text.split("\n");
  expect(keptLines[0]).toBe(lines[0]);
  expect(keptLines.slice(0, head.length)).toEqual(head);
  expect(keptLines.slice(head.length + 1)).toEqual(tail);
  expect(keptLines.length).toBe(TRUNCATION_MAX_LINES + 1);
  expect(readFileSync(r.fullOutputPath as string, "utf8")).toBe(text);
});

it("截断·标记行：省略行范围与字节数独立计算", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => line20(i));
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);

  const head = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);
  const droppedBytes = Buffer.byteLength(text) - Buffer.byteLength(head.concat(tail).join("\n"));
  const marker = `…（已截断：省略第 ${head.length + 1}–${lines.length - tail.length} 行 / ${droppedBytes} 字节，全文在 ${r.fullOutputPath}）`;
  expect(r.text.split("\n")[head.length]).toBe(marker);
});

it("截断·尾窗锚定：原文最后一行逐字保留", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => line20(i));
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);

  const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);
  const keptLines = r.text.split("\n");
  expect(keptLines[keptLines.length - 1]).toBe(lines[lines.length - 1]);
  expect(keptLines.slice(-tail.length)).toEqual(tail);
});

it("截断·行字节双溢出：交替收缩先动尾窗，尾窗尾部锚定", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 1 }, (_, i) => line100(i));
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);

  // 独立推演（120B/行，MAX=51,200；slice(ceil(n/2)) 留 floor(n/2) 行）：(500,1500)→尾750→头250→尾375→头125=(125,375)
  // 60,499B 仍超→尾187=(125,187) 37,751B 停。顺序写反则第三轮先动头 125→62 ⇒ 头窗断言红
  const headLen = 125;
  const tailLen = 187;
  const head = lines.slice(0, headLen);
  const tail = lines.slice(lines.length - tailLen);
  const droppedBytes = Buffer.byteLength(text) - Buffer.byteLength(head.concat(tail).join("\n"));
  const marker = `…（已截断：省略第 ${headLen + 1}–${lines.length - tailLen} 行 / ${droppedBytes} 字节，全文在 ${r.fullOutputPath}）`;

  const keptLines = r.text.split("\n");
  expect(keptLines.slice(0, headLen)).toEqual(head);
  expect(keptLines[headLen]).toBe(marker);
  expect(keptLines.slice(headLen + 1)).toEqual(tail);
  expect(keptLines[keptLines.length - 1]).toBe(lines[lines.length - 1]);
  expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES + 256);
});

it("截断·巨行字节兜底：头 25%/尾 75% 切分，切点对齐 UTF-8 字符边界", () => {
  const text = "中".repeat(20000);
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);
  expect(r.truncated).toBe(true);
  expect(r.text).not.toContain("\uFFFD");
  expect(r.text.startsWith("中")).toBe(true);
  expect(r.text.endsWith("中")).toBe(true);
  expect(r.text).toMatch(/…（已截断：省略中间 \d+ 字节，全文在 .+）/);
  expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES + 256);
  expect(readFileSync(r.fullOutputPath as string, "utf8")).toBe(text);
});

it("截断·两窗各剩 1 行仍超预算：带换行的 keptBody 落入字节兜底", () => {
  const fat = "中".repeat(30000);
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 1 }, (_, i) =>
    i === 0 || i === TRUNCATION_MAX_LINES ? fat : String(i),
  );
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] } as never);
  expect(r.truncated).toBe(true);
  expect(r.text).not.toContain("\uFFFD");
  expect(r.text).toMatch(/…（已截断：省略中间 \d+ 字节，全文在 .+）/);
  expect(r.text.startsWith("中")).toBe(true);
  expect(r.text.endsWith("中")).toBe(true);
  expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES + 256);
  expect(readFileSync(r.fullOutputPath as string, "utf8")).toBe(text);
});

it("文本卫生：ANSI 控制符与回车不进渲染", () => {
  expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
  expect(stripAnsi("\u001B]0;title\u0007body")).toBe("body");
  expect(sanitizeText("a\r\nb")).toBe("a\nb");
  expect(sanitizeText("a\u0000b")).toBe("ab");
  expect(
    renderToolResult({ status: "fulfilled", value: "\u001B[32mok\u001B[0m", logs: [] } as never)
      .text,
  ).toBe("ok");
});

it("渲染预算冻结表：值树深度/子项/单行上限", () => {
  expect(RENDER_BOUNDS.VALUE_TREE_MAX_DEPTH).toBe(4);
  expect(RENDER_BOUNDS.VALUE_TREE_MAX_CHILDREN).toBe(6);
  expect(RENDER_BOUNDS.VALUE_TREE_MAX_LINE_CHARS).toBe(120);
  expect(RENDER_BOUNDS.MAX_LOG_LINES_EXPANDED).toBe(12);
  expect(truncateLine("x".repeat(200))).toBe("x".repeat(120) + "…");
  const rendered = renderModelValue({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 });
  expect(rendered).toContain("…（余 1 项）");
  expect(rendered).not.toContain("g: 7");
  expect(applyAdr0015Truncation("short").truncated).toBe(false);
});
