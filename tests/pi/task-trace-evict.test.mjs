// F3 → 测试：任务痕迹容量边界（spec 决策 29）——最老先出、磁盘同步、未终态红线、平局裁决
// 基准图：docs/prototypes/full-flow-anatomy.html ⑪任务痕迹
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskEngine, TaskRegistry, FileOutputStorage } from "../../packages/dispatch/dist/index.js";

function fakeSpawn() {
  return () => {
    let outCb, exitCb;
    queueMicrotask(() => {
      outCb?.("hello\n");
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

test("600 任务（真实 storageDir）：稳定 500 条，最老 100 条连文件一起消失", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f3-evict-"));
  const registry = new TaskRegistry();
  const engine = new TaskEngine({
    registry,
    storageDir: dir,
    output: new FileOutputStorage(dir),
    spawnChild: fakeSpawn(),
  });
  const ids = [];
  for (let i = 0; i < 600; i++) {
    const r = await engine.dispatch({ task: `t${i}`, wait: true });
    ids.push(r.taskId);
  }
  assert.equal(registry.list().length, 500, `内存记录数应为 500，实际 ${registry.list().length}`);
  // 运行时驱逐走异步归档尾链（决策 29），热文件的删除也在链上——shutdown 排空尾链后再验文件
  await engine.shutdown();
  for (let i = 0; i < 100; i++) {
    assert.ok(!registry.get(ids[i]), `最老的第 ${i} 条还在内存`);
    assert.ok(
      !existsSync(join(dir, "records", `${ids[i]}.json`)),
      `最老的第 ${i} 条 json 还在盘上`,
    );
    assert.ok(!existsSync(join(dir, "tasks", ids[i])), `最老的第 ${i} 条产出目录还在盘上`);
  }
  for (let i = 100; i < 600; i++) {
    assert.ok(registry.get(ids[i]), `第 ${i} 条不该被挤掉`);
  }
  assert.ok(registry.get(ids[599]), "最新的一条必须活着");
  assert.ok(existsSync(join(dir, "records", `${ids[599]}.json`)), "最新的一条 json 必须在盘上");
  assert.ok(existsSync(join(dir, "tasks", ids[599], "output.log")), "最新的一条产出必须在盘上");
  const files = readdirSync(join(dir, "records")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 500, `records 目录应为 500 个文件，实际 ${files.length}`);
});

test("红线：未终态记录永不参与驱逐", async () => {
  const registry = new TaskRegistry();
  const rec = (id, status, finishedAt) => ({
    id,
    status,
    task: id,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  });
  await registry.submit({ kind: "spawn", record: rec("running-1", "running") });
  await registry.submit({ kind: "spawn", record: rec("q-1", "queued") });
  await registry.submit({ kind: "spawn", record: rec("t1", "succeeded", 1000) });
  await registry.submit({ kind: "spawn", record: rec("t2", "failed", 2000) });
  await registry.submit({ kind: "spawn", record: rec("t3", "canceled", 3000) });
  await registry.submit({ kind: "spawn", record: rec("t4", "lost", 4000) });
  const evicted = registry.evictTerminal(2);
  assert.deepEqual(evicted, ["t1", "t2"], `驱逐名单错: ${evicted}`);
  assert.ok(registry.get("running-1") && registry.get("q-1"), "红线破了：未终态记录被驱逐");
  assert.ok(registry.get("t3") && registry.get("t4"), "该留的终态没留");
});

test("平局确定性：同 finishedAt 时按 taskId 字典序成全局全序", async () => {
  const registry = new TaskRegistry();
  const rec = (id) => ({ id, status: "succeeded", task: id, finishedAt: 1000 });
  await registry.submit({ kind: "spawn", record: rec("b-id") });
  await registry.submit({ kind: "spawn", record: rec("a-id") });
  await registry.submit({ kind: "spawn", record: rec("c-id") });
  const evicted = registry.evictTerminal(2);
  assert.deepEqual(evicted, ["a-id"], `平局裁决错: ${evicted}`);
});
