// P0 → 测试：output 包（宿主中立输出核）——renderToolResult 三态整形 + 截断契约（头尾保留中间省略，ADR-0027）
// 断言内容与结构而非措辞：每个实现决策（窗口拆分/尾部锚定/UTF-8 边界/写盘）都有杀死对应变异的断言
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToolResult } from "../../packages/output/dist/index.js";
import {
  TRUNCATION_HEAD_LINES,
  TRUNCATION_MAX_BYTES,
  TRUNCATION_MAX_LINES,
  TRUNCATION_TAIL_LINES,
} from "../../packages/tui/dist/index.js";

// 定长行：编号前缀 + 填充，行号唯一可寻（L0000|/L0124|…），窗口断言靠逐字 deepEqual
const line20 = (i) => `L${String(i).padStart(4, "0")}|` + "x".repeat(14); // 6+14=20 B
const line100 = (i) => `L${String(i).padStart(4, "0")}|` + "y".repeat(114); // 6+114=120 B

test("fulfilled：无日志时只有渲染后的完成值", () => {
  const r = renderToolResult({ status: "fulfilled", value: 42, logs: [] });
  assert.equal(r.truncated, false);
  assert.equal(r.text, "42");
  assert.equal(r.fullOutputPath, undefined);
});

test("fulfilled：日志在值之前，空行连接", () => {
  const r = renderToolResult({
    status: "fulfilled",
    value: "ok",
    logs: ["log-a", "log-b"],
  });
  assert.equal(r.text, "log-a\nlog-b\nok");
});

test("rejected：错误行带 [rejected] 前缀，日志保留", () => {
  const r = renderToolResult({
    status: "rejected",
    error: "boom",
    logs: ["pre"],
  });
  assert.equal(r.text, "pre\n[rejected] boom");
});

test("canceled：原因行带 [canceled] 前缀", () => {
  const r = renderToolResult({ status: "canceled", reason: "user", logs: [] });
  assert.equal(r.text, "[canceled] user");
});

test("临时文件清扫：首次截断删自家过期件、留新件、不碰别人家的", () => {
  const old = join(tmpdir(), "pi-ptc-output-old-stale.txt");
  const fresh = join(tmpdir(), "pi-ptc-output-fresh-keep.txt");
  const foreign = join(tmpdir(), "other-prefix-keep.txt");
  writeFileSync(old, "stale");
  writeFileSync(fresh, "fresh");
  writeFileSync(foreign, "foreign");
  const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(old, dayAgo, dayAgo);
  const huge = { status: "fulfilled", value: "y\n".repeat(TRUNCATION_MAX_LINES + 10), logs: [] };
  renderToolResult(huge); // 触发首次截断 → 顺带清扫（本文件第一个截断用例，清扫必定发生）
  assert.equal(existsSync(old), false, "过期 24h 的自家临时文件必须被清");
  assert.equal(existsSync(fresh), true, "新件保留");
  assert.equal(existsSync(foreign), true, "别人家的前缀不碰");
  rmSync(old, { force: true });
  rmSync(fresh, { force: true });
  rmSync(foreign, { force: true });
});

test("截断·纯行溢出：头尾两窗逐字保留，标记行报省略行范围，全文写盘（变异：只留尾/只留头/数字撒谎）", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 100 }, (_, i) => line20(i)); // 2100×20B=42KB ≤ 50KB，只行溢出
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] });
  assert.equal(r.truncated, true);

  const head = lines.slice(0, TRUNCATION_HEAD_LINES);
  const tail = lines.slice(lines.length - TRUNCATION_TAIL_LINES);
  const elidedStart = head.length + 1;
  const elidedEnd = lines.length - tail.length;
  const droppedBytes = Buffer.byteLength(text) - Buffer.byteLength(head.concat(tail).join("\n"));
  const marker = `…（已截断：省略第 ${elidedStart}–${elidedEnd} 行 / ${droppedBytes} 字节，全文在 ${r.fullOutputPath}）`;

  const keptLines = r.text.split("\n");
  assert.equal(keptLines[0], lines[0], "首行逐字保留（杀死「退回只留尾」）");
  assert.deepEqual(keptLines.slice(0, head.length), head, "头窗 === 原文前 500 行");
  assert.equal(keptLines[head.length], marker, "标记行数字独立计算、逐字匹配（杀死「数字撒谎」）");
  assert.deepEqual(
    keptLines.slice(head.length + 1),
    tail,
    "尾窗 === 原文后 1500 行（杀死「误成只留头」）",
  );
  assert.equal(keptLines.length, TRUNCATION_MAX_LINES + 1, "含标记行不超 2001 行");
  assert.equal(
    readFileSync(r.fullOutputPath, "utf8"),
    text,
    "全文临时文件逐字节等于原文（杀死「只写标记不写盘」）",
  );
});

