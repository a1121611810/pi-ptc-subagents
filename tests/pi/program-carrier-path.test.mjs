// 程序型子代理（issue #293）：ptc CLI 产物路径解析的布局探针。
// 教训来源：381a70d 曾混入一段「差一节 dist」的错误接线（join(packageRoot,"dist",...) 实际算出 dist/dist），
// 假 spawn 探针喂假路径根本看不见——这条探针钉「index URL → 盘上真实产物」的解析。
// ① 真仓库 dist 布局：entry dist/index.js 的 URL ⇒ packages/entry/dist/ptc/cli.js 真实存在
// ② 发布布局同形（临时夹具 <root>/dist/ptc/cli.js）：命中
// ③ 产物缺失（src 直跑形态）：返回 undefined ⇒ 引擎闸前拒
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { resolveProgramCliPath } = await import("../../packages/entry/dist/index.js");

const ENTRY_DIST_INDEX = fileURLToPath(
  new URL("../../packages/entry/dist/index.js", import.meta.url),
);

test("①：真仓库 dist 布局——entry dist/index.js 的 URL 解析到真实产物", () => {
  const resolved = resolveProgramCliPath(pathToFileURL(ENTRY_DIST_INDEX).href);
  assert.equal(resolved, join(dirname(ENTRY_DIST_INDEX), "ptc", "cli.js"));
  assert.ok(resolved, "解析返回 undefined——entry dist 布局下不该缺 CLI 产物");
  assert.ok(existsSync(resolved), "dist/ptc/cli.js 不在盘上——构建没出 CLI 产物？");
});

test("②：发布布局同形（临时夹具 <root>/dist/index.js + dist/ptc/cli.js）⇒ 命中", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-path-pub-"));
  try {
    mkdirSync(join(root, "dist", "ptc"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "// entry");
    writeFileSync(join(root, "dist", "ptc", "cli.js"), "// cli");
    const resolved = resolveProgramCliPath(pathToFileURL(join(root, "dist", "index.js")).href);
    assert.equal(resolved, join(root, "dist", "ptc", "cli.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("③：产物缺失（src 直跑形态：旁边没有 ptc/cli.js）⇒ undefined，引擎据此闸前拒", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-path-src-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "// entry src");
    const resolved = resolveProgramCliPath(pathToFileURL(join(root, "src", "index.ts")).href);
    assert.equal(resolved, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
