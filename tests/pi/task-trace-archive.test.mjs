// F4 → 测试：归档层（spec 决策 29）——压缩归档 / 回落读者 / 开关 / keep 可配 / TTL / 异步不阻塞主线
// 基准图：docs/prototypes/full-flow-anatomy.html ⑪归档层 + ⑫回落读者
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  utimesSync,
  readFileSync,
} from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskEngine, TaskRegistry, FileOutputStorage } from "../../packages/dispatch/dist/index.js";

function fakeSpawn(stdoutText = "hello\n") {
  return () => {
    let outCb, exitCb;
    queueMicrotask(() => {
      outCb?.(stdoutText);
      exitCb?.(0, "");
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

const poll = async (fn, want, ms = 3000) => {
  const t0 = Date.now();
  for (;;) {
    let v = 0;
    try {
      v = fn();
    } catch {
      v = 0;
    }
    if (v >= want) return v;
    if (Date.now() - t0 > ms) throw new Error(`轮询超时：${v} < ${want}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("归档开：600 任务 → 内存 500 / 归档 100，gz 带 archivedAt，回落读者全通", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f4-arch-"));
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    storageDir: dir,
    output: new FileOutputStorage(dir),
    spawnChild: fakeSpawn(),
  });
  const ids = [];
  for (let i = 0; i < 600; i++)
    ids.push((await engine.dispatch({ task: `t${i}`, wait: true })).taskId);
  assert.equal(registry.list().length, 500, "内存应稳定 500");
  // 主线不等：无人 await 归档，尾链自己在 event loop 上推进
  await poll(
    () => readdirSync(join(dir, "archive")).filter((f) => f.endsWith(".json.gz")).length,
    100,
  );
  assert.ok(!existsSync(join(dir, "records", `${ids[0]}.json`)), "最老的热记录文件该没了");
  assert.ok(existsSync(join(dir, "archive", `${ids[0]}.json.gz`)), "最老的归档该在");
  const rec = JSON.parse(
    gunzipSync(readFileSync(join(dir, "archive", `${ids[0]}.json.gz`))).toString("utf8"),
  );
  assert.equal(typeof rec.archivedAt, "number", "归档副本缺 archivedAt 戳");
  assert.equal(rec.task, "t0", "归档内容错");
  const out = gunzipSync(readFileSync(join(dir, "archive", `${ids[0]}.output.gz`))).toString(
    "utf8",
  );
  assert.equal(out, "hello\n", "归档产出内容错");
  const back = await engine.readArchivedRecord(ids[0]);
  assert.ok(back && back.archived === true && back.task === "t0", "回落读者失败");
  assert.equal(await engine.readOutput(ids[0]), "hello\n", "回落产出失败");
  assert.equal(await engine.outputSize(ids[0]), 6, "回落 size 失败");
  assert.ok((await engine.readOutputTail(ids[0], 100))?.includes("hello"), "回落 tail 失败");
  assert.ok(registry.get(ids[599]), "最新条该活着");
  await engine.shutdown();
});

test("归档关：驱逐即删，无归档产物", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f4-off-"));
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    storageDir: dir,
    output: new FileOutputStorage(dir),
    spawnChild: fakeSpawn(),
    archiveEnabled: false,
  });
  const ids = [];
  for (let i = 0; i < 505; i++)
    ids.push((await engine.dispatch({ task: `t${i}`, wait: true })).taskId);
  await engine.shutdown();
  assert.ok(!existsSync(join(dir, "archive")), "归档关时不该有 archive 目录");
  assert.ok(!existsSync(join(dir, "records", `${ids[0]}.json`)), "归档关时热文件该被删");
  assert.equal(registry.list().length, 500, "内存仍应 500");
});

test("keep 可配：keep=3 时 5 任务 → 内存 3 / 归档 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f4-keep-"));
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    storageDir: dir,
    output: new FileOutputStorage(dir),
    spawnChild: fakeSpawn(),
    terminalRecordKeep: 3,
  });
  const ids = [];
  for (let i = 0; i < 5; i++)
    ids.push((await engine.dispatch({ task: `k${i}`, wait: true })).taskId);
  await engine.shutdown();
  assert.equal(registry.list().length, 3, "keep=3 该留 3 条");
  const gz = readdirSync(join(dir, "archive")).filter((f) => f.endsWith(".json.gz")).length;
  assert.equal(gz, 2, `keep=3 该归档 2 条，实际 ${gz}`);
});

test("TTL 按归档时刻：31 天前的归档被 boot 清，刚归档的留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f4-ttl-"));
  mkdirSync(join(dir, "archive"), { recursive: true });
  const old = gzipSync(
    Buffer.from(
      JSON.stringify({
        id: "old-1",
        status: "succeeded",
        task: "old",
        archivedAt: Date.now() - 31 * 86400000,
      }),
    ),
  );
  writeFileSync(join(dir, "archive", "old-1.json.gz"), old);
  writeFileSync(
    join(dir, "archive", "fresh-1.json.gz"),
    gzipSync(Buffer.from(JSON.stringify({ id: "fresh-1", status: "succeeded", task: "f" }))),
  );
  const past = new Date(Date.now() - 31 * 86400000);
  utimesSync(join(dir, "archive", "old-1.json.gz"), past, past);
  const engine = new TaskEngine({
    registry: new TaskRegistry(),
    storageDir: dir,
    output: new FileOutputStorage(dir),
    spawnChild: fakeSpawn(),
  });
  await engine.dispatch({ task: "boot", wait: true }); // 等 #ready（restore 内做 TTL 清理）
  assert.ok(!existsSync(join(dir, "archive", "old-1.json.gz")), "31 天前的归档该被清");
  assert.ok(existsSync(join(dir, "archive", "fresh-1.json.gz")), "刚归档的该留着");
});

test("红线复验：归档层不动未终态记录", async () => {
  const registry = new TaskRegistry();
  await registry.submit({
    kind: "spawn",
    record: { id: "live-1", status: "running", task: "x" },
  });
  for (let i = 0; i < 5; i++)
    await registry.submit({
      kind: "spawn",
      record: { id: `d${i}`, status: "succeeded", task: "x", finishedAt: 1000 + i },
    });
  const evicted = registry.evictTerminal(2);
  assert.equal(evicted.length, 3, `该挤 3 条，实际 ${evicted.length}`);
  assert.ok(registry.get("live-1"), "红线破：running 被挤");
});
