// F5 → 测试：搜索记忆兜底桶（审计 F5）——直接 open 的页存得住、宽松匹配、预算先淘兜底桶
// 基准图：docs/prototypes/full-flow-anatomy.html ⑭记忆
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchMemory } from "../packages/search/dist/index.js";

test("核心：直接 open（没 search 过）的正文存得住、查得到", () => {
  const m = createSearchMemory();
  m.storeText("https://pi.dev/docs/config", "正文-A");
  assert.equal(m.lookup("https://pi.dev/docs/config"), "正文-A", "兜底桶没存住/没查到");
});

test("回归：搜索结果路径原样（先进条目、lookup 命中）", () => {
  const m = createSearchMemory();
  m.remember("q", [{ title: "t", url: "https://a.com/x" }]);
  m.storeText("https://a.com/x", "正文-B");
  assert.equal(m.lookup("https://a.com/x"), "正文-B", "老路径回归失败");
});

test("宽松 URL 匹配对兜底桶同样生效（query 一方为空即视为同页）", () => {
  const m = createSearchMemory();
  m.storeText("https://a.com/x", "正文-C");
  assert.equal(m.lookup("https://a.com/x?utm=1"), "正文-C", "宽松匹配对兜底桶失效");
});

test("预算：兜底桶超 400K 时先淘汰最老的 loose，条目不动", () => {
  const m = createSearchMemory();
  m.remember("keep", [{ title: "t", url: "https://k.com/1" }]);
  m.storeText("https://k.com/1", "K");
  const big = "x".repeat(200_000);
  m.storeText("https://old.com/", big);
  m.storeText("https://new.com/", big);
  m.storeText("https://new2.com/", big); // 总量超 400K：oldest loose 应先被淘汰
  assert.equal(m.lookup("https://old.com/"), undefined, "超预算时最老 loose 该被淘汰");
  assert.equal(m.lookup("https://new2.com/"), big, "新 loose 该活着");
  assert.equal(m.lookup("https://k.com/1"), "K", "条目该不受 loose 淘汰影响");
});

test("回归：条目数上限（5 条）照旧淘汰最老条目", () => {
  const m = createSearchMemory();
  for (let i = 0; i < 6; i++) m.remember(`q${i}`, []);
  m.remember("q6", []);
  m.storeText("https://loose.com/", "L");
  assert.equal(m.lookup("https://loose.com/"), "L", "条目淘汰后 loose 应仍在");
});
