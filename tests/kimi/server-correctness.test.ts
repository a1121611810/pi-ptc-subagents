// kimi-server-correctness 能力的专属探针：server 正确性矩阵。
// 判据脚本原地保留，这里只 spawn 它并断言退出码与关键输出。
// 单独成文件的原因：这条矩阵要跑 8 秒，与同文件的其它用例串行 ⇒ 拖住整面墙钟；
// 独立文件后由 vitest 按文件并行（kills 归属按用例标题，搬家不影响归属）。
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runScript } from "../helpers/run-script.ts";

const BENCH = fileURLToPath(new URL("../../scripts/kimi-bench.mjs", import.meta.url));

it("判据脚本：kimi-bench 正确性矩阵全过（退出码 0 + 0 硬失败）", async () => {
  const out = await runScript(BENCH, {});
  expect(out.code, `bench 退出码 ${out.code}；stderr：${out.stderr.slice(0, 800)}`).toBe(0);
  expect(out.stdout).toMatch(/压测结论：\d+ 项通过，0 硬失败/);
}, 300_000);
