// 生成确定性夹具工作区：bench/kimi-ab/fixture/（判分器靠重算它得出硬答案）
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const dir = join(root, "fixture", "src");
rmSync(join(root, "fixture"), { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

for (let i = 1; i <= 24; i++) {
  const name = `mod${String(i).padStart(2, "0")}`;
  const todos = i % 3; // 每文件 0/1/2 条，总计 24
  const lines = [
    `// module ${name} — generated for kimi-ab, do not edit structure`,
    `export function ${name}_alpha(): number {`,
    `  return ${i}`,
    `}`,
    ``,
    `export function ${name}_beta(): number {`,
    `  return ${i * 2}`,
    `}`,
    ``,
    `export const ${name}_tag = "${name}"`,
  ];
  for (let t = 0; t < todos; t++) lines.push(`// TODO(${name}): pending item ${t + 1}`);
  writeFileSync(join(dir, `${name}.ts`), lines.join("\n") + "\n");
}
console.log("fixture ready: 24 files, total TODO=24, total lines=264, exports=48");
