// 客观判分：重算 48 个 export function，比对 exports.txt
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const src = join(runDir, "src");
const truth = readdirSync(src)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .flatMap((f) =>
    [...readFileSync(join(src, f), "utf8").matchAll(/export function (\w+)/g)].map((m) => m[1]),
  );
let ans = "";
try {
  ans = readFileSync(join(runDir, "exports.txt"), "utf8");
} catch {
  console.log("FAIL: exports.txt 不存在");
  process.exit(1);
}
const got = [...ans.matchAll(/fn_\w+|[a-z]{3}\d{2}_\w+/g)].map((m) => m[0]);
const missing = truth.filter((t) => !got.includes(t));
const extra = got.filter((g) => !truth.includes(g));
console.log(`真值 ${truth.length} 个, 答案 ${got.length} 个`);
if (truth.length !== 48 || missing.length) {
  console.log("FAIL: 缺 " + missing.join(","));
  process.exit(1);
}
if (extra.length) {
  console.log("FAIL: 多 " + extra.join(","));
  process.exit(1);
}
console.log("PASS");
