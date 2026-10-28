// build:kimi 装配：kimi-mcp dist（server/worker/共享 chunk 一起）→ release/kimi/ + skills 拷贝 + 版本与路径自检
// release/kimi 是入库的发布物：Kimi Code 插件安装的是 tag 快照，快照里没有的文件用户拿不到
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "kimi.plugin.json"), "utf8"));

if (manifest.version !== pkg.version) {
  throw new Error(
    `kimi.plugin.json version ${manifest.version} != package.json ${pkg.version}——发版 checklist：先同步版本再 build:kimi`,
  );
}

const distDir = join(root, "packages/kimi-mcp/dist");
const out = join(root, "release/kimi");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "skills", "ptc"), { recursive: true });

const chunks = readdirSync(distDir).filter((f) => f.endsWith(".js"));
for (const f of chunks) cpSync(join(distDir, f), join(out, f));
cpSync(
  join(root, "packages/routes/docs/kimi-ptc/SKILL.md"),
  join(out, "skills", "ptc", "SKILL.md"),
);

for (const f of ["server.js", "worker.js"]) {
  if (!existsSync(join(out, f)))
    throw new Error(`装配缺 ${f}（worker 必须与 server 同目录：buildWorkerUrl 相对解析）`);
}
for (const server of Object.values(manifest.mcpServers ?? {})) {
  for (const arg of server.args ?? []) {
    if (arg.startsWith("./") && !existsSync(join(root, arg))) {
      throw new Error(`kimi.plugin.json 指的路径不存在: ${arg}`);
    }
  }
}
if (!existsSync(join(out, "skills", "ptc", "SKILL.md"))) throw new Error("SKILL.md 拷贝失败");

console.log(
  `release/kimi 装配完成：${chunks.length} 个 js（含 worker 与共享 chunk）+ skills/ptc/SKILL.md，version ${manifest.version}`,
);
