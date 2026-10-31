// 客观判分：两处改对（N=2 小活，正确性底线）
import { readFileSync } from "node:fs";
import { join } from "node:path";
const d = process.argv[2];
const m1 = readFileSync(join(d, "src/mod01.ts"), "utf8");
const m2 = readFileSync(join(d, "src/mod02.ts"), "utf8");
const ok =
  m1.includes("return 100") &&
  m2.includes("return 200") &&
  !m1.includes("return 1\n") &&
  !m2.includes("return 4\n");
console.log(ok ? "PASS" : "FAIL: 返回值未改对");
process.exit(ok ? 0 : 1);
