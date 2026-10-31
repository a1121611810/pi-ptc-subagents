// 客观判分：重算 MD5 比对 checksums.txt（真要用 shell 的活，四件套接不住）
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const runDir = process.argv[2];
const src = join(runDir, "src");
const truth = readdirSync(src)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map(
    (f) =>
      `${f}\t${createHash("md5")
        .update(readFileSync(join(src, f)))
        .digest("hex")}`,
  );
let ans = "";
try {
  ans = readFileSync(join(runDir, "checksums.txt"), "utf8");
} catch {
  console.log("FAIL: checksums.txt 不存在");
  process.exit(1);
}
const rows = ans
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => l.split(/\s+/).join("\t"));
const miss = truth.filter((t) => !rows.includes(t));
console.log(`真值 ${truth.length} 行, 答案 ${rows.length} 行`);
if (miss.length) {
  console.log("FAIL: 缺/错 " + miss.length + " 行, 例: " + miss[0]);
  process.exit(1);
}
console.log("PASS");
