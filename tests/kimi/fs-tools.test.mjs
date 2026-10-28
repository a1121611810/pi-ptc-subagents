// P1 → 测试：Kimi 面程序四件套（read/grep/glob/edit）——语义与 workdir 锁（信任边界）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsBindings } from "../../packages/kimi-mcp/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-fs-"));
  writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "c.txt"), "hello again\n");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "dep.txt"), "hello from dep\n");
  return dir;
}

const call = (binding, args) => binding(args, { cwd: process.cwd(), emitImage: () => {} });

test("read：读出文件内容（string）", async () => {
  const dir = fixture();
  const text = await call(createFsBindings(dir).read, { path: "a.txt" });
  assert.equal(text, "hello\nworld\n");
});

test("read：workdir 越界（/etc/passwd）即拒", async () => {
  const dir = fixture();
  await assert.rejects(
    call(createFsBindings(dir).read, { path: "/etc/passwd" }),
    /escapes workdir/,
  );
});

test("read：符号链接逃逸即拒（realpath 判定）", async () => {
  const dir = fixture();
  symlinkSync("/etc", join(dir, "etc-link"));
  await assert.rejects(
    call(createFsBindings(dir).read, { path: "etc-link/passwd" }),
    /escapes workdir/,
  );
});

test("grep：命中给 file:line: content，跳过 node_modules", async () => {
  const dir = fixture();
  const hits = await call(createFsBindings(dir).grep, { pattern: "hello" });
  const joined = hits.join("\n");
  assert.match(joined, /a\.txt:1: hello/);
  assert.match(joined, /sub\/c\.txt:1: hello again/);
  assert.ok(!joined.includes("node_modules"), "grep 必须跳过 node_modules");
});

test("grep：非法正即报错", async () => {
  const dir = fixture();
  await assert.rejects(call(createFsBindings(dir).grep, { pattern: "(" }), /invalid pattern/);
});

test("glob：按模式列出（绝对路径 jail 内）", async () => {
  const dir = fixture();
  const found = await call(createFsBindings(dir).glob, { pattern: "**/*.txt" });
  assert.ok(found.includes("a.txt"));
  assert.ok(found.includes(join("sub", "c.txt")));
});

test("edit：唯一匹配替换成功，原文件真的变了", async () => {
  const dir = fixture();
  const result = await call(createFsBindings(dir).edit, {
    path: "a.txt",
    old_string: "world",
    new_string: "kimi",
  });
  assert.equal(result.edited, "a.txt");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello\nkimi\n");
});

test("edit：零匹配与多匹配都拒（不猜、不动文件）", async () => {
  const dir = fixture();
  const edit = createFsBindings(dir).edit;
  await assert.rejects(
    call(edit, { path: "a.txt", old_string: "nope", new_string: "x" }),
    /old_string not found/,
  );
  writeFileSync(join(dir, "multi.txt"), "dup dup");
  await assert.rejects(
    call(createFsBindings(dir).edit, { path: "multi.txt", old_string: "dup", new_string: "x" }),
    /must be unique/,
  );
  assert.equal(readFileSync(join(dir, "multi.txt"), "utf8"), "dup dup", "拒绝时文件必须原样");
});
