// 采用率闸门检测器单测：分类器映射 + RunDetector 时序（含状态持久化往返）。
// 必须能单文件跑绿：node --test tests/kimi/nudge-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTool,
  RunDetector,
  RUN_THRESHOLD,
  NUDGE_BUDGET,
} from "../../scripts/lib/tool-shape.mjs";

test("classifyTool：文件五件套映射", () => {
  assert.equal(classifyTool("Read", {}), "Read");
  assert.equal(classifyTool("Grep", {}), "Grep");
  assert.equal(classifyTool("Glob", {}), "Glob");
  assert.equal(classifyTool("Edit", {}), "Edit");
  assert.equal(classifyTool("Write", {}), "Write");
});

test("classifyTool：Bash 纯读 vs 真 shell", () => {
  assert.equal(classifyTool("Bash", { command: "grep -r foo src" }), "BashRead");
  assert.equal(classifyTool("Bash", { command: "cat a.txt | head -5" }), "BashRead");
  assert.equal(classifyTool("Bash", { command: "  rg -n TODO ." }), "BashRead");
  assert.equal(classifyTool("Bash", { command: "git status" }), null);
  assert.equal(classifyTool("Bash", { command: "echo hello" }), null);
  assert.equal(classifyTool("Bash", { command: "pnpm test" }), null);
  assert.equal(classifyTool("Bash", {}), null);
});

test("classifyTool：ptc 自身与其余工具透明", () => {
  assert.equal(classifyTool("mcp__plugin-ptc-tools_ptc__ptc_run_code", {}), null);
  assert.equal(classifyTool("mcp__plugin-ptc-tools_ptc__web_ds_search", {}), null);
  assert.equal(classifyTool("WebSearch", {}), null);
  assert.equal(classifyTool("mcp__codegraph__codegraph_explore", {}), null);
});

// 模拟钩子进程间的状态持久化：每步后 JSON 往返一次
function runWithPersistence(shapes) {
  const detector = new RunDetector();
  return shapes.map((s) => {
    const hit = detector.step(s);
    const revived = new RunDetector(JSON.parse(JSON.stringify(detector.state)));
    detector.state = revived.state;
    return hit;
  });
}

test("RunDetector：恰第 N 次触发一次，触发后归零可重试", () => {
  const hits = runWithPersistence(Array(RUN_THRESHOLD * 2).fill("Grep"));
  assert.deepEqual(
    hits,
    Array(RUN_THRESHOLD * 2)
      .fill(false)
      .map((_, i) => i === RUN_THRESHOLD - 1 || i === RUN_THRESHOLD * 2 - 1),
  );
});

test("RunDetector：形态切换打断 run", () => {
  const hits = runWithPersistence(["Grep", "Grep", "Grep", "Grep", "Read", "Grep"]);
  assert.deepEqual(hits, [false, false, false, false, false, false]);
  // Read 后重新攒 5 连 Grep → 第 5 连触发
  const more = runWithPersistence(["Read", "Grep", "Grep", "Grep", "Grep", "Grep"]);
  assert.deepEqual(more, [false, false, false, false, false, true]);
});

test("RunDetector：null 形态透明（不计数、不打断）", () => {
  const detector = new RunDetector();
  assert.equal(detector.step("Grep"), false);
  assert.equal(detector.step("Grep"), false);
  assert.equal(detector.step(null), false);
  assert.equal(detector.step("Grep"), false);
  assert.equal(detector.step("Grep"), false);
  assert.equal(detector.step("Grep"), true); // 第 5 连，null 没打断
});

test(`RunDetector：预算 ${NUDGE_BUDGET} 次封顶`, () => {
  const shapes = Array(RUN_THRESHOLD * (NUDGE_BUDGET + 1)).fill("Grep");
  const hits = runWithPersistence(shapes);
  assert.equal(hits.filter(Boolean).length, NUDGE_BUDGET);
  assert.equal(hits[RUN_THRESHOLD * (NUDGE_BUDGET + 1) - 1], false); // 第 5 段不再提醒
});
