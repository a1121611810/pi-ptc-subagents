// 第 4 面（standalone）：PTC 引擎不经模型、不装 pi 也能跑——这是「可单独复用」的证据
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createFsBindings, runPtcProgram } from "../../packages/ptc/dist/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ptc-standalone-"));
  writeFileSync(join(dir, "a.txt"), "hello ptc\n");
  writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
  return dir;
}

const run = (code, dir) =>
  runPtcProgram({
    code,
    bindings: createFsBindings(dir),
    cwd: dir,
    timeoutMs: 30_000,
  });

test("程序跑通：返回值与子调用记录都在（无模型、无 pi）", async () => {
  const dir = fixture();
  const outcome = await run(`const a = await tools.read({ path: "a.txt" }); return { a };`, dir);
  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(outcome.value, { a: "hello ptc\n" });
  assert.equal(outcome.subCalls.length, 1);
  assert.equal(outcome.subCalls[0].name, "read");
  assert.equal(outcome.subCalls[0].status, "ok");
});

test("文件四件套真操作：glob / read / grep / edit", async () => {
  const dir = fixture();
  const outcome = await run(
    `const files = await tools.glob({ pattern: "*.txt" });
     const hits = await tools.grep({ pattern: "ptc", path: "." });
     const edited = await tools.edit({ path: "a.txt", old_string: "hello", new_string: "bye" });
     return { files, hits, edited };`,
    dir,
  );
  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(outcome.value.files, ["a.txt"]);
  assert.equal(outcome.value.hits.length, 1);
  assert.match(outcome.value.hits[0], /a\.txt:1: hello ptc/);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "bye ptc\n");
});

test("运行格边界：程序里没有宿主能力（process / fetch / require）", async () => {
  const dir = fixture();
  const outcome = await run(
    `return {
       process: typeof process,
       fetch: typeof fetch,
       require: typeof require,
       tools: typeof tools,
     };`,
    dir,
  );
  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value.process, "undefined");
  assert.equal(outcome.value.fetch, "undefined");
  assert.equal(outcome.value.require, "undefined");
  assert.equal(outcome.value.tools, "object");
});

test("零宿主导入：引擎源码不引 pi 也不引兄弟包", () => {
  const srcDir = join(repoRoot, "packages", "ptc", "src");
  const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "引擎源码目录不该是空的");
  for (const name of files) {
    const text = readFileSync(join(srcDir, name), "utf8");
    assert.doesNotMatch(
      text,
      /from\s*["']@earendil-works\//,
      `${name} 引了宿主包——引擎必须零宿主依赖`,
    );
    assert.doesNotMatch(text, /from\s*["']@pi-ptc\//, `${name} 引了兄弟包——引擎必须零依赖`);
  }
});

test("CLI 端到端：ptc <program.ts> 不经模型跑出结果", async () => {
  const dir = fixture();
  const program = join(dir, "prog.ts");
  writeFileSync(
    program,
    `const files = await tools.glob({ pattern: "*.txt" });\nreturn { files };\n`,
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(repoRoot, "packages", "ptc", "dist", "cli.js"), program, "--workdir", dir],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(stdout), { files: ["a.txt"] });
});
