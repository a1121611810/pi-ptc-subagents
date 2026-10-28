// F2 → 测试：stdout 尾部上限（审计 F2）——假 spawn 灌爆 stdout，验证 16MB 砍头留尾 + outputTruncated 标记
// 基准图：docs/prototypes/full-flow-anatomy.html ⑨泵
import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskEngine,
  TaskRegistry,
  InMemoryOutputStorage,
} from "../../packages/dispatch/dist/index.js";

const CAP = 16 * 1024 * 1024;

function fakeSpawn(stdoutText, exitCode = 0) {
  return () => {
    let outCb, exitCb;
    queueMicrotask(() => {
      outCb?.(stdoutText);
      exitCb?.(exitCode, "");
    });
    return {
      pid: 1,
      onOutput: (cb) => {
        outCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: () => {},
    };
  };
}

function makeEngine(stdoutText) {
  const registry = new TaskRegistry();
  const output = new InMemoryOutputStorage();
  const engine = new TaskEngine({ registry, output, spawnChild: fakeSpawn(stdoutText) });
  return { registry, output, engine };
}

const TAIL_REPORT = '\n```json\n{"summary":"ok-report"}\n```\n';

test("灌爆：17MB 头部垃圾 + 尾部报告 → 砍头留尾，报告仍解析得出", async () => {
  const { registry, output, engine } = makeEngine("A".repeat(17 * 1024 * 1024) + TAIL_REPORT);
  const r = await engine.dispatch({ task: "x", wait: true });
  const rec = registry.get(r.taskId);
  const size = await output.size(r.taskId);
  assert.equal(r.outputTruncated, true, "result.outputTruncated 应为 true");
  assert.equal(rec.outputTruncated, true, "record.outputTruncated 应为 true");
  assert.ok(r.text.length <= CAP, `text 超上限: ${r.text.length}`);
  assert.ok(size !== undefined && size <= CAP, `产出大小异常: ${size}`);
  assert.equal(r.report?.summary, "ok-report", "截断后报告没解析出来: " + JSON.stringify(r.report));
  assert.equal(r.status, "fulfilled");
});

test("正常：小于上限 → 不截断，字节数精确", async () => {
  const { output, engine } = makeEngine("hello\n" + TAIL_REPORT);
  const r = await engine.dispatch({ task: "x", wait: true });
  const size = await output.size(r.taskId);
  assert.equal(r.outputTruncated, false, "result.outputTruncated 应为 false");
  assert.equal(size, Buffer.byteLength("hello\n" + TAIL_REPORT), "正常产出字节数不对: " + size);
  assert.equal(r.report?.summary, "ok-report", "正常报告没解析出来");
});
