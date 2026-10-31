// 客观判分：重算夹具真值，比对 answer.md（汇总表 + 总计行）
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
const src = join(runDir, "src");
const truth = readdirSync(src)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => {
    const lines = readFileSync(join(src, f), "utf8").replace(/\n$/, "").split("\n");
    return {
      file: f,
      lines: lines.length,
      todos: lines.filter((l) => l.includes("// TODO")).length,
    };
  });
const totalTodos = truth.reduce((a, b) => a + b.todos, 0);
const totalLines = truth.reduce((a, b) => a + b.lines, 0);

let ans = "";
try {
  ans = readFileSync(join(runDir, "answer.md"), "utf8");
} catch {
  console.log("FAIL: answer.md 不存在");
  process.exit(1);
}
// 按行解析：找到含文件名的那行，提取行内数字——全文件 includes 会被文件名自带数字骗过（mod11 的 "11"）
const miss = truth.filter((t) => {
  const line = ans.split("\n").find((l) => l.includes(t.file)) ?? "";
  const nums = (line.match(/\d+/g) ?? []).map(Number);
  return !nums.includes(t.todos) || !nums.includes(t.lines);
});
console.log(`真值: 总 TODO=${totalTodos} 总行数=${totalLines} 文件数=${truth.length}`);
if (miss.length) {
  console.log("FAIL: 缺/错的文件行:", miss.map((m) => m.file).join(","));
  process.exit(1);
}
if (!ans.includes(String(totalTodos)) || !ans.includes(String(totalLines))) {
  console.log("FAIL: 总计行不对");
  process.exit(1);
}
console.log("PASS");
