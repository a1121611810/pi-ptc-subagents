// 客观判分：24 个文件都插入了标记行，且原内容未被破坏
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const src = join(runDir, "src");
const files = readdirSync(src)
  .filter((f) => f.endsWith(".ts"))
  .sort();
const MARK = "// kimi-ab: audited";
const bad = [];
for (const f of files) {
  const lines = readFileSync(join(src, f), "utf8").split("\n");
  const mod = f.replace(".ts", "");
  if (lines[1] !== MARK) {
    bad.push(`${f}: 第 2 行不是标记（是: ${lines[1]?.slice(0, 40)}）`);
    continue;
  }
  if (!lines[0].includes(`module ${mod}`)) bad.push(`${f}: 首行被改`);
  if (!lines.includes(`export const ${mod}_tag = "${mod}"`)) bad.push(`${f}: 原内容丢失`);
}
if (files.length !== 24) bad.push(`文件数 ${files.length} ≠ 24`);
if (bad.length) {
  console.log("FAIL:\n" + bad.join("\n"));
  process.exit(1);
}
console.log("PASS");
