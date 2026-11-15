// live 面：OCR 真机探针（pi 真子代理腿 + Kimi 真 MCP 腿）。
// 判据脚本原地保留，探针只 spawn 它并断言退出码——真机面吃真凭据与真模型，不进 CI。
// 缺依赖必须显式失败，不许 skip（脚本自己会红在这里）。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("OCR 真机探针：pi 真子代理腿 + Kimi 真 MCP 腿（没识别出正文要明说、且不入记忆）", () => {
  const run = spawnSync(process.execPath, [join(ROOT, "scripts/ocr-smoke.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 1_800_000,
    env: { ...process.env, SMOKE_MODEL: process.env.SMOKE_MODEL ?? "" },
  });
  expect(
    run.status,
    "OCR 真机冒烟红了：\n" +
      (run.stdout ?? "").slice(-4000) +
      "\n" +
      (run.stderr ?? "").slice(-4000),
  ).toBe(0);
}, 1_900_000);
