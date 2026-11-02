// buildWorkerUrl 的三条分支（探针直打源码：这个函数没进 dist 的公开面，产物里也碰不到它）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWorkerUrl } from "../../packages/ptc/src/worker-source.ts";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ptc-worker-source-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  return { root, from: pathToFileURL(join(root, "lib", "engine.js")).href };
};

test("旁边有 worker.js ⇒ 用它", () => {
  const { root, from } = fixture();
  writeFileSync(join(root, "lib", "worker.js"), "");
  assert.equal(buildWorkerUrl(from).pathname, join(root, "lib", "worker.js"));
});

test("旁边没有、源码入口在 ⇒ 退回源码直跑", () => {
  const { root, from } = fixture();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "worker-entry.ts"), "");
  assert.equal(buildWorkerUrl(from).pathname, join(root, "src", "worker-entry.ts"));
});

test("两边都没有 ⇒ 报错点名期望的 worker.js，不能报一个从没存在过的路径", () => {
  const { from } = fixture();
  assert.throws(
    () => buildWorkerUrl(from),
    (error) => {
      assert.match(error.message, /PTC worker 缺失/);
      assert.match(error.message, /worker\.js/);
      assert.doesNotMatch(error.message, /worker-entry\.ts/);
      return true;
    },
  );
});
