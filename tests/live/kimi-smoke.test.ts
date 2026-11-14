// live 面：真机冒烟（判据脚本原地保留，探针只 spawn 它并断言退出码）。
// 真机面吃真凭据与真模型 ⇒ 不进 CI，由 `pnpm run test:live` 人工触发；缺依赖必须显式失败，不许 skip。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

it("Kimi 面冒烟：布局与版本 / 自包含 / 协议", () => {
  const run = spawnSync("bash", ["scripts/kimi-smoke.sh"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 1_800_000,
    env: { ...process.env, PI_SMOKE_MODEL: process.env.PI_SMOKE_MODEL ?? "" },
  });
  expect(
    run.status,
    "真机冒烟红了：\n" + (run.stdout ?? "").slice(-4000) + "\n" + (run.stderr ?? "").slice(-4000),
  ).toBe(0);
}, 1_900_000);
