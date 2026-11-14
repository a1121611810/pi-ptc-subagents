// 产物形态面（pi）：发布物形状 + 产物外部 import 门禁 + 册子/entry 的工具名逐字对齐。
// 探针直接打产物（packages/entry/dist、packages/routes/dist）——仓规：验的是发布物形态。
// import 门禁只做薄适配：spawn 判据脚本 + 断言退出码与关键输出，判据本身不重写。
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TOOLS } from "../../packages/routes/dist/index.js";
import { agentDir, createFakePi, startSession } from "../helpers/pi-harness.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = join(repoRoot, "packages", "entry", "dist");
const gate = join(repoRoot, "scripts", "check-artifact-imports.mjs");

const jsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
};

const relativeImports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s*"(\.[^"]+)"/g)].map((m) =>
    resolve(dirname(file), m[1] as string),
  );

// ── 产物外部 import 门禁（薄适配：只 spawn 判据脚本，判据不重写） ──

const makeRoot = ({
  manifest,
  dist: hasDist = true,
  source = 'import { x } from "some-pkg";\n',
}): string => {
  const root = mkdtempSync(join(tmpdir(), "ptc-artifact-gate-"));
  mkdirSync(join(root, "packages", "fake"), { recursive: true });
  writeFileSync(join(root, "packages", "fake", "package.json"), JSON.stringify(manifest));
  if (hasDist) {
    mkdirSync(join(root, "packages", "fake", "dist"));
    writeFileSync(join(root, "packages", "fake", "dist", "index.js"), source);
  }
  return root;
};

const runGate = async (root: string): Promise<{ code: number; out: string; err: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [gate, root], {
      cwd: repoRoot,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
};

it("产物 import 门禁：未声明的包判红，且点名那个包与那个 manifest", async () => {
  const root = makeRoot({ manifest: { name: "@pi-ptc/fake" } });
  const { code, err } = await runGate(root);
  expect(code).not.toBe(0);
  expect(err).toMatch(/some-pkg/);
  expect(err).toMatch(/packages\/fake\/package\.json/);
});

it("产物 import 门禁：声明过 ⇒ 绿", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", dependencies: { "some-pkg": "1.0.0" } },
  });
  const { code, out } = await runGate(root);
  expect(code).toBe(0);
  expect(out).toContain("全部已声明");
});

it("产物 import 门禁：devDependencies 不算声明（不随包安装，声明在那里等于没声明）", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", devDependencies: { "some-pkg": "1.0.0" } },
  });
  expect((await runGate(root)).code).not.toBe(0);
});

it("产物 import 门禁：peerDependencies 算声明（宿主提供也算声明）", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", peerDependencies: { "some-pkg": ">=1.0.0" } },
  });
  expect((await runGate(root)).code).toBe(0);
});

it("产物 import 门禁：产物没构建 ⇒ 判红（不许假绿）", async () => {
  const root = makeRoot({ manifest: { name: "@pi-ptc/fake" }, dist: false });
  const { code, err } = await runGate(root);
  expect(code).not.toBe(0);
  expect(err).toMatch(/build/);
});

it("产物 import 门禁：注释与字符串里的示例 import 不算真 import", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake" },
    source: [
      '// import { Ajv } from "ajv";',
      "/**",
      ' * import { Ajv } from "ajv";',
      " */",
      'const code = `require("ajv/dist/runtime/validation_error")`;',
      "export { code };",
      "",
    ].join("\n"),
  });
  expect((await runGate(root)).code).toBe(0);
});

it("产物 import 门禁：压缩产物（整个文件一行）里第二个 import 也算数", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake" },
    source: 'import{a as b}from"./x.js";import{c}from"some-pkg";export{b};',
  });
  const { code, err } = await runGate(root);
  expect(code).not.toBe(0);
  expect(err).toMatch(/some-pkg/);
});

it("产物 import 门禁：压缩产物里 `}export{...}from` 的形状也算数（ASI：} 后省掉分号）", async () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake" },
    source: 'const a=()=>{};a()}export{x as y}from"some-pkg";',
  });
  const { code, err } = await runGate(root);
  expect(code).not.toBe(0);
  expect(err).toMatch(/some-pkg/);
});

it("产物 import 门禁：本仓当前是绿的（真产物全过）", async () => {
  const { code, out } = await runGate(repoRoot);
  expect(code, out).toBe(0);
});

// ── 发布形态（ADR-0024：一次构建 · 四入口 · 引擎与 worker 各一份） ──

it("发布形态：四个入口都在（index / worker / ptc:index / ptc:cli）", () => {
  for (const rel of ["index.js", "worker.js", "ptc/index.js", "ptc/cli.js"]) {
    expect(existsSync(join(dist, rel)), `产物缺 ${rel}`).toBe(true);
  }
});

