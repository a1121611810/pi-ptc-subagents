// standalone 面 · CLI（脱离 pi 与模型自跑）：ptc 命令行的参数解析与 stdout 上的单个 JSON 信封。
// 探针打源码包 packages/ptc/src/cli.ts（该包没有 build script；发布形态是根包的 ptc:cli 入口）。
// 断言逐条搬自旧探针（tests/standalone/cli-args.test.mjs、tests/standalone/standalone-engine.test.mjs）。
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../../packages/ptc/src/cli.ts", import.meta.url));

// 一个最小程序 + 一个带目标文件的工作区
function program(body = "return { ok: true };\n"): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ptc-cli-args-"));
  const file = join(dir, "prog.ts");
  writeFileSync(file, body);
  return { dir, file };
}

// 错误分支：退出码 1 + stderr 上的原因
async function fails(args: string[], cwd: string): Promise<string> {
  try {
    await execFileAsync(process.execPath, [cli, ...args], { cwd });
  } catch (error) {
    const err = error as { code?: number | string; stderr?: string };
    expect(err.code).toBe(1);
    return err.stderr ?? "";
  }
  throw new Error("该失败却成功了：" + args.join(" "));
}

it("未知参数：报出参数名", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, "--bogus"], dir);
  expect(stderr).toMatch(/未知参数 --bogus/);
});

it("--timeout 不是数字：报「要一个毫秒数」", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, "--timeout", "abc"], dir);
  expect(stderr).toMatch(/--timeout 要一个毫秒数/);
});

it("给了两个程序文件：报「只能跑一个程序」", async () => {
  const { dir, file } = program();
  const stderr = await fails([file, file], dir);
  expect(stderr).toMatch(/只能跑一个程序/);
});

it("没给程序文件：打用法，退出码 1", async () => {
  const { dir } = program();
  const stderr = await fails(["--json"], dir);
  expect(stderr).toMatch(/用法：ptc <program\.ts>/);
});

it("--help：打用法，退出码 0", async () => {
  const { dir } = program();
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"], { cwd: dir });
  expect(stdout).toMatch(/用法：ptc <program\.ts>/);
});

it("CLI 端到端：ptc <program.ts> 不经模型跑出结果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-standalone-"));
  writeFileSync(join(dir, "a.txt"), "hello ptc\n");
  const prog = join(dir, "prog.ts");
  writeFileSync(prog, 'const files = await tools.glob({ pattern: "*.txt" });\nreturn { files };\n');
  const { stdout } = await execFileAsync(process.execPath, [cli, prog, "--workdir", dir], {
    cwd: dir,
  });
  expect(JSON.parse(stdout)).toEqual({ files: ["a.txt"] });
});

it("--json：stdout 是单个 JSON 信封", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ptc-standalone-"));
  writeFileSync(join(dir, "a.txt"), "hello ptc\n");
  const prog = join(dir, "prog.ts");
  writeFileSync(prog, 'const files = await tools.glob({ pattern: "*.txt" });\nreturn { files };\n');
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, prog, "--workdir", dir, "--json"],
    { cwd: dir },
  );
  const envelope = JSON.parse(stdout);
  expect(envelope.status).toBe("fulfilled");
  expect(envelope.value).toEqual({ files: ["a.txt"] });
  expect(Array.isArray(envelope.logs)).toBe(true);
});

it("程序无返回值：非 json 模式打「(程序无返回值)」", async () => {
  const { dir, file } = program("const x = 1;\n");
  const { stdout } = await execFileAsync(process.execPath, [cli, file, "--workdir", dir], {
    cwd: dir,
  });
  expect(stdout.trim()).toBe("(程序无返回值)");
});

it("参数解析：-w 是 --workdir 的别名", async () => {
  const { dir, file } = program(
    'const files = await tools.glob({ pattern: "*.txt" });\nreturn { files };\n',
  );
  const workdir = mkdtempSync(join(tmpdir(), "ptc-cli-workdir-"));
  writeFileSync(join(workdir, "a.txt"), "hello ptc\n");
  const { stdout } = await execFileAsync(process.execPath, [cli, file, "-w", workdir], {
    cwd: dir,
  });
  expect(JSON.parse(stdout)).toEqual({ files: ["a.txt"] });
});