test("截断·行字节双溢出：交替收缩先动尾窗，尾窗尾部锚定（变异：收缩顺序写反）", () => {
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 1 }, (_, i) => line100(i)); // 2001×120B≈242KB，行字节双溢出（行数须 >2000 才进两窗路径，==2000 走字节兜底）
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] });

  // 独立推演（120B/行，MAX=51,200；slice(ceil(n/2)) 留 floor(n/2) 行）：(500,1500)→尾750→头250→尾375→头125=(125,375)
  // 60,499B 仍超→尾187=(125,187) 37,751B 停。顺序写反则第三轮先动头 125→62：(62,375)=52,876B 仍超再缩尾 ⇒ 头只剩 62 行 ⇒ 头窗断言红
  const headLen = 125;
  const tailLen = 187;
  const head = lines.slice(0, headLen);
  const tail = lines.slice(lines.length - tailLen);
  const droppedBytes = Buffer.byteLength(text) - Buffer.byteLength(head.concat(tail).join("\n"));
  const marker = `…（已截断：省略第 ${headLen + 1}–${lines.length - tailLen} 行 / ${droppedBytes} 字节，全文在 ${r.fullOutputPath}）`;

  const keptLines = r.text.split("\n");
  assert.deepEqual(
    keptLines.slice(0, headLen),
    head,
    "头窗 125 行在（写反顺序会先缩头到 1 行 ⇒ 红）",
  );
  assert.equal(keptLines[headLen], marker);
  assert.deepEqual(keptLines.slice(headLen + 1), tail, "尾窗含原文最后 187 行——尾部锚定");
  assert.equal(keptLines[keptLines.length - 1], lines[lines.length - 1], "原文最后一行逐字在");
  assert.ok(
    Buffer.byteLength(r.text, "utf8") <= TRUNCATION_MAX_BYTES + 256,
    "含标记行不超预算+标记开销",
  );
});

test("截断·巨行字节兜底：头 25%/尾 75% 切分，切点对齐 UTF-8 字符边界（变异：切出半个字符）", () => {
  const text = "中".repeat(20000); // 60,000B 单行，无换行
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] });
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes("�"), "kept 无 U+FFFD（杀死「边界对齐函数被删」）");
  assert.ok(r.text.startsWith("中"), "头部从字符首开始");
  assert.ok(r.text.endsWith("中"), "尾部到字符尾结束");
  assert.match(r.text, /…（已截断：省略中间 \d+ 字节，全文在 .+）/);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= TRUNCATION_MAX_BYTES + 256);
  assert.equal(readFileSync(r.fullOutputPath, "utf8"), text);
});

test("截断·两窗各剩 1 行仍超预算：带换行的 keptBody 落入字节兜底（review 补的唯一未覆盖可达分支）", () => {
  const fat = "中".repeat(30000); // 30,000B 巨行
  const lines = Array.from({ length: TRUNCATION_MAX_LINES + 1 }, (_, i) =>
    i === 0 || i === TRUNCATION_MAX_LINES ? fat : String(i),
  ); // 2001 行 ≈60KB：两头巨行始终在两窗内，交替砍半只能到 1+1 行，仍 60,001B > 预算 ⇒ 字节兜底
  const text = lines.join("\n");
  const r = renderToolResult({ status: "fulfilled", value: text, logs: [] });
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes("�"), "无半个字符");
  assert.match(
    r.text,
    /…（已截断：省略中间 \d+ 字节，全文在 .+）/,
    "走字节兜底标记（非行范围标记）",
  );
  assert.ok(r.text.startsWith("中") && r.text.endsWith("中"), "头尾各从巨行的字符首/尾开始");
  assert.ok(Buffer.byteLength(r.text, "utf8") <= TRUNCATION_MAX_BYTES + 256);
  assert.equal(readFileSync(r.fullOutputPath, "utf8"), text);
});
