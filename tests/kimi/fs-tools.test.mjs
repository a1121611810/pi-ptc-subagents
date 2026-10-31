// P1 → 测试：Kimi 面程序五件套（read/write/grep/glob/edit）——语义与 workdir 锁（信任边界）
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("grep：path 给单个文件时只搜它（不 ENOTDIR）", async () => {
  const dir = fixture();
  const hits = await call(createFsBindings(dir).grep, { pattern: "world", path: "a.txt" });
  assert.deepEqual(hits, ["a.txt:2: world"]);
});

test("grep：单个文件读不动（权限 000）跳过、其它命中照给", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "locked.txt"), "hello locked\n", { mode: 0o000 });
  const hits = await call(createFsBindings(dir).grep, { pattern: "hello" });
  const joined = hits.join("\n");
  assert.match(joined, /a\.txt:1: hello/);
  assert.match(joined, /sub\/c\.txt:1: hello again/);
});

test("createFsBindings：workdir 不存在报人话（不是裸 errno）", async () => {
  assert.throws(() => createFsBindings("/nonexistent-ptc-workdir-xyz"), /workdir 不存在或不可达/);
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

test("write：新文件写入 + 覆写已存在（原子落盘语义与 edit 同级）", async () => {
  const dir = fixture();
  const r1 = await call(createFsBindings(dir).write, { path: "sub/new.txt", content: "fresh\n" });
  assert.equal(r1.written, "sub/new.txt");
  assert.equal(readFileSync(join(dir, "sub/new.txt"), "utf8"), "fresh\n");
  const r2 = await call(createFsBindings(dir).write, { path: "a.txt", content: "replaced\n" });
  assert.equal(r2.written, "a.txt");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "replaced\n");
});

test("write：父目录不存在即拒（不隐式 mkdir），越界即拒", async () => {
  const dir = fixture();
  await assert.rejects(
    call(createFsBindings(dir).write, { path: "deep/nested/x.txt", content: "x" }),
    /parent dir does not exist/,
  );
  await assert.rejects(
    call(createFsBindings(dir).write, { path: "/etc/ptc-kimi-jail-probe", content: "x" }),
    /escapes workdir/,
  );
  assert.equal(existsSync("/etc/ptc-kimi-jail-probe"), false, "越界写入绝不能落盘");
});
