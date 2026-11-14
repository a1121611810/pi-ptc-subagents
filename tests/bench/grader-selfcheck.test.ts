// bench 面：判分器自检（判据脚本原地保留，探针只调用它）。
// 判分器是头号误差源（按文件位置推仓库根 / 把 Markdown 标题当条目 / judge 少返回几条 check）——
// 自检必须能抓住「判分器失灵」，所以它进 CI 口径（bench project 独立命令触发）。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF_CHECK = join(ROOT, "bench", "ab", "self-check.mjs");

it("判分器自检：正例满分、负例能抓到、缺料不算过", () => {
  const uv = spawnSync("uv", ["--version"], { encoding: "utf8" });
  expect(uv.status, "缺 uv——判分器自检跑不了（它用 uv run python 跑判分器）。不许 skip。").toBe(0);

  const run = spawnSync(process.execPath, [SELF_CHECK], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  expect(
    run.status,
    "判分器自检红了（判分器不可信，别开跑正式实验）：\n" + (run.stdout ?? "") + (run.stderr ?? ""),
  ).toBe(0);
  expect(run.stdout ?? "").toContain("[自检 PASS]");
}, 900_000);
