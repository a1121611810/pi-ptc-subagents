#!/usr/bin/env node
// 门禁：产物里的裸 import，必须被「产出它的那个包」的 manifest 声明。
//
// 为什么有这道门禁（2026-11-02 实测）：把 pi 画面渲染从 entry 搬进 packages/tui/pi 时，
// pi-tui 的依赖声明跟着源码搬走了 —— 但 packages/entry/dist/index.js 仍然 import 它
// （rolldown 把它 external 掉）⇒ 干净安装下解析不到 ⇒ 探针红、CI 也红。
// 本地开发树全绿是因为根 node_modules 里有一条几个月前的陈旧软链侥幸兜住了。
//
// 规则：依赖声明跟产物走，不只跟源码走。
//   扫 packages/*/dist/**/*.js 的裸 import（非相对路径、非 node:），
//   逐条核对产出它的那个包的 dependencies / peerDependencies / optionalDependencies。
//   devDependencies 不算 —— devDeps 不随包安装，声明在那里等于没声明。
//
// 只认「行首的 import/export 语句」：bundle 里常带依赖的 JSDoc 与许可横幅，
// 里面写着 `import { Ajv } from 'ajv'`、`require("ajv/dist/...")` 之类的示例
// （实测 MCP SDK 的 ajv 文档与 ajv codegen 的模板字符串就是这样混进来的）——
// 那是注释与字符串，不是产物真 import。
//
// 用法：node scripts/check-artifact-imports.mjs [仓库根目录]（默认 cwd）
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const packagesDir = join(root, "packages");

const bareImportsOf = (text) => {
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释（JSDoc / 许可横幅）
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1"); // 行注释（// 前不是 : 免得吃掉 https://）
  const specs = new Set();
  const patterns = [
    // 起点是「语句边界」（行首、分号后、右花括号后），不是纯行首：压缩产物整个文件一行，
    // 只认行首会漏掉后面所有 import ⇒ 门禁在最该盯的发布产物上静默失效
    // （实测：压缩前认出 3 处裸 import，压缩后只认出 1 处）
    // ⚠️ 右花括号也在边界里：JS 允许在 `}` 后省掉分号（ASI），压缩器就这么干——实测产物里
    // 就是 `}export{...}` 的形状。漏了它，`export ... from "未声明包"` 会让门禁判绿。
    /(?:^|[;}\n])[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g, // import/export ... from "x"
    /(?:^|[;}\n])[ \t]*import\s*["']([^"']+)["']/g, // import "x"（无 from 的副作用导入）
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // 动态 import("x")——表达式位置，不锚语句边界
  ];
  for (const pattern of patterns) {
    // spec 永远是最后一个捕获组（前面的边界组都改成了非捕获）
    for (const match of code.matchAll(pattern)) {
      const spec = match.at(-1);
      if (spec) specs.add(spec);
    }
  }
  return [...specs].filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
};

// "@scope/name/sub" → "@scope/name"；"name/sub" → "name"
const packageNameOf = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

const jsFiles = (dir) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
};

const problems = [];
let scanned = 0;
let importCount = 0;

for (const dir of existsSync(packagesDir) ? readdirSync(packagesDir) : []) {
  const manifestPath = join(packagesDir, dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const distDir = join(packagesDir, dir, "dist");
  for (const file of jsFiles(distDir)) {
    scanned++;
    for (const spec of bareImportsOf(readFileSync(file, "utf8"))) {
      importCount++;
      const name = packageNameOf(spec);
      if (!declared.has(name)) {
        problems.push(
          `${relative(root, file)} import 了 "${spec}"，但 packages/${dir}/package.json 没声明它` +
            `（依赖声明跟产物走：谁产出这个 import，谁声明它）`,
        );
      }
    }
  }
}

if (scanned === 0) {
  console.error("门禁没扫到任何产物文件 —— 先 pnpm run build 再跑（否则是假绿）");
  process.exit(1);
}

if (problems.length > 0) {
  console.error(`产物里有未声明的外部 import（${problems.length} 条）：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(
  `产物外部 import 门禁：${scanned} 个产物文件 / ${importCount} 处裸 import —— 全部已声明 ✓`,
);