it("发布形态：worker 只有一份（输出根有，ptc/ 下没有）", () => {
  expect(existsSync(join(dist, "worker.js")), "dist/worker.js 必须存在").toBe(true);
  expect(
    existsSync(join(dist, "ptc", "worker.js")),
    "worker 只能有一份：ptc/ 下不该再有 worker.js",
  ).toBe(false);
});

it("发布形态：引擎与 CELL_PREAMBLE 各只在一份产物里", () => {
  const files = jsFiles(dist);
  const withMarker = (marker: string): string[] =>
    files.filter((f) => readFileSync(f, "utf8").includes(marker));
  // 标记必须是字符串字面量：压缩器会改模块级标识符的名字（buildWorkerUrl / CELL_PREAMBLE 都被改名了）。
  // 也别挑用户可见的报错文案当标记——改一次文案这个探针就断：用引擎自己的配置键
  const engine = withMarker("maxPendingCalls");
  expect(engine.length, `引擎应只有一份，实际 ${engine.length}：${engine.join(", ")}`).toBe(1);
  const preamble = withMarker("__PTC_NAMES__");
  expect(preamble.length, `CELL_PREAMBLE 应只在一份产物里，实际 ${preamble.length}`).toBe(1);
});

it("发布形态：两个入口共享同一份引擎块（index.js 与 ptc/index.js 指向同一个 chunk）", () => {
  const ptcImports = relativeImports(join(dist, "ptc", "index.js"));
  const shared = relativeImports(join(dist, "index.js")).filter((f) => ptcImports.includes(f));
  expect(
    shared.length,
    "index.js 与 ptc/index.js 必须共享同一个引擎块——否则引擎有两份",
  ).toBeGreaterThan(0);
});

it("发布形态：共享块留在输出根（worker 按同目录找它，挪进 chunks/ 就找不到）", () => {
  const ptcImports = relativeImports(join(dist, "ptc", "index.js"));
  const shared = relativeImports(join(dist, "index.js")).filter((f) => ptcImports.includes(f));
  expect(shared.length).toBeGreaterThan(0);
  for (const file of shared) {
    expect(dirname(file), `共享块 ${file} 必须留在输出根`).toBe(dist);
  }
});

it("发布形态：import entry 不执行 ptc CLI（入口模块不能被摇进共享块）", async () => {
  const entry = pathToFileURL(join(dist, "index.js")).href;
  const result = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(entry)});`,
  ])
    .then((r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }))
    .catch((error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
  expect(result.code, "import entry 不该执行任何东西（CLI 被摇进共享块就会打印用法）").toBe(0);
  expect(result.stdout.trim(), "import entry 不该有任何输出").toBe("");
  expect(result.stderr.trim(), "import entry 不该有任何输出").toBe("");
});

// ── 工具名逐字对齐（册子 = 模型面散文唯一出处，工具名不许漂） ──

const withAgentDir = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir();
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
};

it("册子工具名不得漂：TOOLS 的键与 name 字段必须逐字一致", () => {
  for (const [key, entry] of Object.entries(TOOLS)) {
    expect(entry.name, `册子里 ${key} 的 name 字段漂了`).toBe(key);
  }
});

it("工具名逐字对齐：entry 注册的 name == 册子声明的 name（两个面）", async () => {
  for (const surface of ["full_ptc", "codemode_ptc"]) {
    const fake = createFakePi({ active: surface === "codemode_ptc" ? ["codemode"] : [] });
    await withAgentDir(() => startSession(fake));
    for (const [name, def] of Object.entries(fake.registered)) {
      const declared = (TOOLS as Record<string, { name: string } | undefined>)[name];
      expect(declared, `${surface} 注册了册子没有的工具 ${name}`).toBeDefined();
      expect(def.name).toBe(name);
      expect(declared?.name, `${surface}/${name}：册子声明的名字与注册名不一致`).toBe(name);
    }
  }
});

it("工具名逐字对齐：两个面各自的注册集合与册子一致（决策 28：一个面一个编排器）", async () => {
  const expected: Record<string, string[]> = {
    full_ptc: [
      "ptc_run_code",
      "ptc_workflow",
      "ptc_progress_update",
      "ptc_task_list",
      "ptc_task_output",
      "ptc_task_stop",
    ],
    codemode_ptc: [
      "pi_task_codemode",
      "ptc_progress_update",
      "ptc_task_list",
      "ptc_task_output",
      "ptc_task_stop",
    ],
  };
  for (const [surface, names] of Object.entries(expected)) {
    const fake = createFakePi({ active: surface === "codemode_ptc" ? ["codemode"] : [] });
    await withAgentDir(() => startSession(fake));
    expect(Object.keys(fake.registered).sort(), `${surface} 的注册集合不对`).toEqual(
      [...names].sort(),
    );
  }
});
