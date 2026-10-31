// 客观判分：answer.md 含 4.9（satisfies 由 TS 4.9 引入，稳定事实）
import { readFileSync } from "node:fs";
import { join } from "node:path";
let ans = "";
try {
  ans = readFileSync(join(process.argv[2], "answer.md"), "utf8");
} catch {
  console.log("FAIL: answer.md 不存在");
  process.exit(1);
}
if (/4\.9/.test(ans) && /typescript|TypeScript/.test(ans)) {
  console.log("PASS");
  process.exit(0);
}
console.log("FAIL: 缺版本号 4.9 或依据");
process.exit(1);
