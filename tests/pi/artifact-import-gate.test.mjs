// 产物外部 import 门禁（scripts/check-artifact-imports.mjs）——
// 规则：依赖声明跟产物走，不只跟源码走。谁产出这个 import，谁声明它。
// 背景：2026-11-02 发版前实测——pi 画面渲染搬进 packages/tui/pi 时依赖声明跟着源码搬走，
// 但 packages/entry/dist/index.js 仍 import pi-tui ⇒ 干净安装解析不到 ⇒ 探针红、CI 也红。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const gate = join(repoRoot, "scripts", "check-artifact-imports.mjs");

const makeRoot = ({ manifest, dist = true, source = 'import { x } from "some-pkg";\n' }) => {
  const root = mkdtempSync(join(tmpdir(), "ptc-artifact-gate-"));
  mkdirSync(join(root, "packages", "fake"), { recursive: true });
  writeFileSync(join(root, "packages", "fake", "package.json"), JSON.stringify(manifest));
  if (dist) {
    mkdirSync(join(root, "packages", "fake", "dist"));
    writeFileSync(join(root, "packages", "fake", "dist", "index.js"), source);
  }
  return root;
};

const runGate = (root) => {
  try {
    const out = execFileSync(process.execPath, [gate, root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, err: error.stderr ?? "" };
  }
};

test("产物 import 了未声明的包 ⇒ 门禁红，且点名那个包与那个 manifest", () => {
  const root = makeRoot({ manifest: { name: "@pi-ptc/fake" } });
  const { code, err } = runGate(root);
  assert.notEqual(code, 0, "未声明的 import 必须判红");
  assert.match(err, /some-pkg/);
  assert.match(err, /packages\/fake\/package\.json/);
});

test("声明了 ⇒ 绿", () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", dependencies: { "some-pkg": "1.0.0" } },
  });
  const { code, out } = runGate(root);
  assert.equal(code, 0, out);
});

test("devDependencies 不算——devDeps 不随包安装，声明在那里等于没声明", () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", devDependencies: { "some-pkg": "1.0.0" } },
  });
  assert.notEqual(runGate(root).code, 0);
});

test("peerDependencies 算——宿主提供也算声明", () => {
  const root = makeRoot({
    manifest: { name: "@pi-ptc/fake", peerDependencies: { "some-pkg": ">=1.0.0" } },
  });
  assert.equal(runGate(root).code, 0);
});

test("产物没构建 ⇒ 门禁红（不许假绿）", () => {
  const root = makeRoot({ manifest: { name: "@pi-ptc/fake" }, dist: false });
  const { code, err } = runGate(root);
  assert.notEqual(code, 0);
  assert.match(err, /build/);
});

test("注释与字符串里的示例 import 不算真 import", () => {
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
  assert.equal(runGate(root).code, 0, "注释与模板字符串里的 import 不该被判红");
});

test("本仓当前是绿的（真产物全过）", () => {
  const { code, out } = runGate(repoRoot);
  assert.equal(code, 0, out);
});
