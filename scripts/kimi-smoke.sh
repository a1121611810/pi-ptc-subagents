#!/bin/bash
# Kimi 面冒烟（P1）：release/kimi 装配产物三腿——协议探针（真 spawn server.js 走 stdio JSON-RPC）、
# 自包含检查（插件托管副本无 node_modules：bundle 里不许残留 workspace/SDK 裸 import）、版本与清单检查。
# 用法：bash scripts/kimi-smoke.sh（先 pnpm run build:kimi）。真 Kimi Code 安装冒烟（/plugins 面板）需 TUI，手工做。
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/release/kimi"
fails=0

echo "== 腿 1：布局与版本 =="
node -e '
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const join = require("node:path").join;
const root = process.argv[1];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "kimi.plugin.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`version 不一致: ${manifest.version} != ${pkg.version}`);
if (!existsSync(join(root, "release/kimi/server.js"))) throw new Error("缺 release/kimi/server.js——先 pnpm run build:kimi");
if (!existsSync(join(root, "release/kimi/worker.js"))) throw new Error("缺 release/kimi/worker.js");
if (!existsSync(join(root, "release/kimi/skills/ptc/SKILL.md"))) throw new Error("缺 skills/ptc/SKILL.md");
console.log(`  version ${manifest.version} 一致，js chunks: ${readdirSync(join(root, "release/kimi")).filter((f) => f.endsWith(".js")).join(", ")}`);
' "$REPO" || fails=$((fails + 1))

echo "== 腿 2：自包含（bundle 无裸依赖 import）=="
if grep -rEl 'from"(@pi-ptc/|@modelcontextprotocol/)|require\("(@pi-ptc/|@modelcontextprotocol/)' "$OUT"/*.js >/dev/null 2>&1; then
  echo "  ✗ bundle 里残留裸依赖 import（托管副本没有 node_modules，必挂）"
  grep -rEl 'from"(@pi-ptc/|@modelcontextprotocol/)' "$OUT"/*.js
  fails=$((fails + 1))
else
  echo "  ✓ server/worker/共享 chunk 全部自包含"
fi

echo "== 腿 3：MCP 协议探针（真 spawn）=="
node -e '
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const dir = mkdtempSync(join(tmpdir(), "ptc-kimi-smoke-"));
const FIXTURE = "kimi-smoke-fixture";
writeFileSync(join(dir, "a.txt"), FIXTURE);
const child = spawn(process.execPath, [join(process.argv[1], "release/kimi/server.js")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1; const pending = new Map(); const err = [];
child.stderr.on("data", (d) => err.push(String(d)));
child.stdout.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr=${err.join("").slice(0, 300)}`)), 60_000);
  pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
(async () => {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  if (init.serverInfo.name !== "pi-ptc") throw new Error("serverInfo.name != pi-ptc");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await request("tools/list");
  if (tools.tools[0].name !== "ptc_run_code") throw new Error("tools/list 没有 ptc_run_code");
  const ok = await request("tools/call", { name: "ptc_run_code", arguments: {
    code: "const t = await tools.read({ path: \"a.txt\" }); return \"SMOKE=\" + t.length;",
    description: "smoke", workdir: dir } });
  if (ok.isError !== false || !ok.content[0].text.includes(`SMOKE=${FIXTURE.length}`)) throw new Error(`call 结果异常: ${JSON.stringify(ok).slice(0, 300)}`);
  const jail = await request("tools/call", { name: "ptc_run_code", arguments: {
    code: "await tools.read({ path: \"/etc/passwd\" }); return 1;",
    description: "smoke jail", workdir: dir } });
  if (jail.isError !== true) throw new Error("workdir 越界没有走 isError");
  console.log("  initialize/tools_list/call(OK=17)/jail(isError) 全过");
  child.kill();
})().catch((e) => { console.error("  ✗", e.message); process.exit(1); });
' "$REPO" || fails=$((fails + 1))

echo "SMOKE-DONE fails=$fails"
exit "$fails"
