// CLI 参数解析：四个错误分支 + 帮助文本——命令行是公开发布面，参数写错要能立刻看懂
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "packages", "ptc", "dist", "cli.js");

function program() {
  const dir = mkdtempSync(join(tmpdir(), "ptc-cli-args-"));
  const file = join(dir, "prog.ts");
  writeFileSync(file, `return { ok: true };\n`);
  return { dir, file };
}

// 错误分支：退出码 1 + stderr 上的原因
async function fails(args, cwd) {
  try {
    await execFileAsync(process.execPath, [cli, ...args], { cwd });
  } catch (error) {
    assert.equal(error.code, 1, "错误分支的退出码该是 1");
    return error.stderr;
  }
  assert.fail(`该失败却成功了：${args.join(" ")}`);
}

test("未知参数：报出参数名", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, "--bogus"], dir);
  assert.match(stderr, /未知参数 --bogus/);
});

test("--timeout 不是数字：报「要一个毫秒数」", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, "--timeout", "abc"], dir);
  assert.match(stderr, /--timeout 要一个毫秒数/);
});

test("给了两个程序文件：报「只能跑一个程序」", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, file], dir);
  assert.match(stderr, /只能跑一个程序/);
});

test("没给程序文件：打用法，退出码 1", async () => {
  const { dir } = program();
  const stderr = await fails(["--json"], dir);
  assert.match(stderr, /用法：ptc <program\.ts>/);
});

test("--help：打用法，退出码 0", async () => {
  const { dir } = program();
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"], { cwd: dir });
  assert.match(stdout, /用法：ptc <program\.ts>/);
});
