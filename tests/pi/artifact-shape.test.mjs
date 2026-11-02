// 发布形态探针（ADR-0024）：一次构建 · 四入口 · 引擎与 worker 各一份 ——
// 重复的引擎/worker 是两次构建拼出来的，不是摇树能消的；这里钉住「只有一份」。
// 另钉一条副作用隔离：分组不能把入口模块摇进共享块（cli.ts 顶层直接 main()）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repoRoot, "packages", "entry", "dist");
assert.ok(existsSync(dist), "产物还没构建——先 pnpm run build");

const jsFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
};

const relativeImports = (file) => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => resolve(dirname(file), m[1]));
};

test("发布形态：四个入口都在（index / worker / ptc:index / ptc:cli）", () => {
  for (const rel of ["index.js", "worker.js", "ptc/index.js", "ptc/cli.js"]) {
    assert.ok(existsSync(join(dist, rel)), `产物缺 ${rel}`);
  }
});

test("发布形态：worker 只有一份（输出根有，ptc/ 下没有）", () => {
  assert.ok(existsSync(join(dist, "worker.js")), "dist/worker.js 必须存在");
  assert.ok(
    !existsSync(join(dist, "ptc", "worker.js")),
    "worker 只能有一份：ptc/ 下不该再有 worker.js",
  );
});

test("摇树结果：引擎与序言各只在一份产物里", () => {
  const files = jsFiles(dist);
  const withMarker = (marker) => files.filter((f) => readFileSync(f, "utf8").includes(marker));
  const engine = withMarker("buildWorkerUrl");
  assert.equal(engine.length, 1, `引擎应只有一份，实际 ${engine.length}：${engine.join(", ")}`);
  const preamble = withMarker("CELL_PREAMBLE");
  assert.equal(preamble.length, 1, `CELL_PREAMBLE 应只在一份产物里，实际 ${preamble.length}`);
});

test("两个入口共享同一份引擎块（index.js 与 ptc/index.js 指向同一个 chunk）", () => {
  const ptcImports = relativeImports(join(dist, "ptc", "index.js"));
  const shared = relativeImports(join(dist, "index.js")).filter((f) => ptcImports.includes(f));
  assert.ok(shared.length > 0, "index.js 与 ptc/index.js 必须共享同一个引擎块——否则引擎有两份");
});

test("副作用隔离：import entry 不执行 ptc CLI（入口模块不能被摇进共享块）", async () => {
  const entry = pathToFileURL(join(dist, "index.js")).href;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(entry)});`,
  ]);
  assert.equal(stdout.trim(), "", "import entry 不该有任何输出（CLI 被摇进共享块就会打印用法）");
});
