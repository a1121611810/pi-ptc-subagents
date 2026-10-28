// P0 → 测试：output 包（宿主中立输出核）——renderToolResult 三态整形 + 截断契约
// 与 ptc 线协议的结构兼容由 packages/ptc 的 type check 钉住，这里只测运行时形状
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToolResult } from "../../packages/output/dist/index.js";
import { TRUNCATION_MAX_LINES } from "../../packages/tui/dist/index.js";

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

test("截断契约：超上限砍头留尾、文首给全文指针，不静默", () => {
  const huge = { status: "fulfilled", value: "x\n".repeat(TRUNCATION_MAX_LINES + 50), logs: [] };
  const r = renderToolResult(huge);
  assert.equal(r.truncated, true);
  assert.match(r.text, /^…（已截断：省略前 \d+ 行 \/ \d+ 字节，全文在 /);
  assert.ok(r.fullOutputPath, "截断必须给 fullOutputPath");
  assert.ok(r.text.split("\n").length <= TRUNCATION_MAX_LINES + 1, "留尾不超过行数上限+标记行");
});
