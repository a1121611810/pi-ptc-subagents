// website 面：站点 gate（判据脚本原地保留，探针只调用它们）+ 反事实 harness。
// 薄适配契约（ADR-0029 §4.8）：① spawn 判据脚本 ② 断言退出码与关键输出 ③ 归属（kills 指向本能力的用例）。
// 「判据自己变红」也算杀死，但必须是对应用例红——归属核对在 scripts/mutate.mjs。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE_DIR = join(ROOT, "packages", "website", "scripts");
const SITE_DIST = join(ROOT, "packages", "website", ".vitepress", "dist");

function gate(script: string, args: string[] = []) {
  const run = spawnSync(process.execPath, [join(GATE_DIR, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { code: run.status, out: ((run.stdout ?? "") + (run.stderr ?? "")).trim() };
}

it("站点产物存在：gate 读的是构建后的站点", () => {
  expect(
    existsSync(SITE_DIST),
    "站点产物不存在（" +
      SITE_DIST +
      "）——先跑 pnpm --filter @pi-ptc/website run build。不许 skip。",
  ).toBe(true);
});

it("五个 gate 全绿：投影覆盖 / 落地页工具名 / 内部链接 / 样式作用域 / 路由链接", () => {
  const run = spawnSync(process.execPath, [join(GATE_DIR, "run-checks.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  expect(run.status, "gate 红了：\n" + (run.stdout ?? "") + (run.stderr ?? "")).toBe(0);
});

it("外部链接报告：不是 gate，只报状态（ADR-0036）", () => {
  const run = gate("check-external-links.mjs");
  expect(run.code, "外部链接报告脚本异常退出：\n" + run.out).toBe(0);
});

it("反事实·落地页工具名：造一个不存在的工具名，门禁必须红", () => {
  const run = gate("counterfactuals/run.mjs", ["check-landing-tool-names.mjs"]);
  expect(run.code, "反事实没成立（门禁已经没牙了）：\n" + run.out).toBe(0);
}, 900_000);

it("反事实·内部链接：造一个没建出来的路由，门禁必须红", () => {
  const run = gate("counterfactuals/run.mjs", ["check-internal-links.mjs"]);
  expect(run.code, "反事实没成立（门禁已经没牙了）：\n" + run.out).toBe(0);
}, 900_000);

it("反事实·样式作用域：造一条越界的样式，门禁必须红", () => {
  const run = gate("counterfactuals/run.mjs", ["check-style-scope.mjs"]);
  expect(run.code, "反事实没成立（门禁已经没牙了）：\n" + run.out).toBe(0);
}, 900_000);

it("反事实·投影覆盖：造一份没人投影的文档，门禁必须红", () => {
  const run = gate("counterfactuals/run.mjs", ["check-projection-coverage.mjs"]);
  expect(run.code, "反事实没成立（门禁已经没牙了）：\n" + run.out).toBe(0);
}, 900_000);

it("反事实清单全覆盖：没有哪个 gate 缺反事实用例", () => {
  const run = gate("counterfactuals/run.mjs");
  expect(run.code, "反事实 harness 红了：\n" + run.out).toBe(0);
  expect(run.out, "有 gate 没有反事实用例（这是缺口，不是通过）：\n" + run.out).not.toContain(
    "no counterfactual yet for",
  );
}, 900_000);
